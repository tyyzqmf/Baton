// Codex-style step runs: two or more consecutive thinking / tool steps between texts fold into
// one summary row ("Ran 3 commands, read 2 files · 42s"). A pure view of the existing DOM,
// recomputed with the turn summaries after every timeline mutation.

const RUN = 'step-run';
const HEAD = 'step-run-head';
const HIDDEN = 'step-run-hidden';
const COLLAPSED = 'step-run-collapsed';
const ROW_HIDDEN = 'step-run-row-hidden';
const TOGGLE = 'step-run-toggle';
const OTHER_HIDDEN = ['thinking-group-hidden', 'tool-run-group-hidden', 'turn-step-hidden'];
const userExpanded = new Map();
const renderedLabel = new WeakMap();

const TERMINAL_ICON = '<svg class="step-run-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/>'
  + '<path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/></svg>';
const CHEVRON = '<svg class="step-run-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"'
  + ' stroke-linecap="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
// The running step reads in the present tense of the verb its row shows.
const DOING = {
  Ran: 'Running', Explored: 'Exploring', Edited: 'Editing', Called: 'Calling', 'Updated Plan': 'Updating plan',
  'Searched the web': 'Searching the web', Fetched: 'Fetching', 'Ran Agent': 'Running agent',
  'Spawned Agent': 'Spawning agent', 'Waited for Agent': 'Waiting for agent', 'Sent Agent Input': 'Messaging agent',
  'Closed Agent': 'Closing agent', 'Read Output': 'Reading output', Stopped: 'Stopping',
  'Viewed Image': 'Viewing image', 'Searched Tools': 'Searching tools', 'Requested Input': 'Requesting input',
  'Checked Goal': 'Checking goal',
};

export function timeOf(element) {
  const value = element?.dataset?.serverTs || element?.dataset?.ts;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many);
}

function isStep(item) {
  return item.classList.contains('thinking-tl') || item.classList.contains('tool-node');
}

function stepKind(item) {
  if (item.classList.contains('thinking-tl')) return 'think';
  const name = item.dataset.toolName || '';
  if (item.classList.contains('codex-called') || name.startsWith('mcp__')) return 'mcp';
  if (item.classList.contains('codex-explore')) return 'explore';
  if (item.classList.contains('claude-bash') || item.classList.contains('codex-ran')
    || name === 'Bash' || name === 'WriteStdin') return 'command';
  if (name === 'Read') return 'read';
  if (['Grep', 'Glob', 'LS', 'ToolSearch'].includes(name)) return 'search';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'].includes(name)) return 'edit';
  if (['Agent', 'Task', 'spawn_agent', 'send_input', 'wait_agent', 'close_agent'].includes(name)) return 'agent';
  if (name === 'WebSearch') return 'web';
  if (name === 'WebFetch') return 'fetch';
  if (name === 'TodoWrite') return 'plan';
  return 'tool';
}

function summaryLabel(steps) {
  const count = {};
  for (const step of steps) {
    const kind = stepKind(step);
    count[kind] = (count[kind] || 0) + 1;
  }
  const ran = [count.command && plural(count.command, 'command', 'commands'),
    count.agent && plural(count.agent, 'agent', 'agents')].filter(Boolean);
  const parts = [
    ran.length && 'ran ' + ran.join(' and '),
    count.read && 'read ' + plural(count.read, 'file', 'files'),
    count.explore && 'explored ' + plural(count.explore, 'file', 'files'),
    count.search && plural(count.search, 'search', 'searches'),
    count.edit && 'edited ' + plural(count.edit, 'file', 'files'),
    count.web && plural(count.web, 'web search', 'web searches'),
    count.fetch && 'fetched ' + plural(count.fetch, 'page', 'pages'),
    count.plan && 'updated the plan',
    count.mcp && 'called ' + plural(count.mcp, 'tool', 'tools'),
    count.tool && 'used ' + plural(count.tool, 'tool', 'tools'),
  ].filter(Boolean);
  const text = parts.slice(0, 3).join(', ') || 'worked';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function currentStep(item) {
  if (item.classList.contains('thinking-tl')) return 'Thinking';
  const name = item.querySelector(':scope > .tool-header .tool-name')?.textContent.trim() || 'Working';
  const desc = item.querySelector(':scope > .tool-header .tool-desc')?.textContent.trim() || '';
  // Partial tool input shows as a JSON fragment; the verb alone reads better until it parses.
  return (DOING[name] || name) + (desc && !/^[[{]/.test(desc) ? ' ' + desc : '');
}

function runDuration(members, next) {
  let start = null;
  for (let i = 0; i < members.length && start === null; i++) start = timeOf(members[i]);
  let end = next ? timeOf(next) : null;
  for (let i = members.length - 1; i >= 0 && end === null; i--) end = timeOf(members[i]);
  if (start !== null && end !== null && end > start) return end - start;
  const thought = members.reduce((sum, member) => sum
    + (Number(member.querySelector('.thinking-block')?.dataset.thinkingDurationMs) || 0), 0);
  return thought > 0 ? thought : null;
}

function labelHtml(run, steps, running) {
  const failed = steps.filter(step => step.classList.contains('error')).length;
  const failure = failed ? '<span class="step-run-failed">· ' + failed + ' failed</span>' : '';
  if (running) {
    return '<span class="step-run-spinner" aria-hidden="true"></span>'
      + '<span class="step-run-label">' + esc(currentStep(steps[steps.length - 1])) + '</span>'
      + '<span class="step-run-meta">· ' + plural(steps.length, 'step', 'steps') + '</span>' + failure + CHEVRON;
  }
  const ms = runDuration(run.members, run.next);
  const thinkingOnly = steps.every(step => step.classList.contains('thinking-tl'));
  const label = thinkingOnly ? 'Thought' + (ms ? ' for ' + formatDuration(ms) : '') : summaryLabel(steps);
  return TERMINAL_ICON + '<span class="step-run-label">' + esc(label) + '</span>'
    + (!thinkingOnly && ms ? '<span class="step-run-meta">· ' + formatDuration(ms) + '</span>' : '')
    + failure + CHEVRON;
}

function identity(item) {
  const data = item.dataset;
  return data.toolId || data.messageId || data.nativeId || data.blockId || '';
}

function clear(item) {
  if (!item.classList.contains(RUN)) return;
  item.classList.remove(RUN, HEAD, HIDDEN, COLLAPSED);
  item.querySelector(':scope > .' + TOGGLE)?.remove();
}

function decorate(turn, run, steps, running, index) {
  const head = run.members[0];
  const key = turn.key + '\u0000' + (identity(head) || '#' + index);
  const open = !!userExpanded.get(key);
  run.members.forEach((member, i) => {
    member.classList.add(RUN);
    member.classList.toggle(HEAD, i === 0);
    member.classList.toggle(HIDDEN, !open && i > 0);
    member.classList.toggle(COLLAPSED, !open && i === 0);
    if (i > 0) member.querySelector(':scope > .' + TOGGLE)?.remove();
  });
  let toggle = head.querySelector(':scope > .' + TOGGLE);
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = TOGGLE;
  }
  // An open turn's "Worked for" toggle may head the same item; the run summary follows it.
  const lead = head.firstElementChild?.classList.contains('turn-worked') ? head.firstElementChild : null;
  if ((lead ? lead.nextElementSibling : head.firstElementChild) !== toggle) {
    if (lead) lead.after(toggle);
    else head.prepend(toggle);
  }
  toggle.dataset.runKey = key;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('running', running);
  const html = labelHtml(run, steps, running);
  if (renderedLabel.get(toggle) !== html) {
    toggle.innerHTML = html;
    renderedLabel.set(toggle, html);
  }
}

function hiddenItem(item) {
  return item.classList.contains(HIDDEN) || OTHER_HIDDEN.some(name => item.classList.contains(name));
}

// turns: [{ key, rows, items, running }] in timeline order, as built by the turn summaries.
export function updateStepRuns(turns) {
  for (const turn of turns) {
    const runs = [];
    let current = null;
    for (const item of turn.items) {
      if (isStep(item)) {
        if (!current) runs.push(current = { members: [], next: null });
        current.members.push(item);
      } else {
        if (current) current.next = item;
        current = null;
      }
    }
    const decorated = new Set();
    runs.forEach((run, index) => {
      // Merged empty thinking rows already show as one.
      const steps = run.members.filter(member => !member.classList.contains('thinking-group-hidden'));
      if (steps.length < 2) return;
      decorate(turn, run, steps, turn.running && !run.next, index);
      run.members.forEach(member => decorated.add(member));
    });
    turn.items.forEach(item => { if (!decorated.has(item)) clear(item); });
    turn.rows.forEach(row => {
      const items = Array.from(row.children).filter(child => child.classList.contains('tl-item'));
      row.classList.toggle(ROW_HIDDEN, items.length > 0 && items.every(hiddenItem));
    });
  }
}

export function isFoldedStep(element) {
  return !!element && (element.classList.contains(HIDDEN) || element.classList.contains(COLLAPSED));
}

export function resetStepRuns() {
  userExpanded.clear();
}

document.addEventListener('click', event => {
  const toggle = event.target.closest?.('.' + TOGGLE);
  if (!toggle) return;
  event.stopPropagation();
  const scroller = document.getElementById('content');
  const before = toggle.getBoundingClientRect().top;
  userExpanded.set(toggle.dataset.runKey || '', toggle.getAttribute('aria-expanded') !== 'true');
  window.updateTurnSummaries?.(toggle.closest('.messages'));
  // Keep the summary where it was tapped while the steps below it open or close.
  if (scroller) scroller.scrollTop += toggle.getBoundingClientRect().top - before;
}, true);

window.isFoldedStep = isFoldedStep;
