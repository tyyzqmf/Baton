import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('frontend test servers preserve live terminal dependencies and clean up isolated caches', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'agentpeek-vite-dev-'));
  let dev;
  const fixtures = [];
  try {
    dev = await createServer({
      root: path.join(ROOT, 'web'), cacheDir, logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, preTransformRequests: false },
    });
    await dev.listen();
    const base = `http://127.0.0.1:${dev.httpServer.address().port}`;
    await (await fetch(base + '/index.html')).text();
    const terminalResponse = await fetch(base + '/js/terminal-runtime.js');
    assert.equal(terminalResponse.status, 200);
    const terminalSource = await terminalResponse.text();
    const terminalUrl = terminalSource.match(/from "([^"]*@xterm_xterm[^"]*)"/)[1];
    const fitUrl = terminalSource.match(/from "([^"]*@xterm_addon-fit[^"]*)"/)[1];
    const terminalDependency = await fetch(base + terminalUrl);
    assert.equal(terminalDependency.status, 200);
    await terminalDependency.text();
    const metadataPath = path.join(cacheDir, 'deps/_metadata.json');
    const metadata = await readFile(metadataPath, 'utf8');

    for (let index = 0; index < 2; index++) {
      const fixture = await createTestServer({
        root: path.join(ROOT, 'web'), cacheDir, logLevel: 'silent', appType: 'custom',
        server: { middlewareMode: true },
        plugins: [{ name: 'session-toolbar-terminal-fixture' }],
      });
      fixtures.push(fixture);
      assert.notEqual(fixture.config.cacheDir, cacheDir);
      await fixture.ssrLoadModule('/js/state.js');
    }
    assert.notEqual(fixtures[0].config.cacheDir, fixtures[1].config.cacheDir);
    for (const fixture of fixtures) {
      await fixture.close();
      await assert.rejects(access(fixture.config.cacheDir), { code: 'ENOENT' });
    }

    assert.equal(await readFile(metadataPath, 'utf8'), metadata);
    const fitDependency = await fetch(base + fitUrl);
    assert.equal(fitDependency.status, 200, fitDependency.statusText);
    assert.match(await fitDependency.text(), /FitAddon/);
  } finally {
    await Promise.all(fixtures.map(fixture => fixture.close()));
    await dev?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
