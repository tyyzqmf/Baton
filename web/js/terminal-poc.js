import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../css/terminal-poc.css';
import { RemoteTerminalSocket } from './terminal-remote-transport.js';

const status = document.getElementById('status');
const container = document.getElementById('terminal');
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, monospace',
  scrollback: 3000,
  disableStdin: true,
  theme: { background: '#15171c', foreground: '#e4e7ef' },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(container);

function fitTerminal() {
  const size = fit.proposeDimensions();
  if (size) terminal.resize(Math.min(500, Math.max(2, size.cols)), Math.min(200, Math.max(1, size.rows)));
}

fitTerminal();
const query = new URLSearchParams(location.search);
const direct = query.get('transport') === 'direct';
const remote = direct || query.get('transport') === 'remote';
if (remote) document.querySelector('.notice').textContent = '远程 WSS → 测试 Bridge → 本机真实 Shell · 刷新创建新会话 · 断网后约 45 秒关闭旧会话';
if (direct) document.querySelector('.notice').textContent = 'Header 签名 WS 直转 → 测试 Bridge → 本机 PTY · 按键/输出不经过 Lambda · 刷新创建新会话';
const socket = remote
  ? new RemoteTerminalSocket(query.get('device'), { profile: query.get('profile') === '1', direct })
  : new WebSocket('ws://127.0.0.1:8787/terminal-poc');
const encoder = new TextEncoder();
let ready = false;
let finalStatus = false;
let sequence = 0;
let pendingOutput = 0;

function stop(message) {
  ready = false;
  finalStatus = true;
  terminal.options.disableStdin = true;
  status.textContent = message;
  socket.close(1000, 'POC client stopped');
}

function send(message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const payload = JSON.stringify(message);
  if (socket.bufferedAmount + payload.length > 256 * 1024) {
    stop('发送队列已满，会话已停止；刷新新建 Shell');
    return false;
  }
  socket.send(payload);
  return true;
}

function sendInput(bytes) {
  if (!ready) return;
  if (bytes.length > 64 * 1024) {
    stop('POC 单次输入限制为 64 KiB，会话已停止');
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 4096)));
    if (!send({ type: 'input', data })) break;
  }
}

terminal.onData(data => {
  if (!ready) return;
  sendInput(encoder.encode(data));
});
terminal.onBinary(data => {
  sendInput(Uint8Array.from(data, character => character.charCodeAt(0) & 255));
});
terminal.onResize(({ cols, rows }) => {
  if (ready) send({ type: 'resize', cols, rows });
});

socket.addEventListener('open', () => send({ type: 'open', cols: terminal.cols, rows: terminal.rows }));
socket.addEventListener('message', event => {
  try {
    if (typeof event.data !== 'string' || event.data.length > 28 * 1024) throw new Error('Invalid output frame');
    const message = JSON.parse(event.data);
    if (message.type === 'ready') {
      ready = true;
      terminal.options.disableStdin = false;
      status.textContent = `${direct ? 'Header 直转已连接' : remote ? '远程已连接' : '已连接'} · ${message.shell} · ${message.cwd}`;
      fitTerminal();
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
      terminal.focus();
    } else if (message.type === 'output') {
      if (message.seq !== sequence + 1) throw new Error('Output sequence mismatch');
      sequence = message.seq;
      const bytes = Uint8Array.from(atob(message.data), character => character.charCodeAt(0));
      pendingOutput += bytes.length;
      if (pendingOutput > 1024 * 1024) throw new Error('Rendering queue exceeded 1 MiB');
      terminal.write(bytes, () => {
        pendingOutput -= bytes.length;
      });
    } else if (message.type === 'exit') {
      stop(`Shell 已退出 (${message.exitCode}${message.signal ? `, signal ${message.signal}` : ''}) · 刷新新建会话`);
    } else if (message.type === 'error') {
      stop(`错误：${message.message}`);
    } else if (message.type !== 'resized') {
      throw new Error('Unknown server message');
    }
  } catch (error) {
    stop(`终端已停止：${error.message}`);
  }
});
socket.addEventListener('error', event => stop(event.data || '连接失败：请先运行 npm run poc:terminal，并关闭其他 POC 页面'));
socket.addEventListener('close', event => {
  ready = false;
  terminal.options.disableStdin = true;
  if (!finalStatus) status.textContent = `连接已断开 (${event.code}) · 刷新新建会话，不会恢复旧 Shell`;
});

const observer = new ResizeObserver(fitTerminal);
observer.observe(container);
window.addEventListener('pagehide', () => {
  observer.disconnect();
  socket.close(1000, 'Page closed');
  terminal.dispose();
}, { once: true });
