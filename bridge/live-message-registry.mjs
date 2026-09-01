const MAX_LIVE_KEYS = 4096;
const CLAUDE_INTERRUPT_TTL_MS = 60_000;
const pushedEntries = new Map();
const runtimeOwnedEntries = new Set();
const claudeInterruptTurns = new Map();

function composite(runtime, key) {
  return `${runtime}:${key}`;
}

function pushedEntry(runtime, key) {
  if (!runtime || !key) return null;
  const value = composite(runtime, key);
  let current = pushedEntries.get(value);
  if (!current) {
    current = { pushed: false };
    pushedEntries.set(value, current);
    while (pushedEntries.size > MAX_LIVE_KEYS) {
      pushedEntries.delete(pushedEntries.keys().next().value);
    }
  }
  return current;
}

export function registerRuntimeOwnedMessage(runtime, key) {
  if (!runtime || !key) return false;
  runtimeOwnedEntries.add(composite(runtime, key));
  return true;
}

export function liveMessageRoute(runtime, key) {
  if (!runtime || !key) return null;
  const value = composite(runtime, key);
  const pushed = !!pushedEntries.get(value)?.pushed;
  const runtimeOwned = runtimeOwnedEntries.has(value);
  return pushed || runtimeOwned ? { pushed, runtimeOwned } : null;
}

export function markLiveMessagePushed(runtime, key) {
  if (!runtime || !key) return false;
  const current = pushedEntry(runtime, key);
  current.pushed = true;
  return true;
}

export function liveMessagePushed(runtime, key) {
  return !!key && !!pushedEntries.get(composite(runtime, key))?.pushed;
}

function pruneClaudeInterruptTurns(now) {
  for (const [sessionId, entries] of claudeInterruptTurns) {
    const active = entries.filter((entry) => entry.expiresAt > now);
    if (active.length) claudeInterruptTurns.set(sessionId, active);
    else claudeInterruptTurns.delete(sessionId);
  }
}

export function registerClaudeInterruptTurn(
  sessionId,
  turnId,
  now = Date.now(),
) {
  if (!sessionId || !turnId) return false;
  pruneClaudeInterruptTurns(now);
  const entries = claudeInterruptTurns.get(sessionId) || [];
  const existing = entries.find((entry) => entry.turnId === turnId);
  if (existing) {
    existing.expiresAt = now + CLAUDE_INTERRUPT_TTL_MS;
  } else {
    entries.push({
      turnId,
      expiresAt: now + CLAUDE_INTERRUPT_TTL_MS,
    });
  }
  claudeInterruptTurns.set(sessionId, entries);
  return true;
}

export function pendingClaudeInterruptTurn(sessionId, now = Date.now()) {
  if (!sessionId) return '';
  pruneClaudeInterruptTurns(now);
  return claudeInterruptTurns.get(sessionId)?.[0]?.turnId || '';
}

export function clearClaudeInterruptTurn(sessionId, turnId) {
  if (!sessionId || !turnId) return false;
  const entries = claudeInterruptTurns.get(sessionId);
  if (!entries) return false;
  const remaining = entries.filter((entry) => entry.turnId !== turnId);
  if (remaining.length) claudeInterruptTurns.set(sessionId, remaining);
  else claudeInterruptTurns.delete(sessionId);
  return remaining.length !== entries.length;
}

export function clearLiveMessage(runtime, key) {
  if (!runtime || !key) return false;
  const value = composite(runtime, key);
  const pushed = pushedEntries.delete(value);
  const runtimeOwned = runtimeOwnedEntries.delete(value);
  return pushed || runtimeOwned;
}

export function clearLiveMessageRegistry() {
  pushedEntries.clear();
  runtimeOwnedEntries.clear();
  claudeInterruptTurns.clear();
}
