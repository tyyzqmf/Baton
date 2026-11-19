import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="content"><div class="messages"></div></div></body>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { state } = await import('../../web/js/state.js');
const { updateTurnSummaries } = await import('../../web/js/turn-summary.js');
test.after(() => dom.window.close());

const container = document.querySelector('.messages');
const at = second => `2026-11-19T00:00:${String(second).padStart(2, '0')}Z`;

function user(id) {
  return `<div class="msg-user" data-anchor="${id}" data-ts="${at(0)}"><div class="msg-text">ask ${id}</div></div>`;
}
function text(id, second, body) {
  return `<div class="tl-item assistant-text" data-message-id="${id}" data-ts="${at(second)}" data-message-text="${body}">${body}</div>`;
}
function think(id, second, ms) {
  return `<div class="tl-item thinking-tl" data-message-id="${id}"${second === null ? '' : ` data-ts="${at(second)}"`}>`
    + `<div class="thinking-block"${ms ? ` data-thinking-duration-ms="${ms}"` : ''}><div class="thinking-toggle">`
    + '<span class="thinking-label">Thinking</span></div><div class="thinking-body">hmm</div></div></div>';
}
function tool(id, name, second, { verb = 'Ran', desc = 'echo hi', cls = '' } = {}) {
  return `<div class="tl-item tool-node tool-details-collapsed ${cls}" data-tool-id="${id}" data-tool-name="${name}" data-ts="${at(second)}">`
    + `<div class="tool-header"><span class="tool-name">${verb}</span><span class="tool-desc">${desc}</span></div></div>`;
}
const bash = (id, second, extra = {}) => tool(id, 'Bash', second, { cls: 'claude-bash', desc: 'echo ' + id, ...extra });
const read = (id, second) => tool(id, 'Read', second, { verb: 'Explored', desc: id + '.js', cls: 'claude-explore' });
const row = items => `<div class="assistant-turn">${items.join('')}</div>`;
const label = toggle => Array.from(toggle.querySelectorAll('span:not(.step-run-spinner)'), span => span.textContent).join(' ');
const visible = id => {
  const item = container.querySelector(`[data-tool-id="${id}"], [data-message-id="${id}"]`);
  return !item.classList.contains('step-run-hidden') && !item.classList.contains('turn-step-hidden');
};

function render(html, running = false) {
  state.wsRunning = running;
  container.innerHTML = html;
  updateTurnSummaries(container);
}

test('a running turn folds each run of two or more steps into one summary between texts', () => {
  render(user('t1')
    + row([text('a1', 1, 'Looking'), think('k1', 2), bash('b1', 5), read('r1', 9)])
    + row([text('a2', 20, 'Next')])
    + row([think('k2', 21), tool('e1', 'Edit', 22, { verb: 'Edited', desc: 'web/js/app.js', cls: 'tool-running' })]), true);
  const toggles = container.querySelectorAll('.step-run-toggle');
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].parentElement.dataset.messageId, 'k1', 'the summary sits in the first step of its run');
  assert.equal(label(toggles[0]), 'Ran 1 command, read 1 file · 18s');
  assert.equal(toggles[0].getAttribute('aria-expanded'), 'false');
  assert.deepEqual(['a1', 'b1', 'r1', 'a2', 'e1'].map(visible), [true, false, false, true, false]);
  assert.ok(container.querySelector('[data-message-id="k1"]').classList.contains('step-run-collapsed'));
  assert.ok(toggles[1].classList.contains('running'));
  assert.ok(toggles[1].querySelector('.step-run-spinner'));
  assert.equal(label(toggles[1]), 'Editing web/js/app.js · 2 steps', 'the running run names its current step');
});

test('a single step keeps its own row', () => {
  render(user('t2') + row([text('c1', 1, 'One'), bash('c2', 3), text('c3', 5, 'Two')]));
  assert.equal(container.querySelector('.step-run-toggle'), null);
  assert.equal(container.querySelector('.step-run'), null);
});

test('a summary opens and closes, and the choice survives recomputation', () => {
  render(user('t3') + row([text('d1', 1, 'Go'), bash('d2', 2), bash('d3', 4), read('d4', 6), text('d5', 9, 'Done')]), true);
  const toggle = () => container.querySelector('.step-run-toggle');
  toggle().click();
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(['d2', 'd3', 'd4'].map(visible), [true, true, true]);
  assert.equal(container.querySelector('[data-tool-id="d2"]').classList.contains('step-run-collapsed'), false);
  updateTurnSummaries(container);
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelectorAll('.step-run-toggle').length, 1);
  toggle().click();
  assert.deepEqual(['d2', 'd3', 'd4'].map(visible), [true, false, false]);
  assert.equal(label(toggle()), 'Ran 2 commands, read 1 file · 7s');
});

test('failed steps are counted on the summary, and a thinking-only run reads Thought for', () => {
  render(user('t4') + row([text('f1', 1, 'Try'), bash('f2', 2, { cls: 'claude-bash error' }), bash('f3', 3), text('f4', 6, 'Then'),
    think('f5', null, 3000), think('f6', null, 4000), text('f7', 9, 'End')]), true);
  const toggles = container.querySelectorAll('.step-run-toggle');
  assert.equal(label(toggles[0]), 'Ran 2 commands · 4s · 1 failed');
  assert.ok(toggles[0].querySelector('.step-run-failed'));
  assert.equal(label(toggles[1]), 'Thought for 7s');
});

test('a finished turn keeps Worked for, and its runs stay folded once it opens', () => {
  render(user('t5') + row([think('g1', 2), bash('g2', 3), read('g3', 5)]) + row([text('g4', 30, 'Answer')]));
  const worked = container.querySelector('.turn-worked');
  assert.ok(worked);
  assert.equal(visible('g1'), false, 'the fold hides the run, summary included');
  assert.equal(container.children[1].classList.contains('turn-row-hidden'), true);
  worked.click();
  assert.equal(visible('g1'), true);
  assert.deepEqual(Array.from(container.querySelector('[data-message-id="g1"]').children).slice(0, 2).map(el => el.className),
    ['turn-worked', 'step-run-toggle'], 'the open turn toggle comes first, then the run summary');
  assert.deepEqual(['g2', 'g3'].map(visible), [false, false], 'the run inside stays folded');
  assert.equal(label(container.querySelector('.step-run-toggle')), 'Ran 1 command, read 1 file · 28s');
});

test('a row whose items all fold is hidden, and anchorless leading rows fold too', () => {
  render(row([think('h1', 1), bash('h2', 2)]) + user('t6') + row([text('h3', 3, 'Start'), bash('h4', 4)]) + row([bash('h5', 5)])
    + row([text('h6', 8, 'Stop')]), true);
  assert.equal(container.querySelectorAll('.step-run-toggle').length, 2);
  assert.equal(container.children[0].classList.contains('step-run-row-hidden'), false, 'the summary keeps its row');
  assert.equal(container.children[3].classList.contains('step-run-row-hidden'), true);
  container.querySelectorAll('.step-run-toggle')[1].click();
  assert.equal(container.children[3].classList.contains('step-run-row-hidden'), false);
});
