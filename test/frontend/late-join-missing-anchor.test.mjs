import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();

test('late join appends after assistant-only history when no user anchor is loaded', async () => {
  const sessionId = 'codex:late-join-missing-anchor';
  const turnId = 'turn-late-join-missing-anchor';
  resetSession(h, { sessionId });
  const container = h.document.querySelector('.messages');
  container.innerHTML = [
    '<div class="assistant-turn">',
    '<div class="tl-item tool-node tool-details-collapsed">history</div>',
    '</div>',
  ].join('');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    h.hooks.handleWsMessage({
      action: 'stream_block_start',
      sessionId,
      turnId,
      seq: 6,
      kind: 'tool_use',
      name: 'Bash',
    });
    await h.tick(20);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(container.querySelectorAll('.assistant-turn').length, 2);
  assert.match(container.textContent, /history/);
  assert.ok(container.querySelector(`[data-turn-id="${turnId}"]`));
  assert.equal(
    container.querySelector('[data-stream-recovery-anchor]'),
    null,
  );
  assert.ok(warnings.some((warning) =>
    warning.includes('late-join history has no user messages')));
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 7,
  });
  await h.tick(20);
});

test('late join still holds when a different user anchor is loaded', async () => {
  const sessionId = 'codex:late-join-missing-anchor';
  const turnId = 'turn-late-join-wrong-anchor';
  resetSession(h, { sessionId });
  const container = h.document.querySelector('.messages');
  container.innerHTML = [
    '<div class="msg-user" data-anchor="another-turn">another prompt</div>',
    '<div class="assistant-turn">',
    '<div class="tl-item tool-node tool-details-collapsed">history</div>',
    '</div>',
  ].join('');

  h.hooks.handleWsMessage({
    action: 'stream_block_start',
    sessionId,
    turnId,
    seq: 6,
    kind: 'tool_use',
    name: 'Bash',
  });
  await h.tick(20);

  assert.equal(container.querySelectorAll('.assistant-turn').length, 1);
  assert.equal(container.querySelector(`[data-turn-id="${turnId}"]`), null);
});
