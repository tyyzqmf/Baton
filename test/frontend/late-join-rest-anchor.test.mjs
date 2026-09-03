import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('late join attaches WS output to a REST user native identity', async () => {
  const h = await makeHarness();
  await import('../../web/js/components/message.js');
  const sessionId = 'codex:late-join-rest-anchor';
  const turnId = 'turn-rest-native-anchor';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  const user = {
    uuid: 'rest-native-user',
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'continue the running turn',
  };
  const container = h.document.querySelector('.messages');
  container.innerHTML = h.window.renderUserBubble(user);

  const anchor = container.querySelector(`[data-anchor="${turnId}"]`);
  assert.ok(anchor);

  h.hooks.handleWsMessage({
    action: 'stream_block_start',
    sessionId,
    turnId,
    seq: 6,
    kind: 'tool_use',
    name: 'Bash',
  });
  await h.tick(20);

  const preview = container.querySelector(`[data-turn-id="${turnId}"]`);
  assert.ok(preview);
  assert.equal(anchor.nextElementSibling, preview);
  assert.ok(preview.querySelector('.tool-node'));
  h.window.close();
});
