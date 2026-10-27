import { ACTIONS, STATUS, CROP_MODES } from '../utils/constants.js';
import { getSettings, saveSettings } from '../utils/storage.js';

// DOM Elements
const idleSection = document.getElementById('idleControls');
const recordingSection = document.getElementById('recordingControls');
const savingSection = document.getElementById('savingControls');

const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const recordingStateLabel = document.getElementById('recordingStateLabel');

const resolutionPicker = document.getElementById('resolutionPicker');
const cropModeGrid = document.getElementById('cropModeGrid');
const detectedContainerNotice = document.getElementById('detectedContainerNotice');
const detectedNoticeText = document.getElementById('detectedNoticeText');

const micToggleCard = document.getElementById('micToggleCard');
const micCheckbox = document.getElementById('micCheckbox');
const micSubtext = document.getElementById('micSubtext');

const pillToggleCard = document.getElementById('pillToggleCard');
const pillCheckbox = document.getElementById('pillCheckbox');
const pillSubtext = document.getElementById('pillSubtext');

const btnStartRecording = document.getElementById('btnStartRecording');
const btnPauseResume = document.getElementById('btnPauseResume');
const pauseIcon = document.getElementById('pauseIcon');
const pauseBtnText = document.getElementById('pauseBtnText');
const btnStopRecording = document.getElementById('btnStopRecording');

const timerText = document.getElementById('timerText');
const metaResolution = document.getElementById('metaResolution');
const metaCrop = document.getElementById('metaCrop');
const metaFormat = document.getElementById('metaFormat');

let timerInterval = null;
let recordingStartTime = 0;
let accumulatedPausedTime = 0;
let currentCropMode = CROP_MODES.AUTO;
let currentResolution = '1080p';

// Format seconds into HH:MM:SS
function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function startTimer(startTime, pausedDuration = 0) {
  stopTimer();
  recordingStartTime = startTime;
  accumulatedPausedTime = pausedDuration;

  const update = () => {
    const elapsed = Date.now() - recordingStartTime - accumulatedPausedTime;
    timerText.textContent = formatTime(elapsed);
  };

  update();
  timerInterval = setInterval(update, 250);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Switch UI Views
function setView(state, data = {}) {
  idleSection.classList.add('hidden');
  recordingSection.classList.add('hidden');
  savingSection.classList.add('hidden');

  statusBadge.className = 'status-badge';

  switch (state) {
    case STATUS.RECORDING:
      recordingSection.classList.remove('hidden');
      statusBadge.classList.add('recording');
      statusText.textContent = 'Recording';
      recordingStateLabel.textContent = 'RECORDING TAB';
      pauseBtnText.textContent = 'Pause';
      pauseIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';

      metaResolution.textContent = data.resolution || currentResolution;
      metaCrop.textContent = (data.cropMode === CROP_MODES.AUTO) ? 'Auto Mobile' : (data.cropMode === CROP_MODES.MANUAL ? 'Custom Frame' : 'Full Tab');
      metaFormat.textContent = (data.format || 'mp4').toUpperCase();

      if (data.startTime) {
        startTimer(data.startTime, data.accumulatedPausedTime || 0);
      }
      break;

    case STATUS.PAUSED:
      recordingSection.classList.remove('hidden');
      statusBadge.classList.add('paused');
      statusText.textContent = 'Paused';
      recordingStateLabel.textContent = 'PAUSED';
      pauseBtnText.textContent = 'Resume';
      pauseIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
      stopTimer();
      if (data.elapsedTime) {
        timerText.textContent = formatTime(data.elapsedTime);
      }
      break;

    case STATUS.SAVING:
      savingSection.classList.remove('hidden');
      statusBadge.classList.add('paused');
      statusText.textContent = 'Finalizing';
      stopTimer();
      break;

    case STATUS.IDLE:
    default:
      idleSection.classList.remove('hidden');
      statusBadge.classList.add('idle');
      statusText.textContent = 'Ready';
      stopTimer();
      timerText.textContent = '00:00:00';
      break;
  }
}

// Helper to check for restricted browser system URLs
function isRestrictedUrl(url) {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:')
  );
}

// Robust target tab query with fallback for DevTools focus
async function getTargetTab() {
  try {
    let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.id || isRestrictedUrl(activeTab.url)) {
      const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (lastFocused.length > 0 && lastFocused[0].id) {
        activeTab = lastFocused[0];
      }
    }
    return activeTab || null;
  } catch (err) {
    console.warn('[Popup] getTargetTab error:', err);
    return null;
  }
}

// Check active tab for mobile mode or restricted URL
async function inspectActiveTab() {
  try {
    const activeTab = await getTargetTab();
    if (!activeTab || !activeTab.id) return;

    if (isRestrictedUrl(activeTab.url)) {
      detectedContainerNotice.classList.remove('hidden');
      detectedContainerNotice.style.background = 'rgba(239, 68, 68, 0.12)';
      detectedContainerNotice.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      detectedContainerNotice.style.color = '#FCA5A5';
      detectedNoticeText.textContent = 'Chrome system pages cannot be captured';
      btnStartRecording.disabled = true;
      btnStartRecording.style.opacity = '0.5';
      return;
    }

    // Ping content script to detect mobile container
    chrome.tabs.sendMessage(activeTab.id, { action: ACTIONS.DETECT_MOBILE }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script might not be injected yet
        return;
      }
      if (response && response.isMobile && currentCropMode === CROP_MODES.AUTO) {
        detectedContainerNotice.classList.remove('hidden');
        const w = Math.round(response.rect?.width || 0);
        const h = Math.round(response.rect?.height || 0);
        const label = response.type === 'manual' ? 'Custom frame' : (response.type === 'viewport' ? 'Mobile viewport' : 'Isolated app frame');
        detectedNoticeText.textContent = `${label} detected (${w}×${h}px)`;
      } else {
        detectedContainerNotice.classList.add('hidden');
      }
    });
  } catch (err) {
    console.warn('[Popup] inspectActiveTab error:', err);
  }
}

// Initialize popup settings and event listeners
async function initPopup() {
  const settings = await getSettings();
  currentResolution = settings.resolution || '1080p';
  currentCropMode = settings.cropMode || CROP_MODES.AUTO;

  // Apply Resolution
  resolutionPicker.querySelectorAll('.segment-btn').forEach((btn) => {
    const isTarget = btn.dataset.resolution === currentResolution;
    btn.classList.toggle('active', isTarget);
    btn.setAttribute('aria-checked', isTarget ? 'true' : 'false');
  });

  // Apply Crop Mode
  cropModeGrid.querySelectorAll('.crop-option').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.mode === currentCropMode);
  });

  // Apply Mic
  micCheckbox.checked = !!settings.recordMic;
  micSubtext.textContent = micCheckbox.checked ? 'Enabled for recording' : 'Voiceover commentary';

  // Apply In-Tab Controls
  pillCheckbox.checked = settings.showFloatingControls !== false;
  pillSubtext.textContent = pillCheckbox.checked ? 'Show timer & buttons on page' : 'Hidden (Clean recording, control via icon)';

  // Check current status from service worker
  chrome.runtime.sendMessage({ action: ACTIONS.GET_STATUS }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setView(STATUS.IDLE);
    } else {
      setView(response.status || STATUS.IDLE, response);
    }
  });

  await inspectActiveTab();
}

// Resolution Selection
resolutionPicker.addEventListener('click', async (e) => {
  const btn = e.target.closest('.segment-btn');
  if (!btn) return;
  const resolution = btn.dataset.resolution;
  currentResolution = resolution;

  resolutionPicker.querySelectorAll('.segment-btn').forEach((b) => {
    const isTarget = b === btn;
    b.classList.toggle('active', isTarget);
    b.setAttribute('aria-checked', isTarget ? 'true' : 'false');
  });

  await saveSettings({ resolution });
});

// Crop Mode Selection
cropModeGrid.addEventListener('click', async (e) => {
  const opt = e.target.closest('.crop-option');
  if (!opt) return;
  const mode = opt.dataset.mode;

  if (mode === CROP_MODES.MANUAL) {
    // Trigger visual element picker in active tab and close popup
    const tab = await getTargetTab();
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: ACTIONS.START_PICKER });
      window.close();
      return;
    }
  }

  currentCropMode = mode;
  cropModeGrid.querySelectorAll('.crop-option').forEach((o) => {
    o.classList.toggle('active', o === opt);
  });

  if (mode === CROP_MODES.AUTO) {
    inspectActiveTab();
  } else {
    detectedContainerNotice.classList.add('hidden');
  }

  await saveSettings({ cropMode: mode });
});

// Mic toggle
micCheckbox.addEventListener('change', async () => {
  const enabled = micCheckbox.checked;
  micSubtext.textContent = enabled ? 'Enabled for recording' : 'Voiceover commentary';
  await saveSettings({ recordMic: enabled });
});

micToggleCard.addEventListener('click', (e) => {
  if (e.target !== micCheckbox) {
    micCheckbox.checked = !micCheckbox.checked;
    micCheckbox.dispatchEvent(new Event('change'));
  }
});

// In-Tab Controls toggle
pillCheckbox.addEventListener('change', async () => {
  const enabled = pillCheckbox.checked;
  pillSubtext.textContent = enabled ? 'Show timer & buttons on page' : 'Hidden (Clean recording, control via icon)';
  await saveSettings({ showFloatingControls: enabled });
});

pillToggleCard.addEventListener('click', (e) => {
  if (e.target !== pillCheckbox) {
    pillCheckbox.checked = !pillCheckbox.checked;
    pillCheckbox.dispatchEvent(new Event('change'));
  }
});

// Start Recording
btnStartRecording.addEventListener('click', async () => {
  btnStartRecording.disabled = true;
  btnStartRecording.style.opacity = '0.7';

  const resetBtn = () => {
    btnStartRecording.disabled = false;
    btnStartRecording.style.opacity = '1';
  };

  try {
    const activeTab = await getTargetTab();
    if (!activeTab || !activeTab.id) {
      alert('Unable to capture: No active tab found. Please focus the webpage tab you want to record.');
      resetBtn();
      return;
    }

    if (isRestrictedUrl(activeTab.url)) {
      alert('Browser system pages cannot be recorded. Please navigate to a standard web page or your localhost app (e.g. http://localhost:5173/) to record.');
      resetBtn();
      return;
    }

    // Capture user gesture token directly in popup before passing to service worker
    chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        const errorMsg = chrome.runtime.lastError?.message || 'Failed to acquire tab capture stream ID';
        console.error('[Popup] getMediaStreamId error:', errorMsg);
        alert(`Capture error: ${errorMsg}`);
        resetBtn();
        return;
      }

      chrome.runtime.sendMessage(
        {
          action: ACTIONS.START_RECORDING,
          streamId,
          tabId: activeTab.id,
          tabTitle: activeTab.title,
          resolution: currentResolution,
          cropMode: currentCropMode,
          recordMic: micCheckbox.checked,
          showFloatingControls: pillCheckbox.checked
        },
        (res) => {
          resetBtn();

          if (chrome.runtime.lastError || (res && res.error)) {
            const errorMsg = res?.error || chrome.runtime.lastError?.message || 'Failed to start recording';
            console.error('[Popup] Start error:', errorMsg);
            alert(`Recording error: ${errorMsg}`);
            return;
          }

          setView(STATUS.RECORDING, {
            resolution: currentResolution,
            cropMode: currentCropMode,
            startTime: res?.startTime || Date.now()
          });
        }
      );
    });
  } catch (err) {
    console.error('[Popup] Exception starting recording:', err);
    alert(`Start error: ${err.message}`);
    resetBtn();
  }
});

// Pause / Resume
btnPauseResume.addEventListener('click', () => {
  const isPaused = statusBadge.classList.contains('paused');
  const action = isPaused ? ACTIONS.RESUME_RECORDING : ACTIONS.PAUSE_RECORDING;

  chrome.runtime.sendMessage({ action }, (res) => {
    if (res && res.status) {
      setView(res.status, res);
    }
  });
});

// Stop Recording
btnStopRecording.addEventListener('click', () => {
  setView(STATUS.SAVING);
  chrome.runtime.sendMessage({ action: ACTIONS.STOP_RECORDING });
});

// Listen for background updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === ACTIONS.STATUS_UPDATE) {
    setView(message.status, message);
  } else if (message.action === ACTIONS.RECORDING_COMPLETE) {
    setView(STATUS.IDLE);
  } else if (message.action === ACTIONS.RECORDING_ERROR) {
    alert(`Recording issue: ${message.error}`);
    setView(STATUS.IDLE);
  }
});

document.addEventListener('DOMContentLoaded', initPopup);
