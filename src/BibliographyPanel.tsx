import { useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage, type Folder } from './api';
import './bibliography.css';

type Author = { family?: string; given?: string; literal?: string };
type Record = {
  id: string; paper_id: string | null; title: string; authors: Author[]; year: string | number | null;
  container_title: string; doi: string; url: string; volume?: string; issue?: string; pages?: string; publisher?: string; publisher_place?: string; item_type?: string; missing_fields: string[];
  folder_id?: string | null; version_label?: string; source_citation?: string; csl: { [key: string]: unknown };
  citations?: { [key: string]: CitationPreview & { confirmed?: boolean; stale?: boolean } };
};
type CitationPreview = { style: string; citation_text: string; bibliography_text: string; bibliography_body_text?: string; fingerprint: string; warnings?: string[] };
type Supplement = { source_fingerprint: string; changes: { [key: string]: { current: unknown; incoming: unknown; manual: boolean; fillable: boolean } } };
type Draft = { title: string; authors: string; year: string; container_title: string; doi: string; url: string; volume: string; issue: string; pages: string; publisher: string; publisher_place: string; item_type: string; version_label: string };
const fields: [keyof Draft, string][] = [['title', '题名'], ['year', '年份'], ['container_title', '期刊、会议或论文集'], ['volume', '卷'], ['issue', '期'], ['pages', '页码'], ['publisher', '出版社'], ['publisher_place', '出版地'], ['doi', 'DOI'], ['url', '来源网址'], ['version_label', '版本说明']];
const missingLabels: { [key: string]: string } = { title: '题名', authors: '作者', year: '年份', container_title: '期刊或会议', doi: 'DOI', url: '来源网址' };

export function BibliographyPanel({ onOpenPaper, folders, folderFilter, onSelectFolder, folderActions, onRecordsChanged }: {
  onOpenPaper: (id: string) => void; folders: Folder[]; folderFilter: string; onSelectFolder: (id: string) => void; folderActions?: ReactNode; onRecordsChanged: () => void;
}) {
  const [items, setItems] = useState<Record[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Record | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [citationRecord, setCitationRecord] = useState<Record | null>(null);
  const [citationStyle, setCitationStyle] = useState('gb-t-7714-2015-numeric');
  const [preview, setPreview] = useState<CitationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [citationError, setCitationError] = useState('');
  const [citationNotice, setCitationNotice] = useState('');
  const [supplementRecord, setSupplementRecord] = useState<Record | null>(null);
  const [supplement, setSupplement] = useState<Supplement | null>(null);
  const [supplementFields, setSupplementFields] = useState<string[]>([]);
  const [editionSource, setEditionSource] = useState<Record | null>(null);
  const [editionDoi, setEditionDoi] = useState('');
  const [edition, setEdition] = useState<{ record: { [key: string]: unknown }; source_url: string } | null>(null);
  const [editionPreview, setEditionPreview] = useState<CitationPreview | null>(null);
  const [editionError, setEditionError] = useState('');
  const [doiCorrection, setDoiCorrection] = useState(false);

  useEffect(() => {
    if (!citationRecord) return;
    let active = true;
    setPreview(null); setPreviewBusy(true); setCitationError(''); setCitationNotice('');
    void api<CitationPreview>('/literature/preview', 'POST', { record: citationRecord.csl, style: citationStyle })
      .then(value => { if (active) setPreview(value); })
      .catch(reason => { if (active) setCitationError(errorMessage(reason)); })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [citationRecord, citationStyle]);

  useEffect(() => {
    if (!draft) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) { setDraft(null); setSelected(null); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [!!draft, saving]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      void api<{ items: Record[]; total: number }>(`/literature?q=${encodeURIComponent(query)}&folder_id=${encodeURIComponent(folderFilter)}`)
        .then((value) => { if (active) setItems(value.items); })
        .catch((reason) => { if (active) setError(errorMessage(reason)); })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, folderFilter, revision]);

  function edit(item: Record) {
    setSelected(item);
    setDoiCorrection(false);
    setDraft({ title: item.title || '', authors: (item.authors || []).map((author) => author.literal || [author.family, author.given].filter(Boolean).join(', ')).join('\n'),
      year: item.year ? String(item.year) : '', container_title: item.container_title || '', doi: item.doi || '', url: item.url || '', volume: item.volume || '', issue: item.issue || '', pages: item.pages || '', publisher: item.publisher || '', publisher_place: item.publisher_place || '', item_type: item.item_type || 'article', version_label: item.version_label || '' });
    setNotice('');
    setError('');
  }

  async function save() {
    if (!draft || !selected) return;
    setSaving(true);
    setError('');
    try {
      if (normalizeDoi(selected.doi) && normalizeDoi(draft.doi) && normalizeDoi(selected.doi) !== normalizeDoi(draft.doi) && !doiCorrection) throw new Error('不同出版版本请使用“添加其他版本”。若仅纠正当前版本的 DOI，请勾选纠错说明。');
      const authors = draft.authors.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const existing = selected.authors.find(author => (author.literal || [author.family, author.given].filter(Boolean).join(', ')) === line);
        if (existing) return existing;
        const [family, ...given] = line.split(',');
        return { family: family.trim(), given: given.join(',').trim() };
      });
      await api(`/literature/${selected.id}`, 'PATCH', { ...draft, year: draft.year.trim() || null, authors });
      setNotice('书目信息已保存，请重新预览并确认引用后在 Word 中刷新。');
      setSelected(null);
      setDraft(null);
      setRevision((value) => value + 1);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  async function move(item: Record, folderId: string) {
    setError(''); setSaving(true);
    try {
      await api(`/literature/${item.id}`, 'PATCH', { folder_id: folderId || null });
      setRevision(value => value + 1); onRecordsChanged();
      setNotice(item.paper_id ? '书目与关联文献的分类已同步。' : '书目分类已更新。');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  async function confirmCitation() {
    if (!citationRecord || !preview) return;
    setSaving(true); setCitationError('');
    try {
      await api(`/literature/${citationRecord.id}/citations`, 'POST', { style: citationStyle, fingerprint: preview.fingerprint });
      setRevision(value => value + 1); setCitationNotice('已确认并保存，可在 Word 中插入。');
    } catch (reason) { setCitationError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  async function findSupplement(item: Record) {
    setError(''); setSaving(true);
    try {
      const proposal = await api<Supplement>(`/literature/${item.id}/supplement/preview`, 'POST', {});
      setSupplementRecord(item); setSupplement(proposal);
      setSupplementFields(Object.keys(proposal.changes).filter(key => proposal.changes[key].fillable));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  async function applySupplement() {
    if (!supplementRecord || !supplement) return;
    setError(''); setSaving(true);
    try {
      await api(`/literature/${supplementRecord.id}/supplement/apply`, 'POST', { fields: supplementFields, source_fingerprint: supplement.source_fingerprint });
      setSupplementRecord(null); setSupplement(null); setRevision(value => value + 1);
      setNotice('已补全选中的空白字段，请检查并重新确认引用。');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  async function resolveEdition() {
    setSaving(true); setEditionError(''); setEdition(null); setEditionPreview(null);
    try {
      const resolved = await api<{ record: { [key: string]: unknown }; source_url: string }>('/literature/resolve', 'POST', { doi: editionDoi.trim() });
      if (normalizeDoi(String(resolved.record.DOI || '')) === normalizeDoi(editionSource?.doi || '')) throw new Error('这是当前版本的 DOI，请使用补全信息。');
      const rendered = await api<CitationPreview>('/literature/preview', 'POST', { record: resolved.record, style: 'gb-t-7714-2015-numeric' });
      setEdition(resolved); setEditionPreview(rendered);
    } catch (reason) { setEditionError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  async function saveEdition() {
    if (!edition || !editionSource) return;
    setSaving(true); setEditionError('');
    try {
      const captured = await api<{ duplicate_record: boolean }>('/literature/capture', 'POST', { csl: edition.record, folder_id: editionSource.folder_id || null, source_url: edition.source_url, version_label: '其他出版版本' });
      setEditionSource(null); setEdition(null); setEditionPreview(null); setRevision(value => value + 1);
      setNotice(captured.duplicate_record ? '此版本已存在，原有书目保留。请在书目列表查看并确认引用。' : '已单独收藏其他版本，原有书目保留。请打开新书目的引用预览确认。');
    } catch (reason) { setEditionError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  return <div className="bibliography-workspace"><aside className="library-sidebar bibliography-sidebar" aria-label="书目分类">
    <h2>书目分类</h2>
    {[{ id: 'all', name: '全部书目' }, { id: 'unfiled', name: '未分类' }, ...folders].map(folder => <button className={`bibliography-folder ${folderFilter === folder.id ? 'selected' : ''}`} type="button" key={folder.id} aria-pressed={folderFilter === folder.id} onClick={() => onSelectFolder(folder.id)}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6h6l2 2h9v12h-17Z" /></svg><span>{folder.name}</span>
    </button>)}
    <div className="folder-actions">{folderActions}</div>
  </aside><section className="settings-panel bibliography-panel">
    <div className="page-heading"><div><div className="eyebrow">收藏与引用</div><h1>书目信息</h1>
      <p>按文献库文件夹管理书目，确认引用后可在 Word 中选择并插入。</p></div></div>
    <p className="field-help">引用排版由 <button className="text-button" type="button" onClick={() => { void window.workbench.openExternal('https://github.com/Juris-M/citeproc-js').catch(reason => setError(errorMessage(reason))); }}>citeproc-js · Frank Bennett</button> 提供。</p>
    <div className="bibliography-toolbar"><input aria-label="搜索书目" placeholder="搜索题名、作者或 DOI" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="secondary-button" type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading}>刷新</button></div>
    {error && !draft && !supplementRecord && <p className="form-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在读取书目…</p>}
    {!loading && !items.length && !error && <div className="settings-card"><h2>尚无收藏书目</h2><p>打开 Folio 后，从 Chrome 或 Edge 的 Folio 插件收藏论文，扩展会自动连接。</p></div>}
    <div className="bibliography-list">{items.map((item) => <article className="settings-card bibliography-item" key={item.id}>
      <div><h2>{item.title || '未填写题名'}</h2><p>{(item.authors || []).map((author) => author.literal || [author.given, author.family].filter(Boolean).join(' ')).join(' · ') || '未填写作者'}{item.year ? ` · ${item.year}` : ''}</p>
        {item.container_title && <p>{item.container_title}</p>}{item.doi && <p className="bibliography-doi">DOI: {item.doi}</p>}
        {item.version_label && <p className="field-help">版本：{item.version_label}</p>}
        <p className="field-help">{Object.values(item.citations || {}).some(citation => citation.confirmed && !citation.stale) ? '已有确认引用' : '引用待确认'}{Object.values(item.citations || {}).some(citation => citation.stale) ? ' · 书目信息已变更，请重新确认' : ''}</p>
        {!!item.missing_fields?.length && <p className="field-help">待补充：{item.missing_fields.map((field) => missingLabels[field] || field).join('、')}</p>}
        {!item.paper_id && <p className="field-help">已收藏书目信息，尚未关联 PDF。</p>}</div>
      <div className="bibliography-item-actions"><label className="bibliography-folder-picker">分类<select aria-label={`移动书目：${item.title}`} value={item.folder_id || ''} disabled={saving} onChange={event => void move(item, event.target.value)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <button className="primary-button compact-button" type="button" onClick={() => { setCitationNotice(''); setCitationRecord(item); }}>引用</button>
        <button className="secondary-button compact-button" type="button" disabled={saving || !item.doi} onClick={() => void findSupplement(item)}>补全信息</button>
        <button className="secondary-button compact-button" type="button" onClick={() => edit(item)}>编辑信息</button>
        <button className="text-button" type="button" onClick={() => { setEditionSource(item); setEditionDoi(''); setEdition(null); setEditionPreview(null); setEditionError(''); }}>添加其他版本</button>
        {item.paper_id && <button className="primary-button compact-button" type="button" onClick={() => onOpenPaper(item.paper_id!)}>打开 PDF</button>}</div>
    </article>)}</div>
    {draft && selected && <div className="dialog-backdrop" onClick={() => { if (!saving) { setDraft(null); setSelected(null); } }}>
      <section className="title-dialog bibliography-editor" role="dialog" aria-modal="true" aria-labelledby="bibliography-edit-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="bibliography-edit-title">编辑书目信息</h2><p className="field-help">字段可留空，请按论文实际信息填写。</p>
        {fields.map(([field, label]) => <label className="field-label" key={field}>{label}<input value={draft[field]} maxLength={field === 'title' ? 1000 : 2000} onChange={(event) => { setDraft({ ...draft, [field]: event.target.value }); if (field === 'doi') setDoiCorrection(false); }} /></label>)}
        {!!normalizeDoi(selected.doi) && !!normalizeDoi(draft.doi) && normalizeDoi(selected.doi) !== normalizeDoi(draft.doi) && <label className="supplement-field"><input type="checkbox" checked={doiCorrection} onChange={event => setDoiCorrection(event.target.checked)} /><span>仅纠正当前版本的 DOI。不同出版版本请另建书目。</span></label>}
        <label className="field-label">文献类型<select aria-label="文献类型" value={draft.item_type} onChange={(event) => setDraft({ ...draft, item_type: event.target.value })}>
          <option value="article">预印本或其他文档</option><option value="journal-article">期刊论文</option><option value="paper-conference">会议论文</option><option value="book">书籍</option><option value="chapter">书籍章节</option><option value="report">报告</option>
        </select></label>
        <label className="field-label">作者<textarea rows={4} aria-label="书目作者" value={draft.authors} onChange={(event) => setDraft({ ...draft, authors: event.target.value })} placeholder={'每行一位作者：姓, 名\n中文作者可直接填写姓名'} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="bibliography-item-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => { setDraft(null); setSelected(null); }}>取消</button>
          <button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div>
      </section>
    </div>}
    {citationRecord && <div className="dialog-backdrop"><section className="title-dialog bibliography-editor" role="dialog" aria-modal="true" aria-labelledby="citation-preview-title">
      <h2 id="citation-preview-title">引用预览</h2><p>{citationRecord.title}</p>
      <label className="field-label">引用格式<select aria-label="引用格式" disabled={saving} value={citationStyle} onChange={event => setCitationStyle(event.target.value)}><option value="gb-t-7714-2015-numeric">GB/T 7714-2015</option><option value="apa">APA 7</option></select></label>
      {previewBusy && <p role="status">正在生成引用…</p>}
      {preview && <><h3>正文引用</h3><p className="citation-preview-text">{preview.citation_text}</p><h3>参考文献</h3><p className="citation-preview-text">{preview.bibliography_text}</p>
        {preview.warnings?.map(warning => <p className="form-error" key={warning}>{warning}</p>)}</>}
      {citationRecord.source_citation && <details><summary>网站提供的原始引用</summary><p className="citation-preview-text">{citationRecord.source_citation}</p></details>}
      {!!citationRecord.missing_fields?.length && <p className="field-help">待补充：{citationRecord.missing_fields.map(field => missingLabels[field] || field).join('、')}。请核对文献版本和出版信息。</p>}
      {citationError && <p className="form-error" role="alert">{citationError}</p>}{citationNotice && <p role="status">{citationNotice}</p>}
      <div className="bibliography-item-actions"><button className="secondary-button" disabled={saving} onClick={() => setCitationRecord(null)}>关闭</button>
        <button className="secondary-button" disabled={!preview || previewBusy} onClick={() => { void navigator.clipboard.writeText(preview!.bibliography_body_text || preview!.bibliography_text).then(() => setCitationNotice('引用已复制。')).catch(reason => setCitationError(errorMessage(reason))); }}>复制参考文献</button>
        <button className="primary-button" disabled={!preview || previewBusy || saving} onClick={() => void confirmCitation()}>{saving ? '保存中…' : '确认并保存引用'}</button></div>
    </section></div>}
    {supplementRecord && supplement && <div className="dialog-backdrop"><section className="title-dialog bibliography-editor" role="dialog" aria-modal="true" aria-labelledby="supplement-title">
      <h2 id="supplement-title">补全书目信息</h2><p>{supplementRecord.title}</p><p className="field-help">仅填充选中的空白字段；已有内容和手动修改不会被覆盖，不自动切换文献版本。</p>
      {Object.keys(supplement.changes).length === 0 && <p>没有可补全的信息。预印本不一定提供期刊、卷期或页码。</p>}
      {Object.entries(supplement.changes).map(([key, change]) => <label className="supplement-field" key={key}><input type="checkbox" checked={supplementFields.includes(key)} disabled={!change.fillable || saving} onChange={event => setSupplementFields(values => event.target.checked ? [...values, key] : values.filter(value => value !== key))} /><span><strong>{fields.find(([field]) => field === key)?.[1] || missingLabels[key] || key}</strong><span>当前：{formatMetadata(change.current)}</span><span>来源：{formatMetadata(change.incoming)}{change.manual ? '（保留手动修改）' : ''}</span></span></label>)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="bibliography-item-actions"><button className="secondary-button" disabled={saving} onClick={() => { setSupplementRecord(null); setSupplement(null); }}>取消</button><button className="primary-button" disabled={saving || !supplementFields.length} onClick={() => void applySupplement()}>补全所选字段</button></div>
    </section></div>}
    {editionSource && <div className="dialog-backdrop"><section className="title-dialog bibliography-editor" role="dialog" aria-modal="true" aria-labelledby="edition-title">
      <h2 id="edition-title">添加其他版本</h2><p>{editionSource.title}</p><p className="field-help">粘贴正式出版版或其他版本的 DOI，核对后另建书目。原有版本和引用会保留。</p>
      <label className="field-label">其他版本 DOI<input aria-label="其他版本 DOI" value={editionDoi} disabled={saving} onChange={event => { setEditionDoi(event.target.value); setEdition(null); setEditionPreview(null); }} /></label>
      <button className="secondary-button" disabled={saving || !editionDoi.trim()} onClick={() => void resolveEdition()}>{saving ? '处理中…' : '读取出版信息'}</button>
      {edition && <><h3>{String(edition.record.title || '')}</h3><p>DOI：{String(edition.record.DOI || '')}</p><p className="citation-preview-text">{editionPreview?.bibliography_text}</p><p className="field-help">请核对题名、作者和出版版本是否对应。收藏后可继续编辑与确认引用。</p></>}
      {editionError && <p className="form-error" role="alert">{editionError}</p>}
      <div className="bibliography-item-actions"><button className="secondary-button" disabled={saving} onClick={() => setEditionSource(null)}>取消</button><button className="primary-button" disabled={saving || !edition} onClick={() => void saveEdition()}>单独收藏此版本</button></div>
    </section></div>}
  </section></div>;
}

function formatMetadata(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' && item ? Object.values(item).join(' ') : String(item)).join('；');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function normalizeDoi(value: string): string {
  return value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').replace(/[.,;\s]+$/, '').toLowerCase();
}
