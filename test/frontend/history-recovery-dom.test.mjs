import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createHistoryRecoveryDomAdapter } from '../../web/js/history-recovery-dom.js';

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

test('history DOM adapter preserves unchanged nodes and keeps pending bubbles last', () => {
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
  assert.equal(container.children[2], pending);
  assert.equal(container.children[1].dataset.messageId, 'two');
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
