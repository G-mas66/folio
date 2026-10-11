import type { PdfAnnotationRect, Segment } from './api';

export type AnnotationPdfKind = 'original' | 'mono' | 'dual';
export type AnnotationViewContext = { page_no: number; rects: PdfAnnotationRect[]; selected_text: string };
export type AnnotationMappingSource = {
  id: string;
  pdf_kind: AnnotationPdfKind;
  page_no: number;
  selected_text: string;
  view_contexts?: Partial<Record<AnnotationPdfKind, AnnotationViewContext>>;
  segment_anchor?: { sequence_no: number; quote: string } | null;
};
export type AnnotationMappingCandidate = {
  annotationId: string;
  targetKind: AnnotationPdfKind;
  quote: string;
  kind: 'exact' | 'paragraph';
  segmentSequenceNo?: number;
};

export function normalizePdfText(value: string): string {
  return Array.from(value.normalize('NFKC').toLocaleLowerCase())
    .filter((character) => !/[\u200b\u200c\u200d\ufeff]/u.test(character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function uniqueMatchingSegment(annotation: AnnotationMappingSource, segments: Segment[]) {
  const anchorSequence = annotation.segment_anchor?.sequence_no;
  if (anchorSequence !== undefined) {
    return segments.find((segment) => segment.sequence_no === anchorSequence) || null;
  }

  const quote = normalizePdfText(annotation.segment_anchor?.quote || annotation.selected_text);
  if (!quote) return null;
  const matches = segments.filter((segment) => {
    const sourceTexts = annotation.pdf_kind === 'original'
      ? [segment.original_text]
      : annotation.pdf_kind === 'mono'
        ? [segment.translation]
        : [segment.original_text, segment.translation];
    return sourceTexts.some((text) => {
      const normalized = normalizePdfText(text);
      return normalized.includes(quote);
    });
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Build text-only cross-view requests. Callers must resolve each quote in its
 * target PDF text layer before persisting any target geometry.
 */
export function annotationMappingCandidates(
  annotation: AnnotationMappingSource,
  segments: Segment[],
): AnnotationMappingCandidate[] {
  const segment = uniqueMatchingSegment(annotation, segments);
  const kinds: AnnotationPdfKind[] = ['original', 'mono', 'dual'];
  const candidates: AnnotationMappingCandidate[] = [];

  for (const targetKind of kinds) {
    if (targetKind === annotation.pdf_kind || annotation.view_contexts?.[targetKind]?.rects?.length) continue;
    if (annotation.selected_text.trim()) {
      candidates.push({ annotationId: annotation.id, targetKind, quote: annotation.selected_text, kind: 'exact' });
    }
    if (!segment) continue;

    const paragraph = targetKind === 'original'
      ? segment.original_text
      : targetKind === 'mono'
        ? segment.translation
        : annotation.pdf_kind === 'mono'
          ? segment.translation
          : segment.original_text;
    if (!paragraph.trim() || normalizePdfText(paragraph) === normalizePdfText(annotation.selected_text)) continue;
    candidates.push({
      annotationId: annotation.id,
      targetKind,
      quote: paragraph,
      kind: 'paragraph',
      segmentSequenceNo: segment.sequence_no,
    });
  }

  return candidates;
}
