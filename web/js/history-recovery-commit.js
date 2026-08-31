import { resolveActivityState } from './runtime-status.js';

/**
 * @param {{mergeResult?: object, pendingMessages?: object[], restResult?: object, activitySnapshot?: object, streamOperations?: object[], adapter?: object}} options
 * @returns {{committed: boolean, activity: 'running'|'needs_input'|'completed', promotedPending: object[], remainingPending: object[]}}
 */
export function commitHistoryRecovery(options = {}) {
  var adapter = options.adapter || {};
  var activitySnapshot = options.activitySnapshot || {};
  if (adapter.isCurrentBarrier && !adapter.isCurrentBarrier()) {
    return {
      committed: false,
      activity: normalizeActivity(activitySnapshot.activityBeforeFetch),
      promotedPending: [],
      remainingPending: (options.pendingMessages || []).slice(),
    };
  }

  var mergeResult = options.mergeResult || {};
  var messages = mergeResult.messages || [];
  var pendingResult = reconcilePendingEchoes(
    options.pendingMessages || [],
    messages,
  );
  var restResult = options.restResult || {};
  var activity = resolveActivityState({
    liveStateChanged: activitySnapshot.liveStateChanged,
    liveActivity: activitySnapshot.liveActivity,
    activityBeforeFetch: activitySnapshot.activityBeforeFetch,
    restOk: restResult.ok,
    restStatus: restResult.status,
    messages: messages,
    runtime: activitySnapshot.runtime,
    hasOutstandingTurns: activitySnapshot.hasOutstandingTurns,
    outstandingTurnIds: activitySnapshot.outstandingTurnIds,
  });

  adapter.setMessages?.(messages);

  for (var promotion of pendingResult.promoted) {
    adapter.promotePending?.(promotion.pending, promotion.echo);
  }
  if (adapter.applyHistoryChanges) {
    adapter.applyHistoryChanges(mergeResult, pendingResult, activity);
  } else {
    for (var patch of mergeResult.patched || []) {
      adapter.patchHistoryNode?.(patch);
    }
    for (var update of mergeResult.identityUpdated || []) {
      adapter.updateHistoryIdentity?.(update);
    }
    for (var insertion of mergeResult.inserted || []) {
      if (!pendingResult.promotedUuids.has(insertion.message?.uuid)) {
        adapter.insertHistoryNode?.(insertion);
      }
    }
  }
  for (var conflict of mergeResult.conflicts || []) {
    adapter.reportConflict?.(conflict);
  }

  adapter.setPendingMessages?.(pendingResult.remaining);
  adapter.restorePending?.(pendingResult.remaining);
  adapter.releaseBarrier?.();
  adapter.applyStreamOperations?.(options.streamOperations || []);

  if (adapter.applyActivity) adapter.applyActivity(activity);
  else {
    adapter.setActivity?.(activity);
    adapter.updateSpinner?.(activity);
  }
  adapter.finalize?.();

  return {
    committed: true,
    activity: activity,
    promotedPending: pendingResult.promoted,
    remainingPending: pendingResult.remaining,
  };
}

function normalizeActivity(value) {
  return value === 'running' || value === 'needs_input' || value === 'completed'
    ? value
    : 'completed';
}

function isUserEcho(message, pending) {
  if (message?.type !== 'user' || !pending?.id) return false;
  if (Array.isArray(message.content)
    && message.content.length
    && message.content.every(function (block) {
      return block?.type === 'tool_result';
    })) {
    return false;
  }
  var turnId = pending.id;
  var promptUuid = String(turnId).replace(/^sent-/, '');
  if (message.turnId === turnId
    || message.uuid === turnId
    || message.uuid === promptUuid
    || message.nativeId === 'codex:user:' + turnId
    || message.nativeId === 'live:user:' + turnId
    || message.nativeId === 'codex:turn:' + turnId + ':user') {
    return true;
  }
  var aliases = new Set(message.identityAliases || []);
  return aliases.has('turn:' + turnId)
    || aliases.has('pending:' + turnId)
    || aliases.has('native:codex:user:' + turnId)
    || aliases.has('native:live:user:' + turnId);
}

function reconcilePendingEchoes(pendingMessages, messages) {
  var promoted = [];
  var remaining = [];
  var promotedUuids = new Set();

  for (var pending of pendingMessages) {
    var echo = messages.find(function (message) {
      return isUserEcho(message, pending);
    });
    if (!echo) {
      remaining.push(pending);
      continue;
    }
    if (!echo.turnId) echo.turnId = pending.id;
    promoted.push({ pending: pending, echo: echo });
    if (echo.uuid) promotedUuids.add(echo.uuid);
  }

  return {
    promoted: promoted,
    remaining: remaining,
    promotedUuids: promotedUuids,
  };
}
