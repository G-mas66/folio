import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import './bibliography.css';

type Author = { family: string; given?: string };
type Record = {
  id: string; paper_id: string | null; title: string; authors: Author[]; year: string | number | null;
  container_title: string; doi: string; url: string; volume?: string; issue?: string; pages?: string; item_type?: string; missing_fields: string[];
};
type Draft = { title: string; authors: string; year: string; container_title: string; doi: string; url: string; volume: string; issue: string; pages: string; item_type: string };
const fields: [keyof Draft, string][] = [['title', '题名'], ['year', '年份'], ['container_title', '期刊或会议'], ['volume', '卷'], ['issue', '期'], ['pages', '页码'], ['doi', 'DOI'], ['url', '来源网址']];
const missingLabels: { [key: string]: string } = { title: '题名', authors: '作者', year: '年份', container_title: '期刊或会议', doi: 'DOI', url: '来源网址' };

export function BibliographyPanel({ onOpenPaper }: { onOpenPaper: (id: string) => void }) {
  const [items, setItems] = useState<Record[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Record | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

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
      void api<{ items: Record[]; total: number }>(`/literature?q=${encodeURIComponent(query)}`)
        .then((value) => { if (active) setItems(value.items); })
        .catch((reason) => { if (active) setError(errorMessage(reason)); })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, revision]);

  function edit(item: Record) {
    setSelected(item);
    setDraft({ title: item.title || '', authors: (item.authors || []).map((author) => [author.family, author.given].filter(Boolean).join(', ')).join('\n'),
      year: item.year ? String(item.year) : '', container_title: item.container_title || '', doi: item.doi || '', url: item.url || '', volume: item.volume || '', issue: item.issue || '', pages: item.pages || '', item_type: item.item_type || 'article' });
    setNotice('');
    setError('');
  }

  async function save() {
    if (!draft || !selected) return;
    setSaving(true);
    setError('');
    try {
      const authors = draft.authors.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const [family, ...given] = line.split(',');
        return { family: family.trim(), given: given.join(',').trim() };
      });
      await api(`/literature/${selected.id}`, 'PATCH', { ...draft, year: draft.year.trim() || null, authors });
      setNotice('书目信息已保存。在 Word 中点击刷新可更新引用。');
      setSelected(null);
      setDraft(null);
      setRevision((value) => value + 1);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  return <section className="settings-panel bibliography-panel">
    <div className="page-heading"><div><div className="eyebrow">收藏与引用</div><h1>书目信息</h1>
      <p>管理浏览器收藏的论文，补充信息后可在 Word 中引用。普通 PDF 阅读不需要填写这些字段。</p></div></div>
    <div className="bibliography-toolbar"><input aria-label="搜索书目" placeholder="搜索题名、作者或 DOI" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="secondary-button" type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading}>刷新</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在读取书目…</p>}
    {!loading && !items.length && !error && <div className="settings-card"><h2>尚无收藏书目</h2><p>从 Chrome 或 Edge 的 Folio 插件保存论文。插件配对凭证在设置中获取。</p></div>}
    <div className="bibliography-list">{items.map((item) => <article className="settings-card bibliography-item" key={item.id}>
      <div><h2>{item.title || '未填写题名'}</h2><p>{(item.authors || []).map((author) => [author.given, author.family].filter(Boolean).join(' ')).join(' · ') || '未填写作者'}{item.year ? ` · ${item.year}` : ''}</p>
        {item.container_title && <p>{item.container_title}</p>}{item.doi && <p className="bibliography-doi">DOI: {item.doi}</p>}
        {!!item.missing_fields?.length && <p className="field-help">待补充：{item.missing_fields.map((field) => missingLabels[field] || field).join('、')}</p>}
        {!item.paper_id && <p className="field-help">已收藏书目信息，尚未关联 PDF。</p>}</div>
      <div className="bibliography-item-actions"><button className="secondary-button compact-button" type="button" onClick={() => edit(item)}>编辑信息</button>
        {item.paper_id && <button className="primary-button compact-button" type="button" onClick={() => onOpenPaper(item.paper_id!)}>打开 PDF</button>}</div>
    </article>)}</div>
    {draft && selected && <div className="dialog-backdrop" onClick={() => { if (!saving) { setDraft(null); setSelected(null); } }}>
      <section className="title-dialog bibliography-editor" role="dialog" aria-modal="true" aria-labelledby="bibliography-edit-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="bibliography-edit-title">编辑书目信息</h2><p className="field-help">字段可留空，请按论文实际信息填写。</p>
        {fields.map(([field, label]) => <label className="field-label" key={field}>{label}<input value={draft[field]} maxLength={field === 'title' ? 1000 : 2000} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} /></label>)}
        <label className="field-label">文献类型<select aria-label="文献类型" value={draft.item_type} onChange={(event) => setDraft({ ...draft, item_type: event.target.value })}>
          <option value="article">其他文档</option><option value="journal-article">期刊论文</option><option value="paper-conference">会议论文</option><option value="book">书籍</option><option value="report">报告</option>
        </select></label>
        <label className="field-label">作者<textarea rows={4} aria-label="书目作者" value={draft.authors} onChange={(event) => setDraft({ ...draft, authors: event.target.value })} placeholder={'每行一位作者：姓, 名\n中文作者可直接填写姓名'} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="bibliography-item-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => { setDraft(null); setSelected(null); }}>取消</button>
          <button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div>
      </section>
    </div>}
  </section>;
}
