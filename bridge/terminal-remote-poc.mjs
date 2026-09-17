import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createTerminalRemote } from './terminal-remote.mjs';

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.baton-bridge/config.json'), 'utf8'));
const response = await fetch(`${config.server}/api/bridge/config`, {
  headers: { 'x-api-key': config.apiKey }, signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Server config failed: HTTP ${response.status}`);
const { wsUrl } = await response.json();
if (!wsUrl?.startsWith('wss://')) throw new Error('Server did not return a secure WS endpoint');
const device = `${config.deviceName}-xterm-poc`;
const endpoint = new URL(wsUrl);
endpoint.search = new URLSearchParams({ apiKey: config.apiKey, role: 'bridge', device, version: 'xterm-poc-1' });
let socket;
let reconnect;
let heartbeat;
let stopped = false;
const manager = createTerminalRemote({
  cwd: process.argv[2] || process.cwd(), device,
  send(message) {
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) return false;
    socket.send(JSON.stringify(message), error => { if (error) socket.terminate(); });
    return true;
  },
});

function connect() {
  if (stopped) return;
  socket = new WebSocket(endpoint, { handshakeTimeout: 15000, maxPayload: 28 * 1024, perMessageDeflate: false });
  socket.on('open', () => {
    console.log(`Remote terminal POC connected: ${device}`);
    console.log(`Page: http://localhost:5173/terminal-poc.html?transport=remote&device=${encodeURIComponent(device)}`);
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: 'heartbeat' }));
    }, 60000);
  });
  socket.on('message', data => {
    try { manager.handle(JSON.parse(data)); } catch { console.error('Invalid relay message'); }
  });
  socket.on('error', error => console.error(`Remote POC WS error: ${error.code || 'connection failed'}`));
  socket.on('close', () => {
    clearInterval(heartbeat);
    manager.closeAll();
    if (!stopped) {
      console.log('Remote POC disconnected; sessions terminated, reconnecting in 3s');
      reconnect = setTimeout(connect, 3000);
    }
  });
}

function shutdown() {
  stopped = true;
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  manager.dispose();
  socket?.terminate();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
connect();
