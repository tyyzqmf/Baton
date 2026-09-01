/**
 * Request-scoped buffer that separates confirmed history from strict stream
 * authority while one REST history request is in flight.
 */
export class FetchBarrier {
  constructor(options = {}) {
    this.sessionId = options.sessionId || '';
    this.requestKey = options.requestKey || '';
    this.generation = options.generation || 0;
    this.lifecycleVersion = options.lifecycleVersion || 0;
    this.activityBeforeFetch = options.activityBeforeFetch || 'completed';
    this.localMessages = (options.localMessages || []).slice();
    this.pendingIds = new Set(options.pendingIds || []);
    this.historyBuffer = [];
    this.strictMessages = [];
    this.completedTurnIds = new Set();
    this.state = 'open';
    this.promise = null;
  }

  captureHistory(messages) {
    if (this.state !== 'open') return false;
    for (var message of messages || []) {
      if (!message || message.truncated === true) continue;
      this.historyBuffer.push(message);
    }
    return true;
  }

  captureStrictMessages(messages) {
    if (this.state !== 'open') return false;
    for (var message of messages || []) {
      if (!message) continue;
      if (message.type === 'user' && message.turnId) {
        var firstTurnMessage = this.strictMessages.findIndex(function (candidate) {
          return candidate?.turnId === message.turnId;
        });
        if (firstTurnMessage >= 0) {
          this.strictMessages.splice(firstTurnMessage, 0, message);
          continue;
        }
      }
      var existing = message.uuid
        ? this.strictMessages.find(function (candidate) {
          return candidate?.uuid === message.uuid;
        })
        : null;
      if (existing && message._strictManaged === false) {
        existing._strictManaged = false;
        existing.turnId = existing.turnId || message.turnId || '';
      }
      this.strictMessages.push(message);
    }
    return true;
  }

  completeStrictTurn(turnId) {
    if (this.state !== 'open' || !turnId) return false;
    this.completedTurnIds.add(turnId);
    for (var message of this.strictMessages) {
      if (message?.turnId !== turnId) continue;
      if (message.type === 'assistant' || message.type === 'summary') {
        message._strictManaged = false;
      }
    }
    return true;
  }

  replaceStrictTurn(turnId, messages) {
    if (this.state !== 'open' || !turnId) return false;
    var firstIndex = this.strictMessages.findIndex(function (message) {
      return message?.turnId === turnId;
    });
    this.strictMessages = this.strictMessages.filter(function (message) {
      return message?.turnId !== turnId;
    });
    var insertionIndex = firstIndex >= 0
      ? Math.min(firstIndex, this.strictMessages.length)
      : this.strictMessages.length;
    this.strictMessages.splice(
      insertionIndex,
      0,
      ...(messages || []).filter(Boolean),
    );
    return true;
  }

  beginCommit() {
    if (this.state !== 'open') return false;
    this.state = 'committing';
    return true;
  }

  close() {
    if (this.state === 'closed' || this.state === 'invalid') return false;
    this.state = 'closed';
    return true;
  }

  invalidate() {
    if (this.state === 'closed' || this.state === 'invalid') return false;
    this.state = 'invalid';
    return true;
  }

  isOpen() {
    return this.state === 'open' || this.state === 'committing';
  }
}

export class FetchBarrierCoordinator {
  constructor() {
    this.generation = 0;
    this.active = null;
  }

  open(options = {}) {
    if (this.active?.isOpen()) this.active.invalidate();
    var barrier = new FetchBarrier({
      ...options,
      generation: ++this.generation,
    });
    this.active = barrier;
    return barrier;
  }

  current(sessionId) {
    var barrier = this.active;
    if (!barrier?.isOpen()) return null;
    if (sessionId && barrier.sessionId !== sessionId) return null;
    return barrier;
  }

  isCurrent(barrier) {
    return !!barrier
      && this.active === barrier
      && barrier.generation === this.generation
      && barrier.isOpen();
  }

  close(barrier) {
    if (!this.isCurrent(barrier)) return false;
    barrier.close();
    this.active = null;
    return true;
  }

  invalidate() {
    if (this.active) this.active.invalidate();
    this.active = null;
    this.generation++;
  }
}
