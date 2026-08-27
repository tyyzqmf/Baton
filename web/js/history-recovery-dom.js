/**
 * @param {{state: object, document: Document, runtime: Function, renderMessages: Function, deferRender?: boolean, isCurrentBarrier?: Function, promotePending?: Function, reportConflict?: Function, releaseBarrier?: Function, applyStreamOperations?: Function, markTurnAdjacency?: Function, loadImages?: Function, clampOverflow?: Function, renderMermaidBlocks?: Function, renderKatexBlocks?: Function, updateTitleFromMessages?: Function, markSpinnerTurnEnd?: Function, updateSendBtn?: Function, updateSpinner?: Function}} options
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
    var cursorKey = domKey(cursor);
    if (!current
      && cursor?.classList.contains('assistant-turn')
      && expectedElement.classList.contains('assistant-turn')
      && cursorKey.indexOf('group:uuid:') !== 0
      && !used.has(cursor)) {
      current = cursor;
    }

    var resolved;
    if (current?.classList.contains('assistant-turn')
      && expectedElement.classList.contains('assistant-turn')) {
      used.add(current);
      reconcileChildren(current, expectedElement);
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
    if (!used.has(stale) && stale.isConnected) stale.remove();
  }
}

function rebuildMessageIndex(messages) {
  var index = new Set();
  for (var message of messages) {
    if (message?.uuid) index.add(message.uuid);
    for (var alias of message?.identityAliases || []) index.add(String(alias));
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

  function applyHistoryChanges(mergeResult) {
    var changed = (mergeResult.inserted || []).filter(changeAffectsDom).length
      + (mergeResult.patched || []).filter(changeAffectsDom).length
      + (mergeResult.identityUpdated || []).filter(changeAffectsDom).length;
    if (!changed || options.deferRender) return false;
    var container = doc.querySelector('.messages');
    if (!container || container.classList.contains('skeleton-messages')) {
      return false;
    }

    var protectedNodes = Array.from(container.children).filter(function (node) {
      return node.hasAttribute('data-pending')
        || node.classList.contains('stream-preview');
    });
    for (var node of protectedNodes) node.remove();

    var expected = doc.createElement('div');
    expected.innerHTML = options.renderMessages(
      state.wsAllMessages,
      options.runtime(),
      { collapseToolDetails: false },
    );
    reconcileTopLevel(container, expected);

    for (var protectedNode of protectedNodes) {
      container.appendChild(protectedNode);
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
