export type Paper = {
  id: string;
  source_name: string;
  file_name: string;
  english_title: string;
  chinese_title: string;
  title_confident: boolean;
  page_count: number;
  status: string;
  error: string;
  created_at: string;
  last_page: number;
  segment_total: number;
  segment_done: number;
  can_read: boolean;
  source_language: 'zh' | 'en' | 'unknown';
  mono_pdf_file_name: string;
  dual_pdf_file_name: string;
  pdf_progress: number;
  model_override: string;
  folder_id: string | null;
  diagnostics: { page: number; status: string; text_chars: number }[];
  api_tokens: number | null;
};

export type Folder = { id: string; name: string; color: string; created_at: string; paper_count: number };

export type Source = { id: string; kind?: 'web'; start_page: number; end_page: number; title?: string; url?: string; snippet?: string };
export type ChatMessage = {
  id?: number; role: 'user' | 'assistant'; content: string; sources?: Source[];
  reasoning?: string; thinking?: 'default' | 'enabled' | 'disabled'; status?: string; error?: string; created_at?: string;
  attachments?: ChatAttachment[];
};
export type ChatAttachment = {
  id: string; name: string; mime_type: string; size: number; kind: 'image' | 'file' | 'pdf' | 'text';
  page_count?: number; preview_url?: string;
};
export type PaperNote = { id: string; title: string; text: string; created_at?: string; updated_at: string };
export type PaperNotes = { text: string; updated_at: string | null; notes: PaperNote[]; active_note_id: string };
export type Segment = {
  id: number;
  sequence_no: number;
  start_page: number;
  end_page: number;
  original_text: string;
  translation: string;
  status: string;
};

export type ApiRequest = {
  path: string;
  method?: string;
  body?: unknown;
  binary?: boolean;
};

export type PdfAnnotationRect = {
  x: number; y: number; width: number; height: number;
  underline_edge?: 'bottom' | 'left' | 'top' | 'right';
};

export type PdfAnnotation = {
  id: string;
  paper_id: string;
  pdf_kind: 'original' | 'mono' | 'dual';
  page_no: number;
  rects: PdfAnnotationRect[];
  selected_text: string;
  comment: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  kind: 'highlight' | 'comment' | 'underline';
  created_at: string;
  updated_at: string;
  view_contexts?: Partial<Record<SelectionContext['pdf_kind'], SelectionContext>>;
  segment_anchor?: { sequence_no: number; quote: string };
};

export type PdfSelection = {
  page_no: number;
  selected_text: string;
  rects: PdfAnnotationRect[];
  anchor: { left: number; top: number; bottom: number };
};

export type SelectionContext = {
  pdf_kind: 'original' | 'mono' | 'dual';
  page_no: number;
  rects: PdfAnnotationRect[];
  selected_text: string;
};

export type ReasoningThinking = 'default' | 'enabled' | 'disabled';
export type ReasoningEffort = 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentActionCandidate = { page_no: number; quote: string; pdf_kind?: SelectionContext['pdf_kind'] };
export type AgentAction = {
  id: string;
  kind: 'annotation' | 'note';
  status: 'pending' | 'applied' | 'cancelled';
  payload: {
    comment?: string;
    quote?: string;
    page_no?: number;
    pdf_kind?: SelectionContext['pdf_kind'];
    selection_context?: SelectionContext;
    text?: string;
    candidates?: AgentActionCandidate[];
    location_status?: 'not_found' | 'matched';
    note_id?: string;
    new_note?: boolean;
    note_title?: string;
  };
  result?: unknown;
};

export type ChatStreamInput = {
  paperId: string; sessionId?: string; question?: string; model?: string; webSearch?: boolean; runId?: string;
  selection_context?: SelectionContext;
  thinking?: ReasoningThinking;
  reasoning_effort?: ReasoningEffort;
  attachment_ids?: string[];
  selected_note_id?: string;
};
export type FeedbackInput = { message: string; contact?: string };
export type ChatStreamEvent = { requestId: string; type: string; data: Record<string, unknown> };
export type ChatStreamHandle = { requestId: string; cancel: () => Promise<boolean>; dispose: () => void };
export type StorageLocationInfo = {
  dataRoot: string;
  uiDataRoot: string;
  credentialRoot: string;
  locationConfigPath: string;
  platform: 'windows' | 'macos' | 'unsupported';
  isPackaged: boolean;
  canUninstall: boolean;
};
export type StorageMigrationProgress = { phase: 'stopping' | 'copying' | 'complete'; copiedFiles: number; totalFiles: number; copiedBytes: number; totalBytes: number };
export type UpdateState = {
  platform: 'windows' | 'macos' | 'unsupported';
  status: 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'manual-available' | 'error';
  currentVersion: string;
  enabled: boolean;
  version?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  releaseUrl?: string;
  architecture?: string;
  percent?: number;
  bytesPerSecond?: number;
  total?: number;
  transferred?: number;
  message?: string;
};

declare global {
  interface Window {
    workbench: {
      request<T = unknown>(input: ApiRequest): Promise<T>;
      setThemePreference(preference: 'system' | 'light' | 'dark'): Promise<string>;
      choosePdfs(): Promise<string[]>;
      revealPaperFile(paperId: string, kind: 'original' | 'mono' | 'dual'): Promise<boolean>;
      openLibraryFolder(): Promise<boolean>;
      getDroppedPaths(files: FileList | File[]): string[];
      cancelPaperStreams(paperId: string): Promise<number>;
      startChatStream(input: ChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<ChatStreamHandle>;
      openExternal(url: string): Promise<boolean>;
      submitFeedback(input: FeedbackInput): Promise<{ requiresActivation: boolean }>;
      uninstallApp(): Promise<boolean>;
      getAppInfo(): Promise<StorageLocationInfo>;
      pluginConnection(action: 'status' | 'start' | 'token' | 'rotate'): Promise<{ running: boolean; host: string; port: number; error?: string; token?: string; browser?: { installed: boolean; message: string }; word?: { running: boolean; state: string; url: string; message: string } }>;
      openPluginFolder(kind: 'browser' | 'word'): Promise<boolean>;
      wordPlugin(action: 'status' | 'install' | 'repair' | 'uninstall'): Promise<{ state: 'not_installed' | 'installed' | 'restart_required' | 'blocked'; wordFound: boolean; wordBitness: string | null; wordRunning: boolean; message: string }>;
      getUpdateState(): Promise<UpdateState>;
      checkForUpdates(): Promise<UpdateState>;
      downloadUpdate(): Promise<UpdateState>;
      cancelUpdateDownload(): Promise<boolean>;
      installUpdate(): Promise<boolean>;
      openUpdateDownload(): Promise<boolean>;
      onUpdateState(callback: (state: UpdateState) => void): () => void;
      onPrepareUpdateInstall(callback: (requestId: string) => void): () => void;
      updateInstallReady(requestId: string, error?: string): void;
      chooseStorageLocation(): Promise<string | null>;
      migrateStorageLocation(input: { target: string }): Promise<{ dataRoot: string; copiedFiles: number; copiedBytes: number; restarting: boolean }>;
      onStorageMigrationProgress(callback: (progress: StorageMigrationProgress) => void): () => void;
    };
  }
}

export function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return window.workbench.request<T>({ path, method, body });
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '操作失败，请稍后重试。';
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
