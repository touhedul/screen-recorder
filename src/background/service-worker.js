import { ACTIONS, STATUS, CROP_MODES } from '../utils/constants.js';
import { setActiveState, getActiveState } from '../utils/storage.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

let currentRecordingState = {
  status: STATUS.IDLE,
  tabId: null,
  tabTitle: '',
  resolution: '1080p',
  cropMode: CROP_MODES.AUTO,
  cropRect: null,
  recordMic: false,
  showFloatingControls: true,
  startTime: 0,
  pausedTimestamp: 0,
  accumulatedPausedTime: 0
};

let offscreenReadyResolver = null;

// Check if offscreen document exists
async function hasOffscreenDocument() {
  if ('hasDocument' in chrome.offscreen) {
    return await chrome.offscreen.hasDocument();
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((c) => c.url.includes(OFFSCREEN_DOCUMENT_PATH));
}

// Create offscreen document if needed
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  const readyPromise = new Promise((resolve) => {
    offscreenReadyResolver = resolve;
    // Safety fallback timeout
    setTimeout(() => {
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
    }, 1500);
  });

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'LOCAL_STORAGE'],
    justification: 'Offscreen canvas rendering, audio mixing, and OPFS stream recording.'
  });

  await readyPromise;
}

// Close offscreen document
async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      console.warn('[ServiceWorker] Error closing offscreen document:', err);
    }
  }
}

// Update Action Badge
function updateBadge(status) {
  if (status === STATUS.RECORDING) {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  } else if (status === STATUS.PAUSED) {
    chrome.action.setBadgeText({ text: 'PAUSE' });
    chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Notify all parts of status update
function broadcastStatus() {
  const payload = {
    action: ACTIONS.STATUS_UPDATE,
    ...currentRecordingState
  };

  chrome.runtime.sendMessage(payload).catch(() => {});

  if (currentRecordingState.tabId) {
    chrome.tabs.sendMessage(currentRecordingState.tabId, payload).catch(() => {});
  }
}

// Handle Start Recording
async function handleStartRecording(params) {
  const {
    tabId,
    tabTitle,
    resolution = '1080p',
    cropMode = CROP_MODES.AUTO,
    recordMic = false,
    showFloatingControls = true
  } = params;

  if (currentRecordingState.status === STATUS.RECORDING) {
    throw new Error('Recording is already in progress');
  }

  // Inject content script if not already present
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/content/content.css']
    });
  } catch (injectErr) {
    console.log('[ServiceWorker] Content script injection note:', injectErr.message);
  }

  // Obtain crop bounds from content script with timeout so it never hangs
  let cropInfo = null;
  try {
    cropInfo = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 600);
      chrome.tabs.sendMessage(tabId, { action: ACTIONS.GET_CROP_BOUNDS }, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
  } catch (cropErr) {
    console.warn('[ServiceWorker] Could not query crop bounds:', cropErr);
  }

  // Obtain MediaStreamId (from popup user gesture or query)
  let streamId = params.streamId;
  if (!streamId) {
    try {
      streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
    } catch (streamErr) {
      console.error('[ServiceWorker] getMediaStreamId error:', streamErr);
    }
  }

  if (!streamId) {
    throw new Error('Failed to acquire tab capture stream ID from Chrome');
  }

  // Setup offscreen document
  await ensureOffscreenDocument();

  // Send start command to offscreen document with retry in case message channel needs a moment
  const sendToOffscreenWithRetry = async (payload, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(payload, (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (res && res.error) {
              reject(new Error(res.error));
            } else {
              resolve(res);
            }
          });
        });
      } catch (err) {
        if (attempt < maxRetries && err.message.includes('Receiving end does not exist')) {
          console.log(`[ServiceWorker] Offscreen not ready yet, retry ${attempt}/${maxRetries}...`);
          await new Promise((r) => setTimeout(r, 200));
        } else {
          throw err;
        }
      }
    }
  };

  const offscreenResponse = await sendToOffscreenWithRetry({
    action: ACTIONS.START_RECORDING,
    streamId,
    resolution,
    cropMode,
    cropRect: cropInfo?.rect || null,
    viewport: cropInfo?.viewport || null,
    recordMic,
    tabTitle
  });

  currentRecordingState = {
    status: STATUS.RECORDING,
    tabId,
    tabTitle,
    resolution,
    cropMode,
    cropRect: cropInfo?.rect || null,
    recordMic,
    showFloatingControls,
    startTime: offscreenResponse?.startTime || Date.now(),
    pausedTimestamp: 0,
    accumulatedPausedTime: 0
  };

  await setActiveState(currentRecordingState);
  updateBadge(STATUS.RECORDING);
  broadcastStatus();

  return currentRecordingState;
}

// Handle Pause Recording
async function handlePauseRecording() {
  if (currentRecordingState.status !== STATUS.RECORDING) return;

  chrome.runtime.sendMessage({ action: ACTIONS.PAUSE_RECORDING }).catch(() => {});
  currentRecordingState.status = STATUS.PAUSED;
  currentRecordingState.pausedTimestamp = Date.now();

  await setActiveState(currentRecordingState);
  updateBadge(STATUS.PAUSED);
  broadcastStatus();

  return currentRecordingState;
}

// Handle Resume Recording
async function handleResumeRecording() {
  if (currentRecordingState.status !== STATUS.PAUSED) return;

  chrome.runtime.sendMessage({ action: ACTIONS.RESUME_RECORDING }).catch(() => {});
  if (currentRecordingState.pausedTimestamp > 0) {
    currentRecordingState.accumulatedPausedTime += Date.now() - currentRecordingState.pausedTimestamp;
  }
  currentRecordingState.status = STATUS.RECORDING;
  currentRecordingState.pausedTimestamp = 0;

  await setActiveState(currentRecordingState);
  updateBadge(STATUS.RECORDING);
  broadcastStatus();

  return currentRecordingState;
}

// Handle Stop Recording
async function handleStopRecording() {
  if (currentRecordingState.status === STATUS.IDLE) return;

  currentRecordingState.status = STATUS.SAVING;
  updateBadge(STATUS.IDLE);
  broadcastStatus();

  chrome.runtime.sendMessage({ action: ACTIONS.STOP_RECORDING }).catch(() => {});
}

// Handle Download Recording
async function handleDownload(url, filename) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false
    });
    console.log('[ServiceWorker] Download initiated with ID:', downloadId);

    if (currentRecordingState.tabId) {
      chrome.tabs.sendMessage(currentRecordingState.tabId, { action: ACTIONS.RECORDING_COMPLETE }).catch(() => {});
    }
  } catch (dlErr) {
    console.error('[ServiceWorker] Download error:', dlErr);
  } finally {
    currentRecordingState = {
      status: STATUS.IDLE,
      tabId: null,
      tabTitle: '',
      resolution: '1080p',
      cropMode: CROP_MODES.AUTO,
      cropRect: null,
      recordMic: false,
      showFloatingControls: true,
      startTime: 0,
      pausedTimestamp: 0,
      accumulatedPausedTime: 0
    };
    await setActiveState(null);
    updateBadge(STATUS.IDLE);
    broadcastStatus();

    // Keep offscreen document alive for 12 seconds so Chrome finishes saving the blob URL
    setTimeout(() => {
      closeOffscreenDocument();
    }, 12000);
  }
}

// Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case ACTIONS.OFFSCREEN_READY: {
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
      sendResponse({ success: true });
      return false;
    }

    case ACTIONS.GET_STATUS: {
      sendResponse(currentRecordingState);
      return false;
    }

    case ACTIONS.START_RECORDING: {
      handleStartRecording(request)
        .then((state) => sendResponse(state))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    case ACTIONS.PAUSE_RECORDING: {
      handlePauseRecording()
        .then((state) => sendResponse(state))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    case ACTIONS.RESUME_RECORDING: {
      handleResumeRecording()
        .then((state) => sendResponse(state))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    case ACTIONS.STOP_RECORDING: {
      handleStopRecording()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    case 'DOWNLOAD_RECORDING': {
      handleDownload(request.url, request.filename);
      sendResponse({ success: true });
      return true;
    }

    case ACTIONS.CONTAINER_SELECTED: {
      currentRecordingState.cropRect = request.rect;
      currentRecordingState.cropMode = CROP_MODES.MANUAL;
      sendResponse({ success: true });
      return false;
    }

    default:
      return false;
  }
});

// If the recorded tab is closed, automatically stop and finalize recording
chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (currentRecordingState.tabId === closedTabId && currentRecordingState.status === STATUS.RECORDING) {
    console.log('[ServiceWorker] Recorded tab was closed, finalizing recording...');
    handleStopRecording();
  }
});

// Restore active state if service worker awoke from idle
getActiveState().then((savedState) => {
  if (savedState && savedState.status === STATUS.RECORDING) {
    currentRecordingState = savedState;
    updateBadge(savedState.status);
  }
});
