import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

export async function getSettings() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
  } catch (error) {
    console.warn('[Storage] Failed to read settings, using defaults:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  try {
    const current = await getSettings();
    const updated = { ...current, ...settings };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
    return updated;
  } catch (error) {
    console.error('[Storage] Failed to save settings:', error);
    throw error;
  }
}

export async function getActiveState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_STATE);
    return result[STORAGE_KEYS.ACTIVE_STATE] || null;
  } catch (error) {
    console.warn('[Storage] Failed to read active state:', error);
    return null;
  }
}

export async function setActiveState(state) {
  try {
    if (state === null) {
      await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_STATE);
    } else {
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_STATE]: state });
    }
  } catch (error) {
    console.error('[Storage] Failed to set active state:', error);
  }
}
