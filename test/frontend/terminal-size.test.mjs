import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

test('shared terminals adopt the current device size after synchronization without stealing it back from other devices', async context => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://baton.test/', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  let hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  Object.assign(globalThis, {
    window, document, WebSocket: window.WebSocket, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    getComputedStyle: window.getComputedStyle,
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false }),
  });
  const disposable = () => ({ dispose() {} });
  let localSize;
  let terminal;
  let socket;
  window.__sizeRuntime = {
    Terminal: class {
      constructor(options) {
        terminal = this;
        this.options = options;
        this.cols = 80;
        this.rows = 24;
        this.buffer = { active: { baseY: 0, viewportY: 0, length: 24 }, onBufferChange: disposable };
        this.parser = { registerCsiHandler() {}, registerDcsHandler() {}, registerOscHandler() {} };
      }
      loadAddon() {}
      open(screen) { this.textarea = document.createElement('textarea'); screen.appendChild(this.textarea); }
      focus() { this.textarea.focus({ preventScroll: true }); }
      blur() { this.textarea.blur(); }
      onData() {}
      onBinary() {}
      onResize() { return disposable(); }
      reset() {}
      write(data, callback) { callback(); }
      resize(cols, rows) { this.cols = cols; this.rows = rows; }
      scrollLines() {}
      scrollToLine() {}
      scrollToBottom() {}
      dispose() { this.textarea.remove(); }
    },
    FitAddon: class { proposeDimensions() { return localSize; } },
    RemoteTerminalSocket: class extends window.EventTarget {
      constructor() { super(); socket = this; this.sent = []; this.readyState = 0; }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
      receive(message) { this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify(message) })); }
    },
  };
  const vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
    plugins: [{
      name: 'terminal-size-runtime-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (source === './terminal-runtime.js' && importer?.endsWith('/js/terminal.js')) return '\0terminal-size-runtime';
      },
      load(id) {
        if (id === '\0terminal-size-runtime') return 'export const { Terminal, FitAddon, RemoteTerminalSocket } = window.__sizeRuntime;';
      },
    }],
  });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  let terminalModule;
  try {
    terminalModule = await vite.ssrLoadModule('/js/terminal.js');
    const open = async () => {
      await terminalModule.openProjectTerminal({ device: 'Mac', projectHash: 'project', projectName: 'Project' });
      terminal.blur();
      socket.readyState = 1;
      socket.dispatchEvent(new window.Event('open'));
      socket.receive({ type: 'sessions', limit: 5, sessions: [
        { id: 'first', name: 'Terminal 1' }, { id: 'second', name: 'Terminal 2' },
      ] });
    };
    const ready = (size, sessionId = 'first') => socket.receive({ type: 'ready', sessionId, name: 'Terminal',
      epoch: sessionId, ...size, snapshotId: sessionId, snapshotBytes: 0, snapshotChunks: 0, exited: false });
    const synced = (sessionId = 'first') => socket.receive({ type: 'synced', epoch: sessionId, snapshotId: sessionId });
    const resizes = () => socket.sent.filter(message => message.type === 'resize');

    for (const [label, previousSize, nextSize] of [
      ['desktop resumes a phone terminal', { cols: 40, rows: 20 }, { cols: 140, rows: 45 }],
      ['phone resumes a desktop terminal', { cols: 140, rows: 45 }, { cols: 40, rows: 20 }],
      ['unchanged size sends no resize', { cols: 40, rows: 20 }, { cols: 40, rows: 20 }],
    ]) {
      await context.test(label, async () => {
        localSize = nextSize;
        await open();
        ready(previousSize);
        await tick();
        assert.equal(resizes().length, 0, 'snapshot replay must finish at its original dimensions');
        synced();
        await tick();
        if (previousSize.cols !== localSize.cols) {
          assert.equal(resizes().length, 1);
          assert.deepEqual(resizes()[0], { type: 'resize', sessionId: 'first', epoch: 'first', ...localSize });
          socket.receive({ type: 'resized', epoch: 'first', ...localSize });
          await tick();
          assert.equal(terminal.cols, localSize.cols);
          assert.equal(terminal.rows, localSize.rows);
          socket.receive({ type: 'resized', epoch: 'first', ...previousSize });
          await tick();
          assert.equal(resizes().length, 1, 'another device resizing must not start a resize feedback loop');
        } else assert.equal(resizes().length, 0);
        assert.notEqual(document.activeElement, terminal.textarea, 'auto-fit must not open the mobile keyboard');
        terminalModule.closeProjectTerminal();
      });
    }

    for (const resultFirst of [false, true]) {
      await context.test(`switching terminal fits after both sync and operation result (result first: ${resultFirst})`, async () => {
        localSize = { cols: 40, rows: 20 };
        await open();
        ready(localSize);
        synced();
        await tick();
        document.querySelector('.project-terminal-selector').click();
        document.querySelector('[data-action="select"][data-session-id="second"]').click();
        const operation = socket.sent.at(-1);
        assert.equal(operation.type, 'select_session');
        ready({ cols: 140, rows: 45 }, 'second');
        const result = () => socket.receive({ type: 'session_result', requestId: operation.requestId });
        if (resultFirst) result();
        else synced('second');
        await tick();
        assert.equal(resizes().length, 0);
        if (resultFirst) synced('second');
        else result();
        await tick();
        assert.deepEqual(resizes(), [{ type: 'resize', sessionId: 'second', epoch: 'second', ...localSize }]);
        terminalModule.closeProjectTerminal();
      });
    }

    await context.test('background reconnect waits until the page returns to the foreground', async () => {
      localSize = { cols: 40, rows: 20 };
      hidden = true;
      await open();
      ready({ cols: 140, rows: 45 });
      synced();
      await tick();
      assert.equal(resizes().length, 0);
      hidden = false;
      document.dispatchEvent(new window.Event('visibilitychange'));
      assert.deepEqual(resizes(), [{ type: 'resize', sessionId: 'first', epoch: 'first', ...localSize }]);
      document.dispatchEvent(new window.Event('visibilitychange'));
      window.dispatchEvent(new window.Event('focus'));
      assert.equal(resizes().length, 1, 'an in-flight resize is not repeated');
      terminalModule.closeProjectTerminal();
      document.dispatchEvent(new window.Event('visibilitychange'));
      assert.equal(resizes().length, 1, 'closing the page removes the foreground listener');
    });
  } finally {
    terminalModule?.closeProjectTerminal();
    await vite.close();
    window.close();
  }
});
