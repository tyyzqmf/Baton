export const SESSION_ACTIVITY_SYNC_INTERVAL_MS = 30_000;

const ACTIVITY_SYNC_RETENTION_MS = 60 * 60_000;
const ACTIVITY_SYNC_PRUNE_SIZE = 256;

export function activitySyncDue(
  lastSyncAt,
  sessionId,
  now = Date.now(),
  intervalMs = SESSION_ACTIVITY_SYNC_INTERVAL_MS,
) {
  return now - (lastSyncAt.get(sessionId) || 0) >= intervalMs;
}

export function markActivitySynced(lastSyncAt, sessionId, now = Date.now()) {
  lastSyncAt.set(sessionId, now);
  if (lastSyncAt.size <= ACTIVITY_SYNC_PRUNE_SIZE) return;

  const cutoff = now - ACTIVITY_SYNC_RETENTION_MS;
  for (const [id, timestamp] of lastSyncAt) {
    if (timestamp < cutoff) lastSyncAt.delete(id);
  }
}
