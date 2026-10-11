import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

export type PdfAttachmentPage = { page_no: number; data_base64: string };

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function createPdfAttachmentTask(data: Uint8Array) {
  const assets = new URL('./pdfjs/', window.location.href);
  return pdfjs.getDocument({
    data,
    cMapUrl: new URL('cmaps/', assets).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
    useSystemFonts: true,
  });
}

// Use the same PDF.js runtime as the reader so attachments work in packaged apps.
export async function renderPdfAttachment(file: File): Promise<PdfAttachmentPage[]> {
  const task = createPdfAttachmentTask(new Uint8Array(await file.arrayBuffer()));
  try {
    const document = await task.promise;
    if (document.numPages > 20) throw new Error('PDF 附件最多支持 20 页，请选择较小的文件。');
    const images: PdfAttachmentPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 1024 / Math.max(original.width, original.height)) });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法准备 PDF 页面图片。');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      images.push({ page_no: pageNumber, data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    return images;
  } finally { await task.destroy(); }
}
