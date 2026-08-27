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
 * @param {{localMessages?: object[], fetchedMessages?: object[]}} options
 * @returns {{messages: object[], inserted: object[], patched: object[], identityUpdated: object[], conflicts: object[]}}
 */
export function mergeLocalHistory(options = {}) {
  var messages = (options.localMessages || []).filter(isMessage).slice();
  var index = new Map();
  for (var localMessage of messages) indexMessage(index, localMessage);

  var inserted = [];
  var patched = [];
  var identityUpdated = [];
  var conflicts = [];

  var fetchedMessages = options.fetchedMessages || [];
  for (var fetchedIndex = 0; fetchedIndex < fetchedMessages.length; fetchedIndex++) {
    var rawMessage = fetchedMessages[fetchedIndex];
    if (!isMessage(rawMessage) || rawMessage.truncated === true) continue;
    var incoming = cloneMessage(rawMessage);
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
      mergeAliases(identityReplacement, [existing, incoming]);
      if (!sameAliases(existing, identityReplacement)) {
        var identityIndex = replaceOne(messages, index, existing, identityReplacement);
        identityUpdated.push({
          index: identityIndex,
          before: existing,
          after: identityReplacement,
        });
      }
      continue;
    }

    if (isProvablyBetter(incoming, existing)) {
      var replacement = patchMessage(existing, incoming);
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

  return {
    messages: messages,
    inserted: inserted,
    patched: patched,
    identityUpdated: identityUpdated,
    conflicts: conflicts,
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
  if (message.uuid) keys.add('uuid:' + message.uuid);
  if (message.turnId) keys.add('turn:' + message.turnId);
  if (message.type === 'user'
    && typeof message.nativeId === 'string'
    && message.nativeId.indexOf('codex:user:') === 0) {
    keys.add('turn:' + message.nativeId.slice('codex:user:'.length));
  }
  for (var alias of message.identityAliases || []) {
    if (alias) keys.add(String(alias));
  }
  if (!message.uuid && message.nativeId) keys.add('native:' + message.nativeId);
  return keys;
}

function identityKeys(message) {
  var keys = matchKeys(message);
  if (message.nativeId) keys.add('native:' + message.nativeId);
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
    timestamp: message.timestamp,
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
