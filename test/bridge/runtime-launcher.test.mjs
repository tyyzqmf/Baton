import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveRuntimeLauncher,
  runtimeLauncherError,
} from '../../bridge/runtime-launcher.mjs';
import { resolveClaudeBinForCapability } from '../../bridge/runtime-capabilities.mjs';

function shellFixture(root) {
  const zsh = '/bin/zsh';
  if (fs.existsSync(zsh)) {
    return {
      shell: zsh,
      initFile: path.join(root, '.zshrc'),
      env: { ZDOTDIR: root },
    };
  }
  const bash = '/bin/bash';
  return {
    shell: bash,
    initFile: path.join(root, '.bashrc'),
    env: { HOME: root },
  };
}

test('direct Claude launch loads the credential script with a bare service environment', {
  skip: process.platform === 'win32',
}, (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-runtime-env ' "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'claude.mjs');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude/env.sh'), [
    'printf "env startup noise\\n"',
    'ANTHROPIC_BASE_URL=https://example.invalid/proxy',
    'ANTHROPIC_AUTH_TOKEN="fixture token with spaces"',
    'ANTHROPIC_API_KEY=fixture-key',
    'PATH=/usr/bin:/bin',
    '',
  ].join('\n'));
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
console.log(JSON.stringify({
  credentials: [process.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY],
  input: fs.readFileSync(0, 'utf8'),
  args: process.argv.slice(2),
  path: process.env.PATH,
}));
`, { mode: 0o700 });
  const env = { HOME: root, PATH: '/usr/bin:/bin' };
  const launcher = resolveClaudeBinForCapability({
    home: root,
    bridgeHome: path.join(root, '.baton-bridge'),
    env,
    findExecutableFn: () => binary,
  });
  const args = ['-p', '--resume', 'session with spaces', '$literal;argument'];
  const result = JSON.parse(execFileSync(launcher, args, {
    env,
    encoding: 'utf8',
    input: 'bridge message\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  }));

  assert.deepEqual(result.credentials, ['https://example.invalid/proxy', 'fixture token with spaces', 'fixture-key']);
  assert.equal(result.input, 'bridge message\n');
  assert.deepEqual(result.args, args);
  assert.ok(result.path.split(':').includes(path.join(root, '.local/bin')));
  assert.doesNotMatch(fs.readFileSync(launcher, 'utf8'), /fixture token|fixture-key/);
});

test('Claude without an environment file keeps direct login-based resolution', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-runtime-no-env-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(resolveClaudeBinForCapability({
    home: root,
    bridgeHome: path.join(root, '.baton-bridge'),
    findExecutableFn: () => '/known/claude',
  }), '/known/claude');
});

test('direct executable resolution wins without probing the user shell', () => {
  let probed = false;
  const resolved = resolveRuntimeLauncher('claude', ['/known/claude'], {
    allowShellFallback: true,
    findExecutableFn: () => '/known/claude',
    execFileSyncFn: () => { probed = true; },
  });

  assert.equal(resolved, '/known/claude');
  assert.equal(probed, false);
});

test('Claude shell fallback loads an interactive alias and preserves Bridge arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-runtime-launcher-'));
  const binDir = path.join(root, 'bin');
  const fakeClaude = path.join(binDir, 'claude');
  const shell = shellFixture(root);
  fs.mkdirSync(binDir);
  fs.writeFileSync(fakeClaude, [
    '#!/bin/sh',
    'IFS= read -r input',
    'printf "BEDROCK=<%s>\\n" "$CLAUDE_CODE_USE_BEDROCK"',
    'printf "PROFILE=<%s>\\n" "$AWS_PROFILE"',
    'printf "STDIN=<%s>\\n" "$input"',
    'printf "ARG=<%s>\\n" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.writeFileSync(shell.initFile, [
    'printf "shell startup noise\\n"',
    `export PATH='${binDir}':"$PATH"`,
    'alias claude=\'CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=default command claude'
      + ' --model "global.anthropic.claude-opus-4-8[1m]"'
      + ' --dangerously-skip-permissions\'',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    ...shell.env,
    SHELL: shell.shell,
    PATH: '/usr/bin:/bin',
  };
  try {
    const launcher = resolveClaudeBinForCapability({
      home: root,
      bridgeHome: path.join(root, '.baton-bridge'),
      env,
      findExecutableFn: () => null,
    });
    const output = execFileSync(launcher, ['-p', '--resume', 'session-1'], {
      env,
      encoding: 'utf8',
      input: 'bridge message\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    assert.doesNotMatch(output, /shell startup noise/);
    assert.match(output, /BEDROCK=<1>/);
    assert.match(output, /PROFILE=<default>/);
    assert.match(output, /STDIN=<bridge message>/);
    assert.match(output, /ARG=<--model>/);
    assert.match(output, /ARG=<global\.anthropic\.claude-opus-4-8\[1m\]>/);
    assert.match(output, /ARG=<--dangerously-skip-permissions>/);
    assert.match(output, /ARG=<-p>/);
    assert.match(output, /ARG=<--resume>/);
    assert.match(output, /ARG=<session-1>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows keeps direct resolution and does not probe PowerShell aliases', () => {
  let probed = false;
  const resolved = resolveRuntimeLauncher('claude', [], {
    platform: 'win32',
    allowShellFallback: true,
    env: { SHELL: 'powershell.exe', Path: 'C:\\Windows\\System32' },
    findExecutableFn: () => null,
    execFileSyncFn: () => { probed = true; },
  });

  assert.equal(resolved, null);
  assert.equal(probed, false);
});

test('launcher failure identifies checked binaries, PATH, and shell', () => {
  const error = runtimeLauncherError('claude', ['/opt/homebrew/bin/claude'], {
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
  });

  assert.match(error.message, /Checked binaries: claude, \/opt\/homebrew\/bin\/claude/);
  assert.match(error.message, /PATH: \/usr\/bin:\/bin/);
  assert.match(error.message, /shell: \/bin\/zsh/);
});
