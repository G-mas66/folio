import { findTextSelections } from '../src/PdfPage';
import { normalizePdfText } from '../src/annotationMapping';

const stage = document.getElementById('stage')!;
const textLayer = document.getElementById('text-layer')!;
const lineBreakQuote = 'masked marker modeling to learn contextual representations of cells.';
const lineBreakMatches = findTextSelections(textLayer, stage, 1, lineBreakQuote);
const ligatureMatches = findTextSelections(textLayer, stage, 1, 'The findings are useful.');
const repeatedMatches = findTextSelections(textLayer, stage, 1, 'common repeated phrase');

const longWords = Array.from({ length: 800 }, (_, index) => `paragraphtoken${index}`).join(' ');
document.getElementById('long-paragraph')!.textContent = longWords;
const longParagraphMatches = findTextSelections(textLayer, stage, 2, longWords);
const shortParagraphQuote = longWords.slice(0, 220).trimEnd();
const shortParagraphMatches = findTextSelections(textLayer, stage, 2, shortParagraphQuote);

Object.assign(window, {
  pdfLocatorResults: {
    lineBreak: lineBreakMatches.map((match) => ({
      selected_text: match.selected_text,
      normalized_selected_text: normalizePdfText(match.selected_text),
      rects: match.rects,
    })),
    ligature: ligatureMatches.map((match) => ({ selected_text: match.selected_text, rects: match.rects })),
    repeated: repeatedMatches.map((match) => ({ selected_text: match.selected_text, rects: match.rects })),
    longParagraph: {
      full: longParagraphMatches.length,
      short: shortParagraphMatches.map((match) => ({ selected_text: match.selected_text, rects: match.rects })),
    },
  },
});
