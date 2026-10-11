import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, errorMessage, ReasoningEffort, SelectionContext } from './api';
import { loadPdfDocument, SharedPdfDocument } from './PdfPage';
import './research-tasks.css';

type ResearchStep = { step_key: string; title: string; status: string; detail: string };
type ResearchEvidence = {
  id: string; kind: string; title: string; start_page: number | null; end_page: number | null; text: string;
};
type ResearchCoverage = {
  complete: boolean; percent: number | null; covered_pages: number[]; expected_pages: number[] | null; unreadable_pages: number[];
};
type ResearchTask = {
  id: string; question: string; status: string; progress: number; plan: ResearchStep[]; evidence: ResearchEvidence[];
  coverage: ResearchCoverage; budget: Record<string, number>; answer: string; error: string;
  image_requests: { id: string; page_no: number; status: string }[]; capabilities: { image_analysis: boolean };
  created_at: string;
};
type ResearchScope = 'question' | 'full' | 'pages' | 'selection';

const activeStatuses = new Set(['queued', 'running', 'waiting_for_image']);
const resumableStatuses = new Set(['stopped', 'failed', 'interrupted', 'waiting_for_image', 'partial']);

function statusLabel(status: string) {
  return ({
    queued: '排队中', running: '研究中', waiting_for_image: '等待页面图像', completed: '已完成', partial: '部分完成',
    stopped: '已停止', interrupted: '已中断', failed: '失败', budget_exhausted: '预算已用尽',
  } as Record<string, string>)[status] || status;
}

async function renderPageImage(document: SharedPdfDocument, pageNumber: number) {
  const page = await document.pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  let scale = Math.min(1.6, 1800 / Math.max(baseViewport.width, baseViewport.height));
  const canvas = window.document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建页面图像画布。');
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', Math.max(0.55, 0.84 - attempt * 0.05));
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (Math.floor(data.length * 0.75) <= 1_900_000) return { mime_type: 'image/jpeg', data_base64: data };
      scale *= 0.78;
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  throw new Error('该页图像超过任务大小限制，无法上传。');
}

export function ResearchTasksPanel({
  paperId, sessionId, active, pageCount, currentModel, selectionContext, defaultEffort, onOpenPdfLocation,
}: {
  paperId: string; sessionId: string; active: boolean; pageCount: number; currentModel: string;
  selectionContext: SelectionContext | null; defaultEffort: ReasoningEffort;
  onOpenPdfLocation: (page: number) => void;
}) {
  const [tasks, setTasks] = useState<ResearchTask[]>([]);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<ResearchScope>(selectionContext?.selected_text ? 'selection' : 'question');
  const [startPage, setStartPage] = useState('1');
  const [endPage, setEndPage] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState('');
  const [imageFailures, setImageFailures] = useState<Record<string, string>>({});
  const imageAttemptsRef = useRef(new Set<string>());
  const pdfDocumentRef = useRef<SharedPdfDocument | null>(null);
  const pdfLoadingRef = useRef<Promise<SharedPdfDocument> | null>(null);
  const pdfEpochRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    pdfEpochRef.current += 1;
    return () => {
      mountedRef.current = false;
      pdfEpochRef.current += 1;
      pdfLoadingRef.current = null;
      const document = pdfDocumentRef.current;
      pdfDocumentRef.current = null;
      if (document) void document.destroy();
    };
  }, [paperId]);

  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await api<{ tasks: ResearchTask[] }>(`/papers/${paperId}/research?session_id=${encodeURIComponent(sessionId)}`);
        if (!cancelled) {
          setTasks(result.tasks);
          setFailure('');
        }
      } catch (error) {
        if (!cancelled) setFailure(errorMessage(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1600);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active, paperId, sessionId]);

  async function getOriginalPdf() {
    const epoch = pdfEpochRef.current;
    if (pdfDocumentRef.current) return pdfDocumentRef.current;
    let pending = pdfLoadingRef.current;
    if (!pending) {
      pending = loadPdfDocument(paperId, 'original');
      pdfLoadingRef.current = pending;
    }
    try {
      const document = await pending;
      if (epoch !== pdfEpochRef.current) {
        void document.destroy();
        throw new Error('文献已切换，页面图像请求已取消。');
      }
      pdfDocumentRef.current = document;
      return document;
    } catch (error) {
      if (pdfLoadingRef.current === pending) pdfLoadingRef.current = null;
      throw error;
    }
  }

  useEffect(() => {
    if (!active) return;
    for (const task of tasks) {
      if (task.status !== 'waiting_for_image') continue;
      for (const request of task.image_requests) {
        if (request.status !== 'pending' || imageAttemptsRef.current.has(request.id)) continue;
        imageAttemptsRef.current.add(request.id);
        void (async () => {
          try {
            const document = await getOriginalPdf();
            const image = await renderPageImage(document, request.page_no);
            if (!mountedRef.current) return;
            await api(`/papers/${paperId}/research/${task.id}/images/${request.id}`, 'POST', image);
            if (mountedRef.current) setImageFailures((previous) => {
              const next = { ...previous };
              delete next[request.id];
              return next;
            });
          } catch (error) {
            if (mountedRef.current) setImageFailures((previous) => ({ ...previous, [request.id]: errorMessage(error) }));
          }
        })();
      }
    }
  }, [active, paperId, sessionId, tasks]);

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt) { setFailure('请填写研究问题。'); return; }
    let range: { start_page: number; end_page: number } | undefined;
    if (scope === 'pages') {
      const start = Number(startPage);
      const end = Number(endPage);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount || end - start >= 10) {
        setFailure('页码范围须在文献内，且不超过10页。');
        return;
      }
      range = { start_page: start, end_page: end };
    }
    if (scope === 'selection' && !selectionContext?.selected_text) {
      setFailure('当前会话没有关联的文字选区。');
      return;
    }
    setSubmitting(true);
    setFailure('');
    try {
      const result = await api<{ task: ResearchTask }>(`/papers/${paperId}/research`, 'POST', {
        question: scope === 'full' ? `全文研究：${prompt}` : prompt,
        session_id: sessionId,
        ...(currentModel ? { model: currentModel } : {}),
        reasoning_effort: defaultEffort,
        ...(range || {}),
        ...(scope === 'selection' && selectionContext ? { selection_context: selectionContext } : {}),
      });
      setTasks((previous) => [result.task, ...previous.filter((item) => item.id !== result.task.id)]);
      setQuestion('');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function taskAction(task: ResearchTask, action: 'stop' | 'resume') {
    try {
      const result = await api<{ task?: ResearchTask; status?: string }>(`/papers/${paperId}/research/${task.id}/${action}`, 'POST');
      if (result.task) setTasks((previous) => previous.map((item) => item.id === task.id ? result.task! : item));
      else if (action === 'resume') {
        const pendingIds = task.image_requests.filter((request) => request.status === 'pending').map((request) => request.id);
        for (const requestId of pendingIds) imageAttemptsRef.current.delete(requestId);
        setImageFailures((previous) => {
          const next = { ...previous };
          for (const requestId of pendingIds) delete next[requestId];
          return next;
        });
        setTasks((previous) => previous.map((item) => item.id === task.id ? { ...item, status: result.status || item.status } : item));
      }
    } catch (error) { setFailure(errorMessage(error)); }
  }

  async function retryImage(requestId: string) {
    imageAttemptsRef.current.delete(requestId);
    setImageFailures((previous) => { const next = { ...previous }; delete next[requestId]; return next; });
    setTasks((previous) => [...previous]);
  }

  const coveredCount = (coverage: ResearchCoverage) => coverage.covered_pages.length;
  return <section className="research-tasks-panel" role="tabpanel" aria-label="深度研究任务">
    <form className="research-start-form" onSubmit={(event) => void createTask(event)}>
      <div className="research-panel-heading">
        <div><span className="eyebrow">单篇文献</span><h2>深度研究</h2></div>
        <span className="research-model-label" title={currentModel || '使用当前模型'}>{currentModel || '当前模型'}</span>
      </div>
      <label className="research-field">研究问题
        <textarea value={question} maxLength={6000} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：作者如何支持其核心结论？有哪些局限？" rows={3} />
      </label>
      <div className="research-scope-options" role="group" aria-label="研究范围">
        {([
          ['question', '问题检索'], ['full', '全文'], ['pages', '页码范围'], ['selection', '当前选区'],
        ] as [ResearchScope, string][]).map(([value, label]) => <button key={value} type="button" className={scope === value ? 'selected' : ''} aria-pressed={scope === value} onClick={() => setScope(value)}>{label}</button>)}
      </div>
      {scope === 'pages' && <div className="research-range-fields">
        <label>从第 <input type="number" min={1} max={pageCount} value={startPage} onChange={(event) => setStartPage(event.target.value)} /> 页</label>
        <label>到第 <input type="number" min={1} max={pageCount} value={endPage} onChange={(event) => setEndPage(event.target.value)} /> 页</label>
      </div>}
      {scope === 'selection' && <p className="research-selection-preview">{selectionContext?.selected_text || '当前会话没有关联的文字选区。'}</p>}
      <div className="research-start-options">
        <button type="submit" className="primary-button compact-button" disabled={submitting || (scope === 'selection' && !selectionContext?.selected_text)}>{submitting ? '正在创建…' : '开始研究'}</button>
      </div>
      <p className="research-form-note">研究只读取本文原文、目录、笔记与批注；不会修改文献内容。全文研究会显示实际正文覆盖情况。</p>
    </form>
    {failure && <div className="research-error" role="alert">{failure}</div>}
    <div className="research-task-list" aria-live="polite">
      {!tasks.length && <p className="research-empty">尚无深度研究任务。提交问题后，计划和证据会保存在当前会话中。</p>}
      {tasks.map((task) => <article className="research-task-card" key={task.id} data-status={task.status}>
        <header className="research-task-heading">
          <div><span className={`research-status research-status-${task.status}`}>{statusLabel(task.status)}</span><time>{new Date(task.created_at).toLocaleString()}</time></div>
          {activeStatuses.has(task.status)
            ? <button type="button" className="secondary-button compact-button" onClick={() => void taskAction(task, 'stop')}>停止</button>
            : resumableStatuses.has(task.status)
              ? <button type="button" className="secondary-button compact-button" onClick={() => void taskAction(task, 'resume')}>继续</button>
              : null}
        </header>
        <h3>{task.question}</h3>
        {activeStatuses.has(task.status) && <div className="research-progress"><progress max={100} value={task.progress} /><span>{task.progress}%</span></div>}
        {task.error && <p className="research-task-error">{task.error}</p>}
        <details className="research-plan">
          <summary>研究计划 · {task.plan.filter((step) => step.status === 'completed' || step.status === 'skipped').length}/{task.plan.length}</summary>
          <ol>{task.plan.map((step) => <li key={step.step_key} data-step-status={step.status}><span>{step.title}</span><small>{step.detail || statusLabel(step.status)}</small></li>)}</ol>
        </details>
        {task.image_requests.map((request) => <div className="research-image-request" key={request.id} role="status">
          {imageFailures[request.id] ? <><span>第 {request.page_no} 页图像读取失败：{imageFailures[request.id]}</span><button type="button" className="reader-annotation-jump" onClick={() => void retryImage(request.id)}>重试</button></> : `正在从原始 PDF 读取第 ${request.page_no} 页图像…`}
        </div>)}
        <div className="research-coverage">
          <strong>{task.coverage.percent === null ? `已读取 ${coveredCount(task.coverage)} 页正文` : `正文覆盖 ${task.coverage.percent}%`}</strong>
          {task.coverage.expected_pages && <span>{task.coverage.complete ? '指定范围正文已完整读取' : `已读 ${coveredCount(task.coverage)} / ${task.coverage.expected_pages.length} 页`}</span>}
          {!!task.coverage.unreadable_pages.length && <span>无法提取正文：第 {task.coverage.unreadable_pages.join('、')} 页</span>}
        </div>
        {task.answer && <div className="research-task-answer"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.answer}</ReactMarkdown></div>}
        {!!task.evidence.length && <details className="research-evidence">
          <summary>证据与引用 · {task.evidence.length}</summary>
          {task.evidence.map((item) => <article key={item.id}>
            <header><strong>[{item.id}] {item.title || item.kind}</strong>{item.start_page && <button type="button" className="reader-annotation-jump" onClick={() => onOpenPdfLocation(item.start_page!)}>跳到第 {item.start_page} 页</button>}</header>
            {item.text && <p>{item.text}</p>}
          </article>)}
        </details>}
        <div className="research-budget">模型调用 {task.budget.model_calls || 0} · 工具调用 {task.budget.tool_calls || 0} · 图像 {task.budget.image_bytes || 0} B{task.capabilities.image_analysis ? ' · 支持图像分析' : ' · 未确认图像能力，本任务读取文本'}</div>
      </article>)}
    </div>
  </section>;
}
