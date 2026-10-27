// Message Action Types
export const ACTIONS = {
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  PAUSE_RECORDING: 'PAUSE_RECORDING',
  RESUME_RECORDING: 'RESUME_RECORDING',
  GET_STATUS: 'GET_STATUS',
  STATUS_UPDATE: 'STATUS_UPDATE',
  DETECT_MOBILE: 'DETECT_MOBILE',
  START_PICKER: 'START_PICKER',
  CANCEL_PICKER: 'CANCEL_PICKER',
  CONTAINER_SELECTED: 'CONTAINER_SELECTED',
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  RECORDING_COMPLETE: 'RECORDING_COMPLETE',
  RECORDING_ERROR: 'RECORDING_ERROR'
};

// Recording Status
export const STATUS = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
  SAVING: 'SAVING',
  ERROR: 'ERROR'
};

// Resolution Profiles
export const RESOLUTIONS = {
  '720p': {
    name: '720p HD',
    width: 1280,
    height: 720,
    mobileWidth: 720,
    mobileHeight: 1280,
    videoBitrate: 3500000 // 3.5 Mbps
  },
  '1080p': {
    name: '1080p Full HD',
    width: 1920,
    height: 1080,
    mobileWidth: 1080,
    mobileHeight: 1920,
    videoBitrate: 7500000 // 7.5 Mbps
  }
};

// Mobile Crop Modes
export const CROP_MODES = {
  AUTO: 'AUTO',      // Automatically detect mobile viewport or centered container
  MANUAL: 'MANUAL',  // User selected container via visual picker
  OFF: 'OFF'         // Record entire tab
};

// Storage Keys
export const STORAGE_KEYS = {
  SETTINGS: 'screen_recorder_settings',
  ACTIVE_STATE: 'screen_recorder_active_state'
};

// Default Settings
export const DEFAULT_SETTINGS = {
  resolution: '1080p',
  cropMode: CROP_MODES.AUTO,
  recordMic: false,
  format: 'mp4' // mp4 with webm fallback
};
