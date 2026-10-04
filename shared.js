const NATIVE_RATE = 0;
const RATE_STEPS = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 20, NATIVE_RATE];
const LAG_STEPS = [2, 3, 5, 10, 0];
const PACING_MODES = ['count', 'reading'];
const DEFAULTS = {
  enabled: true,
  rate: 4,
  maxLag: 3,
  pacing: 'count',
  collapse: true,
  priority: true,
  channels: {},
};

let writeChain = Promise.resolve();

/**
 * Whether a value is one of the allowed rate steps.
 */
function isRate(value) {
  return RATE_STEPS.includes(value);
}

/**
 * Whether a value is one of the allowed skip limits.
 */
function isLag(value) {
  return LAG_STEPS.includes(value);
}

/**
 * Formats a rate for display, without a trailing ".0".
 */
function formatRate(rate) {
  return String(Number(rate.toFixed(rate >= 10 ? 0 : 1)));
}

/**
 * Reads everything saved, replacing missing or invalid values with defaults.
 */
async function loadStored() {
  const raw = await chrome.storage.local.get(DEFAULTS);
  const channels = {};
  for (const [name, override] of Object.entries(raw.channels ?? {})) {
    if (isRate(override?.rate) && isLag(override?.maxLag)) channels[name] = override;
  }
  return {
    enabled: raw.enabled !== false,
    rate: isRate(raw.rate) ? raw.rate : DEFAULTS.rate,
    maxLag: isLag(raw.maxLag) ? raw.maxLag : DEFAULTS.maxLag,
    pacing: PACING_MODES.includes(raw.pacing) ? raw.pacing : DEFAULTS.pacing,
    collapse: raw.collapse !== false,
    priority: raw.priority !== false,
    channels,
  };
}

/**
 * The settings in effect for a channel: its own speed if it has one, else the global speed.
 */
function resolveSettings(stored, channel) {
  const override = channel ? stored.channels[channel] : null;
  return { ...stored, ...override, channelOverride: Boolean(override) };
}

/**
 * Runs storage writes one at a time so read-modify-write updates cannot clobber each other.
 */
function serialized(task) {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

/**
 * Saves a settings change; speed and skip limit go to the channel's own entry when it has one.
 */
function saveSetting(patch, channel) {
  return serialized(async () => {
    const stored = await loadStored();
    const override = channel ? stored.channels[channel] : null;
    const write = {};
    const scoped = {};
    for (const [key, value] of Object.entries(patch)) {
      const target = override && (key === 'rate' || key === 'maxLag') ? scoped : write;
      target[key] = value;
    }
    if (override) write.channels = { ...stored.channels, [channel]: { ...override, ...scoped } };
    await chrome.storage.local.set(write);
  });
}

/**
 * Gives a channel its own speed (starting from the global one) or returns it to the global speed.
 */
function setChannelOverride(channel, enabled) {
  return serialized(async () => {
    const stored = await loadStored();
    const channels = { ...stored.channels };
    if (enabled) channels[channel] = { rate: stored.rate, maxLag: stored.maxLag };
    else delete channels[channel];
    await chrome.storage.local.set({ channels });
  });
}
