import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { api, errorMessage, type Folder, type Paper } from './api';
import type { PdfKind } from './PdfPage';
import { PaperThumbnail } from './PaperThumbnail';

type LiteratureInfo = {
  id: string; paper_id: string | null; authors: { family?: string; given?: string; literal?: string }[];
  year: string | number | null; container_title: string; doi: string;
};
type Props = {
  papers: Paper[]; folders: Folder[]; folderFilter: string; search: string; onSearch: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>; active: boolean; busy: boolean; notice: string; error: string;
  favoritePending: string[]; onChooseFiles: () => void; onOpen: (paper: Paper, kind?: PdfKind) => void;
  onFavorite: (paper: Paper) => void; onEdit: (paper: Paper) => void; onDelete: (paper: Paper) => void;
  onReveal: (paper: Paper, kind?: PdfKind) => void; onMove: (paper: Paper, folderId: string | null) => void;
  onAction: (paper: Paper, action: 'stop' | 'continue' | 'retry') => void; onBibliography: (paper: Paper) => void;
};
const statusText: Record<string, string> = {
  waiting_api: '待继续旧任务', needs_title: '待确认标题', queued: '排队中', translating: 'PDF 版式翻译中',
  checking: '完成检查', completed: '可阅读', needs_ocr: '需要 OCR', needs_attention: '提取不完整', error: '处理失败', stopped: '已暂停',
};
function canOpenPdf(paper: Paper, kind?: PdfKind) {
  if (kind === 'mono') return Boolean(paper.mono_pdf_file_name);
  if (kind === 'dual') return Boolean(paper.dual_pdf_file_name);
  return Boolean(paper.can_read_original || paper.can_read);
}
const pdfNames: [PdfKind, string][] = [['original', '原文 PDF'], ['mono', '中文 PDF'], ['dual', '双语 PDF']];

function DocumentIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6.5 3.5h8l4 4v13h-12v-17Zm8 0v4h4m-8 4h4m-4 4h5" /></svg>;
}
function StarIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /></svg>;
}
function PanelIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M15 4v16" /></svg>;
}
function OpenIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 4h6v6m-9 5 9-9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></svg>;
}
function titleFor(paper: Paper) {
  return paper.english_title && !/^https?:\/\//i.test(paper.english_title) ? paper.english_title : paper.chinese_title || paper.source_name;
}
function authorsFor(info?: LiteratureInfo, full = false) {
  const authors = info?.authors || [];
  if (!authors.length) return '未记录';
  const name = (author: typeof authors[number]) => author.literal || [author.given, author.family].filter(Boolean).join(' ');
  return full ? authors.map(name).join('、') : `${authors[0].family || name(authors[0])}${authors.length > 1 ? ' 等' : ''}`;
}

export function PaperLibrary(props: Props) {
  const { papers, folders, folderFilter, search, onSearch, searchInputRef, active, busy, notice, error, favoritePending, onChooseFiles, onOpen, onFavorite } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [metadata, setMetadata] = useState<Record<string, LiteratureInfo>>({});
  const [metadataError, setMetadataError] = useState('');
  const [metadataRevision, setMetadataRevision] = useState(0);
  const rowsRef = useRef<HTMLDivElement>(null);
  const paperIds = papers.map(paper => paper.id).join(',');
  const selected = papers.find(paper => paper.id === selectedId);
  const showDetails = Boolean(selected && detailsOpen);

  useEffect(() => {
    if (!active || !paperIds) return;
    let current = true;
    void api<{ items: LiteratureInfo[] }>('/literature').then(result => {
      if (!current) return;
      const byPaper: Record<string, LiteratureInfo> = {};
      for (const item of result.items) if (item.paper_id && !byPaper[item.paper_id]) byPaper[item.paper_id] = item;
      setMetadata(byPaper);
      setMetadataError('');
    }).catch(reason => { if (current) setMetadataError(errorMessage(reason)); });
    return () => { current = false; };
  }, [active, paperIds, metadataRevision]);

  function selectPaper(paper: Paper) {
    setSelectedId(paper.id);
    setDetailsOpen(true);
  }
  function rowKeyDown(event: KeyboardEvent<HTMLElement>, paper: Paper) {
    if ((event.target as HTMLElement).closest('button, summary, select, input')) return;
    if (event.key === 'Enter') { event.preventDefault(); onOpen(paper); return; }
    if (event.key === ' ') { event.preventDefault(); selectPaper(paper); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const index = papers.findIndex(item => item.id === paper.id);
    const next = papers[Math.max(0, Math.min(papers.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selectPaper(next);
      rowsRef.current?.querySelector<HTMLElement>(`[data-paper-id="${next.id}"]`)?.focus();
    }
  }
  const filesFor = (paper: Paper) => pdfNames.filter(([kind]) => kind === 'original' || kind === 'mono' && paper.mono_pdf_file_name || kind === 'dual' && paper.dual_pdf_file_name);
  const favoriteButton = (paper: Paper, testId = false) => <button className="paper-favorite-button" type="button" data-testid={testId ? `paper-favorite-${paper.id}` : 'detail-favorite'} aria-label={paper.is_favorite ? '取消收藏' : '收藏文献'} title={paper.is_favorite ? '取消收藏' : '收藏文献'} aria-pressed={paper.is_favorite} disabled={favoritePending.includes(paper.id)} onClick={(event) => { event.stopPropagation(); onFavorite(paper); }}><StarIcon /></button>;
  const heading = folderFilter === 'favorites' ? '收藏文献' : folderFilter === 'recent' ? '最近阅读' : folders.find(folder => folder.id === folderFilter)?.name || '文献库';

  return <div className={`paper-library-shell ${showDetails ? 'with-details' : ''}`}>
    <main className="library-page">
      <div className="page-heading"><div><h1>{heading}</h1><p><span className="paper-count">{papers.length} 篇文献</span></p></div><button className="primary-button import-button" onClick={onChooseFiles} disabled={busy}>＋ 导入 PDF</button></div>
      <div className="library-toolbar">
        <div className="search-wrap library-main-search"><svg className="search-icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="7.3" /><path d="m16.2 16.2 4.3 4.3" /></svg><input ref={searchInputRef} aria-label="搜索文献" value={search} onChange={event => onSearch(event.target.value)} placeholder="搜索标题或原文件名" /></div>
        <span className="library-density-label">紧凑视图</span>
        <button className="library-detail-toggle" type="button" data-testid="library-detail-toggle" aria-label="显示或隐藏文献详情" aria-pressed={showDetails} disabled={!selected} onClick={() => setDetailsOpen(value => !value)}><PanelIcon /></button>
      </div>
      {notice && <div className="notice success-notice" role="status">{notice}</div>}
      {error && <div className="notice error-notice" role="alert">{error}</div>}
      {!papers.length ? <div className="empty-state">
        <div className="empty-icon" aria-hidden="true">PDF</div>
        <h2>{search ? '没有找到匹配的文献' : folderFilter === 'favorites' ? '还没有收藏的文献' : folderFilter === 'recent' ? '还没有最近阅读的文献' : folderFilter !== 'all' ? '此文件夹还没有文献' : '把论文放进你的工作台'}</h2>
        <p>{search ? '试试更短的标题关键词。' : folderFilter === 'favorites' ? '点击文献旁的星标，即可收藏并在这里快速找到。' : folderFilter === 'recent' ? '打开一篇可阅读的文献后，它会显示在这里。' : '选择一个或多个 PDF，也可以把文件拖到这里。'}</p>
        {!search && folderFilter === 'all' && <button className="secondary-button" onClick={onChooseFiles} disabled={busy}>选择 PDF 文件</button>}
      </div> : <section className="paper-list compact-paper-list" role="table" aria-label="文献列表" ref={rowsRef}>
        <div className="paper-list-header" role="row"><span role="columnheader">标题</span><span role="columnheader">创建者</span><span role="columnheader">年份</span><span role="columnheader">操作</span></div>
        {papers.map((paper, index) => <div className="paper-list-group" key={paper.id}>
          <article className={`paper-card ${selectedId === paper.id ? 'selected' : ''}`} role="row" aria-selected={selectedId === paper.id} data-paper-id={paper.id} data-testid={`paper-row-${paper.id}`} tabIndex={selected ? selectedId === paper.id ? 0 : -1 : index === 0 ? 0 : -1}
            onClick={() => selectPaper(paper)} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button, summary, select')) onOpen(paper); }} onKeyDown={event => rowKeyDown(event, paper)}>
            <div className="paper-document-column" role="cell">
              <button className="paper-expand-button" type="button" aria-label={expandedIds.includes(paper.id) ? '收起 PDF 附件' : '展开 PDF 附件'} aria-expanded={expandedIds.includes(paper.id)} onClick={event => { event.stopPropagation(); setExpandedIds(current => current.includes(paper.id) ? current.filter(id => id !== paper.id) : [...current, paper.id]); }}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" /></svg></button>
              <DocumentIcon /><span className="paper-row-title" title={`${titleFor(paper)}\n${paper.source_name}`}>{titleFor(paper)}</span>
              {!paper.can_read && <span className={`paper-row-state status-${paper.status}`} title={paper.error || statusText[paper.status]}>{paper.status === 'translating' ? `翻译 ${paper.pdf_progress}%` : statusText[paper.status] || paper.status}</span>}
            </div>
            <span className="paper-creator-cell" role="cell" title={authorsFor(metadata[paper.id], true)}>{authorsFor(metadata[paper.id])}</span>
            <span className="paper-year-cell" role="cell">{metadata[paper.id]?.year || ''}</span>
            <div className="paper-actions" role="cell">
              <button className="paper-read-button" type="button" data-testid={`paper-read-${paper.id}`} aria-label="阅读" title={canOpenPdf(paper) ? '阅读文献' : statusText[paper.status]} disabled={!canOpenPdf(paper)} onClick={event => { event.stopPropagation(); onOpen(paper); }}><DocumentIcon /></button>
              {favoriteButton(paper, true)}<PaperActions {...props} paper={paper} />
            </div>
          </article>
          {expandedIds.includes(paper.id) && <div className="paper-attachment-rows" role="rowgroup">{filesFor(paper).map(([kind, name]) => <div role="row" key={kind}><button role="cell" type="button" disabled={!canOpenPdf(paper, kind)} onClick={() => onOpen(paper, kind)}><DocumentIcon />{name}<span>{paper.page_count} 页</span></button></div>)}</div>}
        </div>)}
      </section>}
      <div className="library-footer"><span>{papers.length} 篇文献{selected ? ' · 已选 1 篇' : ''}</span><span>单击查看详情，双击阅读</span></div>
    </main>
    {showDetails && selected && <aside className="paper-inspector" aria-label="文献详情" data-testid="paper-inspector">
      <div className="paper-inspector-heading"><DocumentIcon /><span>文献详情</span><button type="button" className="icon-button" aria-label="关闭文献详情" onClick={() => setDetailsOpen(false)}>×</button></div>
      <div className="paper-inspector-scroll">
        <div className="paper-inspector-cover"><PaperThumbnail key={selected.id} paper={selected} /><span>PDF 首页 · {selected.page_count} 页</span></div>
        <div className="paper-inspector-body">
          <div className="paper-detail-kicker"><span>{selected.source_language === 'zh' ? '中文文献' : '研究论文'}</span><span className={`status-${selected.status}`}>{statusText[selected.status] || selected.status}</span></div>
          <h2>{selected.chinese_title || titleFor(selected)}</h2>
          {selected.chinese_title && selected.english_title && selected.chinese_title !== selected.english_title && !/^https?:\/\//i.test(selected.english_title) && <p className="paper-detail-english">{selected.english_title}</p>}
          <div className="paper-detail-actions"><button type="button" className="primary-button" data-testid="detail-read" disabled={!canOpenPdf(selected)} onClick={() => onOpen(selected)}><OpenIcon />阅读 PDF</button>{favoriteButton(selected)}<PaperActions {...props} paper={selected} /></div>
          {selected.error && <p className={selected.status === 'translating' ? 'field-help' : 'paper-detail-error'} role="status">{selected.error}</p>}
          {['queued', 'translating', 'waiting_api'].includes(selected.status) && <button className="secondary-button" type="button" onClick={() => props.onAction(selected, 'stop')}>暂停翻译</button>}
          {selected.status === 'stopped' && <button className="secondary-button" type="button" onClick={() => props.onAction(selected, 'continue')}>继续翻译</button>}
          {['error', 'waiting_api'].includes(selected.status) && <button className="secondary-button" type="button" onClick={() => props.onAction(selected, 'retry')}>重试翻译</button>}
          {['needs_ocr', 'needs_attention'].includes(selected.status) && <button className="secondary-button" type="button" onClick={() => props.onAction(selected, 'retry')}>{selected.source_language === 'zh' ? 'OCR 识别' : 'OCR 后翻译'}</button>}
          {selected.status === 'needs_title' && <button className="secondary-button" type="button" onClick={() => props.onEdit(selected)}>编辑标题</button>}
          {!!selected.ocr_pages?.length && <p className="field-help">已识别 OCR：第 {selected.ocr_pages.join('、')} 页</p>}
          <section className="paper-detail-section"><h3>文献信息</h3>
            {metadataError && <p className="paper-metadata-error">书目信息暂时无法读取。<button type="button" className="text-button" onClick={() => setMetadataRevision(value => value + 1)}>重试</button></p>}
            <dl><dt>作者</dt><dd>{authorsFor(metadata[selected.id], true)}</dd><dt>年份</dt><dd>{metadata[selected.id]?.year || '未记录'}</dd><dt>来源</dt><dd>{metadata[selected.id]?.container_title || '未记录'}</dd><dt>页数</dt><dd>{selected.page_count} 页</dd><dt>分类</dt><dd>{folders.find(folder => folder.id === selected.folder_id)?.name || '未分类'}</dd><dt>DOI</dt><dd>{metadata[selected.id]?.doi || '未记录'}</dd></dl>
            <button className="text-button paper-detail-edit" type="button" onClick={() => props.onBibliography(selected)}>查看或编辑书目信息</button>
          </section>
          <section className="paper-detail-section"><h3>PDF 文件</h3>{filesFor(selected).map(([kind, name]) => <div className="paper-detail-file" key={kind}><button type="button" disabled={!canOpenPdf(selected, kind)} onClick={() => onOpen(selected, kind)}><DocumentIcon /><span>{name}</span><span className="paper-file-pages">{selected.page_count} 页</span></button><button className="icon-button" type="button" aria-label={`定位${name}`} title={`定位${name}`} onClick={() => props.onReveal(selected, kind)}><OpenIcon /></button></div>)}</section>
          {selected.diagnostics.length > 0 && <section className="paper-detail-section"><h3>页面检查</h3><ul className="paper-detail-diagnostics">{selected.diagnostics.map(item => <li key={item.page}>第 {item.page} 页：{item.status === 'needs_ocr' ? '需 OCR' : '提取不完整'}</li>)}</ul></section>}
        </div>
      </div>
    </aside>}
  </div>;
}

function PaperActions({ paper, folders, onEdit, onDelete, onReveal, onMove, onAction, onBibliography }: Props & { paper: Paper }) {
  return <details className="paper-more-actions" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <summary aria-label="更多"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></svg><span className="visually-hidden">更多</span></summary>
    <div className="paper-more-menu"><label>分类<select aria-label="移动文献到文件夹" data-testid={`paper-folder-${paper.id}`} value={paper.folder_id || ''} onChange={event => onMove(paper, event.target.value || null)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
      <button className="text-button" type="button" onClick={() => onEdit(paper)}>编辑标题</button><button className="text-button" type="button" onClick={() => onBibliography(paper)}>书目信息</button><button className="text-button" type="button" onClick={() => onReveal(paper)}>打开文件位置</button>
      {['queued', 'translating', 'waiting_api'].includes(paper.status) && <button className="text-button" type="button" onClick={() => onAction(paper, 'stop')}>暂停</button>}{paper.status === 'stopped' && <button className="text-button" type="button" onClick={() => onAction(paper, 'continue')}>继续翻译</button>}{['error', 'waiting_api'].includes(paper.status) && <button className="text-button" type="button" onClick={() => onAction(paper, 'retry')}>重试</button>}
      {['needs_ocr', 'needs_attention'].includes(paper.status) && <button className="text-button" type="button" onClick={() => onAction(paper, 'retry')}>{paper.source_language === 'zh' ? 'OCR 识别' : 'OCR 后翻译'}</button>}
      <button className="text-button delete-paper-button" type="button" onClick={() => onDelete(paper)}>删除</button>
    </div>
  </details>;
}
