import { useEffect, useState } from 'react';
import { api, errorMessage, StorageLocationInfo, StorageMigrationProgress } from './api';

type Settings = {
  base_url: string;
  models_url: string;
  model: string;
  model_options: string[];
  key_configured: boolean;
  api_tokens: number | null;
};

const emptySettings: Settings = { base_url: '', models_url: '', model: '', model_options: [], key_configured: false, api_tokens: null };

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [apiKey, setApiKey] = useState('');
  const [customModelsUrlEnabled, setCustomModelsUrlEnabled] = useState(false);
  const [manualModel, setManualModel] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [selectedDiscovered, setSelectedDiscovered] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [storageLocation, setStorageLocation] = useState<StorageLocationInfo | null>(null);
  const [storageTarget, setStorageTarget] = useState<string | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageStatus, setStorageStatus] = useState('');
  const [storageFailure, setStorageFailure] = useState('');

  useEffect(() => {
    let active = true;
    api<Settings>('/settings')
      .then((value) => { if (active) setSettings(value); })
      .catch((error) => { if (active) setFailure(errorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void window.workbench.getAppInfo().then((value) => { if (active) setStorageLocation(value); })
      .catch((error) => { if (active) setStorageFailure(errorMessage(error)); });
    const unsubscribe = window.workbench.onStorageMigrationProgress((progress) => {
      if (!active) return;
      setStorageStatus(storageProgressText(progress));
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  async function save() {
    setBusy(true);
    setNotice('');
    setFailure('');
    try {
      await api('/settings', 'PUT', { base_url: settings.base_url, models_url: settings.models_url, model: settings.model, api_key: apiKey });
      setApiKey('');
      const next = await api<Settings>('/settings');
      setSettings(next);
      setNotice('AI 服务设置已保存。');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice('正在测试连接…');
    setFailure('');
    try {
      await api('/settings', 'PUT', { base_url: settings.base_url, models_url: settings.models_url, model: settings.model, api_key: apiKey });
      setApiKey('');
      setSettings(await api<Settings>('/settings'));
      await api('/settings/test', 'POST');
      setNotice('AI 服务连接成功，服务已返回有效文本。');
    } catch (error) {
      setNotice('');
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function discoverModels() {
    const useCustomUrl = customModelsUrlEnabled && settings.models_url.trim();
    if ((!settings.base_url.trim() && !useCustomUrl) || discovering || busy) return;
    setDiscovering(true);
    setNotice('正在读取模型列表…');
    setFailure('');
    try {
      const result = await api<{ models: string[] }>('/settings/models/discover', 'POST', {
        base_url: settings.base_url,
        ...(useCustomUrl ? { models_url: settings.models_url } : {}),
        api_key: apiKey,
      });
      setDiscovered(result.models);
      setSelectedDiscovered([]);
      setNotice(`读取到 ${result.models.length} 个模型；请选择要添加的项目。`);
    } catch (error) {
      setNotice('');
      setFailure(errorMessage(error));
    } finally {
      setDiscovering(false);
    }
  }

  async function saveModelOptions(models: string[]) {
    const result = await api<{ models: string[] }>('/settings/models', 'PUT', { models });
    setSettings((current) => ({ ...current, model_options: result.models }));
  }

  async function addManualModel() {
    const model = manualModel.trim();
    if (!model || busy) return;
    setBusy(true);
    setFailure('');
    try {
      await saveModelOptions([...settings.model_options, model]);
      setManualModel('');
      setNotice('模型已添加到常用列表。');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function addSelectedModels() {
    if (!selectedDiscovered.length || busy) return;
    setBusy(true);
    setFailure('');
    try {
      await saveModelOptions([...settings.model_options, ...selectedDiscovered]);
      setSelectedDiscovered([]);
      setNotice('所选模型已添加到常用列表。');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeModel(model: string) {
    setBusy(true);
    setFailure('');
    try {
      await saveModelOptions(settings.model_options.filter((item) => item !== model));
      setNotice('模型已从常用列表移除。');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseStorageLocation() {
    setStorageFailure('');
    try {
      const target = await window.workbench.chooseStorageLocation();
      if (target) {
        setStorageTarget(target);
        setStorageStatus('');
      }
    } catch (error) {
      setStorageFailure(errorMessage(error));
    }
  }

  async function migrateStorageLocation() {
    if (!storageTarget || storageBusy) return;
    setStorageBusy(true);
    setStorageFailure('');
    setStorageStatus('正在停止任务并准备迁移…');
    try {
      await window.workbench.migrateStorageLocation({ target: storageTarget });
      setStorageStatus('迁移完成，应用正在重启…');
    } catch (error) {
      setStorageFailure(errorMessage(error));
      setStorageStatus('');
      setStorageBusy(false);
    }
  }

  return (
    <section className="settings-panel">
      <div className="page-heading">
        <div>
          <div className="eyebrow">偏好设置</div>
          <h1>AI 问答与总结</h1>
          <p>此处 AI 配置仅用于原文问答和全文总结；文献翻译由免费翻译服务处理，不需要此处的 API Key。</p>
        </div>
      </div>
      <div className="settings-card">
        <label className="field-label" htmlFor="base-url">AI API URL</label>
        <input id="base-url" disabled={loading || busy} value={settings.base_url} onChange={(e) => { setSettings({ ...settings, base_url: e.target.value }); setCustomModelsUrlEnabled(false); }} placeholder="粘贴服务商提供的完整 URL" />
        <div className="model-discovery-actions">
          <span className="field-help">从当前 API URL 查找模型；使用本次输入的 Key，留空时复用已保存 Key，无 Key 时会尝试匿名查询。临时 Key 不保存，也不会改动聊天请求地址。</span>
          <button className="secondary-button compact-button" type="button" onClick={() => void discoverModels()} disabled={loading || busy || discovering || !settings.base_url.trim() && !(customModelsUrlEnabled && settings.models_url.trim())}>
            {discovering ? '读取中…' : '获取模型列表'}
          </button>
        </div>
        <details className="advanced-model-url">
          <summary>高级：自定义模型列表地址</summary>
          <label className="custom-model-url-toggle"><input type="checkbox" aria-label="使用自定义模型列表地址" checked={customModelsUrlEnabled} onChange={(event) => setCustomModelsUrlEnabled(event.target.checked)} />使用自定义地址查询</label>
          <label className="field-label" htmlFor="models-url">模型列表地址</label>
          <input id="models-url" aria-label="模型列表地址" disabled={loading || busy} value={settings.models_url} onChange={(e) => { setSettings({ ...settings, models_url: e.target.value }); setCustomModelsUrlEnabled(Boolean(e.target.value.trim())); }} placeholder="留空时根据 AI API URL 自动推导" />
          <span className="field-help">适用于服务商使用不同的模型列表地址。此地址只用于获取模型，不会覆盖 AI API URL。</span>
        </details>

        <label className="field-label" htmlFor="model">默认模型名称</label>
        <input id="model" disabled={loading || busy} value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="服务方提供的模型 ID" />

        <label className="field-label" htmlFor="api-key">AI API Key</label>
        <input id="api-key" disabled={loading || busy} type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={settings.key_configured ? '已安全保存；留空可保留当前 Key' : '粘贴服务方提供的 API Key'} />
        <span className="field-help">仅用于 AI 问答和总结；保存在 Windows 凭据管理器中，不用于文献翻译，也不会回读显示。读取模型列表时使用本次输入的 Key，留空时复用已保存 Key；临时 Key 不会保存。</span>

        <div className="settings-actions">
          <button className="primary-button" onClick={save} disabled={busy || loading}>{loading ? '读取中…' : busy ? '处理中…' : '保存设置'}</button>
          <button className="secondary-button" onClick={test} disabled={busy || loading || !settings.key_configured && !apiKey}>{loading ? '读取中…' : '保存并测试连接'}</button>
          <span className={settings.key_configured ? 'connected-state' : 'muted-state'}>{loading ? '正在读取已保存设置…' : settings.key_configured ? 'AI 凭据已保存' : '尚未配置 AI API Key'}</span>
        </div>

        <div className="model-list-settings">
          <label className="field-label" htmlFor="manual-model">添加模型</label>
          <div className="model-manual-add">
            <input id="manual-model" aria-label="添加模型" disabled={loading || busy} value={manualModel} onChange={(e) => setManualModel(e.target.value)} placeholder="手动输入模型 ID" />
            <button className="secondary-button compact-button" type="button" onClick={() => void addManualModel()} disabled={loading || busy || !manualModel.trim()}>手动添加</button>
          </div>
          {settings.model_options.length > 0 && <div className="saved-model-list" aria-label="常用模型列表">
            {settings.model_options.map((model) => <div className="saved-model-row" key={model}><span>{model}</span><button type="button" className="text-button" aria-label={`移除模型 ${model}`} disabled={busy} onClick={() => void removeModel(model)}>移除</button></div>)}
          </div>}
          {discovered.length > 0 && <div className="discovered-models" aria-label="可添加模型列表">
            <div className="field-help">选择后点击“添加所选模型”；读取不会自动保存这些模型。</div>
            {discovered.map((model) => <label className="discovered-model-row" key={model}><input type="checkbox" aria-label={model} checked={selectedDiscovered.includes(model)} onChange={(event) => setSelectedDiscovered((current) => event.target.checked ? [...current, model] : current.filter((item) => item !== model))} /><span>{model}</span></label>)}
            <button className="secondary-button compact-button" type="button" onClick={() => void addSelectedModels()} disabled={busy || selectedDiscovered.length === 0}>添加所选模型</button>
          </div>}
        </div>
        {notice && <div className="notice success-notice" role="status">{notice}</div>}
        {failure && <div className="notice error-notice" role="alert">{failure}</div>}
      </div>
      <section className="settings-card storage-location-card" aria-labelledby="storage-location-heading">
        <div>
          <div className="eyebrow">本机数据</div>
          <h2 id="storage-location-heading">文献存储位置</h2>
          <p className="field-help">更改后，应用会复制并校验文献数据，再重启切换位置；原目录会保留作备份。</p>
        </div>
        <div className="storage-location-current">
          <span className="field-label">当前文献存储位置</span>
          <code data-testid="storage-location-path" aria-label="当前文献存储位置">{storageLocation?.dataRoot || '正在读取…'}</code>
          <button className="secondary-button compact-button" type="button" data-testid="choose-storage-location" onClick={() => void chooseStorageLocation()} disabled={!storageLocation || storageBusy}>更改存储位置…</button>
        </div>
        {storageTarget && <div className="dialog-backdrop storage-migration-backdrop">
          <div className="title-dialog storage-migration-dialog" data-testid="storage-migration-dialog" role="dialog" aria-modal="true" aria-labelledby="storage-migration-heading">
            <h3 id="storage-migration-heading">确认迁移文献数据</h3>
            <div className="storage-migration-paths">
              <div><span className="field-label">当前文献存储位置</span><code>{storageLocation?.dataRoot}</code></div>
              <div><span className="field-label">迁移至</span><code data-testid="storage-migration-target">{storageTarget}</code></div>
            </div>
            <p>目标文件夹必须为空。数据库、PDF、聊天、笔记、批注和分类会复制并逐文件校验。成功后应用将重启；当前目录会保留，不会删除。</p>
            {storageStatus && <div data-testid="storage-migration-status" className="storage-migration-status" role="status">{storageStatus}</div>}
            {storageFailure && <div data-testid="storage-migration-error" className="notice error-notice" role="alert">{storageFailure}</div>}
            <div className="settings-actions storage-migration-actions">
              <button className="text-button" type="button" disabled={storageBusy} onClick={() => { setStorageTarget(null); setStorageStatus(''); setStorageFailure(''); }}>取消迁移</button>
              <button className="primary-button" type="button" disabled={storageBusy} onClick={() => void migrateStorageLocation()}>{storageBusy ? '正在迁移…' : '确认迁移并重启'}</button>
            </div>
          </div>
        </div>}
        {!storageTarget && storageFailure && <div data-testid="storage-migration-error" className="notice error-notice" role="alert">{storageFailure}</div>}
      </section>
      <div className="privacy-card">
        <h2>数据与隐私</h2>
        <p>免费翻译服务会接收论文标题和可提取的正文段落；AI 问答与总结会把相关英文原文发送到你配置的服务。论文文件、译文、阅读进度和聊天记录保存在本机。</p>
        <p>AI 服务累计用量：{settings.api_tokens == null ? '服务未返回用量信息' : `${settings.api_tokens.toLocaleString()} tokens`}</p>
      </div>
    </section>
  );
}

function storageProgressText(progress: StorageMigrationProgress) {
  if (progress.phase === 'stopping') return '正在停止任务并准备迁移…';
  if (progress.phase === 'complete') return '迁移完成，应用正在重启…';
  const copied = (progress.copiedBytes / (1024 * 1024)).toFixed(1);
  const total = (progress.totalBytes / (1024 * 1024)).toFixed(1);
  return `正在复制并校验文件 ${progress.copiedFiles}/${progress.totalFiles}（${copied}/${total} MiB）…`;
}
