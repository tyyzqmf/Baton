import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractCodexMessages } from '../../bridge/codex-extract.mjs';
import {
  mergeFetchWindow,
  mergeLocalHistory,
} from '../../web/js/history-recovery.js';

const CODEX_ROLLOUT_FIXTURE = fileURLToPath(new URL(
  '../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-22222222-2222-4222-8222-222222222222.jsonl',
  import.meta.url,
));

function message(uuid, timestamp, extra = {}) {
  return {
    uuid,
    type: 'assistant',
    content: [{ type: 'text', text: uuid }],
    timestamp,
    ...extra,
  };
}

test('mergeFetchWindow returns an ordered REST-only snapshot without mutating input', () => {
  const restMessages = [
    message('a', '2026-08-27T01:00:00.000Z'),
    message('b', '2026-08-27T01:00:01.000Z'),
  ];
  const result = mergeFetchWindow({
    restMessages,
    historyBuffer: [],
    restOk: true,
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b']);
  assert.equal(result.restOk, true);
  assert.notEqual(result.messages[0], restMessages[0]);
  assert.equal(restMessages[0].identityAliases, undefined);
});

test('mergeFetchWindow keeps complete buffered history when REST fails', () => {
  const result = mergeFetchWindow({
    restMessages: [message('stale-rest', '2026-08-27T01:00:00.000Z')],
    historyBuffer: [
      message('ws-1', '2026-08-27T01:00:01.000Z'),
      message('ws-2', '2026-08-27T01:00:02.000Z'),
    ],
    restOk: false,
  });

  assert.equal(result.restOk, false);
  assert.deepEqual(result.messages.map((item) => item.uuid), ['ws-1', 'ws-2']);
});

test('mergeFetchWindow dedupes REST and WS copies by deterministic UUID with REST precedence', () => {
  const result = mergeFetchWindow({
    restMessages: [message('shared-copy', '2026-08-27T01:00:00.000Z', {
      nativeId: 'codex:item:shared',
      content: [{ type: 'text', text: 'REST full copy' }],
    })],
    historyBuffer: [message('shared-copy', '2026-08-27T01:00:00.000Z', {
      nativeId: 'codex:item:shared',
      content: [{ type: 'text', text: 'different WS copy' }],
    })],
    restOk: true,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].uuid, 'shared-copy');
  assert.equal(result.messages[0].content[0].text, 'REST full copy');
});

test('mergeFetchWindow preserves distinct real messages that reuse one nativeId', () => {
  const result = mergeFetchWindow({
    restMessages: [
      message('first-user-row', '2026-08-27T01:00:00.000Z', {
        nativeId: 'codex:turn:reused:user',
        type: 'user',
        content: 'first prompt',
      }),
      message('second-user-row', '2026-08-27T01:00:01.000Z', {
        nativeId: 'codex:turn:reused:user',
        type: 'user',
        content: 'second prompt',
      }),
    ],
    historyBuffer: [],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['first-user-row', 'second-user-row'],
  );
});

test('mergeFetchWindow replaces truncated or provisional REST copies with complete WS copies', () => {
  const truncated = mergeFetchWindow({
    restMessages: [message('shared-truncated', '2026-08-27T01:00:00.000Z', {
      nativeId: 'shared-truncated',
      truncated: true,
    })],
    historyBuffer: [message('shared-truncated', '2026-08-27T01:00:00.000Z', {
      nativeId: 'shared-truncated',
      content: [{ type: 'text', text: 'complete' }],
    })],
  });
  assert.equal(truncated.messages[0].uuid, 'shared-truncated');
  assert.equal(truncated.messages[0].content[0].text, 'complete');
  assert.equal(truncated.messages[0].truncated, undefined);

  const provisional = mergeFetchWindow({
    restMessages: [message('shared-provisional', '2026-08-27T01:00:00.000Z', {
      nativeId: 'shared-provisional',
      provisional: true,
    })],
    historyBuffer: [message('shared-provisional', '2026-08-27T01:00:00.000Z', {
      nativeId: 'shared-provisional',
    })],
  });
  assert.equal(provisional.messages[0].uuid, 'shared-provisional');
  assert.equal(provisional.messages[0].provisional, undefined);
});

test('mergeFetchWindow preserves REST order and buffered WS arrival order', () => {
  const result = mergeFetchWindow({
    restMessages: [
      message('a', '2026-08-27T01:00:00.000Z'),
      message('c', '2026-08-27T01:00:02.000Z'),
    ],
    historyBuffer: [
      message('d', '2026-08-27T01:00:03.000Z'),
      message('b', '2026-08-27T01:00:01.000Z'),
    ],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'c', 'd', 'b']);
});

test('mergeFetchWindow merges transitive aliases into one canonical message', () => {
  const result = mergeFetchWindow({
    restMessages: [
      message('rest-user', '2026-08-27T01:00:00.000Z', {
        nativeId: 'codex:turn:turn-1:user',
        identityAliases: ['codex-user-logical-1'],
      }),
      message('rest-mirror', '2026-08-27T01:00:00.001Z', {
        nativeId: 'codex:turn:turn-1:mirror',
        identityAliases: ['codex-user-mirror-1'],
      }),
    ],
    historyBuffer: [message('ws-user', '2026-08-27T01:00:00.000Z', {
      nativeId: 'codex:user:client-1',
      identityAliases: ['codex-user-logical-1', 'codex-user-mirror-1'],
    })],
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].uuid, 'rest-user');
  assert.ok(result.messages[0].identityAliases.includes('native:codex:user:client-1'));
  assert.ok(result.messages[0].identityAliases.includes('uuid:ws-user'));
  assert.ok(result.messages[0].identityAliases.includes('uuid:rest-mirror'));
});

test('mergeFetchWindow excludes unique truncated watcher previews from confirmed history', () => {
  const result = mergeFetchWindow({
    restMessages: [],
    historyBuffer: [message('preview', '2026-08-27T01:00:00.000Z', {
      truncated: true,
    })],
  });

  assert.deepEqual(result.messages, []);
});

test('mergeLocalHistory fills an empty local history', () => {
  const fetchedMessages = [
    message('a', '2026-08-27T02:00:00.000Z'),
    message('b', '2026-08-27T02:00:01.000Z'),
  ];
  const result = mergeLocalHistory({
    localMessages: [],
    fetchedMessages,
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b']);
  assert.deepEqual(result.inserted.map((item) => item.index), [0, 1]);
  assert.equal(result.patched.length, 0);
  assert.equal(result.conflicts.length, 0);
});

test('mergeLocalHistory keeps unchanged overlap and object identity', () => {
  const a = message('a', '2026-08-27T02:00:00.000Z');
  const b = message('b', '2026-08-27T02:00:01.000Z');
  const result = mergeLocalHistory({
    localMessages: [a, b],
    fetchedMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
    ],
  });

  assert.equal(result.messages[0], a);
  assert.equal(result.messages[1], b);
  assert.equal(result.inserted.length, 0);
  assert.equal(result.patched.length, 0);
  assert.equal(result.identityUpdated.length, 0);
});

test('mergeLocalHistory appends a fetched tail and inserts missing history in order', () => {
  const result = mergeLocalHistory({
    localMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('c', '2026-08-27T02:00:02.000Z'),
    ],
    fetchedMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
      message('c', '2026-08-27T02:00:02.000Z'),
      message('d', '2026-08-27T02:00:03.000Z'),
    ],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    result.inserted.map((item) => [item.message.uuid, item.index]),
    [['b', 1], ['d', 3]],
  );
});

test('mergeLocalHistory preserves fetched causal order for equal timestamps', () => {
  const timestamp = '2026-08-27T02:00:00.000Z';
  const toolUse = message('z-tool-use', timestamp, {
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  });
  const toolResult = message('a-tool-result', timestamp, {
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
    }],
  });
  const result = mergeLocalHistory({
    localMessages: [toolResult],
    fetchedMessages: [toolUse, toolResult],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['z-tool-use', 'a-tool-result'],
  );
  assert.deepEqual(result.inserted.map((item) => item.index), [0]);
});

test('mergeLocalHistory inserts a missing fetched prefix before the first shared anchor', () => {
  const result = mergeLocalHistory({
    localMessages: [message('c', '2026-08-27T02:00:02.000Z')],
    fetchedMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
      message('c', '2026-08-27T02:00:02.000Z'),
    ],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b', 'c']);
  assert.deepEqual(
    result.inserted.map((item) => [item.message.uuid, item.index]),
    [['a', 0], ['b', 1]],
  );
});

test('mergeLocalHistory appends a fetched suffix when no later shared anchor exists', () => {
  const result = mergeLocalHistory({
    localMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('local-only', '2026-08-27T02:00:02.000Z'),
    ],
    fetchedMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
    ],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['a', 'local-only', 'b'],
  );
  assert.deepEqual(result.inserted.map((item) => item.index), [2]);
});

test('mergeLocalHistory preserves a local tail missing from fetched history', () => {
  const result = mergeLocalHistory({
    localMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
      message('local-newer', '2026-08-27T02:00:02.000Z'),
    ],
    fetchedMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
    ],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['a', 'b', 'local-newer'],
  );
  assert.equal(result.inserted.length, 0);
  assert.equal(result.patched.length, 0);
});

test('mergeLocalHistory patches better fetched copies at the original position', () => {
  const local = [
    message('before', '2026-08-27T02:00:00.000Z'),
    message('shared', '2026-08-27T02:00:01.000Z', {
      truncated: true,
      content: [{ type: 'text', text: 'partial' }],
    }),
    message('after', '2026-08-27T02:00:02.000Z'),
  ];
  const result = mergeLocalHistory({
    localMessages: local,
    fetchedMessages: [message('shared', '2026-08-27T02:00:01.000Z', {
      revision: 2,
      content: [{ type: 'text', text: 'complete' }],
    })],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['before', 'shared', 'after']);
  assert.equal(result.messages[1].content[0].text, 'complete');
  assert.equal(result.messages[1].truncated, undefined);
  assert.equal(result.patched.length, 1);
  assert.equal(result.patched[0].index, 1);
  assert.equal(local[1].content[0].text, 'partial');
});

test('mergeLocalHistory updates the same identity for live authority', () => {
  const local = message('shared', '2026-08-27T02:00:00.000Z', {
    content: [{
      type: 'tool_use',
      id: 'tool-shared',
      name: 'Bash',
      input: { command: '/bin/bash -lc "echo ok"' },
    }],
    _strictManaged: true,
  });
  const result = mergeLocalHistory({
    localMessages: [local],
    replaceConflicts: true,
    fetchedMessages: [message('shared', '2026-08-27T02:00:00.000Z', {
      content: [{
        type: 'tool_use',
        id: 'tool-shared',
        name: 'Bash',
        input: { command: 'echo ok' },
      }],
    })],
  });

  assert.equal(result.messages.length, 1);
  assert.equal(
    result.messages[0].content[0].input.command,
    'echo ok',
  );
  assert.equal(result.messages[0]._strictManaged, undefined);
  assert.equal(result.patched.length, 1);
  assert.equal(result.patched[0].index, 0);
  assert.equal(result.conflicts.length, 0);
});

test('mergeLocalHistory keeps complete local content on a REST conflict', () => {
  const local = message('shared-rest-conflict', '2026-08-27T02:00:00.000Z', {
    content: [{ type: 'text', text: 'complete local content' }],
  });
  const result = mergeLocalHistory({
    localMessages: [local],
    fetchedMessages: [message(
      'shared-rest-conflict',
      '2026-08-27T02:00:00.000Z',
      {
        content: [{ type: 'text', text: 'different REST content' }],
      },
    )],
  });

  assert.equal(result.messages[0], local);
  assert.equal(result.patched.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, 'content-conflict');
});

test('mergeLocalHistory never downgrades complete content with a provisional copy', () => {
  const local = message('shared-complete', '2026-08-27T02:00:00.000Z', {
    nativeId: 'codex:item:shared-complete',
    content: [{ type: 'text', text: 'complete REST content' }],
  });
  const result = mergeLocalHistory({
    localMessages: [local],
    fetchedMessages: [message(
      'shared-complete',
      '2026-08-27T02:00:00.000Z',
      {
        nativeId: 'codex:item:shared-complete',
        turnId: 'turn-shared-complete',
        content: [{
          type: 'text',
          text: 'partial WS content',
          codexProvisional: true,
        }],
      },
    )],
  });

  assert.equal(result.messages[0].content[0].text, 'complete REST content');
  assert.equal(result.messages[0].turnId, 'turn-shared-complete');
  assert.equal(result.patched.length, 0);
});

test('history recovery merges canonical interrupt identity and authoritative stopReason', () => {
  const interruptId = 'codex:turn:native-turn-1:interrupt';
  const local = [
    message('user-one', '2026-08-31T08:11:35.362Z', {
      nativeId: 'codex:user:sent-one',
      turnId: 'sent-one',
      type: 'user',
      content: 'question one',
    }),
    message(interruptId, '2026-08-31T08:11:43.910Z', {
      nativeId: interruptId,
      turnId: 'sent-one',
      type: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    }),
    message('user-two', '2026-08-31T08:11:44.443Z', {
      nativeId: 'codex:user:sent-two',
      turnId: 'sent-two',
      type: 'user',
      content: 'question two',
    }),
    message('assistant-two', '2026-08-31T08:11:45.000Z', {
      nativeId: 'codex:item:assistant-two',
      content: [{ type: 'text', text: 'answer two' }],
    }),
  ];
  const fetched = [
    message('user-one', '2026-08-31T08:11:35.362Z', {
      nativeId: 'codex:user:sent-one',
      type: 'user',
      content: 'question one',
    }),
    message(interruptId, '2026-08-31T08:11:43.925Z', {
      nativeId: interruptId,
      type: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    }),
    message('user-two', '2026-08-31T08:11:44.443Z', {
      nativeId: 'codex:user:sent-two',
      type: 'user',
      content: 'question two',
    }),
    message('assistant-two', '2026-08-31T08:11:45.000Z', {
      nativeId: 'codex:item:assistant-two',
      content: [{ type: 'text', text: 'answer two' }],
      stopReason: 'end_turn',
    }),
  ];

  const result = mergeLocalHistory({
    localMessages: local,
    fetchedMessages: fetched,
    authoritative: true,
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['user-one', interruptId, 'user-two', 'assistant-two'],
  );
  assert.equal(result.messages[1].turnId, 'sent-one');
  assert.equal(result.messages[3].stopReason, 'end_turn');
  assert.equal(result.messages.filter((item) => item.uuid === interruptId).length, 1);
  assert.equal(result.conflicts.length, 0);
});

test('mergeLocalHistory preserves different UUIDs that reuse one nativeId', () => {
  const result = mergeLocalHistory({
    localMessages: [message('local-user', '2026-08-27T02:00:00.000Z', {
      nativeId: 'codex:turn:reused:user',
      type: 'user',
      content: 'first prompt',
    })],
    fetchedMessages: [message('fetched-user', '2026-08-27T02:00:01.000Z', {
      nativeId: 'codex:turn:reused:user',
      type: 'user',
      content: 'second prompt',
    })],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['local-user', 'fetched-user'],
  );
});

test('strict lifecycle preserves distinct UUIDs with identical content', () => {
  const shared = {
    turnId: 'turn-identical-assistants',
    _strictLifecycle: true,
    content: [{ type: 'text', text: 'same answer' }],
  };
  const result = mergeFetchWindow({
    restMessages: [],
    historyBuffer: [
      message('assistant-one', '', shared),
      message('assistant-two', '', shared),
    ],
    restOk: true,
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['assistant-one', 'assistant-two'],
  );
});

test('history recovery preserves legacy user messages that reuse one turn UUID', () => {
  const sharedId = 'codex:turn:turn-reused:user';
  const fetched = [{
    uuid: sharedId,
    nativeId: sharedId,
    type: 'user',
    content: 'first prompt',
    timestamp: '2026-08-31T03:22:04.523Z',
  }, {
    uuid: sharedId,
    nativeId: sharedId,
    type: 'user',
    content: 'second prompt',
    timestamp: '2026-08-31T03:22:34.496Z',
  }];

  const window = mergeFetchWindow({
    restMessages: fetched,
    historyBuffer: [],
    restOk: true,
  });
  const result = mergeLocalHistory({
    localMessages: [],
    fetchedMessages: window.messages,
    authoritative: true,
  });

  assert.deepEqual(
    result.messages.map((item) => item.content),
    ['first prompt', 'second prompt'],
  );
});

test('mergeLocalHistory merges explicit aliases without creating a duplicate', () => {
  const local = message('local-user', '2026-08-27T02:00:00.000Z', {
    nativeId: 'codex:turn:turn-1:user',
    identityAliases: ['logical-user-1'],
    content: [{ type: 'text', text: 'same user prompt' }],
  });
  const result = mergeLocalHistory({
    localMessages: [local],
    fetchedMessages: [message('fetched-user', '2026-08-27T02:00:00.000Z', {
      nativeId: 'codex:user:client-1',
      identityAliases: ['logical-user-1'],
      content: [{ type: 'text', text: 'same user prompt' }],
    })],
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].uuid, 'local-user');
  assert.equal(result.inserted.length, 0);
  assert.equal(result.identityUpdated.length, 1);
  assert.ok(
    result.messages[0].identityAliases.includes('uuid:fetched-user'),
  );
  assert.ok(
    result.messages[0].identityAliases.includes('native:codex:user:client-1'),
  );
});

test('mergeLocalHistory never moves a new row before an already processed alias predecessor', () => {
  const restUser = {
    uuid: 'rest-user',
    nativeId: 'codex:user:turn-1',
    type: 'user',
    content: 'question',
  };
  const answer = {
    uuid: 'answer',
    type: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
  };
  const liveUser = {
    uuid: 'live-user',
    nativeId: 'codex:user:turn-1',
    turnId: 'turn-1',
    type: 'user',
    content: 'question',
  };

  const result = mergeLocalHistory({
    localMessages: [],
    fetchedMessages: [restUser, answer, liveUser],
  });

  assert.deepEqual(
    result.messages.map((message) => message.uuid),
    ['rest-user', 'answer'],
  );
});

test('real Codex rollout preserves every message across REST and WS window overlaps', () => {
  const all = extractCodexMessages(
    CODEX_ROLLOUT_FIXTURE,
    '22222222-2222-4222-8222-222222222222',
  ).messages;
  const expectedOrder = all.map((item) => item.uuid);

  assert.equal(all.length, 11);
  assert.equal(
    new Set(all.map((item) => item.nativeId).filter(Boolean)).size,
    all.filter((item) => item.nativeId).length,
    'stable Codex native ids must uniquely identify each logical message',
  );

  const scenarios = [
    [all, all.slice(-4)],
    [all.slice(0, -2), all.slice(-5)],
    [all.slice(0, -1), all.slice(-1)],
    [all.slice(0, -3), all.slice(-3)],
  ];
  for (const [restMessages, historyBuffer] of scenarios) {
    const result = mergeFetchWindow({ restMessages, historyBuffer });
    assert.deepEqual(result.messages.map((item) => item.uuid), expectedOrder);
  }
});

test('real Codex rollout restores local prefixes, missing rows, and stale snapshots', () => {
  const all = extractCodexMessages(
    CODEX_ROLLOUT_FIXTURE,
    '22222222-2222-4222-8222-222222222222',
  ).messages;
  const expectedOrder = all.map((item) => item.uuid);
  const middle = Math.floor(all.length / 2);
  const truncatedLocal = all.map((item, index) => index === all.length - 1
    ? {
        ...item,
        truncated: true,
        content: [{ type: 'text', text: 'partial fixture preview' }],
      }
    : item);

  const scenarios = [
    [all.slice(0, -3), all],
    [all, all.slice(0, -3)],
    [all.filter((_, index) => index !== middle), all.slice(middle - 2)],
    [all, all.slice(0, -1)],
    [truncatedLocal, all.slice(-1)],
  ];
  for (const [localMessages, fetchedMessages] of scenarios) {
    const result = mergeLocalHistory({ localMessages, fetchedMessages });
    assert.deepEqual(result.messages.map((item) => item.uuid), expectedOrder);
  }
});
