import fs from 'fs';
import path from 'path';
import { projectHashToPath } from '../session.mjs';
import { operationError, runGit } from './git-command.mjs';

const contextCache = new Map();

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveProjectPath(projectHash, resolver = projectHashToPath) {
  if (!projectHash) throw operationError('project_not_found', 'Project is required.');
  const candidate = resolver(projectHash);
  try {
    const projectPath = fs.realpathSync(candidate);
    if (!fs.statSync(projectPath).isDirectory()) throw new Error('not a directory');
    return projectPath;
  } catch {
    throw operationError('project_not_found', 'Project directory was not found.');
  }
}

export function cachedGitContext(projectHash, projectPath) {
  const cached = contextCache.get(projectHash);
  return cached?.projectPath === projectPath ? cached : null;
}

export function clearGitContext(projectHash) {
  contextCache.delete(projectHash);
}

export async function resolveGitContext(projectHash, projectPath, options = {}) {
  const run = options.runGit || runGit;
  const result = await run([
    '-C', projectPath,
    'rev-parse',
    '--show-toplevel',
    '--show-prefix',
  ]);
  const lines = result.stdout.toString('utf8').split(/\r?\n/);
  const repoRoot = fs.realpathSync(lines[0]);
  if (!inside(repoRoot, projectPath)) {
    throw operationError('not_git_repository', 'Project is outside the Git worktree.');
  }
  const relativePrefix = path.relative(repoRoot, projectPath).replaceAll('\\', '/');
  const context = {
    projectPath,
    repoRoot,
    prefix: relativePrefix ? `${relativePrefix}/` : '',
  };
  contextCache.set(projectHash, context);
  return context;
}

export async function getGitContext(projectHash, options = {}) {
  const projectPath = options.projectPath
    || resolveProjectPath(projectHash, options.resolveProjectPath);
  return cachedGitContext(projectHash, projectPath)
    || resolveGitContext(projectHash, projectPath, options);
}

export function clearGitContextCache() {
  contextCache.clear();
}
