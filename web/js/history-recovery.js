/**
 * @param {{restMessages?: object[], historyBuffer?: object[], restOk?: boolean}} options
 * @returns {{messages: object[], restOk: boolean}}
 */
export function mergeFetchWindow(options = {}) {
  var restOk = options.restOk !== false;
  var messages = [];
  var index = new Map();

  if (restOk) {
    for (var message of options.restMessages || []) {
      upsert(messages, index, message);
    }
  }

  for (var message of options.historyBuffer || []) {
    if (message?.truncated === true) continue;
    upsert(messages, index, message);
  }

  return { messages: messages, restOk: restOk };
}

/**
 * @param {{localMessages?: object[], fetchedMessages?: object[], authoritative?: boolean}} options
 * @returns {{messages: object[], inserted: object[], patched: object[], identityUpdated: object[], conflicts: object[], reordered: boolean, authoritative: boolean}}
 */
export function mergeLocalHistory(options = {}) {
  var messages = (options.localMessages || []).filter(isMessage).slice();
  var index = new Map();
  for (var localMessage of messages) indexMessage(index, localMessage);

  var inserted = [];
  var patched = [];
  var identityUpdated = [];
  var conflicts = [];
  var ambiguousUserIdentity = false;

  var fetchedMessages = options.fetchedMessages || [];
  for (var fetchedIndex = 0; fetchedIndex < fetchedMessages.length; fetchedIndex++) {
    var rawMessage = fetchedMessages[fetchedIndex];
    if (!isMessage(rawMessage) || rawMessage.truncated === true) continue;
    var incoming = cloneMessage(rawMessage);
    if (options.authoritative) delete incoming._strictManaged;
    var matches = findExisting(index, incoming);

    if (!matches.length) {
      var insertedMessage = cloneMessage(incoming);
      var insertedIndex = findFetchedInsertionIndex(
        messages,
        index,
        fetchedMessages,
        fetchedIndex,
      );
      messages.splice(insertedIndex, 0, insertedMessage);
      indexMessage(index, insertedMessage);
      inserted.push({ index: insertedIndex, message: insertedMessage });
      continue;
    }

    matches.sort(function (left, right) {
      return messages.indexOf(left) - messages.indexOf(right);
    });
    var existing = matches[0];
    if (matches.length > 1) {
      if (incoming.type === 'user'
        || matches.some(function (message) {
          return message?.type === 'user';
        })) {
        ambiguousUserIdentity = true;
      }
      conflicts.push({
        type: 'ambiguous-identity',
        incoming: incoming,
        matches: matches.slice(),
      });
      continue;
    }

    if (sameCanonicalContent(existing, incoming)) {
      var identityReplacement = cloneMessage(existing);
      if (!identityReplacement.turnId && incoming.turnId) {
        identityReplacement.turnId = incoming.turnId;
      }
      if (options.authoritative) delete identityReplacement._strictManaged;
      mergeAliases(identityReplacement, [existing, incoming]);
      var presentationChanged =
        existing._strictManaged !== identityReplacement._strictManaged;
      var identityChanged = existing.turnId !== identityReplacement.turnId
        || !sameAliases(existing, identityReplacement);
      if (presentationChanged || identityChanged) {
        var identityIndex = replaceOne(messages, index, existing, identityReplacement);
        var identityChange = {
          index: identityIndex,
          before: existing,
          after: identityReplacement,
        };
        if (presentationChanged) patched.push(identityChange);
        else identityUpdated.push(identityChange);
      }
      continue;
    }

    if (isProvablyBetter(incoming, existing)) {
      var replacement = patchMessage(existing, incoming);
      if (options.authoritative) delete replacement._strictManaged;
      mergeAliases(replacement, [existing, incoming]);
      var patchedIndex = replaceOne(messages, index, existing, replacement);
      patched.push({
        index: patchedIndex,
        before: existing,
        after: replacement,
      });
      continue;
    }

    conflicts.push({
      type: 'content-conflict',
      existing: existing,
      incoming: incoming,
    });
  }

  var reordered = false;
  if (options.authoritative && !ambiguousUserIdentity) {
    var orderedMatches = [];
    var used = new Set();
    var finalIndex = new Map();
    for (var finalMessage of messages) indexMessage(finalIndex, finalMessage);
    for (var fetchedMessage of fetchedMessages) {
      var fetchedMatches = findExisting(finalIndex, fetchedMessage).filter(
        function (message) { return !used.has(message); },
      );
      if (fetchedMatches.length !== 1) continue;
      used.add(fetchedMatches[0]);
      orderedMatches.push(fetchedMatches[0]);
    }
    var matchedIndexes = messages.map(function (message, index) {
      return used.has(message) ? index : -1;
    }).filter(function (index) {
      return index >= 0;
    });
    var firstMatched = matchedIndexes.length
      ? Math.min.apply(null, matchedIndexes)
      : messages.length;
    var lastMatched = matchedIndexes.length
      ? Math.max.apply(null, matchedIndexes)
      : firstMatched - 1;
    var localWithin = messages.slice(firstMatched, lastMatched + 1).filter(
      function (message) { return !used.has(message); },
    );
    var ordered = messages.slice(0, firstMatched)
      .concat(orderedMatches, localWithin)
      .concat(messages.slice(lastMatched + 1));
    reordered = ordered.some(function (message, index) {
      return message !== messages[index];
    });
    messages = ordered;
    for (var insertion of inserted) {
      insertion.index = messages.indexOf(insertion.message);
    }
    for (var patch of patched) patch.index = messages.indexOf(patch.after);
    for (var update of identityUpdated) {
      update.index = messages.indexOf(update.after);
    }
  }

  return {
    messages: messages,
    inserted: inserted,
    patched: patched,
    identityUpdated: identityUpdated,
    conflicts: conflicts,
    reordered: reordered,
    authoritative: !!options.authoritative,
  };
}

function isMessage(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneMessage(message) {
  var cloned = { ...message };
  if (Array.isArray(message.identityAliases)) {
    cloned.identityAliases = message.identityAliases.slice();
  }
  return cloned;
}

function matchKeys(message) {
  var keys = new Set();
  var legacyTurnUserKey = legacyTurnUserOccurrenceKey(message);
  if (legacyTurnUserKey) keys.add(legacyTurnUserKey);
  else if (message.uuid) keys.add('uuid:' + message.uuid);
  var promptId = promptTurnId(message);
  if (promptId) keys.add('prompt-turn:' + promptId);
  if (typeof message.nativeId === 'string'
    && (message.nativeId.indexOf('codex:user:') === 0
      || message.nativeId.indexOf('live:user:') === 0
      || message.nativeId.indexOf('codex:item:') === 0)) {
    keys.add('native:' + message.nativeId);
  }
  for (var alias of message.identityAliases || []) {
    if (!alias || /^(?:turn|pending):/.test(String(alias))) continue;
    if (legacyTurnUserKey
      && (alias === 'uuid:' + message.uuid
        || alias === 'native:' + message.nativeId)) {
      continue;
    }
    keys.add(String(alias));
  }
  if (!legacyTurnUserKey && !message.uuid && message.nativeId) {
    keys.add('native:' + message.nativeId);
  }
  return keys;
}

function legacyTurnUserOccurrenceKey(message) {
  var nativeId = String(message?.nativeId || '');
  var uuid = String(message?.uuid || '');
  var scope = /^codex:turn:.+:user$/.test(nativeId)
    ? nativeId
    : /^codex:turn:.+:user$/.test(uuid)
      ? uuid
      : '';
  if (message?.type !== 'user' || !scope) return '';
  var occurrence = message.orderKey
    || message.timestamp
    || stableJson(canonicalPayload(message));
  return 'turn-user-occurrence:' + scope + ':' + occurrence;
}

function promptTurnId(message) {
  if (!isPromptUserMessage(message)) return '';
  if (message.turnId) return String(message.turnId);
  var nativeId = String(message.nativeId || '');
  for (var prefix of ['codex:user:', 'live:user:']) {
    if (nativeId.indexOf(prefix) === 0) return nativeId.slice(prefix.length);
  }
  for (var alias of message.identityAliases || []) {
    var value = String(alias || '');
    for (var aliasPrefix of ['prompt-turn:', 'pending:']) {
      if (value.indexOf(aliasPrefix) === 0) {
        return value.slice(aliasPrefix.length);
      }
    }
  }
  var uuid = String(message.uuid || '');
  return uuid.indexOf('codex:user:') === 0
    ? uuid.slice('codex:user:'.length)
    : '';
}

function isPromptUserMessage(message) {
  if (message?.type !== 'user') return false;
  if (Array.isArray(message.content)
    && message.content.length
    && message.content.every(function (block) {
      return block?.type === 'tool_result';
    })) {
    return false;
  }
  var text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(function (block) { return block?.text || ''; }).join('')
      : '';
  if (text === '[Request interrupted by user]'
    || text === '[Request interrupted by user for tool use]') {
    return false;
  }
  return !/^\s*<(?:subagent_notification|local-command-caveat|task-notification|system-reminder)/i
    .test(text);
}

function identityKeys(message) {
  var keys = matchKeys(message);
  if (message.nativeId && !legacyTurnUserOccurrenceKey(message)) {
    keys.add('native:' + message.nativeId);
  }
  return keys;
}

function hasProvisionalContent(message) {
  if (message.provisional === true || message.codexProvisional === true) {
    return true;
  }
  return Array.isArray(message.content) && message.content.some(function (block) {
    return block?.codexProvisional === true;
  });
}

function isProvablyBetter(incoming, existing) {
  if (existing.truncated === true && incoming.truncated !== true) return true;
  if (hasProvisionalContent(existing) && !hasProvisionalContent(incoming)) return true;
  var incomingRevision = Number(incoming.revision);
  var existingRevision = Number(existing.revision);
  return Number.isFinite(incomingRevision)
    && (!Number.isFinite(existingRevision) || incomingRevision > existingRevision);
}

function mergeAliases(canonical, sources) {
  var aliases = new Set();
  for (var source of sources) {
    if (!canonical.turnId && source?.turnId) canonical.turnId = source.turnId;
    for (var key of identityKeys(source)) aliases.add(key);
  }
  if (canonical.nativeId) aliases.delete('native:' + canonical.nativeId);
  if (canonical.uuid) aliases.delete('uuid:' + canonical.uuid);
  if (aliases.size) canonical.identityAliases = Array.from(aliases);
  else delete canonical.identityAliases;
  return canonical;
}

function findExisting(index, message) {
  var matches = new Set();
  for (var key of matchKeys(message)) {
    var existing = index.get(key);
    if (existing) matches.add(existing);
  }
  return Array.from(matches);
}

function indexMessage(index, message) {
  for (var key of matchKeys(message)) index.set(key, message);
}

function replaceIndexedMessages(messages, index, existingMessages, replacement) {
  var positions = existingMessages
    .map(function (message) { return messages.indexOf(message); })
    .filter(function (position) { return position !== -1; })
    .sort(function (left, right) { return left - right; });
  for (var positionIndex = positions.length - 1; positionIndex >= 0; positionIndex--) {
    messages.splice(positions[positionIndex], 1);
  }
  messages.splice(positions.length ? positions[0] : messages.length, 0, replacement);
  for (var [key, value] of index) {
    if (existingMessages.includes(value)) index.delete(key);
  }
  indexMessage(index, replacement);
}

function findFetchedInsertionIndex(messages, index, fetchedMessages, fetchedIndex) {
  var floor = 0;
  for (var previousIndex = fetchedIndex - 1; previousIndex >= 0; previousIndex--) {
    var previousMessage = fetchedMessages[previousIndex];
    if (!isMessage(previousMessage) || previousMessage.truncated === true) continue;
    var previousMatches = findExisting(index, previousMessage);
    var previousPositions = previousMatches.map(function (message) {
      return messages.indexOf(message);
    }).filter(function (position) {
      return position >= 0;
    });
    if (previousPositions.length) {
      floor = Math.max.apply(null, previousPositions) + 1;
      break;
    }
  }

  for (var nextIndex = fetchedIndex + 1; nextIndex < fetchedMessages.length; nextIndex++) {
    var nextMessage = fetchedMessages[nextIndex];
    if (!isMessage(nextMessage) || nextMessage.truncated === true) continue;
    var matches = findExisting(index, nextMessage);
    if (!matches.length) continue;
    var positions = matches.map(function (message) {
      return messages.indexOf(message);
    }).filter(function (position) {
      return position >= 0;
    });
    if (positions.length) {
      return Math.max(floor, Math.min.apply(null, positions));
    }
  }
  return Math.max(floor, messages.length);
}

function upsert(messages, index, rawMessage) {
  if (!isMessage(rawMessage)) return;
  var incoming = cloneMessage(rawMessage);
  var existingMessages = findExisting(index, incoming);
  if (!existingMessages.length) {
    messages.push(incoming);
    indexMessage(index, incoming);
    return;
  }

  var canonical = cloneMessage(existingMessages[0]);
  for (var candidate of existingMessages.slice(1).concat(incoming)) {
    if (isProvablyBetter(candidate, canonical)) canonical = cloneMessage(candidate);
  }
  mergeAliases(canonical, existingMessages.concat(incoming));
  replaceIndexedMessages(messages, index, existingMessages, canonical);
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalPayload(message) {
  return {
    type: message.type,
    content: message.content,
    stopReason: message.stopReason,
    toolUseResult: message.toolUseResult,
    truncated: message.truncated,
    provisional: message.provisional,
    revision: message.revision,
    orderKey: message.orderKey,
  };
}

function sameCanonicalContent(left, right) {
  return stableJson(canonicalPayload(left)) === stableJson(canonicalPayload(right));
}

function sameAliases(left, right) {
  var leftAliases = new Set(left.identityAliases || []);
  var rightAliases = new Set(right.identityAliases || []);
  if (leftAliases.size !== rightAliases.size) return false;
  for (var alias of leftAliases) {
    if (!rightAliases.has(alias)) return false;
  }
  return true;
}

function replaceOne(messages, index, existing, replacement) {
  replaceIndexedMessages(messages, index, [existing], replacement);
  return messages.indexOf(replacement);
}

function patchMessage(existing, incoming) {
  var replacement = { ...existing, ...incoming };
  for (var key of ['truncated', 'provisional', 'codexProvisional']) {
    if (!Object.hasOwn(incoming, key)) delete replacement[key];
  }
  return replacement;
}
