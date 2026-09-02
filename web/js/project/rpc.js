import { state } from '../state.js';

var REQUEST_TIMEOUT = 20000;
var pendingRequests = new Map();

function armTimeout(requestId, pending, timeout) {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(function () {
    pendingRequests.delete(requestId);
    pending.reject(new Error('Request timed out — device may be offline.'));
  }, timeout);
}

function requestUuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  var bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (var index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = Array.from(bytes, function (value) {
    return value.toString(16).padStart(2, '0');
  }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-'
    + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

export function requestProjectFiles(operation, fields, options) {
  options = options || {};
  var requestId = requestUuid();
  return new Promise(function (resolve, reject) {
    var pending = {
      resolve: resolve,
      reject: reject,
      timer: null,
      timeout: options.timeout || REQUEST_TIMEOUT,
      onProgress: options.onProgress,
      chunks: new Map(),
      finalSequence: null,
      finalMessage: null,
    };
    pendingRequests.set(requestId, pending);
    armTimeout(requestId, pending, pending.timeout);
    window.wsSendReliable({
      action: 'project_files',
      operation: operation,
      requestId: requestId,
      projectHash: fields.projectHash,
      path: fields.path || '',
      ...(fields.cursor ? { cursor: fields.cursor } : {}),
      device: state.appState.device || '',
    });
  });
}

function completeChunkedRequest(requestId, pending) {
  if (pending.finalSequence === null) return false;
  var chunks = [];
  for (var sequence = 0; sequence <= pending.finalSequence; sequence++) {
    if (!pending.chunks.has(sequence)) return false;
    chunks.push(pending.chunks.get(sequence));
  }
  pendingRequests.delete(requestId);
  if (pending.timer) clearTimeout(pending.timer);
  pending.resolve({
    ...pending.finalMessage,
    content: chunks.join(''),
  });
  return true;
}

export function handleProjectFilesMessage(message) {
  if (!message || message.action !== 'project_files') return false;
  var pending = pendingRequests.get(message.requestId);
  if (!pending) return true;
  if (message.ok === false) {
    pendingRequests.delete(message.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    var error = new Error(message.error || 'Project file request failed.');
    error.response = message;
    pending.reject(error);
    return true;
  }
  if (message.progress) {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (typeof pending.onProgress === 'function') pending.onProgress(message);
    return true;
  }
  if (message.operation === 'read'
    && Number.isInteger(message.sequence)
    && message.sequence >= 0) {
    pending.chunks.set(message.sequence, message.content || '');
    if (message.complete) {
      pending.finalSequence = message.sequence;
      pending.finalMessage = message;
    }
    armTimeout(message.requestId, pending, pending.timeout);
    completeChunkedRequest(message.requestId, pending);
    return true;
  }
  pendingRequests.delete(message.requestId);
  if (pending.timer) clearTimeout(pending.timer);
  pending.resolve(message);
  return true;
}
