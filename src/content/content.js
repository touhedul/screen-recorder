// AeroRecord Content Script
(function () {
  if (window.__AERORECORD_INJECTED__) return;
  window.__AERORECORD_INJECTED__ = true;

  const ACTIONS = {
    START_RECORDING: 'START_RECORDING',
    STOP_RECORDING: 'STOP_RECORDING',
    PAUSE_RECORDING: 'PAUSE_RECORDING',
    RESUME_RECORDING: 'RESUME_RECORDING',
    DETECT_MOBILE: 'DETECT_MOBILE',
    GET_CROP_BOUNDS: 'GET_CROP_BOUNDS',
    START_PICKER: 'START_PICKER',
    CANCEL_PICKER: 'CANCEL_PICKER',
    CONTAINER_SELECTED: 'CONTAINER_SELECTED',
    STATUS_UPDATE: 'STATUS_UPDATE',
    RECORDING_COMPLETE: 'RECORDING_COMPLETE'
  };

  let manualCropElement = null;
  let isPickerActive = false;
  let pickerOverlay = null;
  let pickerBadge = null;
  let highlightOverlay = null;
  let highlightBadge = null;
  let highlightTimeout = null;
  let floatingPill = null;
  let pillTimerInterval = null;
  let recordingStartTime = 0;
  let accumulatedPausedTime = 0;
  let isPaused = false;

  // --- Scored Centered Container & Frame Detection ---
  function findBestContainer() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // 1. Check if DevTools mobile emulation or narrow window is active
    if (w <= 850) {
      return {
        type: 'viewport',
        rect: { left: 0, top: 0, width: w, height: h, right: w, bottom: h },
        score: 1000
      };
    }

    // 2. Check manual selection
    if (manualCropElement && document.contains(manualCropElement)) {
      const r = manualCropElement.getBoundingClientRect();
      return {
        type: 'manual',
        rect: r,
        score: 2000
      };
    }

    // 3. Scan DOM for centered containers, chat frames, resizable mockups, preview boxes
    const elements = document.querySelectorAll(
      'main, article, section, [class*="chat"], [class*="gpt"], [class*="resize"], [class*="preview"], [class*="mobile"], [class*="phone"], [class*="container"], [class*="window"], [class*="card"], [class*="box"], [class*="app"], [id*="chat"], [id*="app"], [id*="preview"], div'
    );

    let candidates = [];

    for (const el of elements) {
      // Exclude body, html, root wrapper, or AeroRecord overlays
      if (
        el === document.body ||
        el === document.documentElement ||
        el.id === 'root' ||
        el.id?.startsWith('aerorecord')
      ) {
        continue;
      }

      const r = el.getBoundingClientRect();

      // Must have visible dimensions
      if (r.width < 280 || r.height < 200) continue;

      const leftGutter = r.left;
      const rightGutter = w - r.right;

      // Must have side gutters (not edge-to-edge full width)
      if (leftGutter < 12 || rightGutter < 12) continue;

      // Must be reasonably centered horizontally
      const gutterDiff = Math.abs(leftGutter - rightGutter);
      if (gutterDiff > 160) continue;

      let score = 120 - gutterDiff; // Higher score for better centering

      // Typical container width for chat/mobile/web previews (340px to 1150px)
      if (r.width >= 340 && r.width <= 1150) {
        score += 70;
      }

      // Significant height coverage
      const heightRatio = r.height / h;
      if (heightRatio >= 0.4 && heightRatio <= 1.05) {
        score += 60;
      }

      // Keyword bonuses
      const classIdText = (el.className + ' ' + el.id).toLowerCase();
      if (classIdText.includes('chat') || classIdText.includes('gpt')) score += 100;
      if (classIdText.includes('resize')) score += 80;
      if (classIdText.includes('preview') || classIdText.includes('mobile') || classIdText.includes('phone') || classIdText.includes('device')) score += 90;
      if (classIdText.includes('window') || classIdText.includes('app') || classIdText.includes('container')) score += 40;

      // Check for resize handles inside or on element
      if (
        el.querySelector('[class*="handle"], [class*="resize"], [class*="grip"]') ||
        el.textContent.includes('==') ||
        el.textContent.includes('//')
      ) {
        score += 75;
      }

      // Visual styling bonuses
      try {
        const style = window.getComputedStyle(el);
        if (style.borderRadius && parseInt(style.borderRadius) >= 4) score += 30;
        if (style.boxShadow && style.boxShadow !== 'none') score += 30;
        if (style.borderWidth && parseInt(style.borderWidth) > 0) score += 20;
      } catch (styleErr) {}

      candidates.push({ el, rect: r, score });
    }

    if (candidates.length === 0) return null;

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // If candidate has parent with high score, prefer the outer frame (contains top bar / handles)
    let best = candidates[0];
    for (let i = 1; i < Math.min(candidates.length, 6); i++) {
      const cand = candidates[i];
      if (cand.el.contains(best.el) && cand.score >= best.score - 50) {
        best = cand;
      }
    }

    return {
      type: 'auto-container',
      rect: best.rect,
      el: best.el,
      score: best.score
    };
  }

  // --- Mobile Mode Detection ---
  function detectMobileContainer() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const match = findBestContainer();

    if (match) {
      return {
        isMobile: true,
        type: match.type,
        rect: {
          x: Math.round(match.rect.left),
          y: Math.round(match.rect.top),
          width: Math.round(match.rect.width),
          height: Math.round(match.rect.height)
        },
        viewport: { width: w, height: h, dpr: window.devicePixelRatio || 1 }
      };
    }

    return {
      isMobile: false,
      type: 'full',
      rect: { x: 0, y: 0, width: w, height: h },
      viewport: { width: w, height: h, dpr: window.devicePixelRatio || 1 }
    };
  }

  // --- Temporary Visual Outline for Detected Container ---
  function flashHighlight(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    if (rect.width >= window.innerWidth - 20) return; // Don't flash if full width

    if (!highlightOverlay) {
      highlightOverlay = document.createElement('div');
      highlightOverlay.id = 'aerorecord-detected-highlight';

      highlightBadge = document.createElement('div');
      highlightBadge.id = 'aerorecord-highlight-badge';
      highlightBadge.textContent = 'AeroRecord: Detected Area';
      highlightOverlay.appendChild(highlightBadge);

      document.documentElement.appendChild(highlightOverlay);
    }

    highlightOverlay.style.top = `${rect.y}px`;
    highlightOverlay.style.left = `${rect.x}px`;
    highlightOverlay.style.width = `${rect.width}px`;
    highlightOverlay.style.height = `${rect.height}px`;
    highlightOverlay.style.opacity = '1';
    highlightOverlay.style.display = 'block';

    if (highlightTimeout) clearTimeout(highlightTimeout);
    highlightTimeout = setTimeout(() => {
      if (highlightOverlay) {
        highlightOverlay.style.opacity = '0';
        setTimeout(() => {
          if (highlightOverlay) highlightOverlay.style.display = 'none';
        }, 400);
      }
    }, 2500);
  }

  // --- Interactive Element Picker ---
  function startPicker() {
    if (isPickerActive) return;
    isPickerActive = true;

    if (!pickerOverlay) {
      pickerOverlay = document.createElement('div');
      pickerOverlay.id = 'aerorecord-picker-overlay';

      pickerBadge = document.createElement('div');
      pickerBadge.id = 'aerorecord-picker-badge';
      pickerBadge.textContent = 'Click to record this frame (Esc to cancel)';
      pickerOverlay.appendChild(pickerBadge);

      document.documentElement.appendChild(pickerOverlay);
    }

    pickerOverlay.style.display = 'block';

    const handleMouseMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (
        !target ||
        target === pickerOverlay ||
        target === pickerBadge ||
        target.id?.startsWith('aerorecord')
      ) {
        return;
      }

      const rect = target.getBoundingClientRect();
      pickerOverlay.style.top = `${rect.top}px`;
      pickerOverlay.style.left = `${rect.left}px`;
      pickerOverlay.style.width = `${rect.width}px`;
      pickerOverlay.style.height = `${rect.height}px`;

      pickerBadge.textContent = `Select frame: ${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    };

    const handleClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && !target.id?.startsWith('aerorecord')) {
        manualCropElement = target;
        const rect = target.getBoundingClientRect();

        chrome.runtime.sendMessage({
          action: ACTIONS.CONTAINER_SELECTED,
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio || 1
          }
        });

        flashHighlight({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });

        showToast(`Frame selected: ${Math.round(rect.width)} × ${Math.round(rect.height)}px. Ready to record!`);
      }
      stopPicker();
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        stopPicker();
        showToast('Frame picker cancelled');
      }
    };

    function stopPicker() {
      isPickerActive = false;
      if (pickerOverlay) pickerOverlay.style.display = 'none';
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    }

    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
  }

  // --- Toast Notification ---
  function showToast(msg) {
    const existing = document.getElementById('aerorecord-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'aerorecord-toast';
    toast.innerHTML = `<span>⚡</span><span>${msg}</span>`;
    document.documentElement.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // --- Floating In-Tab Control Pill ---
  function formatSeconds(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function showFloatingPill(startTime, pausedDuration = 0) {
    removeFloatingPill();
    recordingStartTime = startTime || Date.now();
    accumulatedPausedTime = pausedDuration;
    isPaused = false;

    floatingPill = document.createElement('div');
    floatingPill.id = 'aerorecord-floating-pill';
    floatingPill.innerHTML = `
      <div class="aerorecord-pill-rec">
        <div class="aerorecord-pill-dot-wrap">
          <span class="aerorecord-pill-ring"></span>
          <span class="aerorecord-pill-dot"></span>
        </div>
        <span class="aerorecord-pill-timer" id="aerorecord-pill-timer-text">00:00</span>
      </div>
      <div class="aerorecord-pill-divider"></div>
      <div class="aerorecord-pill-actions">
        <button type="button" class="aerorecord-pill-btn" id="aerorecord-pill-btn-pause" title="Pause / Resume">Pause</button>
        <button type="button" class="aerorecord-pill-btn stop" id="aerorecord-pill-btn-stop" title="Stop & Save">Stop</button>
        <button type="button" class="aerorecord-pill-btn close" id="aerorecord-pill-btn-close" title="Hide controls from recording">✕</button>
      </div>
    `;

    document.documentElement.appendChild(floatingPill);

    const timerEl = floatingPill.querySelector('#aerorecord-pill-timer-text');
    const btnPause = floatingPill.querySelector('#aerorecord-pill-btn-pause');
    const btnStop = floatingPill.querySelector('#aerorecord-pill-btn-stop');
    const btnClose = floatingPill.querySelector('#aerorecord-pill-btn-close');

    // Make Draggable across the window/margins
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let pillStartX = 0;
    let pillStartY = 0;

    floatingPill.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = floatingPill.getBoundingClientRect();
      pillStartX = rect.left;
      pillStartY = rect.top;

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        const dx = moveEvent.clientX - dragStartX;
        const dy = moveEvent.clientY - dragStartY;
        // Allow moving to any gutter, margin, or corner
        const newX = Math.max(-100, Math.min(window.innerWidth - 40, pillStartX + dx));
        const newY = Math.max(0, Math.min(window.innerHeight - 30, pillStartY + dy));
        floatingPill.style.left = `${newX}px`;
        floatingPill.style.top = `${newY}px`;
        floatingPill.style.right = 'auto';
        floatingPill.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    // Dismiss / Hide controls from page
    btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFloatingPill();
      showToast('In-tab controls hidden. Click AeroRecord in Chrome toolbar to pause or stop.');
    });

    // Timer loop
    pillTimerInterval = setInterval(() => {
      if (!isPaused) {
        const elapsedSec = Math.floor((Date.now() - recordingStartTime - accumulatedPausedTime) / 1000);
        timerEl.textContent = formatSeconds(elapsedSec);
      }
    }, 500);

    // Pause / Resume
    btnPause.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = isPaused ? ACTIONS.RESUME_RECORDING : ACTIONS.PAUSE_RECORDING;
      chrome.runtime.sendMessage({ action });
    });

    // Stop
    btnStop.addEventListener('click', (e) => {
      e.stopPropagation();
      btnStop.textContent = 'Saving...';
      btnStop.style.opacity = '0.7';
      btnStop.disabled = true;
      chrome.runtime.sendMessage({ action: ACTIONS.STOP_RECORDING });
    });
  }

  function updateFloatingPillState(status) {
    if (!floatingPill) return;
    const btnPause = floatingPill.querySelector('#aerorecord-pill-btn-pause');
    const dot = floatingPill.querySelector('.aerorecord-pill-dot');
    const ring = floatingPill.querySelector('.aerorecord-pill-ring');

    if (status === 'PAUSED') {
      isPaused = true;
      if (btnPause) btnPause.textContent = 'Resume';
      if (dot) dot.style.background = '#F59E0B';
      if (ring) ring.style.display = 'none';
    } else if (status === 'RECORDING') {
      isPaused = false;
      if (btnPause) btnPause.textContent = 'Pause';
      if (dot) dot.style.background = '#EF4444';
      if (ring) ring.style.display = 'block';
    }
  }

  function removeFloatingPill() {
    if (pillTimerInterval) {
      clearInterval(pillTimerInterval);
      pillTimerInterval = null;
    }
    if (floatingPill) {
      floatingPill.remove();
      floatingPill = null;
    }
  }

  // --- Compositor Repaint Heartbeat ---
  // On idle or static pages (like localhost apps with no ongoing animations), Chromium's
  // compositor suppresses tab frames. A sub-pixel repaint heartbeat ensures continuous frame delivery.
  let repaintElement = null;
  let repaintRaf = null;

  function startRepaintHeartbeat() {
    if (repaintElement) return;
    repaintElement = document.createElement('div');
    repaintElement.id = 'aerorecord-repaint-heartbeat';
    repaintElement.style.cssText =
      'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483647;';
    document.documentElement.appendChild(repaintElement);

    let flip = false;
    function nudge() {
      if (!repaintElement) return;
      flip = !flip;
      repaintElement.style.transform = flip ? 'translateZ(0)' : 'translateZ(1px)';
      repaintRaf = requestAnimationFrame(nudge);
    }
    nudge();
  }

  function stopRepaintHeartbeat() {
    if (repaintRaf) {
      cancelAnimationFrame(repaintRaf);
      repaintRaf = null;
    }
    if (repaintElement) {
      repaintElement.remove();
      repaintElement = null;
    }
  }

  // --- Message Listener ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case ACTIONS.DETECT_MOBILE: {
        const result = detectMobileContainer();
        if (result && result.isMobile && result.rect) {
          flashHighlight(result.rect);
        }
        sendResponse(result);
        return false;
      }

      case ACTIONS.GET_CROP_BOUNDS: {
        const result = detectMobileContainer();
        sendResponse(result);
        return false;
      }

      case ACTIONS.START_PICKER: {
        startPicker();
        sendResponse({ success: true });
        return false;
      }

      case ACTIONS.STATUS_UPDATE: {
        if (request.status === 'RECORDING') {
          startRepaintHeartbeat();
          if (request.showFloatingControls !== false) {
            showFloatingPill(request.startTime, request.accumulatedPausedTime);
            updateFloatingPillState('RECORDING');
          } else {
            removeFloatingPill();
          }
        } else if (request.status === 'PAUSED') {
          updateFloatingPillState('PAUSED');
        } else if (request.status === 'IDLE' || request.status === 'SAVING') {
          stopRepaintHeartbeat();
          removeFloatingPill();
        }
        sendResponse({ success: true });
        return false;
      }

      case ACTIONS.RECORDING_COMPLETE: {
        stopRepaintHeartbeat();
        removeFloatingPill();
        showToast('Recording saved to your Downloads folder!');
        sendResponse({ success: true });
        return false;
      }

      default:
        return false;
    }
  });
})();
