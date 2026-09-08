import assert from 'node:assert/strict';
import test from 'node:test';
import { currentProjectHash } from '../../web/js/project/project-hash.js';
import { state } from '../../web/js/state.js';

test('current project hash wins over a stale new-session project hash', () => {
  const previousAppState = state.appState;
  const previousWsProjectHash = state.wsProjectHash;
  try {
    state.appState = {
      device: 'test-ec2',
      project: {
        hash: '-home-ec2-user-workspace-github-agentpeek',
        name: 'agentpeek',
      },
      session: null,
    };
    state.wsProjectHash = '-home-ec2-user-workspace-game-guandan';

    assert.equal(
      currentProjectHash(),
      '-home-ec2-user-workspace-github-agentpeek',
    );
  } finally {
    state.appState = previousAppState;
    state.wsProjectHash = previousWsProjectHash;
  }
});

test('new-session project hash remains available before app project state exists', () => {
  const previousAppState = state.appState;
  const previousWsProjectHash = state.wsProjectHash;
  try {
    state.appState = {
      device: 'test-ec2',
      project: null,
      session: '__new__',
    };
    state.wsProjectHash = '-home-ec2-user-workspace-game-guandan';

    assert.equal(
      currentProjectHash(),
      '-home-ec2-user-workspace-game-guandan',
    );
  } finally {
    state.appState = previousAppState;
    state.wsProjectHash = previousWsProjectHash;
  }
});
