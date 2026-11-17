// Codex-style turn summary: once a turn has finished, its intermediate steps fold
// under "Worked for …" above the final answer. Recomputed after every timeline
// mutation (markTurnAdjacency), so it is purely a view of the existing DOM.
import { state } from './state.js';

const STEP = 'turn-step';
const HIDDEN = 'turn-step-hidden';
const FINAL = 'turn-final';
const TOGGLE = 'turn-worked';
const userExpanded = new Map();
let foldedWhileRunning = null;

function timeOf(element) {
  const value = element?.dataset?.serverTs || element?.dataset?.ts;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

export function formatWorked(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function turnsOf(container) {
  const turns = [];
  let current = null;
  for (const element of container.children) {
    if (element.classList.contains('msg-user')) {
      current = { anchor: element, rows: [] };
      turns.push(current);
    } else if (element.id === 'permission-prompt') {
      current = null;
    } else if (current && element.classList.contains('assistant-turn')) {
      current.rows.push(element);
    }
  }
  return turns;
}

function clearItem(item) {
  item.classList.remove(STEP, HIDDEN, FINAL);
  item.querySelector(':scope > .' + TOGGLE)?.remove();
}

function turnKey(anchor) {
  return anchor.dataset.anchor || anchor.dataset.messageId || anchor.dataset.nativeId || '';
}

export function updateTurnSummaries(container) {
  if (!container?.classList?.contains('messages')) return;
  foldedWhileRunning = !!state.wsRunning;
  const turns = turnsOf(container);
  turns.forEach((turn, index) => {
    const items = turn.rows.flatMap(row => Array.from(row.children)
      .filter(child => child.classList.contains('tl-item')));
    const running = turn.rows.some(row => row.classList.contains('stream-preview'))
      || (index === turns.length - 1 && state.wsRunning);
    let finalIndex = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.classList.contains('msg-interrupt')) continue;
      if (item.classList.contains('assistant-text') && item.textContent.trim()) finalIndex = i;
      break;
    }
    const steps = finalIndex > 0 ? items.slice(0, finalIndex) : [];
    if (running || !steps.length) {
      items.forEach(clearItem);
      turn.rows.forEach(row => row.classList.remove('turn-row-hidden'));
      return;
    }
    const final = items[finalIndex];
    const key = turnKey(turn.anchor);
    const collapsed = !userExpanded.get(key);
    const start = timeOf(turn.anchor);
    let end = null;
    for (let i = items.length - 1; i >= 0 && end === null; i--) end = timeOf(items[i]);
    const label = start !== null && end !== null && end > start
      ? 'Worked for ' + formatWorked(end - start)
      : 'Show work';
    items.forEach((item, i) => {
      if (i === finalIndex) return;
      if (item.classList.contains(FINAL) || i > finalIndex) clearItem(item);
      if (i > finalIndex) return;
      item.classList.add(STEP);
      item.classList.toggle(HIDDEN, collapsed);
    });
    final.classList.remove(STEP, HIDDEN);
    final.classList.add(FINAL);
    let toggle = final.querySelector(':scope > .' + TOGGLE);
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = TOGGLE;
      final.prepend(toggle);
    }
    toggle.dataset.turnKey = key;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (toggle.firstChild?.textContent !== label) {
      toggle.innerHTML = '<span class="turn-worked-label"></span><span class="turn-worked-chevron" aria-hidden="true">›</span>';
      toggle.firstChild.textContent = label;
    }
    turn.rows.forEach(row => row.classList.toggle('turn-row-hidden', Array.from(row.children)
      .every(child => !child.classList.contains('tl-item') || child.classList.contains(HIDDEN))));
  });
}

document.addEventListener('click', event => {
  const toggle = event.target.closest?.('.' + TOGGLE);
  if (!toggle) return;
  event.stopPropagation();
  const container = toggle.closest('.messages');
  const scroller = document.getElementById('content');
  const before = toggle.getBoundingClientRect().top;
  const key = toggle.dataset.turnKey || '';
  userExpanded.set(key, toggle.getAttribute('aria-expanded') !== 'true');
  updateTurnSummaries(container);
  // Keep the toggle where the user tapped it while the steps above it open or close.
  if (scroller) scroller.scrollTop += toggle.getBoundingClientRect().top - before;
}, true);

// The running state can change without a timeline mutation (REST status, turn end).
export function syncTurnSummaries() {
  if (foldedWhileRunning === !!state.wsRunning) return;
  updateTurnSummaries(document.querySelector('#content .messages'));
}

window.updateTurnSummaries = updateTurnSummaries;
window.syncTurnSummaries = syncTurnSummaries;
window.resetTurnSummaries = () => userExpanded.clear();
