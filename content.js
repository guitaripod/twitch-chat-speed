const CONTAINER_SELECTOR = '.chat-scrollable-area__message-container, #anti-ban-chat';
const LOCAL_MESSAGE_ID_PREFIX = 'anti-ban-local-';
const CHAT_INPUT_SELECTOR = '[data-a-target="chat-input"]';
const SEND_BUTTON_SELECTOR = '[data-a-target="chat-send-button"]';
const HIDDEN_ATTR = 'data-tcs-hidden';
const TICK_MS = 40;
const HOUSEKEEPING_MS = 500;
const MAX_CREDIT = 2;
const OWN_MESSAGE_WINDOW_MS = 4000;
const BOTTOM_TOLERANCE_PX = 24;

let settings = { ...DEFAULTS };
let container = null;
let observer = null;
let scroller = null;
let queue = [];
let skipped = 0;
let credit = MAX_CREDIT;
let lastCreditAt = performance.now();
let timer = null;
let pendingOwn = null;
let badge = null;
let wasActive = true;

/**
 * Whether throttling applies right now: enabled, and not a VOD where chat follows the video.
 */
function isActive() {
  return settings.enabled && !location.pathname.startsWith('/videos/');
}

/**
 * How many messages may wait in the queue before the oldest are skipped.
 */
function queueCap() {
  if (settings.maxLag === 0) return Infinity;
  return Math.max(1, Math.ceil(settings.rate * settings.maxLag));
}

/**
 * Words in an element's text plus emote alt texts, so rendered emotes match typed emote names.
 */
function textTokens(root) {
  const alts = Array.from(root.querySelectorAll('img[alt]'), (img) => img.alt);
  const text = [root.value ?? '', root.textContent, ...alts].join(' ');
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Remembers what the user just sent so its echo in chat can skip the queue.
 */
function rememberSentMessage(input) {
  if (!input) return;
  const tokens = textTokens(input);
  if (tokens.length) pendingOwn = { tokens, until: performance.now() + OWN_MESSAGE_WINDOW_MS };
}

/**
 * Whether a new chat line is the user's own: a locally rendered Twitch Anti-Ban message, or the echo of what they just sent (consumed on match).
 */
function isOwnMessage(node) {
  if (node.getAttribute('data-id')?.startsWith(LOCAL_MESSAGE_ID_PREFIX)) return true;
  if (!pendingOwn) return false;
  if (performance.now() > pendingOwn.until) {
    pendingOwn = null;
    return false;
  }
  const have = new Set(textTokens(node));
  if (!pendingOwn.tokens.every((token) => have.has(token))) return false;
  pendingOwn = null;
  return true;
}

/**
 * The scrollable ancestor of the message container.
 */
function findScroller() {
  for (let el = container?.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return el;
  }
  return null;
}

/**
 * Whether chat is pinned to the newest message, as opposed to scrolled up by the user.
 */
function isAtBottom() {
  if (!scroller?.isConnected) scroller = findScroller();
  if (!scroller) return false;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_TOLERANCE_PX;
}

/**
 * Shows queued lines and keeps chat pinned to the bottom if it was.
 */
function reveal(nodes) {
  const live = nodes.filter((node) => node.isConnected);
  if (!live.length) return;
  const follow = isAtBottom();
  for (const node of live) node.removeAttribute(HIDDEN_ATTR);
  if (follow) scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Releases as many queued lines as the token bucket allows.
 */
function pump() {
  const now = performance.now();
  credit = Math.min(MAX_CREDIT, credit + ((now - lastCreditAt) / 1000) * settings.rate);
  lastCreditAt = now;
  const due = [];
  while (credit >= 1 && queue.length) {
    const node = queue.shift();
    if (!node.isConnected) continue;
    credit -= 1;
    due.push(node);
  }
  reveal(due);
  if (!queue.length) stopTimer();
}

/**
 * Keeps releasing on a steady tick while lines are waiting.
 */
function ensureTimer() {
  if (!timer && queue.length) timer = setInterval(pump, TICK_MS);
}

/**
 * Stops the release tick.
 */
function stopTimer() {
  clearInterval(timer);
  timer = null;
}

/**
 * Permanently skips the oldest queued lines beyond the lag limit.
 */
function enforceCap() {
  const cap = queueCap();
  while (queue.length > cap) {
    if (queue.shift().isConnected) skipped += 1;
  }
}

/**
 * Handles chat lines added by Twitch: hide, queue, and release at the chosen rate.
 */
function onMutations(records) {
  if (!isActive()) return;
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE || isOwnMessage(node)) continue;
      node.setAttribute(HIDDEN_ATTR, '');
      queue.push(node);
    }
  }
  enforceCap();
  pump();
  ensureTimer();
}

/**
 * Shows every queued and skipped line again.
 */
function flush() {
  stopTimer();
  queue = [];
  skipped = 0;
  if (container) reveal(Array.from(container.querySelectorAll(`[${HIDDEN_ATTR}]`)));
}

/**
 * Follows Twitch's single-page navigation by re-attaching when the message container changes.
 */
function attach() {
  const next = document.querySelector(CONTAINER_SELECTOR);
  if (next === container) return;
  observer?.disconnect();
  stopTimer();
  queue = [];
  skipped = 0;
  scroller = null;
  container = next;
  if (!container) return;
  observer = new MutationObserver(onMutations);
  observer.observe(container, { childList: true });
}

/**
 * Creates the small on-page indicator; clicking it turns throttling off.
 */
function ensureBadge() {
  if (badge) return badge;
  badge = document.createElement('div');
  badge.id = 'tcs-badge';
  badge.addEventListener('click', () => saveSettings({ enabled: false }));
  document.body.appendChild(badge);
  return badge;
}

/**
 * Pins the indicator to the chat's top-right corner and updates its text.
 */
function refreshBadge() {
  const rect = container?.getBoundingClientRect();
  if (!rect || !rect.width || !isActive()) {
    if (badge) badge.hidden = true;
    return;
  }
  const el = ensureBadge();
  el.hidden = false;
  el.style.top = `${rect.top + 6}px`;
  el.style.right = `${document.documentElement.clientWidth - rect.right + 18}px`;
  el.textContent = skipped ? `${settings.rate}/s · ${skipped} skipped` : `${settings.rate}/s`;
  el.title = 'Twitch Chat Speed: click to turn off';
}

/**
 * Reacts to a settings change: un-throttle when off, re-trim the queue otherwise.
 */
function applySettings() {
  if (isActive()) enforceCap();
  else flush();
  wasActive = isActive();
  refreshBadge();
}

/**
 * Periodic upkeep: container re-attachment, VOD navigation, badge position.
 */
function housekeeping() {
  attach();
  const active = isActive();
  if (wasActive && !active) flush();
  wasActive = active;
  refreshBadge();
}

document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    rememberSentMessage(event.target.closest?.(CHAT_INPUT_SELECTOR));
  },
  true
);

document.addEventListener(
  'click',
  (event) => {
    if (event.target.closest?.(SEND_BUTTON_SELECTOR)) {
      rememberSentMessage(document.querySelector(CHAT_INPUT_SELECTOR));
    }
  },
  true
);

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  loadSettings().then((next) => {
    settings = next;
    applySettings();
  });
});

loadSettings().then((loaded) => {
  settings = loaded;
  wasActive = isActive();
  housekeeping();
  setInterval(housekeeping, HOUSEKEEPING_MS);
});
