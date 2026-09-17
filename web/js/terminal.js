import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../css/terminal.css';
import { RemoteTerminalSocket } from './terminal-remote-transport.js';
import { backButtonHtml } from './components/back-button.js';
import { setBreadcrumbItemsLoading } from './components/breadcrumb.js';
import { registerEdgeBackLayer } from './edge-back.js';

let view = null;
const encoder = new TextEncoder();
const edgeBack = registerEdgeBackLayer({ navigateBack: closeProjectTerminal,
  foregroundSelectors: ['#projectTerminalPage'], guardZIndex: 902, foregroundZIndex: 900 });

function decode(data) {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0));
}

export function closeProjectTerminal() {
  if (!view) return false;
  const previous = view;
  view = null;
  edgeBack.deactivate();
  clearTimeout(previous.reconnect);
  clearTimeout(previous.ackTimer);
  clearTimeout(previous.syncTimer);
  clearTimeout(previous.operationTimer);
  previous.socket?.close();
  setBreadcrumbItemsLoading([previous.projectLabel], false);
  previous.observer.disconnect();
  for (const dispose of previous.listeners) dispose();
  previous.terminal.dispose();
  previous.page.remove();
  previous.returnFocus?.isConnected && previous.returnFocus.focus({ preventScroll: true });
  return true;
}

export function openProjectTerminal({ device, projectHash, projectName }) {
  if (view?.device === device && view.projectHash === projectHash) return view.terminal.focus();
  closeProjectTerminal();
  const page = document.createElement('section');
  page.id = 'projectTerminalPage';
  page.className = 'project-terminal-page';
  page.setAttribute('aria-label', 'Project terminal');
  page.innerHTML = '<header class="path-breadcrumb project-terminal-header">' + backButtonHtml({ label: 'Back to project' })
    + '<div class="project-terminal-heading"><span class="path-breadcrumb-item project-terminal-project"></span></div>'
    + '<button class="project-terminal-action project-terminal-retry" type="button" hidden>Reconnect</button>'
    + '<button class="project-terminal-action project-terminal-selector" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="terminalMenu" disabled><span class="project-terminal-selection">Terminals</span><span aria-hidden="true">▾</span></button></header>'
    + '<div class="project-terminal-status" role="status" hidden></div>'
    + '<main class="project-terminal-screen"></main>'
    + '<div class="project-terminal-menu" id="terminalMenu" role="dialog" aria-modal="true" aria-labelledby="terminalMenuTitle" hidden>'
    + '<div class="project-terminal-menu-panel"><div class="project-terminal-menu-heading"><span id="terminalMenuTitle">Terminals</span><span class="project-terminal-count"></span>'
    + '<button class="project-terminal-add" type="button" aria-label="New terminal" title="New terminal">＋</button></div><div class="project-terminal-list"></div></div></div>'
    + '<div class="modal-overlay project-terminal-confirm" style="display:none" role="dialog" aria-modal="true" aria-labelledby="terminalCloseTitle">'
    + '<div class="modal-box"><div class="modal-title" id="terminalCloseTitle">Close terminal?</div>'
    + '<div class="modal-desc">This stops the terminal and its running process for all connected devices.</div>'
    + '<div class="modal-actions"><button class="modal-btn cancel" type="button">Cancel</button>'
    + '<button class="modal-btn confirm danger" type="button">Close terminal</button></div></div></div>';
  const returnFocus = document.activeElement;
  document.body.appendChild(page);
  const projectLabel = page.querySelector('.project-terminal-project');
  projectLabel.textContent = projectName || 'Terminal';
  projectLabel.title = projectName || 'Terminal';
  const terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 1000, allowProposedApi: true,
    fontFamily: 'Menlo, Monaco, Consolas, monospace', disableStdin: true,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const screen = page.querySelector('.project-terminal-screen');
  terminal.open(screen);
  const selectionKey = `terminal-selection:${JSON.stringify([localStorage.getItem('_as'), device, projectHash])}`;
  let selection;
  try { selection = sessionStorage.getItem(selectionKey); } catch {}
  const current = view = { page, terminal, fit, device, projectHash, returnFocus, listeners: [],
    ready: false, exited: false, generation: 0, queuedBytes: 0, ackBytes: 0, lastAck: 0,
    sessions: [], limit: 5, sessionId: selection, busy: null,
    projectLabel, status: page.querySelector('.project-terminal-status'),
    selector: page.querySelector('.project-terminal-selector'), retry: page.querySelector('.project-terminal-retry'),
    menu: page.querySelector('.project-terminal-menu'), list: page.querySelector('.project-terminal-list'),
    add: page.querySelector('.project-terminal-add'),
    modal: page.querySelector('.project-terminal-confirm'), writes: Promise.resolve() };
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    current.listeners.push(() => target.removeEventListener(name, callback, options));
  };

  function status(text, state = 'connected') {
    setBreadcrumbItemsLoading([current.projectLabel], state === 'connecting' || state === 'syncing');
    current.status.textContent = text;
    current.status.dataset.state = state;
    current.status.hidden = state !== 'error' && state !== 'warning';
  }

  function rememberSelection() {
    try {
      if (current.sessionId) sessionStorage.setItem(selectionKey, current.sessionId);
      else sessionStorage.removeItem(selectionKey);
    } catch {}
  }

  function controls() {
    const disabled = !current.ready || !!current.busy;
    const selected = current.sessions.find(session => session.id === current.sessionId);
    current.selector.disabled = disabled;
    current.selector.title = 'Switch or manage terminals';
    page.querySelector('.project-terminal-selection').textContent = selected?.name || current.sessionName || 'Terminals';
    page.querySelector('.project-terminal-count').textContent = `${current.sessions.length}/${current.limit}`;
    current.add.disabled = disabled || current.sessions.length >= current.limit;
    current.add.title = current.sessions.length >= current.limit ? 'Maximum 5 terminals' : 'New terminal';
    terminal.options.disableStdin = !current.ready || !!current.busy || current.exited || !current.sessionId;
    const focused = document.activeElement;
    const focusId = current.list.contains(focused) ? focused.dataset.sessionId : null;
    const focusAction = focused?.dataset.action;
    current.list.replaceChildren();
    for (const session of current.sessions) {
      const row = document.createElement('div');
      row.className = 'project-terminal-row';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'project-terminal-option';
      select.dataset.action = 'select';
      select.dataset.sessionId = session.id;
      select.disabled = disabled;
      select.setAttribute('aria-current', session.id === current.sessionId ? 'true' : 'false');
      const check = document.createElement('span');
      check.className = 'project-terminal-check';
      check.textContent = session.id === current.sessionId ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = session.name;
      select.append(check, name);
      if (session.exited) {
        const exited = document.createElement('span');
        exited.className = 'project-terminal-exited';
        exited.textContent = 'Exited';
        select.append(exited);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'project-terminal-close';
      close.dataset.action = 'close';
      close.dataset.sessionId = session.id;
      close.disabled = disabled;
      close.setAttribute('aria-label', `Close ${session.name}`);
      close.title = `Close ${session.name}`;
      close.textContent = '×';
      row.append(select, close);
      current.list.appendChild(row);
    }
    if (focusId && !current.menu.hidden) {
      const replacement = [...current.list.querySelectorAll('button')].find(button => button.dataset.sessionId === focusId && button.dataset.action === focusAction && !button.disabled);
      (replacement || current.add).focus({ preventScroll: true });
    }
  }

  function settledStatus() {
    if (!current.ready || current.busy) return;
    const text = current.exited ? 'Shell exited · Close this terminal or create a new one'
      : current.historyTruncated ? 'Recent history omitted' : '';
    status(text, text ? 'warning' : 'connected');
    if (current.focusAfterSync && current.sessionId && !current.exited && matchMedia('(pointer: fine)').matches) terminal.focus();
    current.focusAfterSync = false;
  }

  function menu(open) {
    current.menu.hidden = !open;
    current.selector.setAttribute('aria-expanded', String(open));
    if (open) {
      current.menu.style.setProperty('--terminal-menu-top', `${page.querySelector('header').getBoundingClientRect().height + 4}px`);
      terminal.blur();
      (current.list.querySelector('[aria-current="true"]') || current.add).focus({ preventScroll: true });
    } else current.selector.focus({ preventScroll: true });
  }

  function operate(type, sessionId) {
    if (!current.ready || current.busy) return;
    menu(false);
    const requestId = crypto.randomUUID();
    current.busy = requestId;
    current.focusAfterSync = type !== 'close_session' || sessionId === current.sessionId;
    controls();
    status('Updating terminals…', 'syncing');
    if (!send({ type, requestId, ...(sessionId ? { sessionId } : {}), ...(type === 'create_session' ? proposedSize() : {}) })) {
      fail('Terminal connection is unavailable', true);
      return;
    }
    current.operationTimer = setTimeout(() => {
      fail('Terminal operation result unknown; reconnecting without repeating it', true);
      current.socket?.close();
    }, 15000);
  }

  function proposedSize() {
    const size = fit.proposeDimensions();
    return { cols: Math.min(400, Math.max(20, size?.cols || 80)), rows: Math.min(200, Math.max(5, size?.rows || 24)) };
  }

  function send(message) {
    if (view !== current || current.socket?.readyState !== WebSocket.OPEN) return false;
    current.socket.send(JSON.stringify({ sessionId: current.sessionId, ...message, epoch: current.epoch }));
    return true;
  }

  function useLocalSize() {
    if (!current.ready || current.exited || !current.sessionId || current.busy || !current.menu.hidden) return;
    const size = proposedSize();
    if ((terminal.cols !== size.cols || terminal.rows !== size.rows)
      && (current.requestedSize?.cols !== size.cols || current.requestedSize?.rows !== size.rows)) {
      current.requestedSize = size;
      send({ type: 'resize', ...size });
    }
  }

  function input(bytes) {
    if (!current.ready || current.exited || !current.sessionId || current.busy || view !== current) return;
    if (bytes.length > 64 * 1024) return status('Paste exceeds 64 KiB; nothing sent', 'error');
    useLocalSize();
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 4096)));
      if (!send({ type: 'input', data })) break;
    }
  }

  function acknowledge() {
    clearTimeout(current.ackTimer);
    current.ackTimer = null;
    if (!current.lastAck) return;
    send({ type: 'render_ack', eventSeq: current.lastAck });
    current.lastAck = 0;
    current.ackBytes = 0;
  }

  function write(data) {
    return new Promise(resolve => terminal.write(data, resolve));
  }

  function fail(message, reconnect = false) {
    if (view !== current) return;
    current.ready = false;
    terminal.options.disableStdin = true;
    clearTimeout(current.operationTimer);
    current.busy = null;
    menu(false);
    controls();
    current.failure = message;
    clearTimeout(current.syncTimer);
    current.modal.style.display = 'none';
    if (reconnect && !current.reconnect && (current.reconnectCount || 0) < 5) {
      current.reconnectCount = (current.reconnectCount || 0) + 1;
      current.reconnect = setTimeout(() => { current.reconnect = null; connect(); }, Math.min(15000, current.reconnectCount * 3000));
    }
    current.retry.hidden = !!current.reconnect;
    status(message, current.reconnect ? 'connecting' : 'error');
  }

  async function receive(message, generation) {
    if (view !== current || generation !== current.generation) return;
    if (message.type === 'sessions') {
      if (!Array.isArray(message.sessions) || message.sessions.length > 5 || message.limit !== 5
        || message.sessions.some(session => typeof session.id !== 'string' || typeof session.name !== 'string')) throw new Error('Invalid terminal list');
      current.sessions = message.sessions;
      if (current.closingId && !current.sessions.some(session => session.id === current.closingId)) closeConfirmation();
      controls();
    } else if (message.type === 'session_result') {
      if (message.requestId !== current.busy) return;
      clearTimeout(current.operationTimer);
      current.busy = null;
      controls();
      if (message.error) { current.focusAfterSync = false; status(message.error, 'error'); }
      else settledStatus();
    } else if (message.type === 'ready') {
      if (!current.sessions.some(session => session.id === message.sessionId)) throw new Error('终端列表未同步，请更新 Bridge 后重新连接');
      clearTimeout(current.ackTimer);
      current.ackTimer = null;
      current.lastAck = 0;
      current.ackBytes = 0;
      current.requestedSize = null;
      current.ready = false;
      current.exited = message.exited;
      current.epoch = message.epoch;
      current.sessionId = message.sessionId;
      current.sessionName = message.name;
      rememberSelection();
      current.snapshotId = message.snapshotId;
      current.snapshotIndex = 0;
      current.snapshotBytes = 0;
      current.snapshotTotal = message.snapshotBytes;
      current.snapshotChunks = message.snapshotChunks;
      current.historyTruncated = message.historyTruncated;
      terminal.options.disableStdin = true;
      terminal.reset();
      terminal.resize(message.cols, message.rows);
      current.page.dataset.sessionId = message.sessionId;
      current.page.dataset.epoch = message.epoch;
      current.page.dataset.cwd = message.cwd;
      controls();
      status('Syncing screen…', 'syncing');
      clearTimeout(current.syncTimer);
      current.syncTimer = setTimeout(() => { fail('Screen sync timed out; reconnect to restore'); current.socket?.close(); }, 60000);
    } else if (message.type === 'snapshot') {
      if (message.epoch !== current.epoch || message.snapshotId !== current.snapshotId || message.index !== current.snapshotIndex) throw new Error('Snapshot sequence mismatch');
      const bytes = decode(message.data);
      current.snapshotBytes += bytes.length;
      if (current.snapshotBytes > current.snapshotTotal || current.snapshotTotal > 4 * 1024 * 1024) throw new Error('Snapshot exceeds limit');
      await write(bytes);
      if (view !== current || generation !== current.generation) return;
      current.snapshotIndex++;
      send({ type: 'render_ack', eventSeq: message.eventSeq, snapshotId: message.snapshotId, index: message.index });
    } else if (message.type === 'synced') {
      if (message.epoch !== current.epoch || message.snapshotId !== current.snapshotId
        || current.snapshotBytes !== current.snapshotTotal || current.snapshotIndex !== current.snapshotChunks) throw new Error('Incomplete terminal snapshot');
      clearTimeout(current.syncTimer);
      current.ready = true;
      current.reconnectCount = 0;
      current.retry.hidden = true;
      controls();
      settledStatus();
    } else if (message.type === 'output') {
      if (message.epoch !== current.epoch) throw new Error('Terminal generation mismatch');
      const bytes = decode(message.data);
      await write(bytes);
      if (view !== current || generation !== current.generation) return;
      current.lastAck = message.eventSeq;
      current.ackBytes += bytes.length;
      if (current.ackBytes >= 16384) acknowledge();
      else if (!current.ackTimer) current.ackTimer = setTimeout(acknowledge, 100);
    } else if (message.type === 'resized') {
      current.requestedSize = null;
      if (message.epoch === current.epoch) terminal.resize(message.cols, message.rows);
    } else if (message.type === 'exit') {
      current.exited = true;
      terminal.options.disableStdin = true;
      settledStatus();
    } else if (message.type === 'error') {
      if (message.fatal) { fail(message.message); current.socket?.close(); }
      else status(message.message, 'error');
    }
  }

  function connect() {
    if (view !== current) return;
    current.generation++;
    const generation = current.generation;
    clearTimeout(current.reconnect);
    clearTimeout(current.ackTimer);
    current.reconnect = null;
    current.ackTimer = null;
    current.lastAck = 0;
    current.ackBytes = 0;
    current.ready = false;
    current.busy = null;
    current.failure = null;
    terminal.options.disableStdin = true;
    controls();
    current.retry.hidden = true;
    current.socket?.close();
    status('Connecting…', 'connecting');
    const socket = current.socket = new RemoteTerminalSocket(device, { direct: true, projectHash });
    socket.addEventListener('open', () => {
      if (view === current && generation === current.generation) socket.send(JSON.stringify({ type: 'open', sessionId: current.sessionId, ...proposedSize() }));
    });
    socket.addEventListener('message', event => {
      if (view !== current || generation !== current.generation) return;
      const message = JSON.parse(event.data);
      const size = message.data?.length || 0;
      current.queuedBytes += size;
      if (current.queuedBytes > 1024 * 1024) { fail('Terminal display is behind; reconnect to restore'); socket.close(); return; }
      current.writes = current.writes.then(() => receive(message, generation)).catch(error => {
        if (generation === current.generation) { fail(error.message); socket.close(); }
      }).finally(() => { current.queuedBytes -= size; });
    });
    socket.addEventListener('error', event => {
      if (view === current && generation === current.generation) {
        const message = event.data || 'Terminal connection failed';
        fail(message, !/更新|目录|最多|无效|权限|unsupported/i.test(message));
      }
    });
    socket.addEventListener('close', () => {
      if (view === current && generation === current.generation && !current.failure) fail('Disconnected · reconnecting; background shell is retained', true);
    });
  }

  function closeConfirmation() {
    current.modal.style.display = 'none';
    current.closingId = null;
    current.selector.focus({ preventScroll: true });
  }

  listen(page.querySelector('.back-button'), 'click', closeProjectTerminal);
  listen(current.retry, 'click', () => { current.reconnectCount = 0; connect(); });
  listen(current.selector, 'click', () => menu(current.menu.hidden));
  listen(current.add, 'click', () => operate('create_session'));
  listen(current.menu, 'click', event => { if (event.target === current.menu) menu(false); });
  listen(current.list, 'click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const session = current.sessions.find(candidate => candidate.id === button.dataset.sessionId);
    if (!session) return;
    if (button.dataset.action === 'select') {
      if (session.id === current.sessionId) menu(false);
      else operate('select_session', session.id);
    } else {
      menu(false);
      current.closingId = session.id;
      const restart = current.sessions.length === 1;
      current.modal.querySelector('.modal-title').textContent = `${restart ? 'Restart' : 'Close'} ${session.name}?`;
      current.modal.querySelector('.modal-desc').textContent = restart
        ? 'This stops the current process and starts a new terminal for all connected devices.'
        : 'This stops the terminal and its running process for all connected devices.';
      current.modal.querySelector('.confirm').textContent = restart ? 'Restart terminal' : 'Close terminal';
      current.modal.style.display = 'flex';
      current.modal.querySelector('.cancel').focus({ preventScroll: true });
    }
  });
  listen(current.modal.querySelector('.cancel'), 'click', closeConfirmation);
  listen(current.modal, 'click', event => { if (event.target === current.modal) closeConfirmation(); });
  listen(current.modal.querySelector('.confirm'), 'click', () => {
    const sessionId = current.closingId;
    closeConfirmation();
    if (sessionId) operate('close_session', sessionId);
  });
  listen(current.menu, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu(false); }
    if (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = [...current.menu.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.shiftKey || event.key === 'ArrowUp' ? -1 : 1;
      buttons[(buttons.indexOf(document.activeElement) + direction + buttons.length) % buttons.length].focus();
    }
  });
  listen(current.modal, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeConfirmation(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = current.modal.querySelectorAll('button');
      (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus();
    }
  });

  terminal.onData(data => input(encoder.encode(data)));
  terminal.onBinary(data => input(Uint8Array.from(data, character => character.charCodeAt(0) & 255)));
  for (const identifier of [{ final: 'n' }, { prefix: '?', final: 'n' }, { final: 'c' },
    { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' }]) terminal.parser.registerCsiHandler(identifier, () => true);
  terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
  for (const code of [10, 11, 12]) terminal.parser.registerOscHandler(code, data => data === '?');

  function viewport() {
    const visible = window.visualViewport;
    page.style.height = visible ? `${visible.height}px` : '';
    page.style.top = visible ? `${visible.offsetTop}px` : '';
    current.menu.style.setProperty('--terminal-menu-top', `${page.querySelector('header').getBoundingClientRect().height + 4}px`);
    if (document.hasFocus() && page.contains(document.activeElement)) useLocalSize();
  }
  current.observer = new ResizeObserver(() => {
    if (document.hasFocus() && page.contains(document.activeElement)) useLocalSize();
  });
  current.observer.observe(screen);
  listen(screen, 'pointerdown', useLocalSize);
  listen(window, 'focus', useLocalSize);
  listen(window, 'pagehide', closeProjectTerminal);
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', viewport);
    listen(window.visualViewport, 'scroll', viewport);
  }
  viewport();
  edgeBack.activate();
  connect();
  terminal.focus();
}

Object.assign(window, { closeProjectTerminal, deactivateProjectTerminal: closeProjectTerminal });
