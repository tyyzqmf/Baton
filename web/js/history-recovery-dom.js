/**
 * @param {{state: object, document: Document, runtime: Function, renderMessages: Function, preserveStreamPreviews?: boolean, isCurrentBarrier?: Function, promotePending?: Function, reportConflict?: Function, releaseBarrier?: Function, applyStreamOperations?: Function, markTurnAdjacency?: Function, loadImages?: Function, clampOverflow?: Function, renderMermaidBlocks?: Function, renderKatexBlocks?: Function, updateTitleFromMessages?: Function, markSpinnerTurnEnd?: Function, updateSendBtn?: Function, updateSpinner?: Function}} options
 * @returns {{setMessages: Function, applyHistoryChanges: Function, applyActivity: Function, finalize: Function}}
 */
export function createHistoryRecoveryDomAdapter(options = {}) {
  return buildHistoryRecoveryDomAdapter(options);
}

function domKey(element) {
  if (!element) return '';
  var messageId = element.dataset?.messageId || '';
  var nativeId = element.dataset?.nativeId || '';
  var toolId = element.dataset?.toolId || '';
  if (messageId) return 'uuid:' + messageId + (toolId ? ':tool:' + toolId : '');
  if (nativeId) return 'native:' + nativeId + (toolId ? ':tool:' + toolId : '');
  if (toolId) return 'tool:' + toolId;
  if (element.classList?.contains('msg-user')) {
    return 'user:' + (element.dataset.anchor
      || element.dataset.messageId
      || element.dataset.nativeId
      || element.dataset.ts
      || '');
  }
  var firstIdentity = element.querySelector?.(
    '[data-message-id], [data-native-id], [data-tool-id]',
  );
  if (firstIdentity) return 'group:' + domKey(firstIdentity);
  return 'fallback:' + (element.className || '')
    + ':' + (element.dataset?.ts || '')
    + ':' + (element.textContent || '').trim();
}

function comparableMarkup(element) {
  var clone = element.cloneNode(true);
  var nodes = [clone].concat(Array.from(clone.querySelectorAll('*')));
  for (var node of nodes) {
    node.classList?.remove(
      'tool-details-collapsed',
      'expanded-desc',
      'expanded',
      'clamped',
      'open',
    );
    node.removeAttribute?.('aria-expanded');
    node.removeAttribute?.('data-tool-details-group');
    if (node.classList?.contains('tool-body-content')
      && String(node.id || '').indexOf('tool-') === 0) {
      node.removeAttribute('id');
    }
  }
  for (var button of clone.querySelectorAll('.clamp-btn')) button.remove();
  return clone.outerHTML;
}

function nodeUnchanged(current, expected) {
  if (!current || !expected || current.tagName !== expected.tagName) return false;
  return domKey(current) === domKey(expected)
    && comparableMarkup(current) === comparableMarkup(expected);
}

function sameUserAnchor(current, expected) {
  if (!current?.classList.contains('msg-user')
    || !expected?.classList.contains('msg-user')) {
    return false;
  }
  var currentAnchor = current.dataset?.anchor || '';
  var expectedAnchor = expected.dataset?.anchor || '';
  return !!currentAnchor && currentAnchor === expectedAnchor;
}

function syncUserIdentity(current, expected) {
  if (!current || !expected) return;
  for (var attribute of ['data-anchor', 'data-message-id', 'data-native-id']) {
    if (expected.hasAttribute(attribute)) {
      current.setAttribute(attribute, expected.getAttribute(attribute));
    }
  }
  if (expected.dataset?.ts) current.dataset.serverTs = expected.dataset.ts;
}

function inheritUiState(current, expected) {
  if (!current || !expected) return;
  if (current.classList.contains('tool-node')
    && expected.classList.contains('tool-node')) {
    var collapsed = current.classList.contains('tool-details-collapsed');
    expected.classList.toggle('tool-details-collapsed', collapsed);
    var header = expected.querySelector(':scope > .tool-header');
    if (header?.classList.contains('tool-details-toggle')) {
      header.setAttribute('aria-expanded', String(!collapsed));
    }
  }
}

function reconcileChildren(parent, expectedParent) {
  var existing = Array.from(parent.children);
  var used = new Set();
  var byKey = new Map();
  for (var element of existing) {
    var key = domKey(element);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(element);
  }

  var cursor = parent.firstElementChild;
  for (var expected of Array.from(expectedParent.children)) {
    var candidates = byKey.get(domKey(expected)) || [];
    var current = candidates.find(function (candidate) {
      return !used.has(candidate);
    }) || null;
    if (!current && expected.dataset?.toolId) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && candidate.dataset?.toolId === expected.dataset.toolId;
      }) || null;
    }
    var resolved;
    if (current && nodeUnchanged(current, expected)) {
      used.add(current);
      resolved = current;
      if (resolved !== cursor) parent.insertBefore(resolved, cursor);
    } else {
      inheritUiState(current, expected);
      resolved = expected;
      parent.insertBefore(resolved, cursor);
      if (current) {
        used.add(current);
        current.remove();
      }
    }
    cursor = resolved.nextElementSibling;
  }

  for (var stale of existing) {
    if (!used.has(stale) && stale.isConnected) stale.remove();
  }
}

function reconcileTopLevel(container, expected) {
  var existing = Array.from(container.children);
  var used = new Set();
  var byKey = new Map();
  for (var element of existing) {
    var key = domKey(element);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(element);
  }

  var cursor = container.firstElementChild;
  for (var expectedElement of Array.from(expected.children)) {
    var key = domKey(expectedElement);
    var candidates = byKey.get(key) || [];
    var current = candidates.find(function (candidate) {
      return !used.has(candidate);
    }) || null;
    if (!current && expectedElement.classList.contains('msg-user')) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && sameUserAnchor(candidate, expectedElement);
      }) || null;
    }
    var cursorKey = domKey(cursor);
    if (!current
      && cursor?.classList.contains('assistant-turn')
      && expectedElement.classList.contains('assistant-turn')
      && cursorKey.indexOf('group:uuid:') !== 0
      && !used.has(cursor)) {
      current = cursor;
    }

    var resolved;
    if (current && sameUserAnchor(current, expectedElement)) {
      used.add(current);
      syncUserIdentity(current, expectedElement);
      resolved = current;
    } else if (current?.classList.contains('assistant-turn')
      && expectedElement.classList.contains('assistant-turn')) {
      used.add(current);
      reconcileChildren(current, expectedElement);
      current.className = expectedElement.className;
      for (var attribute of ['data-turn-id', 'data-ts']) {
        if (expectedElement.hasAttribute(attribute)) {
          current.setAttribute(attribute, expectedElement.getAttribute(attribute));
        } else {
          current.removeAttribute(attribute);
        }
      }
      resolved = current;
      if (resolved !== cursor) container.insertBefore(resolved, cursor);
    } else if (current && nodeUnchanged(current, expectedElement)) {
      used.add(current);
      resolved = current;
      if (resolved !== cursor) container.insertBefore(resolved, cursor);
    } else {
      inheritUiState(current, expectedElement);
      resolved = expectedElement;
      container.insertBefore(resolved, cursor);
      if (current) {
        used.add(current);
        current.remove();
      }
    }
    cursor = resolved.nextElementSibling;
  }

  for (var stale of existing) {
    if (!used.has(stale)
      && stale.isConnected
      && !stale.hasAttribute('data-recovery-pending-placeholder')
      && !stale.hasAttribute('data-pending')
      && !(stale.classList.contains('msg-user') && stale.dataset?.anchor)) {
      stale.remove();
    }
  }
}

function restoreStreamPreview(container, streamPreview) {
  var turnId = streamPreview?.dataset?.turnId || '';
  var anchor = turnId
    ? Array.from(container.children).find(function (element) {
        return element.dataset?.anchor === turnId;
      })
    : null;
  if (!anchor) {
    return false;
  }
  var insertionPoint = anchor;
  while (insertionPoint.nextElementSibling?.classList.contains('assistant-turn')
    && insertionPoint.nextElementSibling !== streamPreview) {
    insertionPoint = insertionPoint.nextElementSibling;
  }
  insertionPoint.insertAdjacentElement('afterend', streamPreview);
  return true;
}

function rebuildMessageIndex(messages) {
  var index = new Set();
  for (var message of messages) {
    if (message?.uuid) index.add(message.uuid);
    for (var alias of message?.identityAliases || []) {
      if (!/^(?:turn|pending):/.test(String(alias))) index.add(String(alias));
    }
    if (!message?.uuid && message?.nativeId) {
      index.add('native:' + message.nativeId);
    }
  }
  return index;
}

function isMetadata(message) {
  return message?.type === 'ai-title'
    || message?.type === 'custom-title'
    || message?.type === 'last-prompt';
}

function changeAffectsDom(change) {
  var message = change?.after || change?.message || change?.incoming;
  if (!message || isMetadata(message)) return false;
  if (message.type === 'user'
    && typeof message.content === 'string'
    && /^\s*<subagent_notification>[\s\S]*<\/subagent_notification>\s*$/i
      .test(message.content)) {
    return false;
  }
  return true;
}

function buildHistoryRecoveryDomAdapter(options) {
  var state = options.state;
  var doc = options.document;
  var rendered = false;

  function setMessages(messages) {
    state.wsAllMessages = messages;
    state.wsMessageUuids = rebuildMessageIndex(messages);
    state.wsMessageCount = messages.length;
    state.wsLastTimestamp = messages.length
      ? messages[messages.length - 1].timestamp || ''
      : '';
  }

  function applyHistoryChanges(mergeResult, pendingResult, activity) {
    var changed = (mergeResult.inserted || []).filter(changeAffectsDom).length
      + (mergeResult.patched || []).filter(changeAffectsDom).length
      + (mergeResult.identityUpdated || []).filter(changeAffectsDom).length;
    if (mergeResult.reordered) changed++;
    if (mergeResult.authoritative) changed++;
    if (!changed) return false;
    var container = doc.querySelector('.messages');
    if (!container || container.classList.contains('skeleton-messages')) {
      return false;
    }

    var pendingPlacements = Array.from(container.children)
      .filter(function (node) {
        return node.hasAttribute('data-pending');
      })
      .map(function (node) {
        var marker = doc.createElement('span');
        marker.hidden = true;
        marker.dataset.recoveryPendingPlaceholder = '1';
        node.before(marker);
        return { node: node, marker: marker };
      });
    var pendingNodes = pendingPlacements.map(function (placement) {
      return placement.node;
    });
    var streamPreviews = activity === 'completed'
      && !options.preserveStreamPreviews
      ? []
      : Array.from(container.children).filter(function (node) {
          return node.classList.contains('stream-preview');
        });
    for (var node of pendingNodes.concat(streamPreviews)) node.remove();

    var streamedTurnIds = new Set(streamPreviews.map(function (node) {
      return node.dataset?.turnId || '';
    }).filter(Boolean));
    var renderMessages = streamedTurnIds.size
      ? state.wsAllMessages.map(function (message) {
          if ((message?.type !== 'assistant' && message?.type !== 'summary')
            || !streamedTurnIds.has(message.turnId)) {
            return message;
          }
          return { ...message, _strictManaged: true };
        })
      : state.wsAllMessages;
    var expected = doc.createElement('div');
    expected.innerHTML = options.renderMessages(
      renderMessages,
      options.runtime(),
      { collapseToolDetails: false },
    );
    reconcileTopLevel(container, expected);

    for (var placement of pendingPlacements) {
      if (placement.marker.isConnected) {
        placement.marker.replaceWith(placement.node);
      }
    }
    for (var streamPreview of streamPreviews) {
      restoreStreamPreview(container, streamPreview);
    }
    state.wsRenderedCount = state.wsAllMessages.length;
    rendered = true;
    return true;
  }

  function applyActivity(activity) {
    var wasRunning = state.wsRunning;
    state.wsRunning = activity === 'running';
    if (wasRunning && activity === 'completed') {
      options.markSpinnerTurnEnd?.();
    }
    options.updateSendBtn?.();
    options.updateSpinner?.();
  }

  function finalize() {
    options.updateTitleFromMessages?.();
    if (!rendered) return;
    var container = doc.querySelector('.messages');
    if (!container) return;
    options.markTurnAdjacency?.(container);
    options.loadImages?.(container);
    options.clampOverflow?.(container);
    options.renderMermaidBlocks?.(container);
    options.renderKatexBlocks?.(container);
  }

  return {
    isCurrentBarrier: options.isCurrentBarrier,
    setMessages: setMessages,
    promotePending: options.promotePending,
    applyHistoryChanges: applyHistoryChanges,
    reportConflict: options.reportConflict,
    setPendingMessages: function (pending) {
      state.pendingSentMessages = pending;
    },
    releaseBarrier: options.releaseBarrier,
    applyStreamOperations: options.applyStreamOperations,
    applyActivity: applyActivity,
    finalize: finalize,
  };
}
