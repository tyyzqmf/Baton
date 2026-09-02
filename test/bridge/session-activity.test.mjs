import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activitySyncDue,
  markActivitySynced,
} from '../../bridge/session-activity.mjs';

test('session activity is due only after the configured interval', () => {
  const synced = new Map([['session-1', 1_000]]);
  assert.equal(activitySyncDue(synced, 'session-1', 30_999, 30_000), false);
  assert.equal(activitySyncDue(synced, 'session-1', 31_000, 30_000), true);
  assert.equal(activitySyncDue(synced, 'session-2', 1_000, 30_000), false);
  assert.equal(activitySyncDue(synced, 'session-2', 30_000, 30_000), true);
});

test('session activity timestamps prune old entries after the map grows', () => {
  const synced = new Map();
  for (let index = 0; index < 256; index++) {
    synced.set(`old-${index}`, 1_000);
  }

  markActivitySynced(synced, 'current', 3_601_001);

  assert.deepEqual(Array.from(synced.entries()), [['current', 3_601_001]]);
});
