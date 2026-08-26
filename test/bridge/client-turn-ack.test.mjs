import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldCacheClientTurnAck } from '../../bridge/ws.mjs';

function result(overrides = {}) {
  return {
    action: 'send_message_result',
    turnId: 'turn-1',
    ok: true,
    ...overrides,
  };
}

test('terminal send results are cached for idempotent delivery', () => {
  assert.equal(shouldCacheClientTurnAck(result()), true);
  assert.equal(shouldCacheClientTurnAck(result({
    ok: false,
    errorCode: 'session_unavailable',
  })), true);
});

test('retriable send results are not cached', () => {
  assert.equal(shouldCacheClientTurnAck(result({
    ok: false,
    errorCode: 'previous_turn_missing',
  })), false);
  assert.equal(shouldCacheClientTurnAck(result({
    ok: false,
    errorCode: 'codex_active_writer',
  })), false);
  assert.equal(shouldCacheClientTurnAck(result({ queued: true })), false);
});

test('unscoped events are not cached as client turn results', () => {
  assert.equal(shouldCacheClientTurnAck({ action: 'heartbeat' }), false);
  assert.equal(shouldCacheClientTurnAck(result({ turnId: '' })), false);
});
