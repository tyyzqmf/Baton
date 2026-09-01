import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createHistoryRecoveryDomAdapter } from '../../web/js/history-recovery-dom.js';
import { StreamingDomRenderer } from '../../web/js/streaming.js';

function user(message) {
  return '<div class="msg-user" data-message-id="' + message.uuid + '">'
    + message.content + '</div>';
}

function createAdapter(dom, state, extra = {}) {
  return createHistoryRecoveryDomAdapter({
    state,
    document: dom.window.document,
    runtime: () => 'codex',
    renderMessages: (messages) => messages.map((message) => {
      if (message.type === 'ai-title') return '';
      return user(message);
    }).join(''),
    ...extra,
  });
}

test('history DOM adapter preserves unchanged and pending bubble identities', () => {
  const dom = new JSDOM(
    '<div class="messages">'
      + '<div class="msg-user" data-message-id="one">one</div>'
      + '<div id="pending" class="msg-user" data-pending="1">pending</div>'
      + '</div>',
  );
  const container = dom.window.document.querySelector('.messages');
  const unchanged = container.firstElementChild;
  const pending = container.lastElementChild;
  const state = {
    wsAllMessages: [],
    wsMessageUuids: new Set(),
    wsMessageCount: 0,
    wsLastTimestamp: '',
    wsRenderedCount: 0,
    pendingSentMessages: [],
    wsRunning: false,
  };
  const one = { uuid: 'one', type: 'user', content: 'one' };
  const two = { uuid: 'two', type: 'user', content: 'two' };
  const adapter = createAdapter(dom, state);

  adapter.setMessages([one, two]);
  assert.equal(adapter.applyHistoryChanges({
    messages: [one, two],
    inserted: [{ index: 1, message: two }],
  }), true);

  assert.equal(container.children[0], unchanged);
  assert.equal(container.children[1].dataset.messageId, 'two');
  assert.equal(container.children[2], pending);
});

test('metadata-only recovery does not rebuild visible history DOM', () => {
  const dom = new JSDOM(
    '<div class="messages"><div class="msg-user" data-message-id="one">one</div></div>',
  );
  const container = dom.window.document.querySelector('.messages');
  const unchanged = container.firstElementChild;
  const one = { uuid: 'one', type: 'user', content: 'one' };
  const title = { uuid: 'title', type: 'ai-title', content: 'Title' };
  const state = {
    wsAllMessages: [one],
    wsMessageUuids: new Set(['one']),
    wsMessageCount: 1,
    wsLastTimestamp: '',
    wsRenderedCount: 1,
    pendingSentMessages: [],
    wsRunning: false,
  };
  let titleUpdates = 0;
  const adapter = createAdapter(dom, state, {
    updateTitleFromMessages: () => { titleUpdates++; },
  });

  adapter.setMessages([one, title]);
  assert.equal(adapter.applyHistoryChanges({
    messages: [one, title],
    inserted: [{ index: 1, message: title }],
  }), false);
  adapter.finalize();
  assert.equal(container.firstElementChild, unchanged);
  assert.equal(titleUpdates, 1);
});

test('activity commit marks the spinner end only on running to completed', () => {
  const dom = new JSDOM('<div class="messages"></div>');
  const calls = [];
  const state = {
    wsAllMessages: [],
    wsMessageUuids: new Set(),
    wsMessageCount: 0,
    wsLastTimestamp: '',
    wsRenderedCount: 0,
    pendingSentMessages: [],
    wsRunning: true,
  };
  const adapter = createAdapter(dom, state, {
    markSpinnerTurnEnd: () => calls.push('end'),
    updateSendBtn: () => calls.push('button'),
    updateSpinner: () => calls.push('spinner'),
  });

  adapter.applyActivity('completed');

  assert.equal(state.wsRunning, false);
  assert.deepEqual(calls, ['end', 'button', 'spinner']);
});

test('completed recovery cannot reuse a stale stream turn for another answer', () => {
  const turn8 = 'sent-user-eight';
  const turn0 = 'sent-user-zero';
  const answer8 = 'answer-eight';
  const answer0 = 'answer-zero';
  const dom = new JSDOM(
    '<div class="messages">'
      + '<div class="msg-user" data-message-id="user-eight">8</div>'
      + '<div class="assistant-turn"><div class="tl-item assistant-text"'
      + ' data-message-id="' + answer8 + '">8</div></div>'
      + '<div class="msg-user" data-anchor="' + turn0 + '"'
      + ' data-message-id="user-zero">0</div>'
      + '<div class="assistant-turn stream-preview" data-turn-id="' + turn8 + '"></div>'
      + '</div>',
  );
  const container = dom.window.document.querySelector('.messages');
  const messages = [
    { uuid: 'user-eight', type: 'user', content: '8' },
    { uuid: answer8, type: 'assistant', content: '8' },
    { uuid: 'user-zero', turnId: turn0, type: 'user', content: '0' },
    { uuid: answer0, type: 'assistant', content: '0' },
  ];
  const state = {
    wsAllMessages: messages,
    wsMessageUuids: new Set(messages.map((message) => message.uuid)),
    wsMessageCount: messages.length,
    wsLastTimestamp: '',
    wsRenderedCount: 0,
    pendingSentMessages: [],
    wsRunning: false,
  };
  const renderMessages = (items) => items.map((message) => {
    if (message.type === 'user') {
      return '<div class="msg-user"'
        + (message.turnId ? ' data-anchor="' + message.turnId + '"' : '')
        + ' data-message-id="' + message.uuid + '">' + message.content + '</div>';
    }
    return '<div class="assistant-turn"><div class="tl-item assistant-text"'
      + ' data-message-id="' + message.uuid + '">' + message.content
      + '</div></div>';
  }).join('');
  const renderer = new StreamingDomRenderer({
    document: dom.window.document,
    getContainer: () => container,
    findAnchor: (turnId) => container.querySelector(
      '[data-anchor="' + turnId + '"]',
    ),
    renderMarkdown: (element, text) => { element.textContent = text; },
  });
  renderer.createTurn({ turnId: turn8 });
  const adapter = createHistoryRecoveryDomAdapter({
    state,
    document: dom.window.document,
    runtime: () => 'claude',
    renderMessages,
    preserveStreamPreviews: false,
    discardStreamTurn: (turnId) => renderer.discardTurn(turnId),
  });

  adapter.setMessages(messages);
  adapter.applyHistoryChanges({
    messages,
    inserted: [],
    patched: [],
    identityUpdated: [],
    conflicts: [],
    reordered: true,
    authoritative: true,
  }, { promoted: [], remaining: [] }, 'completed');
  renderer.applyOperation({
    type: 'patchBlock',
    turnId: turn8,
    blockId: 2,
    block: {
      blockId: 2,
      kind: 'text',
      text: '8',
      messageId: answer8,
      displayComplete: true,
      stopped: true,
      authoritative: true,
    },
  });

  const answerZeroTurn = container.querySelector(
    '[data-message-id="' + answer0 + '"]',
  )?.parentElement;
  assert.equal(answerZeroTurn?.textContent, '0');
  assert.equal(answerZeroTurn?.querySelectorAll('.tl-item').length, 1);
  assert.equal(container.querySelectorAll(
    '[data-message-id="' + answer8 + '"]',
  ).length, 1);
});

test('recovery patches but never deletes local stream-committed children', () => {
  const turnId = 'turn-committed';
  const dom = new JSDOM(
    '<div class="messages">'
      + '<div class="msg-user" data-anchor="' + turnId + '"'
      + ' data-message-id="user">question</div>'
      + '<div class="assistant-turn stream-committed" data-turn-id="'
      + turnId + '">'
      + '<div class="tl-item tool-node" data-message-id="local-only">local</div>'
      + '<div class="tl-item assistant-text" data-message-id="shared">old</div>'
      + '</div>'
      + '</div>',
  );
  const container = dom.window.document.querySelector('.messages');
  const committed = container.lastElementChild;
  const localOnly = committed.firstElementChild;
  const shared = committed.lastElementChild;
  const messages = [{
    uuid: 'user',
    turnId,
    type: 'user',
    content: 'question',
  }, {
    uuid: 'shared',
    turnId,
    type: 'assistant',
    content: 'new',
  }];
  const state = {
    wsAllMessages: messages,
    wsMessageUuids: new Set(['user', 'shared']),
    wsMessageCount: messages.length,
    wsLastTimestamp: '',
    wsRenderedCount: messages.length,
    pendingSentMessages: [],
    wsRunning: false,
  };
  const adapter = createHistoryRecoveryDomAdapter({
    state,
    document: dom.window.document,
    runtime: () => 'codex',
    renderMessages: () =>
      '<div class="msg-user" data-anchor="' + turnId + '"'
      + ' data-message-id="user">question</div>'
      + '<div class="assistant-turn" data-turn-id="' + turnId + '">'
      + '<div class="tl-item assistant-text" data-message-id="shared">new</div>'
      + '</div>',
  });

  adapter.setMessages(messages);
  adapter.applyHistoryChanges({
    messages,
    inserted: [],
    patched: [{
      before: { uuid: 'shared', type: 'assistant', content: 'old' },
      after: messages[1],
    }],
    identityUpdated: [],
    conflicts: [],
    reordered: false,
    authoritative: true,
  }, { promoted: [], remaining: [] }, 'completed');

  assert.equal(container.lastElementChild, committed);
  assert.equal(localOnly.isConnected, true);
  assert.equal(
    committed.querySelector('[data-message-id="shared"]'),
    shared,
  );
  assert.equal(
    committed.querySelector('[data-message-id="shared"]').textContent,
    'new',
  );
});

test('append-only recovery patches ordinary nodes in place without removing local rows', () => {
  const dom = new JSDOM(
    '<div class="messages">'
      + '<div class="msg-user" data-message-id="shared">old</div>'
      + '<div class="assistant-turn" data-local-only="1">local row</div>'
      + '</div>',
  );
  const container = dom.window.document.querySelector('.messages');
  const shared = container.firstElementChild;
  const localOnly = container.lastElementChild;
  const message = { uuid: 'shared', type: 'user', content: 'new' };
  const state = {
    wsAllMessages: [message],
    wsMessageUuids: new Set(['shared']),
    wsMessageCount: 1,
    wsLastTimestamp: '',
    wsRenderedCount: 1,
    pendingSentMessages: [],
    wsRunning: false,
  };
  const adapter = createHistoryRecoveryDomAdapter({
    state,
    document: dom.window.document,
    runtime: () => 'codex',
    preserveUnmatchedHistory: true,
    renderMessages: () =>
      '<div class="msg-user" data-message-id="shared">new</div>',
  });

  adapter.setMessages([message]);
  adapter.applyHistoryChanges({
    messages: [message],
    inserted: [],
    patched: [{
      before: { uuid: 'shared', type: 'user', content: 'old' },
      after: message,
    }],
    identityUpdated: [],
    conflicts: [],
    reordered: false,
    authoritative: true,
  }, { promoted: [], remaining: [] }, 'completed');

  assert.equal(container.firstElementChild, shared);
  assert.equal(shared.textContent, 'new');
  assert.equal(localOnly.isConnected, true);
  assert.equal(container.lastElementChild, localOnly);
});
