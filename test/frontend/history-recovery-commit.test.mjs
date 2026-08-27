import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractCodexMessages } from '../../bridge/codex-extract.mjs';
import {
  deriveActivityFromMessages,
  resolveActivityState,
} from '../../web/js/runtime-status.js';
import { commitHistoryRecovery } from '../../web/js/history-recovery-commit.js';
import {
  mergeFetchWindow,
  mergeLocalHistory,
} from '../../web/js/history-recovery.js';

const CODEX_ROLLOUT_FIXTURE = fileURLToPath(new URL(
  '../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-22222222-2222-4222-8222-222222222222.jsonl',
  import.meta.url,
));

function assistant(uuid, stopReason = '') {
  return {
    uuid,
    type: 'assistant',
    content: [{ type: 'text', text: uuid }],
    timestamp: '2026-08-27T03:00:00.000Z',
    ...(stopReason ? { stopReason } : {}),
  };
}

test('resolveActivityState gives newer live activity priority over REST status', () => {
  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'running',
    activityBeforeFetch: 'completed',
    restOk: true,
    restStatus: 'completed',
  }), 'running');

  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'completed',
    activityBeforeFetch: 'running',
    restOk: true,
    restStatus: 'running',
  }), 'completed');

  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'needs_input',
    restOk: true,
    restStatus: 'running',
  }), 'needs_input');

  assert.equal(resolveActivityState({
    liveStateChanged: true,
    liveActivity: 'running',
    restOk: true,
    restStatus: 'needs_input',
  }), 'running');
});

test('resolveActivityState preserves pre-fetch activity when REST fails', () => {
  assert.equal(resolveActivityState({
    activityBeforeFetch: 'running',
    restOk: false,
    restStatus: 'completed',
  }), 'running');
  assert.equal(resolveActivityState({
    activityBeforeFetch: 'needs_input',
    restOk: false,
  }), 'needs_input');
});

test('resolveActivityState uses REST status and terminal-tail fallback', () => {
  assert.equal(resolveActivityState({
    restOk: true,
    restStatus: 'needs_input',
  }), 'needs_input');
  assert.equal(resolveActivityState({
    restOk: true,
    restStatus: 'completed',
  }), 'completed');
  assert.equal(resolveActivityState({
    restOk: true,
    restStatus: 'running',
    messages: [assistant('done', 'end_turn')],
  }), 'completed');
  assert.equal(resolveActivityState({
    restOk: true,
    restStatus: 'running',
    messages: [
      assistant('previous', 'end_turn'),
      {
        uuid: 'new-user',
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-27T03:00:01.000Z',
      },
    ],
    runtime: 'codex',
  }), 'running');
});

test('resolveActivityState preserves the existing summary-tail decision supplied by the caller', () => {
  assert.equal(resolveActivityState({
    restOk: true,
    restStatus: 'running',
    messages: [
      assistant('done', 'end_turn'),
      {
        uuid: 'summary',
        type: 'summary',
        content: 'context compacted',
        timestamp: '2026-08-27T03:00:01.000Z',
      },
    ],
  }), 'running');
});

test('resolveActivityState falls back to outstanding turns and runtime activity', () => {
  assert.equal(resolveActivityState({
    restOk: true,
    hasOutstandingTurns: true,
    messages: [],
  }), 'running');
  assert.equal(resolveActivityState({
    restOk: true,
    runtime: 'codex',
    messages: [{
      uuid: 'user',
      type: 'user',
      content: 'continue',
    }],
  }), 'running');
  assert.equal(resolveActivityState({ restOk: true }), 'completed');
});

test('deriveActivityFromMessages preserves Claude and Codex runtime rules', () => {
  assert.equal(deriveActivityFromMessages({
    runtime: 'claude',
    messages: [assistant('tool', 'tool_use')],
  }), 'running');
  assert.equal(deriveActivityFromMessages({
    runtime: 'claude',
    messages: [assistant('done', 'end_turn')],
  }), 'completed');
  assert.equal(deriveActivityFromMessages({
    runtime: 'codex',
    messages: [{
      uuid: 'user',
      type: 'user',
      content: 'continue',
    }],
  }), 'running');
  assert.equal(deriveActivityFromMessages({
    runtime: 'codex',
    messages: [assistant('done', 'end_turn')],
  }), 'completed');
});

test('commitHistoryRecovery applies minimal UI changes in a fixed order', () => {
  const echo = {
    uuid: 'echo-user',
    nativeId: 'codex:user:turn-1',
    type: 'user',
    content: 'prompt',
    timestamp: '2026-08-27T03:00:00.000Z',
  };
  const answer = assistant('answer');
  const calls = [];
  const pendingOne = { id: 'turn-1', text: 'prompt' };
  const pendingTwo = { id: 'turn-2', text: 'later prompt' };

  const result = commitHistoryRecovery({
    mergeResult: {
      messages: [echo, answer],
      inserted: [
        { index: 0, message: echo },
        { index: 1, message: answer },
      ],
      patched: [{ index: 1, before: {}, after: answer }],
      identityUpdated: [{ index: 0, before: {}, after: echo }],
      conflicts: [{ type: 'content-conflict' }],
    },
    pendingMessages: [pendingOne, pendingTwo],
    restResult: { ok: true, status: 'completed' },
    activitySnapshot: {
      liveStateChanged: true,
      liveActivity: 'running',
      activityBeforeFetch: 'completed',
    },
    streamOperations: [{ type: 'createTurn' }, { type: 'createBlock' }],
    adapter: {
      isCurrentBarrier: () => true,
      setMessages: (messages) => calls.push(['messages', messages.length]),
      promotePending: (pending) => calls.push(['promote', pending.id]),
      patchHistoryNode: (patch) => calls.push(['patch', patch.index]),
      updateHistoryIdentity: (update) => calls.push(['identity', update.index]),
      insertHistoryNode: (insertion) => calls.push(['insert', insertion.message.uuid]),
      reportConflict: (conflict) => calls.push(['conflict', conflict.type]),
      setPendingMessages: (pending) => calls.push(['pending-state', pending.map((item) => item.id)]),
      restorePending: (pending) => calls.push(['pending-dom', pending.map((item) => item.id)]),
      applyStreamOperations: (operations) => calls.push(['stream', operations.length]),
      setActivity: (activity) => calls.push(['activity', activity]),
      updateSpinner: (activity) => calls.push(['spinner', activity]),
    },
  });

  assert.deepEqual(calls, [
    ['messages', 2],
    ['promote', 'turn-1'],
    ['patch', 1],
    ['identity', 0],
    ['insert', 'answer'],
    ['conflict', 'content-conflict'],
    ['pending-state', ['turn-2']],
    ['pending-dom', ['turn-2']],
    ['stream', 2],
    ['activity', 'running'],
    ['spinner', 'running'],
  ]);
  assert.equal(result.committed, true);
  assert.equal(result.activity, 'running');
  assert.equal(result.promotedPending.length, 1);
  assert.deepEqual(result.remainingPending, [pendingTwo]);
});

test('commitHistoryRecovery never text-matches a pending user bubble', () => {
  const serverUser = {
    uuid: 'unscoped-user',
    type: 'user',
    content: 'same text',
    timestamp: '2026-08-27T03:00:00.000Z',
  };
  const pending = { id: 'turn-1', text: 'same text' };
  const inserted = [];
  const promoted = [];

  const result = commitHistoryRecovery({
    mergeResult: {
      messages: [serverUser],
      inserted: [{ index: 0, message: serverUser }],
    },
    pendingMessages: [pending],
    restResult: { ok: true, status: 'completed' },
    adapter: {
      insertHistoryNode: (entry) => inserted.push(entry.message.uuid),
      promotePending: (entry) => promoted.push(entry.id),
    },
  });

  assert.deepEqual(inserted, ['unscoped-user']);
  assert.deepEqual(promoted, []);
  assert.deepEqual(result.remainingPending, [pending]);
});

test('commitHistoryRecovery ignores a stale barrier without side effects', () => {
  var calls = 0;
  const pending = [{ id: 'turn-1' }];
  const result = commitHistoryRecovery({
    mergeResult: { messages: [assistant('ignored')] },
    pendingMessages: pending,
    activitySnapshot: { activityBeforeFetch: 'needs_input' },
    adapter: {
      isCurrentBarrier: () => false,
      setMessages: () => { calls++; },
      setActivity: () => { calls++; },
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.committed, false);
  assert.equal(result.activity, 'needs_input');
  assert.deepEqual(result.remainingPending, pending);
});

test('real Codex rollout commits recovered history and applies completed REST status', () => {
  const all = extractCodexMessages(
    CODEX_ROLLOUT_FIXTURE,
    '22222222-2222-4222-8222-222222222222',
  ).messages;
  const fetched = mergeFetchWindow({
    restMessages: all.slice(0, -2),
    historyBuffer: all.slice(-4),
  });
  const merged = mergeLocalHistory({
    localMessages: all.slice(0, -3),
    fetchedMessages: fetched.messages,
  });
  const calls = [];

  const result = commitHistoryRecovery({
    mergeResult: merged,
    pendingMessages: [],
    restResult: { ok: true, status: 'completed' },
    activitySnapshot: {
      liveStateChanged: false,
      activityBeforeFetch: 'running',
    },
    adapter: {
      setMessages: (messages) => calls.push(['messages', messages.length]),
      insertHistoryNode: (entry) => calls.push(['insert', entry.message.uuid]),
      setActivity: (activity) => calls.push(['activity', activity]),
      updateSpinner: (activity) => calls.push(['spinner', activity]),
    },
  });

  assert.deepEqual(
    merged.messages.map((message) => message.uuid),
    all.map((message) => message.uuid),
  );
  assert.equal(result.activity, 'completed');
  assert.deepEqual(calls.at(-2), ['activity', 'completed']);
  assert.deepEqual(calls.at(-1), ['spinner', 'completed']);
});
