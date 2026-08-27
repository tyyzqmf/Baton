import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FetchBarrier,
  FetchBarrierCoordinator,
} from '../../web/js/fetch-barrier.js';

test('FetchBarrier keeps complete history and strict authority in separate buffers', () => {
  const barrier = new FetchBarrier({
    sessionId: 'session-1',
    localMessages: [{ uuid: 'local' }],
  });

  barrier.captureHistory([
    { uuid: 'history' },
    { uuid: 'truncated', truncated: true },
  ]);
  barrier.captureStrictMessages([{ uuid: 'strict' }]);

  assert.deepEqual(barrier.historyBuffer.map((message) => message.uuid), ['history']);
  assert.deepEqual(barrier.strictMessages.map((message) => message.uuid), ['strict']);
  assert.deepEqual(barrier.localMessages.map((message) => message.uuid), ['local']);
});

test('FetchBarrier stops accepting messages once commit begins', () => {
  const barrier = new FetchBarrier({ sessionId: 'session-1' });

  assert.equal(barrier.beginCommit(), true);
  assert.equal(barrier.captureHistory([{ uuid: 'late' }]), false);
  assert.equal(barrier.captureStrictMessages([{ uuid: 'strict-late' }]), false);
  assert.equal(barrier.close(), true);
  assert.equal(barrier.isOpen(), false);
});

test('FetchBarrierCoordinator invalidates stale generations', () => {
  const coordinator = new FetchBarrierCoordinator();
  const first = coordinator.open({ sessionId: 'session-1' });
  const second = coordinator.open({ sessionId: 'session-2' });

  assert.equal(first.state, 'invalid');
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
  assert.equal(coordinator.current('session-1'), null);
  assert.equal(coordinator.current('session-2'), second);
  assert.equal(coordinator.close(second), true);
  assert.equal(coordinator.current('session-2'), null);
});
