import { useEffect, useRef, useState } from 'react';
import type { Paper } from './api';
import { loadPdfDocument } from './PdfPage';
import { getThumbnailCover, removeThumbnailCover, saveThumbnailCover } from './thumbnailCoverCache';

export function PaperThumbnail({ paper }: { paper: Paper }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cachedCover, setCachedCover] = useState(() => getThumbnailCover(paper.id));
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(() => cachedCover ? 'ready' : 'loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '120px' });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || cachedCover) return;
    let cancelled = false;
    let loaded: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    const canvas = canvasRef.current;
    if (!canvas) return;

    void (async () => {
      try {
        loaded = await loadPdfDocument(paper.id, 'original');
        if (cancelled) {
          await loaded.destroy();
          loaded = null;
          return;
        }
        const page = await loaded.pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(176 / base.width, 232 / base.height);
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法绘制 PDF 首页。');
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        renderTask = page.render({ canvas, canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
        await renderTask.promise;
        if (!cancelled) {
          try { saveThumbnailCover(paper.id, canvas.toDataURL('image/png')); } catch { /* the canvas remains usable if caching fails */ }
          setState('ready');
        }
      } catch {
        if (!cancelled) setState('error');
      } finally {
        if (loaded) await loaded.destroy();
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [cachedCover, paper.id, visible]);

  return (
    <div ref={hostRef} className={`paper-thumbnail ${state === 'ready' ? 'loaded' : ''}`} role="img" aria-label={`${(paper.chinese_title || paper.english_title || paper.source_name)}首页缩略图`}>
      <canvas ref={canvasRef} aria-hidden="true" style={cachedCover ? { visibility: 'hidden' } : undefined} />
      {cachedCover && <img
        src={cachedCover}
        aria-hidden="true"
        onError={() => {
          removeThumbnailCover(paper.id);
          setCachedCover(null);
          setState('loading');
        }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'white', boxShadow: '0 2px 7px #0002' }}
      />}
      {state !== 'ready' && <span>{state === 'error' ? '预览不可用' : '载入首页'}</span>}
    </div>
  );
}
