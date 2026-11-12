import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { PdfAnnotation, PdfAnnotationRect, PdfSelection, SelectionContext } from './api';
import { normalizePdfText } from './annotationMapping';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfKind = 'original' | 'mono' | 'dual';
export type SharedPdfDocument = { pdf: pdfjs.PDFDocumentProxy; destroy: () => Promise<void> };

type RenderTaskRef = { cancel: () => void };
export const PDF_MAX_ZOOM = 2.5;

// ---- Rendering budget -------------------------------------------------------
// Pages share one small render pool; the page closest to the viewport centre
// always goes next, so the page you are looking at is never stuck behind
// pre-rendering further down the document.
const MAX_CONCURRENT_PAGE_RENDERS = 2;
const MAX_CANVAS_PIXELS = 16_000_000;
// Scale/width changes are previewed by CSS-scaling the finished bitmap; the
// sharp re-render only starts once the value has been still for this long.
const RERENDER_SETTLE_MS = 160;
const EYE_COMFORT_TINT = 'rgba(228, 191, 119, 0.28)';

type RenderWaiter = { priority: () => number; grant: () => void };
const renderPool = { active: 0, waiters: [] as RenderWaiter[] };

function pumpRenderPool() {
  while (renderPool.active < MAX_CONCURRENT_PAGE_RENDERS && renderPool.waiters.length) {
    let best = 0;
    let bestPriority = Infinity;
    renderPool.waiters.forEach((waiter, index) => {
      const priority = waiter.priority();
      if (priority < bestPriority) { bestPriority = priority; best = index; }
    });
    const [waiter] = renderPool.waiters.splice(best, 1);
    waiter.grant();
  }
}

function acquireRenderSlot(priority: () => number) {
  return new Promise<() => void>((resolve) => {
    renderPool.waiters.push({
      priority,
      grant: () => {
        renderPool.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          renderPool.active -= 1;
          pumpRenderPool();
        });
      },
    });
    pumpRenderPool();
  });
}

function distanceFromViewport(frame: HTMLElement | null, root: HTMLElement | null) {
  if (!frame || !root) return Number.MAX_SAFE_INTEGER;
  const page = frame.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  return Math.abs((page.top + page.bottom) / 2 - (view.top + view.bottom) / 2);
}

function pageOutputScale(width: number, height: number) {
  const device = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  return Math.max(0.75, Math.min(device, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height))));
}

// Eye comfort used to be a mix-blend-mode overlay on every page, which forces
// expensive compositing on every scrolled frame. The tint is now baked into
// the bitmap once, at render time.
const eyeComfortListeners = new Set<() => void>();
let eyeComfortObserver: MutationObserver | null = null;
function subscribeEyeComfort(listener: () => void) {
  eyeComfortListeners.add(listener);
  if (!eyeComfortObserver) {
    eyeComfortObserver = new MutationObserver(() => eyeComfortListeners.forEach((callback) => callback()));
    eyeComfortObserver.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-eye-comfort'] });
  }
  return () => { eyeComfortListeners.delete(listener); };
}
// Text layers (thousands of measured spans) are built only when the main
// thread is idle, after the page image is already on screen.
function whenIdle(timeout = 400) {
  return new Promise<void>((resolve) => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(() => resolve(), { timeout });
    else window.setTimeout(resolve, 16);
  });
}
const readEyeComfort = () => window.document.documentElement.dataset.eyeComfort === 'on';

const MAX_SELECTION_LINES = 32;
const MAX_SELECTION_RECTS = 512;
const MAX_SELECTION_TEXT_LENGTH = 10000;
type UnderlineEdge = NonNullable<PdfAnnotationRect['underline_edge']>;

function underlineEdgeFor(textNode: Text): UnderlineEdge {
  const span = textNode.parentElement;
  const textRotation = Number.parseFloat(span ? getComputedStyle(span).getPropertyValue('--rotate') : '0');
  const pageRotation = Number.parseFloat(span?.closest<HTMLElement>('.textLayer')?.dataset.mainRotation || '0');
  const rotation = textRotation + pageRotation;
  if (!Number.isFinite(rotation)) return 'bottom';
  const quarterTurns = Math.round(rotation / 90);
  if (Math.abs(rotation - quarterTurns * 90) > 0.5) return 'bottom';
  switch ((quarterTurns % 4 + 4) % 4) {
    case 1: return 'left';
    case 2: return 'top';
    case 3: return 'right';
    default: return 'bottom';
  }
}

type TextUnit = { element: HTMLElement; trailingBreak: Node | null; left: number; top: number; right: number; bottom: number };

function textUnitBounds(element: HTMLElement) {
  const style = getComputedStyle(element);
  const matrix = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform);
  const origin = style.transformOrigin.split(/\s+/).map((value) => Number.parseFloat(value) || 0);
  const originX = origin[0] || 0;
  const originY = origin[1] || 0;
  const points = [[0, 0], [element.offsetWidth, 0], [0, element.offsetHeight], [element.offsetWidth, element.offsetHeight]].map(([x, y]) => ({
    x: matrix.a * (x - originX) + matrix.c * (y - originY) + matrix.e + originX + element.offsetLeft,
    y: matrix.b * (x - originX) + matrix.d * (y - originY) + matrix.f + originY + element.offsetTop,
  }));
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function orderTextLayerByColumns(textLayer: HTMLDivElement) {
  const units: TextUnit[] = [];
  let child = textLayer.firstChild;
  while (child) {
    if (!(child instanceof HTMLElement) || child.tagName !== 'SPAN' || child.getAttribute('role') !== 'presentation') return;
    const element = child;
    const trailingBreak = element.nextSibling instanceof HTMLElement && element.nextSibling.tagName === 'BR'
      ? element.nextSibling
      : null;
    const bounds = textUnitBounds(element);
    units.push({
      element,
      trailingBreak,
      ...bounds,
    });
    child = trailingBreak ? trailingBreak.nextSibling : element.nextSibling;
  }
  if (units.length < 4 || units.length !== textLayer.querySelectorAll('span[role="presentation"]').length) return;

  const findCut = (items: TextUnit[], axis: 'x' | 'y') => {
    const intervals = items.map((item) => axis === 'x'
      ? { start: item.left, end: item.right, crossStart: item.top, crossEnd: item.bottom }
      : { start: item.top, end: item.bottom, crossStart: item.left, crossEnd: item.right })
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const suffixMin = new Array<number>(intervals.length);
    const suffixMax = new Array<number>(intervals.length);
    const suffixMinThickness = new Array<number>(intervals.length);
    for (let index = intervals.length - 1; index >= 0; index -= 1) {
      const current = intervals[index];
      suffixMin[index] = Math.min(current.crossStart, suffixMin[index + 1] ?? Infinity);
      suffixMax[index] = Math.max(current.crossEnd, suffixMax[index + 1] ?? -Infinity);
      suffixMinThickness[index] = Math.min(current.crossEnd - current.crossStart, suffixMinThickness[index + 1] ?? Infinity);
    }
    const threshold = axis === 'x' ? Math.max(14, textLayer.clientWidth * 0.025) : Math.max(10, textLayer.clientHeight * 0.012);
    let prefixEnd = -Infinity;
    let prefixMin = Infinity;
    let prefixMax = -Infinity;
    let prefixMinThickness = Infinity;
    let best: { start: number; end: number; gap: number } | null = null;
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      prefixEnd = Math.max(prefixEnd, previous.end);
      prefixMin = Math.min(prefixMin, previous.crossStart);
      prefixMax = Math.max(prefixMax, previous.crossEnd);
      prefixMinThickness = Math.min(prefixMinThickness, previous.crossEnd - previous.crossStart);
      const current = intervals[index];
      const gap = current.start - prefixEnd;
      const crossOverlap = Math.min(prefixMax, suffixMax[index]) - Math.max(prefixMin, suffixMin[index]);
      const requiredOverlap = Math.min(prefixMinThickness, suffixMinThickness[index]) * 0.5;
      const minimumGroupSize = axis === 'x' ? 2 : 1;
      if (index >= minimumGroupSize && intervals.length - index >= minimumGroupSize && gap >= threshold && crossOverlap >= requiredOverlap && (!best || gap > best.gap)) {
        best = { start: prefixEnd, end: current.start, gap };
      }
    }
    return best;
  };
  let hasColumnCut = false;
  const order = (items: TextUnit[], depth = 0): TextUnit[] => {
    if (items.length < 4 || depth > 12) return items;
    const xCut = findCut(items, 'x');
    if (xCut) {
      const before = items.filter((item) => item.right <= xCut.start + 0.5);
      const after = items.filter((item) => item.left >= xCut.end - 0.5);
      if (before.length && after.length && before.length + after.length === items.length) {
        hasColumnCut = true;
        return [...order(before, depth + 1), ...order(after, depth + 1)];
      }
    }

    const wide = items.filter((item) => item.right - item.left >= textLayer.clientWidth * 0.45);
    const wideSet = new Set(wide);
    const body = items.filter((item) => !wideSet.has(item));
    const bodyCut = wide.length && body.length >= 4 ? findCut(body, 'x') : null;
    if (bodyCut) {
      const bridge = wide.filter((item) => item.left < bodyCut.end && item.right > bodyCut.start);
      const threshold = Math.max(10, textLayer.clientHeight * 0.012);
      if (bridge.length) {
        const bodyTop = Math.min(...body.map((item) => item.top));
        const bodyBottom = Math.max(...body.map((item) => item.bottom));
        const above = bridge.filter((item) => item.bottom + threshold <= bodyTop);
        const below = bridge.filter((item) => item.top >= bodyBottom + threshold);
        if (above.length + below.length !== bridge.length) return items;
        const bridgeSet = new Set([...above, ...below]);
        const remaining = items.filter((item) => !bridgeSet.has(item));
        return [...order(above, depth + 1), ...order(remaining, depth + 1), ...order(below, depth + 1)];
      }
    }

    const yCut = findCut(items, 'y');
    if (!yCut) return items;
    const before = items.filter((item) => item.bottom <= yCut.start + 0.5);
    const after = items.filter((item) => item.top >= yCut.end - 0.5);
    if (!before.length || !after.length || before.length + after.length !== items.length) return items;
    return [...order(before, depth + 1), ...order(after, depth + 1)];
  };
  const ordered = order(units);
  if (!hasColumnCut || ordered.every((item, index) => item === units[index])) return;
  textLayer.replaceChildren(...ordered.flatMap((item) => item.trailingBreak ? [item.element, item.trailingBreak] : [item.element]));
}

function mergeSelectionRects(rects: { rect: DOMRect; underline_edge: UnderlineEdge }[]) {
  const merged: { rect: DOMRect; underline_edge: UnderlineEdge }[] = [];
  for (const current of rects) {
    const vertical = current.underline_edge === 'left' || current.underline_edge === 'right';
    let rect = current.rect;
    for (let index = 0; index < merged.length;) {
      const item = merged[index];
      if (item.underline_edge !== current.underline_edge) {
        index += 1;
        continue;
      }
      const crossOverlap = vertical
        ? Math.min(item.rect.right, rect.right) - Math.max(item.rect.left, rect.left)
        : Math.min(item.rect.bottom, rect.bottom) - Math.max(item.rect.top, rect.top);
      const crossSize = vertical
        ? Math.min(item.rect.width, rect.width)
        : Math.min(item.rect.height, rect.height);
      if (crossOverlap < crossSize * 0.5) {
        index += 1;
        continue;
      }
      const alongGap = vertical
        ? Math.max(item.rect.top - rect.bottom, rect.top - item.rect.bottom, 0)
        : Math.max(item.rect.left - rect.right, rect.left - item.rect.right, 0);
      if (alongGap > 1) {
        index += 1;
        continue;
      }
      const left = Math.min(item.rect.left, rect.left);
      const top = Math.min(item.rect.top, rect.top);
      const right = Math.max(item.rect.right, rect.right);
      const bottom = Math.max(item.rect.bottom, rect.bottom);
      rect = new DOMRect(left, top, right - left, bottom - top);
      merged.splice(index, 1);
      index = 0;
    }
    merged.push({ rect, underline_edge: current.underline_edge });
  }
  return merged;
}

function visualLineCount(rects: { rect: DOMRect; underline_edge: UnderlineEdge }[]) {
  const bands: { vertical: boolean; position: number; thickness: number }[] = [];
  for (const { rect, underline_edge } of rects) {
    const vertical = underline_edge === 'left' || underline_edge === 'right';
    const position = vertical ? rect.left : rect.top;
    const thickness = vertical ? rect.width : rect.height;
    const band = bands.find((item) => item.vertical === vertical && Math.abs(item.position - position) <= Math.max(2, Math.min(item.thickness, thickness) * 0.6));
    if (band) {
      band.position = (band.position + position) / 2;
      band.thickness = Math.max(band.thickness, thickness);
    } else {
      bands.push({ vertical, position, thickness });
    }
  }
  return bands.length;
}

function buildNormalizedTextMap(textLayer: HTMLElement) {
  const source: { character: string; node: Text | null; start: number; end: number }[] = [];
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      let offset = 0;
      for (const character of Array.from(textNode.data)) {
        const start = offset;
        offset += character.length;
        for (const normalized of Array.from(character.normalize('NFKC').toLocaleLowerCase())) {
          if (!/[\u200b\u200c\u200d\ufeff]/u.test(normalized)) source.push({ character: normalized, node: textNode, start, end: offset });
        }
      }
    } else if ((node as HTMLElement).tagName === 'BR') {
      source.push({ character: ' ', node: null, start: 0, end: 0 });
    }
    node = walker.nextNode();
  }

  const characters: string[] = [];
  const positions: { node: Text | null; start: number; end: number }[] = [];
  for (const item of source) {
    if (/\s/u.test(item.character)) {
      if (!characters.length || characters[characters.length - 1] === ' ') continue;
      characters.push(' ');
      positions.push(item);
    } else {
      characters.push(item.character);
      positions.push(item);
    }
  }
  if (characters[characters.length - 1] === ' ') {
    characters.pop();
    positions.pop();
  }
  return { text: characters.join(''), positions };
}

function selectionForRange(range: Range, textLayer: HTMLElement, stage: HTMLElement, pageNumber: number): PdfSelection | null {
  if (!range.toString().trim()) return null;
  const bounds = stage.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const pieces: { rect: DOMRect; underline_edge: UnderlineEdge }[] = [];
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (range.intersectsNode(textNode)) {
      const start = range.startContainer === textNode ? range.startOffset : 0;
      const end = range.endContainer === textNode ? range.endOffset : textNode.length;
      if (end > start) {
        const part = textLayer.ownerDocument.createRange();
        part.setStart(textNode, start);
        part.setEnd(textNode, end);
        for (const rect of Array.from(part.getClientRects())) {
          const left = Math.max(bounds.left, rect.left);
          const top = Math.max(bounds.top, rect.top);
          const right = Math.min(bounds.right, rect.right);
          const bottom = Math.min(bounds.bottom, rect.bottom);
          if (right > left && bottom > top) pieces.push({ rect: new DOMRect(left, top, right - left, bottom - top), underline_edge: underlineEdgeFor(textNode) });
        }
      }
    }
    node = walker.nextNode();
  }
  const merged = mergeSelectionRects(pieces);
  if (!merged.length || merged.length > MAX_SELECTION_RECTS || visualLineCount(merged) > MAX_SELECTION_LINES) return null;
  const selectedText = range.toString().trim();
  if (selectedText.length > MAX_SELECTION_TEXT_LENGTH) return null;
  const anchor = range.getBoundingClientRect();
  return {
    page_no: pageNumber,
    selected_text: selectedText,
    rects: merged.map(({ rect, underline_edge }) => ({
      x: Math.max(0, Math.min(1, (rect.left - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (rect.top - bounds.top) / bounds.height)),
      width: Math.max(0, Math.min(1, rect.width / bounds.width)),
      height: Math.max(0, Math.min(1, rect.height / bounds.height)),
      underline_edge,
    })),
    anchor: { left: anchor.left, top: anchor.top, bottom: anchor.bottom },
  };
}

export function findTextSelections(textLayer: HTMLElement, stage: HTMLElement, pageNumber: number, quote: string): PdfSelection[] {
  const target = normalizePdfText(quote);
  if (!target) return [];
  const source = buildNormalizedTextMap(textLayer);
  const matches: PdfSelection[] = [];
  let from = 0;
  while (from <= source.text.length - target.length) {
    const start = source.text.indexOf(target, from);
    if (start < 0) break;
    const end = start + target.length;
    let first = start;
    let last = end - 1;
    while (first < end && !source.positions[first]?.node) first += 1;
    while (last >= first && !source.positions[last]?.node) last -= 1;
    const startPosition = source.positions[first];
    const endPosition = source.positions[last];
    if (startPosition?.node && endPosition?.node) {
      const range = textLayer.ownerDocument.createRange();
      range.setStart(startPosition.node, startPosition.start);
      range.setEnd(endPosition.node, endPosition.end);
      const selection = selectionForRange(range, textLayer, stage, pageNumber);
      if (selection) matches.push(selection);
    }
    from = start + 1;
  }
  return matches;
}

export type PdfTextMappingRequest = { annotationId: string; quote: string; kind: 'exact' | 'paragraph' };
export type PdfTextMappingResult = PdfTextMappingRequest & { matches: PdfSelection[] };
export type PdfParagraphMarker = { id: string; rect: PdfAnnotationRect; comment: string };

export async function loadPdfDocument(paperId: string, kind: PdfKind): Promise<SharedPdfDocument> {
  const bytes = await window.workbench.request<Uint8Array>({ path: `/papers/${paperId}/pdf?kind=${kind}`, binary: true });
  const resources = new URL('./pdfjs/', window.location.href);
  const loadingTask = pdfjs.getDocument({
    data: import.meta.env.MODE === 'tablet' ? bytes : new Uint8Array(bytes),
    cMapUrl: new URL('cmaps/', resources).href,
    cMapPacked: true,
    iccUrl: new URL('iccs/', resources).href,
    standardFontDataUrl: new URL('standard_fonts/', resources).href,
    wasmUrl: new URL('wasm/', resources).href,
  });
  return { pdf: await loadingTask.promise, destroy: () => loadingTask.destroy() };
}

export async function pageAspectRatios(document: SharedPdfDocument, pageCount: number): Promise<number[]> {
  const ratios: number[] = [];
  const batchSize = import.meta.env.MODE === 'tablet' ? 8 : 1;
  for (let start = 1; start <= pageCount; start += batchSize) {
    const batch = await Promise.all(Array.from({ length: Math.min(batchSize, pageCount - start + 1) }, async (_, index) => {
      const page = await document.pdf.getPage(start + index);
      const viewport = page.getViewport({ scale: 1 });
      return viewport.width / viewport.height;
    }));
    ratios.push(...batch);
  }
  return ratios;
}

export async function prepareTabletPdf(document: SharedPdfDocument, signal: AbortSignal) {
  const aspects: number[] = [];
  const imageUrls: string[] = [];
  const canvas = window.document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas unavailable');
  // Prepare at maximum zoom so pinch only scales the existing image.
  const pageWidth = Math.max(100, Math.max(window.innerWidth, window.innerHeight) - 28) * PDF_MAX_ZOOM;
  const deviceScale = Math.max(2, window.devicePixelRatio || 1);
  try {
    for (let number = 1; number <= document.pdf.numPages; number += 1) {
      if (signal.aborted) throw signal.reason;
      const page = await document.pdf.getPage(number);
      if (signal.aborted) throw signal.reason;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pageWidth / natural.width });
      const outputScale = Math.min(deviceScale, Math.sqrt(16000000 / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      const task = page.render({
        canvas, canvasContext: context, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0],
      });
      const cancel = () => task.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await task.promise;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((image) => image ? resolve(image) : reject(new Error('PDF page encoding failed')), 'image/png');
      });
      if (signal.aborted) throw signal.reason;
      imageUrls.push(URL.createObjectURL(blob));
      aspects.push(natural.width / natural.height);
      page.cleanup();
    }
    return { aspects, imageUrls };
  } catch (error) {
    imageUrls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function PdfPageView({
  document, pageNumber, imageUrl, scale, fitWidth = true, containerWidth, scrollRoot, pageAspectRatio,
  annotations, active, onSelection, locateRequest, onLocate, previewSelection,
  mappingRequests = [], onMapped, paragraphMarkers = [], onAnnotationClick,
}: {
  document: SharedPdfDocument; pageNumber: number; scale: number; fitWidth?: boolean;
  imageUrl?: string;
  containerWidth: number; scrollRoot: HTMLElement | null; pageAspectRatio: number;
  annotations: PdfAnnotation[]; active: boolean;
  onSelection: (selection: PdfSelection | null, notice?: string, contextMenuPoint?: { left: number; top: number }) => void;
  locateRequest?: { id: string; quote: string } | null;
  onLocate?: (id: string, pageNumber: number, matches: PdfSelection[]) => void;
  previewSelection?: SelectionContext | null;
  mappingRequests?: PdfTextMappingRequest[];
  onMapped?: (pageNumber: number, results: PdfTextMappingResult[]) => void;
  paragraphMarkers?: PdfParagraphMarker[];
  onAnnotationClick?: (id: string) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const textLayerInstanceRef = useRef<InstanceType<typeof pdfjs.TextLayer> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTaskRef | null>(null);
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const textDocumentRef = useRef<SharedPdfDocument | null>(null);
  const lastLocateIdRef = useRef<string | null>(null);
  const lastMappingSignatureRef = useRef<string | null>(null);
  const [nearby, setNearby] = useState(false);
  const [failure, setFailure] = useState('');
  const [rendered, setRendered] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const tablet = import.meta.env.MODE === 'tablet';
  const eyeComfort = useSyncExternalStore(subscribeEyeComfort, readEyeComfort);
  const [settled, setSettled] = useState({ scale, containerWidth });
  useEffect(() => {
    if (settled.scale === scale && settled.containerWidth === containerWidth) return;
    if (!rendered) { setSettled({ scale, containerWidth }); return; }
    const timer = window.setTimeout(() => setSettled({ scale, containerWidth }), RERENDER_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [scale, containerWidth, settled.scale, settled.containerWidth, rendered]);
  const renderScale = settled.scale;
  const renderWidth = settled.containerWidth;
  const placeholderWidth = Math.max(100, containerWidth - 28) * (fitWidth ? scale : 1);
  const placeholderHeight = pageAspectRatio > 0 ? placeholderWidth / pageAspectRatio + 28 : 540;
  // The stage is one coordinate system for pixels, selection and annotations.
  // Its layout size stays at the completed render; only its visual scale changes.
  function fitCompletedStage() {
    if (tablet) return;
    const stage = stageRef.current;
    const frame = frameRef.current;
    const baseWidth = stage ? Number.parseFloat(stage.style.width) : 0;
    if (!stage || !frame || !(baseWidth > 0)) return;
    const targetWidth = Number.parseFloat(frame.style.width) - 28;
    if (!(targetWidth > 0)) return;
    stage.style.transformOrigin = '0 0';
    stage.style.transform = `scale(${targetWidth / baseWidth})`;
  }

  useLayoutEffect(fitCompletedStage, [placeholderWidth, placeholderHeight]);

  function captureSelection(contextMenuPoint?: { left: number; top: number }) {
    const textLayer = textRef.current;
    const stage = stageRef.current;
    const selection = window.getSelection();
    if (!active || !textLayer || !stage || !selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) {
      onSelection(null);
      return false;
    }
    const range = selection.getRangeAt(0);
    if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) {
      const startPage = range.startContainer.parentElement?.closest<HTMLElement>('.pdf-page-frame')?.dataset.pageNumber;
      const endPage = range.endContainer.parentElement?.closest<HTMLElement>('.pdf-page-frame')?.dataset.pageNumber;
      onSelection(null, startPage && endPage && startPage !== endPage ? '当前一次只能标记同一页内的文字。' : undefined);
      return false;
    }
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      onSelection(null);
      return false;
    }
    const seenRects = new Set<string>();
    const clientRects: { rect: DOMRect; underline_edge: UnderlineEdge }[] = [];
    const walker = textLayer.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    const textRange = textLayer.ownerDocument.createRange();
    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      if (range.intersectsNode(textNode)) {
        const start = range.startContainer === textNode ? range.startOffset : 0;
        const end = range.endContainer === textNode ? range.endOffset : textNode.length;
        if (end > start && textNode.data.slice(start, end).trim()) {
          textRange.setStart(textNode, start);
          textRange.setEnd(textNode, end);
          const underlineEdge = underlineEdgeFor(textNode);
          const span = textNode.parentElement?.closest<HTMLElement>('span[role="presentation"]');
          const spanBounds = span?.getBoundingClientRect();
          const vertical = underlineEdge === 'left' || underlineEdge === 'right';
          for (const rect of Array.from(textRange.getClientRects())) {
            const left = Math.max(bounds.left, vertical && spanBounds ? spanBounds.left : rect.left);
            const top = Math.max(bounds.top, !vertical && spanBounds ? spanBounds.top : rect.top);
            const right = Math.min(bounds.right, vertical && spanBounds ? spanBounds.right : rect.right);
            const bottom = Math.min(bounds.bottom, !vertical && spanBounds ? spanBounds.bottom : rect.bottom);
            if (right <= left || bottom <= top) continue;
            const key = [...[left, top, right, bottom].map((value) => Math.round(value * 10) / 10), underlineEdge].join(':');
            if (seenRects.has(key)) continue;
            seenRects.add(key);
            clientRects.push({ rect: new DOMRect(left, top, right - left, bottom - top), underline_edge: underlineEdge });
          }
        }
      }
      node = walker.nextNode();
    }
    const mergedRects = mergeSelectionRects(clientRects);
    const domRects = mergedRects.map((item) => item.rect);
    const rects = mergedRects.map(({ rect, underline_edge }) => ({
      x: Math.max(0, Math.min(1, (Math.max(bounds.left, rect.left) - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (Math.max(bounds.top, rect.top) - bounds.top) / bounds.height)),
      width: Math.max(0, Math.min(1, (Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left)) / bounds.width)),
      height: Math.max(0, Math.min(1, (Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top)) / bounds.height)),
      underline_edge,
    }));
    if (!rects.length) {
      onSelection(null);
      return false;
    }
    const selectedText = selection.toString().trim();
    if (mergedRects.length > MAX_SELECTION_RECTS || selectedText.length > MAX_SELECTION_TEXT_LENGTH) {
      onSelection(null, '选区过大，请缩小范围后再标记。');
      return false;
    }
    if (visualLineCount(mergedRects) > MAX_SELECTION_LINES) {
      onSelection(null, '选区跨越过多行，请缩小范围后再标记。');
      return false;
    }
    if (contextMenuPoint && !domRects.some((rect) => (
      contextMenuPoint.left >= rect.left - 2 && contextMenuPoint.left <= rect.right + 2
      && contextMenuPoint.top >= rect.top - 2 && contextMenuPoint.top <= rect.bottom + 2
    ))) {
      onSelection(null);
      return false;
    }
    const anchor = range.getBoundingClientRect();
    onSelection({
      page_no: pageNumber,
      selected_text: selectedText,
      rects,
      anchor: { left: anchor.left, top: anchor.top, bottom: anchor.bottom },
    }, undefined, contextMenuPoint);
    return true;
  }

  useEffect(() => {
    if (import.meta.env.MODE !== 'tablet' || !active || !nearby || !rendered) return;
    let timer: number | undefined;
    function captureTouchSelection() {
      window.clearTimeout(timer);
      const selection = window.getSelection();
      const layer = textRef.current;
      if (!selection || selection.isCollapsed || !layer?.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return;
      timer = window.setTimeout(() => captureSelection(), 180);
    }
    window.document.addEventListener('selectionchange', captureTouchSelection);
    return () => {
      window.clearTimeout(timer);
      window.document.removeEventListener('selectionchange', captureTouchSelection);
    };
  }, [active, nearby, rendered, onSelection]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !scrollRoot) return;
    const observer = new IntersectionObserver(
      (entries) => setNearby(Boolean(entries[0]?.isIntersecting)),
      { root: scrollRoot, rootMargin: '200% 0px', threshold: 0 },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!nearby || renderWidth <= 0) {
      renderTaskRef.current?.cancel();
      const textLayer = textRef.current;
      setRendered(false);
      canvasHostRef.current?.replaceChildren();
      textLayer?.replaceChildren();
      textLayerInstanceRef.current = null;
      textDocumentRef.current = null;
      return;
    }
    let canceled = false;
    renderTaskRef.current?.cancel();
    const job = renderQueueRef.current.catch(() => undefined).then(async () => {
      if (canceled) return;
      const release = await acquireRenderSlot(() => distanceFromViewport(frameRef.current, scrollRoot));
      try {
        if (canceled) return;
        const canvasHost = canvasHostRef.current;
        const textLayer = textRef.current;
        if (!textLayer) return;
        const reuseText = tablet && textDocumentRef.current === document;
        const existingLayer = !tablet && textDocumentRef.current === document ? textLayerInstanceRef.current : null;
        const page = await document.pdf.getPage(pageNumber);
        if (canceled) return;
        const naturalViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(100, renderWidth - 28);
        const fitScale = fitWidth && renderWidth ? availableWidth / naturalViewport.width : 1;
        const viewport = page.getViewport({ scale: fitScale * renderScale });
        // Render into a detached canvas and swap it in whole: the old bitmap
        // stays on screen until the new one is complete, with no copy.
        let nextCanvas: HTMLCanvasElement | null = null;
        if (!tablet && canvasHost) {
          nextCanvas = window.document.createElement('canvas');
          const outputScale = pageOutputScale(viewport.width, viewport.height);
          nextCanvas.width = Math.ceil(viewport.width * outputScale);
          nextCanvas.height = Math.ceil(viewport.height * outputScale);
          const context = nextCanvas.getContext('2d');
          if (!context) throw new Error('Canvas unavailable');
          const task = page.render({ canvas: nextCanvas, canvasContext: context, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0] });
          renderTaskRef.current = task;
          await task.promise;
          if (renderTaskRef.current === task) renderTaskRef.current = null;
          if (canceled) return;
          if (eyeComfort) {
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.globalCompositeOperation = 'multiply';
            context.fillStyle = EYE_COMFORT_TINT;
            context.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
            context.globalCompositeOperation = 'source-over';
          }
        }
        if (canvasHost && nextCanvas) {
          nextCanvas.dataset.pageNumber = String(pageNumber);
          nextCanvas.setAttribute('data-testid', `pdf-canvas-${pageNumber}`);
          nextCanvas.style.width = String(viewport.width) + 'px';
          nextCanvas.style.height = String(viewport.height) + 'px';
          canvasHost.replaceChildren(nextCanvas);
          const stage = stageRef.current;
          if (stage) {
            stage.style.width = String(viewport.width) + 'px';
            stage.style.height = String(viewport.height) + 'px';
            fitCompletedStage();
          }
        }
        // Free the render slot for neighbouring pages before text work.
        release();
        await whenIdle();
        if (canceled) return;
        const nextTextLayer = textLayer.cloneNode(false) as HTMLDivElement;
        let newLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
        if (!reuseText && !existingLayer) {
          nextTextLayer.style.setProperty('--total-scale-factor', String(viewport.scale));
          const content = await page.getTextContent();
          if (canceled) return;
          newLayer = new pdfjs.TextLayer({ textContentSource: content, container: nextTextLayer, viewport });
          renderTaskRef.current = newLayer;
          await newLayer.render();
          if (renderTaskRef.current === newLayer) renderTaskRef.current = null;
        }
        if (canceled) return;
        textLayer.style.width = String(viewport.width) + 'px';
        textLayer.style.height = String(viewport.height) + 'px';
        textLayer.style.setProperty('--total-scale-factor', String(viewport.scale));
        if (existingLayer) {
          // Same text, new size: re-measure the spans in place instead of
          // rebuilding and re-sorting thousands of nodes.
          existingLayer.update({ viewport });
        } else if (!reuseText && newLayer) {
          textLayer.style.setProperty('--min-font-size', nextTextLayer.style.getPropertyValue('--min-font-size'));
          textLayer.replaceChildren(...Array.from(nextTextLayer.childNodes));
          // Rotation belongs to the PDF.js container, not its spans.
          if (nextTextLayer.dataset.mainRotation) textLayer.dataset.mainRotation = nextTextLayer.dataset.mainRotation;
          else delete textLayer.dataset.mainRotation;
          textLayerInstanceRef.current = newLayer;
          await whenIdle();
          if (canceled) return;
          orderTextLayerByColumns(textLayer);
        }
        textDocumentRef.current = document;
        setFailure('');
        setRendered(true);
        if (!existingLayer) setRenderVersion((version) => version + 1);
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (!canceled && name !== 'RenderingCancelledException' && name !== 'AbortException') {
          console.error('PDF render failed on page', pageNumber, error);
          setFailure('无法显示这页 PDF。');
        }
      } finally {
        release();
      }
    });
    renderQueueRef.current = job.catch(() => undefined);
    return () => {
      canceled = true;
      renderTaskRef.current?.cancel();
    };
  }, [document, pageNumber, renderScale, fitWidth, renderWidth, nearby, eyeComfort]);

  useEffect(() => {
    if (!rendered || !locateRequest || !onLocate || lastLocateIdRef.current === locateRequest.id) return;
    const textLayer = textRef.current;
    const stage = stageRef.current;
    if (!textLayer || !stage) return;
    lastLocateIdRef.current = locateRequest.id;
    onLocate(locateRequest.id, pageNumber, findTextSelections(textLayer, stage, pageNumber, locateRequest.quote));
  }, [rendered, locateRequest?.id, locateRequest?.quote, onLocate, pageNumber]);

  useEffect(() => {
    if (!rendered || !onMapped || !mappingRequests.length) return;
    const signature = `${renderVersion}:${JSON.stringify(mappingRequests)}`;
    if (lastMappingSignatureRef.current === signature) return;
    const textLayer = textRef.current;
    const stage = stageRef.current;
    if (!textLayer || !stage) return;
    lastMappingSignatureRef.current = signature;
    const results = mappingRequests.map((request) => {
      let matches = findTextSelections(textLayer, stage, pageNumber, request.quote);
      if (!matches.length && request.kind === 'paragraph') {
        const shortQuote = request.quote.trim().slice(0, 220).trimEnd();
        if (shortQuote && shortQuote !== request.quote.trim()) {
          matches = findTextSelections(textLayer, stage, pageNumber, shortQuote);
        }
      }
      return { ...request, matches };
    });
    onMapped(pageNumber, results);
  }, [rendered, renderVersion, mappingRequests, onMapped, pageNumber]);

  return <div
    className="pdf-page-frame"
    data-page-number={pageNumber}
    data-rendered={rendered && nearby ? 'true' : 'false'}
    ref={frameRef}
    style={{ width: placeholderWidth + 28, height: placeholderHeight }}
  >
    <div className="pdf-page-shell" style={tablet ? undefined : { overflow: 'hidden' }}>
      {failure && <div className="pdf-error">{failure}</div>}
      <div className="pdf-page-stage" ref={stageRef} style={tablet ? { width: placeholderWidth, height: placeholderHeight - 28 } : { flexShrink: 0 }}>
        {tablet ? <img className="pdf-page-bitmap" src={imageUrl} alt="" draggable={false} /> :
          <div className="pdf-canvas-host" ref={canvasHostRef} />}
        <div className="pdf-annotation-layer" aria-label="PDF 高亮和批注">
          {annotations.flatMap((annotation) => annotation.rects.map((rect, index) => <span
            key={`${annotation.id}-${index}`}
            className={`pdf-annotation-rect annotation-color-${annotation.color} annotation-kind-${annotation.kind} annotation-edge-${rect.underline_edge || 'bottom'}${annotation.kind === 'comment' ? ' has-comment' : ''}`}
            data-testid={`annotation-rect-${annotation.id}-${index}`}
            data-annotation-id={annotation.id}
            aria-hidden="true"
            title={annotation.comment || annotation.selected_text}
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
          />))}
          {previewSelection?.page_no === pageNumber && previewSelection.rects.map((rect, index) => <span
            key={`preview-${index}`}
            className="pdf-annotation-rect annotation-color-blue pdf-location-preview"
            data-testid={`pdf-location-preview-${pageNumber}-${index}`}
            aria-hidden="true"
            title="待确认的文字位置"
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
          />)}
          {paragraphMarkers.map((marker) => <button
            key={marker.id}
            type="button"
            className="pdf-paragraph-annotation-marker"
            data-testid={`paragraph-annotation-marker-${marker.id}`}
            aria-label={`查看批注：${marker.comment || '段落批注'}`}
            title={marker.comment || '查看批注'}
            onClick={(event) => { event.stopPropagation(); onAnnotationClick?.(marker.id); }}
            style={{ left: `${marker.rect.x * 100}%`, top: `${marker.rect.y * 100}%` }}
          >注</button>)}
        </div>
        <div className="textLayer" ref={textRef} onMouseUp={() => captureSelection()} onContextMenu={(event) => {
          if (captureSelection({ left: event.clientX, top: event.clientY })) event.preventDefault();
        }} />
      </div>
    </div>
  </div>;
}

type PdfPageProps = Parameters<typeof PdfPageView>[0];

function shallowSame(left: unknown, right: unknown) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}

// The reader re-renders on every page-number change while scrolling; pages
// only need to update when something they draw actually changed. Callbacks
// must therefore be identity-stable wrappers in the parent.
function samePdfPageProps(previous: PdfPageProps, next: PdfPageProps) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof PdfPageProps>;
  for (const key of keys) {
    const left = previous[key];
    const right = next[key];
    if (left === right) continue;
    if (typeof left === 'function' && typeof right === 'function') continue;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length === right.length && left.every((item, index) => shallowSame(item, right[index]))) continue;
      return false;
    }
    if (shallowSame(left, right)) continue;
    return false;
  }
  return true;
}

export const PdfPage = memo(PdfPageView, samePdfPageProps);
