const { contextBridge, ipcRenderer, webUtils } = require('electron');

function startChatStream(input, onEvent) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const requestId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const listener = (_event, payload) => {
    if (payload?.requestId !== requestId) return;
    onEvent(payload);
    if (['done', 'cancelled', 'error'].includes(payload.type)) ipcRenderer.removeListener('workbench:chat-stream-event', listener);
  };
  ipcRenderer.on('workbench:chat-stream-event', listener);
  return ipcRenderer.invoke('workbench:chat-stream-start', { ...input, requestId })
    .then(() => ({
      requestId,
      cancel: () => ipcRenderer.invoke('workbench:chat-stream-cancel', requestId),
      dispose: () => ipcRenderer.removeListener('workbench:chat-stream-event', listener),
    }))
    .catch((error) => {
      ipcRenderer.removeListener('workbench:chat-stream-event', listener);
      throw error;
    });
}

contextBridge.exposeInMainWorld('workbench', Object.freeze({
  request: (input) => ipcRenderer.invoke('workbench:request', input),
  setThemePreference: (preference) => ipcRenderer.invoke('workbench:set-theme-preference', preference),
  choosePdfs: () => ipcRenderer.invoke('workbench:choose-pdfs'),
  revealPaperFile: (paperId, kind) => ipcRenderer.invoke('workbench:reveal-paper-file', { paperId, kind }),
  openLibraryFolder: () => ipcRenderer.invoke('workbench:open-library-folder'),
  getDroppedPaths: (files) => Array.from(files, (file) => webUtils.getPathForFile(file)).filter(Boolean),
  cancelPaperStreams: (paperId) => ipcRenderer.invoke('workbench:cancel-paper-streams', paperId),
  startChatStream,
  openExternal: (url) => ipcRenderer.invoke('workbench:open-external', url),
  getAppInfo: () => ipcRenderer.invoke('workbench:get-app-info'),
  getUpdateState: () => ipcRenderer.invoke('workbench:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('workbench:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('workbench:update-download'),
  cancelUpdateDownload: () => ipcRenderer.invoke('workbench:update-cancel-download'),
  installUpdate: () => ipcRenderer.invoke('workbench:update-install'),
  openUpdateDownload: () => ipcRenderer.invoke('workbench:update-open-download'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('workbench:update-state', listener);
    ipcRenderer.send('workbench:update-state-subscribe');
    return () => ipcRenderer.removeListener('workbench:update-state', listener);
  },
  onPrepareUpdateInstall: (callback) => {
    const listener = (_event, requestId) => callback(requestId);
    ipcRenderer.on('workbench:update-install-prepare', listener);
    return () => ipcRenderer.removeListener('workbench:update-install-prepare', listener);
  },
  updateInstallReady: (requestId, error) => ipcRenderer.send('workbench:update-install-ready', { requestId, error }),
  chooseStorageLocation: () => ipcRenderer.invoke('workbench:choose-storage-location'),
  migrateStorageLocation: (input) => ipcRenderer.invoke('workbench:migrate-storage-location', input),
  onStorageMigrationProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('workbench:storage-migration-progress', listener);
    return () => ipcRenderer.removeListener('workbench:storage-migration-progress', listener);
  },
}));
