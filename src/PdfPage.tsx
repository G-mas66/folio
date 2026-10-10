import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { PdfAnnotation, PdfAnnotationRect, PdfSelection } from './api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfKind = 'original' | 'mono' | 'dual';
export type SharedPdfDocument = { pdf: pdfjs.PDFDocumentProxy; destroy: () => Promise<void> };

type RenderTaskRef = { cancel: () => void };

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

export async function loadPdfDocument(paperId: string, kind: PdfKind): Promise<SharedPdfDocument> {
  const bytes = await window.workbench.request<Uint8Array>({ path: `/papers/${paperId}/pdf?kind=${kind}`, binary: true });
  const resources = new URL('./pdfjs/', window.location.href);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
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
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await document.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    ratios.push(viewport.width / viewport.height);
  }
  return ratios;
}

export function PdfPage({
  document, pageNumber, scale, fitWidth = true, containerWidth, scrollRoot, pageAspectRatio,
  annotations, active, onSelection,
}: {
  document: SharedPdfDocument; pageNumber: number; scale: number; fitWidth?: boolean;
  containerWidth: number; scrollRoot: HTMLElement | null; pageAspectRatio: number;
  annotations: PdfAnnotation[]; active: boolean;
  onSelection: (selection: PdfSelection | null, notice?: string, contextMenuPoint?: { left: number; top: number }) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTaskRef | null>(null);
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [nearby, setNearby] = useState(false);
  const [failure, setFailure] = useState('');
  const [rendered, setRendered] = useState(false);
  const placeholderWidth = Math.max(100, containerWidth - 28) * (fitWidth ? scale : 1);
  const placeholderHeight = pageAspectRatio > 0 ? placeholderWidth / pageAspectRatio + 28 : 540;

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
    const frame = frameRef.current;
    if (!frame || !scrollRoot) return;
    const observer = new IntersectionObserver(
      (entries) => setNearby(Boolean(entries[0]?.isIntersecting)),
      { root: scrollRoot, rootMargin: '180% 0px', threshold: 0 },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!nearby || containerWidth <= 0) {
      renderTaskRef.current?.cancel();
      const canvas = canvasRef.current;
      const textLayer = textRef.current;
      setRendered(false);
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.style.width = '0px';
        canvas.style.height = '0px';
      }
      textLayer?.replaceChildren();
      return;
    }
    let canceled = false;
    renderTaskRef.current?.cancel();
    const job = renderQueueRef.current.catch(() => undefined).then(async () => {
      if (canceled) return;
      const canvas = canvasRef.current;
      const textLayer = textRef.current;
      if (!canvas || !textLayer) return;
      try {
        const page = await document.pdf.getPage(pageNumber);
        if (canceled) return;
        const naturalViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(100, containerWidth - 28);
        const fitScale = fitWidth && containerWidth ? availableWidth / naturalViewport.width : 1;
        const viewport = page.getViewport({ scale: fitScale * scale });
        const outputScale = Math.max(2, window.devicePixelRatio || 1);
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        textLayer.style.width = `${viewport.width}px`;
        textLayer.style.height = `${viewport.height}px`;
        textLayer.style.setProperty('--total-scale-factor', String(viewport.scale));
        textLayer.replaceChildren();
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        const task = page.render({
          canvas, canvasContext: context, viewport,
          transform: [outputScale, 0, 0, outputScale, 0, 0],
        });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) renderTaskRef.current = null;
        if (canceled) return;
        const content = await page.getTextContent();
        if (canceled) return;
        const layer = new pdfjs.TextLayer({ textContentSource: content, container: textLayer, viewport });
        await layer.render();
        if (canceled) textLayer.replaceChildren();
        else {
          orderTextLayerByColumns(textLayer);
          setRendered(true);
        }
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (!canceled && name !== 'RenderingCancelledException') {
          const detail = error instanceof Error ? `${error.name}: ${error.message.slice(0, 180)}` : 'Unknown PDF render error';
          console.error(`PDF render failed on page ${pageNumber}`, detail);
          setFailure('无法显示这页 PDF。');
        }
      }
    });
    renderQueueRef.current = job.catch(() => undefined);
    return () => {
      canceled = true;
      renderTaskRef.current?.cancel();
    };
  }, [document, pageNumber, scale, fitWidth, containerWidth, nearby]);

  return <div
    className="pdf-page-frame"
    data-page-number={pageNumber}
    data-rendered={rendered && nearby ? 'true' : 'false'}
    ref={frameRef}
    style={{ width: placeholderWidth + 28, height: placeholderHeight }}
  >
    <div className="pdf-page-shell">
      {failure && <div className="pdf-error">{failure}</div>}
      <div className="pdf-page-stage" ref={stageRef}>
        <canvas ref={canvasRef} data-page-number={pageNumber} data-testid={`pdf-canvas-${pageNumber}`} />
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
        </div>
        <div className="textLayer" ref={textRef} onMouseUp={() => captureSelection()} onContextMenu={(event) => {
          if (captureSelection({ left: event.clientX, top: event.clientY })) event.preventDefault();
        }} />
      </div>
    </div>
  </div>;
}
