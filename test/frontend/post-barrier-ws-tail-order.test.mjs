import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('ordinary WS history appends at the confirmed tail regardless of timestamp', async () => {
  const h = await makeHarness();
  const sessionId = 'post-barrier-tail';
  resetSession(h, { sessionId });
  const first = {
    uuid: 'first',
    type: 'user',
    content: 'first',
    timestamp: '2026-08-27T00:00:10.000Z',
  };
  const second = {
    uuid: 'second',
    type: 'assistant',
    content: [{ type: 'text', text: 'second' }],
    timestamp: '2026-08-27T00:00:20.000Z',
  };
  h.state.wsAllMessages = [first, second];
  h.state.wsMessageUuids = new Set(['first', 'second']);
  h.state.wsMessageCount = 2;
  h.state.wsRenderedCount = 2;
  const container = h.document.querySelector('.messages');
  container.innerHTML = h.window.renderMessages([first, second], 'codex');
  container.insertAdjacentHTML(
    'beforeend',
    '<div id="pending" class="msg-user" data-pending="1">pending</div>',
  );

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [{
      uuid: 'late-arrival',
      type: 'assistant',
      content: [{ type: 'text', text: 'late arrival' }],
      timestamp: '2026-08-27T00:00:15.000Z',
    }],
  });

  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    ['first', 'second', 'late-arrival'],
  );
  assert.deepEqual(
    Array.from(container.children).map((node) => node.textContent.trim()),
    ['first', 'second', 'late arrival', 'pending'],
  );
});
