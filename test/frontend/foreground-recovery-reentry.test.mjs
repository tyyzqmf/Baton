import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('repeated foreground recovery preserves buffered consecutive Edit blocks', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-repeat-edit';
  const turnId = 'turn-foreground-repeat-edit';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };

  const user = {
    uuid: 'codex:user:' + turnId,
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'update both panels',
    timestamp: '2026-08-28T08:05:09.897Z',
  };
  h.hooks.handleWsMessage(event(sessionId, turnId, 0, 'stream_turn_start'));
  h.hooks.handleWsMessage(event(sessionId, turnId, 1, 'messages', {
    messages: [user],
  }));
  await h.tick(10);

  const request = deferred();
  h.setApiHandler(() => request.promise);
  const firstRecovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(firstRecovery);

  const firstInput = {
    file_path: '/project/UploadBuildPresetPanel.tsx',
    old_string: 'old build',
    new_string: 'new build',
  };
  for (const item of [
    event(sessionId, turnId, 2, 'stream_block_start', {
      kind: 'tool_use',
      name: 'Edit',
    }),
    event(sessionId, turnId, 3, 'stream_tool_input', {
      chunk: JSON.stringify(firstInput),
    }),
    event(sessionId, turnId, 4, 'stream_block_stop'),
  ]) h.hooks.handleWsMessage(item);

  const secondRecovery = h.hooks.beginSessionConnectionRecovery();
  assert.equal(
    secondRecovery,
    firstRecovery,
    'foreground re-entry must reuse the active recovery and its buffered events',
  );
  h.hooks.startSessionConnectionRecovery(secondRecovery);

  const secondInput = {
    file_path: '/project/UploadSegmentPresetPanel.tsx',
    old_string: 'old segment',
    new_string: 'new segment',
  };
  const toolUse = {
    uuid: 'codex:item:call-edit:tool-use',
    nativeId: 'codex:item:call-edit:tool-use',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'edit-build',
      name: 'Edit',
      input: firstInput,
    }, {
      type: 'tool_use',
      id: 'edit-segment',
      name: 'Edit',
      input: secondInput,
    }],
    timestamp: '2026-08-28T08:05:50.799Z',
    stopReason: 'tool_use',
  };
  const toolResult = {
    uuid: 'codex:item:call-edit:tool-result',
    nativeId: 'codex:item:call-edit:tool-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'edit-build',
      content: 'Applied changes',
      is_error: false,
    }, {
      type: 'tool_result',
      tool_use_id: 'edit-segment',
      content: 'Applied changes',
      is_error: false,
    }],
    timestamp: '2026-08-28T08:05:50.799Z',
  };
  for (const item of [
    event(sessionId, turnId, 5, 'stream_block_start', {
      kind: 'tool_use',
      name: 'Edit',
    }),
    event(sessionId, turnId, 6, 'stream_tool_input', {
      chunk: JSON.stringify(secondInput),
    }),
    event(sessionId, turnId, 7, 'stream_block_stop'),
    event(sessionId, turnId, 8, 'messages', { messages: [toolUse] }),
    event(sessionId, turnId, 9, 'messages', { messages: [toolResult] }),
    event(sessionId, turnId, 10, 'stream_end', {
      messages: [user, toolUse, toolResult],
    }),
  ]) h.hooks.handleWsMessage(item);

  request.resolve({
    messages: [],
    hasMore: false,
    needSync: false,
    status: 'running',
  });
  await h.tick(80);

  assert.equal(
    h.document.querySelectorAll('[data-tool-id="edit-build"]').length,
    1,
  );
  assert.equal(
    h.document.querySelectorAll('[data-tool-id="edit-segment"]').length,
    1,
  );
});
