import { FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { api, ChatMessage, ChatStreamEvent, ChatStreamHandle, errorMessage, Paper, PdfAnnotation, PdfSelection, Segment, Source } from './api';
import { loadPdfDocument, pageAspectRatios, PdfPage, PdfKind, SharedPdfDocument } from './PdfPage';
import './reader-reference.css';

type Page = { page_no: number; extraction_status: string; text_chars: number };
type AnalysisRun = {
  id: string; kind: string; status: string; error: string; completed_chunks: number; total_chunks: number; question: string;
};
type ReaderSettings = { model: string; model_options: string[]; web_search_enabled: boolean };
type ReaderLayoutState = { outlineWidth: number; chatWidth: number; outlineVisible: boolean; chatVisible: boolean };
type ReaderSelection = PdfSelection & { pdf_kind: PdfKind };
type AnnotationDraft = { selection: ReaderSelection; comment: string };
type NoteSaveStatus = '未保存' | '保存中…' | '已保存' | '保存失败';

const readerLayoutKey = 'paper-workbench.reader-layout.v1';
const defaultReaderLayout: ReaderLayoutState = { outlineWidth: 240, chatWidth: 470, outlineVisible: true, chatVisible: true };

function readReaderLayout(): ReaderLayoutState {
  try {
    const saved = JSON.parse(localStorage.getItem(readerLayoutKey) || 'null') as Partial<ReaderLayoutState> | null;
    return {
      outlineWidth: typeof saved?.outlineWidth === 'number' ? saved.outlineWidth : defaultReaderLayout.outlineWidth,
      chatWidth: typeof saved?.chatWidth === 'number' ? saved.chatWidth : defaultReaderLayout.chatWidth,
      outlineVisible: typeof saved?.outlineVisible === 'boolean' ? saved.outlineVisible : true,
      chatVisible: typeof saved?.chatVisible === 'boolean' ? saved.chatVisible : true,
    };
  } catch {
    return defaultReaderLayout;
  }
}

function bounded(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function fitReaderLayout(layout: ReaderLayoutState, totalWidth: number): ReaderLayoutState {
  let outlineWidth = Math.max(140, layout.outlineWidth);
  let chatWidth = Math.max(280, layout.chatWidth);
  const separators = Number(layout.outlineVisible) + Number(layout.chatVisible);
  const sideBudget = Math.max(0, totalWidth - 320 - separators * 10);
  if (layout.outlineVisible && layout.chatVisible) {
    outlineWidth = Math.min(outlineWidth, Math.max(140, sideBudget - 280));
    chatWidth = Math.min(chatWidth, Math.max(280, sideBudget - outlineWidth));
  } else if (layout.outlineVisible) {
    outlineWidth = Math.min(outlineWidth, Math.max(140, sideBudget));
  } else if (layout.chatVisible) {
    chatWidth = Math.min(chatWidth, Math.max(280, sideBudget));
  }
  return { ...layout, outlineWidth, chatWidth };
}

function saveReaderLayout(layout: ReaderLayoutState) {
  try { localStorage.setItem(readerLayoutKey, JSON.stringify(layout)); } catch { /* local preferences are optional */ }
}

export function Reader({ paperId, active, libraryNavigation }: { paperId: string; active: boolean; libraryNavigation: ReactNode }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [rightPanel, setRightPanel] = useState<'chat' | 'notes'>('chat');
  const [noteText, setNoteText] = useState('');
  const [noteSaveStatus, setNoteSaveStatusState] = useState<NoteSaveStatus>('未保存');
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [notesFailure, setNotesFailure] = useState('');
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [highlightPaletteOpen, setHighlightPaletteOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [annotationEditText, setAnnotationEditText] = useState('');
  const [annotationFailure, setAnnotationFailure] = useState('');
  const [settings, setSettings] = useState<ReaderSettings | null>(null);
  const [currentModel, setCurrentModel] = useState('');
  const [modelFailure, setModelFailure] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [mode, setMode] = useState<'bilingual' | 'mono' | 'original'>('bilingual');
  const pdfKind: PdfKind = mode === 'original' ? 'original' : mode === 'mono' ? 'mono' : 'dual';
  const [searchText, setSearchText] = useState('');
  const [searchNotice, setSearchNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [pdfFailure, setPdfFailure] = useState('');
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfDocument, setPdfDocument] = useState<SharedPdfDocument | null>(null);
  const [pageAspects, setPageAspects] = useState<number[]>([]);
  const [pdfScrollElement, setPdfScrollElement] = useState<HTMLDivElement | null>(null);
  const [pdfScrollWidth, setPdfScrollWidth] = useState(0);
  const [readerLayout, setReaderLayout] = useState<ReaderLayoutState>(readReaderLayout);
  const [readerLayoutElement, setReaderLayoutElement] = useState<HTMLDivElement | null>(null);
  const [readerLayoutWidth, setReaderLayoutWidth] = useState(0);
  const readerLayoutRef = useRef(readerLayout);
  const resizeStartLayoutRef = useRef<ReaderLayoutState | null>(null);
  const pendingReaderLayoutRef = useRef<ReaderLayoutState | null>(null);
  const activeRef = useRef(active);
  const activeEpochRef = useRef(0);
  const lastActivePropRef = useRef(active);
  const hasActivatedReaderRef = useRef(false);
  const scrollPositionRef = useRef(0);
  const resizingRef = useRef(false);
  const resizeAnchorRef = useRef<{ page: number; offset: number | null } | null>(null);
  const anchorSettleTimerRef = useRef<number | null>(null);
  const restoredPaperRef = useRef<string | null>(null);
  const initialPageScrollPendingRef = useRef(false);
  const visiblePageRef = useRef(1);
  const modelSavingRef = useRef(false);
  const progressTimerRef = useRef<number | null>(null);
  const noteDraftRef = useRef('');
  const noteRevisionRef = useRef(0);
  const noteSavedRevisionRef = useRef(0);
  const noteLoadedRef = useRef(false);
  const noteStatusRef = useRef<NoteSaveStatus>('未保存');
  const noteSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveNoteOnUnmountRef = useRef<(text: string, revision: number) => void>(() => undefined);
  const flushNoteBeforeUpdateRef = useRef<() => Promise<void>>(async () => undefined);
  const noteSaveTimerRef = useRef<number | null>(null);
  const pendingAnnotationJumpRef = useRef<{ pdfKind: PdfKind; page: number } | null>(null);
  const previousPdfKindRef = useRef<PdfKind>(pdfKind);
  const loadedPdfKindRef = useRef<PdfKind | null>(null);
  readerLayoutRef.current = readerLayout;
  if (lastActivePropRef.current !== active) {
    activeEpochRef.current += 1;
    lastActivePropRef.current = active;
  }
  activeRef.current = active;

  function setNoteSaveStatus(status: NoteSaveStatus) {
    noteStatusRef.current = status;
    setNoteSaveStatusState(status);
  }

  async function persistPaperNotes(text: string, revision: number, updateUi = true) {
    if (noteSaveTimerRef.current !== null) window.clearTimeout(noteSaveTimerRef.current);
    noteSaveTimerRef.current = null;
    if (updateUi) setNoteSaveStatus('保存中…');
    const request = noteSaveQueueRef.current.catch(() => undefined).then(() => api<{ text: string }>(`/papers/${paperId}/notes`, 'PUT', { text }));
    noteSaveQueueRef.current = request.then(() => undefined, () => undefined);
    try {
      await request;
      noteSavedRevisionRef.current = Math.max(noteSavedRevisionRef.current, revision);
      if (!updateUi) return;
      if (noteRevisionRef.current !== revision || noteDraftRef.current !== text) {
        setNoteSaveStatus('未保存');
        return;
      }
      try {
        const key = `paper-workbench.note-draft.${paperId}`;
        if (localStorage.getItem(key) === text) localStorage.removeItem(key);
      } catch {
        setNoteSaveStatus('保存失败');
        setNotesFailure('本地草稿无法清理；笔记已保存到本机数据库。');
        return;
      }
      setNoteSaveStatus('已保存');
      setNotesFailure('');
    } catch (error) {
      if (updateUi && noteRevisionRef.current === revision) {
        setNoteSaveStatus('保存失败');
        setNotesFailure(errorMessage(error));
      }
    }
  }

  flushNoteBeforeUpdateRef.current = async () => {
    if (!noteLoadedRef.current || noteRevisionRef.current <= noteSavedRevisionRef.current) return;
    const text = noteDraftRef.current;
    const revision = noteRevisionRef.current;
    await persistPaperNotes(text, revision);
    if (noteSavedRevisionRef.current < revision) throw new Error('笔记尚未保存，更新安装已取消。');
  };

  saveNoteOnUnmountRef.current = (text, revision) => { void persistPaperNotes(text, revision, false); };

  function changeNoteText(text: string) {
    noteDraftRef.current = text;
    noteRevisionRef.current += 1;
    setNoteText(text);
    try {
      localStorage.setItem(`paper-workbench.note-draft.${paperId}`, text);
      setNoteSaveStatus('未保存');
      setNotesFailure('');
    } catch {
      setNoteSaveStatus('保存失败');
      setNotesFailure('本地草稿暂时无法保存；关闭阅读标签前请先保存笔记。');
    }
  }

  function applyReaderLayout(next: ReaderLayoutState) {
    readerLayoutRef.current = next;
    setReaderLayout(next);
  }

  function previewReaderLayout(next: ReaderLayoutState) {
    const outline = readerLayoutElement?.querySelector<HTMLElement>('.reader-outline');
    const chat = readerLayoutElement?.querySelector<HTMLElement>('.chat-column');
    if (outline) {
      outline.style.width = `${next.outlineVisible ? next.outlineWidth : 0}px`;
      outline.style.flexBasis = `${next.outlineVisible ? next.outlineWidth : 0}px`;
    }
    if (chat) {
      chat.style.width = `${next.chatVisible ? next.chatWidth : 0}px`;
      chat.style.flexBasis = `${next.chatVisible ? next.chatWidth : 0}px`;
    }
  }

  function commitReaderLayout() {
    saveReaderLayout(readerLayoutRef.current);
  }

  function captureReaderAnchor() {
    if (!active || resizingRef.current) return;
    resizingRef.current = true;
    const page = visiblePageRef.current;
    const frame = pdfScrollElement?.querySelector<HTMLElement>(`.pdf-page-frame[data-page-number="${page}"]`);
    const offset = frame && pdfScrollElement ? frame.getBoundingClientRect().top - pdfScrollElement.getBoundingClientRect().top : null;
    resizeAnchorRef.current = { page, offset };
  }

  function startReaderResize() {
    if (anchorSettleTimerRef.current !== null) window.clearTimeout(anchorSettleTimerRef.current);
    anchorSettleTimerRef.current = null;
    resizingRef.current = false;
    resizeAnchorRef.current = null;
    captureReaderAnchor();
    resizeStartLayoutRef.current = readerLayoutRef.current;
  }

  function adjustReaderAnchor() {
    const anchor = resizeAnchorRef.current;
    if (!anchor || anchor.offset === null || !pdfScrollElement) return;
    const frame = pdfScrollElement.querySelector<HTMLElement>(`.pdf-page-frame[data-page-number="${anchor.page}"]`);
    if (!frame) return;
    const delta = frame.getBoundingClientRect().top - pdfScrollElement.getBoundingClientRect().top - anchor.offset;
    pdfScrollElement.scrollTop += delta;
  }

  function restoreReaderAnchor(persist = true) {
    if (!active) return;
    const pending = pendingReaderLayoutRef.current;
    if (pending) {
      const fitted = fitReaderLayout(pending, readerLayoutElement?.clientWidth || readerLayoutWidth);
      previewReaderLayout(fitted);
      applyReaderLayout(fitted);
      pendingReaderLayoutRef.current = null;
      resizeStartLayoutRef.current = null;
    }
    if (readerLayoutElement) {
      const fitted = fitReaderLayout(readerLayoutRef.current, readerLayoutElement.clientWidth);
      if (fitted.outlineWidth !== readerLayoutRef.current.outlineWidth || fitted.chatWidth !== readerLayoutRef.current.chatWidth) applyReaderLayout(fitted);
    }
    if (pdfScrollElement) setPdfScrollWidth(Math.max(0, pdfScrollElement.clientWidth - 40));
    if (persist) commitReaderLayout();
    window.requestAnimationFrame(adjustReaderAnchor);
    if (anchorSettleTimerRef.current !== null) window.clearTimeout(anchorSettleTimerRef.current);
    anchorSettleTimerRef.current = window.setTimeout(() => {
      if (readerLayoutElement) {
        const fitted = fitReaderLayout(readerLayoutRef.current, readerLayoutElement.clientWidth);
        if (fitted.outlineWidth !== readerLayoutRef.current.outlineWidth || fitted.chatWidth !== readerLayoutRef.current.chatWidth) {
          previewReaderLayout(fitted);
          applyReaderLayout(fitted);
          if (persist) commitReaderLayout();
        }
      }
      if (pdfScrollElement) {
        const nextWidth = Math.max(0, pdfScrollElement.clientWidth - 40);
        setPdfScrollWidth((current) => current === nextWidth ? current : nextWidth);
      }
      adjustReaderAnchor();
      resizingRef.current = false;
      resizeAnchorRef.current = null;
      resizeStartLayoutRef.current = null;
      pendingReaderLayoutRef.current = null;
      anchorSettleTimerRef.current = null;
      if (isAtPdfScrollEnd() && paper) updatePageFromScroll(paper.page_count);
    }, 320);
  }

  function isAtPdfScrollEnd() {
    if (!activeRef.current || !paper || !pdfDocument || pageAspects.length < paper.page_count || !pdfScrollElement) return false;
    const lastFrame = pdfScrollElement.querySelector<HTMLElement>(`.pdf-page-frame[data-page-number="${paper.page_count}"]`);
    return Boolean(lastFrame?.offsetHeight && pdfScrollElement.scrollHeight > pdfScrollElement.clientHeight + 1
      && pdfScrollElement.scrollTop + pdfScrollElement.clientHeight >= pdfScrollElement.scrollHeight - 2);
  }

  function resizeReaderPanel(panel: 'outline' | 'chat', width: number) {
    const current = resizeStartLayoutRef.current || readerLayoutRef.current;
    const separators = Number(current.outlineVisible) + Number(current.chatVisible);
    const sideBudget = Math.max(0, readerLayoutWidth - 320 - separators * 10);
    let outlineWidth = current.outlineWidth;
    let chatWidth = current.chatWidth;
    if (panel === 'outline') {
      outlineWidth = bounded(width, 140, sideBudget - (current.chatVisible ? 280 : 0));
      if (current.chatVisible && outlineWidth + chatWidth > sideBudget) chatWidth = Math.max(280, sideBudget - outlineWidth);
    } else {
      chatWidth = bounded(width, 280, sideBudget - (current.outlineVisible ? 140 : 0));
      if (current.outlineVisible && outlineWidth + chatWidth > sideBudget) outlineWidth = Math.max(140, sideBudget - chatWidth);
    }
    const next = fitReaderLayout({ ...current, outlineWidth, chatWidth }, readerLayoutWidth);
    pendingReaderLayoutRef.current = next;
    previewReaderLayout(next);
  }

  function toggleReaderPanel(panel: 'outline' | 'chat') {
    captureReaderAnchor();
    const current = readerLayoutRef.current;
    const next = fitReaderLayout({
      ...current,
      [panel === 'outline' ? 'outlineVisible' : 'chatVisible']: !(panel === 'outline' ? current.outlineVisible : current.chatVisible),
    }, readerLayoutElement?.clientWidth || readerLayoutWidth || window.innerWidth);
    applyReaderLayout(next);
    window.requestAnimationFrame(() => restoreReaderAnchor());
  }

  const refresh = useCallback(async () => {
    try {
      const [nextPaper, nextPages, nextSegments, nextSettings] = await Promise.all([
        api<Paper>(`/papers/${paperId}`),
        api<Page[]>(`/papers/${paperId}/pages`),
        api<Segment[]>(`/papers/${paperId}/segments`),
        api<ReaderSettings>('/settings'),
      ]);
      setPaper(nextPaper);
      setPages(nextPages);
      setSegments(nextSegments);
      setSettings(nextSettings);
      if (restoredPaperRef.current !== paperId) {
        restoredPaperRef.current = paperId;
        if (nextPaper.source_language === 'zh') setMode('original');
        const restoredPage = nextPaper.last_page || 1;
        visiblePageRef.current = restoredPage;
        initialPageScrollPendingRef.current = true;
        setPageNumber(restoredPage);
      }
      if (!modelSavingRef.current) setCurrentModel(nextPaper.model_override || nextSettings.model || '');
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, [paperId]);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  useEffect(() => {
    let canceled = false;
    noteLoadedRef.current = false;
    setNotesLoaded(false);
    setNotesFailure('');
    let localDraft: string | null = null;
    let storageFailure = false;
    try { localDraft = localStorage.getItem(`paper-workbench.note-draft.${paperId}`); }
    catch { storageFailure = true; }
    void api<{ text: string; updated_at: string | null }>(`/papers/${paperId}/notes`).then((saved) => {
      if (canceled) return;
      const value = localDraft ?? saved.text;
      noteDraftRef.current = value;
      noteRevisionRef.current = localDraft !== null && localDraft !== saved.text ? 1 : 0;
      noteSavedRevisionRef.current = 0;
      setNoteText(value);
      noteLoadedRef.current = true;
      setNotesLoaded(true);
      setNoteSaveStatus(storageFailure ? '保存失败' : noteRevisionRef.current ? '未保存' : '已保存');
      if (storageFailure) setNotesFailure('本地草稿存储不可用；请使用“保存笔记”保存到本机数据库。');
      if (localDraft === saved.text && localDraft !== null) {
        try { localStorage.removeItem(`paper-workbench.note-draft.${paperId}`); } catch { /* saved note is already durable */ }
      }
    }).catch((error) => {
      if (canceled) return;
      const value = localDraft ?? '';
      noteDraftRef.current = value;
      noteRevisionRef.current = localDraft !== null ? 1 : 0;
      noteSavedRevisionRef.current = 0;
      setNoteText(value);
      noteLoadedRef.current = true;
      setNotesLoaded(true);
      setNoteSaveStatus('保存失败');
      setNotesFailure(`${errorMessage(error)}${storageFailure ? '；本地草稿存储也不可用。' : ''}`);
    });
    void api<PdfAnnotation[]>(`/papers/${paperId}/annotations`).then((items) => {
      if (!canceled) setAnnotations(items);
    }).catch((error) => {
      if (!canceled) setAnnotationFailure(errorMessage(error));
    });
    return () => { canceled = true; };
  }, [paperId]);

  useEffect(() => {
    if (!notesLoaded || noteRevisionRef.current <= noteSavedRevisionRef.current) return;
    const text = noteText;
    const revision = noteRevisionRef.current;
    noteSaveTimerRef.current = window.setTimeout(() => { void persistPaperNotes(text, revision); }, 1000);
    return () => {
      if (noteSaveTimerRef.current !== null) window.clearTimeout(noteSaveTimerRef.current);
      noteSaveTimerRef.current = null;
    };
  }, [notesLoaded, noteText]);

  useEffect(() => () => {
    if (noteSaveTimerRef.current !== null) window.clearTimeout(noteSaveTimerRef.current);
    if (noteLoadedRef.current && noteRevisionRef.current > noteSavedRevisionRef.current) {
      saveNoteOnUnmountRef.current(noteDraftRef.current, noteRevisionRef.current);
    }
  }, [paperId]);

  useEffect(() => {
    const prepare = (event: Event) => {
      const detail = (event as CustomEvent<{ pending: Promise<void>[] }>).detail;
      detail.pending.push(flushNoteBeforeUpdateRef.current());
    };
    window.addEventListener('folio:prepare-update-install', prepare);
    return () => window.removeEventListener('folio:prepare-update-install', prepare);
  }, [paperId]);

  useEffect(() => {
    if (previousPdfKindRef.current === pdfKind) return;
    previousPdfKindRef.current = pdfKind;
    if (!pendingAnnotationJumpRef.current) pendingAnnotationJumpRef.current = { pdfKind, page: visiblePageRef.current };
    initialPageScrollPendingRef.current = true;
    setSelection(null);
    setHighlightPaletteOpen(false);
    setAnnotationDraft(null);
  }, [pdfKind]);

  useEffect(() => {
    if (active) return;
    setSelection(null);
    setHighlightPaletteOpen(false);
    setAnnotationDraft(null);
    if (anchorSettleTimerRef.current !== null) window.clearTimeout(anchorSettleTimerRef.current);
    anchorSettleTimerRef.current = null;
    resizingRef.current = false;
    resizeAnchorRef.current = null;
    resizeStartLayoutRef.current = null;
    pendingReaderLayoutRef.current = null;
    previewReaderLayout(readerLayoutRef.current);
  }, [active]);

  useEffect(() => {
    if (!active || !readerLayoutElement) return;
    const observer = new ResizeObserver(() => setReaderLayoutWidth(readerLayoutElement.clientWidth));
    observer.observe(readerLayoutElement);
    setReaderLayoutWidth(readerLayoutElement.clientWidth);
    return () => observer.disconnect();
  }, [active, readerLayoutElement]);

  useEffect(() => {
    if (!active || readerLayoutWidth < 1 || resizingRef.current) return;
    const next = fitReaderLayout(readerLayoutRef.current, readerLayoutWidth);
    if (next.outlineWidth === readerLayoutRef.current.outlineWidth && next.chatWidth === readerLayoutRef.current.chatWidth) return;
    readerLayoutRef.current = next;
    setReaderLayout(next);
    saveReaderLayout(next);
  }, [active, readerLayoutWidth]);

  useEffect(() => {
    const syncLayout = (event: StorageEvent) => {
      if (!active) return;
      if (event.key !== readerLayoutKey && event.key !== null) return;
      const next = fitReaderLayout(readReaderLayout(), readerLayoutElement?.clientWidth || window.innerWidth);
      const current = readerLayoutRef.current;
      if (next.outlineWidth === current.outlineWidth && next.chatWidth === current.chatWidth
        && next.outlineVisible === current.outlineVisible && next.chatVisible === current.chatVisible) return;
      captureReaderAnchor();
      readerLayoutRef.current = next;
      setReaderLayout(next);
      window.requestAnimationFrame(() => restoreReaderAnchor(false));
    };
    window.addEventListener('storage', syncLayout);
    return () => window.removeEventListener('storage', syncLayout);
  }, [active, pdfScrollElement, readerLayoutElement]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void Promise.all([api<Paper>(`/papers/${paperId}`), api<ReaderSettings>('/settings')]).then(([nextPaper, nextSettings]) => {
        setPaper((previous) => previous ? { ...previous, model_override: nextPaper.model_override } : previous);
        setSettings(nextSettings);
        if (!modelSavingRef.current) setCurrentModel(nextPaper.model_override || nextSettings.model || '');
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [active, paperId]);

  useEffect(() => {
    if (!active || !pdfScrollElement) return;
    const updateWidth = () => {
      if (resizingRef.current) return;
      setPdfScrollWidth(Math.max(0, pdfScrollElement.clientWidth - 40));
    };
    const observer = new ResizeObserver(updateWidth);
    observer.observe(pdfScrollElement);
    updateWidth();
    return () => observer.disconnect();
  }, [active, pdfScrollElement]);

  useLayoutEffect(() => {
    if (active && resizingRef.current) adjustReaderAnchor();
  }, [active, pdfScrollWidth, readerLayout.outlineWidth, readerLayout.chatWidth, readerLayout.outlineVisible, readerLayout.chatVisible, pdfScrollElement]);

  useLayoutEffect(() => {
    if (!active || !pdfScrollElement) return;
    if (hasActivatedReaderRef.current) pdfScrollElement.scrollTop = scrollPositionRef.current;
    hasActivatedReaderRef.current = true;
  }, [active, pdfScrollElement]);

  useEffect(() => {
    if (!active) return;
    const handleWindowResize = () => {
      if (resizingRef.current) return;
      captureReaderAnchor();
      if (anchorSettleTimerRef.current !== null) window.clearTimeout(anchorSettleTimerRef.current);
      anchorSettleTimerRef.current = window.setTimeout(() => restoreReaderAnchor(), 100);
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [active, pdfScrollElement, readerLayoutElement]);

  useEffect(() => {
    if (!paper?.can_read) return;
    let canceled = false;
    let loaded: SharedPdfDocument | null = null;
    setPdfDocument(null);
    setPageAspects([]);
    setPdfFailure('');
    void (async () => {
      try {
        loaded = await loadPdfDocument(paperId, pdfKind);
        const aspects = await pageAspectRatios(loaded, paper.page_count);
        if (canceled) {
          await loaded.destroy();
          return;
        }
        loadedPdfKindRef.current = pdfKind;
        setPageAspects(aspects);
        setPdfDocument(loaded);
      } catch (error) {
        if (!canceled) {
          const detail = error instanceof Error ? `${error.name}: ${error.message.slice(0, 180)}` : 'Unknown PDF load error';
          console.error('PDF document load failed', detail);
          setPdfFailure('无法打开这份 PDF，请重试。');
        }
      }
    })();
    return () => {
      canceled = true;
      if (loaded) void loaded.destroy();
    };
  }, [paper?.can_read, paper?.page_count, paperId, pdfKind]);

  useLayoutEffect(() => {
    const target = pendingAnnotationJumpRef.current;
    if (!active || !pdfDocument || loadedPdfKindRef.current !== pdfKind || !target || target.pdfKind !== pdfKind) return;
    pendingAnnotationJumpRef.current = null;
    visiblePageRef.current = target.page;
    setPageNumber(target.page);
    scrollPageIntoView(target.page, 'auto');
    initialPageScrollPendingRef.current = false;
  }, [active, pdfDocument, pdfKind, pdfScrollElement]);

  function scrollPageIntoView(target: number, behavior: ScrollBehavior = 'smooth') {
    if (!activeRef.current || !pdfScrollElement) return;
    const frame = pdfScrollElement.querySelector<HTMLElement>(`.pdf-page-frame[data-page-number="${target}"]`);
    if (!frame) return;
    const rootTop = pdfScrollElement.getBoundingClientRect().top;
    const frameTop = frame.getBoundingClientRect().top;
    pdfScrollElement.scrollTo({ top: pdfScrollElement.scrollTop + frameTop - rootTop - 12, behavior });
  }

  function goToPage(target: number) {
    if (!active) return;
    const next = Math.min(Math.max(target, 1), paper?.page_count || 1);
    visiblePageRef.current = next;
    setPageNumber(next);
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
    void api(`/papers/${paperId}/progress`, 'PATCH', { page: next }).catch(() => undefined);
    window.requestAnimationFrame(() => scrollPageIntoView(next));
  }

  function updatePageFromScroll(next: number) {
    if (!activeRef.current || initialPageScrollPendingRef.current || !paper || next < 1 || next > paper.page_count) return;
    const page = isAtPdfScrollEnd() ? paper.page_count : next;
    if (resizingRef.current || visiblePageRef.current === page) return;
    visiblePageRef.current = page;
    setPageNumber(page);
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      void api(`/papers/${paperId}/progress`, 'PATCH', { page }).catch(() => undefined);
    }, 250);
  }

  useEffect(() => {
    if (!active || !pdfDocument || !pdfScrollElement || restoredPaperRef.current !== paperId) return;
    const observerEpoch = activeEpochRef.current;
    let ignoreInitialObservation = hasActivatedReaderRef.current;
    hasActivatedReaderRef.current = true;
    const frames = pdfScrollElement.querySelectorAll<HTMLElement>('.pdf-page-frame');
    const observer = new IntersectionObserver((entries) => {
      if (!activeRef.current || observerEpoch !== activeEpochRef.current) return;
      if (ignoreInitialObservation) {
        ignoreInitialObservation = false;
        return;
      }
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible) updatePageFromScroll(Number((visible.target as HTMLElement).dataset.pageNumber));
    }, { root: pdfScrollElement, rootMargin: '-18% 0px -65% 0px', threshold: 0 });
    frames.forEach((frame) => observer.observe(frame));
    return () => observer.disconnect();
  }, [active, paperId, pdfDocument, pdfScrollElement, paper?.page_count]);

  useEffect(() => {
    if (!active || !pdfDocument || loadedPdfKindRef.current !== pdfKind || pendingAnnotationJumpRef.current || !initialPageScrollPendingRef.current) return;
    const restoredPage = pageNumber;
    window.requestAnimationFrame(() => {
      scrollPageIntoView(restoredPage, 'auto');
      initialPageScrollPendingRef.current = false;
    });
  }, [active, pdfDocument, pdfKind, pageNumber]);

  useEffect(() => () => {
    if (anchorSettleTimerRef.current !== null) window.clearTimeout(anchorSettleTimerRef.current);
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
  }, []);

  async function chooseModel(model: string) {
    const selected = model.trim();
    setCurrentModel(selected);
    setModelFailure('');
    modelSavingRef.current = true;
    try {
      const result = await api<{ model_override: string }>(`/papers/${paperId}/model`, 'PATCH', {
        model: selected === settings?.model ? null : selected,
      });
      setPaper((previous) => previous ? { ...previous, model_override: result.model_override } : previous);
    } catch (error) {
      setModelFailure(errorMessage(error));
    } finally {
      modelSavingRef.current = false;
    }
  }

  async function updateWebSearch(enabled: boolean) {
    const result = await api<{ web_search_enabled: boolean }>('/settings/web-search', 'PATCH', { enabled });
    setSettings((previous) => previous ? { ...previous, web_search_enabled: result.web_search_enabled } : previous);
  }

  function jumpToSource(source: Source) {
    if (source.kind === 'web' && source.url) {
      void window.workbench.openExternal(source.url);
      return;
    }
    setMode(paper?.source_language === 'zh' ? 'original' : 'bilingual');
    goToPage(source.start_page);
  }

  function findText(event: FormEvent) {
    event.preventDefault();
    const query = searchText.trim().toLocaleLowerCase();
    if (!query) return;
    const match = segments.find((segment) => segment.original_text.toLocaleLowerCase().includes(query));
    if (!match) {
      setSearchNotice('没有在可提取的原文中找到这段文字。');
      return;
    }
    setSearchNotice(`已跳到第 ${match.start_page} 页。`);
    setMode('original');
    goToPage(match.start_page);
    window.setTimeout(() => (window as Window & { find?: (text: string) => boolean }).find?.call(window, searchText.trim()), 800);
  }

  async function persistAnnotation(target: ReaderSelection, kind: 'highlight' | 'comment', color: PdfAnnotation['color'], comment = '') {
    const created = await api<PdfAnnotation>(`/papers/${paperId}/annotations`, 'POST', {
      pdf_kind: target.pdf_kind,
      page_no: target.page_no,
      rects: target.rects,
      selected_text: target.selected_text,
      comment,
      color,
      kind,
    });
    setAnnotations((previous) => [...previous, created]);
    setRightPanel('notes');
    setAnnotationFailure('');
    return created;
  }

  function clearPdfSelection() {
    setSelection(null);
    setHighlightPaletteOpen(false);
    window.getSelection()?.removeAllRanges();
  }

  function capturePdfSelection(value: PdfSelection | null, notice?: string) {
    if (!activeRef.current) return;
    if (!value) {
      setSelection(null);
      setHighlightPaletteOpen(false);
      if (notice) setSelectionNotice(notice);
      return;
    }
    setSelection({ ...value, pdf_kind: pdfKind });
    setHighlightPaletteOpen(false);
    setSelectionNotice('');
    setAnnotationFailure('');
  }

  async function addHighlight(color: PdfAnnotation['color']) {
    if (!selection) return;
    try {
      await persistAnnotation(selection, 'highlight', color);
      clearPdfSelection();
    } catch (error) {
      setAnnotationFailure(errorMessage(error));
    }
  }

  function beginAnnotationDraft() {
    if (!selection) return;
    setAnnotationDraft({ selection, comment: '' });
    setSelection(null);
    setHighlightPaletteOpen(false);
    setAnnotationFailure('');
  }

  async function saveAnnotationDraft() {
    if (!annotationDraft?.comment.trim()) {
      setAnnotationFailure('请填写批注内容。');
      return;
    }
    try {
      await persistAnnotation(annotationDraft.selection, 'comment', 'yellow', annotationDraft.comment.trim());
      setAnnotationDraft(null);
      clearPdfSelection();
    } catch (error) {
      setAnnotationFailure(errorMessage(error));
    }
  }

  function jumpToAnnotation(annotation: PdfAnnotation) {
    setRightPanel('notes');
    setSelectedAnnotation(annotation.id);
    const targetMode = annotation.pdf_kind === 'dual' ? 'bilingual' : annotation.pdf_kind;
    if (annotation.pdf_kind === pdfKind) {
      goToPage(annotation.page_no);
      return;
    }
    pendingAnnotationJumpRef.current = { pdfKind: annotation.pdf_kind, page: annotation.page_no };
    setMode(targetMode);
  }

  function beginEditingAnnotation(annotation: PdfAnnotation) {
    setEditingAnnotation(annotation.id);
    setAnnotationEditText(annotation.comment);
    setAnnotationFailure('');
  }

  async function saveEditedAnnotation(annotation: PdfAnnotation) {
    try {
      const updated = await api<PdfAnnotation>(`/papers/${paperId}/annotations/${annotation.id}`, 'PATCH', { comment: annotationEditText });
      setAnnotations((previous) => previous.map((item) => item.id === updated.id ? updated : item));
      setEditingAnnotation(null);
      setAnnotationFailure('');
    } catch (error) {
      setAnnotationFailure(errorMessage(error));
    }
  }

  async function deleteAnnotation(annotation: PdfAnnotation) {
    try {
      await api(`/papers/${paperId}/annotations/${annotation.id}`, 'DELETE');
      setAnnotations((previous) => previous.filter((item) => item.id !== annotation.id));
      if (selectedAnnotation === annotation.id) setSelectedAnnotation(null);
      if (editingAnnotation === annotation.id) setEditingAnnotation(null);
      setAnnotationFailure('');
    } catch (error) {
      setAnnotationFailure(errorMessage(error));
    }
  }

  return (
    <div className="reader-shell">
      {failure && <div className="reader-error" role="alert">{failure}</div>}
      {!paper?.can_read ? (
        <div className="reader-blocked"><span className="eyebrow">尚未开放阅读</span><h1>{paper ? '中文 PDF 仍在生成' : '正在准备阅读窗口'}</h1><p>{paper?.error || '中文 PDF 与双语 PDF 均生成并通过检查后，才会开放阅读。'}</p></div>
      ) : (
        <div className="reader-layout" ref={setReaderLayoutElement}>
          <aside
            className={`reader-outline ${readerLayout.outlineVisible ? '' : 'reader-column-hidden'}`}
            style={{ width: readerLayout.outlineVisible ? readerLayout.outlineWidth : 0, flexBasis: readerLayout.outlineVisible ? readerLayout.outlineWidth : 0 }}
            aria-hidden={!readerLayout.outlineVisible}
          >
            <div className="reader-library-navigation">{libraryNavigation}</div>
            <div className="outline-heading"><span className="eyebrow">本篇目录</span><span>{paper.page_count} 页</span></div>
            {mode !== 'mono' && <form className="pdf-search reader-outline-search" onSubmit={findText}><input aria-label={paper.source_language === 'zh' ? '搜索原文' : '搜索英文原文'} value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={paper.source_language === 'zh' ? '搜索原文' : '搜索英文原文'} /><button className="secondary-button compact-button">查找</button></form>}
            <div className="page-index-list">
              {pages.map((page) => {
                const first = segments.find((segment) => segment.start_page === page.page_no);
                return <button key={page.page_no} className={page.page_no === pageNumber ? 'page-index current' : 'page-index'} onClick={() => goToPage(page.page_no)}>
                  <span className="page-index-number">{page.page_no}</span><span className="page-index-label">{first?.original_text.slice(0, 34) || '空白页'}</span>
                </button>;
              })}
            </div>
          </aside>
          {readerLayout.outlineVisible && <LayoutSeparator
            testId="outline-resizer" label="调整导航宽度" value={readerLayout.outlineWidth} min={140}
            max={Math.max(140, readerLayoutWidth - 320 - 10 - Number(readerLayout.chatVisible) * 10 - (readerLayout.chatVisible ? 280 : 0))}
            onStart={startReaderResize} onResize={(width) => resizeReaderPanel('outline', width)} onEnd={restoreReaderAnchor}
          />}
          <main className="reading-column">
            <div className="reading-toolbar">
              <button className="reader-toolbar-icon" type="button" data-testid="toggle-outline" aria-label={readerLayout.outlineVisible ? '隐藏导航' : '显示导航'} aria-pressed={!readerLayout.outlineVisible} onClick={() => toggleReaderPanel('outline')}>{readerLayout.outlineVisible ? '☰' : '›'}</button>
              {paper.source_language === 'zh' ? <span className="reader-binding">中文原文</span> : <div className="reader-mode-switch" role="group" aria-label="PDF 阅读模式">
                <button type="button" className={mode === 'original' ? 'mode-button active' : 'mode-button'} aria-label="原文 PDF" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>原文</button>
                <button type="button" className={mode === 'mono' ? 'mode-button active' : 'mode-button'} aria-label="中文 PDF" aria-pressed={mode === 'mono'} onClick={() => setMode('mono')}>中文</button>
                <button type="button" className={mode === 'bilingual' ? 'mode-button active' : 'mode-button'} aria-label="双语对照" aria-pressed={mode === 'bilingual'} onClick={() => setMode('bilingual')}>双语</button>
              </div>}
              <span className="reading-toolbar-spacer" />
              <div className="page-stepper">
                <button className="icon-button" aria-label="上一页" onClick={() => goToPage(pageNumber - 1)} disabled={pageNumber <= 1}>‹</button>
                <input aria-label="当前页码" type="number" min={1} max={paper.page_count} value={pageNumber} onChange={(event) => goToPage(Number(event.target.value))} />
                <span>/ {paper.page_count}</span>
                <button className="icon-button" aria-label="下一页" onClick={() => goToPage(pageNumber + 1)} disabled={pageNumber >= paper.page_count}>›</button>
              </div>
              <div className="zoom-controls"><button className="secondary-button compact-button" aria-label="缩小 PDF" onClick={() => setPdfScale((scale) => Math.max(0.5, Math.round((scale - 0.1) * 100) / 100))}>−</button><span>{Math.round(pdfScale * 100)}%</span><button className="secondary-button compact-button" aria-label="放大 PDF" onClick={() => setPdfScale((scale) => Math.min(2.5, Math.round((scale + 0.1) * 100) / 100))}>＋</button></div>
              <button className="reader-toolbar-icon" type="button" aria-label="打开当前 PDF 文件位置" title="文件位置" onClick={() => void window.workbench.revealPaperFile(paperId, pdfKind).catch((error) => setFailure(errorMessage(error)))}>↗</button>
              <button className="reader-toolbar-icon" type="button" data-testid="toggle-chat" aria-label={readerLayout.chatVisible ? '隐藏 AI 助手' : '显示 AI 助手'} aria-pressed={!readerLayout.chatVisible} onClick={() => toggleReaderPanel('chat')}>{readerLayout.chatVisible ? '◫' : '◧'}</button>
              {searchNotice && <span className="search-result">{searchNotice}</span>}
              {selectionNotice && <span className="selection-notice" role="status">{selectionNotice}</span>}
            </div>
            <div className="pdf-scroll" ref={setPdfScrollElement} data-testid="pdf-scroll" data-pdf-kind={pdfDocument ? loadedPdfKindRef.current : undefined} aria-label="PDF 页面滚动区" onScroll={(event) => {
              if (!activeRef.current) return;
              if (selection) setSelection(null);
              scrollPositionRef.current = event.currentTarget.scrollTop;
              if (isAtPdfScrollEnd() && paper) updatePageFromScroll(paper.page_count);
            }}>
              {pdfFailure ? <div className="pdf-error">{pdfFailure}</div> : !pdfDocument ? <div className="pdf-loading">正在载入 PDF…</div> : (
                <div className="pdf-pages">
                  {Array.from({ length: paper.page_count }, (_, index) => index + 1).map((page) => (
                    <PdfPage
                      key={`${pdfKind}-${page}`}
                      document={pdfDocument}
                      pageNumber={page}
                      scale={pdfScale}
                      containerWidth={pdfScrollWidth}
                      scrollRoot={pdfScrollElement}
                      pageAspectRatio={pageAspects[page - 1] || 0.72}
                      annotations={annotations.filter((item) => item.pdf_kind === pdfKind && item.page_no === page)}
                      active={active}
                      onSelection={capturePdfSelection}
                    />
                  ))}
                </div>
              )}
            </div>
          </main>
          {readerLayout.chatVisible && <LayoutSeparator
            testId="chat-resizer" label="调整 AI 助手宽度" value={readerLayout.chatWidth} min={280} reverse
            max={Math.max(280, readerLayoutWidth - 320 - Number(readerLayout.outlineVisible) * 10 - (readerLayout.outlineVisible ? 140 : 0) - 10)}
            onStart={startReaderResize} onResize={(width) => resizeReaderPanel('chat', width)} onEnd={restoreReaderAnchor}
          />}
          <div
            className={`chat-column ${readerLayout.chatVisible ? '' : 'reader-column-hidden'}`}
            style={{ width: readerLayout.chatVisible ? readerLayout.chatWidth : 0, flexBasis: readerLayout.chatVisible ? readerLayout.chatWidth : 0 }}
            aria-hidden={!readerLayout.chatVisible}
          >
            <div className="reader-assistant-heading"><h2>文献助手</h2></div>
            <div className="reader-side-tabs" role="tablist" aria-label="阅读侧栏">
              <button id={`reader-side-tab-chat-${paperId}`} type="button" role="tab" data-testid="reader-side-tab-chat" aria-label="问答（AI 助手）" aria-controls={`reader-side-panel-chat-${paperId}`} aria-selected={rightPanel === 'chat'} className={rightPanel === 'chat' ? 'active' : ''} onClick={() => setRightPanel('chat')}>问答</button>
              <button id={`reader-side-tab-notes-${paperId}`} type="button" role="tab" data-testid="reader-side-tab-notes" aria-controls={`reader-side-panel-notes-${paperId}`} aria-selected={rightPanel === 'notes'} className={rightPanel === 'notes' ? 'active' : ''} onClick={() => setRightPanel('notes')}>笔记</button>
            </div>
            <div id={`reader-side-panel-chat-${paperId}`} className="reader-side-content" role="tabpanel" aria-labelledby={`reader-side-tab-chat-${paperId}`} hidden={rightPanel !== 'chat'}>
              <PaperChats
                paperId={paperId} title={paper.chinese_title || paper.english_title} active={active} visible={rightPanel === 'chat'}
                onJump={jumpToSource}
                settings={settings} currentModel={currentModel} modelFailure={modelFailure}
                onModelChange={chooseModel} onWebSearchChange={updateWebSearch}
              />
            </div>
            <section id={`reader-side-panel-notes-${paperId}`} className="reader-notes-panel" role="tabpanel" aria-labelledby={`reader-side-tab-notes-${paperId}`} hidden={rightPanel !== 'notes'}>
              <div className="reader-notes-heading">
                <h2>阅读笔记</h2>
                <span data-testid="reader-note-save-status" role="status">{notesLoaded ? noteSaveStatus : '正在载入…'}</span>
              </div>
              <textarea
                data-testid="reader-note-editor" aria-label="阅读笔记" value={noteText} disabled={!notesLoaded}
                placeholder="记录这篇文献的阅读笔记…" onChange={(event) => changeNoteText(event.target.value)}
              />
              <div className="reader-note-actions">
                <span>{notesFailure && <span className="reader-note-error" role="alert">{notesFailure}</span>}</span>
                <button type="button" className="primary-button compact-button" disabled={!notesLoaded || noteSaveStatus === '保存中…' || noteSaveStatus === '已保存'} onClick={() => void persistPaperNotes(noteDraftRef.current, noteRevisionRef.current)}>保存笔记</button>
              </div>
              <div className="reader-annotations-heading"><h3>高亮与批注</h3><span>{annotations.length}</span></div>
              {annotationFailure && <div className="reader-note-error" role="alert">{annotationFailure}</div>}
              <div className="reader-annotations-list" data-testid="reader-annotations-list">
                {annotations.length === 0 && <p className="reader-annotations-empty">选中 PDF 文字即可添加高亮或批注。</p>}
                {annotations.map((annotation) => <article
                  className={`reader-annotation-card${selectedAnnotation === annotation.id ? ' selected' : ''}`}
                  key={annotation.id} data-testid={`reader-annotation-${annotation.id}`} data-annotation-id={annotation.id}
                >
                  <div className="reader-annotation-card-heading">
                    <span className={`annotation-color-dot annotation-color-${annotation.color}`} aria-hidden="true" />
                    <span className="reader-annotation-location">第 {annotation.page_no} 页 · {annotation.pdf_kind === 'dual' ? '双语对照' : annotation.pdf_kind === 'mono' ? '中文 PDF' : '原文 PDF'}</span>
                    <button type="button" className="reader-annotation-jump" aria-label="跳到此处" onClick={() => jumpToAnnotation(annotation)}>跳到此处</button>
                  </div>
                  <blockquote>{annotation.selected_text}</blockquote>
                  {editingAnnotation === annotation.id ? <>
                    <textarea aria-label="批注内容" value={annotationEditText} onChange={(event) => setAnnotationEditText(event.target.value)} />
                    <div className="reader-annotation-actions">
                      <button type="button" className="secondary-button compact-button" onClick={() => setEditingAnnotation(null)}>取消</button>
                      <button type="button" className="primary-button compact-button" onClick={() => void saveEditedAnnotation(annotation)}>保存批注</button>
                    </div>
                  </> : <>
                    {annotation.comment && <p className="reader-annotation-comment">{annotation.comment}</p>}
                    <div className="reader-annotation-actions">
                      <button type="button" className="secondary-button compact-button" onClick={() => beginEditingAnnotation(annotation)}>{annotation.kind === 'comment' ? '编辑批注' : '编辑备注'}</button>
                      <button type="button" className="secondary-button compact-button" onClick={() => void deleteAnnotation(annotation)}>{annotation.kind === 'highlight' ? '删除高亮' : '删除批注'}</button>
                    </div>
                  </>}
                </article>)}
              </div>
            </section>
          </div>
        </div>
      )}
      {selection && active && <div
        className="pdf-selection-toolbar"
        data-testid="reader-selection-toolbar"
        style={{ left: Math.max(8, Math.min(window.innerWidth - 320, selection.anchor.left)), top: Math.max(8, selection.anchor.top - 46) }}
      >
        <button type="button" aria-label="高亮" aria-expanded={highlightPaletteOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setHighlightPaletteOpen((open) => !open)}>高亮</button>
        <button type="button" aria-label="批注" onMouseDown={(event) => event.preventDefault()} onClick={beginAnnotationDraft}>批注</button>
        <button type="button" aria-label="取消文字选择" onMouseDown={(event) => event.preventDefault()} onClick={clearPdfSelection}>×</button>
        {highlightPaletteOpen && <div className="pdf-highlight-palette" role="group" aria-label="高亮颜色">
          <button type="button" className="annotation-color-yellow" aria-label="黄色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('yellow')} />
          <button type="button" className="annotation-color-green" aria-label="绿色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('green')} />
          <button type="button" className="annotation-color-blue" aria-label="蓝色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('blue')} />
          <button type="button" className="annotation-color-pink" aria-label="粉色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('pink')} />
        </div>}
      </div>}
      {annotationDraft && active && <div
        className="pdf-annotation-draft"
        style={{ left: Math.max(8, Math.min(window.innerWidth - 320, selection?.anchor.left || annotationDraft.selection.anchor.left)), top: Math.min(window.innerHeight - 220, annotationDraft.selection.anchor.bottom + 8) }}
        onMouseDown={(event) => { if ((event.target as HTMLElement).tagName !== 'TEXTAREA') event.preventDefault(); }}
      >
        <div className="annotation-draft-selection">第 {annotationDraft.selection.page_no} 页 · {annotationDraft.selection.selected_text}</div>
        <textarea aria-label="批注内容" autoFocus value={annotationDraft.comment} onChange={(event) => setAnnotationDraft((current) => current ? { ...current, comment: event.target.value } : current)} placeholder="写下这处文字的批注…" />
        {annotationFailure && <div className="reader-note-error" role="alert">{annotationFailure}</div>}
        <div className="reader-annotation-actions">
          <button type="button" className="secondary-button compact-button" onClick={() => setAnnotationDraft(null)}>取消</button>
          <button type="button" className="primary-button compact-button" onClick={() => void saveAnnotationDraft()}>保存批注</button>
        </div>
      </div>}
    </div>
  );
}

function LayoutSeparator({
  testId, label, value, min, max, reverse = false, onStart, onResize, onEnd,
}: {
  testId: string; label: string; value: number; min: number; max: number; reverse?: boolean;
  onStart: () => void; onResize: (value: number) => void; onEnd: () => void;
}) {
  const drag = useRef<{ x: number; value: number; pointerId: number } | null>(null);
  const separator = useRef<HTMLDivElement>(null);
  const pendingWidth = useRef<number | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const finishRef = useRef<() => void>(() => undefined);

  function applyResize(width: number) {
    onResize(width);
    separator.current?.setAttribute('aria-valuenow', String(Math.round(width)));
  }

  function flushResize() {
    if (resizeFrame.current !== null) window.cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    const width = pendingWidth.current;
    pendingWidth.current = null;
    if (width !== null) applyResize(width);
  }

  function queueResize(width: number) {
    pendingWidth.current = width;
    if (resizeFrame.current !== null) return;
    resizeFrame.current = window.requestAnimationFrame(() => {
      resizeFrame.current = null;
      const next = pendingWidth.current;
      pendingWidth.current = null;
      if (next !== null) applyResize(next);
    });
  }

  useEffect(() => () => {
    if (resizeFrame.current !== null) window.cancelAnimationFrame(resizeFrame.current);
  }, []);

  function finish(event?: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    flushResize();
    const pointerId = drag.current.pointerId;
    const target = event?.currentTarget || separator.current;
    drag.current = null;
    if (target?.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    onEnd();
  }

  finishRef.current = () => finish();

  useEffect(() => {
    const finishOnBlur = () => finishRef.current();
    window.addEventListener('blur', finishOnBlur);
    return () => window.removeEventListener('blur', finishOnBlur);
  }, []);
  return <div
    ref={separator}
    className="reader-resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    tabIndex={0}
    data-testid={testId}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, value, pointerId: event.pointerId };
      onStart();
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      const direction = reverse ? -1 : 1;
      queueResize(bounded(drag.current.value + (event.clientX - drag.current.x) * direction, min, max));
    }}
    onPointerUp={(event) => finish(event)}
    onPointerCancel={(event) => finish(event)}
    onLostPointerCapture={() => finish()}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      onStart();
      if (event.key === 'Home') applyResize(min);
      else if (event.key === 'End') applyResize(max);
      else {
        const delta = (event.key === 'ArrowRight' ? 1 : -1) * (reverse ? -1 : 1) * (event.shiftKey ? 40 : 12);
        applyResize(bounded(value + delta, min, max));
      }
      onEnd();
    }}
  />;
}

type ActiveStream = {
  answer: string; reasoning: string; phase: string; tool?: string; query?: string;
  runId?: string; messageId?: number; requestId?: string; sources: Source[];
};

type PaperChatsProps = {
  paperId: string; title: string; active: boolean; visible: boolean;
  onJump: (source: Source) => void;
  settings: ReaderSettings | null; currentModel: string; modelFailure: string;
  onModelChange: (model: string) => Promise<void>;
  onWebSearchChange: (enabled: boolean) => Promise<void>;
};
type ChatSession = { id: string; title: string; created_at: string };

function PaperChats(props: PaperChatsProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState('');
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({});
  const [changing, setChanging] = useState(false);
  const [failure, setFailure] = useState('');
  const selectionKey = `paper-workbench.chat-session.${props.paperId}`;

  useEffect(() => {
    let cancelled = false;
    void api<ChatSession[]>(`/papers/${props.paperId}/chat-sessions`).then((list) => {
      if (cancelled) return;
      let saved = '';
      try { saved = localStorage.getItem(selectionKey) || ''; } catch { /* session history is stored in the database */ }
      setSessions(list);
      setCurrentSession(list.some((session) => session.id === saved) ? saved : list[0]?.id || '');
    }).catch((error) => { if (!cancelled) setFailure(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [props.paperId, selectionKey]);

  useEffect(() => {
    if (currentSession) {
      try { localStorage.setItem(selectionKey, currentSession); } catch { /* selecting a session still works */ }
    }
  }, [currentSession, selectionKey]);

  const markBusy = useCallback((id: string, busy: boolean) => {
    setBusySessions((previous) => previous[id] === busy ? previous : { ...previous, [id]: busy });
  }, []);

  async function newSession() {
    if (changing) return;
    setChanging(true);
    setFailure('');
    try {
      const created = await api<ChatSession>(`/papers/${props.paperId}/chat-sessions`, 'POST', {});
      setSessions((previous) => [...previous, created]);
      setCurrentSession(created.id);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setChanging(false); }
  }

  async function deleteSession(session: ChatSession) {
    if (changing || busySessions[session.id] || !window.confirm(`删除“${session.title}”的聊天记录？PDF、笔记和其他会话会保留。`)) return;
    setChanging(true);
    setFailure('');
    try {
      await api(`/papers/${props.paperId}/chat-sessions/${session.id}`, 'DELETE');
      const list = await api<ChatSession[]>(`/papers/${props.paperId}/chat-sessions`);
      setSessions(list);
      if (currentSession === session.id) setCurrentSession(list[0]?.id || '');
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setChanging(false); }
  }

  return <div className="paper-chats">
    <div className="chat-session-bar">
      <div className="chat-session-tabs" role="tablist" aria-label="文献 AI 会话">
        {sessions.map((session) => <div className={`chat-session-tab ${session.id === currentSession ? 'active' : ''}`} key={session.id}>
          <button type="button" role="tab" aria-selected={session.id === currentSession} data-testid={`chat-session-${session.id}`} title={session.title} onClick={() => setCurrentSession(session.id)}>{session.title}</button>
          <button type="button" className="chat-session-close" aria-label={`删除会话 ${session.title}`} title={busySessions[session.id] ? '请先停止此会话的生成' : '删除此会话'} disabled={changing || busySessions[session.id]} onClick={() => void deleteSession(session)}>×</button>
        </div>)}
      </div>
      <button type="button" className="chat-session-new" aria-label="新建 AI 会话" title="新建会话" disabled={changing || !sessions.length} onClick={() => void newSession()}>＋</button>
    </div>
    {failure && <div className="chat-error" role="alert">{failure}</div>}
    {!sessions.length && !failure && <div className="chat-empty">正在读取会话…</div>}
    {sessions.map((session) => <div className="chat-session-content" data-session-id={session.id} key={session.id} hidden={session.id !== currentSession}>
      <ChatPanel {...props} sessionId={session.id} visible={props.visible && session.id === currentSession} onBusyChange={markBusy} />
    </div>)}
  </div>;
}

function ChatPanel({ paperId, title, active, visible, onJump, settings, currentModel, modelFailure, onModelChange, onWebSearchChange, sessionId, onBusyChange }: PaperChatsProps & {
  sessionId: string; onBusyChange: (id: string, busy: boolean) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesTopRef = useRef(0);
  const followLatestRef = useRef(true);
  const [followingLatest, setFollowingLatest] = useState(true);
  const activeRef = useRef<ActiveStream | null>(null);
  const handleRef = useRef<ChatStreamHandle | null>(null);

  const refresh = useCallback(async () => {
    const [nextMessages, nextRuns] = await Promise.all([
      api<ChatMessage[]>(`/papers/${paperId}/chat?session_id=${sessionId}`),
      api<AnalysisRun[]>(`/papers/${paperId}/analysis?session_id=${sessionId}`),
    ]);
    setMessages(nextMessages);
    setRuns(nextRuns);
  }, [paperId, sessionId]);

  useEffect(() => {
    if (active && visible) void refresh().catch((error) => setFailure(errorMessage(error)));
  }, [active, visible, refresh]);
  useEffect(() => { onBusyChange(sessionId, busy); }, [sessionId, busy, onBusyChange]);

  useEffect(() => {
    if (settings) setWebSearchEnabled(settings.web_search_enabled);
  }, [settings?.web_search_enabled]);
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (active && visible && container) container.scrollTop = followLatestRef.current ? container.scrollHeight : messagesTopRef.current;
  }, [active, visible, messages, runs, activeStream?.answer, activeStream?.reasoning]);

  function followLatest() {
    followLatestRef.current = true;
    setFollowingLatest(true);
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }

  function finishStream(event: ChatStreamEvent, current: ActiveStream) {
    const data = event.data;
    const messageId = typeof data.message_id === 'number' ? data.message_id : current.messageId;
    const finalState = {
      ...current,
      messageId,
      answer: event.type === 'done' && typeof data.answer === 'string' ? data.answer : current.answer,
    };
    activeRef.current = finalState;
    setActiveStream(finalState);
    setBusy(false);
    setStopping(false);
    if (event.type === 'error') setFailure(typeof data.message === 'string' ? data.message : '生成失败，部分内容已保留。');
    const handle = handleRef.current;
    handleRef.current = null;
    handle?.dispose();
    void refresh().catch((error) => setFailure(errorMessage(error))).finally(() => {
      if (activeRef.current === finalState) {
        activeRef.current = null;
        setActiveStream(null);
      }
    });
  }

  async function startStream(input: { question?: string; runId?: string }) {
    followLatest();
    const initial: ActiveStream = {
      answer: '', reasoning: '', phase: 'thinking', runId: input.runId, sources: [],
    };
    activeRef.current = initial;
    setActiveStream(initial);
    setBusy(true);
    setStopping(false);
    let ended = false;
    try {
      const handle = await window.workbench.startChatStream({
        paperId, sessionId, question: input.question, runId: input.runId,
        model: currentModel, webSearch: webSearchEnabled,
      }, (event) => {
        const previous = activeRef.current;
        if (!previous || (previous.requestId && previous.requestId !== event.requestId)) return;
        const data = event.data;
        const messageId = typeof data.message_id === 'number' ? data.message_id : previous.messageId;
        if (['done', 'cancelled', 'error'].includes(event.type)) {
          ended = true;
          finishStream(event, { ...previous, messageId });
          return;
        }
        let next = { ...previous, messageId };
        if (event.type === 'status') {
          next = {
            ...next,
            phase: typeof data.phase === 'string' ? data.phase : next.phase,
            tool: typeof data.tool === 'string' ? data.tool : undefined,
            query: typeof data.query === 'string' ? data.query : undefined,
            runId: typeof data.run_id === 'string' ? data.run_id : next.runId,
          };
        } else if (event.type === 'content_delta' && typeof data.text === 'string') {
          next.answer += data.text;
        } else if (event.type === 'reasoning_delta' && typeof data.text === 'string') {
          next.reasoning += data.text;
        } else if (event.type === 'turn_reset') {
          next.answer = '';
        } else if (event.type === 'sources' && Array.isArray(data.sources)) {
          next.sources = data.sources as Source[];
        }
        activeRef.current = next;
        setActiveStream(next);
      });
      if (!ended && activeRef.current) {
        const next = { ...activeRef.current, requestId: handle.requestId };
        activeRef.current = next;
        handleRef.current = handle;
        setActiveStream(next);
      } else {
        handle.dispose();
      }
    } catch (error) {
      handleRef.current?.dispose();
      handleRef.current = null;
      activeRef.current = null;
      setActiveStream(null);
      setBusy(false);
      setFailure(errorMessage(error));
      await refresh().catch((error) => setFailure(errorMessage(error)));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setQuestion('');
    setFailure('');
    await startStream({ question: text });
  }

  async function resume(run: AnalysisRun) {
    if (busy) return;
    setFailure('');
    await startStream({ runId: run.id });
  }

  async function stop() {
    const handle = handleRef.current;
    if (!handle || stopping) return;
    setStopping(true);
    try {
      await handle.cancel();
    } catch (error) {
      setStopping(false);
      setFailure(errorMessage(error));
    }
  }

  function changeWebSearch(enabled: boolean) {
    const previous = webSearchEnabled;
    setWebSearchEnabled(enabled);
    setFailure('');
    void onWebSearchChange(enabled).catch((error) => {
      setWebSearchEnabled(previous);
      setFailure(errorMessage(error));
    });
  }

  const visibleMessages = messages.filter((message) =>
    message.status !== 'streaming' && !(activeStream?.messageId && message.id === activeStream.messageId));
  const activeLabel = activeStream?.phase === 'tool'
    ? activeStream.tool === 'web_search' ? '正在搜索网页…'
      : activeStream.tool === 'read_paper' ? '正在读取相关原文…'
        : activeStream.tool === 'summarize_paper' || activeStream.runId ? '正在发送整篇原文…' : '正在使用文献工具…'
    : activeStream?.runId ? '正在发送整篇原文…' : '正在生成回答…';

  return (
    <aside className="chat-panel">
      <div className="chat-heading">
        <div className="chat-bound-paper" title={title}>当前文献 · {title}</div>
      </div>
      <div className="chat-messages" ref={messagesRef} data-testid="chat-messages" aria-live="polite" onWheel={(event) => {
        if (event.deltaY < 0) { followLatestRef.current = false; setFollowingLatest(false); }
      }} onScroll={(event) => {
        if (!active || !visible) return;
        const container = event.currentTarget;
        messagesTopRef.current = container.scrollTop;
        const following = container.scrollHeight - container.scrollTop - container.clientHeight <= 4;
        followLatestRef.current = following;
        setFollowingLatest(following);
      }}>
        {visibleMessages.length === 0 && runs.length === 0 && !activeStream && <div className="chat-empty"><div className="chat-empty-mark" aria-hidden="true">问</div><p>可以直接问“详细总结一下这篇文献”，也可以询问实验设计、数据或结论。</p></div>}
        {visibleMessages.map((message, index) => <Message key={message.id ?? `${message.created_at || index}-${index}`} message={message} onJump={onJump} />)}
        {runs.filter((run) => !(run.status === 'running' && activeStream?.runId === run.id)).map((run) => <div className="run-card" key={run.id}>
          <div className="run-title">{run.kind === 'full_prompt' ? '整篇原文总结' : '全文分块总结'} {run.status === 'running' ? '进行中' : run.status === 'completed' ? '已完成' : '未完成'}</div>
          <div className="run-progress">{run.kind === 'full_prompt' ? '整篇原文以一次请求发送，不截断或拆分。' : `已覆盖 ${run.completed_chunks}/${run.total_chunks} 个正文分块`}</div>
          {run.error && <p className="paper-error">{run.error}</p>}
          {run.status !== 'running' && run.status !== 'completed' && <button className="secondary-button compact-button" disabled={busy} onClick={() => void resume(run)}>继续总结</button>}
        </div>)}
        {activeStream && <div className="chat-message assistant active-chat-stream">
          <div className="message-role">Folio · 正在生成</div>
          {activeStream.reasoning && <details className="reasoning-panel" open><summary>思考过程</summary><div data-testid="streaming-reasoning">{activeStream.reasoning}</div></details>}
          <div className="message-content" data-testid="streaming-answer"><MarkdownContent markdown={activeStream.answer || '…'} sources={activeStream.sources} onJump={onJump} /></div>
          <div className="assistant-thinking"><span className="typing-dots">•••</span>{activeLabel}{activeStream.query ? ` ${activeStream.query}` : ''}</div>
        </div>}
      </div>
      {!followingLatest && <button className="chat-follow-latest" type="button" onClick={followLatest}>回到最新 ↓</button>}
      {failure && <div className="chat-error" role="alert">{failure}</div>}
      <form className="chat-composer" onSubmit={(event) => void send(event)}>
        <textarea aria-label="向当前文献提问" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event); }
        }} placeholder="询问这篇文献…" rows={3} />
        <div className="composer-footer">
          <div className="composer-options">
            <label className="web-search-toggle"><input type="checkbox" aria-label="联网搜索" checked={webSearchEnabled} disabled={!settings || busy} onChange={(event) => changeWebSearch(event.target.checked)} />联网搜索</label>
          </div>
          <div className="composer-actions">
            <div className="model-picker" title={currentModel || undefined}>
              <span className="model-picker-name" data-testid="reader-model-name" title={currentModel || undefined}>{currentModel || '正在加载模型…'}</span>
              <span className="model-picker-chevron" data-testid="reader-model-chevron" aria-hidden="true">▾</span>
              <select
                aria-label="当前 AI 模型" data-testid="reader-model-select" title={currentModel || undefined}
                value={currentModel} disabled={!settings || !currentModel}
                onChange={(event) => void onModelChange(event.target.value)}
              >
                {!currentModel && <option value="">正在加载模型…</option>}
                {settings?.model && <option value={settings.model}>{settings.model}</option>}
                {currentModel && currentModel !== settings?.model && !settings?.model_options.includes(currentModel) && <option value={currentModel}>{currentModel}</option>}
                {settings?.model_options.filter((model) => model !== settings.model).map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </div>
            {busy ? <button type="button" className="secondary-button send-button" aria-label="停止生成" disabled={!handleRef.current || stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止生成'}</button>
              : <button className="primary-button send-button" disabled={!question.trim()}>发送 ↑</button>}
          </div>
          {modelFailure && <div className="reader-model-error" role="alert">{modelFailure}</div>}
        </div>
      </form>
    </aside>
  );
}

function normalizeMathDelimiters(markdown: string): string {
  const code: string[] = [];
  const protectedMarkdown = markdown.replace(/```[\s\S]*?```|`[^`\n]*`/g, (match) => {
    const index = code.push(match) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  return protectedMarkdown
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `$$\n${formula}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, formula: string) => `$${formula}$`)
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => code[Number(index)]);
}

function MarkdownContent({ markdown, sources, onJump }: { markdown: string; sources?: Source[]; onJump: (source: Source) => void }) {
  const sourceMap = new Map((sources || []).map((source) => [source.id, source]));
  const linkedMarkdown = normalizeMathDelimiters(markdown).replace(/\[((?:S|W)\d{1,10})\]/g, (match, sourceId: string) => {
    const source = sourceMap.get(sourceId);
    if (!source) return match;
    const label = source.kind === 'web'
      ? `[网页：${source.title || '来源'} ↗]`
      : `[第 ${source.start_page}${source.end_page !== source.start_page ? `–${source.end_page}` : ''} 页 ↗]`;
    return `${label}(#source-${sourceId})`;
  });
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]}
    components={{
      a: ({ href, children }) => {
        const sourceId = href?.match(/^#source-((?:S|W)\d{1,10})$/)?.[1];
        const source = sourceId ? sourceMap.get(sourceId) : undefined;
        if (source) return <button type="button" className="citation-button" onClick={() => onJump(source)}>{children}</button>;
        if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
        return <button type="button" className="markdown-external-link" onClick={() => void window.workbench.openExternal(href)}>{children}</button>;
      },
      img: ({ alt }) => <span className="markdown-image-note">[图片未加载{alt ? `：${alt}` : ''}]</span>,
    }}
  >
    {linkedMarkdown}
  </ReactMarkdown>;
}

function Message({ message, onJump }: { message: ChatMessage; onJump: (source: Source) => void }) {
  const incomplete = message.role === 'assistant' && message.status && message.status !== 'completed';
  return <div className={`chat-message ${message.role}`}>
    <div className="message-role">{message.role === 'user' ? '你' : 'Folio'}{incomplete ? ` · ${message.status === 'cancelled' ? '已停止，未完成' : message.status === 'interrupted' ? '窗口关闭时中断' : message.status === 'error' ? '未完成' : '处理中断'}` : ''}</div>
    {message.reasoning && <details className="reasoning-panel"><summary>思考过程</summary><div>{message.reasoning}</div></details>}
    <div className="message-content"><MarkdownContent markdown={message.content} sources={message.sources} onJump={onJump} /></div>
    {message.error && <div className="message-incomplete-error">{message.error}</div>}
    {(message.sources || []).some((source) => source.kind === 'web' && source.url) && <div className="web-source-list">
      <div>网页来源</div>
      {(message.sources || []).filter((source) => source.kind === 'web' && source.url).map((source) => <button type="button" key={source.id} onClick={() => onJump(source)}>{source.title || source.url}</button>)}
    </div>}
  </div>;
}
