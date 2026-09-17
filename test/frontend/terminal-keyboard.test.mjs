import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const harness = await makeHarness({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
  visualViewport: { height: 844, offsetTop: 0 },
});

test('the terminal stays inside the keyboard viewport without exposing or shifting the session page', async () => {
  const { window, document, visualViewport } = harness;
  resetSession(harness, { sessionId: 'codex:terminal-keyboard' });
  document.body.insertAdjacentHTML('afterbegin', '<header class="top-bar"></header><div id="breadcrumb"></div>');
  Object.defineProperty(document.querySelector('.top-bar'), 'offsetHeight', { value: 44 });
  Object.defineProperty(document.getElementById('breadcrumb'), 'offsetHeight', { value: 30 });
  Object.assign(globalThis, {
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    getComputedStyle: window.getComputedStyle,
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
  });
  let terminalInstance;
  let socket;
  window.__keyboardRuntime = {
    Terminal: class {
      constructor(options) {
        this.options = options;
        this.cols = 80;
        this.rows = 24;
        this.followCount = 0;
        this.buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0, length: 24 }, onBufferChange: () => ({ dispose() {} }) };
        this.parser = { registerCsiHandler() {}, registerDcsHandler() {}, registerOscHandler() {} };
        terminalInstance = this;
      }
      loadAddon() {}
      open(screen) {
        this.textarea = document.createElement('textarea');
        screen.appendChild(this.textarea);
      }
      focus() { this.textarea.focus({ preventScroll: true }); }
      blur() { this.textarea.blur(); }
      onData(callback) { this.input = callback; }
      onBinary() {}
      onResize() { return { dispose() {} }; }
      reset() {}
      write(data, callback) { callback(); }
      resize(cols, rows) {
        if (this.buffer.active.baseY) {
          this.buffer.active.baseY += this.rows - rows;
          this.buffer.active.viewportY += this.rows - rows;
        }
        this.cols = cols;
        this.rows = rows;
      }
      scrollToBottom() { this.followCount++; this.buffer.active.viewportY = this.buffer.active.baseY; }
      scrollToLine(line) { this.buffer.active.viewportY = line; }
      scrollLines(lines) { this.buffer.active.viewportY = Math.max(0, this.buffer.active.viewportY + lines); }
      registerMarker(offset) {
        return { line: this.buffer.active.baseY + this.buffer.active.cursorY + offset, dispose() {} };
      }
      dispose() { this.textarea.remove(); }
    },
    FitAddon: class {
      proposeDimensions() {
        const height = parseFloat(document.getElementById('projectTerminalPage').style.height);
        return { cols: 40, rows: Math.floor((height - 44) / 20) };
      }
    },
    RemoteTerminalSocket: class extends window.EventTarget {
      constructor() { super(); this.readyState = 0; this.sent = []; socket = this; }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; this.dispatchEvent(new window.Event('close')); }
      receive(message) { this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify(message) })); }
    },
  };
  const vite = await createTestServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom', server: { middlewareMode: true },
    plugins: [{
      name: 'terminal-keyboard-runtime-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (source === './terminal-runtime.js' && importer?.endsWith('/js/terminal.js')) return '\0terminal-keyboard-runtime';
      },
      load(id) {
        if (id === '\0terminal-keyboard-runtime') return 'export const { Terminal, FitAddon, RemoteTerminalSocket } = window.__keyboardRuntime;';
      },
    }],
  });
  let terminalModule;
  try {
    terminalModule = await vite.ssrLoadModule('/js/terminal.js');
    const conversation = document.querySelector('.messages');
    document.getElementById('msg-input').focus();
    visualViewport.height = 420;
    visualViewport.offsetTop = 40;
    visualViewport.dispatch('resize');
    assert.equal(document.body.style.transform, 'translateY(-74px)');

    const opening = terminalModule.openProjectTerminal({ device: 'Mac', projectHash: 'project', projectName: 'Project' });
    assert.equal(document.body.style.transform, '', 'entering with an open keyboard must remove the session translation immediately');
    await opening;
    const page = document.getElementById('projectTerminalPage');
    const screen = page.querySelector('.project-terminal-screen');
    assert.equal(page.style.height, '420px');
    assert.equal(page.style.top, '40px');
    assert.equal(document.body.style.height, '420px');
    assert.equal(document.activeElement, terminalInstance.textarea);

    socket.readyState = 1;
    socket.dispatchEvent(new window.Event('open'));
    socket.receive({ type: 'sessions', limit: 5, sessions: [{ id: 'terminal', name: 'Terminal 1' }] });
    socket.receive({ type: 'ready', sessionId: 'terminal', name: 'Terminal 1', epoch: 'epoch', cols: 40, rows: 18,
      snapshotId: 'snapshot', snapshotBytes: 0, snapshotChunks: 0, exited: false });
    socket.receive({ type: 'synced', epoch: 'epoch', snapshotId: 'snapshot' });
    await harness.tick();
    assert.equal(terminalInstance.options.disableStdin, false);

    for (const [height, offsetTop, rows] of [[844, 0, 40], [420, 40, 18]]) {
      visualViewport.height = height;
      visualViewport.offsetTop = offsetTop;
      visualViewport.dispatch('resize');
      assert.equal(document.body.style.transform, '');
      assert.equal(page.style.height, `${height}px`);
      assert.equal(page.style.top, `${offsetTop}px`);
      assert.equal(document.body.style.height, `${height}px`);
      assert.equal(socket.sent.at(-1).type, 'resize');
      assert.equal(socket.sent.at(-1).rows, rows);
      const followCount = terminalInstance.followCount;
      screen.scrollTop = 80;
      socket.receive({ type: 'resized', epoch: 'epoch', cols: 40, rows });
      await harness.tick();
      assert.equal(terminalInstance.rows, rows);
      assert.equal(terminalInstance.followCount, followCount + 1);
      assert.equal(screen.scrollTop, 0);
      assert.equal(document.activeElement, terminalInstance.textarea);
    }

    visualViewport.offsetTop = 64;
    visualViewport.dispatch('scroll');
    assert.equal(page.style.top, '64px');
    assert.equal(document.body.style.transform, '');
    terminalInstance.input('pwd\r');
    assert.equal(socket.sent.at(-1).type, 'input');
    assert.equal(atob(socket.sent.at(-1).data), 'pwd\r');

    const followCount = terminalInstance.followCount;
    socket.receive({ type: 'resized', epoch: 'epoch', cols: 80, rows: 24 });
    await harness.tick();
    assert.equal(terminalInstance.followCount, followCount, 'another device resizing must not jump local history');

    const dispatch = (target, type, { pointerType = 'touch', clientY = 30 } = {}) => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY, detail: 1 });
      Object.defineProperties(event, {
        pointerType: { value: pointerType }, pointerId: { value: 1 }, isPrimary: { value: true },
      });
      target.dispatchEvent(event);
      return event;
    };
    let refocusCount = 0;
    let clickCount = 0;
    screen.addEventListener('mousedown', () => { refocusCount++; terminalInstance.focus(); });
    screen.addEventListener('click', () => { clickCount++; });

    dispatch(screen, 'pointerdown');
    assert.equal(dispatch(screen, 'pointerup').defaultPrevented, true);
    assert.notEqual(document.activeElement, terminalInstance.textarea, 'a blank tap dismisses the terminal keyboard');
    for (const type of ['mousedown', 'mouseup', 'click']) {
      assert.equal(dispatch(screen, type).defaultPrevented, true);
    }
    assert.equal(refocusCount, 0, 'the dismissing tap must not immediately refocus xterm');
    assert.equal(clickCount, 0);

    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      assert.equal(dispatch(screen, type).defaultPrevented, false);
    }
    assert.equal(document.activeElement, terminalInstance.textarea, 'the next tap can open the keyboard again');
    assert.equal(refocusCount, 1);

    dispatch(screen, 'pointerdown');
    assert.equal(dispatch(screen, 'pointermove', { clientY: 90 }).defaultPrevented, false);
    assert.equal(dispatch(screen, 'pointerup', { clientY: 90 }).defaultPrevented, false);
    assert.equal(document.activeElement, terminalInstance.textarea, 'scroll gestures must not dismiss the keyboard');
    terminalInstance.buffer.active = { viewportY: 30, baseY: 100, cursorY: 0, length: 124 };
    const sentCount = socket.sent.length;
    dispatch(screen, 'pointerdown');
    dispatch(screen, 'pointermove', { clientY: 90 });
    dispatch(screen, 'pointerup', { clientY: 90 });
    assert.equal(socket.sent.length, sentCount, 'browsing by touch must not reclaim another device’s terminal size');
    visualViewport.height = 500;
    visualViewport.dispatch('resize');
    assert.equal(socket.sent.at(-1).type, 'resize');
    socket.receive({ type: 'resized', epoch: 'epoch', cols: 40, rows: 22 });
    await harness.tick();
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    assert.equal(terminalInstance.followCount, followCount, 'a local viewport resize must not leave the history being read');
    assert.equal(terminalInstance.buffer.active.viewportY, 30, 'the same history line stays at the top after resizing');

    terminalInstance.buffer.active.viewportY = terminalInstance.buffer.active.baseY;
    visualViewport.height = 420;
    visualViewport.dispatch('resize');
    terminalInstance.buffer.active.viewportY = 30;
    socket.receive({ type: 'resized', epoch: 'epoch', cols: 40, rows: 18 });
    await harness.tick();
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    assert.equal(terminalInstance.followCount, followCount, 'a delayed resize must not undo a newer history scroll');
    assert.equal(terminalInstance.buffer.active.viewportY, 30);
    dispatch(screen, 'pointerdown');
    dispatch(screen, 'pointercancel');
    assert.equal(dispatch(screen, 'pointerup').defaultPrevented, false);

    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      assert.equal(dispatch(screen, type, { pointerType: 'mouse' }).defaultPrevented, false);
    }
    assert.equal(document.activeElement, terminalInstance.textarea);

    const scrollbar = document.createElement('div');
    scrollbar.className = 'scrollbar';
    screen.appendChild(scrollbar);
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      assert.equal(dispatch(scrollbar, type).defaultPrevented, false);
    }
    assert.equal(document.activeElement, terminalInstance.textarea, 'scrollbar interaction remains available');
    dispatch(screen, 'pointerdown');
    dispatch(screen, 'contextmenu');
    assert.equal(dispatch(screen, 'pointerup').defaultPrevented, false);

    const heading = page.querySelector('.project-terminal-heading');
    dispatch(heading, 'pointerdown');
    dispatch(heading, 'pointerup');
    dispatch(heading, 'click');
    assert.notEqual(document.activeElement, terminalInstance.textarea, 'blank header space also dismisses the keyboard');
    terminalInstance.focus();
    const selector = page.querySelector('.project-terminal-selector');
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      assert.equal(dispatch(selector, type).defaultPrevented, false);
    }
    assert.equal(selector.getAttribute('aria-expanded'), 'true', 'terminal management buttons remain usable on the first tap');
    selector.click();

    terminalInstance.buffer.active.viewportY = 30;
    terminalInstance.blur();
    visualViewport.offsetTop = 0;
    visualViewport.height = 650;
    visualViewport.dispatch('resize');
    assert.equal(socket.sent.at(-1).rows, 30, 'closing the keyboard resizes even after textarea blur');
    visualViewport.height = 844;
    visualViewport.dispatch('resize');
    assert.equal(socket.sent.at(-1).rows, 40);
    socket.receive({ type: 'resized', epoch: 'epoch', cols: 40, rows: 30 });
    socket.receive({ type: 'resized', epoch: 'epoch', cols: 40, rows: 40 });
    await harness.tick();
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    assert.equal(terminalInstance.rows, 40);
    assert.equal(terminalInstance.buffer.active.viewportY, terminalInstance.buffer.active.baseY,
      'after keyboard closing and delayed resize acknowledgements, the prompt stays at the bottom');
    assert.notEqual(document.activeElement, terminalInstance.textarea, 'fitting must not reopen the keyboard');
    assert.equal(screen.scrollTop, 0);

    terminalModule.closeProjectTerminal();
    assert.equal(document.getElementById('projectTerminalPage'), null);
    assert.equal(document.body.style.transform, '');
    assert.equal(document.querySelector('.messages'), conversation);
  } finally {
    terminalModule?.closeProjectTerminal();
    visualViewport.height = 844;
    visualViewport.offsetTop = 0;
    visualViewport.dispatch('resize');
    await vite.close();
    window.close();
  }
});
