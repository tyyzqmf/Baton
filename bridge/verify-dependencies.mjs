import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const modulesRoot = fileURLToPath(new URL('./node_modules/', import.meta.url));

if (packageJson.dependencies?.['node-pty'] && process.platform === 'darwin') {
  for (const relative of ['build/Release/spawn-helper', `prebuilds/darwin-${process.arch}/spawn-helper`]) {
    const helper = path.join(modulesRoot, 'node-pty', relative);
    if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o100);
  }
}

for (const name of Object.keys(packageJson.dependencies || {})) {
  const resolved = import.meta.resolve(name);
  const resolvedPath = fileURLToPath(resolved);
  const relative = path.relative(modulesRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${name} resolved outside the staged node_modules directory`);
  }
  await import(resolved);
}

if (packageJson.dependencies?.['node-pty'] && process.platform !== 'win32') {
  const { default: pty } = await import('node-pty');
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '' } });
    const timeout = setTimeout(() => { terminal.kill(); reject(new Error('PTY startup verification timed out')); }, 5000);
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve();
      else reject(new Error('PTY startup verification failed'));
    });
  });
}
