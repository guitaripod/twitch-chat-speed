const enabledInput = document.getElementById('enabled');
const rateInput = document.getElementById('rate');
const rateLabel = document.getElementById('rateLabel');
const lagSelect = document.getElementById('maxLag');

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
  rateLabel.textContent = `${RATE_STEPS[Number(rateInput.value)]} messages/sec`;
}

/**
 * Fills the controls from saved settings.
 */
async function render() {
  const settings = await loadSettings();
  enabledInput.checked = settings.enabled;
  rateInput.max = RATE_STEPS.length - 1;
  rateInput.value = RATE_STEPS.indexOf(settings.rate);
  lagSelect.replaceChildren(
    ...LAG_STEPS.map((seconds) => new Option(lagLabel(seconds), seconds, false, seconds === settings.maxLag))
  );
  renderRate();
}

enabledInput.addEventListener('change', () => saveSettings({ enabled: enabledInput.checked }));
rateInput.addEventListener('input', () => {
  renderRate();
  saveSettings({ rate: RATE_STEPS[Number(rateInput.value)] });
});
lagSelect.addEventListener('change', () => saveSettings({ maxLag: Number(lagSelect.value) }));

render();
