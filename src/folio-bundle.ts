import type { PdfKind } from './PdfPage';

export type BundlePaper = {
  id: string;
  source_name: string;
  english_title: string;
  chinese_title: string;
  page_count: number;
};
export const bundleKinds = ['original', 'mono', 'dual'] as const;
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function readFolioBundle(file: Blob) {
  try {
    const prefix = await file.slice(0, 12).arrayBuffer();
    if (prefix.byteLength !== 12 || decoder.decode(prefix.slice(0, 8)) !== 'FOLIO01\n') throw Error();
    const length = new DataView(prefix).getUint32(8, true);
    if (!length || length > 65536 || 12 + length >= file.size) throw Error();
    const { paper, sizes } = JSON.parse(decoder.decode(await file.slice(12, 12 + length).arrayBuffer())) as {
      paper: BundlePaper; sizes: number[];
    };
    if (!/^[a-f0-9]{32}$/.test(paper?.id) || !Number.isSafeInteger(paper.page_count) || paper.page_count < 1 ||
      [paper.source_name, paper.english_title, paper.chinese_title].some(value => typeof value !== 'string' || value.length > 5000) ||
      !Array.isArray(sizes) || sizes.length !== 3 || sizes.some(size => !Number.isSafeInteger(size) || size <= 0) ||
      sizes.reduce((sum, size) => sum + size, 12 + length) !== file.size) throw Error();
    const pdfs = {} as Record<PdfKind, Blob>;
    let offset = 12 + length;
    for (const [index, kind] of bundleKinds.entries()) {
      const pdf = file.slice(offset, offset + sizes[index], 'application/pdf');
      const head = new TextDecoder().decode(await pdf.slice(0, 1024).arrayBuffer());
      if (!head.includes('%PDF-')) throw Error();
      pdfs[kind] = pdf;
      offset += sizes[index];
    }
    return { paper, pdfs };
  } catch {
    throw Error('无法读取 Folio 文献包，请从电脑版重新导出。');
  }
}
