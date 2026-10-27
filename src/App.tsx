import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, Folder, Paper, UpdateState } from './api';
import type { PdfKind } from './PdfPage';
import { PaperLibrary } from './PaperLibrary';
import { Reader } from './Reader';
import { SettingsPanel } from './SettingsPanel';
import { BibliographyPanel } from './BibliographyPanel';
import { removeThumbnailCover } from './thumbnailCoverCache';

const readerTabsKey = 'paper-workbench.reader-tabs.v1';
const recentPaperIdsKey = 'folio.recent-papers.v1';
const themePreferenceKey = 'folio.theme.v1';
const eyeComfortKey = 'folio.eye-comfort.v1';
type ThemePreference = 'system' | 'light' | 'dark';

function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(themePreferenceKey);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  return preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : preference === 'dark' ? 'dark' : 'light';
}

function readEyeComfort(): boolean {
  try { return localStorage.getItem(eyeComfortKey) === 'on'; } catch { return false; }
}

function readReaderTabs(): { paperIds: string[]; active: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(readerTabsKey) || 'null');
    const paperIds = Array.isArray(saved?.paperIds) ? saved.paperIds.filter((id: unknown) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) : [];
    return { paperIds, active: typeof saved?.active === 'string' ? saved.active : 'library' };
  } catch {
    return { paperIds: [], active: 'library' };
  }
}

function readRecentPaperIds(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(recentPaperIdsKey) || 'null');
    return Array.isArray(saved) ? saved.filter((id: unknown) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) : [];
  } catch {
    return [];
  }
}

export function App() {
  return <Workbench />;
}

function Workbench() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(readThemePreference()));
  const [eyeComfort, setEyeComfort] = useState(readEyeComfort);
  const [activePanel, setActivePanel] = useState('library');
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const focusLibrarySearchRef = useRef(false);
  const [readerTabs, setReaderTabs] = useState<string[]>([]);
  const [readerOpenRequest, setReaderOpenRequest] = useState<{ paperId: string; kind: PdfKind; sequence: number } | null>(null);
  const readerTabsRef = useRef(readerTabs);
  readerTabsRef.current = readerTabs;
  const [readerPapers, setReaderPapers] = useState<Record<string, Paper>>({});
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [recentPaperIds, setRecentPaperIds] = useState<string[]>(readRecentPaperIds);
  const [papers, setPapers] = useState<Paper[]>([]);
  const refreshSequenceRef = useRef(0);
  const [favoritePending, setFavoritePending] = useState<string[]>([]);
  const [totalPaperCount, setTotalPaperCount] = useState<number | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderFilter, setFolderFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [updateNotice, setUpdateNotice] = useState<UpdateState | null>(null);
  const dismissedUpdateRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Paper | null>(null);
  const [folderDialog, setFolderDialog] = useState<'create' | 'rename' | null>(null);
  const [folderName, setFolderName] = useState('');
  const [feedbackDialog, setFeedbackDialog] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    let active = true;
    const receiveUpdateState = (value: UpdateState) => {
      if (!active) return;
      if (value.status === 'available' || value.status === 'manual-available') {
        if ((value.version || '') !== dismissedUpdateRef.current) setUpdateNotice(value);
      } else {
        setUpdateNotice(null);
      }
    };
    const unsubscribe = window.workbench.onUpdateState(receiveUpdateState);
    void window.workbench.getUpdateState().then(receiveUpdateState).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const next = themePreference === 'system' ? media.matches ? 'dark' : 'light' : themePreference;
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
      setTheme(next);
    };
    apply();
    void window.workbench.setThemePreference(themePreference).catch((error) => setError(errorMessage(error)));
    if (themePreference !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [themePreference]);

  useLayoutEffect(() => {
    const value = eyeComfort ? 'on' : 'off';
    document.documentElement.dataset.eyeComfort = value;
    try { localStorage.setItem(eyeComfortKey, value); } catch { /* eye comfort preference is optional */ }
  }, [eyeComfort]);

  useLayoutEffect(() => {
    if (activePanel !== 'library' || !focusLibrarySearchRef.current) return;
    focusLibrarySearchRef.current = false;
    const input = librarySearchRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [activePanel]);

  useEffect(() => {
    try { localStorage.setItem(themePreferenceKey, themePreference); } catch { /* theme preference is optional */ }
  }, [themePreference]);

  useEffect(() => window.workbench.onPrepareUpdateInstall(async (requestId) => {
    const pending: Promise<void>[] = [];
    window.dispatchEvent(new CustomEvent('folio:prepare-update-install', { detail: { pending } }));
    try {
      await Promise.all(pending);
      window.workbench.updateInstallReady(requestId);
    } catch (error) {
      window.workbench.updateInstallReady(requestId, errorMessage(error));
    }
  }), []);

  function clearFileDrag() {
    dragDepthRef.current = 0;
    setDragging(false);
  }

  useEffect(() => {
    const cancel = () => clearFileDrag();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clearFileDrag(); };
    window.addEventListener('dragend', cancel);
    window.addEventListener('drop', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('focus', cancel);
    window.addEventListener('pointerdown', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('dragend', cancel);
      window.removeEventListener('drop', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('focus', cancel);
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('keydown', escape);
    };
  }, []);

  useEffect(() => { clearFileDrag(); }, [activePanel]);

  useEffect(() => {
    let mounted = true;
    const saved = readReaderTabs();
    void api<Paper[]>('/papers?folder_id=all').then((allPapers) => {
      if (!mounted) return;
      const readable = allPapers.filter((paper) => paper.can_read || paper.can_read_original);
      const byId = Object.fromEntries(readable.map((paper) => [paper.id, paper])) as Record<string, Paper>;
      const validTabs = [...new Set(saved.paperIds)].filter((id) => Boolean(byId[id]));
      setReaderPapers(byId);
      setReaderTabs(validTabs);
      setActivePanel(['settings', 'library', 'bibliography'].includes(saved.active) || validTabs.includes(saved.active) ? saved.active : 'library');
    }).catch((e) => {
      if (mounted) setError(errorMessage(e));
    }).finally(() => {
      if (mounted) setTabsLoaded(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!tabsLoaded) return;
    try { localStorage.setItem(readerTabsKey, JSON.stringify({ paperIds: readerTabs, active: activePanel })); } catch { /* local preferences are optional */ }
  }, [tabsLoaded, readerTabs, activePanel]);

  useEffect(() => {
    try { localStorage.setItem(recentPaperIdsKey, JSON.stringify(recentPaperIds)); } catch { /* local preferences are optional */ }
  }, [recentPaperIds]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const query = new URLSearchParams({ folder_id: ['recent', 'favorites'].includes(folderFilter) ? 'all' : folderFilter });
      if (folderFilter === 'favorites') query.set('favorite', 'true');
      if (search) query.set('q', search);
      const [nextPapers, nextFolders] = await Promise.all([
        api<Paper[]>(`/papers?${query.toString()}`),
        api<Folder[]>('/folders'),
      ]);
      if (sequence !== refreshSequenceRef.current) return;
      const visiblePapers = folderFilter === 'recent'
        ? nextPapers.filter((paper) => recentPaperIds.includes(paper.id)).sort((a, b) => recentPaperIds.indexOf(a.id) - recentPaperIds.indexOf(b.id))
        : nextPapers;
      setPapers(visiblePapers);
      if (folderFilter === 'all' && !search) setTotalPaperCount(nextPapers.length);
      setFolders(nextFolders);
      setReaderPapers((current) => {
        const next = { ...current };
        for (const paper of nextPapers) if (next[paper.id]) next[paper.id] = paper;
        return next;
      });
    } catch (e) {
      if (sequence === refreshSequenceRef.current) setError(errorMessage(e));
    }
  }, [folderFilter, recentPaperIds, search]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { window.clearInterval(timer); refreshSequenceRef.current += 1; };
  }, [refresh]);

  async function importFiles(paths: string[]) {
    if (!paths.length) return;
    setBusy(true);
    setNotice('正在导入并检查 PDF…');
    setError('');
    try {
      const folder_id = !['all', 'unfiled', 'recent', 'favorites'].includes(folderFilter) ? folderFilter : null;
      const result = await api<{ results: { duplicate: boolean; paper: Paper }[] }>('/papers/import', 'POST', { paths, folder_id });
      const added = result.results.filter((item) => !item.duplicate).length;
      const duplicates = result.results.length - added;
      setTotalPaperCount((current) => current === null ? null : current + added);
      setNotice(`导入完成：新增 ${added} 篇${duplicates ? `，${duplicates} 篇内容相同的文献已合并` : ''}。`);
      await refresh();
    } catch (e) {
      setNotice('');
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFiles() {
    const paths = await window.workbench.choosePdfs();
    await importFiles(paths);
  }

  async function revealFile(paper: Paper, kind: PdfKind = 'original') {
    try { await window.workbench.revealPaperFile(paper.id, kind); }
    catch (error) { setError(errorMessage(error)); }
  }

  async function openLibraryFolder() {
    try { await window.workbench.openLibraryFolder(); }
    catch (error) { setError(errorMessage(error)); }
  }

  function beginFeedback() {
    setNotice('');
    setError('');
    setFeedbackDialog(true);
  }

  async function paperAction(paper: Paper, action: 'stop' | 'continue' | 'retry') {
    setError('');
    try {
      await api(`/papers/${paper.id}/translation/${action}`, 'POST');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function toggleFavorite(paper: Paper) {
    setFavoritePending((current) => [...current, paper.id]);
    setError('');
    try {
      const updated = await api<Paper>(`/papers/${paper.id}/favorite`, 'PATCH', { is_favorite: !paper.is_favorite });
      refreshSequenceRef.current += 1;
      setReaderPapers((current) => current[paper.id] ? { ...current, [paper.id]: updated } : current);
      await refreshRef.current();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setFavoritePending((current) => current.filter((id) => id !== paper.id));
    }
  }

  async function saveTitle(paper: Paper, english_title: string, chinese_title: string) {
    setError('');
    try {
      await api(`/papers/${paper.id}/title`, 'PATCH', { english_title, chinese_title });
      setReaderPapers((current) => current[paper.id]
        ? { ...current, [paper.id]: { ...current[paper.id], english_title, chinese_title } }
        : current);
      setEditing(null);
      setNotice('标题已更新，文献库副本文件名已同步。');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function openReader(paper: Paper, kind?: PdfKind) {
    if (!paper.can_read && !paper.can_read_original) return;
    if (kind === 'mono' && !paper.mono_pdf_file_name || kind === 'dual' && !paper.dual_pdf_file_name) return;
    if (kind) setReaderOpenRequest((current) => ({ paperId: paper.id, kind, sequence: (current?.sequence || 0) + 1 }));
    setRecentPaperIds((current) => [paper.id, ...current.filter((id) => id !== paper.id)]);
    setReaderPapers((current) => ({ ...current, [paper.id]: paper }));
    if (!readerTabsRef.current.includes(paper.id)) {
      const nextTabs = [...readerTabsRef.current, paper.id];
      readerTabsRef.current = nextTabs;
      setReaderTabs(nextTabs);
    }
    setActivePanel(paper.id);
  }

  function removeReaderTab(paperId: string) {
    const currentTabs = readerTabsRef.current;
    const index = currentTabs.indexOf(paperId);
    if (index < 0) return;
    const nextTabs = currentTabs.filter((id) => id !== paperId);
    readerTabsRef.current = nextTabs;
    setReaderTabs(nextTabs);
    setReaderPapers((current) => {
      const next = { ...current };
      delete next[paperId];
      return next;
    });
    setActivePanel((current) => current === paperId ? nextTabs[Math.max(0, index - 1)] || 'library' : current);
  }

  async function closeReaderTab(paperId: string) {
    try { await window.workbench.cancelPaperStreams(paperId); } catch { /* closing a tab should still complete */ }
    removeReaderTab(paperId);
  }

  async function deletePaper(paper: Paper) {
    const title = paper.chinese_title || paper.english_title || paper.source_name;
    if (!window.confirm(`确定删除“${title}”吗？这会删除工作台中的原文副本、中文 PDF、双语 PDF、聊天记录、阅读笔记和批注。导入时选择的源文件不会删除。`)) return;
    setError('');
    try {
      await api(`/papers/${paper.id}`, 'DELETE');
      removeThumbnailCover(paper.id);
      setTotalPaperCount((current) => current === null ? null : Math.max(0, current - 1));
      setRecentPaperIds((current) => current.filter((id) => id !== paper.id));
      if (readerTabs.includes(paper.id)) await closeReaderTab(paper.id);
      try { localStorage.removeItem(`paper-workbench.note-draft.${paper.id}`); } catch { /* the paper is already deleted */ }
      setNotice('已从工作台删除该文献，原始导入文件未更改。');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function beginFolderDialog(mode: 'create' | 'rename') {
    const selected = folders.find((folder) => folder.id === folderFilter);
    setFolderName(mode === 'rename' ? selected?.name || '' : '');
    setFolderDialog(mode);
  }

  async function saveFolder() {
    const name = folderName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    try {
      if (folderDialog === 'create') {
        const created = await api<Folder>('/folders', 'POST', { name });
        setFolderFilter(created.id);
        setNotice(`已创建文件夹“${created.name}”。`);
      } else if (folderDialog === 'rename' && folderFilter !== 'all' && folderFilter !== 'unfiled') {
        await api(`/folders/${folderFilter}`, 'PATCH', { name });
        setNotice('文件夹名称已更新。');
        await refresh();
      }
      setFolderDialog(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteFolder() {
    const folder = folders.find((item) => item.id === folderFilter);
    if (!folder || !window.confirm(`删除文件夹“${folder.name}”？文献会移到“未分类”，不会删除文献或 PDF。`)) return;
    setError('');
    try {
      await api(`/folders/${folder.id}`, 'DELETE');
      setFolderFilter('unfiled');
      setNotice(`已删除文件夹“${folder.name}”；其中的文献已移到未分类。`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function movePaper(paper: Paper, folder_id: string | null) {
    setError('');
    try {
      await api(`/papers/${paper.id}/folder`, 'PATCH', { folder_id });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function dismissUpdateNotice() {
    dismissedUpdateRef.current = updateNotice?.version || '';
    setUpdateNotice(null);
  }

  function actOnUpdateNotice() {
    const action = updateNotice?.platform === 'windows'
      ? window.workbench.downloadUpdate()
      : window.workbench.openUpdateDownload();
    dismissedUpdateRef.current = updateNotice?.version || '';
    setUpdateNotice(null);
    void action.catch((updateError) => setError(errorMessage(updateError)));
  }

  const unfiledCount = totalPaperCount === null ? null : Math.max(0, totalPaperCount - folders.reduce((sum, folder) => sum + folder.paper_count, 0));
  function updateLibrarySearch(value: string) {
    setSearch(value);
    if (activePanel !== 'library') {
      focusLibrarySearchRef.current = true;
      setActivePanel('library');
    }
  }
  const libraryNavigation = <LibraryNavigation
    folderFilter={folderFilter}
    folders={folders}
    search={search}
    unfiledCount={unfiledCount}
    onSearch={updateLibrarySearch}
    onSelectFilter={(value) => { setFolderFilter(value); setActivePanel('library'); }}
    onCreateFolder={() => { setActivePanel('library'); beginFolderDialog('create'); }}
  />;
  const readerLibraryNavigation = <LibraryNavigation
    folderFilter={folderFilter}
    folders={folders}
    search={search}
    unfiledCount={unfiledCount}
    onSearch={updateLibrarySearch}
    onSelectFilter={(value) => { setFolderFilter(value); setActivePanel('library'); }}
    onCreateFolder={() => { setActivePanel('library'); beginFolderDialog('create'); }}
    testIdPrefix="reader-"
  />;

  return (
    <div className="app-shell" onDragEnter={(event) => {
      if (activePanel !== 'library' || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    }} onDragOver={(event) => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault();
    }} onDragLeave={(event) => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current || event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) clearFileDrag();
    }} onDrop={(event) => {
      event.preventDefault();
      clearFileDrag();
      if (activePanel !== 'library') return;
      try {
        const paths = window.workbench.getDroppedPaths(Array.from(event.dataTransfer.files));
        void importFiles(paths);
      } catch (error) { setError(errorMessage(error)); }
    }}>
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-mark" aria-hidden="true"><img src="./folio-mark.svg" alt="" /></div>
          <div className="brand-wordmark">Folio</div>
        </div>
        <nav className="app-tab-strip" role="tablist" aria-label="工作台标签">
          <button className={`app-tab ${activePanel === 'bibliography' ? 'selected' : ''}`} type="button" role="tab" aria-selected={activePanel === 'bibliography'} aria-controls="bibliography-tab-panel" data-testid="bibliography-tab" onClick={() => setActivePanel('bibliography')}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 3h16v18H4V3Zm3 4v2h10V7H7Zm0 4v2h10v-2H7Zm0 4v2h7v-2H7Z" /></svg><span>书目</span></button>
          <button className={`app-tab library-tab ${activePanel === 'library' ? 'selected' : ''}`} type="button" role="tab" aria-selected={activePanel === 'library'} aria-controls="library-tab-panel" data-testid="library-tab" onClick={() => setActivePanel('library')}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 5.5c3.4-1.1 6.1-.7 8.5 1.1v13c-2.4-1.8-5.1-2.2-8.5-1.1v-13Zm17 0c-3.4-1.1-6.1-.7-8.5 1.1v13c2.4-1.8 5.1-2.2 8.5-1.1v-13Z" /></svg><span>文献库</span></button>
          {readerTabs.map((paperId) => {
            const paper = readerPapers[paperId];
            if (!paper) return null;
            const title = paper.chinese_title || paper.english_title || paper.source_name;
            return <div className={`reader-tab ${activePanel === paperId ? 'selected' : ''}`} key={paperId}>
              <button className="app-tab reader-tab-title" type="button" role="tab" aria-selected={activePanel === paperId} aria-controls={`reader-tab-panel-${paperId}`} data-testid={`paper-tab-${paperId}`} title={title} onClick={() => openReader(paper)}>{title}</button>
              <button className="reader-tab-close" type="button" aria-label={`关闭 ${title}`} data-testid={`close-tab-${paperId}`} title="关闭标签" onClick={() => void closeReaderTab(paperId)}>×</button>
            </div>;
          })}
        </nav>
        <button className="topbar-icon-button theme-toggle" type="button" data-testid="theme-toggle" aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}>
          <svg aria-hidden="true" viewBox="0 0 24 24">{theme === 'dark' ? <path d="M20.4 15.7A8.6 8.6 0 0 1 8.3 3.6 8.7 8.7 0 1 0 20.4 15.7Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>}</svg>
        </button>
        <button className="topbar-icon-button eye-comfort-toggle" type="button" data-testid="eye-comfort-toggle" aria-pressed={eyeComfort} aria-label={eyeComfort ? '关闭护眼模式' : '开启护眼模式'} title={eyeComfort ? '关闭护眼模式' : '开启护眼模式'} onClick={() => setEyeComfort((value) => !value)}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="3" /></svg>
        </button>
        <button className={`topbar-icon-button settings-tab ${activePanel === 'settings' ? 'selected' : ''}`} type="button" data-testid="settings-tab" aria-label="设置" title="设置" onClick={() => setActivePanel('settings')}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9.7 3.8.5-1.3h3.6l.5 1.3a8.7 8.7 0 0 1 1.7 1l1.3-.4 1.8 3.1-1 1a8.3 8.3 0 0 1 0 2l1 1-1.8 3.1-1.3-.4a8.7 8.7 0 0 1-1.7 1l-.5 1.3h-3.6l-.5-1.3a8.7 8.7 0 0 1-1.7-1l-1.3.4-1.8-3.1 1-1a8.3 8.3 0 0 1 0-2l-1-1 1.8-3.1 1.3.4a8.7 8.7 0 0 1 1.7-1Z" transform="translate(0 2)" /><circle cx="12" cy="12" r="3" /></svg>
        </button>
      </header>
      {updateNotice && <div className="update-toast" data-testid="update-toast" role="status">
        <div className="update-toast-heading"><strong>Folio 有可用更新</strong><button type="button" className="update-toast-dismiss" aria-label="稍后提醒" onClick={dismissUpdateNotice}>×</button></div>
        <p>版本 {updateNotice.version} 已准备好。{updateNotice.platform === 'macos' ? `下载适用于 ${updateNotice.architecture || '当前'} 架构的安装包。` : '下载后可选择何时重启安装。'}</p>
        <div className="update-toast-actions"><button className="primary-button compact-button" type="button" onClick={actOnUpdateNotice}>{updateNotice.platform === 'macos' ? '获取更新' : '下载更新'}</button><button className="text-button" type="button" onClick={() => { dismissUpdateNotice(); setActivePanel('settings'); }}>查看详情</button><button className="text-button" type="button" onClick={dismissUpdateNotice}>稍后</button></div>
      </div>}
      <div className="app-content">
        <section className="app-panel settings-app-panel" hidden={activePanel !== 'settings'}>
          {activePanel === 'settings' && <SettingsPanel theme={themePreference} onThemeChange={setThemePreference} />}
        </section>
        <section className="app-panel settings-app-panel" id="bibliography-tab-panel" role="tabpanel" hidden={activePanel !== 'bibliography'}>
          {activePanel === 'bibliography' && <BibliographyPanel folders={folders} folderFilter={['recent', 'favorites'].includes(folderFilter) ? 'all' : folderFilter} onSelectFolder={setFolderFilter} onRecordsChanged={() => { void refresh(); }}
            folderActions={<><button className="text-button" type="button" onClick={() => beginFolderDialog('create')}>新建文件夹</button>{!['all', 'unfiled', 'recent', 'favorites'].includes(folderFilter) && <><button className="text-button" type="button" onClick={() => beginFolderDialog('rename')}>重命名文件夹</button><button className="text-button delete-paper-button" type="button" onClick={() => void deleteFolder()}>删除文件夹</button></>}</>}
            onOpenPaper={(id) => { void api<Paper>(`/papers/${id}`).then(openReader).catch((reason) => setError(errorMessage(reason))); }} />}
          {activePanel === 'bibliography' && folderDialog && <FolderDialog mode={folderDialog} value={folderName} onChange={setFolderName} onClose={() => setFolderDialog(null)} onSave={() => void saveFolder()} />}
        </section>
        <section className="app-panel library-app-panel" id="library-tab-panel" role="tabpanel" hidden={activePanel !== 'library'}>
        <div className="library-workspace">
          <aside className="library-sidebar" data-testid="library-sidebar" aria-label="文献分类">
            {libraryNavigation}
            <div className="folder-actions">
              <button className="text-button" aria-label="新建文件夹" onClick={() => beginFolderDialog('create')}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h7l2 2h8v11h-17v-13Zm8.5 5v6m-3-3h6" /></svg><span>新建文件夹</span></button>
              <button className="text-button" type="button" onClick={() => void openLibraryFolder()}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 7h6l2 2h9v11h-17v-13Z" /></svg><span>打开文献目录</span></button>
              <button className="text-button" type="button" aria-label="意见反馈" onClick={beginFeedback}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5.5h16v12H9l-5 3v-3Z" /><path d="M7 9h10M7 12.5h7" /></svg><span>意见反馈</span></button>
              {!['all', 'unfiled', 'recent', 'favorites'].includes(folderFilter) && <>
                <button className="text-button" aria-label="重命名文件夹" onClick={() => beginFolderDialog('rename')}>重命名</button>
                <button className="text-button delete-paper-button" aria-label="删除文件夹" onClick={() => void deleteFolder()}>删除文件夹</button>
              </>}
            </div>
          </aside>
          <PaperLibrary papers={papers} folders={folders} folderFilter={folderFilter} search={search} onSearch={setSearch}
            searchInputRef={librarySearchRef} active={activePanel === 'library'} busy={busy} notice={notice} error={error}
            favoritePending={favoritePending} onChooseFiles={() => void chooseFiles()}
            onOpen={openReader} onFavorite={(paper) => void toggleFavorite(paper)} onEdit={setEditing}
            onDelete={(paper) => void deletePaper(paper)} onReveal={(paper, kind) => void revealFile(paper, kind)}
            onMove={(paper, folderId) => void movePaper(paper, folderId)} onAction={(paper, action) => void paperAction(paper, action)}
            onBibliography={(paper) => {
              void api('/literature/capture', 'POST', { paper_id: paper.id, title: titleFor(paper), source: 'local_pdf' }).then(() => setActivePanel('bibliography')).catch((reason) => setError(errorMessage(reason)));
            }} />
          {dragging && <div className="drop-overlay" aria-hidden="true"><div>松开即可导入 PDF</div></div>}
          {editing && <TitleDialog paper={editing} onClose={() => setEditing(null)} onSave={(english, chinese) => void saveTitle(editing, english, chinese)} />}
          {activePanel === 'library' && folderDialog && <FolderDialog mode={folderDialog} value={folderName} onChange={setFolderName} onClose={() => setFolderDialog(null)} onSave={() => void saveFolder()} />}
          {feedbackDialog && <FeedbackDialog
            onClose={() => setFeedbackDialog(false)}
            onSubmitted={(requiresActivation) => {
              setFeedbackDialog(false);
              setNotice(requiresActivation
                ? '反馈已暂存，服务正在等待收件端激活。'
                : '反馈服务已接收，感谢你的建议。');
            }}
          />}
        </div>
        </section>
        {tabsLoaded && readerTabs.map((paperId) => <section key={paperId} role="tabpanel" id={`reader-tab-panel-${paperId}`} className="app-panel reader-tab-panel" data-testid={`reader-tab-panel-${paperId}`} data-paper-id={paperId} hidden={activePanel !== paperId}>
          {readerPapers[paperId] && <Reader paperId={paperId} active={activePanel === paperId} libraryNavigation={readerLibraryNavigation} openRequest={readerOpenRequest?.paperId === paperId ? readerOpenRequest : undefined} />}
        </section>)}
      </div>
      {busy && <div className="busy-indicator" role="status">正在处理</div>}
    </div>
  );
}

function LibraryNavigation({ folderFilter, folders, search, unfiledCount, onSearch, onSelectFilter, onCreateFolder, testIdPrefix = '' }: {
  folderFilter: string;
  folders: Folder[];
  search: string;
  unfiledCount: number | null;
  onSearch: (value: string) => void;
  onSelectFilter: (value: string) => void;
  onCreateFolder: () => void;
  testIdPrefix?: string;
}) {
  return (
    <div className="library-navigation">
      <div className="search-wrap library-sidebar-search"><SearchIcon /><input aria-label="侧栏搜索文献" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索文献" /></div>
      <nav className="library-primary-nav" aria-label="文献导航">
        <button className={folderFilter === 'all' ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid={`${testIdPrefix}folder-nav-all`} onClick={() => onSelectFilter('all')}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6.5 3.5h8l4 4v13h-12v-17Zm8 0v4h4m-8 4h4m-4 4h5" /></svg><span>全部文献</span></button>
        <button className={folderFilter === 'recent' ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid={`${testIdPrefix}folder-nav-recent`} onClick={() => onSelectFilter('recent')}><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg><span>最近阅读</span></button>
        <button className={folderFilter === 'favorites' ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid={`${testIdPrefix}folder-nav-favorites`} onClick={() => onSelectFilter('favorites')}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /></svg><span>收藏文献</span></button>
      </nav>
      <div className="library-category-heading"><div className="sidebar-section-label">分类</div><button className="sidebar-add-folder" type="button" aria-label="新增分类" title="新建文件夹" onClick={onCreateFolder}>+</button></div>
      <nav className="folder-nav" aria-label="文件夹分类">
        <button className={folderFilter === 'unfiled' ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid={`${testIdPrefix}folder-nav-unfiled`} onClick={() => onSelectFilter('unfiled')}><span className="folder-color-mark" aria-hidden="true" /><span className="folder-nav-name">未分类</span>{unfiledCount !== null && <span className="folder-nav-count">{unfiledCount}</span>}</button>
        {folders.map((folder) => <button key={folder.id} aria-label={folder.name} className={folderFilter === folder.id ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid={`${testIdPrefix}folder-nav-${folder.id}`} onClick={() => onSelectFilter(folder.id)}><span className="folder-color-mark" data-testid={`${testIdPrefix}folder-color-${folder.id}`} style={{ backgroundColor: folder.color }} aria-hidden="true" /><span className="folder-nav-name">{folder.name}</span><span className="folder-nav-count">{folder.paper_count}</span></button>)}
      </nav>
    </div>
  );
}


function titleFor(paper: Paper) {
  return paper.chinese_title || paper.english_title || paper.source_name;
}

function SearchIcon() {
  return <svg className="search-icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="7.3" /><path d="m16.2 16.2 4.3 4.3" /></svg>;
}

function FolderDialog({ mode, value, onChange, onClose, onSave }: {
  mode: 'create' | 'rename'; value: string; onChange: (value: string) => void; onClose: () => void; onSave: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="title-dialog folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-heading">
        <div className="dialog-heading"><div><div className="eyebrow">文献归类</div><h2 id="folder-dialog-heading">{mode === 'create' ? '新建文件夹' : '重命名文件夹'}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
        <label htmlFor="folder-name-input">文件夹名称</label>
        <input id="folder-name-input" aria-label="文件夹名称" data-testid="folder-name-input" autoFocus value={value} onChange={(event) => onChange(event.target.value)} maxLength={80} />
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" data-testid="folder-save" disabled={!value.trim()} onClick={onSave}>保存</button></div>
      </section>
    </div>
  );
}

function FeedbackDialog({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: (requiresActivation: boolean) => void }) {
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [failure, setFailure] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingRef.current) return;
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setFailure('请填写反馈内容。');
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setFailure('');
    let requiresActivation: boolean | undefined;
    try {
      const result = await window.workbench.submitFeedback({ message: trimmedMessage, contact: contact.trim() });
      requiresActivation = result.requiresActivation;
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    if (requiresActivation !== undefined) onSubmitted(requiresActivation);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!sending && event.target === event.currentTarget) onClose(); }}>
      <section className="title-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-heading">
        <div className="dialog-heading"><div><div className="eyebrow">意见反馈</div><h2 id="feedback-dialog-heading">告诉我们你的想法</h2></div><button className="icon-button" aria-label="关闭" disabled={sending} onClick={onClose}>×</button></div>
        <form onSubmit={(event) => void send(event)}>
          <label htmlFor="feedback-message">反馈内容</label>
          <textarea id="feedback-message" aria-label="反馈内容" autoFocus required disabled={sending} rows={6} maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="描述遇到的问题或改进建议…" />
          <p className="field-help">反馈通过 FormSubmit 发送给开发者，只包含你填写的内容和 Folio 版本。</p>
          <label htmlFor="feedback-contact">联系方式（选填）</label>
          <input id="feedback-contact" aria-label="联系方式（选填）" disabled={sending} maxLength={200} value={contact} onChange={(event) => setContact(event.target.value)} placeholder="邮箱、QQ 或其他联系方式" />
          {failure && <div className="notice error-notice" role="alert">{failure}</div>}
          <div className="dialog-actions"><button type="button" className="secondary-button" disabled={sending} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={sending || !message.trim()}>{sending ? '正在发送…' : '提交反馈'}</button></div>
        </form>
      </section>
    </div>
  );
}

function TitleDialog({ paper, onClose, onSave }: { paper: Paper; onClose: () => void; onSave: (english: string, chinese: string) => void }) {
  const [english, setEnglish] = useState(paper.english_title);
  const [chinese, setChinese] = useState(paper.chinese_title);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="title-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title-heading">
        <div className="dialog-heading"><div><div className="eyebrow">文献标题</div><h2 id="edit-title-heading">确认或修改标题</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
        {paper.source_language !== 'zh' && <><label htmlFor="english-title">英文标题</label><textarea id="english-title" rows={3} value={english} onChange={(event) => setEnglish(event.target.value)} /></>}
        <label htmlFor="chinese-title">{paper.source_language === 'zh' ? '文献标题' : '中文标题'}</label><input id="chinese-title" value={chinese} onChange={(event) => setChinese(event.target.value)} placeholder={paper.source_language === 'zh' ? '填写文献标题' : '留空时会由免费服务翻译'} />
        <p className="field-help">文献库中的副本会使用中文标题命名，导入时选择的源文件不变。</p>
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onSave(paper.source_language === 'zh' ? chinese : english, chinese)}>保存并继续</button></div>
      </section>
    </div>
  );
}
