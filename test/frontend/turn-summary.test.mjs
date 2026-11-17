import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="content"><div class="messages"></div></div></body>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { state } = await import('../../web/js/state.js');
const { updateTurnSummaries, formatWorked } = await import('../../web/js/turn-summary.js');
const { messageText } = await import('../../web/js/message-text.js');
test.after(() => dom.window.close());

const container = document.querySelector('.messages');

function user(id, ts) {
  return `<div class="msg-user" data-anchor="${id}" data-ts="${ts}"><div class="msg-text">ask ${id}</div></div>`;
}
function text(id, ts, body) {
  return `<div class="tl-item assistant-text" data-message-id="${id}" data-ts="${ts}" data-message-text="${body}">${body}</div>`;
}
function tool(id, ts) {
  return `<div class="tl-item tool-node tool-details-collapsed" data-tool-id="${id}" data-ts="${ts}"><div class="tool-header"><span class="tool-name">Ran</span></div></div>`;
}
function row(items, extra = '') {
  return `<div class="assistant-turn${extra}">${items.join('')}</div>`;
}
function render(html, running = false) {
  state.wsRunning = running;
  container.innerHTML = html;
  updateTurnSummaries(container);
}

test('a finished turn folds its steps under Worked for above the final answer', () => {
  render(user('t1', '2026-11-17T00:00:00Z')
    + row([text('a1', '2026-11-17T00:00:02Z', 'Looking'), tool('b1', '2026-11-17T00:00:10Z')])
    + row([tool('b2', '2026-11-17T00:00:40Z')])
    + row([text('a2', '2026-11-17T00:01:05Z', 'Done')]));
  const final = container.querySelector('[data-message-id="a2"]');
  const toggle = final.querySelector(':scope > .turn-worked');
  assert.ok(toggle);
  assert.equal(toggle.querySelector('.turn-worked-label').textContent, 'Worked for 1m 5s');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(final.classList.contains('turn-final'));
  assert.deepEqual([...container.querySelectorAll('.turn-step-hidden')].map(el => el.dataset.messageId || el.dataset.toolId),
    ['a1', 'b1', 'b2']);
  assert.ok(container.children[2].classList.contains('turn-row-hidden'), 'a row with only hidden steps is hidden');
  assert.equal(final.classList.contains('turn-step-hidden'), false);
  assert.equal(messageText(final, container).includes('Worked for'), false, 'copy text ignores the toggle');
});

test('the toggle expands the steps and the choice survives recomputation', () => {
  render(user('t2', '2026-11-17T00:00:00Z')
    + row([tool('c1', '2026-11-17T00:00:03Z'), text('c2', '2026-11-17T00:00:09Z', 'Answer')]));
  container.querySelector('.turn-worked').click();
  assert.equal(container.querySelector('.turn-step-hidden'), null);
  assert.equal(container.querySelector('.turn-worked').getAttribute('aria-expanded'), 'true');
  updateTurnSummaries(container);
  assert.equal(container.querySelector('.turn-step-hidden'), null);
  assert.equal(container.querySelectorAll('.turn-worked').length, 1);
  container.querySelector('.turn-worked').click();
  assert.deepEqual([...container.querySelectorAll('.turn-step-hidden')].map(el => el.dataset.toolId), ['c1']);
});

test('running turns, step-less answers and turns ending on a tool stay as they are', () => {
  render(user('t3', '2026-11-17T00:00:00Z')
    + row([tool('d1', '2026-11-17T00:00:03Z'), text('d2', '2026-11-17T00:00:05Z', 'Partial')], ' stream-preview'));
  assert.equal(container.querySelector('.turn-worked'), null);
  assert.equal(container.querySelector('.turn-step-hidden'), null);

  render(user('t4', '2026-11-17T00:00:00Z')
    + row([tool('e1', '2026-11-17T00:00:03Z'), text('e2', '2026-11-17T00:00:05Z', 'Answer')]), true);
  assert.equal(container.querySelector('.turn-worked'), null, 'the last turn is still running');

  render(user('t5', '2026-11-17T00:00:00Z') + row([text('f1', '2026-11-17T00:00:05Z', 'Only answer')]));
  assert.equal(container.querySelector('.turn-worked'), null);

  render(user('t6', '2026-11-17T00:00:00Z')
    + row([text('g1', '2026-11-17T00:00:02Z', 'Starting'), tool('g2', '2026-11-17T00:00:05Z')]));
  assert.equal(container.querySelector('.turn-worked'), null);
  assert.equal(container.querySelector('.turn-step-hidden'), null);
});

test('a trailing interrupt does not stop the fold and an earlier final is cleared when text follows', () => {
  render(user('t7', '2026-11-17T00:00:00Z')
    + row([tool('h1', '2026-11-17T00:00:02Z'), text('h2', '2026-11-17T00:00:04Z', 'Answer'),
      '<div class="tl-item msg-interrupt">Interrupted</div>']));
  assert.ok(container.querySelector('[data-message-id="h2"] > .turn-worked'));
  assert.equal(container.querySelector('.msg-interrupt').classList.contains('turn-step-hidden'), false,
    'the Interrupted marker after the answer stays visible');

  render(user('t8', '2026-11-17T00:00:00Z')
    + row([tool('i1', '2026-11-17T00:00:02Z'), text('i2', '2026-11-17T00:00:04Z', 'First')]));
  const turn = container.querySelector('.assistant-turn');
  turn.insertAdjacentHTML('beforeend', tool('i3', '2026-11-17T00:00:06Z') + text('i4', '2026-11-17T00:00:08Z', 'Second'));
  updateTurnSummaries(container);
  assert.equal(container.querySelector('[data-message-id="i2"] > .turn-worked'), null);
  assert.equal(container.querySelector('[data-message-id="i2"]').classList.contains('turn-final'), false);
  assert.ok(container.querySelector('[data-message-id="i4"] > .turn-worked'));
  assert.deepEqual([...container.querySelectorAll('.turn-step-hidden')].map(el => el.dataset.messageId || el.dataset.toolId),
    ['i1', 'i2', 'i3']);
});

test('a running state change refolds without a timeline mutation', async () => {
  const { syncTurnSummaries } = await import('../../web/js/turn-summary.js');
  render(user('t10', '2026-11-17T00:00:00Z')
    + row([tool('k1', '2026-11-17T00:00:03Z'), text('k2', '2026-11-17T00:00:05Z', 'Answer')]));
  assert.ok(container.querySelector('.turn-worked'));
  state.wsRunning = true;
  syncTurnSummaries();
  assert.equal(container.querySelector('.turn-worked'), null, 'the last turn reopens while it runs again');
  state.wsRunning = false;
  syncTurnSummaries();
  assert.ok(container.querySelector('.turn-worked'), 'it folds once the run ends');
});

test('durations read like Codex and an unknown duration still offers the steps', () => {
  assert.equal(formatWorked(400), '1s');
  assert.equal(formatWorked(53000), '53s');
  assert.equal(formatWorked(413000), '6m 53s');
  assert.equal(formatWorked(3 * 3600000 + 120000), '3h 2m');
  render('<div class="msg-user" data-anchor="t9"><div class="msg-text">ask</div></div>'
    + row([tool('j1', ''), text('j2', '', 'Answer')]));
  assert.equal(container.querySelector('.turn-worked-label').textContent, 'Show work');
});
