import { state } from '../state.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { backButtonHtml } from '../components/back-button.js';
import { loadingSpinner } from '../components/loading.js';
import { requestProjectFiles } from '../project/rpc.js';
import { renderSourceView } from '../project/source-view.js';
import { requestGitDiff } from './rpc.js';
import {
  clearGitDiffView,
  readGitDiffView,
  saveGitDiffView,
} from './view-state.js';

var overlay;
var body;
var title;
var tabs;
var current;
var token = 0;
var edgeBack = registerEdgeBackLayer({
  navigateBack: closeGitDiff,
  foregroundSelectors: ['#gitDiffOverlay'],
  guardZIndex: 1002,
  foregroundZIndex: 1001,
});

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement('section');
  overlay.id = 'gitDiffOverlay';
  overlay.className = 'git-diff-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<div class="path-breadcrumb git-diff-header">'
    + backButtonHtml({ className: 'git-diff-back' })
    + '<div class="git-diff-title"></div><div class="git-diff-tabs file-tabs">'
    + '<button class="file-tab" type="button" data-mode="diff">Diff</button>'
    + '<button class="file-tab" type="button" data-mode="code">Code</button>'
    + '</div></div><div class="git-diff-body"></div>';
  document.body.appendChild(overlay);
  body = overlay.querySelector('.git-diff-body');
  title = overlay.querySelector('.git-diff-title');
  tabs = overlay.querySelector('.git-diff-tabs');
  overlay.querySelector('.git-diff-back').onclick = closeGitDiff;
  tabs.onclick = function (event) {
    var button = event.target.closest('button[data-mode]');
    if (button) showMode(button.dataset.mode);
  };
}

function setActive(mode) {
  tabs.querySelectorAll('button').forEach(function (button) {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
}

function showLoading(label) {
  body.innerHTML = '<div class="file-loading">'
    + loadingSpinner({ label: label }) + '</div>';
}

async function showDiff(myToken) {
  showLoading('Loading diff');
  try {
    await window.loadDiffViewer?.();
    var result = await requestGitDiff({
      projectHash: state.appState.project?.hash || '',
      group: current.group,
      path: current.path,
    });
    if (myToken !== token) return;
    body.innerHTML = result.truncated ? '<div class="git-diff-warning">Showing the first 5 MB.</div>' : '';
    var host = document.createElement('div');
    host.className = 'git-diff-render';
    body.appendChild(host);
    var ui = new window.Diff2HtmlUI(host, result.content || '', {
      drawFileList: false,
      outputFormat: 'line-by-line',
      matching: 'lines',
      colorScheme: 'dark',
      highlight: true,
    });
    ui.draw();
  } catch (error) {
    if (myToken === token) body.innerHTML = '<div class="git-error">' + esc(error.message) + '</div>';
  }
}

async function showCode(myToken) {
  showLoading('Loading code');
  try {
    var result = await requestProjectFiles('read', {
      projectHash: state.appState.project?.hash || '',
      path: current.path,
    });
    if (myToken !== token) return;
    var text = result.content;
    if (text == null && result.key) text = await window.apiText('/api/bridge/file/' + result.key);
    if (myToken !== token) return;
    renderSourceView(body, {
      path: current.path,
      text: text,
      truncated: result.truncated,
    });
  } catch (error) {
    if (myToken === token) body.innerHTML = '<div class="git-error">' + esc(error.message) + '</div>';
  }
}

function showMode(mode) {
  if (!current || (mode === 'code' && current.deleted)) return;
  body.scrollLeft = 0;
  body.scrollTop = 0;
  current.mode = mode;
  saveGitDiffView(state.appState, current);
  setActive(mode);
  var myToken = ++token;
  if (mode === 'diff') showDiff(myToken);
  else showCode(myToken);
}

export function openGitDiff(path, group, status, options) {
  ensureOverlay();
  options = options || {};
  current = {
    path: path,
    group: group,
    status: status || '',
    deleted: status === 'deleted',
    mode: options.mode === 'code' ? 'code' : 'diff',
  };
  title.textContent = path.split('/').pop();
  title.title = path;
  var codeButton = tabs.querySelector('[data-mode="code"]');
  codeButton.disabled = current.deleted;
  overlay.hidden = false;
  edgeBack.activate();
  showMode(current.deleted && current.mode === 'code' ? 'diff' : current.mode);
}

export function closeGitDiff() {
  clearGitDiffView();
  if (!overlay || overlay.hidden) return false;
  overlay.hidden = true;
  edgeBack.deactivate();
  current = null;
  token++;
  if (state.gitStatusOpen) window.refreshGitStatus?.();
  return true;
}

export function restoreGitDiffView() {
  var saved = readGitDiffView(state.appState);
  if (!saved) return false;
  openGitDiff(saved.path, saved.group, saved.status, { mode: saved.mode });
  return true;
}

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !closeGitDiff()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
