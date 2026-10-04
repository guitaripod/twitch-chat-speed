const RATE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const LAG_STEPS = [2, 3, 5, 10, 0];
const DEFAULTS = { enabled: true, rate: 4, maxLag: 3 };

/**
 * Reads the saved settings, filling anything missing or invalid with defaults.
 * @returns {Promise<{enabled: boolean, rate: number, maxLag: number}>}
 */
async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    enabled: stored.enabled !== false,
    rate: RATE_STEPS.includes(stored.rate) ? stored.rate : DEFAULTS.rate,
    maxLag: LAG_STEPS.includes(stored.maxLag) ? stored.maxLag : DEFAULTS.maxLag,
  };
}

/**
 * Persists a partial settings change.
 * @param {Partial<{enabled: boolean, rate: number, maxLag: number}>} patch
 */
function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}
