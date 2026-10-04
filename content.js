const CONTAINER_SELECTOR = '.chat-scrollable-area__message-container, #anti-ban-chat';
const CHAT_INPUT_SELECTOR = '[data-a-target="chat-input"]';
const SEND_BUTTON_SELECTOR = '[data-a-target="chat-send-button"]';
const BODY_SELECTOR = '[data-a-target="chat-line-message-body"]';
const NOTICE_SELECTOR = '.user-notice-line, .chat-line__status';
const MENTION_SELECTOR = '.mention-fragment--recipient';
const LOCAL_MESSAGE_ID_PREFIX = 'anti-ban-local-';
const POPOUT_ROUTES = ['popout', 'embed', 'moderator'];
const PRIORITY_BADGE_IDS = [
  '5527c58c-fb7d-422d-b71b-f309dcb85cc1',
  '3267646d-33f0-4b17-b3df-f923a41db1d0',
  'd97c37bd-a6f5-4c38-8f57-4e4bef88af34',
];
const PRIORITY_BADGE_ALT = /^(broadcaster|moderator|staff|admin)$/i;
const HIDDEN_ATTR = 'data-tcs-hidden';
const TICK_MS = 40;
const HOUSEKEEPING_MS = 500;
const RATE_WINDOW_BUCKETS = 10;
const MAX_CREDIT = 2;
const PRIORITY_RATE = 2;
const PRIORITY_BURST = 3;
const OWN_MESSAGE_WINDOW_MS = 4000;
const BOTTOM_TOLERANCE_PX = 24;
const RECENT_MS = 6000;
const AVG_MESSAGE_CHARS = 30;
const EMOTE_CHARS = 3;
const MIN_COST = 0.4;
const MAX_COST = 3;

let stored = { ...DEFAULTS };
let settings = resolveSettings(stored, null);
let channel = null;
let container = null;
let observer = null;
let scroller = null;
let queue = [];
let skipped = 0;
let collapsed = 0;
let paused = false;
let credit = MAX_CREDIT;
let lastCreditAt = performance.now();
let priorityCredit = PRIORITY_BURST;
let priorityAt = performance.now();
let timer = null;
let pendingOwn = null;
let badge = null;
let wasActive = true;
let ownLogin = null;
let mentionPattern = null;
let arrivals = 0;
let arrivalBuckets = [];
let chatRate = 0;
const pendingKeys = new Map();
const recent = new Map();

/**
 * Whether the extension is on for this page: enabled, and not a VOD where chat follows the video.
 */
function isEnabledHere() {
  return settings.enabled && !location.pathname.startsWith('/videos/');
}

/**
 * Whether throttling applies right now: enabled here and not set to native speed.
 */
function isActive() {
  return isEnabledHere() && settings.rate !== NATIVE_RATE;
}

/**
 * The channel a Twitch URL belongs to, including popout, embed and moderator views.
 */
function channelFromPath() {
  const [first, second] = location.pathname.split('/').filter(Boolean);
  const name = POPOUT_ROUTES.includes(first) ? second : first;
  return name ? name.toLowerCase() : null;
}

/**
 * How many droppable messages may wait in the queue before the oldest are skipped.
 */
function queueCap() {
  if (settings.maxLag === 0) return Infinity;
  return Math.max(1, Math.ceil(settings.rate * settings.maxLag));
}

/**
 * Words in order from an element's text, with emotes represented by their alt text or image URL.
 */
function contentTokens(root) {
  const tokens = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeType === Node.TEXT_NODE) tokens.push(...current.textContent.split(/\s+/).filter(Boolean));
    else if (current.tagName === 'IMG') tokens.push(current.alt || current.src);
  }
  return tokens;
}

/**
 * The part of a chat line holding the message text, or null for lines without one.
 */
function bodyOf(node) {
  return node.querySelector(BODY_SELECTOR) ?? (node.classList.contains('chat-line') ? node.lastElementChild : null);
}

/**
 * How long a message takes to read relative to an average one, bounded.
 */
function readingCost(body) {
  const chars = body.textContent.replace(/\s+/g, ' ').trim().length;
  const emotes = body.querySelectorAll('img').length;
  return Math.min(MAX_COST, Math.max(MIN_COST, (chars + emotes * EMOTE_CHARS) / AVG_MESSAGE_CHARS));
}

/**
 * Wraps a chat line with what the queue needs to know about it.
 */
function makeEntry(node) {
  const body = bodyOf(node);
  const key = body ? contentTokens(body).join(' ').toLowerCase() : '';
  return { node, key, cost: body ? readingCost(body) : 1, count: 1, keep: false, at: 0 };
}

/**
 * Remembers what the user just sent so its echo in chat can skip the queue.
 */
function rememberSentMessage(input) {
  if (!input) return;
  const tokens = input.value ? input.value.split(/\s+/).filter(Boolean) : contentTokens(input);
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
  const have = new Set(contentTokens(node));
  if (!pendingOwn.tokens.every((token) => have.has(token))) return false;
  pendingOwn = null;
  return true;
}

/**
 * The signed-in user's login from Twitch's cookies, or null when not signed in or unreadable.
 */
function readOwnLogin() {
  try {
    const cookies = Object.fromEntries(document.cookie.split('; ').map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
    const login = cookies.login ?? JSON.parse(decodeURIComponent(cookies['twilight-user'] ?? 'null'))?.login;
    return /^\w+$/.test(login ?? '') ? login.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a chat line carries a broadcaster, moderator or staff badge.
 */
function hasPriorityBadge(node) {
  return Array.from(node.querySelectorAll('img')).some(
    (img) => PRIORITY_BADGE_ALT.test(img.alt) || PRIORITY_BADGE_IDS.some((id) => img.src.includes(id))
  );
}

/**
 * Whether a chat line is worth showing at once: alerts, mentions of the user, and broadcaster, moderator or staff messages.
 */
function isPriority(node) {
  if (node.matches(NOTICE_SELECTOR) || node.querySelector(NOTICE_SELECTOR)) return true;
  if (node.querySelector(MENTION_SELECTOR)) return true;
  if (mentionPattern?.test(node.textContent)) return true;
  return hasPriorityBadge(node);
}

/**
 * Spends one token from the small allowance that lets priority lines skip the queue, so bots cannot flood past it.
 */
function takePriorityToken() {
  const now = performance.now();
  priorityCredit = Math.min(PRIORITY_BURST, priorityCredit + ((now - priorityAt) / 1000) * PRIORITY_RATE);
  priorityAt = now;
  if (priorityCredit < 1) return false;
  priorityCredit -= 1;
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
 * Shows or updates the repeat count tag on a line that absorbed repeats, once the line is visible.
 */
function renderCount(entry) {
  if (entry.count < 2 || !entry.node.isConnected || entry.node.hasAttribute(HIDDEN_ATTR)) return;
  let tag = entry.node.querySelector('.tcs-count');
  if (!tag) {
    tag = document.createElement('span');
    tag.className = 'tcs-count';
    (bodyOf(entry.node) ?? entry.node).appendChild(tag);
  }
  tag.textContent = `×${entry.count}`;
}

/**
 * Stops tracking a queued entry's text for repeat detection.
 */
function forget(entry) {
  if (pendingKeys.get(entry.key) === entry) pendingKeys.delete(entry.key);
}

/**
 * Records a released line so identical messages arriving soon after can fold into it.
 */
function remember(entry, now) {
  entry.at = now;
  if (entry.key) recent.set(entry.key, entry);
  renderCount(entry);
}

/**
 * Folds an identical message into the queued or recently shown line, returning whether it did.
 */
function absorbDuplicate(entry) {
  if (!entry.key) return false;
  const now = performance.now();
  const shown = recent.get(entry.key);
  const hit = pendingKeys.get(entry.key) ?? (shown && now - shown.at < RECENT_MS && shown.node.isConnected ? shown : null);
  if (!hit) return false;
  hit.count += 1;
  hit.at = now;
  collapsed += 1;
  renderCount(hit);
  return true;
}

/**
 * Releases queued lines as the token bucket allows; long messages cost more when pacing by reading time.
 */
function pump() {
  if (paused) return;
  const now = performance.now();
  credit = Math.min(MAX_CREDIT, credit + ((now - lastCreditAt) / 1000) * settings.rate);
  lastCreditAt = now;
  const due = [];
  while (credit >= 1 && queue.length) {
    const entry = queue.shift();
    forget(entry);
    if (!entry.node.isConnected) continue;
    credit -= settings.pacing === 'reading' ? entry.cost : 1;
    due.push(entry);
  }
  reveal(due.map((entry) => entry.node));
  for (const entry of due) remember(entry, now);
  if (!queue.length) stopTimer();
}

/**
 * Keeps releasing on a steady tick while lines are waiting.
 */
function ensureTimer() {
  if (!timer && queue.length && !paused) timer = setInterval(pump, TICK_MS);
}

/**
 * Stops the release tick.
 */
function stopTimer() {
  clearInterval(timer);
  timer = null;
}

/**
 * Permanently skips the oldest droppable lines beyond the lag limit; kept lines are never skipped.
 */
function enforceCap() {
  if (paused) return;
  const cap = queueCap();
  let droppable = queue.reduce((total, entry) => total + (entry.keep ? 0 : 1), 0);
  while (droppable > cap) {
    const [entry] = queue.splice(queue.findIndex((candidate) => !candidate.keep), 1);
    forget(entry);
    if (entry.node.isConnected) skipped += 1;
    droppable -= 1;
  }
}

/**
 * Handles one chat line added by Twitch: let it through, fold it into a repeat, or hide and queue it.
 */
function enqueue(node) {
  if (isOwnMessage(node)) return;
  const priority = settings.priority && isPriority(node);
  if (priority && !paused && takePriorityToken()) return;
  const entry = makeEntry(node);
  entry.keep = priority && paused;
  node.setAttribute(HIDDEN_ATTR, '');
  if (settings.collapse && !priority && absorbDuplicate(entry)) return;
  queue.push(entry);
  if (entry.key) pendingKeys.set(entry.key, entry);
}

/**
 * Counts arrivals for the live chat rate and queues new lines while throttling is active.
 */
function onMutations(records) {
  const added = records.flatMap((record) => Array.from(record.addedNodes));
  const lines = added.filter((node) => node.nodeType === Node.ELEMENT_NODE);
  arrivals += lines.length;
  if (!isActive()) return;
  for (const node of lines) enqueue(node);
  enforceCap();
  pump();
  ensureTimer();
}

/**
 * Forgets all per-chat state, for a new channel or container.
 */
function resetState() {
  stopTimer();
  queue = [];
  pendingKeys.clear();
  recent.clear();
  skipped = 0;
  collapsed = 0;
  paused = false;
  scroller = null;
}

/**
 * Shows every queued, skipped and folded line again.
 */
function flush() {
  const hidden = container ? Array.from(container.querySelectorAll(`[${HIDDEN_ATTR}]`)) : [];
  resetState();
  reveal(hidden);
}

/**
 * Holds or resumes chat; on resume the backlog is trimmed to the lag limit and releases again.
 */
function setPaused(next) {
  paused = next;
  if (paused) {
    stopTimer();
  } else {
    lastCreditAt = performance.now();
    enforceCap();
    pump();
    ensureTimer();
  }
  refreshBadge();
}

/**
 * Toggles holding chat while throttling is active.
 */
function togglePause() {
  if (isActive()) setPaused(!paused);
}

/**
 * Moves the speed one step slower (-1) or faster (+1), saving it for the channel or globally.
 */
function stepRate(direction) {
  const index = RATE_STEPS.indexOf(settings.rate) + direction;
  if (index < 0 || index >= RATE_STEPS.length) return;
  saveSetting({ rate: RATE_STEPS[index] }, channel);
}

/**
 * Follows Twitch's single-page navigation by re-attaching when the message container changes.
 */
function attach() {
  const next = document.querySelector(CONTAINER_SELECTOR);
  if (next === container) return;
  observer?.disconnect();
  resetState();
  container = next;
  if (!container) return;
  observer = new MutationObserver(onMutations);
  observer.observe(container, { childList: true });
}

/**
 * Sums recent arrival buckets into messages per second.
 */
function updateChatRate() {
  arrivalBuckets.push(arrivals);
  arrivals = 0;
  if (arrivalBuckets.length > RATE_WINDOW_BUCKETS) arrivalBuckets.shift();
  const seconds = (arrivalBuckets.length * HOUSEKEEPING_MS) / 1000;
  chatRate = arrivalBuckets.reduce((total, count) => total + count, 0) / seconds;
}

/**
 * Drops repeat-tracking entries that are too old to absorb anything.
 */
function pruneRecent() {
  const now = performance.now();
  for (const [key, entry] of recent) {
    if (now - entry.at > RECENT_MS) recent.delete(key);
  }
}

/**
 * Builds a small button for the on-page control.
 */
function makeButton(action, text, title) {
  const button = document.createElement('button');
  button.dataset.action = action;
  button.textContent = text;
  button.title = title;
  return button;
}

/**
 * Handles clicks on the on-page control's buttons.
 */
function onBadgeClick(event) {
  const action = event.target.closest('button')?.dataset.action;
  if (action === 'slower') stepRate(-1);
  else if (action === 'faster') stepRate(1);
  else if (action === 'pause') togglePause();
}

/**
 * Creates the on-page control: slower, current speed, faster, hold.
 */
function ensureBadge() {
  if (badge) return badge;
  badge = document.createElement('div');
  badge.id = 'tcs-badge';
  const label = document.createElement('span');
  label.className = 'tcs-label';
  badge.append(
    makeButton('slower', '−', 'Slower (Alt+Down)'),
    label,
    makeButton('faster', '+', 'Faster (Alt+Up)'),
    makeButton('pause', '⏸', 'Hold chat (Alt+P)')
  );
  badge.addEventListener('click', onBadgeClick);
  document.body.appendChild(badge);
  return badge;
}

/**
 * Text for the on-page control's label.
 */
function badgeLabel() {
  if (paused) return `Held · ${queue.length} waiting`;
  const live = `chat ${formatRate(chatRate)}/s`;
  if (settings.rate === NATIVE_RATE) return `Native · ${live}`;
  return `${formatRate(settings.rate)}/s · ${live}`;
}

/**
 * Tooltip with the running totals.
 */
function badgeTitle() {
  return `${skipped} skipped · ${collapsed} folded into repeats`;
}

/**
 * Pins the control to the chat's top-right corner and updates its text.
 */
function refreshBadge() {
  const rect = container?.getBoundingClientRect();
  if (!rect || !rect.width || !isEnabledHere()) {
    if (badge) badge.hidden = true;
    return;
  }
  const el = ensureBadge();
  el.hidden = false;
  el.style.top = `${rect.top + 6}px`;
  el.style.right = `${document.documentElement.clientWidth - rect.right + 18}px`;
  el.querySelector('.tcs-label').textContent = badgeLabel();
  el.querySelector('[data-action="pause"]').textContent = paused ? '▶' : '⏸';
  el.title = badgeTitle();
}

/**
 * Reacts to a settings change: un-throttle when off or native, re-trim the queue otherwise.
 */
function applySettings() {
  if (isActive()) enforceCap();
  else flush();
  wasActive = isActive();
  refreshBadge();
}

/**
 * Recomputes the effective settings for the current channel.
 */
function resolve() {
  settings = resolveSettings(stored, container ? channel : null);
}

/**
 * Periodic upkeep: channel and container changes, VOD navigation, login lookup, live rate, control position.
 */
function housekeeping() {
  const nextChannel = channelFromPath();
  if (nextChannel !== channel) {
    channel = nextChannel;
    resetState();
  }
  attach();
  resolve();
  if (!ownLogin) {
    ownLogin = readOwnLogin();
    mentionPattern = ownLogin ? new RegExp(`@${ownLogin}\\b`, 'i') : null;
  }
  const active = isActive();
  if (wasActive && !active) flush();
  wasActive = active;
  updateChatRate();
  pruneRecent();
  refreshBadge();
}

/**
 * Snapshot for the popup.
 */
function snapshot() {
  return { channel: container ? channel : null, chatRate, active: isActive(), paused, skipped, collapsed };
}

const HOTKEYS = {
  ArrowUp: () => stepRate(1),
  ArrowDown: () => stepRate(-1),
  KeyP: togglePause,
};

window.addEventListener(
  'keydown',
  (event) => {
    const action = HOTKEYS[event.code];
    const plainAlt = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!action || !plainAlt || !container || !settings.enabled) return;
    event.preventDefault();
    action();
  },
  true
);

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') sendResponse(snapshot());
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  loadStored().then((next) => {
    stored = next;
    resolve();
    applySettings();
  });
});

loadStored().then((loaded) => {
  stored = loaded;
  channel = channelFromPath();
  attach();
  resolve();
  wasActive = isActive();
  housekeeping();
  setInterval(housekeeping, HOUSEKEEPING_MS);
});
