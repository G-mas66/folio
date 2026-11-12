import { useEffect, useRef, useState } from 'react';
import { apiConfiguration, clearApiConfiguration, completeTabletAI, discoverTabletModels, saveApiConfiguration } from './tablet-ai';

export function TabletSettings() {
  const [config, setConfig] = useState(apiConfiguration);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [modelsUrl, setModelsUrl] = useState(config.modelsUrl);
  const [model, setModel] = useState(config.model);
  const [options, setOptions] = useState(config.modelOptions);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const discovery = useRef<AbortController | null>(null);
  const disabled = busy || discovering;
  const available = [...new Set([model, ...options, ...discovered].filter(Boolean))];
  const toAdd = discovered.filter(item => !options.includes(item));
  const sameAddress = baseUrl.trim().replace(/\/+$/, '') === config.baseUrl;
  const hasSavedKey = sameAddress && config.hasKey;

  useEffect(() => () => discovery.current?.abort(), []);

  function changeBaseUrl(value: string) {
    const same = value.trim().replace(/\/+$/, '') === config.baseUrl;
    setBaseUrl(value);
    setDiscovered([]);
    setSelected([]);
    setOptions(same ? config.modelOptions : []);
    setModel(same ? config.model : '');
    setModelsUrl(same ? config.modelsUrl : '');
    setNotice('');
    setError('');
  }

  async function detect() {
    const controller = new AbortController();
    discovery.current = controller;
    setDiscovering(true);
    setDiscovered([]);
    setSelected([]);
    setError('');
    setNotice('');
    try {
      const models = await discoverTabletModels(baseUrl, key, modelsUrl, controller.signal);
      if (controller.signal.aborted) return;
      setDiscovered(models);
      setNotice(models.length ? '读取到 ' + models.length + ' 个模型。可选默认模型，或添加到常用列表。' : '服务返回的模型列表为空。');
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '获取模型列表失败。');
    } finally {
      if (!controller.signal.aborted) setDiscovering(false);
      if (discovery.current === controller) discovery.current = null;
    }
  }

  function addSelected() {
    setOptions([...new Set([...options, ...selected])]);
    if (!model) setModel(selected[0] ?? '');
    setSelected([]);
    setNotice('所选模型已添加，保存设置后生效。');
  }

  async function save(test: boolean) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      saveApiConfiguration(baseUrl, key, model, modelsUrl, options);
      setConfig(apiConfiguration());
      setKey('');
      if (test) await completeTabletAI([{ role: 'user', content: 'Reply with OK.' }]);
      setNotice(test ? 'API 连接成功。' : 'API 设置已保存。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接 API。');
    } finally { setBusy(false); }
  }

  function clear() {
    clearApiConfiguration();
    setConfig(apiConfiguration());
    setBaseUrl('');
    setModelsUrl('');
    setModel('');
    setOptions([]);
    setDiscovered([]);
    setSelected([]);
    setKey('');
    setError('');
    setNotice('已清除 API 设置。');
  }

  return <section className="settings-panel">
    <div className="page-heading"><div><div className="eyebrow">偏好设置</div><h1>设置</h1></div></div>
    <div className="settings-card">
      <h2>AI API 设置</h2>
      <p className="field-help">使用支持 OpenAI Chat Completions 的 HTTPS 服务。API Key 加密保存在平板。</p>
      <label className="field-label" htmlFor="tablet-api-url">AI API URL</label>
      <input id="tablet-api-url" type="url" disabled={disabled} value={baseUrl} onChange={event => changeBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
      <label className="field-label" htmlFor="tablet-api-key">AI API Key</label>
      <input id="tablet-api-key" type="password" disabled={disabled} value={key} onChange={event => setKey(event.target.value)} placeholder={hasSavedKey ? '已保存，留空沿用' : '粘贴服务方提供的 API Key'} autoComplete="new-password" />
      <div className="model-discovery-actions">
        <span className="field-help">读取服务提供的模型列表。检测时可以使用当前输入的 Key。</span>
        <button className="secondary-button compact-button" type="button" onClick={() => void detect()} disabled={disabled || !(baseUrl.trim() || modelsUrl.trim())}>{discovering ? '读取中…' : '获取模型列表'}</button>
      </div>
      <details className="advanced-model-url">
        <summary>高级：自定义模型列表地址</summary>
        <label className="field-label" htmlFor="tablet-models-url">模型列表地址</label>
        <input id="tablet-models-url" type="url" disabled={disabled} value={modelsUrl} onChange={event => {
          setModelsUrl(event.target.value);
          setDiscovered([]);
          setSelected([]);
        }} placeholder="留空时根据 AI API URL 自动推导" />
        <span className="field-help">使用不同域名的模型列表时，如需认证，请重新输入 API Key。</span>
      </details>
      <label className="field-label" htmlFor="tablet-api-model">默认模型</label>
      <select id="tablet-api-model" disabled={disabled || !available.length} value={model} onChange={event => setModel(event.target.value)}>
        <option value="">{available.length ? '请选择模型' : '请先获取模型列表'}</option>
        {available.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <div className="settings-actions">
        <button type="button" className="primary-button" disabled={disabled || !model || !baseUrl.trim() || !(key.trim() || hasSavedKey)} onClick={() => void save(false)}>保存设置</button>
        <button type="button" className="secondary-button" disabled={disabled || !model || !baseUrl.trim() || !(key.trim() || hasSavedKey)} onClick={() => void save(true)}>保存并测试连接</button>
        {config.hasKey && <button type="button" className="text-button" disabled={disabled} onClick={clear}>清除设置</button>}
      </div>
      {options.length > 0 && <div className="saved-model-list" aria-label="常用模型列表">
        {options.map(item => <div className="saved-model-row" key={item}><span>{item}</span>
          <button type="button" className="text-button" disabled={disabled} aria-label={'移除模型 ' + item} onClick={() => setOptions(options.filter(option => option !== item))}>移除</button>
        </div>)}
      </div>}
      {toAdd.length > 0 && <div className="discovered-models" aria-label="可添加模型列表">
        <div className="field-help">勾选后添加到常用模型。</div>
        {toAdd.map(item => <label className="discovered-model-row" key={item}>
          <input type="checkbox" disabled={disabled} checked={selected.includes(item)} onChange={event => setSelected(current => event.target.checked ? [...current, item] : current.filter(option => option !== item))} />
          <span>{item}</span>
        </label>)}
        <button className="secondary-button compact-button" type="button" onClick={addSelected} disabled={disabled || !selected.length}>添加所选模型</button>
      </div>}
      {notice && <p className="notice success-notice" role="status">{notice}</p>}
      {error && <p className="notice error-notice" role="alert">{error}</p>}
    </div>
  </section>;
}
