import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { createPdfAttachmentTask } from './PdfAttachment';

export type ChatEffort = 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ChatAttachmentView = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  kind?: string;
  page_count?: number;
  previewUrl?: string;
  status?: 'uploading' | 'ready' | 'error';
  error?: string;
};

export type ChatModelChoice = { id: string; efforts: readonly ChatEffort[] };

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (question: string) => void | Promise<void>;
  attachments: readonly ChatAttachmentView[];
  onFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onLoadPreview?: (attachment: ChatAttachmentView) => Promise<string | null>;
  disabled?: boolean;
  busy?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  searchEnabled: boolean;
  onSearchChange: (enabled: boolean) => void;
  currentModel: string;
  models: readonly ChatModelChoice[];
  onModelChange: (model: string) => void | Promise<void>;
  effort: ChatEffort;
  onEffortChange: (effort: ChatEffort) => void;
};

const ACCEPTED_FILES = '.png,.jpg,.jpeg,.webp,.pdf,.txt,.md';
const EFFORT_LABELS: Record<ChatEffort, string> = {
  default: '默认', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大',
};

function isImage(attachment: Pick<ChatAttachmentView, 'mime_type' | 'name' | 'kind'>) {
  return attachment.mime_type.startsWith('image/') || attachment.kind === 'image'
    || /\.(png|jpe?g|webp)$/i.test(attachment.name);
}

function isPdf(attachment: Pick<ChatAttachmentView, 'mime_type' | 'name' | 'kind'>) {
  return attachment.mime_type === 'application/pdf' || attachment.kind === 'pdf' || /\.pdf$/i.test(attachment.name);
}

function isSupportedFile(file: File) {
  return /\.(png|jpe?g|webp|pdf|txt|md)$/i.test(file.name);
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileType(attachment: ChatAttachmentView) {
  if (attachment.kind === 'pdf' || attachment.mime_type === 'application/pdf' || /\.pdf$/i.test(attachment.name)) return 'PDF';
  if (attachment.kind === 'text' || /\.(txt|md)$/i.test(attachment.name)) return /\.md$/i.test(attachment.name) ? 'MD' : 'TXT';
  return attachment.name.split('.').pop()?.toUpperCase().slice(0, 5) || '文件';
}

function GlobeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 7h14M5 17h14" /></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>;
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

type PdfAttachmentDocument = Awaited<ReturnType<typeof createPdfAttachmentTask>['promise']>;

function PdfAttachmentCanvas({ pdf, pageNumber, onError }: {
  pdf: PdfAttachmentDocument;
  pageNumber: number;
  onError: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel: () => void } | undefined;
    let page: Awaited<ReturnType<PdfAttachmentDocument['getPage']>> | undefined;
    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const originalViewport = page.getViewport({ scale: 1 });
        const container = canvas.closest<HTMLElement>('.chat-attachment-modal-pdf');
        const availableWidth = Math.max(1, (container?.clientWidth || originalViewport.width) - 28);
        const outputScale = window.devicePixelRatio || 1;
        const scale = Math.min(1.5, availableWidth / originalViewport.width);
        const viewport = page.getViewport({ scale: scale * outputScale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${Math.ceil(viewport.width / outputScale)}px`;
        canvas.style.height = `${Math.ceil(viewport.height / outputScale)}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法准备 PDF 页面。');
        renderTask = page.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
        if (!cancelled) canvas.dataset.rendered = 'true';
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : '无法渲染 PDF 页面。');
      } finally {
        page?.cleanup();
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [onError, pageNumber, pdf]);

  return <article className="chat-attachment-modal-pdf-page" data-page-number={pageNumber}>
    <canvas ref={canvasRef} className="chat-attachment-modal-pdf-canvas" aria-label={`PDF 第 ${pageNumber} 页`} />
  </article>;
}

function PdfAttachmentPreview({ source }: { source: string }) {
  const [pdf, setPdf] = useState<PdfAttachmentDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const onPageError = useCallback((message: string) => setError(message), []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof createPdfAttachmentTask> | null = null;
    const controller = new AbortController();
    setPdf(null);
    setLoading(true);
    setError('');
    void fetch(source, { signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error('无法读取 PDF 附件。');
      return response.arrayBuffer();
    }).then((buffer) => {
      if (cancelled) return null;
      loadingTask = createPdfAttachmentTask(new Uint8Array(buffer));
      return loadingTask.promise;
    }).then((document) => {
      if (!document || cancelled) {
        if (document) void loadingTask?.destroy();
        return;
      }
      setPdf(document);
      setLoading(false);
    }).catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : '无法读取 PDF 附件。');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (loadingTask) void loadingTask.destroy();
    };
  }, [source]);

  return <div className="chat-attachment-modal-pdf" role="region" aria-label="PDF 附件预览" data-testid="chat-attachment-pdf-preview">
    {loading && <div className="chat-attachment-modal-pdf-status" role="status">正在读取 PDF 附件…</div>}
    {error && <div className="chat-attachment-modal-pdf-error" role="alert">{error}</div>}
    {pdf && <div className="chat-attachment-modal-pdf-pages">
      {Array.from({ length: pdf.numPages }, (_, index) => <PdfAttachmentCanvas
        key={index + 1} pdf={pdf} pageNumber={index + 1} onError={onPageError} />)}
    </div>}
  </div>;
}

function AttachmentPreviewDialog({ attachment, source, onClose }: {
  attachment: ChatAttachmentView;
  source: string;
  onClose: () => void;
}) {
  const textFile = /\.(txt|md)$/i.test(attachment.name) || attachment.kind === 'text';
  const pdfFile = isPdf(attachment);
  const [textContent, setTextContent] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    closeButtonRef.current?.focus();
    if (textFile) {
      void fetch(source).then((response) => response.text()).then((content) => {
        if (!cancelled) setTextContent(content);
      }).catch(() => {
        if (!cancelled) setTextContent('无法读取此文本附件。');
      });
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, source, textFile]);

  return <div className="chat-attachment-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="chat-attachment-modal" role="dialog" aria-modal="true" aria-label={`预览附件：${attachment.name}`}>
      <header className="chat-attachment-modal-header">
        <strong title={attachment.name}>{attachment.name}</strong>
        <button ref={closeButtonRef} type="button" aria-label="关闭预览" onClick={onClose}><CloseIcon /></button>
      </header>
      {isImage(attachment)
        ? <img className="chat-attachment-modal-image" src={source} alt={attachment.name} />
        : textFile
          ? <pre className="chat-attachment-modal-text">{textContent ?? '正在读取附件…'}</pre>
          : pdfFile ? <PdfAttachmentPreview source={source} /> : <pre className="chat-attachment-modal-text">不支持预览此文件。</pre>}
    </section>
  </div>;
}

async function loadAttachmentPreview(
  attachment: ChatAttachmentView,
  loader?: (attachment: ChatAttachmentView) => Promise<string | null>,
) {
  if (attachment.previewUrl) return attachment.previewUrl;
  return loader ? loader(attachment) : null;
}

function AttachmentCards({ attachments, onRemove, onLoadPreview, compact = false }: {
  attachments: readonly ChatAttachmentView[];
  onRemove?: (id: string) => void;
  onLoadPreview?: (attachment: ChatAttachmentView) => Promise<string | null>;
  compact?: boolean;
}) {
  const [preview, setPreview] = useState<{ attachment: ChatAttachmentView; source: string } | null>(null);
  const [loadingId, setLoadingId] = useState('');
  const [previewError, setPreviewError] = useState('');
  const requestRef = useRef(0);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  async function openPreview(attachment: ChatAttachmentView, opener: HTMLButtonElement) {
    const request = ++requestRef.current;
    openerRef.current = opener;
    setLoadingId(attachment.id);
    setPreviewError('');
    try {
      const source = await loadAttachmentPreview(attachment, onLoadPreview);
      if (request !== requestRef.current) return;
      if (source) setPreview({ attachment, source });
      else setPreviewError(`无法预览“${attachment.name}”。`);
    } catch {
      if (request === requestRef.current) setPreviewError(`无法预览“${attachment.name}”。`);
    } finally {
      if (request === requestRef.current) setLoadingId('');
    }
  }

  function closePreview() {
    setPreview(null);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }

  return <>
    <div className={compact ? 'chat-attachment-list is-compact' : 'chat-attachment-list'}>
      {attachments.map((attachment) => {
        const image = isImage(attachment);
        const previewable = !!attachment.previewUrl || !!onLoadPreview;
        const label = `预览附件：${attachment.name}`;
        return <article className={`chat-attachment-card${image ? ' is-image' : ' is-file'}${attachment.status === 'error' ? ' has-error' : ''}`} key={attachment.id}>
          <button type="button" className="chat-attachment-card-open" aria-label={label} title={attachment.name}
            disabled={!previewable || attachment.status === 'uploading'} onClick={(event) => void openPreview(attachment, event.currentTarget)}>
            {image
              ? attachment.previewUrl
                ? <img className="chat-attachment-thumbnail" src={attachment.previewUrl} alt="" />
                : <span className="chat-attachment-thumbnail chat-attachment-image-placeholder" aria-hidden="true">图片</span>
              : <span className="chat-attachment-file-icon" aria-hidden="true">{fileType(attachment)}</span>}
            <span className="chat-attachment-labels">
              <span className="chat-attachment-name">{attachment.name}</span>
              <span className="chat-attachment-detail">
                {attachment.status === 'uploading' ? '正在上传…'
                  : attachment.status === 'error' ? attachment.error || '上传失败'
                    : `${fileType(attachment)}${attachment.page_count ? ` · ${attachment.page_count} 页` : ''} · ${formatSize(attachment.size)}`}
              </span>
            </span>
          </button>
          {attachment.status === 'uploading' && <span className="chat-attachment-status" role="status">上传中</span>}
          {onRemove && <button type="button" className="chat-attachment-remove" aria-label={`移除附件：${attachment.name}`}
            title="移除附件" onClick={() => onRemove(attachment.id)}><CloseIcon /></button>}
        </article>;
      })}
    </div>
    {previewError && <span className="chat-attachment-preview-error" role="status">{previewError}</span>}
    {loadingId && <span className="chat-attachment-preview-loading" role="status">正在打开附件…</span>}
    {preview && <AttachmentPreviewDialog attachment={preview.attachment} source={preview.source} onClose={closePreview} />}
  </>;
}

export function ChatAttachmentList({ attachments, onLoadPreview }: {
  attachments: readonly ChatAttachmentView[];
  onLoadPreview?: (attachment: ChatAttachmentView) => Promise<string | null>;
}) {
  if (!attachments.length) return null;
  return <AttachmentCards attachments={attachments} onLoadPreview={onLoadPreview} compact />;
}

export function ChatComposer(props: ChatComposerProps) {
  const {
    value, onChange, onSubmit, attachments, onFiles, onRemoveAttachment, onLoadPreview,
    disabled = false, busy = false, stopping = false, onStop,
    searchEnabled, onSearchChange, currentModel, models, onModelChange, effort, onEffortChange,
  } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [fileError, setFileError] = useState('');
  const canSend = !disabled && !busy && (!!value.trim() || attachments.some((attachment) => attachment.status === 'ready'))
    && !attachments.some((attachment) => attachment.status && attachment.status !== 'ready');
  const selectedModel = models.find((model) => model.id === currentModel);
  const supportedEfforts = selectedModel?.efforts || ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
  const effortValues = (['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
    .filter((item) => item === 'default' || supportedEfforts.includes(item));
  const effortIndex = Math.max(0, effortValues.indexOf(effort));

  useEffect(() => {
    if (!modelMenuOpen) return;
    function closeOnOutside(event: MouseEvent) {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setModelMenuOpen(false);
        modelButtonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [modelMenuOpen]);

  function takeFiles(files: File[]) {
    const accepted: File[] = [];
    files.forEach((file) => {
      if (isSupportedFile(file)) {
        accepted.push(file);
        return;
      }
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[file.type];
      if (extension) accepted.push(new File([file], `${file.name.replace(/\.[^.]*$/, '') || '粘贴图片'}.${extension}`, { type: file.type, lastModified: file.lastModified }));
    });
    const rejected = files.length - accepted.length;
    setFileError(rejected ? '仅支持 PNG、JPG、WebP、PDF、TXT 和 MD 文件。' : '');
    if (accepted.length) onFiles(accepted);
  }

  function handleFileInput(event: FormEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    takeFiles(Array.from(input.files || []));
    input.value = '';
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length) {
      event.preventDefault();
      takeFiles(files);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    void onSubmit(value.trim());
  }

  return <form className="chat-composer chat-composer-upgraded" onSubmit={submit}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={(event) => { event.preventDefault(); takeFiles(Array.from(event.dataTransfer.files)); }}>
    <textarea aria-label="向当前文献提问" value={value} onChange={(event) => onChange(event.target.value)}
      onPaste={handlePaste} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder="询问这篇文献…" rows={3} disabled={disabled || busy} />
    {attachments.length > 0 && <div className="chat-composer-attachments">
      <AttachmentCards attachments={attachments} onRemove={onRemoveAttachment} onLoadPreview={onLoadPreview} />
      <span className="chat-attachment-count">{attachments.length} 个附件{attachments.some((item) => item.status === 'uploading') ? '上传中' : '待发送'}</span>
    </div>}
    {fileError && <div className="chat-composer-file-error" role="status">{fileError}</div>}
    <input ref={fileInputRef} className="chat-composer-file-input" type="file" multiple accept={ACCEPTED_FILES}
      aria-label="选择图片或文件" onChange={handleFileInput} />
    <div className="chat-composer-footer">
      <button type="button" className="chat-composer-add" aria-label="添加图片或文件" title="添加图片或文件"
        disabled={disabled || busy} onClick={() => fileInputRef.current?.click()}><PlusIcon /></button>
      <button type="button" className={`chat-search-toggle${searchEnabled ? ' is-enabled' : ''}`} role="switch"
        aria-label="联网搜索" aria-checked={searchEnabled} title="联网搜索" disabled={disabled || busy}
        onClick={() => onSearchChange(!searchEnabled)}><GlobeIcon /></button>
      <div className="chat-model-menu-anchor" ref={modelMenuRef}>
        <button type="button" className="chat-model-menu-trigger" ref={modelButtonRef} aria-haspopup="dialog"
          aria-expanded={modelMenuOpen} aria-label={`模型与推理强度：${currentModel}，${EFFORT_LABELS[effort]}`}
          title="选择模型与推理强度" disabled={disabled || !currentModel} onClick={() => setModelMenuOpen((open) => !open)}>
          <span className="chat-model-menu-model">{currentModel || '正在加载模型…'}</span>
          <span className="chat-model-menu-separator" aria-hidden="true">·</span>
          <span>{EFFORT_LABELS[effort]}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
        {modelMenuOpen && <section className="chat-model-menu" role="dialog" aria-label="选择模型与推理强度">
          <div className="chat-model-menu-heading">选择模型</div>
          <div className="chat-model-options" role="group" aria-label="模型">
            {(models.length ? models : currentModel ? [{ id: currentModel, efforts: supportedEfforts }] : []).map((model) => <button
              type="button" className={model.id === currentModel ? 'is-selected' : ''} key={model.id}
              aria-pressed={model.id === currentModel} onClick={() => void onModelChange(model.id)}>
              <span>{model.id}</span>{model.id === currentModel && <span aria-hidden="true">✓</span>}
            </button>)}
          </div>
          <div className="chat-effort-slider-heading"><span>推理强度</span><strong>{EFFORT_LABELS[effort]}</strong></div>
          <input className="chat-effort-slider" type="range" min={0} max={effortValues.length - 1} step={1}
            value={effortIndex} aria-label="推理强度" aria-valuetext={EFFORT_LABELS[effort]}
            onChange={(event) => onEffortChange(effortValues[Number(event.target.value)])} />
          <div className="chat-effort-labels" aria-hidden="true">{effortValues.map((item) => <span key={item}>{EFFORT_LABELS[item]}</span>)}</div>
        </section>}
      </div>
      {busy
        ? <button type="button" className="chat-composer-send is-stop" aria-label="停止生成" title="停止生成"
          disabled={!onStop || stopping} onClick={onStop}>{stopping ? '…' : <span className="chat-stop-icon" aria-hidden="true" />}</button>
        : <button type="submit" className="chat-composer-send" aria-label="发送" title="发送" disabled={!canSend}><SendIcon /></button>}
    </div>
  </form>;
}
