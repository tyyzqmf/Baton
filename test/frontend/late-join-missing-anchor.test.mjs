import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('late join without a user anchor logs and keeps the preview detached', async () => {
  const h = await makeHarness();
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

  assert.equal(container.querySelectorAll('.assistant-turn').length, 1);
  assert.equal(container.textContent.trim(), 'history');
  assert.equal(
    container.querySelector('[data-stream-recovery-anchor]'),
    null,
  );
  assert.ok(warnings.some((warning) =>
    warning.includes('late-join turn has no user anchor')));
});
