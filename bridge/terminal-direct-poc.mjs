import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createTerminalDirect } from './terminal-direct.mjs';

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.baton-bridge/config.json'), 'utf8'));
const response = await fetch(`${config.server}/api/bridge/config`, {
  headers: { 'x-api-key': config.apiKey }, signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Server config failed: HTTP ${response.status}`);
const { wsUrl } = await response.json();
if (!wsUrl?.startsWith('wss://')) throw new Error('Missing secure WebSocket endpoint');
const device = `${config.deviceName}-xterm-direct-poc`;
const endpoint = new URL(wsUrl);
endpoint.search = new URLSearchParams({ apiKey: config.apiKey, role: 'bridge', device, version: 'xterm-direct-1' });
let socket;
let reconnect;
let heartbeat;
let stopped = false;
const socketFactory = url => new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 28 * 1024, perMessageDeflate: false });
const manager = createTerminalDirect({ endpoint: wsUrl, key: config.apiKey, device, socketFactory,
  cwd: process.argv[2] || process.cwd(), sendControl(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  },
});

function connect() {
  if (stopped) return;
  socket = socketFactory(endpoint);
  socket.on('open', () => {
    console.log(`Header-signed terminal Bridge connected: ${device}`);
    console.log(`Page: http://localhost:5173/terminal-poc.html?transport=direct&device=${encodeURIComponent(device)}`);
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: 'heartbeat' }));
    }, 60000);
  });
  socket.on('message', data => {
    try { manager.handle(JSON.parse(data)); } catch { console.error('Invalid terminal control message'); }
  });
  socket.on('error', error => console.error(`Terminal control connection failed: ${error.code || 'network error'}`));
  socket.on('close', () => {
    clearInterval(heartbeat);
    manager.closeAll();
    if (!stopped) reconnect = setTimeout(connect, 3000);
  });
}

function shutdown() {
  stopped = true;
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  manager.dispose();
  socket?.terminate();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
connect();
