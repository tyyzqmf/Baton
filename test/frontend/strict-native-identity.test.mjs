import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('strict authority updates the same native identity when UUID changes', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:strict-native-reuse';
  const turnId = 'turn-new';
  resetSession(h, { sessionId });

  const oldMessage = {
    uuid: 'old-uuid',
    nativeId: 'codex:item:reused',
    type: 'assistant',
    content: [{ type: 'text', text: 'old answer' }],
    timestamp: '2026-08-31T00:00:00.000Z',
  };
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [oldMessage],
  });

  const userMessage = {
    uuid: 'user-new',
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'new question',
  };
  const newMessage = {
    uuid: 'new-uuid',
    nativeId: 'codex:item:reused',
    type: 'assistant',
    content: [{ type: 'text', text: 'new answer' }],
    timestamp: '2026-08-31T00:00:01.000Z',
  };
  const event = (seq, action, extra = {}) => ({
    action,
    sessionId,
    turnId,
    seq,
    ...extra,
  });

  for (const item of [
    event(0, 'stream_turn_start'),
    event(1, 'messages', { messages: [userMessage] }),
    event(2, 'stream_block_start', { kind: 'text' }),
    event(3, 'stream_delta', { chunk: 'new answer' }),
    event(4, 'stream_block_stop'),
    event(5, 'messages', { messages: [newMessage] }),
    event(6, 'stream_end', { messages: [userMessage, newMessage] }),
  ]) {
    h.hooks.handleWsMessage(item);
  }
  await h.tick(80);

  assert.deepEqual(
    h.state.wsAllMessages
      .filter((message) => message.type === 'assistant')
      .map((message) => message.uuid),
    ['new-uuid'],
  );
  assert.equal(h.document.querySelector('[data-message-id="old-uuid"]'), null);
  assert.ok(h.document.querySelector('[data-message-id="new-uuid"]'));
  h.window.close();
});
