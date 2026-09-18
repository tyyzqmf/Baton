import { realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { MAX_FRAME_BYTES, dimensions, inputBytes, spawnTerminal } from './terminal-pty.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['open', 'input', 'resize', 'heartbeat', 'close']);

export function createTerminalRemote(options) {
  const cwd = realpathSync(options.cwd || process.cwd());
  if (!statSync(cwd).isDirectory()) throw new Error('Terminal cwd must be a directory');
  const shell = options.shell || userInfo().shell || process.env.SHELL || '/bin/bash';
  const shellArgs = options.shellArgs || ['-l', '-i'];
  const sessions = new Map();
  const retired = new Set();
  const leaseMs = options.leaseMs ?? 45000;
  const gapMs = options.gapMs ?? 10000;

  function send(session, message) {
    const envelope = {
      action: 'terminal_poc', v: 1, terminalId: session.id,
      replyConnectionId: session.owner, device: options.device,
      eventSeq: message.type === 'ack' ? 0 : ++session.eventSeq,
      ...(session.profile ? { profile: true } : {}), ...message,
    };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_FRAME_BYTES || options.send(envelope) === false) {
      terminate(session);
      return false;
    }
    return true;
  }

  function reject(message, error) {
    options.send({
      action: 'terminal_poc', v: 1, type: 'error', eventSeq: 0,
      terminalId: message.terminalId, replyConnectionId: message.replyConnectionId,
      device: options.device, message: error,
    });
  }

  function terminate(session) {
    if (session.stopped) return;
    session.stopped = true;
    clearImmediate(session.flushTimer);
    session.output = [];
    session.pending.clear();
    retired.add(`${session.owner}:${session.id}`);
    if (retired.size > 128) retired.delete(retired.values().next().value);
    if (!session.terminal || session.exited) {
      sessions.delete(session.id);
      return;
    }
    session.terminal.kill('SIGHUP');
    session.killTimer = setTimeout(() => session.terminal.kill('SIGKILL'), 1000);
    session.killTimer.unref();
  }

  function fail(session, message) {
    if (!session.stopped) send(session, { type: 'error', message });
    terminate(session);
  }

  function flush(session) {
    clearImmediate(session.flushTimer);
    session.flushTimer = null;
    if (session.stopped || !session.output.length) return;
    const bytes = Buffer.concat(session.output);
    session.output = [];
    session.queuedOutput = 0;
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      if (!send(session, { type: 'output', data: bytes.subarray(offset, offset + 16384).toString('base64') })) break;
    }
  }

  function open(message) {
    if (message.clientSeq !== 0) throw new Error('Open requires clientSeq 0');
    const size = dimensions(message);
    const existing = sessions.get(message.terminalId);
    if (existing) {
      if (existing.owner !== message.replyConnectionId) throw new Error('Terminal belongs to another connection');
      return;
    }
    if (retired.has(`${message.replyConnectionId}:${message.terminalId}`)) throw new Error('Terminal has ended; create a new ID');
    if (sessions.size) throw new Error('POC terminal is busy; close the other page or wait for its lease to expire');
    const session = {
      id: message.terminalId, owner: message.replyConnectionId, eventSeq: 0, nextInput: 1,
      pending: new Map(), pendingBytes: 0, output: [], queuedOutput: 0, totalOutput: 0,
      lastSeen: Date.now(), gapSince: 0, stopped: false, exited: false,
      profile: message.profile === true,
    };
    sessions.set(session.id, session);
    try {
      session.terminal = spawnTerminal({ shell, shellArgs, cwd, ...size });
      session.terminal.onData(bytes => {
        if (session.stopped) return;
        if (!Buffer.isBuffer(bytes)) return fail(session, 'PTY output must be raw bytes');
        session.totalOutput += bytes.length;
        session.queuedOutput += bytes.length;
        if (session.totalOutput > 16 * 1024 * 1024 || session.queuedOutput > 1024 * 1024) {
          return fail(session, 'POC output limit reached; start a new session');
        }
        session.output.push(bytes);
        if (session.queuedOutput >= 16384) flush(session);
        else if (!session.flushTimer) session.flushTimer = setImmediate(() => flush(session));
      });
      session.terminal.onExit(({ exitCode, signal }) => {
        session.exited = true;
        clearTimeout(session.killTimer);
        if (!session.stopped) {
          flush(session);
          send(session, { type: 'exit', exitCode, signal });
        }
        terminate(session);
        sessions.delete(session.id);
      });
      send(session, { type: 'ready', shell, cwd, ...size });
    } catch (error) {
      fail(session, error.message);
    }
  }

  function apply(session, message) {
    if (message.type === 'input') session.terminal.write(inputBytes(message.data));
    else if (message.type === 'resize') {
      const size = dimensions(message);
      session.terminal.resize(size.cols, size.rows);
      send(session, { type: 'resized', ...size });
    } else if (message.type === 'close') {
      send(session, { type: 'closed' });
      terminate(session);
      return;
    }
    session.lastSeen = Date.now();
    send(session, { type: 'ack', clientSeq: message.clientSeq });
  }

  const watchdog = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.stopped) continue;
      if (Date.now() - session.lastSeen > leaseMs) fail(session, 'App heartbeat expired; terminal closed');
      else if (session.gapSince && Date.now() - session.gapSince > gapMs) fail(session, 'Input sequence gap; terminal closed without replay');
    }
  }, Math.min(1000, leaseMs, gapMs));
  watchdog.unref();

  return {
    handle(message) {
      if (message.action !== 'terminal_poc' || message.v !== 1 || !UUID.test(message.terminalId)
        || typeof message.replyConnectionId !== 'string' || !message.replyConnectionId
        || message.replyConnectionId.length > 256) return;
      try {
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME_BYTES || !TYPES.has(message.type)) throw new Error('Invalid terminal message');
        if (message.type === 'open') return open(message);
        const session = sessions.get(message.terminalId);
        if (!session || session.stopped) throw new Error('Terminal is not running');
        if (session.owner !== message.replyConnectionId) throw new Error('Terminal belongs to another connection');
        if (!Number.isSafeInteger(message.clientSeq) || message.clientSeq < 1) throw new Error('Invalid clientSeq');
        if (message.type === 'input') inputBytes(message.data);
        if (message.type === 'resize') dimensions(message);
        if (message.clientSeq < session.nextInput) return;
        if (session.pending.has(message.clientSeq)) {
          if (JSON.stringify(session.pending.get(message.clientSeq)) !== JSON.stringify(message)) fail(session, 'Conflicting input sequence');
          return;
        }
        session.pending.set(message.clientSeq, message);
        session.pendingBytes += Buffer.byteLength(JSON.stringify(message));
        if (message.clientSeq - session.nextInput > 128 || session.pendingBytes > 512 * 1024) return fail(session, 'Input reorder limit exceeded');
        while (!session.stopped && session.pending.has(session.nextInput)) {
          const next = session.pending.get(session.nextInput);
          session.pending.delete(session.nextInput++);
          session.pendingBytes -= Buffer.byteLength(JSON.stringify(next));
          apply(session, next);
        }
        session.gapSince = session.pending.size ? session.gapSince || Date.now() : 0;
      } catch (error) {
        const session = sessions.get(message.terminalId);
        if (session && !session.stopped && session.owner === message.replyConnectionId) fail(session, error.message);
        else reject(message, error.message);
      }
    },
    closeAll() {
      for (const session of sessions.values()) terminate(session);
    },
    dispose() {
      clearInterval(watchdog);
      this.closeAll();
    },
  };
}
