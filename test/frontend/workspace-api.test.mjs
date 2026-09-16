import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceRequest } from '../../web/js/workspace-api.js';

test('the local overview uses same-origin without overriding other saved API routes', async () => {
  const calls = [];
  const win = {
    location: { origin: 'http://localhost:5173' },
    api: (...args) => { calls.push(args); return Promise.resolve('ok'); },
  };
  const request = createWorkspaceRequest(win, true);
  assert.equal(await request('/api/bridge/project-sessions', { limit: 50 }), 'ok');
  await request('/api/bridge/sessions', { device: 'mac', project: 'baton', limit: 5 });
  await request('/api/bridge/devices');
  assert.deepEqual(calls, [
    ['/api/bridge/project-sessions', { limit: 50 }, { server: 'http://localhost:5173' }],
    ['/api/bridge/sessions', { device: 'mac', project: 'baton', limit: 5 }, undefined],
    ['/api/bridge/devices', undefined, undefined],
  ]);
});

test('production and normal development keep the configured API server', () => {
  for (const localHomeApi of [undefined, false]) {
    const calls = [];
    const request = createWorkspaceRequest({
      location: { origin: 'http://localhost:5173' }, api: (...args) => calls.push(args),
    }, localHomeApi);
    request('/api/bridge/project-sessions', { limit: 50 });
    assert.equal(calls[0][2], undefined);
  }
});
