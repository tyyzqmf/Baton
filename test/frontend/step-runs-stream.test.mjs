import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();
await import('../../web/js/components/tool.js');
await import('../../web/js/render.js');
await import('../../web/js/turn-summary.js');
for (const name of ['renderToolNode', 'renderMessages', 'renderSingleMessage']) {
  globalThis[name] = harness.window[name];
}
globalThis.renderAssistantText = (text) => text;
globalThis.isToolResultOnly = harness.window.isToolResultOnly = (message) =>
  Array.isArray(message.content) && message.content.length > 0
  && message.content.every((block) => block.type === 'tool_result');

test('streamed steps fold into one summary per run and a commit keeps exactly one each', () => {
  resetSession(harness, { sessionId: 'step-runs-stream' });
  harness.state.appState.runtime = 'claude';
  harness.state.wsRunning = true;
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = harness.window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = harness.window.cancelAnimationFrame = (id) => frames.delete(id);
  const flushFrames = () => {
    for (let pass = 0; frames.size && pass < 200; pass++) {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach((callback) => callback(Date.now() + pass * 1000));
    }
  };
  const container = harness.document.querySelector('.messages');
  const turnId = 'step-runs-turn';
  container.innerHTML = `<div class="msg-user" data-anchor="${turnId}">fold the steps</div>`;
  let sequence = 0;
  const dispatch = (action, extra = {}) => harness.hooks.handleWsMessage({
    action, sessionId: harness.state.wsSessionId, turnId, seq: sequence++, ...extra,
  });
  const say = (chunk) => {
    dispatch('stream_block_start', { kind: 'text' });
    dispatch('stream_delta', { chunk });
    dispatch('stream_block_stop');
    flushFrames();
  };
  const call = (name, input, { stop = true } = {}) => {
    dispatch('stream_block_start', { kind: 'tool_use', name });
    dispatch('stream_tool_input', { chunk: JSON.stringify(input) });
    if (stop) dispatch('stream_block_stop');
    flushFrames();
  };
  const toggles = () => Array.from(container.querySelectorAll('.step-run-toggle'));
  const label = (toggle) => toggle.querySelector('.step-run-label').textContent;

  dispatch('stream_turn_start');
  say('Looking first');
  call('Bash', { command: 'echo one' });
  call('Read', { file_path: '/repo/app.js' });
  say('Now the next part');
  call('Bash', { command: 'echo three' });
  dispatch('stream_block_start', { kind: 'tool_use', name: 'Read' });
  dispatch('stream_tool_input', { chunk: '{"file_path":"/repo/' });
  flushFrames();

  assert.equal(toggles().length, 2);
  assert.equal(label(toggles()[0]), 'Ran 1 command, read 1 file');
  assert.equal(toggles()[0].getAttribute('aria-expanded'), 'false');
  assert.ok(toggles()[1].classList.contains('running'));
  assert.equal(label(toggles()[1]), 'Exploring', 'partial input shows the verb alone');
  const tools = Array.from(container.querySelectorAll('.tool-node'));
  assert.deepEqual(tools.map((node) => node.dataset.toolName), ['Bash', 'Read', 'Bash', 'Read']);
  assert.deepEqual(tools.map((node) => node.classList.contains('step-run-hidden')), [false, true, false, true]);
  assert.deepEqual(Array.from(container.querySelectorAll('.assistant-text'), (node) => node.textContent.trim()),
    ['Looking first', 'Now the next part'], 'texts stay visible');

  dispatch('stream_tool_input', { chunk: 'lib.js"}' });
  dispatch('stream_block_stop');
  flushFrames();
  assert.match(label(toggles()[1]), /^Exploring .*lib\.js$/);

  const at = (second) => `2026-11-19T00:00:${String(second).padStart(2, '0')}Z`;
  const assistant = (uuid, second, block) => ({ uuid, type: 'assistant', timestamp: at(second), content: [block] });
  const messages = [
    assistant('m1', 1, { type: 'text', text: 'Looking first' }),
    assistant('m2', 2, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'echo one' } }),
    assistant('m3', 4, { type: 'tool_use', id: 'u2', name: 'Read', input: { file_path: '/repo/app.js' } }),
    assistant('m4', 9, { type: 'text', text: 'Now the next part' }),
    assistant('m5', 10, { type: 'tool_use', id: 'u3', name: 'Bash', input: { command: 'echo three' } }),
    assistant('m6', 12, { type: 'tool_use', id: 'u4', name: 'Read', input: { file_path: '/repo/lib.js' } }),
  ];
  dispatch('stream_end', { messages });
  harness.state.wsRunning = false;
  flushFrames();
  harness.window.syncTurnSummaries();

  assert.equal(toggles().length, 2, 'the commit reuses the summaries instead of adding new ones');
  assert.equal(container.querySelectorAll('.tool-node').length, 4);
  assert.deepEqual(Array.from(container.querySelectorAll('.tool-node'), (node) => node.dataset.toolId),
    ['u1', 'u2', 'u3', 'u4'], 'the authoritative messages reached the streamed rows');
  assert.equal(toggles()[1].classList.contains('running'), false);
  assert.equal(label(toggles()[1]), 'Ran 1 command, read 1 file');
  assert.equal(toggles()[0].getAttribute('aria-expanded'), 'false');
});
