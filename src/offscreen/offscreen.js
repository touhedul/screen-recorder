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

// Choose best supported MIME type
function getSupportedMimeType() {
  const candidates = [
    { mime: 'video/webm;codecs=vp9,opus', format: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', format: 'webm' },
    { mime: 'video/webm', format: 'webm' },
    { mime: 'video/mp4;codecs=avc1,mp4a', format: 'mp4' },
    { mime: 'video/mp4', format: 'mp4' }
  ];

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

    // 3. Audio Mixing
    let combinedAudioStream = null;
    if (micStream && micStream.getAudioTracks().length > 0) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      const destination = audioContext.createMediaStreamDestination();

      if (tabStream.getAudioTracks().length > 0) {
        const tabSource = audioContext.createMediaStreamSource(tabStream);
        tabSource.connect(destination);
      }

      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(destination);

      combinedAudioStream = destination.stream;
    } else if (tabStream.getAudioTracks().length > 0) {
      combinedAudioStream = new MediaStream(tabStream.getAudioTracks());
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

    const videoW = videoEl.videoWidth || 1920;
    const videoH = videoEl.videoHeight || 1080;
    const vpW = viewport?.width || videoW;
    const vpH = viewport?.height || videoH;

    const resConfig = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];

    // Check if real cropping is active
    const isCropping =
      cropMode !== 'OFF' &&
      cropRect &&
      cropRect.width > 50 &&
      cropRect.height > 50 &&
      (cropRect.width < vpW - 20 || cropRect.height < vpH - 20);

    let outputStream = null;

    if (!isCropping) {
      // Full tab recording: Use tabStream video directly for maximum efficiency and zero frame drops
      console.log('[Offscreen] Full tab recording mode: Using direct native tab stream');
      outputStream = new MediaStream();
      tabStream.getVideoTracks().forEach((track) => outputStream.addTrack(track));
    } else {
      // Mobile Mode Crop: Setup canvas render loop with reliable setInterval timer
      const scaleX = videoW / vpW;
      const scaleY = videoH / vpH;

      const sx = Math.max(0, Math.floor(cropRect.x * scaleX));
      const sy = Math.max(0, Math.floor(cropRect.y * scaleY));
      const sw = Math.min(Math.floor(cropRect.width * scaleX), videoW - sx);
      const sh = Math.min(Math.floor(cropRect.height * scaleY), videoH - sy);

      const cropAspect = sw / sh;
      let targetW, targetH;

      if (cropAspect <= 0.65) {
        // Tall portrait phone orientation (e.g., 9:16)
        targetH = (resolution === '720p') ? 1280 : 1920;
        targetW = Math.round(targetH * cropAspect);
      } else {
        // Centered app frame / chat window / tablet orientation
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

      canvasEl.width = targetW;
      canvasEl.height = targetH;

      console.log(`[Offscreen] Crop mode active: Source (${videoW}×${videoH}) -> Sub-rect (${sx},${sy},${sw},${sh}) -> Canvas (${targetW}×${targetH})`);

      isRecordingActive = true;
      const drawFrame = () => {
        if (!isRecordingActive) return;
        try {
          ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvasEl.width, canvasEl.height);
        } catch (drawErr) {
          console.warn('[Offscreen] Canvas draw error:', drawErr);
        }
      };

      drawFrame();
      // Use setInterval (30 FPS) for continuous, unthrottled frames in offscreen context
      renderTimer = setInterval(drawFrame, 1000 / 30);

      outputStream = canvasEl.captureStream(30);
    }

    // Add audio tracks to output stream
    if (combinedAudioStream) {
      combinedAudioStream.getAudioTracks().forEach((track) => {
        outputStream.addTrack(track);
      });
    }

    // 5. Initialize MediaRecorder
    const chosenType = getSupportedMimeType();
    console.log(`[Offscreen] Using MIME type: "${chosenType.mime}" (format: ${chosenType.format})`);

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

    // Fallback direct download trigger inside offscreen document
    try {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 2000);
    } catch (aErr) {
      console.log('[Offscreen] Direct anchor download note:', aErr);
    }

    // Send blobUrl to service worker for chrome.downloads
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
  if (request.action === ACTIONS.START_RECORDING) {
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
