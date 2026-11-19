// Codex-style turn summary: once a turn has finished, its intermediate steps fold
// under "Worked for …" above the final answer, and within every turn consecutive
// steps fold into step runs. Recomputed after every timeline mutation
// (markTurnAdjacency), so it is purely a view of the existing DOM.
import { state } from './state.js';
import { formatDuration, resetStepRuns, timeOf, updateStepRuns } from './step-runs.js';

const STEP = 'turn-step';
const HIDDEN = 'turn-step-hidden';
const FINAL = 'turn-final';
const TOGGLE = 'turn-worked';
const userExpanded = new Map();
let foldedWhileRunning = null;

export const formatWorked = formatDuration;

// Rows before the first loaded user message (an older page not loaded yet) form an anchorless turn.
function turnsOf(container) {
  const turns = [];
  let current = { anchor: null, rows: [] };
  turns.push(current);
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
  return turns.filter(turn => turn.anchor || turn.rows.length);
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
    turn.items = turn.rows.flatMap(row => Array.from(row.children)
      .filter(child => child.classList.contains('tl-item')));
    turn.running = turn.rows.some(row => row.classList.contains('stream-preview'))
      || (index === turns.length - 1 && state.wsRunning);
    turn.key = turn.anchor ? turnKey(turn.anchor) : '';
    if (turn.anchor) foldTurn(turn);
  });
  // After the fold, so a run's row-hiding sees which steps the fold hides.
  updateStepRuns(turns);
}

function foldTurn(turn) {
  const { items, running } = turn;
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
  const key = turn.key;
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
  // Folded, the toggle heads the final answer; open, it heads the turn and the steps follow it.
  const holder = collapsed ? final : items[0];
  let toggle = null;
  for (const item of items) {
    const found = item.querySelector(':scope > .' + TOGGLE);
    if (!found) continue;
    if (toggle) found.remove();
    else toggle = found;
  }
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = TOGGLE;
  }
  if (holder.firstElementChild !== toggle) holder.prepend(toggle);
  toggle.dataset.turnKey = key;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  if (toggle.firstChild?.textContent !== label) {
    toggle.innerHTML = '<span class="turn-worked-label"></span><span class="turn-worked-chevron" aria-hidden="true">›</span>';
    toggle.firstChild.textContent = label;
  }
  turn.rows.forEach(row => row.classList.toggle('turn-row-hidden', Array.from(row.children)
    .every(child => !child.classList.contains('tl-item') || child.classList.contains(HIDDEN))));
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
window.resetTurnSummaries = () => {
  userExpanded.clear();
  resetStepRuns();
};
