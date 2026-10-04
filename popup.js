const STATUS_POLL_MS = 1000;

const enabledInput = document.getElementById('enabled');
const rateInput = document.getElementById('rate');
const rateLabel = document.getElementById('rateLabel');
const lagSelect = document.getElementById('maxLag');
const liveLabel = document.getElementById('live');
const channelRow = document.getElementById('channelRow');
const channelInput = document.getElementById('channelOverride');
const channelText = document.getElementById('channelText');
const pacingInput = document.getElementById('pacing');
const collapseInput = document.getElementById('collapse');
const priorityInput = document.getElementById('priority');

let channel = null;

/**
 * Human label for a skip limit in seconds, where 0 means never skip.
 */
function lagLabel(seconds) {
  return seconds === 0 ? 'Never skip (chat falls behind)' : `${seconds} seconds`;
}

/**
 * Shows the slider's current rate next to its label.
 */
function renderRate() {
  const rate = RATE_STEPS[Number(rateInput.value)];
  rateLabel.textContent = rate === NATIVE_RATE ? 'Native (no limit)' : `${formatRate(rate)} messages/sec`;
}

/**
 * Fills the controls from saved settings, resolved for the active tab's channel.
 */
async function render() {
  const settings = resolveSettings(await loadStored(), channel);
  enabledInput.checked = settings.enabled;
  rateInput.max = RATE_STEPS.length - 1;
  if (document.activeElement !== rateInput) rateInput.value = RATE_STEPS.indexOf(settings.rate);
  lagSelect.replaceChildren(
    ...LAG_STEPS.map((seconds) => new Option(lagLabel(seconds), seconds, false, seconds === settings.maxLag))
  );
  channelInput.checked = settings.channelOverride;
  pacingInput.checked = settings.pacing === 'reading';
  collapseInput.checked = settings.collapse;
  priorityInput.checked = settings.priority;
  renderRate();
}

/**
 * Shows the active tab's live chat numbers and which channel its settings apply to.
 */
function renderStatus(status) {
  const nextChannel = status?.channel ?? null;
  channelRow.hidden = !nextChannel;
  channelText.textContent = nextChannel ? `Separate speed for ${nextChannel}` : '';
  if (!status) {
    liveLabel.textContent = 'Open a Twitch chat to see live numbers.';
  } else {
    const parts = [`Chat right now: ${formatRate(status.chatRate)} messages/sec`];
    if (status.skipped) parts.push(`${status.skipped} skipped`);
    if (status.collapsed) parts.push(`${status.collapsed} folded`);
    liveLabel.textContent = parts.join(' · ');
  }
  if (nextChannel === channel) return;
  channel = nextChannel;
  render();
}

/**
 * Asks the active tab's content script for its status.
 */
async function refreshStatus() {
  let status = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    status = (await chrome.tabs.sendMessage(tab.id, { type: 'status' })) ?? null;
  } catch {
    status = null;
  }
  renderStatus(status);
}

enabledInput.addEventListener('change', () => saveSetting({ enabled: enabledInput.checked }, channel));
rateInput.addEventListener('input', () => {
  renderRate();
  saveSetting({ rate: RATE_STEPS[Number(rateInput.value)] }, channel);
});
lagSelect.addEventListener('change', () => saveSetting({ maxLag: Number(lagSelect.value) }, channel));
channelInput.addEventListener('change', () => setChannelOverride(channel, channelInput.checked));
pacingInput.addEventListener('change', () => saveSetting({ pacing: pacingInput.checked ? 'reading' : 'count' }, channel));
collapseInput.addEventListener('change', () => saveSetting({ collapse: collapseInput.checked }, channel));
priorityInput.addEventListener('change', () => saveSetting({ priority: priorityInput.checked }, channel));
chrome.storage.onChanged.addListener(render);

render();
refreshStatus();
setInterval(refreshStatus, STATUS_POLL_MS);
