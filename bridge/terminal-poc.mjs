import { createServer } from 'node:http';
import { realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES, dimensions, inputBytes, spawnTerminal } from './terminal-pty.mjs';

export { MAX_FRAME_BYTES };
const OUTPUT_BYTES = 16 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_SESSION_OUTPUT = 16 * 1024 * 1024;
const ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

export async function startTerminalPoc(options = {}) {
  if (process.platform === 'win32') throw new Error('This local POC currently supports macOS/Linux only');
  const cwd = realpathSync(options.cwd || process.cwd());
  if (!statSync(cwd).isDirectory()) throw new Error('PTY cwd must be a directory');
  const shell = options.shell || userInfo().shell || process.env.SHELL || '/bin/bash';
  const shellArgs = options.shellArgs || ['-l', '-i'];
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const sessions = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Local terminal POC: WebSocket only\n');
  });

  server.on('upgrade', (request, socket, head) => {
    const port = server.address().port;
    const validHost = [`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host);
    let status = 0;
    if (!validHost || !ORIGINS.has(request.headers.origin)) status = 403;
    else if (request.url !== '/terminal-poc') status = 404;
    else if (sessions.size) status = 409;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, connection => webSockets.emit('connection', connection));
  });

  webSockets.on('connection', connection => {
    let terminal;
    let stopping = false;
    let exited = false;
    let killTimer;
    let sequence = 0;
    let outputBytes = 0;
    const session = { close: () => connection.close(1001, 'POC server stopped') };
    sessions.add(session);

    function stopTerminal() {
      if (stopping) return;
      stopping = true;
      clearTimeout(openTimer);
      if (!terminal || exited) {
        sessions.delete(session);
        return;
      }
      terminal.kill('SIGHUP');
      killTimer = setTimeout(() => terminal.kill('SIGKILL'), 1000);
      killTimer.unref();
    }

    function fail(message, code = 1008) {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ type: 'error', message }));
        connection.close(code, 'Terminal POC stopped');
      }
      stopTerminal();
    }

    function send(message) {
      if (connection.readyState !== WebSocket.OPEN || stopping) return false;
      const payload = JSON.stringify(message);
      if (Buffer.byteLength(payload) > MAX_FRAME_BYTES
        || connection.bufferedAmount + Buffer.byteLength(payload) > MAX_PENDING_BYTES) {
        fail('Output queue limit exceeded; this POC does not support replay', 1009);
        return false;
      }
      connection.send(payload, error => {
        if (error) {
          connection.terminate();
          stopTerminal();
        }
      });
      return true;
    }

    const openTimer = setTimeout(() => fail('Timed out waiting for open'), 5000);
    openTimer.unref();
    connection.on('error', stopTerminal);
    connection.on('close', stopTerminal);
    connection.on('message', (data, isBinary) => {
      if (stopping) return;
      try {
        if (isBinary) throw new Error('Only JSON text frames are accepted');
        const message = JSON.parse(data.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
        if (message.type === 'open') {
          if (terminal) throw new Error('Terminal is already open');
          const size = dimensions(message);
          terminal = spawnTerminal({ shell, shellArgs, cwd, ...size });
          clearTimeout(openTimer);
          terminal.onData(bytes => {
            if (stopping) return;
            if (!Buffer.isBuffer(bytes)) {
              fail('PTY must produce raw bytes', 1011);
              return;
            }
            outputBytes += bytes.length;
            if (outputBytes > MAX_SESSION_OUTPUT) {
              fail('POC output limit reached (16 MiB); refresh to start a new shell', 1009);
              return;
            }
            for (let offset = 0; offset < bytes.length; offset += OUTPUT_BYTES) {
              if (!send({ type: 'output', seq: ++sequence, data: bytes.subarray(offset, offset + OUTPUT_BYTES).toString('base64') })) break;
            }
          });
          terminal.onExit(({ exitCode, signal }) => {
            exited = true;
            clearTimeout(killTimer);
            sessions.delete(session);
            send({ type: 'exit', exitCode, signal });
            connection.close(1000, 'Shell exited');
          });
          send({ type: 'ready', shell, cwd, ...size });
        } else if (message.type === 'input') {
          if (!terminal || exited) throw new Error('Terminal is not running');
          terminal.write(inputBytes(message.data));
        } else if (message.type === 'resize') {
          if (!terminal || exited) throw new Error('Terminal is not running');
          const size = dimensions(message);
          terminal.resize(size.cols, size.rows);
          send({ type: 'resized', ...size });
        } else {
          throw new Error('Unknown message type');
        }
      } catch (error) {
        fail(error.message);
      }
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, '127.0.0.1', resolveListen);
  });

  return {
    port: server.address().port,
    cwd,
    shell,
    async close() {
      for (const session of sessions) session.close();
      const forceClose = setTimeout(() => {
        for (const connection of webSockets.clients) connection.terminate();
      }, 1000);
      forceClose.unref();
      await Promise.all([
        new Promise(resolveClose => webSockets.close(resolveClose)),
        new Promise(resolveClose => server.close(resolveClose)),
      ]);
      clearTimeout(forceClose);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await startTerminalPoc({ cwd: process.argv[2] });
    console.log(`Local PTY POC: ws://127.0.0.1:${server.port}/terminal-poc`);
    console.log(`Browser: http://localhost:5173/terminal-poc.html`);
    console.log(`Shell: ${server.shell}; cwd: ${server.cwd}`);
    console.log('Local-only, one client. Closing the page terminates its shell. Ctrl+C stops this POC.');
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await server.close();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(`Terminal POC failed: ${error.message}`);
    process.exitCode = 1;
  }
}
