import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();
test.after(() => h.window.close());

function runningSession() {
  resetSession(h, { sessionId: 'escape-scope' });
  const sent = [];
  h.state.ws = { readyState: 1, send(payload) { sent.push(JSON.parse(payload)); }, close() {} };
  h.state.wsRunning = true;
  return sent;
}

function escape(target) {
  const event = new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('Esc in the composer still interrupts a running turn', () => {
  const sent = runningSession();
  escape(h.document.getElementById('msg-input'));
  assert.ok(sent.some(payload => payload.action === 'interrupt'));
});

test('Esc in another field, such as the sidebar search, never interrupts', () => {
  const sent = runningSession();
  const search = h.document.createElement('input');
  search.type = 'search';
  h.document.body.appendChild(search);
  try {
    escape(search);
    assert.equal(sent.some(payload => payload.action === 'interrupt'), false);
  } finally { search.remove(); }
});

test('Esc while a dialog overlay is open belongs to the dialog', () => {
  const sent = runningSession();
  const overlay = h.document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  h.document.body.appendChild(overlay);
  try {
    escape(h.document.body);
    assert.equal(sent.some(payload => payload.action === 'interrupt'), false);
    overlay.style.display = 'none';
    escape(h.document.body);
    assert.ok(sent.some(payload => payload.action === 'interrupt'), 'a hidden overlay does not block it');
  } finally { overlay.remove(); }
});
