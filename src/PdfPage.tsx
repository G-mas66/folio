import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { PdfAnnotation, PdfSelection } from './api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfKind = 'original' | 'mono' | 'dual';
export type SharedPdfDocument = { pdf: pdfjs.PDFDocumentProxy; destroy: () => Promise<void> };

type RenderTaskRef = { cancel: () => void };

export async function loadPdfDocument(paperId: string, kind: PdfKind): Promise<SharedPdfDocument> {
  const bytes = await window.workbench.request<Uint8Array>({ path: `/papers/${paperId}/pdf?kind=${kind}`, binary: true });
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
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
  onSelection: (selection: PdfSelection | null, notice?: string) => void;
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

  function captureSelection() {
    const textLayer = textRef.current;
    const stage = stageRef.current;
    const selection = window.getSelection();
    if (!active || !textLayer || !stage || !selection || selection.isCollapsed || !selection.toString().trim()) {
      onSelection(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) {
      const startPage = range.startContainer.parentElement?.closest<HTMLElement>('.pdf-page-frame')?.dataset.pageNumber;
      const endPage = range.endContainer.parentElement?.closest<HTMLElement>('.pdf-page-frame')?.dataset.pageNumber;
      onSelection(null, startPage && endPage && startPage !== endPage ? '当前一次只能标记同一页内的文字。' : undefined);
      return;
    }
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      onSelection(null);
      return;
    }
    const seenRects = new Set<string>();
    const rects = Array.from(range.getClientRects()).flatMap((rect) => {
      const left = Math.max(bounds.left, rect.left);
      const top = Math.max(bounds.top, rect.top);
      const right = Math.min(bounds.right, rect.right);
      const bottom = Math.min(bounds.bottom, rect.bottom);
      if (right <= left || bottom <= top) return [];
      const key = [left, top, right, bottom].map((value) => Math.round(value * 10) / 10).join(':');
      if (seenRects.has(key)) return [];
      seenRects.add(key);
      return [{
        x: Math.max(0, Math.min(1, (left - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (top - bounds.top) / bounds.height)),
        width: Math.max(0, Math.min(1, (right - left) / bounds.width)),
        height: Math.max(0, Math.min(1, (bottom - top) / bounds.height)),
      }];
    });
    if (!rects.length) {
      onSelection(null);
      return;
    }
    if (rects.length > 32) {
      onSelection(null, '选区跨越过多行，请缩小范围后再标记。');
      return;
    }
    const anchor = range.getBoundingClientRect();
    onSelection({
      page_no: pageNumber,
      selected_text: selection.toString().trim(),
      rects,
      anchor: { left: anchor.left, top: anchor.top, bottom: anchor.bottom },
    });
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
        else setRendered(true);
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
            className={`pdf-annotation-rect annotation-color-${annotation.color}${annotation.kind === 'comment' ? ' has-comment' : ''}`}
            data-testid={`annotation-rect-${annotation.id}-${index}`}
            data-annotation-id={annotation.id}
            aria-hidden="true"
            title={annotation.comment || annotation.selected_text}
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
          />))}
        </div>
        <div className="textLayer" ref={textRef} onMouseUp={captureSelection} />
      </div>
    </div>
  </div>;
}
