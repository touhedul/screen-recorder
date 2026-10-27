import { ACTIONS, RESOLUTIONS } from '../utils/constants.js';
import { fixWebmDuration } from '../utils/webm-fixer.js';

let mediaRecorder = null;
let activeStreams = [];
let audioContext = null;
let renderTimer = null;
let recordedChunks = [];
let recordingStartTime = 0;
let finalDurationMs = 0;
let isRecordingActive = false;

const videoEl = document.getElementById('tabVideo');
const canvasEl = document.getElementById('cropCanvas');
const ctx = canvasEl.getContext('2d', { alpha: false });

// Choose best supported MIME type based on whether audio track is actually present
function getSupportedMimeType(hasAudio = true) {
  const candidatesWithAudio = [
    { mime: 'video/webm;codecs=vp9,opus', format: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', format: 'webm' },
    { mime: 'video/webm', format: 'webm' },
    { mime: 'video/mp4;codecs=avc1,mp4a', format: 'mp4' },
    { mime: 'video/mp4', format: 'mp4' }
  ];

  const candidatesVideoOnly = [
    { mime: 'video/webm;codecs=vp9', format: 'webm' },
    { mime: 'video/webm;codecs=vp8', format: 'webm' },
    { mime: 'video/webm', format: 'webm' },
    { mime: 'video/mp4;codecs=avc1', format: 'mp4' },
    { mime: 'video/mp4', format: 'mp4' }
  ];

  const candidates = hasAudio ? candidatesWithAudio : candidatesVideoOnly;

  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) {
      return c;
    }
  }

  return { mime: '', format: 'webm' };
}

// Start Recording Pipeline
async function startRecording(params) {
  const {
    streamId,
    resolution = '1080p',
    cropMode = 'AUTO',
    cropRect,
    viewport,
    recordMic = false,
    tabTitle = 'tab'
  } = params;

  try {
    console.log('[Offscreen] Starting recording with streamId:', streamId);

    // 1. Capture raw tab stream with fallback
    let tabStream = null;
    try {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
            maxFrameRate: 60
          }
        }
      });
    } catch (tabAudioErr) {
      console.warn('[Offscreen] Audio+Video capture failed, falling back to video-only capture:', tabAudioErr);
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
            maxFrameRate: 60
          }
        }
      });
    }

    activeStreams.push(tabStream);

    // 2. Capture microphone if enabled
    let micStream = null;
    if (recordMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        activeStreams.push(micStream);
      } catch (micErr) {
        console.warn('[Offscreen] Microphone permission denied or unavailable:', micErr);
      }
    }

    // 3. Audio Mixing & Tab Audio Passthrough (so tab remains audible to user)
    let combinedAudioStream = null;
    const hasTabAudio = tabStream.getAudioTracks().length > 0;
    const hasMicAudio = micStream && micStream.getAudioTracks().length > 0;

    if (hasTabAudio || hasMicAudio) {
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') {
          await audioContext.resume().catch(() => {});
        }
        const destination = audioContext.createMediaStreamDestination();

        if (hasTabAudio) {
          try {
            const tabSource = audioContext.createMediaStreamSource(tabStream);
            tabSource.connect(destination);
            // Connect to audioContext.destination so capturing does not mute the tab locally
            tabSource.connect(audioContext.destination);
          } catch (tabRouteErr) {
            console.warn('[Offscreen] Tab audio routing note:', tabRouteErr);
          }
        }

        if (hasMicAudio) {
          try {
            const micSource = audioContext.createMediaStreamSource(micStream);
            micSource.connect(destination);
          } catch (micRouteErr) {
            console.warn('[Offscreen] Mic audio routing note:', micRouteErr);
          }
        }

        combinedAudioStream = destination.stream;
      } catch (audioMixErr) {
        console.warn('[Offscreen] AudioContext setup error:', audioMixErr);
        if (hasTabAudio) {
          combinedAudioStream = new MediaStream(tabStream.getAudioTracks());
        }
      }
    }

    // 4. Video Source & Dimension Inspection
    videoEl.srcObject = tabStream;
    await new Promise((resolve) => {
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        resolve();
      } else {
        videoEl.onloadedmetadata = () => resolve();
        setTimeout(resolve, 800);
      }
    });

    try {
      await videoEl.play();
    } catch (playErr) {
      console.warn('[Offscreen] video.play() note:', playErr);
    }

    const resConfig = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];
    const vpW = (viewport && viewport.width > 0) ? viewport.width : (videoEl.videoWidth || 1920);
    const vpH = (viewport && viewport.height > 0) ? viewport.height : (videoEl.videoHeight || 1080);

    // Check if cropping or canvas scaling should be active
    const isCropModeRequested = cropMode !== 'OFF';
    const isViewportMobile = cropRect && (cropRect.width <= 850 || vpW <= 850);
    const hasSpecificSubRect = cropRect && (
      cropRect.width < vpW - 20 ||
      cropRect.height < vpH - 20
    );

    const isCropping = isCropModeRequested && (hasSpecificSubRect || isViewportMobile);

    let outputStream = null;

    if (!isCropping) {
      // Full tab recording: Use tabStream video directly for maximum efficiency and zero frame drops
      console.log('[Offscreen] Full tab recording mode: Using direct native tab stream');
      outputStream = new MediaStream();
      tabStream.getVideoTracks().forEach((track) => outputStream.addTrack(track));
    } else {
      // Mobile Mode Crop & Scale: Setup canvas render loop
      const subW = (cropRect && cropRect.width > 50) ? cropRect.width : vpW;
      const subH = (cropRect && cropRect.height > 50) ? cropRect.height : vpH;
      const cropAspect = subW / subH;

      let targetW, targetH;
      if (cropAspect <= 0.65) {
        // Tall portrait phone orientation (e.g., 9:16)
        targetH = (resolution === '720p') ? 1280 : 1920;
        targetW = Math.round(targetH * cropAspect);
      } else if (cropAspect >= 1.5) {
        // Landscape orientation
        targetW = (resolution === '720p') ? 1280 : 1920;
        targetH = Math.round(targetW / cropAspect);
      } else {
        // Centered app frame / chat window / tablet / square responsive (e.g., 600x600)
        targetH = (resolution === '720p') ? 720 : 1080;
        targetW = Math.round(targetH * cropAspect);
        const maxBoundW = (resolution === '720p') ? 1280 : 1920;
        if (targetW > maxBoundW) {
          targetW = maxBoundW;
          targetH = Math.round(targetW / cropAspect);
        }
      }

      // Ensure even pixel dimensions for video encoders
      if (targetW % 2 !== 0) targetW += 1;
      if (targetH % 2 !== 0) targetH += 1;

      canvasEl.width = Math.max(2, targetW);
      canvasEl.height = Math.max(2, targetH);

      console.log(`[Offscreen] Crop mode active: Source (${videoEl.videoWidth}×${videoEl.videoHeight}) -> Canvas (${canvasEl.width}×${canvasEl.height}, Aspect: ${cropAspect.toFixed(2)})`);

      isRecordingActive = true;
      const drawFrame = () => {
        if (!isRecordingActive) return;
        try {
          const curVidW = videoEl.videoWidth;
          const curVidH = videoEl.videoHeight;

          if (curVidW > 0 && curVidH > 0) {
            const scaleX = curVidW / vpW;
            const scaleY = curVidH / vpH;

            const rx = (cropRect && cropRect.x >= 0) ? cropRect.x : 0;
            const ry = (cropRect && cropRect.y >= 0) ? cropRect.y : 0;
            const rw = (cropRect && cropRect.width > 0) ? cropRect.width : vpW;
            const rh = (cropRect && cropRect.height > 0) ? cropRect.height : vpH;

            const sx = Math.max(0, Math.min(Math.floor(rx * scaleX), curVidW - 1));
            const sy = Math.max(0, Math.min(Math.floor(ry * scaleY), curVidH - 1));
            const sw = Math.max(1, Math.min(Math.floor(rw * scaleX), curVidW - sx));
            const sh = Math.max(1, Math.min(Math.floor(rh * scaleY), curVidH - sy));

            ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvasEl.width, canvasEl.height);
          }
        } catch (drawErr) {
          console.warn('[Offscreen] Canvas draw error:', drawErr);
        }
      };

      drawFrame();
      // Use setInterval (30 FPS) for continuous, unthrottled frames in offscreen context
      renderTimer = setInterval(drawFrame, 1000 / 30);

      outputStream = canvasEl.captureStream(30);
    }

    // Add audio tracks to output stream if present
    if (combinedAudioStream && combinedAudioStream.getAudioTracks().length > 0) {
      combinedAudioStream.getAudioTracks().forEach((track) => {
        outputStream.addTrack(track);
      });
    }

    // 5. Initialize MediaRecorder
    const hasAudio = outputStream.getAudioTracks().length > 0;
    const chosenType = getSupportedMimeType(hasAudio);
    console.log(`[Offscreen] Using MIME type: "${chosenType.mime}" (format: ${chosenType.format}, hasAudio: ${hasAudio})`);

    const recorderOptions = {
      videoBitsPerSecond: resConfig.videoBitrate
    };
    if (chosenType.mime) {
      recorderOptions.mimeType = chosenType.mime;
    }

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(outputStream, recorderOptions);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
        console.log(`[Offscreen] Chunk received: ${event.data.size} bytes (Total chunks: ${recordedChunks.length})`);
      }
    };

    mediaRecorder.onerror = (recErr) => {
      console.error('[Offscreen] MediaRecorder runtime error:', recErr);
      chrome.runtime.sendMessage({
        action: ACTIONS.RECORDING_ERROR,
        error: recErr?.error?.message || 'MediaRecorder encountered a runtime error'
      }).catch(() => {});
    };

    mediaRecorder.onstop = async () => {
      console.log('[Offscreen] MediaRecorder stopped. Assembling recording...');
      finalDurationMs = Date.now() - recordingStartTime;
      await finalizeAndDownload(chosenType.format, tabTitle);
    };

    recordingStartTime = Date.now();
    isRecordingActive = true;

    // Request data every 1000ms
    mediaRecorder.start(1000);

    return {
      success: true,
      startTime: recordingStartTime,
      format: chosenType.format
    };
  } catch (err) {
    console.error('[Offscreen] startRecording failed:', err);
    cleanupStreams();
    throw err;
  }
}

// Finalize chunks and export
async function finalizeAndDownload(format, tabTitle) {
  try {
    if (recordedChunks.length === 0) {
      console.error('[Offscreen] No recorded chunks available.');
      chrome.runtime.sendMessage({
        action: ACTIONS.RECORDING_ERROR,
        error: 'No video frames were captured. Please try recording again.'
      });
      cleanupStreams();
      return;
    }

    let finalBlob = new Blob(recordedChunks, {
      type: format === 'mp4' ? 'video/mp4' : 'video/webm'
    });
    console.log(`[Offscreen] Total recorded file size: ${finalBlob.size} bytes`);

    // Patch duration header if WebM format
    if (format === 'webm' && finalDurationMs > 0) {
      try {
        finalBlob = await fixWebmDuration(finalBlob, finalDurationMs);
      } catch (patchErr) {
        console.warn('[Offscreen] WebM duration patching warning:', patchErr);
      }
    }

    const safeTitle = (tabTitle || 'recording')
      .replace(/[^a-z0-9_-]/gi, '_')
      .substring(0, 30);
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `AeroRecord_${safeTitle}_${dateStr}.${format}`;

    // Create fast, lightweight Blob URL
    const blobUrl = URL.createObjectURL(finalBlob);

    // Send blobUrl to service worker for single chrome.downloads download
    chrome.runtime.sendMessage({
      action: 'DOWNLOAD_RECORDING',
      url: blobUrl,
      filename
    });
  } catch (err) {
    console.error('[Offscreen] finalizeAndDownload error:', err);
    chrome.runtime.sendMessage({
      action: ACTIONS.RECORDING_ERROR,
      error: err.message
    });
    cleanupStreams();
  }
}

// Pause / Resume
function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    console.log('[Offscreen] Recording paused');
  }
}

function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    console.log('[Offscreen] Recording resumed');
  }
}

// Stop Recording
function stopRecording() {
  isRecordingActive = false;
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanupStreams();
  }
}

// Clean up resources
function cleanupStreams() {
  isRecordingActive = false;
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }

  activeStreams.forEach((stream) => {
    stream.getTracks().forEach((t) => t.stop());
  });
  activeStreams = [];

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }

  videoEl.srcObject = null;
  mediaRecorder = null;
}

// Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === ACTIONS.OFFSCREEN_READY) {
    sendResponse({ success: true, ready: true });
    return false;
  } else if (request.action === ACTIONS.START_RECORDING) {
    startRecording(request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  } else if (request.action === ACTIONS.STOP_RECORDING) {
    stopRecording();
    sendResponse({ success: true });
    return true;
  } else if (request.action === ACTIONS.PAUSE_RECORDING) {
    pauseRecording();
    sendResponse({ success: true });
    return true;
  } else if (request.action === ACTIONS.RESUME_RECORDING) {
    resumeRecording();
    sendResponse({ success: true });
    return true;
  }
});

// Announce offscreen ready state immediately upon module load
chrome.runtime.sendMessage({ action: ACTIONS.OFFSCREEN_READY }).catch(() => {});
