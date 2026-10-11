'use strict';

if (!globalThis.__folioCaptureContentInstalled) {
  globalThis.__folioCaptureContentInstalled = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'FOLIO_EXTRACT_PAGE') return false;
    sendResponse(FolioCapture.extractPage(document, location.href));
    return false;
  });
}
