import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage, Folder, Paper, UpdateState } from './api';
import { loadPdfDocument } from './PdfPage';
import { Reader } from './Reader';
import { SettingsPanel } from './SettingsPanel';

const statusText: Record<string, string> = {
  waiting_api: '待继续旧任务', needs_title: '待确认标题', queued: '排队中', translating: 'PDF 版式翻译中',
  checking: '完成检查', completed: '可阅读', needs_ocr: '需要 OCR', needs_attention: '提取不完整',
  error: '处理失败', stopped: '已暂停',
};

const readerTabsKey = 'paper-workbench.reader-tabs.v1';
const themePreferenceKey = 'folio.theme.v1';
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

function readReaderTabs(): { paperIds: string[]; active: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(readerTabsKey) || 'null');
    const paperIds = Array.isArray(saved?.paperIds) ? saved.paperIds.filter((id: unknown) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) : [];
    return { paperIds, active: typeof saved?.active === 'string' ? saved.active : 'library' };
  } catch {
    return { paperIds: [], active: 'library' };
  }
}

export function App() {
  return <Workbench />;
}

function Workbench() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(readThemePreference()));
  const [activePanel, setActivePanel] = useState('library');
  const [readerTabs, setReaderTabs] = useState<string[]>([]);
  const readerTabsRef = useRef(readerTabs);
  readerTabsRef.current = readerTabs;
  const [readerPapers, setReaderPapers] = useState<Record<string, Paper>>({});
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [papers, setPapers] = useState<Paper[]>([]);
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
      const readable = allPapers.filter((paper) => paper.can_read);
      const byId = Object.fromEntries(readable.map((paper) => [paper.id, paper])) as Record<string, Paper>;
      const validTabs = [...new Set(saved.paperIds)].filter((id) => Boolean(byId[id]));
      setReaderPapers(byId);
      setReaderTabs(validTabs);
      setActivePanel(saved.active === 'settings' || saved.active === 'library' || validTabs.includes(saved.active) ? saved.active : 'library');
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

  const refresh = useCallback(async () => {
    try {
      const query = new URLSearchParams({ folder_id: folderFilter });
      if (search) query.set('q', search);
      const [nextPapers, nextFolders] = await Promise.all([
        api<Paper[]>(`/papers?${query.toString()}`),
        api<Folder[]>('/folders'),
      ]);
      setPapers(nextPapers);
      setFolders(nextFolders);
      setReaderPapers((current) => {
        const next = { ...current };
        for (const paper of nextPapers) if (next[paper.id]) next[paper.id] = paper;
        return next;
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [folderFilter, search]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function importFiles(paths: string[]) {
    if (!paths.length) return;
    setBusy(true);
    setNotice('正在导入并检查 PDF…');
    setError('');
    try {
      const folder_id = folderFilter !== 'all' && folderFilter !== 'unfiled' ? folderFilter : null;
      const result = await api<{ results: { duplicate: boolean; paper: Paper }[] }>('/papers/import', 'POST', { paths, folder_id });
      const added = result.results.filter((item) => !item.duplicate).length;
      const duplicates = result.results.length - added;
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

  async function revealFile(paper: Paper) {
    try { await window.workbench.revealPaperFile(paper.id, 'original'); }
    catch (error) { setError(errorMessage(error)); }
  }

  async function openLibraryFolder() {
    try { await window.workbench.openLibraryFolder(); }
    catch (error) { setError(errorMessage(error)); }
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

  function openReader(paper: Paper) {
    if (!paper.can_read) return;
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
        <div className="brand-mark" aria-hidden="true"><img src="./folio-mark.svg" alt="" /></div>
        <div className="brand-wordmark">Folio</div>
        <nav className="app-tab-strip" role="tablist" aria-label="工作台标签">
          <button className={`app-tab library-tab ${activePanel === 'library' ? 'selected' : ''}`} type="button" role="tab" aria-selected={activePanel === 'library'} aria-controls="library-tab-panel" data-testid="library-tab" onClick={() => setActivePanel('library')}>文献库</button>
          {readerTabs.map((paperId) => {
            const paper = readerPapers[paperId];
            if (!paper) return null;
            const title = paper.chinese_title || paper.english_title || paper.source_name;
            return <div className={`reader-tab ${activePanel === paperId ? 'selected' : ''}`} key={paperId}>
              <button className="app-tab reader-tab-title" type="button" role="tab" aria-selected={activePanel === paperId} aria-controls={`reader-tab-panel-${paperId}`} data-testid={`paper-tab-${paperId}`} title={title} onClick={() => setActivePanel(paperId)}>{title}</button>
              <button className="reader-tab-close" type="button" aria-label={`关闭 ${title}`} data-testid={`close-tab-${paperId}`} title="关闭标签" onClick={() => void closeReaderTab(paperId)}>×</button>
            </div>;
          })}
        </nav>
        <button className="topbar-icon-button theme-toggle" type="button" data-testid="theme-toggle" aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}>
          <svg aria-hidden="true" viewBox="0 0 24 24">{theme === 'dark' ? <path d="M20.4 15.7A8.6 8.6 0 0 1 8.3 3.6 8.7 8.7 0 1 0 20.4 15.7Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>}</svg>
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
        <section className="app-panel library-app-panel" id="library-tab-panel" role="tabpanel" hidden={activePanel !== 'library'}>
        <div className="library-workspace">
          <aside className="library-sidebar" data-testid="library-sidebar" aria-label="文献分类">
            <div className="sidebar-section-label">分类</div>
            <div className="folder-nav" aria-label="文件夹分类">
              <button className={folderFilter === 'all' ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid="folder-nav-all" onClick={() => setFolderFilter('all')}>全部文献</button>
              <button className={folderFilter === 'unfiled' ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid="folder-nav-unfiled" onClick={() => setFolderFilter('unfiled')}>未分类</button>
              {folders.map((folder) => <button key={folder.id} aria-label={folder.name} className={folderFilter === folder.id ? 'folder-nav-button selected' : 'folder-nav-button'} data-testid={`folder-nav-${folder.id}`} onClick={() => setFolderFilter(folder.id)}><span className="folder-color-mark" data-testid={`folder-color-${folder.id}`} style={{ backgroundColor: folder.color }} aria-hidden="true" />{folder.name}</button>)}
            </div>
            <div className="folder-actions">
              <button className="text-button" aria-label="新建文件夹" onClick={() => beginFolderDialog('create')}>＋ 新建文件夹</button>
              <button className="text-button" type="button" onClick={() => void openLibraryFolder()}>打开文献目录</button>
              {folderFilter !== 'all' && folderFilter !== 'unfiled' && <>
                <button className="text-button" aria-label="重命名文件夹" onClick={() => beginFolderDialog('rename')}>重命名</button>
                <button className="text-button delete-paper-button" aria-label="删除文件夹" onClick={() => void deleteFolder()}>删除文件夹</button>
              </>}
            </div>
          </aside>
          <main className="library-page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">本机文献与处理进度</div>
              <h1>文献库</h1>
              <p>PDF 原文与译文</p>
            </div>
            <button className="primary-button import-button" onClick={chooseFiles} disabled={busy}>＋ 导入 PDF</button>
          </div>
          <div className="library-toolbar">
            <div className="search-wrap"><span aria-hidden="true">⌕</span><input aria-label="搜索文献" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或原文件名" /></div>
            <span className="paper-count">{papers.length} 篇文献</span>
          </div>
          {notice && <div className="notice success-notice" role="status">{notice}</div>}
          {error && <div className="notice error-notice" role="alert">{error}</div>}
          {papers.length === 0 ? (
            <div className={dragging ? 'empty-state dragging' : 'empty-state'}>
              <div className="empty-icon" aria-hidden="true">PDF</div>
              <h2>{search ? '没有找到匹配的文献' : papers.length === 0 && folderFilter !== 'all' ? '此文件夹还没有文献' : '把论文放进你的工作台'}</h2>
              <p>{search ? '试试更短的标题关键词。' : '选择一个或多个 PDF，也可以把文件拖到这里。'}</p>
              {!search && folderFilter === 'all' && <button className="secondary-button" onClick={chooseFiles} disabled={busy}>选择 PDF 文件</button>}
            </div>
          ) : (
            <section className={dragging ? 'paper-list dragging' : 'paper-list'} aria-label="文献列表">
              {papers.map((paper) => <PaperCard key={paper.id} paper={paper} folders={folders} onOpen={() => openReader(paper)} onAction={(action) => void paperAction(paper, action)} onEdit={() => setEditing(paper)} onDelete={() => void deletePaper(paper)} onReveal={() => void revealFile(paper)} onMove={(folderId) => void movePaper(paper, folderId)} />)}
            </section>
          )}
          {dragging && <div className="drop-overlay" aria-hidden="true"><div>松开即可导入 PDF</div></div>}
          {editing && <TitleDialog paper={editing} onClose={() => setEditing(null)} onSave={(english, chinese) => void saveTitle(editing, english, chinese)} />}
          {folderDialog && <FolderDialog mode={folderDialog} value={folderName} onChange={setFolderName} onClose={() => setFolderDialog(null)} onSave={() => void saveFolder()} />}
        </main>
        </div>
        </section>
        {tabsLoaded && readerTabs.map((paperId) => <section key={paperId} role="tabpanel" id={`reader-tab-panel-${paperId}`} className="app-panel reader-tab-panel" data-testid={`reader-tab-panel-${paperId}`} data-paper-id={paperId} hidden={activePanel !== paperId}>
          {readerPapers[paperId] && <Reader paperId={paperId} active={activePanel === paperId} />}
        </section>)}
      </div>
      {busy && <div className="busy-indicator" role="status">正在处理</div>}
    </div>
  );
}

function PaperCard({ paper, folders, onOpen, onAction, onEdit, onDelete, onReveal, onMove }: {
  paper: Paper; folders: Folder[]; onOpen: () => void; onAction: (action: 'stop' | 'continue' | 'retry') => void; onEdit: () => void; onDelete: () => void; onReveal: () => void; onMove: (folderId: string | null) => void;
}) {
  const progress = paper.pdf_progress || 0;
  const canStop = ['queued', 'translating', 'waiting_api'].includes(paper.status);
  const canContinue = paper.status === 'stopped';
  const canRetry = ['error', 'waiting_api'].includes(paper.status);
  const title = paper.chinese_title || paper.english_title || paper.source_name;
  const folder = folders.find((item) => item.id === paper.folder_id);
  return (
    <article className="paper-card">
      <PaperThumbnail paper={paper} />
      <div className="paper-main">
        <div className="paper-title-row"><h2 title={title}>{title}</h2><span className={`status-pill status-${paper.status}`}>{statusText[paper.status] || paper.status}</span></div>
        {paper.english_title && paper.chinese_title && paper.english_title !== paper.chinese_title && <div className="paper-subtitle">{paper.english_title}</div>}
        <div className="paper-meta">
          <span>{paper.page_count} 页</span>
          <span className="paper-folder-label"><i style={{ backgroundColor: folder?.color || '#8a928d' }} aria-hidden="true" />{folder?.name || '未分类'}</span>
          <span title={paper.source_name}>{paper.source_name}</span>
          <span>{new Date(paper.created_at).toLocaleDateString('zh-CN')}</span>
        </div>
        {paper.status === 'translating' || paper.status === 'queued' || paper.status === 'checking' ? (
          <div className="progress-row"><div className="progress-track"><div className="progress-value" style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div>
        ) : null}
        {paper.error && <p className="paper-error">{paper.error}</p>}
        {paper.diagnostics.length > 0 && <ul className="diagnostics">{paper.diagnostics.map((item) => <li key={item.page}>第 {item.page} 页：{item.status === 'needs_ocr' ? '有图片但没有可提取文字，需 OCR' : '检测到页面内容，但没有提取到正文文字'}</li>)}</ul>}
      </div>
      <div className="paper-actions">
        {paper.can_read && <button className="primary-button compact-button" data-testid={`paper-read-${paper.id}`} onClick={onOpen}>阅读</button>}
        <details className="paper-more-actions">
          <summary>更多</summary>
          <div className="paper-more-menu">
            <label>分类<select aria-label="移动文献到文件夹" data-testid={`paper-folder-${paper.id}`} value={paper.folder_id || ''} onChange={(event) => onMove(event.target.value || null)}>
              <option value="">未分类</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select></label>
            <button className="text-button" onClick={onEdit}>编辑标题</button>
            <button className="text-button" type="button" onClick={onReveal}>打开文件位置</button>
            {canStop && <button className="text-button" onClick={() => onAction('stop')}>暂停</button>}
            {canContinue && <button className="text-button" onClick={() => onAction('continue')}>继续翻译</button>}
            {canRetry && <button className="text-button" onClick={() => onAction('retry')}>重试</button>}
            <button className="text-button delete-paper-button" onClick={onDelete}>删除</button>
          </div>
        </details>
      </div>
    </article>
  );
}

function PaperThumbnail({ paper }: { paper: Paper }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

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
    if (!visible) return;
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
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({ canvas, canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
        await renderTask.promise;
        if (!cancelled) setState('ready');
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
  }, [paper.id, visible]);

  return (
    <div ref={hostRef} className={`paper-thumbnail ${state === 'ready' ? 'loaded' : ''}`} role="img" aria-label={`${titleFor(paper)}首页缩略图`}>
      <canvas ref={canvasRef} aria-hidden="true" />
      {state !== 'ready' && <span>{state === 'error' ? '预览不可用' : '载入首页'}</span>}
    </div>
  );
}

function titleFor(paper: Paper) {
  return paper.chinese_title || paper.english_title || paper.source_name;
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
