import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';

type OcrStatus = { enabled: boolean; language: string; available: boolean; languages: { tag: string; name: string }[]; error?: string };

export function OcrSettings() {
  const [settings, setSettings] = useState<OcrStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void api<OcrStatus>('/settings/ocr').then(value => { if (active) setSettings(value); })
      .catch(reason => { if (active) setFailure(errorMessage(reason)); });
    return () => { active = false; };
  }, []);

  async function update(save: boolean) {
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      const value = await api<OcrStatus>('/settings/ocr', save ? 'PUT' : 'GET', save && settings ? { enabled: settings.enabled, language: settings.language } : undefined);
      setSettings(value);
      setNotice(save ? '本地 OCR 设置已保存。' : 'OCR 状态已刷新。');
    } catch (reason) { setFailure(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  return <section className="settings-card" aria-labelledby="ocr-heading">
    <div><div className="eyebrow">文字识别</div><h2 id="ocr-heading">本地 OCR</h2></div>
    <p className="field-help" role="status">{settings ? settings.available ? 'Windows 本地 OCR 可用。' : settings.error || '本地 OCR 暂不可用，请检查 Windows 识别语言包后刷新状态。' : failure ? '无法读取 OCR 状态。' : '正在读取 OCR 状态…'}</p>
    <p className="field-help">免费、离线识别，仅处理无法提取文字的页面，保留原始 PDF。识别结果可能有误，阅读时请核对原文。</p>
    <label className="field-label"><input type="checkbox" checked={settings?.enabled ?? false} disabled={!settings || busy} onChange={event => setSettings(current => current && { ...current, enabled: event.target.checked })} /> 自动进行本地 OCR</label>
    <label className="field-label" htmlFor="ocr-language">识别语言</label>
    <select id="ocr-language" value={settings?.language || 'auto'} disabled={!settings || busy} onChange={event => setSettings(current => current && { ...current, language: event.target.value })}>
      <option value="auto">自动选择</option>
      {settings?.languages.map(language => <option key={language.tag} value={language.tag}>{language.name}（{language.tag}）</option>)}
      {settings && settings.language !== 'auto' && !settings.languages.some(language => language.tag === settings.language) && <option value={settings.language}>{settings.language}（未安装）</option>}
    </select>
    <div className="update-actions"><button className="secondary-button compact-button" type="button" disabled={!settings || busy} onClick={() => void update(true)}>保存 OCR 设置</button><button className="text-button" type="button" disabled={busy} onClick={() => void update(false)}>刷新状态</button></div>
    {notice && <p className="notice success-notice" role="status">{notice}</p>}
    {failure && <p className="notice error-notice" role="alert">{failure}</p>}
  </section>;
}
