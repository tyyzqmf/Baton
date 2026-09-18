import pty from 'node-pty';

export const MAX_FRAME_BYTES = 28 * 1024;

export function dimensions(message) {
  if (!Number.isInteger(message.cols) || message.cols < 2 || message.cols > 500
    || !Number.isInteger(message.rows) || message.rows < 1 || message.rows > 200) {
    throw new Error('Invalid terminal dimensions (cols: 2–500, rows: 1–200)');
  }
  return { cols: message.cols, rows: message.rows };
}

export function inputBytes(data) {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(4096 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('Invalid base64 input');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 4096 || bytes.toString('base64') !== data) {
    throw new Error('Input exceeds 4 KiB or is not canonical base64');
  }
  return bytes;
}

export function spawnTerminal({ shell, shellArgs, cwd, cols, rows }) {
  if (process.platform === 'win32') throw new Error('This POC supports macOS/Linux only');
  const environment = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return pty.spawn(shell, shellArgs, {
    name: 'xterm-256color', cwd, cols, rows, encoding: null,
    env: { ...environment, SHELL: shell, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
}
