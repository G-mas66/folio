import { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './reader-notes-upgrade.css';

export type ReaderNote = { id: string; title: string; text: string; created_at?: string; updated_at?: string | null };
export type ReaderNoteSaveStatus = '未保存' | '保存中…' | '已保存' | '保存失败' | string;

export type ReaderNotesPanelProps = {
  paperId: string;
  notes: ReaderNote[];
  activeNoteId: string | null;
  text: string;
  loading?: boolean;
  disabled?: boolean;
  saveStatus: ReaderNoteSaveStatus;
  error?: string;
  noteConflict?: boolean;
  onChange: (text: string) => void;
  onResolveConflict?: () => void | Promise<void>;
  onSelectNote: (id: string) => void | Promise<void>;
  onCreateNote: () => void | Promise<void>;
  onRenameNote: (id: string, title: string) => void | Promise<void>;
  onDeleteNote: (id: string) => void | Promise<void>;
  onSave?: () => void | Promise<void>;
  children?: ReactNode;
};

type NotePanelMode = 'read' | 'edit';
type NotePanelSplit = { upperHeight: number };
type DragState = { pointerId: number; startY: number; startHeight: number };

const splitStoragePrefix = 'paper-workbench.reader-notes-split.v1.';
const DEFAULT_UPPER_RATIO = 0.48;
const MIN_UPPER_HEIGHT = 124;
const MIN_LOWER_HEIGHT = 96;
const SPLITTER_HEIGHT = 14;

function safeExternalHref(href: string | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function readSplit(paperId: string): number | null {
  try {
    const saved = JSON.parse(localStorage.getItem(`${splitStoragePrefix}${paperId}`) || 'null') as Partial<NotePanelSplit> | null;
    return typeof saved?.upperHeight === 'number' && Number.isFinite(saved.upperHeight) ? saved.upperHeight : null;
  } catch {
    return null;
  }
}

function saveSplit(paperId: string, upperHeight: number) {
  try { localStorage.setItem(`${splitStoragePrefix}${paperId}`, JSON.stringify({ upperHeight })); } catch { /* the panel still resizes for this session */ }
}

function noteTitle(note: ReaderNote | undefined) {
  return note?.title?.trim() || '未命名笔记';
}

export function ReaderNotesPanel({
  paperId, notes, activeNoteId, text, loading = false, disabled = false, saveStatus, error, noteConflict = false,
  onChange, onResolveConflict, onSelectNote, onCreateNote, onRenameNote, onDeleteNote, onSave, children,
}: ReaderNotesPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [upperHeight, setUpperHeight] = useState<number | null>(() => readSplit(paperId));
  const [mode, setMode] = useState<NotePanelMode>('read');
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [annotationsCollapsed, setAnnotationsCollapsed] = useState(false);
  const activeNote = notes.find((note) => note.id === activeNoteId);
  const layoutHeight = upperHeight === null ? undefined : `${upperHeight}px`;

  useEffect(() => {
    setUpperHeight(readSplit(paperId));
    setMode('read');
    setMenuOpen(false);
    setRenaming(false);
    setNotesCollapsed(false);
    setAnnotationsCollapsed(false);
  }, [paperId]);

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  useEffect(() => setMode('read'), [activeNoteId]);

  function boundedUpperHeight(requested: number) {
    const totalHeight = rootRef.current?.getBoundingClientRect().height || 0;
    if (totalHeight <= 0) return Math.max(MIN_UPPER_HEIGHT, requested);
    return Math.min(
      Math.max(MIN_UPPER_HEIGHT, requested),
      Math.max(MIN_UPPER_HEIGHT, totalHeight - MIN_LOWER_HEIGHT - SPLITTER_HEIGHT),
    );
  }

  function setAndRememberHeight(height: number) {
    const next = boundedUpperHeight(height);
    setUpperHeight(next);
    saveSplit(paperId, next);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || notesCollapsed || annotationsCollapsed) return;
    const currentHeight = upperRef.current?.getBoundingClientRect().height;
    if (!currentHeight) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: currentHeight };
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setUpperHeight(boundedUpperHeight(drag.startHeight + event.clientY - drag.startY));
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = boundedUpperHeight(drag.startHeight + event.clientY - drag.startY);
    dragRef.current = null;
    setUpperHeight(next);
    saveSplit(paperId, next);
  }

  function adjustHeight(delta: number) {
    const totalHeight = rootRef.current?.getBoundingClientRect().height || 0;
    const current = upperRef.current?.getBoundingClientRect().height
      || totalHeight * DEFAULT_UPPER_RATIO
      || 240;
    setAndRememberHeight(current + delta);
  }

  function resizeByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      adjustHeight(event.key === 'ArrowUp' ? -20 : 20);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setAndRememberHeight(MIN_UPPER_HEIGHT);
    } else if (event.key === 'End') {
      event.preventDefault();
      const totalHeight = rootRef.current?.getBoundingClientRect().height || 0;
      setAndRememberHeight(totalHeight - MIN_LOWER_HEIGHT - SPLITTER_HEIGHT);
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!activeNote || !title) return;
    await onRenameNote(activeNote.id, title);
    setRenaming(false);
    setMenuOpen(false);
  }

  async function deleteActiveNote() {
    if (!activeNote) return;
    const label = noteTitle(activeNote);
    if (!window.confirm(`删除“${label}”？此操作无法撤销。`)) return;
    await onDeleteNote(activeNote.id);
    setMenuOpen(false);
  }

  function beginRename() {
    if (!activeNote) return;
    setRenameTitle(noteTitle(activeNote));
    setRenaming(true);
    setMenuOpen(false);
  }

  return <div className={`reader-notes-upgrade${notesCollapsed ? ' notes-collapsed' : ''}${annotationsCollapsed ? ' annotations-collapsed' : ''}`} ref={rootRef}>
    <section
      className="reader-notes-upgrade-upper"
      ref={upperRef}
      style={{ height: notesCollapsed ? undefined : layoutHeight, flexBasis: notesCollapsed ? undefined : layoutHeight }}
      aria-label="阅读笔记"
      hidden={notesCollapsed}
    >
      <div className="reader-notes-upgrade-tabs" role="tablist" aria-label="文献笔记">
        {notes.map((note) => <button
          key={note.id}
          type="button"
          role="tab"
          aria-selected={note.id === activeNoteId}
          className={`reader-notes-upgrade-tab${note.id === activeNoteId ? ' active' : ''}`}
          title={noteTitle(note)}
          onClick={() => { setRenaming(false); void onSelectNote(note.id); }}
        >{noteTitle(note)}</button>)}
        <button type="button" className="reader-notes-upgrade-add" aria-label="新建笔记" title="新建笔记" disabled={loading || disabled} onClick={() => void onCreateNote()}>＋</button>
        <span className="reader-notes-upgrade-spacer" />
        <button type="button" className="reader-notes-upgrade-collapse" aria-label="收起笔记区域" title="收起笔记区域" onClick={() => setNotesCollapsed(true)}>⌃</button>
      </div>
      <div className="reader-notes-upgrade-tools">
        <div className="reader-notes-upgrade-mode" role="group" aria-label="笔记显示方式">
          <button type="button" className={mode === 'read' ? 'active' : ''} aria-pressed={mode === 'read'} onClick={() => setMode('read')}>阅读</button>
          <button type="button" className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑</button>
        </div>
        <span className="reader-notes-upgrade-status" role="status">{loading ? '正在载入…' : saveStatus}</span>
        {noteConflict && onResolveConflict && <button
          type="button"
          className="reader-notes-upgrade-save"
          disabled={loading || disabled}
          onClick={() => void onResolveConflict()}
        >合并冲突版本</button>}
        {onSave && <button
          type="button"
          className="reader-notes-upgrade-save"
          disabled={loading || disabled || noteConflict || saveStatus === '保存中…' || saveStatus === '已保存'}
          onClick={() => void onSave()}
        >保存</button>}
        <div className="reader-notes-upgrade-menu-wrap">
          <button
            type="button"
            className="reader-notes-upgrade-menu-button"
            aria-label="笔记操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={!activeNote || loading || disabled}
            onClick={() => setMenuOpen((open) => !open)}
          >···</button>
          {menuOpen && <div className="reader-notes-upgrade-menu" role="menu">
            <button type="button" role="menuitem" onClick={beginRename}>重命名</button>
            <button type="button" role="menuitem" disabled={notes.length <= 1} title={notes.length <= 1 ? '至少保留一篇笔记' : undefined} onClick={() => void deleteActiveNote()}>删除笔记</button>
          </div>}
        </div>
      </div>
      {renaming && activeNote && <form className="reader-notes-upgrade-rename" onSubmit={(event) => void submitRename(event)}>
        <input
          ref={renameInputRef}
          aria-label="笔记名称"
          maxLength={100}
          value={renameTitle}
          onChange={(event) => setRenameTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false); }}
        />
        <button type="submit" disabled={!renameTitle.trim() || disabled}>保存名称</button>
        <button type="button" onClick={() => setRenaming(false)}>取消</button>
      </form>}
      {error && <div className="reader-notes-upgrade-error" role="alert">{error}</div>}
      <div className={`reader-notes-upgrade-body${mode === 'edit' ? ' editing' : ''}`}>
        {!activeNoteId
          ? <div className="reader-notes-upgrade-empty">{loading ? '正在载入笔记…' : <>还没有笔记。<button type="button" disabled={disabled} onClick={() => void onCreateNote()}>新建一篇</button></>}</div>
          : mode === 'edit'
            ? <textarea
              data-testid="reader-note-editor"
              aria-label="阅读笔记 Markdown 源文"
              value={text}
              disabled={loading || disabled}
              placeholder="用 Markdown 记录这篇文献的阅读笔记…"
              onChange={(event) => onChange(event.target.value)}
            />
            : <article className="reader-notes-upgrade-markdown" aria-label={noteTitle(activeNote)}>
              {text.trim()
                ? <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  skipHtml
                  components={{
                    a: ({ href, children }) => {
                      const safeHref = safeExternalHref(href);
                      return safeHref
                        ? <button type="button" className="reader-notes-upgrade-link" onClick={() => void window.workbench.openExternal(safeHref)}>{children}</button>
                        : <span>{children}</span>;
                    },
                    img: ({ alt }) => <span className="reader-notes-upgrade-image-note">[图片未加载{alt ? `：${alt}` : ''}]</span>,
                  }}
                >{text}</ReactMarkdown>
                : <p className="reader-notes-upgrade-placeholder">这篇笔记还是空的。切换到“编辑”开始记录。</p>}
            </article>}
      </div>
    </section>

    <div
      className="reader-notes-upgrade-splitter"
      role="separator"
      aria-label="调整笔记与批注区域高度"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(upperHeight || 0)}
      aria-valuetext={notesCollapsed ? '笔记区域已收起' : annotationsCollapsed ? '批注区域已收起' : `笔记区域高度 ${Math.round(upperHeight || 0)} 像素`}
      tabIndex={notesCollapsed || annotationsCollapsed ? -1 : 0}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onKeyDown={resizeByKeyboard}
    >
      {notesCollapsed && <button type="button" aria-label="展开笔记区域" title="展开笔记区域" onPointerDown={(event) => event.stopPropagation()} onClick={() => setNotesCollapsed(false)}>⌄</button>}
      <span className="reader-notes-upgrade-grip" aria-hidden="true" />
      <button
        type="button"
        aria-label={annotationsCollapsed ? '展开批注区域' : '收起批注区域'}
        title={annotationsCollapsed ? '展开批注区域' : '收起批注区域'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setAnnotationsCollapsed((collapsed) => !collapsed)}
      >{annotationsCollapsed ? '⌃' : '⌄'}</button>
    </div>

    {!annotationsCollapsed && <section className="reader-notes-upgrade-annotations" aria-label="高亮、下划线与批注">
      {children}
    </section>}
    {annotationsCollapsed && <button
      type="button"
      className="reader-notes-upgrade-show-annotations"
      onClick={() => setAnnotationsCollapsed(false)}
    >展开批注</button>}
  </div>;
}
