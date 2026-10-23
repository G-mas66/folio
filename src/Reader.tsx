import { FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { AgentAction, AgentActionCandidate, api, ChatAttachment, ChatMessage, ChatStreamEvent, ChatStreamHandle, errorMessage, Paper, PaperNote, PaperNotes, PdfAnnotation, PdfSelection, ReasoningEffort, ReasoningThinking, Segment, SelectionContext, Source } from './api';
import { loadPdfDocument, pageAspectRatios, PdfPage, PdfKind, SharedPdfDocument, type PdfTextMappingRequest, type PdfTextMappingResult } from './PdfPage';
import './reader-reference.css';
import { ChatComposer, ChatAttachmentList, type ChatAttachmentView } from './ChatComposer';
import { ChatTurnNavigation } from './ChatTurnNavigation';
import './chat-upgrade.css';
import { ReaderNotesPanel } from './ReaderNotesPanel';
import { ResearchTasksPanel } from './ResearchTasksPanel';
import { annotationMappingCandidates, normalizePdfText } from './annotationMapping';
import { renderPdfAttachment } from './PdfAttachment';

type Page = { page_no: number; extraction_status: string; text_chars: number };
type AnalysisRun = {
  id: string; kind: string; status: string; error: string; completed_chunks: number; total_chunks: number; question: string;
};
type ReaderSettings = { model: string; model_options: string[]; web_search_enabled: boolean };
type ReaderLayoutState = { outlineWidth: number; chatWidth: number; outlineVisible: boolean; chatVisible: boolean };
type ReaderSelection = PdfSelection & { pdf_kind: PdfKind };
type AnnotationDraft = { selection: ReaderSelection; comment: string };
type AiAnnotationDraft = {
  requestId: number; paperId: string; selection: ReaderSelection; question: string; generatedQuestion: string; comment: string; reasoning: string;
  requestedThinking: ReasoningThinking;
  status: 'asking' | 'loading' | 'preview' | 'saving'; failure: string;
};
type ReasoningPreferences = { thinking: ReasoningThinking; effort: ReasoningEffort };
type ActionLocationPreview = { sessionId: string; actionId: string; selection: SelectionContext; manualReselect: boolean };
type LocationSearch = { id: string; sessionId: string; actionId: string; candidates: AgentActionCandidate[]; index: number; matches: SelectionContext[] };
type AgentActionConfirmInput = { selection_context?: SelectionContext; manual_reselect?: true; comment?: string; text?: string; note_id?: string; new_note?: boolean; note_title?: string };
type SelectionAssociationRequest = { selection: ReaderSelection; sessionId: string };
type SelectionContextMenu = { left: number; top: number };
type SentenceTranslation = {
  requestId: number; paperId: string; text: string; translation: string; failure: string;
  status: 'loading' | 'complete' | 'error'; left: number; top: number;
};
type NoteSaveStatus = '未保存' | '保存中…' | '已保存' | '保存失败';

const readerLayoutKey = 'paper-workbench.reader-layout.v1';
const reasoningPreferencesKey = 'paper-workbench.reasoning-preferences.v1';
const defaultReaderLayout: ReaderLayoutState = { outlineWidth: 240, chatWidth: 470, outlineVisible: true, chatVisible: true };
const defaultReasoningPreferences: ReasoningPreferences = { thinking: 'default', effort: 'default' };

function reasoningEffortOptions(model: string) {
  if (/deepseek/i.test(model)) return { options: ['low', 'high', 'max'] as ReasoningEffort[], uncertain: false };
  if (/^o[1-4](?:-|$)/i.test(model)) return { options: ['low', 'medium', 'high'] as ReasoningEffort[], uncertain: false };
  if (/^gpt-5(?:\.|-|$)/i.test(model)) return { options: ['minimal', 'low', 'medium', 'high'] as ReasoningEffort[], uncertain: false };
  return { options: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ReasoningEffort[], uncertain: true };
}

function readReasoningPreferences(): Record<string, ReasoningPreferences> {
  try {
    const saved = JSON.parse(localStorage.getItem(reasoningPreferencesKey) || '{}') as Record<string, Partial<ReasoningPreferences>>;
    return Object.fromEntries(Object.entries(saved).map(([model, value]) => [model, {
      thinking: 'default',
      effort: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort || '') ? value.effort as ReasoningEffort : 'default',
    }]));
  } catch { return {}; }
}

function toSelectionContext(selection: ReaderSelection): SelectionContext {
  return { pdf_kind: selection.pdf_kind, page_no: selection.page_no, rects: selection.rects, selected_text: selection.selected_text };
}

function sortAnnotations(items: PdfAnnotation[]) {
  const position = (annotation: PdfAnnotation) => annotation.rects.reduce((best, rect) =>
    rect.y < best.y || (rect.y === best.y && rect.x < best.x) ? rect : best,
  { x: 1, y: 1 });
  return [...items].sort((left, right) => {
    const leftStart = position(left);
    const rightStart = position(right);
    return left.page_no - right.page_no || leftStart.y - rightStart.y || leftStart.x - rightStart.x
      || left.pdf_kind.localeCompare(right.pdf_kind) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
  });
}

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

export function Reader({ paperId, active, libraryNavigation, openRequest }: { paperId: string; active: boolean; libraryNavigation: ReactNode; openRequest?: { kind: PdfKind; sequence: number } }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [rightPanel, setRightPanel] = useState<'chat' | 'notes'>('chat');
  const [noteText, setNoteText] = useState('');
  const [paperNotes, setPaperNotes] = useState<PaperNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState('');
  const activeNoteIdRef = useRef('');
  const noteServerTextRef = useRef(new Map<string, string>());
  const [noteSwitchPending, setNoteSwitchPending] = useState(false);
  const noteSwitchPendingRef = useRef(false);
  const [noteSaveStatus, setNoteSaveStatusState] = useState<NoteSaveStatus>('未保存');
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [notesFailure, setNotesFailure] = useState('');
  const [noteConflict, setNoteConflict] = useState(false);
  const noteRecoveryReadyRef = useRef(false);
  const [noteActionPending, setNoteActionPending] = useState(false);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [mappedAnnotations, setMappedAnnotations] = useState<Record<string, { context: SelectionContext; kind: 'exact' | 'paragraph' }>>({});
  const [mappingRequestsByPage, setMappingRequestsByPage] = useState<Record<number, PdfTextMappingRequest[]>>({});
  const annotationMappingEpochRef = useRef(0);
  const [manualAnnotationLinkId, setManualAnnotationLinkId] = useState<string | null>(null);
  const [manualAnnotationLinkSelection, setManualAnnotationLinkSelection] = useState<SelectionContext | null>(null);
  const [manualAnnotationLinkSaving, setManualAnnotationLinkSaving] = useState(false);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [selectionContextMenu, setSelectionContextMenu] = useState<SelectionContextMenu | null>(null);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [highlightPaletteOpen, setHighlightPaletteOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [aiAnnotationDraft, setAiAnnotationDraft] = useState<AiAnnotationDraft | null>(null);
  const [sentenceTranslation, setSentenceTranslation] = useState<SentenceTranslation | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [annotationEditText, setAnnotationEditText] = useState('');
  const [annotationFailure, setAnnotationFailure] = useState('');
  const [settings, setSettings] = useState<ReaderSettings | null>(null);
  const [currentModel, setCurrentModel] = useState('');
  const [modelFailure, setModelFailure] = useState('');
  const [reasoningPreferencesByModel, setReasoningPreferencesByModel] = useState<Record<string, ReasoningPreferences>>(readReasoningPreferences);
  const [selectionToAssociate, setSelectionToAssociate] = useState<SelectionAssociationRequest | null>(null);
  const [locationSearch, setLocationSearch] = useState<LocationSearch | null>(null);
  const [locationChoices, setLocationChoices] = useState<{ sessionId: string; actionId: string; matches: SelectionContext[] } | null>(null);
  const [actionLocationPreview, setActionLocationPreview] = useState<ActionLocationPreview | null>(null);
  const [actionLocationMessage, setActionLocationMessage] = useState<{ actionId: string; message: string } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [mode, setMode] = useState<'bilingual' | 'mono' | 'original'>('bilingual');
  const pdfKind: PdfKind = mode === 'original' ? 'original' : mode === 'mono' ? 'mono' : 'dual';
  const lastOpenRequestRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !paper || !openRequest || lastOpenRequestRef.current === openRequest.sequence) return;
    lastOpenRequestRef.current = openRequest.sequence;
    setMode(paper.source_language === 'zh' || openRequest.kind === 'original' ? 'original' : openRequest.kind === 'mono' ? 'mono' : 'bilingual');
  }, [active, paper?.id, paper?.source_language, openRequest]);
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
  const paperIdRef = useRef(paperId);
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
  const noteActionPendingRef = useRef(false);
  const noteActionPaperRef = useRef<string | null>(null);
  const noteConflictRef = useRef(false);
  const saveNoteOnUnmountRef = useRef<(text: string, revision: number) => void>(() => undefined);
  const flushNoteBeforeUpdateRef = useRef<() => Promise<void>>(async () => undefined);
  const noteSaveTimerRef = useRef<number | null>(null);
  const selectionContextMenuRef = useRef<HTMLDivElement>(null);
  const sentenceTranslationRef = useRef<HTMLDivElement>(null);
  const sentenceTranslationRequestRef = useRef(0);
  const aiAnnotationRequestRef = useRef(0);
  const locationSearchRequestRef = useRef(0);
  const locationSearchRef = useRef<LocationSearch | null>(null);
  const manualRetargetActionRef = useRef<{ sessionId: string; actionId: string; pdfKind: PdfKind } | null>(null);
  const activeChatSessionRef = useRef('');
  const sentenceTranslationDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const pendingAnnotationJumpRef = useRef<{ pdfKind: PdfKind; page: number } | null>(null);
  const previousPdfKindRef = useRef<PdfKind>(pdfKind);
  const loadedPdfKindRef = useRef<PdfKind | null>(null);
  const pdfPageCount = pdfDocument?.pdf.numPages || paper?.page_count || 1;
  useEffect(() => {
    setManualAnnotationLinkId(null);
    setManualAnnotationLinkSelection(null);
  }, [paperId, pdfKind]);
  readerLayoutRef.current = readerLayout;
  if (lastActivePropRef.current !== active) {
    activeEpochRef.current += 1;
    lastActivePropRef.current = active;
  }
  activeRef.current = active;
  paperIdRef.current = paperId;
  const reasoningPreferences = reasoningPreferencesByModel[currentModel] || defaultReasoningPreferences;

  function changeReasoningPreferences(next: Partial<ReasoningPreferences>) {
    if (!currentModel) return;
    setReasoningPreferencesByModel((previous) => {
      const updated = { ...previous, [currentModel]: { ...(previous[currentModel] || defaultReasoningPreferences), ...next } };
      try { localStorage.setItem(reasoningPreferencesKey, JSON.stringify(updated)); } catch { /* model preferences are optional */ }
      return updated;
    });
  }

  function setNoteSaveStatus(status: NoteSaveStatus) {
    noteStatusRef.current = status;
    setNoteSaveStatusState(status);
  }

  async function persistPaperNotes(text: string, revision: number, updateUi = true, force = false) {
    const noteId = activeNoteIdRef.current;
    if (!noteId) return;
    if (force && noteConflictRef.current && !noteRecoveryReadyRef.current) {
      setNotesFailure('请先合并冲突版本，核对内容后再保存。');
      return;
    }
    if ((noteActionPendingRef.current || noteConflictRef.current) && !force) {
      noteSaveTimerRef.current = null;
      return;
    }
    if (noteSaveTimerRef.current !== null) window.clearTimeout(noteSaveTimerRef.current);
    noteSaveTimerRef.current = null;
    if (updateUi) setNoteSaveStatus('保存中…');
    const request = noteSaveQueueRef.current.catch(() => undefined).then(() => {
      if ((noteActionPendingRef.current || noteConflictRef.current) && !force) throw new Error('笔记追加期间产生了较新的草稿；已暂停自动保存。');
      return api<PaperNote>(`/papers/${paperId}/notes/${noteId}`, 'PUT', { text, expected_text: noteServerTextRef.current.get(noteId) ?? '' }).then((saved) => {
        noteServerTextRef.current.set(noteId, saved.text);
        return saved;
      });
    });
    noteSaveQueueRef.current = request.then(() => undefined, () => undefined);
    try {
      const saved = await request;
      if (paperIdRef.current !== paperId || activeNoteIdRef.current !== noteId) return;
      setPaperNotes((previous) => previous.map((note) => note.id === noteId ? saved : note));
      noteSavedRevisionRef.current = Math.max(noteSavedRevisionRef.current, revision);
      if (!updateUi) return;
      if (noteRevisionRef.current !== revision || noteDraftRef.current !== text) {
        setNoteSaveStatus('未保存');
        return;
      }
      try {
        const key = `paper-workbench.note-draft.${paperId}.${noteId}`;
        if (localStorage.getItem(key) === text) localStorage.removeItem(key);
      } catch {
        setNoteSaveStatus('保存失败');
        setNotesFailure('本地草稿无法清理；笔记已保存到本机数据库。');
        return;
      }
      setNoteSaveStatus('已保存');
      setNotesFailure('');
      noteConflictRef.current = false;
      setNoteConflict(false);
      noteRecoveryReadyRef.current = false;
    } catch (error) {
      if (paperIdRef.current === paperId && activeNoteIdRef.current === noteId && errorMessage(error).includes('笔记已在其他位置更新')) {
        noteConflictRef.current = true;
        setNoteConflict(true);
        noteRecoveryReadyRef.current = false;
      }
      if (updateUi && noteRevisionRef.current === revision) {
        setNoteSaveStatus('保存失败');
        setNotesFailure(errorMessage(error));
      }
    }
  }

  async function resolveNoteConflict() {
    const noteId = activeNoteIdRef.current;
    if (!noteId || noteSwitchPendingRef.current || noteActionPendingRef.current) return;
    noteSwitchPendingRef.current = true;
    setNoteSwitchPending(true);
    try {
      await noteSaveQueueRef.current;
      const latest = await api<PaperNotes>(`/papers/${paperId}/notes`);
      if (paperIdRef.current !== paperId || activeNoteIdRef.current !== noteId) return;
      const remote = latest.notes.find((note) => note.id === noteId);
      if (!remote) throw new Error('目标笔记已删除；本地草稿仍保留，请复制草稿后重新打开阅读器。');
      const local = noteDraftRef.current;
      noteServerTextRef.current.set(noteId, remote.text);
      setPaperNotes(latest.notes);
      const merged = remote.text === local ? local : `## 服务端版本\n\n${remote.text}\n\n---\n\n## 本地草稿\n\n${local}`;
      changeNoteText(merged);
      noteConflictRef.current = true;
      setNoteConflict(false);
      noteRecoveryReadyRef.current = true;
      setNotesFailure('两个版本已保留在草稿中，自动保存已暂停。请编辑核对后点击保存。');
    } catch (error) {
      setNotesFailure(errorMessage(error));
    } finally {
      noteSwitchPendingRef.current = false;
      setNoteSwitchPending(false);
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
      localStorage.setItem(`paper-workbench.note-draft.${paperId}.${activeNoteIdRef.current}`, text);
      setNoteSaveStatus('未保存');
      setNotesFailure('');
    } catch {
      setNoteSaveStatus('保存失败');
      setNotesFailure('本地草稿暂时无法保存；关闭阅读标签前请先保存笔记。');
    }
  }

  function loadNoteDraft(note: PaperNote) {
    let draft: string | null = null;
    try { draft = localStorage.getItem(`paper-workbench.note-draft.${paperId}.${note.id}`); }
    catch { setNotesFailure('本地草稿存储不可用，请及时保存笔记。'); }
    activeNoteIdRef.current = note.id;
    setActiveNoteId(note.id);
    noteDraftRef.current = draft ?? note.text;
    noteRevisionRef.current = draft !== null && draft !== note.text ? 1 : 0;
    noteSavedRevisionRef.current = 0;
    noteConflictRef.current = false;
    setNoteConflict(false);
    noteRecoveryReadyRef.current = false;
    noteServerTextRef.current.set(note.id, note.text);
    setNoteText(noteDraftRef.current);
    setNoteSaveStatus(noteRevisionRef.current ? '未保存' : '已保存');
  }

  async function switchNote(noteId: string) {
    if (noteSwitchPendingRef.current || noteActionPendingRef.current || noteId === activeNoteIdRef.current) return;
    noteSwitchPendingRef.current = true;
    setNoteSwitchPending(true);
    try {
      await flushNoteBeforeUpdateRef.current();
      const note = paperNotes.find((item) => item.id === noteId);
      if (!note) throw new Error('找不到这篇笔记。');
      await api(`/papers/${paperId}/notes/active`, 'PATCH', { note_id: noteId });
      loadNoteDraft(note);
      setNotesFailure('');
    } catch (error) { setNotesFailure(errorMessage(error)); }
    finally { noteSwitchPendingRef.current = false; setNoteSwitchPending(false); }
  }

  async function createNote(title?: string) {
    if (noteSwitchPendingRef.current || noteActionPendingRef.current) return;
    noteSwitchPendingRef.current = true;
    setNoteSwitchPending(true);
    try {
      await flushNoteBeforeUpdateRef.current();
      const note = await api<PaperNote>(`/papers/${paperId}/notes`, 'POST', { title });
      await api(`/papers/${paperId}/notes/active`, 'PATCH', { note_id: note.id });
      setPaperNotes((previous) => [...previous, note]);
      loadNoteDraft(note);
      setNotesFailure('');
    } catch (error) { setNotesFailure(errorMessage(error)); }
    finally { noteSwitchPendingRef.current = false; setNoteSwitchPending(false); }
  }

  async function renameNote(noteId: string, title: string) {
    try {
      const updated = await api<PaperNote>(`/papers/${paperId}/notes/${noteId}`, 'PATCH', { title });
      setPaperNotes((previous) => previous.map((note) => note.id === noteId ? { ...note, title: updated.title } : note));
    } catch (error) { setNotesFailure(errorMessage(error)); }
  }

  async function deleteNote(noteId: string) {
    if (noteSwitchPendingRef.current || noteActionPendingRef.current) return;
    noteSwitchPendingRef.current = true;
    setNoteSwitchPending(true);
    try {
      await flushNoteBeforeUpdateRef.current();
      await api(`/papers/${paperId}/notes/${noteId}`, 'DELETE');
      const saved = await api<PaperNotes>(`/papers/${paperId}/notes`);
      setPaperNotes(saved.notes);
      localStorage.removeItem(`paper-workbench.note-draft.${paperId}.${noteId}`);
      noteServerTextRef.current.delete(noteId);
      const selected = saved.notes.find((note) => note.id === saved.active_note_id) || saved.notes[0];
      if (selected) loadNoteDraft(selected);
      setNotesFailure('');
    } catch (error) { setNotesFailure(errorMessage(error)); }
    finally { noteSwitchPendingRef.current = false; setNoteSwitchPending(false); }
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
      if (isAtPdfScrollEnd() && paper) updatePageFromScroll(pdfPageCount);
    }, 320);
  }

  function isAtPdfScrollEnd() {
    if (!activeRef.current || !paper || !pdfDocument || pageAspects.length < pdfPageCount || !pdfScrollElement) return false;
    const lastFrame = pdfScrollElement.querySelector<HTMLElement>(`.pdf-page-frame[data-page-number="${pdfPageCount}"]`);
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
    const epoch = ++annotationMappingEpochRef.current;
    setMappedAnnotations({});
    setMappingRequestsByPage({});
    if (!pdfDocument || loadedPdfKindRef.current !== pdfKind) return;
    const candidates = annotations.flatMap((annotation) => annotationMappingCandidates(annotation, segments)).filter((candidate) => candidate.targetKind === pdfKind);
    if (!candidates.length) return;
    void (async () => {
      const texts: string[] = [];
      for (let page = 1; page <= pdfDocument.pdf.numPages; page++) {
        const content = await (await pdfDocument.pdf.getPage(page)).getTextContent();
        if (epoch !== annotationMappingEpochRef.current) return;
        texts.push(normalizePdfText(content.items.map((item) => 'str' in item ? item.str : '').join(' ')).replace(/\s/g, ''));
      }
      const requests: Record<number, PdfTextMappingRequest[]> = {};
      for (const candidate of candidates) {
        const quote = candidate.kind === 'paragraph' ? candidate.quote.trim().slice(0, 220).trimEnd() : candidate.quote;
        const needle = normalizePdfText(quote).replace(/\s/g, '');
        if (!needle) continue;
        const pages: number[] = [];
        texts.forEach((text, index) => {
          let offset = text.indexOf(needle);
          while (offset >= 0) {
            pages.push(index + 1);
            offset = text.indexOf(needle, offset + needle.length);
          }
        });
        if (pages.length !== 1) continue;
        (requests[pages[0]] ||= []).push({ annotationId: candidate.annotationId, quote, kind: candidate.kind });
      }
      if (epoch === annotationMappingEpochRef.current) setMappingRequestsByPage(requests);
    })().catch(() => { /* original annotations remain available if this PDF cannot be mapped */ });
    return () => { annotationMappingEpochRef.current += 1; };
  }, [pdfDocument, pdfKind, annotations, segments]);

  const receiveAnnotationMappings = useCallback((page: number, results: PdfTextMappingResult[]) => {
    if (loadedPdfKindRef.current !== pdfKind) return;
    setMappedAnnotations((previous) => {
      const next = { ...previous };
      for (const result of results) {
        if (result.matches.length !== 1) continue;
        if (next[result.annotationId]?.kind === 'exact' && result.kind !== 'exact') continue;
        const match = result.matches[0];
        next[result.annotationId] = { context: { pdf_kind: pdfKind, page_no: page, rects: match.rects, selected_text: match.selected_text }, kind: result.kind };
      }
      return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
    });
  }, [pdfKind]);

  function annotationsForPage(page: number) {
    return annotations.flatMap((annotation) => {
      if (annotation.pdf_kind === pdfKind) return annotation.page_no === page ? [annotation] : [];
      const verified = annotation.view_contexts?.[pdfKind];
      const mapped = mappedAnnotations[annotation.id];
      const context = verified || (mapped?.kind === 'exact' ? mapped.context : null);
      return context?.page_no === page ? [{ ...annotation, ...context, pdf_kind: pdfKind }] : [];
    });
  }

  function openAnnotationComment(id: string) {
    setSelectedAnnotation(id);
    setRightPanel('notes');
    window.requestAnimationFrame(() => document.querySelector(`[data-testid="reader-annotation-${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  useEffect(() => {
    let canceled = false;
    setSelectionToAssociate(null);
    aiAnnotationRequestRef.current += 1;
    setAiAnnotationDraft(null);
    locationSearchRequestRef.current += 1;
    locationSearchRef.current = null;
    setLocationSearch(null);
    setLocationChoices(null);
    setActionLocationPreview(null);
    manualRetargetActionRef.current = null;
    noteActionPendingRef.current = false;
    noteActionPaperRef.current = null;
    noteConflictRef.current = false;
    setNoteConflict(false);
    noteRecoveryReadyRef.current = false;
    setSelection(null);
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    setAnnotationDraft(null);
    sentenceTranslationRequestRef.current += 1;
    setSentenceTranslation(null);
    window.getSelection()?.removeAllRanges();
    noteLoadedRef.current = false;
    setNotesLoaded(false);
    setNotesFailure('');
    let localDraft: string | null = null;
    let storageFailure = false;
    try { localDraft = localStorage.getItem(`paper-workbench.note-draft.${paperId}`); }
    catch { storageFailure = true; }
    activeNoteIdRef.current = '';
    setActiveNoteId('');
    setPaperNotes([]);
    void api<PaperNotes>(`/papers/${paperId}/notes`).then((saved) => {
      if (canceled) return;
      setPaperNotes(saved.notes);
      saved.notes.forEach((note) => noteServerTextRef.current.set(note.id, note.text));
      const selected = localDraft !== null ? saved.notes[0] : saved.notes.find((note) => note.id === saved.active_note_id) || saved.notes[0];
      if (!selected) throw new Error('没有可用的阅读笔记。');
      if (localDraft !== null) {
        localStorage.setItem(`paper-workbench.note-draft.${paperId}.${selected.id}`, localDraft);
        localStorage.removeItem(`paper-workbench.note-draft.${paperId}`);
      }
      loadNoteDraft(selected);
      noteLoadedRef.current = true;
      setNotesLoaded(true);
      if (storageFailure) {
        setNoteSaveStatus('保存失败');
        setNotesFailure('本地草稿存储不可用；请使用保存按钮保存到本机数据库。');
      }
    }).catch((error) => {
      if (canceled) return;
      noteLoadedRef.current = false;
      setNotesLoaded(false);
      setNoteSaveStatus('保存失败');
      setNotesFailure(errorMessage(error));
    });
    void api<PdfAnnotation[]>(`/papers/${paperId}/annotations`).then((items) => {
      if (!canceled) setAnnotations(sortAnnotations(items));
    }).catch((error) => {
      if (!canceled) setAnnotationFailure(errorMessage(error));
    });
    return () => { canceled = true; };
  }, [paperId]);

  useEffect(() => {
    if (!selectionContextMenu && !sentenceTranslation) return;
    const closeMenuOutside = (event: PointerEvent) => {
      if (selectionContextMenu && !selectionContextMenuRef.current?.contains(event.target as Node)) setSelectionContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelectionContextMenu(null);
      if (sentenceTranslation) {
        sentenceTranslationRequestRef.current += 1;
        sentenceTranslationDragRef.current = null;
        setSentenceTranslation(null);
      }
    };
    document.addEventListener('pointerdown', closeMenuOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenuOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [selectionContextMenu, sentenceTranslation?.requestId]);

  useLayoutEffect(() => {
    if (!selectionContextMenu) return;
    const reposition = () => {
      const menu = selectionContextMenuRef.current;
      if (!menu) return;
      const bounds = menu.getBoundingClientRect();
      const left = bounded(selectionContextMenu.left, 8, window.innerWidth - bounds.width - 8);
      const top = bounded(selectionContextMenu.top, 8, window.innerHeight - bounds.height - 8);
      if (left !== selectionContextMenu.left || top !== selectionContextMenu.top) {
        setSelectionContextMenu((current) => current === selectionContextMenu ? { left, top } : current);
      }
    };
    reposition();
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [selectionContextMenu, highlightPaletteOpen]);

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
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    setAnnotationDraft(null);
  }, [pdfKind]);

  useEffect(() => {
    const search = locationSearch;
    if (!search) return;
    const candidate = search.candidates[search.index];
    if (candidate) goToPdfLocation(candidate.pdf_kind || 'original', candidate.page_no);
  }, [locationSearch?.id, locationSearch?.index, pdfKind, pdfDocument]);

  useEffect(() => {
    if (active) return;
    setManualAnnotationLinkId(null);
    setManualAnnotationLinkSelection(null);
    aiAnnotationRequestRef.current += 1;
    setAiAnnotationDraft(null);
    locationSearchRequestRef.current += 1;
    locationSearchRef.current = null;
    setLocationSearch(null);
    setLocationChoices(null);
    setActionLocationPreview(null);
    manualRetargetActionRef.current = null;
    setSelection(null);
    setSelectionContextMenu(null);
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
      setSelectionContextMenu(null);
      const translationWindow = sentenceTranslationRef.current;
      if (translationWindow) {
        const bounds = translationWindow.getBoundingClientRect();
        const left = bounded(bounds.left, 8, window.innerWidth - bounds.width - 8);
        const top = bounded(bounds.top, 8, window.innerHeight - bounds.height - 8);
        setSentenceTranslation((current) => current ? { ...current, left, top } : current);
      }
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
        const aspects = await pageAspectRatios(loaded, loaded.pdf.numPages);
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
    const targetPage = Math.min(Math.max(target.page, 1), pdfDocument.pdf.numPages);
    visiblePageRef.current = targetPage;
    setPageNumber(targetPage);
    scrollPageIntoView(targetPage, 'auto');
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
    const next = Math.min(Math.max(target, 1), pdfPageCount);
    visiblePageRef.current = next;
    setPageNumber(next);
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
    void api(`/papers/${paperId}/progress`, 'PATCH', { page: next }).catch(() => undefined);
    window.requestAnimationFrame(() => scrollPageIntoView(next));
  }

  function updatePageFromScroll(next: number) {
    if (!activeRef.current || initialPageScrollPendingRef.current || !paper || next < 1 || next > pdfPageCount) return;
    const page = isAtPdfScrollEnd() ? pdfPageCount : next;
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
    const restoredPage = Math.min(Math.max(pageNumber, 1), pdfDocument.pdf.numPages);
    if (restoredPage !== pageNumber) setPageNumber(restoredPage);
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
    goToPdfLocation('original', source.start_page);
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

  async function persistAnnotation(target: ReaderSelection, kind: 'highlight' | 'comment' | 'underline', color: PdfAnnotation['color'], comment = '') {
    const created = await api<PdfAnnotation>(`/papers/${paperId}/annotations`, 'POST', {
      pdf_kind: target.pdf_kind,
      page_no: target.page_no,
      rects: target.rects,
      selected_text: target.selected_text,
      comment,
      color,
      kind,
    });
    setAnnotations((previous) => sortAnnotations([...previous, created]));
    setRightPanel('notes');
    setAnnotationFailure('');
    return created;
  }

  function clearPdfSelection() {
    aiAnnotationRequestRef.current += 1;
    setAiAnnotationDraft(null);
    setSelection(null);
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    window.getSelection()?.removeAllRanges();
  }

  function capturePdfSelection(value: PdfSelection | null, notice?: string, contextMenuPoint?: { left: number; top: number }) {
    if (!activeRef.current) return;
    if (!value) {
      setSelection(null);
      setSelectionContextMenu(null);
      setHighlightPaletteOpen(false);
      if (notice) setSelectionNotice(notice);
      return;
    }
    if (manualAnnotationLinkId) {
      setManualAnnotationLinkSelection(toSelectionContext({ ...value, pdf_kind: pdfKind }));
      setSelection(null);
      setSelectionContextMenu(null);
      setSelectionNotice('已选择关联位置，请确认保存。');
      window.getSelection()?.removeAllRanges();
      return;
    }
    const manualRetarget = manualRetargetActionRef.current;
    if (manualRetarget) {
      manualRetargetActionRef.current = null;
      if (activeChatSessionRef.current === manualRetarget.sessionId) {
        setActionLocationPreview({
          sessionId: manualRetarget.sessionId,
          actionId: manualRetarget.actionId,
          selection: toSelectionContext({ ...value, pdf_kind: pdfKind }),
          manualReselect: true,
        });
        setLocationChoices(null);
        setActionLocationMessage(null);
      }
      setSelection(null);
      setSelectionContextMenu(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (aiAnnotationDraft) {
      aiAnnotationRequestRef.current += 1;
      setAiAnnotationDraft(null);
    }
    if (locationSearchRef.current) {
      locationSearchRef.current = null;
      setLocationSearch(null);
      setActionLocationMessage(null);
    }
    setSelection({ ...value, pdf_kind: pdfKind });
    setSelectionContextMenu(contextMenuPoint ? {
      left: bounded(contextMenuPoint.left, 8, window.innerWidth - 8),
      top: bounded(contextMenuPoint.top, 8, window.innerHeight - 8),
    } : null);
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

  async function addUnderline() {
    if (!selection) return;
    try {
      await persistAnnotation(selection, 'underline', 'yellow');
      clearPdfSelection();
    } catch (error) {
      setAnnotationFailure(errorMessage(error));
    }
  }

  function beginAnnotationDraft() {
    if (!selection) return;
    setAnnotationDraft({ selection, comment: '' });
    setSelection(null);
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    setAnnotationFailure('');
  }

  function goToPdfLocation(targetKind: PdfKind, targetPage: number) {
    const nextMode = targetKind === 'dual' ? 'bilingual' : targetKind;
    if (targetKind !== pdfKind) {
      pendingAnnotationJumpRef.current = { pdfKind: targetKind, page: targetPage };
      initialPageScrollPendingRef.current = true;
      setMode(nextMode);
      return;
    }
    pendingAnnotationJumpRef.current = { pdfKind: targetKind, page: targetPage };
    if (pdfDocument && loadedPdfKindRef.current === targetKind) {
      pendingAnnotationJumpRef.current = null;
      goToPage(targetPage);
    }
  }

  function startActionLocation(sessionId: string, action: AgentAction) {
    if (action.status !== 'pending' || action.kind !== 'annotation') return;
    const linked = action.payload.selection_context;
    if (linked) {
      setLocationSearch(null);
      locationSearchRef.current = null;
      setLocationChoices(null);
      setActionLocationPreview({ sessionId, actionId: action.id, selection: linked, manualReselect: false });
      setActionLocationMessage(null);
      goToPdfLocation(linked.pdf_kind, linked.page_no);
      return;
    }
    const fallbackKind = action.payload.pdf_kind || 'original';
    const candidates = (action.payload.candidates?.length ? action.payload.candidates : action.payload.quote && action.payload.page_no ? [{
      page_no: action.payload.page_no, quote: action.payload.quote, pdf_kind: fallbackKind,
    }] : []).filter((candidate) => candidate.page_no > 0 && candidate.quote.trim());
    const unique = candidates.filter((candidate, index) => candidates.findIndex((other) =>
      other.page_no === candidate.page_no && other.pdf_kind === candidate.pdf_kind && other.quote === candidate.quote) === index);
    if (!unique.length) {
      setActionLocationMessage({ actionId: action.id, message: '没有可自动定位的页码和引文；可以在原文 PDF 中手动选择。' });
      setLocationChoices(null);
      setActionLocationPreview(null);
      return;
    }
    const search: LocationSearch = {
      id: String(++locationSearchRequestRef.current), sessionId, actionId: action.id,
      candidates: unique.map((candidate) => ({ ...candidate, pdf_kind: candidate.pdf_kind || fallbackKind })), index: 0, matches: [],
    };
    locationSearchRef.current = search;
    setLocationSearch(search);
    setLocationChoices(null);
    setActionLocationPreview(null);
    setActionLocationMessage({ actionId: action.id, message: '正在 PDF 文本层中定位…' });
    goToPdfLocation(search.candidates[0].pdf_kind || 'original', search.candidates[0].page_no);
  }

  function receivePdfMatches(id: string, page: number, matches: PdfSelection[]) {
    const current = locationSearchRef.current;
    if (!current || `${current.id}:${current.index}` !== id) return;
    const candidate = current.candidates[current.index];
    if (!candidate || candidate.page_no !== page) return;
    const found = matches.map((match) => toSelectionContext({ ...match, pdf_kind: candidate.pdf_kind || 'original' }));
    const allMatches = [...current.matches, ...found];
    if (current.index + 1 < current.candidates.length) {
      const next = { ...current, index: current.index + 1, matches: allMatches };
      locationSearchRef.current = next;
      setLocationSearch(next);
      goToPdfLocation(next.candidates[next.index].pdf_kind || 'original', next.candidates[next.index].page_no);
      return;
    }
    locationSearchRef.current = null;
    setLocationSearch(null);
    if (!allMatches.length) {
      setLocationChoices(null);
      setActionLocationPreview(null);
      setActionLocationMessage({ actionId: current.actionId, message: '在候选页的 PDF 文本层中没有找到这段引文；批注草稿仍保留，可手动重新选择。' });
      return;
    }
    setLocationChoices({ sessionId: current.sessionId, actionId: current.actionId, matches: allMatches });
    setActionLocationMessage(null);
    if (allMatches.length === 1) {
      const selection = allMatches[0];
      setActionLocationPreview({ sessionId: current.sessionId, actionId: current.actionId, selection, manualReselect: false });
      goToPdfLocation(selection.pdf_kind, selection.page_no);
    }
  }

  function chooseActionLocation(sessionId: string, actionId: string, target: SelectionContext) {
    if (activeChatSessionRef.current && activeChatSessionRef.current !== sessionId) return;
    setActionLocationPreview({ sessionId, actionId, selection: target, manualReselect: false });
    setActionLocationMessage(null);
    goToPdfLocation(target.pdf_kind, target.page_no);
  }

  function beginManualActionReselect(sessionId: string, action: AgentAction) {
    if (action.status !== 'pending' || action.kind !== 'annotation') return;
    const kind = action.payload.selection_context?.pdf_kind || action.payload.pdf_kind || 'original';
    const page = action.payload.selection_context?.page_no || action.payload.page_no || action.payload.candidates?.[0]?.page_no || pageNumber;
    locationSearchRequestRef.current += 1;
    locationSearchRef.current = null;
    manualRetargetActionRef.current = { sessionId, actionId: action.id, pdfKind: kind };
    setLocationSearch(null);
    setLocationChoices(null);
    setActionLocationPreview(null);
    setActionLocationMessage({ actionId: action.id, message: '请在 PDF 中拖选实际文字；选中后会先显示位置预览。' });
    goToPdfLocation(kind, page);
  }

  function changeActiveChatSession(sessionId: string) {
    if (activeChatSessionRef.current && activeChatSessionRef.current !== sessionId) {
      locationSearchRequestRef.current += 1;
      locationSearchRef.current = null;
      manualRetargetActionRef.current = null;
      setLocationSearch(null);
      setLocationChoices(null);
      setActionLocationPreview(null);
      setActionLocationMessage(null);
    }
    activeChatSessionRef.current = sessionId;
  }

  async function confirmAgentAction(sessionId: string, action: AgentAction, input: AgentActionConfirmInput) {
    const targetPaperId = paperId;
    let noteSnapshot: { noteId: string; text: string; revision: number } | null = null;
    if (action.kind === 'note') {
      if (noteSwitchPendingRef.current || noteActionPendingRef.current) throw new Error('笔记正在更新，请完成后再确认。');
      if (paperIdRef.current !== targetPaperId) throw new Error('文献已切换，请在当前文献中重新确认。');
      if (!notesLoaded) throw new Error('笔记仍在载入，请稍后再确认。');
      try { await flushNoteBeforeUpdateRef.current(); }
      catch (error) {
        const detail = notesFailure || errorMessage(error).replace('，更新安装已取消。', '');
        throw new Error(`${detail ? `${detail}；` : ''}现有笔记未保存，请先保存后再确认追加。`);
      }
      if (paperIdRef.current !== targetPaperId) throw new Error('文献已切换，请在当前文献中重新确认。');
      if (noteSwitchPendingRef.current || noteActionPendingRef.current) throw new Error('笔记正在更新，请完成后再确认。');
      if (!input.new_note) {
        const noteId = input.note_id || action.payload.note_id || activeNoteIdRef.current;
        const note = paperNotes.find((item) => item.id === noteId);
        if (!note) throw new Error('目标笔记不存在，请重新选择保存位置。');
        noteSnapshot = { noteId, text: noteId === activeNoteIdRef.current ? noteDraftRef.current : noteServerTextRef.current.get(noteId) ?? note.text, revision: noteRevisionRef.current };
      }
      noteActionPendingRef.current = true;
      noteActionPaperRef.current = targetPaperId;
      setNoteActionPending(true);
    }
    try {
      const result = await api<AgentAction>(`/papers/${targetPaperId}/agent-actions/${action.id}/confirm`, 'POST', {
        ...input,
        ...(noteSnapshot ? { expected_note_text: noteSnapshot.text } : {}),
      });
      if (paperIdRef.current !== targetPaperId) return result;
      const payload = result.result as { annotation?: PdfAnnotation; notes?: PaperNote } | undefined;
      if (payload?.annotation) {
        setAnnotations((previous) => sortAnnotations([...previous.filter((item) => item.id !== payload.annotation?.id), payload.annotation as PdfAnnotation]));
        setAnnotationFailure('');
      }
      if (payload?.notes) {
        const savedNote = payload.notes;
        noteServerTextRef.current.set(savedNote.id, savedNote.text);
        setPaperNotes((previous) => previous.some((note) => note.id === savedNote.id) ? previous.map((note) => note.id === savedNote.id ? savedNote : note) : [...previous, savedNote]);
        if (input.new_note) {
          loadNoteDraft(savedNote);
          setRightPanel('notes');
        } else if (noteSnapshot && savedNote.id === activeNoteIdRef.current && noteSnapshot.noteId === activeNoteIdRef.current) {
        if (noteRevisionRef.current === noteSnapshot.revision && noteDraftRef.current === noteSnapshot.text) {
          if (noteSaveTimerRef.current !== null) window.clearTimeout(noteSaveTimerRef.current);
          noteSaveTimerRef.current = null;
          noteDraftRef.current = payload.notes.text;
          noteRevisionRef.current += 1;
          noteSavedRevisionRef.current = noteRevisionRef.current;
          setNoteText(payload.notes.text);
          setNoteSaveStatus('已保存');
          setNotesFailure('');
          try { localStorage.removeItem(`paper-workbench.note-draft.${paperId}.${savedNote.id}`); }
          catch { setNoteSaveStatus('保存失败'); setNotesFailure('建议笔记已保存到数据库，但本地草稿状态无法同步。'); }
        } else {
          noteConflictRef.current = true;
          setNoteConflict(true);
          noteRecoveryReadyRef.current = false;
          setNoteSaveStatus('未保存');
          setNotesFailure('建议笔记已保存，但期间出现了较新的本地草稿。草稿已保留；请先合并冲突版本，核对后保存。');
        }
        }
      }
      setActionLocationPreview((current) => current?.sessionId === sessionId && current.actionId === action.id ? null : current);
      setLocationChoices((current) => current?.sessionId === sessionId && current.actionId === action.id ? null : current);
      setActionLocationMessage(null);
      return result;
    } catch (error) {
      const serverConflict = errorMessage(error).includes('笔记已在其他位置更新');
      if (paperIdRef.current === targetPaperId && noteSnapshot && serverConflict && noteSnapshot.noteId !== activeNoteIdRef.current) {
        const latest = await api<PaperNotes>(`/papers/${targetPaperId}/notes`).catch(() => null);
        if (latest && paperIdRef.current === targetPaperId) {
          setPaperNotes(latest.notes);
          for (const note of latest.notes) {
            if (note.id !== activeNoteIdRef.current) noteServerTextRef.current.set(note.id, note.text);
          }
        }
      }
      if (paperIdRef.current === targetPaperId && noteSnapshot?.noteId === activeNoteIdRef.current && (serverConflict || noteRevisionRef.current !== noteSnapshot.revision || noteDraftRef.current !== noteSnapshot.text)) {
        noteConflictRef.current = true;
        setNoteConflict(true);
        noteRecoveryReadyRef.current = false;
        setNoteSaveStatus('未保存');
        setNotesFailure('笔记在确认期间被修改；较新的本地草稿已保留。请先合并冲突版本，核对后保存，再重试建议。');
      }
      throw error;
    } finally {
      if (action.kind === 'note' && noteActionPaperRef.current === targetPaperId) {
        noteActionPendingRef.current = false;
        noteActionPaperRef.current = null;
        setNoteActionPending(false);
      }
    }
  }

  function beginAiAnnotationQuestion() {
    if (!selection) return;
    aiAnnotationRequestRef.current += 1;
    setAiAnnotationDraft({
      requestId: aiAnnotationRequestRef.current, paperId, selection, question: '', generatedQuestion: '', comment: '', reasoning: '', requestedThinking: 'default',
      status: 'asking', failure: '',
    });
    setSelection(null);
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    window.getSelection()?.removeAllRanges();
  }

  function associateSelectionWithChat() {
    if (!selection) return;
    setSelectionToAssociate({ selection, sessionId: activeChatSessionRef.current });
    setSelection(null);
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    setRightPanel('chat');
    window.getSelection()?.removeAllRanges();
  }

  function cancelAiAnnotation() {
    aiAnnotationRequestRef.current += 1;
    setAiAnnotationDraft(null);
  }

  async function generateAiAnnotation() {
    const draft = aiAnnotationDraft;
    if (!draft || draft.paperId !== paperId || !draft.question.trim()) {
      setAiAnnotationDraft((current) => current ? { ...current, failure: '请先填写希望 AI 回答的问题。' } : current);
      return;
    }
    const requestId = ++aiAnnotationRequestRef.current;
    const question = draft.question.trim();
    const prefs = reasoningPreferencesByModel[currentModel] || defaultReasoningPreferences;
    const model = currentModel;
    setAiAnnotationDraft({ ...draft, requestId, question, requestedThinking: prefs.thinking, status: 'loading', failure: '' });
    try {
      const result = await api<{ comment: string; reasoning?: string }>(`/papers/${paperId}/ai-annotation`, 'POST', {
        selection_context: toSelectionContext(draft.selection), question,
        ...(model ? { model } : {}),
        ...(prefs.thinking === 'default' ? {} : { thinking: prefs.thinking }),
        ...(prefs.effort === 'default' ? {} : { reasoning_effort: prefs.effort }),
      });
      if (aiAnnotationRequestRef.current !== requestId || draft.paperId !== paperId) return;
      setAiAnnotationDraft((current) => current?.requestId === requestId && current.paperId === paperId
        ? { ...current, generatedQuestion: question, comment: result.comment || '', reasoning: result.reasoning || '', status: 'preview', failure: '' }
        : current);
    } catch (error) {
      if (aiAnnotationRequestRef.current !== requestId || draft.paperId !== paperId) return;
      setAiAnnotationDraft((current) => current?.requestId === requestId
        ? { ...current, status: 'asking', failure: errorMessage(error) }
        : current);
    }
  }

  async function saveAiAnnotation() {
    const draft = aiAnnotationDraft;
    if (!draft || draft.paperId !== paperId || !draft.comment.trim() || draft.question.trim() !== draft.generatedQuestion) {
      setAiAnnotationDraft((current) => current ? { ...current, failure: current.question.trim() !== current.generatedQuestion
        ? '问题已更改，请重新生成解释后保存。' : '请填写批注内容。' } : current);
      return;
    }
    setAiAnnotationDraft((current) => current?.requestId === draft.requestId ? { ...current, status: 'saving', failure: '' } : current);
    try {
      await persistAnnotation(draft.selection, 'comment', 'yellow', `问题：${draft.question.trim()}\n\n批注：${draft.comment.trim()}`);
      if (aiAnnotationRequestRef.current === draft.requestId) {
        aiAnnotationRequestRef.current += 1;
        setAiAnnotationDraft(null);
      }
    } catch (error) {
      setAiAnnotationDraft((current) => current?.requestId === draft.requestId ? { ...current, status: 'preview', failure: errorMessage(error) } : current);
    }
  }

  async function translateSelectedSentence() {
    if (!selection) return;
    const target = selection;
    const targetPaperId = paperId;
    const requestId = ++sentenceTranslationRequestRef.current;
    const width = 328;
    const height = 320;
    let top = target.anchor.bottom + 12;
    if (top + height > window.innerHeight - 8) top = target.anchor.top - height - 12;
    setSentenceTranslation({
      requestId, paperId: targetPaperId, text: target.selected_text, translation: '', failure: '', status: 'loading',
      left: bounded(target.anchor.left, 8, window.innerWidth - width - 8),
      top: bounded(top, 8, window.innerHeight - height - 8),
    });
    setSelectionContextMenu(null);
    setHighlightPaletteOpen(false);
    try {
      const result = await api<{ translation: string }>(`/papers/${targetPaperId}/translate-selection`, 'POST', { text: target.selected_text });
      if (sentenceTranslationRequestRef.current !== requestId) return;
      setSentenceTranslation((current) => current?.requestId === requestId && current.paperId === targetPaperId
        ? { ...current, translation: result.translation, status: 'complete' }
        : current);
    } catch (error) {
      if (sentenceTranslationRequestRef.current !== requestId) return;
      setSentenceTranslation((current) => current?.requestId === requestId && current.paperId === targetPaperId
        ? { ...current, failure: errorMessage(error), status: 'error' }
        : current);
    }
  }

  function closeSentenceTranslation() {
    sentenceTranslationRequestRef.current += 1;
    sentenceTranslationDragRef.current = null;
    setSentenceTranslation(null);
  }

  function startSentenceTranslationDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    if (!sentenceTranslation) return;
    sentenceTranslationDragRef.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: sentenceTranslation.left, top: sentenceTranslation.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveSentenceTranslation(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = sentenceTranslationDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = sentenceTranslationRef.current?.getBoundingClientRect();
    const maxLeft = window.innerWidth - (bounds?.width || 328) - 8;
    const maxTop = window.innerHeight - (bounds?.height || 240) - 8;
    setSentenceTranslation((current) => current ? {
      ...current,
      left: bounded(drag.left + event.clientX - drag.x, 8, maxLeft),
      top: bounded(drag.top + event.clientY - drag.y, 8, maxTop),
    } : current);
  }

  function endSentenceTranslationDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (sentenceTranslationDragRef.current?.pointerId !== event.pointerId) return;
    sentenceTranslationDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
    const currentContext = annotation.view_contexts?.[pdfKind] || mappedAnnotations[annotation.id]?.context;
    if (annotation.pdf_kind !== pdfKind && currentContext) {
      goToPage(currentContext.page_no);
      return;
    }
    const targetMode = annotation.pdf_kind === 'dual' ? 'bilingual' : annotation.pdf_kind;
    if (annotation.pdf_kind === pdfKind) {
      goToPage(annotation.page_no);
      return;
    }
    pendingAnnotationJumpRef.current = { pdfKind: annotation.pdf_kind, page: annotation.page_no };
    setMode(targetMode);
  }

  async function saveManualAnnotationLink() {
    if (!manualAnnotationLinkId || !manualAnnotationLinkSelection || manualAnnotationLinkSaving) return;
    setManualAnnotationLinkSaving(true);
    try {
      const updated = await api<PdfAnnotation>(`/papers/${paperId}/annotations/${manualAnnotationLinkId}/views`, 'PATCH', { selection_context: manualAnnotationLinkSelection });
      setAnnotations((previous) => sortAnnotations(previous.map((annotation) => annotation.id === updated.id ? updated : annotation)));
      setManualAnnotationLinkId(null);
      setManualAnnotationLinkSelection(null);
      setSelectionNotice('已关联到当前 PDF 视图。');
    } catch (error) { setSelectionNotice(errorMessage(error)); }
    finally { setManualAnnotationLinkSaving(false); }
  }

  function beginEditingAnnotation(annotation: PdfAnnotation) {
    setEditingAnnotation(annotation.id);
    setAnnotationEditText(annotation.comment);
    setAnnotationFailure('');
  }

  async function saveEditedAnnotation(annotation: PdfAnnotation) {
    try {
      const updated = await api<PdfAnnotation>(`/papers/${paperId}/annotations/${annotation.id}`, 'PATCH', { comment: annotationEditText });
      setAnnotations((previous) => sortAnnotations(previous.map((item) => item.id === updated.id ? updated : item)));
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
                <input aria-label="当前页码" type="number" min={1} max={pdfPageCount} value={pageNumber} onChange={(event) => goToPage(Number(event.target.value))} />
                <span>/ {pdfPageCount}</span>
                <button className="icon-button" aria-label="下一页" onClick={() => goToPage(pageNumber + 1)} disabled={pageNumber >= pdfPageCount}>›</button>
              </div>
              <div className="zoom-controls"><button className="secondary-button compact-button" aria-label="缩小 PDF" onClick={() => setPdfScale((scale) => Math.max(0.5, Math.round((scale - 0.1) * 100) / 100))}>−</button><span>{Math.round(pdfScale * 100)}%</span><button className="secondary-button compact-button" aria-label="放大 PDF" onClick={() => setPdfScale((scale) => Math.min(2.5, Math.round((scale + 0.1) * 100) / 100))}>＋</button></div>
              <button className="reader-toolbar-icon" type="button" aria-label="打开当前 PDF 文件位置" title="文件位置" onClick={() => void window.workbench.revealPaperFile(paperId, pdfKind).catch((error) => setFailure(errorMessage(error)))}>↗</button>
              <button className="reader-toolbar-icon" type="button" data-testid="toggle-chat" aria-label={readerLayout.chatVisible ? '隐藏 AI 助手' : '显示 AI 助手'} aria-pressed={!readerLayout.chatVisible} onClick={() => toggleReaderPanel('chat')}>{readerLayout.chatVisible ? '◫' : '◧'}</button>
              {searchNotice && <span className="search-result">{searchNotice}</span>}
              {selectionNotice && <span className="selection-notice" role="status">{selectionNotice}</span>}
              {manualAnnotationLinkId && <>
                <button type="button" className="primary-button compact-button" disabled={!manualAnnotationLinkSelection || manualAnnotationLinkSaving} onClick={() => void saveManualAnnotationLink()}>确认关联</button>
                <button type="button" className="secondary-button compact-button" onClick={() => { setManualAnnotationLinkId(null); setManualAnnotationLinkSelection(null); setSelectionNotice(''); }}>取消关联</button>
              </>}
            </div>
            <div className="pdf-scroll" ref={setPdfScrollElement} data-testid="pdf-scroll" data-pdf-kind={pdfDocument ? loadedPdfKindRef.current : undefined} aria-label="PDF 页面滚动区" onScroll={(event) => {
              if (!activeRef.current) return;
              if (selection) {
                setSelection(null);
                setSelectionContextMenu(null);
                setHighlightPaletteOpen(false);
              }
              scrollPositionRef.current = event.currentTarget.scrollTop;
              if (isAtPdfScrollEnd() && paper) updatePageFromScroll(pdfPageCount);
            }}>
              {pdfFailure ? <div className="pdf-error">{pdfFailure}</div> : !pdfDocument ? <div className="pdf-loading">正在载入 PDF…</div> : (
                <div className="pdf-pages">
                  {Array.from({ length: pdfPageCount }, (_, index) => index + 1).map((page) => (
                    <PdfPage
                      key={`${pdfKind}-${page}`}
                      document={pdfDocument}
                      pageNumber={page}
                      scale={pdfScale}
                      containerWidth={pdfScrollWidth}
                      scrollRoot={pdfScrollElement}
                      pageAspectRatio={pageAspects[page - 1] || 0.72}
                      annotations={annotationsForPage(page)}
                      mappingRequests={mappingRequestsByPage[page] || []}
                      onMapped={receiveAnnotationMappings}
                      paragraphMarkers={annotations.flatMap((annotation) => {
                        const mapped = mappedAnnotations[annotation.id];
                        return annotation.pdf_kind !== pdfKind && mapped?.kind === 'paragraph' && mapped.context.page_no === page && mapped.context.rects[0]
                          ? [{ id: annotation.id, rect: mapped.context.rects[0], comment: annotation.comment || annotation.selected_text }] : [];
                      })}
                      onAnnotationClick={openAnnotationComment}
                      active={active}
                      onSelection={capturePdfSelection}
                      locateRequest={locationSearch?.candidates[locationSearch.index]?.page_no === page
                        && (locationSearch.candidates[locationSearch.index]?.pdf_kind || 'original') === pdfKind
                        ? { id: `${locationSearch.id}:${locationSearch.index}`, quote: locationSearch.candidates[locationSearch.index].quote }
                        : null}
                      onLocate={receivePdfMatches}
                      previewSelection={manualAnnotationLinkSelection?.pdf_kind === pdfKind ? manualAnnotationLinkSelection : actionLocationPreview?.selection.pdf_kind === pdfKind ? actionLocationPreview.selection : null}
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
            <PaperChats
              paperId={paperId} pageCount={paper.page_count} active={active} visible={rightPanel === 'chat'} rightPanel={rightPanel} onRightPanelChange={setRightPanel}
              onJump={jumpToSource}
              settings={settings} currentModel={currentModel} modelFailure={modelFailure}
              defaultEffort={reasoningPreferences.effort}
              onModelChange={chooseModel} onWebSearchChange={updateWebSearch}
              reasoningPreferences={reasoningPreferences} onReasoningChange={changeReasoningPreferences}
              notes={paperNotes} activeNoteId={activeNoteId}
              selectionToAssociate={selectionToAssociate}
              onAssociationComplete={(request) => {
                setSelectionToAssociate((current) => current === request ? null : current);
              }}
              onCurrentSessionChange={changeActiveChatSession}
              onOpenPdfLocation={goToPdfLocation}
              locationChoices={locationChoices} actionLocationPreview={actionLocationPreview} actionLocationMessage={actionLocationMessage}
              onLocateAction={startActionLocation} onChooseActionLocation={chooseActionLocation} onManualReselect={beginManualActionReselect}
              onConfirmAction={confirmAgentAction}
            />
            <section id={`reader-side-panel-notes-${paperId}`} className="reader-notes-panel" role="tabpanel" aria-labelledby={`reader-side-tab-notes-${paperId}`} hidden={rightPanel !== 'notes'}>
              <ReaderNotesPanel
                paperId={paperId} notes={paperNotes} activeNoteId={activeNoteId} text={noteText}
                loading={!notesLoaded} disabled={noteSwitchPending || noteActionPending}
                saveStatus={noteSaveStatus} error={notesFailure} onChange={changeNoteText}
                noteConflict={noteConflict} onResolveConflict={resolveNoteConflict}
                onSelectNote={switchNote} onCreateNote={() => createNote()}
                onRenameNote={renameNote} onDeleteNote={deleteNote}
                onSave={() => persistPaperNotes(noteDraftRef.current, noteRevisionRef.current, true, true)}
              >
              <div className="reader-annotations-heading"><h3>高亮、下划线与批注</h3><span>{annotations.length}</span></div>
              {annotationFailure && <div className="reader-note-error" role="alert">{annotationFailure}</div>}
              <div className="reader-annotations-list" data-testid="reader-annotations-list">
                {annotations.length === 0 && <p className="reader-annotations-empty">选中 PDF 文字后右键，可添加高亮、下划线或批注。</p>}
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
                  <div className="annotation-view-links" aria-label="标注可见视图">
                    {(['original', 'mono', 'dual'] as const).map((kind) => <span key={kind} className={annotation.pdf_kind === kind || annotation.view_contexts?.[kind] || (kind === pdfKind && mappedAnnotations[annotation.id]) ? 'linked' : ''}>{kind === 'original' ? '英文' : kind === 'mono' ? '中文' : '对照'}</span>)}
                    {annotation.pdf_kind !== pdfKind && <button type="button" className="reader-annotation-jump" disabled={manualAnnotationLinkSaving} onClick={() => {
                      setManualAnnotationLinkId(annotation.id); setManualAnnotationLinkSelection(null);
                      setSelectionNotice('请在当前 PDF 中选中对应文字，然后确认关联。');
                    }}>手动关联当前视图</button>}
                  </div>
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
                      <button type="button" className="secondary-button compact-button" onClick={() => void deleteAnnotation(annotation)}>{annotation.kind === 'highlight' ? '删除高亮' : annotation.kind === 'underline' ? '删除下划线' : '删除批注'}</button>
                    </div>
                  </>}
                </article>)}
              </div>
              </ReaderNotesPanel>
            </section>
          </div>
        </div>
      )}
      {selection && selectionContextMenu && active && <div
        ref={selectionContextMenuRef}
        className="pdf-selection-toolbar pdf-selection-context-menu"
        data-testid="reader-selection-context-menu"
        style={{ left: selectionContextMenu.left, top: selectionContextMenu.top }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button type="button" aria-label="高亮" aria-expanded={highlightPaletteOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setHighlightPaletteOpen((open) => !open)}>高亮</button>
        <button type="button" aria-label="下划线" onMouseDown={(event) => event.preventDefault()} onClick={() => void addUnderline()}>下划线</button>
        <button type="button" aria-label="批注" onMouseDown={(event) => event.preventDefault()} onClick={beginAnnotationDraft}>批注</button>
        <button type="button" aria-label="AI 批注" data-testid="reader-ai-annotation" onMouseDown={(event) => event.preventDefault()} onClick={beginAiAnnotationQuestion}>AI 批注</button>
        <button type="button" aria-label="向 AI 提问" data-testid="reader-ask-ai-about-selection" onMouseDown={(event) => event.preventDefault()} onClick={associateSelectionWithChat}>向 AI 提问</button>
        <button type="button" aria-label="翻译句子" onMouseDown={(event) => event.preventDefault()} onClick={() => void translateSelectedSentence()}>翻译句子</button>
        <button type="button" aria-label="取消文字选择" onMouseDown={(event) => event.preventDefault()} onClick={clearPdfSelection}>取消选择</button>
        {highlightPaletteOpen && <div className="pdf-highlight-palette" role="group" aria-label="高亮颜色">
          <button type="button" className="annotation-color-yellow" aria-label="黄色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('yellow')} />
          <button type="button" className="annotation-color-green" aria-label="绿色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('green')} />
          <button type="button" className="annotation-color-blue" aria-label="蓝色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('blue')} />
          <button type="button" className="annotation-color-pink" aria-label="粉色高亮" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight('pink')} />
        </div>}
      </div>}
      {sentenceTranslation && sentenceTranslation.paperId === paperId && active && <div
        ref={sentenceTranslationRef}
        className="pdf-translation-window"
        data-testid="reader-sentence-translation"
        role="dialog"
        aria-label="句子翻译"
        style={{ left: sentenceTranslation.left, top: sentenceTranslation.top, maxHeight: Math.max(0, Math.min(320, window.innerHeight - sentenceTranslation.top - 8)) }}
      >
        <div className="pdf-translation-window-heading" onPointerDown={startSentenceTranslationDrag} onPointerMove={moveSentenceTranslation} onPointerUp={endSentenceTranslationDrag} onPointerCancel={endSentenceTranslationDrag}>
          <span>句子翻译</span>
          <button type="button" aria-label="关闭翻译" onPointerDown={(event) => event.stopPropagation()} onClick={closeSentenceTranslation}>×</button>
        </div>
        <div className="pdf-translation-window-content">
          <div className="pdf-translation-window-source">{sentenceTranslation.text}</div>
          {sentenceTranslation.status === 'loading' && <div role="status">正在翻译…</div>}
          {sentenceTranslation.failure && <div className="reader-note-error" role="alert">{sentenceTranslation.failure}</div>}
          {sentenceTranslation.translation && <div className="pdf-translation-window-result">{sentenceTranslation.translation}</div>}
        </div>
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
      {aiAnnotationDraft && active && aiAnnotationDraft.paperId === paperId && <div
        className="pdf-annotation-draft ai-annotation-draft"
        data-testid={aiAnnotationDraft.status === 'preview' ? 'reader-ai-annotation-preview' : 'reader-ai-annotation-dialog'}
        role="dialog"
        aria-label="生成 AI 批注"
        style={{ left: Math.max(8, Math.min(window.innerWidth - 380, aiAnnotationDraft.selection.anchor.left)), top: Math.max(8, Math.min(window.innerHeight - 360, aiAnnotationDraft.selection.anchor.bottom + 8)) }}
        onMouseDown={(event) => { if ((event.target as HTMLElement).tagName !== 'TEXTAREA') event.preventDefault(); }}
      >
        <div className="ai-annotation-heading"><span>AI 批注 · 第 {aiAnnotationDraft.selection.page_no} 页</span><button type="button" aria-label="关闭 AI 批注" disabled={aiAnnotationDraft.status === 'saving'} onClick={cancelAiAnnotation}>×</button></div>
        <blockquote className="ai-annotation-quote">{aiAnnotationDraft.selection.selected_text}</blockquote>
        <label htmlFor="reader-ai-annotation-question">先写下你想问的问题</label>
        <textarea
          id="reader-ai-annotation-question" data-testid="reader-ai-annotation-question" aria-label="AI 批注问题"
          autoFocus disabled={aiAnnotationDraft.status === 'loading' || aiAnnotationDraft.status === 'saving'} value={aiAnnotationDraft.question}
          onChange={(event) => setAiAnnotationDraft((current) => current ? { ...current, question: event.target.value, failure: '' } : current)}
          placeholder="例如：这句话中的方法解决了什么问题？"
        />
        {aiAnnotationDraft.status === 'loading' && <div className="ai-annotation-status" role="status">正在根据这段原文生成简短解释…</div>}
        {aiAnnotationDraft.status === 'saving' && <div className="ai-annotation-status" role="status">正在保存批注…</div>}
        {(aiAnnotationDraft.status === 'preview' || aiAnnotationDraft.status === 'saving') && <>
          <label htmlFor="reader-ai-annotation-explanation">可编辑的简短解释</label>
          <textarea id="reader-ai-annotation-explanation" aria-label="AI 批注解释" disabled={aiAnnotationDraft.status === 'saving'} value={aiAnnotationDraft.comment}
            onChange={(event) => setAiAnnotationDraft((current) => current ? { ...current, comment: event.target.value, failure: '' } : current)} />
          {aiAnnotationDraft.generatedQuestion !== aiAnnotationDraft.question.trim() && <div className="ai-annotation-status">问题有修改，请重新生成解释后保存。</div>}
        </>}
        {aiAnnotationDraft.failure && <div className="reader-note-error" role="alert">{aiAnnotationDraft.failure}</div>}
        <div className="reader-annotation-actions">
          <button type="button" className="secondary-button compact-button" disabled={aiAnnotationDraft.status === 'saving'} onClick={cancelAiAnnotation}>取消</button>
          {aiAnnotationDraft.status === 'preview' && <button type="button" className="secondary-button compact-button" disabled={!aiAnnotationDraft.question.trim()} onClick={() => void generateAiAnnotation()}>重新生成</button>}
          {aiAnnotationDraft.status === 'preview' || aiAnnotationDraft.status === 'saving'
            ? <button type="button" className="primary-button compact-button" data-testid="reader-ai-annotation-save" disabled={aiAnnotationDraft.status === 'saving' || !aiAnnotationDraft.comment.trim() || aiAnnotationDraft.generatedQuestion !== aiAnnotationDraft.question.trim()} onClick={() => void saveAiAnnotation()}>{aiAnnotationDraft.status === 'saving' ? '正在保存…' : '保存批注'}</button>
            : <button type="button" className="primary-button compact-button" disabled={!aiAnnotationDraft.question.trim() || aiAnnotationDraft.status === 'loading'} onClick={() => void generateAiAnnotation()}>生成预览</button>}
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
  thinking: ReasoningThinking; completed?: boolean;
};

type PaperChatsProps = {
  paperId: string; pageCount: number; active: boolean; visible: boolean;
  rightPanel: 'chat' | 'notes'; onRightPanelChange: (panel: 'chat' | 'notes') => void;
  onJump: (source: Source) => void;
  settings: ReaderSettings | null; currentModel: string; modelFailure: string; defaultEffort: ReasoningEffort;
  onModelChange: (model: string) => Promise<void>;
  onWebSearchChange: (enabled: boolean) => Promise<void>;
  reasoningPreferences: ReasoningPreferences; onReasoningChange: (preferences: Partial<ReasoningPreferences>) => void;
  selectionToAssociate: SelectionAssociationRequest | null; onAssociationComplete: (request: SelectionAssociationRequest, sessionId: string) => void;
  onCurrentSessionChange: (sessionId: string) => void;
  onOpenPdfLocation: (kind: PdfKind, page: number) => void;
  locationChoices: { sessionId: string; actionId: string; matches: SelectionContext[] } | null;
  actionLocationPreview: ActionLocationPreview | null;
  actionLocationMessage: { actionId: string; message: string } | null;
  onLocateAction: (sessionId: string, action: AgentAction) => void;
  onChooseActionLocation: (sessionId: string, actionId: string, target: SelectionContext) => void;
  onManualReselect: (sessionId: string, action: AgentAction) => void;
  onConfirmAction: (sessionId: string, action: AgentAction, input: AgentActionConfirmInput) => Promise<AgentAction>;
  notes: PaperNote[]; activeNoteId: string;
};
type ChatSession = { id: string; title: string; created_at: string; selection_context?: SelectionContext | null };

function PaperChats(props: PaperChatsProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState('');
  const [assistantMode, setAssistantMode] = useState<'chat' | 'research'>('chat');
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({});
  const [changing, setChanging] = useState(false);
  const [failure, setFailure] = useState('');
  const [associationFailure, setAssociationFailure] = useState('');
  const [associationRetry, setAssociationRetry] = useState(0);
  const attemptedAssociationRef = useRef<SelectionAssociationRequest | null>(null);
  const latestAssociationBySessionRef = useRef(new Map<string, object>());
  const selectionWriteQueueRef = useRef(new Map<string, Promise<void>>());
  const currentSessionRef = useRef(currentSession);
  const selectionToAssociateRef = useRef(props.selectionToAssociate);
  currentSessionRef.current = currentSession;
  selectionToAssociateRef.current = props.selectionToAssociate;
  const selectionKey = `paper-workbench.chat-session.${props.paperId}`;

  function selectSession(sessionId: string) {
    currentSessionRef.current = sessionId;
    setCurrentSession(sessionId);
    props.onCurrentSessionChange(sessionId);
  }

  function writeSessionSelection(sessionId: string, selectionContext: SelectionContext | null) {
    const previous = selectionWriteQueueRef.current.get(sessionId) || Promise.resolve();
    const request = previous.catch(() => undefined).then(() => api<{ selection_context: SelectionContext | null }>(
      `/papers/${props.paperId}/chat-sessions/${sessionId}/selection`, 'PUT', { selection_context: selectionContext },
    ));
    const settled = request.then(() => undefined, () => undefined);
    selectionWriteQueueRef.current.set(sessionId, settled);
    void settled.then(() => {
      if (selectionWriteQueueRef.current.get(sessionId) === settled) selectionWriteQueueRef.current.delete(sessionId);
    });
    return request;
  }

  useEffect(() => {
    let cancelled = false;
    void api<ChatSession[]>(`/papers/${props.paperId}/chat-sessions`).then((list) => {
      if (cancelled) return;
      let saved = '';
      try { saved = localStorage.getItem(selectionKey) || ''; } catch { /* session history is stored in the database */ }
      setSessions(list);
      selectSession(list.some((session) => session.id === saved) ? saved : list[0]?.id || '');
    }).catch((error) => { if (!cancelled) setFailure(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [props.paperId, selectionKey]);

  useEffect(() => {
    if (currentSession) {
      try { localStorage.setItem(selectionKey, currentSession); } catch { /* selecting a session still works */ }
    }
    props.onCurrentSessionChange(currentSession);
  }, [currentSession, selectionKey, props.onCurrentSessionChange]);

  useEffect(() => {
    const request = props.selectionToAssociate;
    if (!request) { attemptedAssociationRef.current = null; return; }
    const targetSessionId = request.sessionId && sessions.some((session) => session.id === request.sessionId)
      ? request.sessionId : currentSession;
    if (!targetSessionId || attemptedAssociationRef.current === request) return;
    attemptedAssociationRef.current = request;
    latestAssociationBySessionRef.current.set(targetSessionId, request);
    const originatingSessionId = request.sessionId || currentSessionRef.current;
    setAssociationFailure('');
    void writeSessionSelection(targetSessionId, toSelectionContext(request.selection)).then((result) => {
      if (latestAssociationBySessionRef.current.get(targetSessionId) === request) {
        setSessions((previous) => previous.map((session) => session.id === targetSessionId ? { ...session, selection_context: result.selection_context } : session));
        latestAssociationBySessionRef.current.delete(targetSessionId);
      }
      if (selectionToAssociateRef.current === request) {
        if (currentSessionRef.current === originatingSessionId && currentSessionRef.current !== targetSessionId) selectSession(targetSessionId);
        props.onAssociationComplete(request, targetSessionId);
      }
    }).catch((error) => {
      if (latestAssociationBySessionRef.current.get(targetSessionId) === request) latestAssociationBySessionRef.current.delete(targetSessionId);
      if (selectionToAssociateRef.current === request) setAssociationFailure(errorMessage(error));
    });
  }, [props.paperId, props.selectionToAssociate, currentSession, sessions, associationRetry, props.onAssociationComplete]);

  async function clearAssociation(sessionId: string) {
    const requestToken = {};
    latestAssociationBySessionRef.current.set(sessionId, requestToken);
    setAssociationFailure('');
    try {
      const result = await writeSessionSelection(sessionId, null);
      if (latestAssociationBySessionRef.current.get(sessionId) === requestToken) {
        setSessions((previous) => previous.map((session) => session.id === sessionId ? { ...session, selection_context: result.selection_context } : session));
        latestAssociationBySessionRef.current.delete(sessionId);
      }
    } catch (error) {
      if (latestAssociationBySessionRef.current.get(sessionId) === requestToken) {
        latestAssociationBySessionRef.current.delete(sessionId);
        setAssociationFailure(errorMessage(error));
      }
    }
  }

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
      selectSession(created.id);
      setAssistantMode('chat');
      props.onRightPanelChange('chat');
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
      if (currentSession === session.id) selectSession(list[0]?.id || '');
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setChanging(false); }
  }

  return <>
    <div className="chat-session-bar">
      <div className="reader-side-tabs" role="tablist" aria-label="阅读侧栏">
        <button id={`reader-side-tab-chat-${props.paperId}`} type="button" role="tab" data-testid="reader-side-tab-chat" aria-label="问答（AI 助手）" title="问答（AI 助手）" aria-controls={`reader-side-panel-chat-${props.paperId}`} aria-selected={props.rightPanel === 'chat'} className={props.rightPanel === 'chat' ? 'active' : ''} onClick={() => props.onRightPanelChange('chat')}>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M3.25 4.75A1.75 1.75 0 0 1 5 3h10a1.75 1.75 0 0 1 1.75 1.75v6A1.75 1.75 0 0 1 15 12.5H9l-3.75 3v-3H5a1.75 1.75 0 0 1-1.75-1.75v-6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M6.5 7h7M6.5 9.75h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        <button id={`reader-side-tab-notes-${props.paperId}`} type="button" role="tab" data-testid="reader-side-tab-notes" aria-label="笔记" title="笔记" aria-controls={`reader-side-panel-notes-${props.paperId}`} aria-selected={props.rightPanel === 'notes'} className={props.rightPanel === 'notes' ? 'active' : ''} onClick={() => props.onRightPanelChange('notes')}>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M5.25 2.75h6.5l3 3v10A1.5 1.5 0 0 1 13.25 17h-8A1.5 1.5 0 0 1 3.75 15.5v-11A1.75 1.75 0 0 1 5.25 2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M11.5 3v3h3M6.5 9h6M6.5 12h6M6.5 15h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
      <div className="chat-session-tabs" role="tablist" aria-label="文献 AI 会话">
        {sessions.map((session) => <div className={`chat-session-tab ${session.id === currentSession ? 'active' : ''}`} key={session.id}>
          <button type="button" role="tab" aria-selected={session.id === currentSession} data-testid={`chat-session-${session.id}`} title={session.title} onClick={() => { selectSession(session.id); setAssistantMode('chat'); props.onRightPanelChange('chat'); }}>{session.title}</button>
          <button type="button" className="chat-session-close" aria-label={`删除会话 ${session.title}`} title={busySessions[session.id] ? '请先停止此会话的生成' : '删除此会话'} disabled={changing || busySessions[session.id]} onClick={() => void deleteSession(session)}>×</button>
        </div>)}
      </div>
      <button type="button" className="chat-session-new" aria-label="新建 AI 会话" title="新建会话" disabled={changing || !sessions.length} onClick={() => void newSession()}><svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg></button>
    </div>
    <div id={`reader-side-panel-chat-${props.paperId}`} className="reader-side-content" role="tabpanel" aria-labelledby={`reader-side-tab-chat-${props.paperId}`} hidden={props.rightPanel !== 'chat'}>
      {failure && <div className="chat-error" role="alert">{failure}</div>}
      {associationFailure && <div className="chat-error" role="alert">{associationFailure}{props.selectionToAssociate && <button type="button" className="secondary-button compact-button" onClick={() => { attemptedAssociationRef.current = null; setAssociationRetry((value) => value + 1); }}>重试关联</button>}</div>}
      {!sessions.length && !failure && <div className="chat-empty">正在读取会话…</div>}
      {!!sessions.length && <div className="assistant-mode-switch" role="tablist" aria-label="AI 工作模式">
        <button type="button" role="tab" data-testid="reader-chat-mode-chat" aria-selected={assistantMode === 'chat'} aria-controls={`reader-chat-mode-panel-chat-${props.paperId}`} className={assistantMode === 'chat' ? 'active' : ''} onClick={() => setAssistantMode('chat')}>聊天</button>
        <button type="button" role="tab" data-testid="reader-chat-mode-research" aria-selected={assistantMode === 'research'} aria-controls={`reader-chat-mode-panel-research-${props.paperId}`} className={assistantMode === 'research' ? 'active' : ''} onClick={() => setAssistantMode('research')}>深度研究</button>
      </div>}
      <div id={`reader-chat-mode-panel-chat-${props.paperId}`} className="assistant-mode-panel" role="tabpanel" aria-labelledby="reader-chat-mode-chat" hidden={assistantMode !== 'chat'}>
        {sessions.map((session) => <div className="chat-session-content" data-session-id={session.id} key={session.id} hidden={session.id !== currentSession}>
          <ChatPanel {...props} sessionId={session.id} selectionContext={session.selection_context || null} onClearAssociation={clearAssociation} visible={props.visible && assistantMode === 'chat' && session.id === currentSession} onBusyChange={markBusy} />
        </div>)}
      </div>
      <div id={`reader-chat-mode-panel-research-${props.paperId}`} className="assistant-mode-panel research-mode-panel" role="tabpanel" aria-labelledby="reader-chat-mode-research" hidden={assistantMode !== 'research'}>
        {sessions.find((session) => session.id === currentSession) && <ResearchTasksPanel
          key={`${props.paperId}:${currentSession}`}
          paperId={props.paperId} sessionId={currentSession} active={props.active && props.visible && assistantMode === 'research'}
          pageCount={props.pageCount} currentModel={props.currentModel} defaultEffort={props.defaultEffort}
          selectionContext={sessions.find((session) => session.id === currentSession)?.selection_context || null}
          onOpenPdfLocation={(page) => props.onOpenPdfLocation('original', page)}
        />}
      </div>
    </div>
  </>;
}

function ChatPanel(props: PaperChatsProps & {
  sessionId: string; selectionContext: SelectionContext | null; onClearAssociation: (sessionId: string) => Promise<void>;
  onBusyChange: (id: string, busy: boolean) => void;
}) {
  const { paperId, active, visible, onJump, settings, currentModel, modelFailure, onModelChange, onWebSearchChange, sessionId, selectionContext, onClearAssociation, onBusyChange } = props;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [agentActions, setAgentActions] = useState<AgentAction[]>([]);
  const [actionDrafts, setActionDrafts] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});
  const [question, setQuestion] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentView[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | number | null>(null);
  const [actionNoteTargets, setActionNoteTargets] = useState<Record<string, string>>({});
  const attachmentEpochRef = useRef(0);
  const removedUploadsRef = useRef(new Set<string>());
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
  const autoLocatedActionsRef = useRef(new Set<string>());
  const busyActionsRef = useRef(new Set<string>());

  useEffect(() => () => { attachmentEpochRef.current += 1; }, [paperId, sessionId]);

  async function loadAttachmentPreview(attachment: ChatAttachmentView) {
    const content = await api<{ mime_type: string; data_base64: string }>(`/papers/${paperId}/chat-sessions/${sessionId}/attachments/${attachment.id}/content`);
    return `data:${content.mime_type};base64,${content.data_base64}`;
  }

  async function removeAttachment(id: string) {
    removedUploadsRef.current.add(id);
    setPendingAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
    if (id.startsWith('pending-')) return;
    try { await api(`/papers/${paperId}/chat-sessions/${sessionId}/attachments/${id}`, 'DELETE'); }
    catch (error) { setFailure(errorMessage(error)); }
  }

  async function addAttachmentFiles(files: File[]) {
    if (busy) return;
    const epoch = attachmentEpochRef.current;
    let slots = 5 - pendingAttachments.length;
    for (const file of files) {
      if (epoch !== attachmentEpochRef.current) return;
      if (slots <= 0) { setFailure('每条消息最多添加 5 个附件。'); break; }
      const temporaryId = `pending-${crypto.randomUUID()}`;
      if (file.size > 10 * 1024 * 1024) { setFailure('单个附件不能超过 10 MB。'); continue; }
      slots -= 1;
      setPendingAttachments((previous) => [...previous, { id: temporaryId, name: file.name, mime_type: file.type || '', size: file.size, status: 'uploading' }]);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('无法读取附件。'));
          reader.readAsDataURL(file);
        });
        const uploaded = await api<ChatAttachment>(`/papers/${paperId}/chat-sessions/${sessionId}/attachments`, 'POST', {
          name: file.name, mime_type: file.type || '', data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          ...(/\.pdf$/i.test(file.name) ? { page_images: await renderPdfAttachment(file) } : {}),
        });
        if (removedUploadsRef.current.has(temporaryId)) {
          await api(`/papers/${paperId}/chat-sessions/${sessionId}/attachments/${uploaded.id}`, 'DELETE');
          removedUploadsRef.current.delete(temporaryId);
          continue;
        }
        if (epoch !== attachmentEpochRef.current) {
          await api(`/papers/${paperId}/chat-sessions/${sessionId}/attachments/${uploaded.id}`, 'DELETE');
          return;
        }
        setPendingAttachments((previous) => previous.map((item) => item.id === temporaryId ? {
          ...uploaded, status: 'ready', ...(uploaded.mime_type.startsWith('image/') ? { previewUrl: dataUrl } : {}),
        } : item));
      } catch (error) {
        if (epoch !== attachmentEpochRef.current) return;
        setPendingAttachments((previous) => previous.map((item) => item.id === temporaryId ? { ...item, status: 'error', error: errorMessage(error) } : item));
      }
    }
  }

  const refresh = useCallback(async () => {
    const [nextMessages, nextRuns, nextActions] = await Promise.all([
      api<ChatMessage[]>(`/papers/${paperId}/chat?session_id=${sessionId}`),
      api<AnalysisRun[]>(`/papers/${paperId}/analysis?session_id=${sessionId}`),
      api<AgentAction[]>(`/papers/${paperId}/agent-actions?session_id=${encodeURIComponent(sessionId)}`),
    ]);
    setMessages(nextMessages);
    setRuns(nextRuns);
    setAgentActions((previous) => {
      const existing = new Map(previous.map((action) => [action.id, action]));
      return nextActions.map((action) => {
        const current = existing.get(action.id);
        return current && current.status !== 'pending' && action.status === 'pending' ? current : action;
      });
    });
    setActionDrafts((previous) => {
      const next = { ...previous };
      nextActions.forEach((action) => { if (!(action.id in next)) next[action.id] = action.kind === 'annotation' ? action.payload.comment || '' : action.payload.text || ''; });
      return next;
    });
  }, [paperId, sessionId]);

  useEffect(() => {
    if (active && visible) void refresh().catch((error) => setFailure(errorMessage(error)));
  }, [active, visible, refresh]);
  useEffect(() => { onBusyChange(sessionId, busy); }, [sessionId, busy, onBusyChange]);

  useEffect(() => {
    if (!active || !visible) return;
    for (const action of agentActions) {
      if (action.kind !== 'annotation' || action.status !== 'pending' || autoLocatedActionsRef.current.has(action.id)) continue;
      autoLocatedActionsRef.current.add(action.id);
      props.onLocateAction(sessionId, action);
    }
  }, [active, visible, agentActions, sessionId, props.onLocateAction]);

  function replaceAgentAction(action: AgentAction) {
    setAgentActions((previous) => [...previous.filter((item) => item.id !== action.id), action]);
    setActionDrafts((previous) => previous[action.id] === undefined ? {
      ...previous, [action.id]: action.kind === 'annotation' ? action.payload.comment || '' : action.payload.text || '',
    } : previous);
  }

  async function confirmAction(action: AgentAction) {
    if (busyActionsRef.current.has(action.id) || action.status !== 'pending') return;
    const original = action.kind === 'annotation' ? action.payload.comment || '' : action.payload.text || '';
    const draft = actionDrafts[action.id] ?? original;
    const preview = props.actionLocationPreview?.sessionId === sessionId && props.actionLocationPreview.actionId === action.id ? props.actionLocationPreview : null;
    if (action.kind === 'annotation' && !preview) {
      setActionErrors((previous) => ({ ...previous, [action.id]: '请先在 PDF 中定位或手动重新选择批注位置。' }));
      return;
    }
    busyActionsRef.current.add(action.id);
    setBusyActions((previous) => ({ ...previous, [action.id]: true }));
    setActionErrors((previous) => ({ ...previous, [action.id]: '' }));
    try {
      const updated = await props.onConfirmAction(sessionId, action, {
        ...(preview ? { selection_context: preview.selection, ...(preview.manualReselect ? { manual_reselect: true as const } : {}) } : {}),
        ...(draft !== original ? action.kind === 'annotation' ? { comment: draft } : { text: draft } : {}),
        ...(action.kind === 'note' ? ((actionNoteTargets[action.id] || (action.payload.new_note ? '__new__' : '')) === '__new__' ? { new_note: true, note_title: 'AI 笔记' } : {
          new_note: false, note_id: actionNoteTargets[action.id] || action.payload.note_id || props.activeNoteId,
        }) : {}),
      });
      replaceAgentAction(updated);
    } catch (error) { setActionErrors((previous) => ({ ...previous, [action.id]: errorMessage(error) })); }
    finally { busyActionsRef.current.delete(action.id); setBusyActions((previous) => ({ ...previous, [action.id]: false })); }
  }

  async function cancelAction(action: AgentAction) {
    if (busyActionsRef.current.has(action.id) || action.status !== 'pending') return;
    busyActionsRef.current.add(action.id);
    setBusyActions((previous) => ({ ...previous, [action.id]: true }));
    setActionErrors((previous) => ({ ...previous, [action.id]: '' }));
    try {
      replaceAgentAction(await api<AgentAction>(`/papers/${paperId}/agent-actions/${action.id}/cancel`, 'POST', {}));
    } catch (error) { setActionErrors((previous) => ({ ...previous, [action.id]: errorMessage(error) })); }
    finally { busyActionsRef.current.delete(action.id); setBusyActions((previous) => ({ ...previous, [action.id]: false })); }
  }

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
      completed: true,
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

  async function startStream(input: { question?: string; runId?: string; attachment_ids?: string[]; onRejected?: () => void }) {
    followLatest();
    const requestPreferences = { ...props.reasoningPreferences };
    const requestModel = currentModel;
    const requestSelectionContext = selectionContext;
    const initial: ActiveStream = {
      answer: '', reasoning: '', phase: 'thinking', runId: input.runId, sources: [], thinking: requestPreferences.thinking,
    };
    activeRef.current = initial;
    setActiveStream(initial);
    setBusy(true);
    setStopping(false);
    let ended = false;
    let rejected = false;
    try {
      const handle = await window.workbench.startChatStream({
        paperId, sessionId, question: input.question, runId: input.runId,
        model: requestModel, webSearch: webSearchEnabled,
        selection_context: requestSelectionContext || undefined,
        attachment_ids: input.attachment_ids,
        selected_note_id: props.activeNoteId || undefined,
        ...(requestPreferences.thinking === 'default' ? {} : { thinking: requestPreferences.thinking }),
        ...(requestPreferences.effort === 'default' ? {} : { reasoning_effort: requestPreferences.effort }),
      }, (event) => {
        const previous = activeRef.current;
        if (!previous || (previous.requestId && previous.requestId !== event.requestId)) return;
        const data = event.data;
        const messageId = typeof data.message_id === 'number' ? data.message_id : previous.messageId;
        if (['done', 'cancelled', 'error'].includes(event.type)) {
          ended = true;
          if (event.type === 'error' && messageId == null && data.request_rejected === true) {
            rejected = true;
            input.onRejected?.();
          }
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
        } else if ((event.type === 'reasoning_summary_delta' || event.type === 'reasoning_summary') && typeof data.text === 'string') {
          next.reasoning += data.text;
        } else if (event.type === 'agent_action' && data.action && typeof data.action === 'object') {
          replaceAgentAction(data.action as AgentAction);
        } else if (event.type === 'turn_reset') {
          next.answer = '';
        } else if (event.type === 'sources' && Array.isArray(data.sources)) {
          next.sources = data.sources as Source[];
        }
        activeRef.current = next;
        setActiveStream(next);
        if (event.type === 'status' && previous.messageId == null && messageId != null) {
          void api<ChatMessage[]>(`/papers/${paperId}/chat?session_id=${sessionId}`).then((currentMessages) => {
            if (activeRef.current?.messageId === messageId && !activeRef.current.completed) setMessages(currentMessages);
          }).catch(() => { /* completion refresh retries the history */ });
        }
      });
      if (!ended && activeRef.current) {
        const next = { ...activeRef.current, requestId: handle.requestId };
        activeRef.current = next;
        handleRef.current = handle;
        setActiveStream(next);
      } else {
        handle.dispose();
      }
      return !rejected;
    } catch (error) {
      handleRef.current?.dispose();
      handleRef.current = null;
      activeRef.current = null;
      setActiveStream(null);
      setBusy(false);
      setFailure(errorMessage(error));
      await refresh().catch((error) => setFailure(errorMessage(error)));
      return false;
    }
  }

  async function send() {
    const text = question.trim();
    if ((!text && !pendingAttachments.length) || busy || pendingAttachments.some((item) => item.status !== 'ready')) return;
    setQuestion('');
    setFailure('');
    const attachments = pendingAttachments;
    const started = await startStream({ question: text || '请分析这些附件。', attachment_ids: attachments.map((item) => item.id), onRejected: () => {
      setQuestion((current) => current || text);
      setPendingAttachments((current) => [...current, ...attachments.filter((attachment) => !current.some((item) => item.id === attachment.id))]);
    } });
    if (started) setPendingAttachments([]);
    else setQuestion(text);
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
        : activeStream.tool === 'load_research_skill' ? '正在加载研究技能…'
        : activeStream.tool === 'summarize_paper' || activeStream.runId ? '正在发送整篇原文…' : '正在使用文献工具…'
    : activeStream?.runId ? '正在发送整篇原文…' : '正在生成回答…';

  return (
    <aside className="chat-panel">
      <div className="chat-messages-shell">
      <div className="chat-messages" ref={messagesRef} data-testid="chat-messages" aria-live="polite" onWheel={(event) => {
        if (event.deltaY < 0) { followLatestRef.current = false; setFollowingLatest(false); }
      }} onScroll={(event) => {
        if (!active || !visible) return;
        const container = event.currentTarget;
        messagesTopRef.current = container.scrollTop;
        const following = container.scrollHeight - container.scrollTop - container.clientHeight <= 4;
        followLatestRef.current = following;
        setFollowingLatest(following);
        const turnNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-turn-id]'));
        const middle = container.getBoundingClientRect().top + container.clientHeight / 2;
        const turn = turnNodes.filter((node) => node.getBoundingClientRect().top <= middle).at(-1) || turnNodes[0];
        if (turn) setActiveTurnId(turn.dataset.chatTurnId || null);
      }}>
        {selectionContext && <div className="reader-selection-association" data-testid="reader-selection-association">
          <div><strong>已关联{selectionContext.pdf_kind === 'original' ? '原文' : selectionContext.pdf_kind === 'mono' ? '中文' : '对照'} · 第 {selectionContext.page_no} 页</strong><blockquote>{selectionContext.selected_text}</blockquote></div>
          <button type="button" className="secondary-button compact-button" data-testid="reader-clear-associated-selection" onClick={() => void onClearAssociation(sessionId)}>清除</button>
        </div>}
        {visibleMessages.length === 0 && runs.length === 0 && !activeStream && <div className="chat-empty"><div className="chat-empty-mark" aria-hidden="true">问</div><p>可以直接问“详细总结一下这篇文献”，也可以询问实验设计、数据或结论。</p></div>}
        {visibleMessages.map((message, index) => <Message key={message.id ?? `${message.created_at || index}-${index}`} message={message} onJump={onJump} onLoadAttachmentPreview={loadAttachmentPreview} />)}
        {runs.filter((run) => !(run.status === 'running' && activeStream?.runId === run.id)).map((run) => <div className="run-card" key={run.id}>
          <div className="run-title">{run.kind === 'full_prompt' ? '整篇原文总结' : '全文分块总结'} {run.status === 'running' ? '进行中' : run.status === 'completed' ? '已完成' : '未完成'}</div>
          <div className="run-progress">{run.kind === 'full_prompt' ? '整篇原文以一次请求发送，不截断或拆分。' : `已覆盖 ${run.completed_chunks}/${run.total_chunks} 个正文分块`}</div>
          {run.error && <p className="paper-error">{run.error}</p>}
          {run.status !== 'running' && run.status !== 'completed' && <button className="secondary-button compact-button" disabled={busy} onClick={() => void resume(run)}>继续总结</button>}
        </div>)}
        {agentActions.map((action) => {
          const original = action.kind === 'annotation' ? action.payload.comment || '' : action.payload.text || '';
          const draft = actionDrafts[action.id] ?? original;
          const preview = props.actionLocationPreview?.sessionId === sessionId && props.actionLocationPreview.actionId === action.id ? props.actionLocationPreview : null;
          const choices = props.locationChoices?.sessionId === sessionId && props.locationChoices.actionId === action.id ? props.locationChoices.matches : [];
          const locationMessage = props.actionLocationMessage?.actionId === action.id ? props.actionLocationMessage.message : '';
          const pending = action.status === 'pending';
          const actionQuote = action.payload.selection_context?.selected_text || action.payload.quote;
          return <article className="agent-action-card" key={action.id} data-testid={`reader-agent-action-${action.id}`} data-action-kind={action.kind} data-action-status={action.status}>
            <div className="agent-action-heading"><strong>{action.kind === 'annotation' ? 'AI 批注建议' : 'AI 笔记建议'}</strong><span>{pending ? '待确认' : action.status === 'applied' ? '已保存' : '已取消'}</span></div>
            {actionQuote && <blockquote className="agent-action-quote">{actionQuote}{action.payload.page_no && <> · 第 {action.payload.page_no} 页</>}</blockquote>}
            <label htmlFor={`reader-agent-action-text-${action.id}`}>{action.kind === 'annotation' ? '批注草稿' : '建议追加到笔记'}</label>
            <textarea id={`reader-agent-action-text-${action.id}`} data-testid={`reader-agent-action-text-${action.id}`} value={draft} disabled={!pending || !!busyActions[action.id]}
              onChange={(event) => setActionDrafts((previous) => ({ ...previous, [action.id]: event.target.value }))} />
            {action.kind === 'note' && pending && <label className="agent-note-target">保存到
              <select aria-label="建议笔记保存到" disabled={!!busyActions[action.id]}
                value={actionNoteTargets[action.id] || (action.payload.new_note ? '__new__' : action.payload.note_id || props.activeNoteId)}
                onChange={(event) => setActionNoteTargets((previous) => ({ ...previous, [action.id]: event.target.value }))}>
                {props.notes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
                <option value="__new__">＋ 新建笔记</option>
              </select>
            </label>}
            {action.kind === 'annotation' && <>
              {choices.length > 1 && <div className="agent-action-locations" role="group" aria-label="选择匹配的批注位置">{choices.map((match, index) => <button
                key={`${match.pdf_kind}-${match.page_no}-${match.rects[0]?.x}-${match.rects[0]?.y}-${index}`}
                type="button" className={preview?.selection === match ? 'active' : ''}
                data-testid={`reader-agent-action-location-${action.id}-${index}`} aria-pressed={preview?.selection === match}
                onClick={() => props.onChooseActionLocation(sessionId, action.id, match)}
              >位置 {index + 1} · 第 {match.page_no} 页</button>)}</div>}
              {locationMessage && <div className="agent-action-location-message" role="status">{locationMessage}</div>}
              {preview && <div className="agent-action-location-preview" data-testid="reader-action-location-preview">
                <span>{preview.manualReselect ? '手动重选预览' : '批注位置预览'} · 第 {preview.selection.page_no} 页 · {preview.selection.pdf_kind === 'original' ? '原文 PDF' : preview.selection.pdf_kind === 'mono' ? '中文 PDF' : '双语 PDF'}</span>
                <blockquote>{preview.selection.selected_text}</blockquote>
                <button type="button" className="secondary-button compact-button" onClick={() => props.onOpenPdfLocation(preview.selection.pdf_kind, preview.selection.page_no)}>跳到预览位置</button>
              </div>}
              {pending && <div className="agent-action-location-actions">
                <button type="button" className="secondary-button compact-button" onClick={() => props.onLocateAction(sessionId, action)}>重新定位</button>
                <button type="button" className="secondary-button compact-button" data-testid={`reader-agent-action-reselect-${action.id}`} onClick={() => props.onManualReselect(sessionId, action)}>手动重选位置</button>
              </div>}
            </>}
            {actionErrors[action.id] && <div className="chat-error" role="alert">{actionErrors[action.id]}</div>}
            {pending && <div className="agent-action-actions">
              <button type="button" className="secondary-button compact-button" data-testid={`reader-agent-action-cancel-${action.id}`} disabled={!!busyActions[action.id]} onClick={() => void cancelAction(action)}>取消建议</button>
              <button type="button" className="primary-button compact-button" data-testid={`reader-agent-action-confirm-${action.id}`} disabled={!!busyActions[action.id] || (action.kind === 'annotation' && !preview) || !draft.trim()} onClick={() => void confirmAction(action)}>{busyActions[action.id] ? '处理中…' : action.kind === 'annotation' ? '确认并保存批注' : '确认追加到笔记'}</button>
            </div>}
          </article>;
        })}
        {activeStream && <div className="chat-message assistant active-chat-stream">
          <div className="message-role">Folio · 正在生成</div>
          <div className="message-content" data-testid="streaming-answer"><MarkdownContent markdown={activeStream.answer || '…'} sources={activeStream.sources} onJump={onJump} /></div>
          <div className="assistant-thinking"><span className="typing-dots">•••</span>{activeLabel}{activeStream.query ? ` ${activeStream.query}` : ''}</div>
        </div>}
      </div>
      <ChatTurnNavigation
        turns={visibleMessages.filter((message) => message.role === 'user' && message.id != null).map((message) => ({ id: message.id!, excerpt: message.content.slice(0, 80) || '附件提问' }))}
        activeId={activeTurnId} containerRef={messagesRef}
        onNavigate={(id) => { followLatestRef.current = false; setFollowingLatest(false); setActiveTurnId(id); }}
      />
      </div>
      {!followingLatest && <button className="chat-follow-latest" type="button" onClick={followLatest}>回到最新 ↓</button>}
      {failure && <div className="chat-error" role="alert">{failure}</div>}
      <ChatComposer
        value={question} onChange={setQuestion} onSubmit={() => send()}
        attachments={pendingAttachments} onFiles={(files) => void addAttachmentFiles(files)}
        onRemoveAttachment={(id) => void removeAttachment(id)}
        onLoadPreview={loadAttachmentPreview} disabled={!settings} busy={busy} stopping={stopping}
        onStop={() => void stop()} searchEnabled={webSearchEnabled} onSearchChange={changeWebSearch}
        currentModel={currentModel}
        models={[...new Set([currentModel, settings?.model || '', ...(settings?.model_options || [])])].filter(Boolean).map((id) => ({ id, efforts: reasoningEffortOptions(id).options }))}
        onModelChange={onModelChange} effort={props.reasoningPreferences.effort}
        onEffortChange={(effort) => props.onReasoningChange({ thinking: 'default', effort })}
      />
      {modelFailure && <div className="reader-model-error" role="alert">{modelFailure}</div>}
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

function Message({ message, onJump, onLoadAttachmentPreview }: {
  message: ChatMessage; onJump: (source: Source) => void;
  onLoadAttachmentPreview: (attachment: ChatAttachmentView) => Promise<string | null>;
}) {
  const incomplete = message.role === 'assistant' && message.status && message.status !== 'completed';
  return <div className={`chat-message ${message.role}`} data-chat-turn-id={message.role === 'user' ? message.id : undefined}>
    <div className="message-role">{message.role === 'user' ? '你' : 'Folio'}{incomplete ? ` · ${message.status === 'cancelled' ? '已停止，未完成' : message.status === 'interrupted' ? '窗口关闭时中断' : message.status === 'error' ? '未完成' : '处理中断'}` : ''}</div>
    {!!message.attachments?.length && <ChatAttachmentList attachments={message.attachments} onLoadPreview={onLoadAttachmentPreview} />}
    <div className="message-content"><MarkdownContent markdown={message.content} sources={message.sources} onJump={onJump} /></div>
    {message.error && <div className="message-incomplete-error">{message.error}</div>}
    {(message.sources || []).some((source) => source.kind === 'web' && source.url) && <div className="web-source-list">
      <div>网页来源</div>
      {(message.sources || []).filter((source) => source.kind === 'web' && source.url).map((source) => <button type="button" key={source.id} onClick={() => onJump(source)}>{source.title || source.url}</button>)}
    </div>}
  </div>;
}
