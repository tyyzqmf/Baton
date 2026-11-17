// Desktop sidebar: navigation, projects with their recent sessions, and devices.
import { state } from './state.js';
import { NEW_CHAT_ICON_SVG } from './components/icons.js';
import { readPins } from './shell.js';
import { attachmentPreviewText } from './components/attachment.js';

const CACHE_KEY = 'apeek_home_cache';
const FOLDED_KEY = 'baton-sidebar-folded';
const REFRESH_MS = 60000;
const STALE_MS = 15000;

const root = document.getElementById('sidebar');
const wide = window.matchMedia('(min-width: 1024px)');
let data = null;
let loadedAt = 0;
let refreshing = null;
let query = '';
let searchOpen = false;
let folded = new Set();
try { folded = new Set(JSON.parse(sessionStorage.getItem(FOLDED_KEY) || '[]')); } catch {}

const ICONS = {
  panel: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  recents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  approve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  chevron: '<svg class="sidebar-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
  folder: '<svg class="recent-project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"/><path d="M3 9h18"/></svg>',
};

function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function ago(iso) {
  const elapsed = Date.now() - (Date.parse(iso || '') || 0);
  if (!iso || elapsed < 60000) return 'now';
  if (elapsed < 3600000) return Math.floor(elapsed / 60000) + 'm';
  if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + 'h';
  return Math.floor(elapsed / 86400000) + 'd';
}

function deviceName(name) {
  return window.__deviceDisplayNames?.[name] || state.deviceDisplayNameMap?.[name] || name;
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

function sessionTitle(session) {
  return session.isAgent && session.agentName ? session.agentName : attachmentPreviewText(session.preview || 'No preview');
}

function currentSession() {
  return { device: state.appState.device, session: state.rootSessionId || state.appState.session };
}

function statusClass(status) {
  return status === 'running' ? ' running' : status === 'needs_input' ? ' needs-input' : '';
}

// Active rows are authoritative for status; recent project rows supply the rest.
function sessions() {
  const byKey = new Map();
  const add = session => {
    if (!session?.sessionId || !session.deviceName) return;
    const key = session.deviceName + '\u0000' + session.sessionId;
    if (!byKey.has(key)) byKey.set(key, session);
  };
  (data?.active?.sessions || []).forEach(add);
  (data?.active?.recentProjects || []).forEach(project => (project.sessions || []).forEach(session => add({
    deviceName: project.deviceName, projectHash: project.projectHash, projectName: project.projectName, ...session,
  })));
  return byKey;
}

function threadHtml(session, known) {
  const current = currentSession();
  const live = known.get(session.deviceName + '\u0000' + session.sessionId) || session;
  const active = current.device === live.deviceName && current.session === live.sessionId;
  const href = '#/' + encodeURIComponent(live.deviceName) + '/' + encodeURIComponent(live.projectHash)
    + '/' + encodeURIComponent(live.sessionId);
  return '<a class="sidebar-thread' + (active ? ' active' : '') + '" href="' + esc(href) + '" data-sidebar-open'
    + ' data-device="' + esc(live.deviceName) + '" data-phash="' + esc(live.projectHash) + '"'
    + ' data-pname="' + esc(live.projectName || live.projectHash) + '" data-sid="' + esc(live.sessionId) + '"'
    + ' data-preview="' + esc(live.preview || '') + '" data-isagent="' + (live.isAgent ? 'true' : '') + '"'
    + (active ? ' aria-current="page"' : '') + ' title="' + esc(sessionTitle(live)) + '">'
    + '<span class="sidebar-status' + statusClass(live.status) + '" aria-hidden="true"></span>'
    + '<span class="sidebar-thread-title">' + esc(sessionTitle(live)) + '</span>'
    + (live.lastActive ? '<time datetime="' + esc(live.lastActive) + '">' + ago(live.lastActive) + '</time>' : '')
    + '</a>';
}

function projectHtml(project, known, multipleDevices) {
  const key = JSON.stringify([project.deviceName, project.projectHash]);
  const open = !folded.has(key);
  const threads = (project.sessions || []).map(session => threadHtml({
    deviceName: project.deviceName, projectHash: project.projectHash, projectName: project.projectName, ...session,
  }, known)).join('');
  const href = '#/' + encodeURIComponent(project.deviceName) + '/' + encodeURIComponent(project.projectHash);
  return '<div class="sidebar-project">'
    + '<div class="sidebar-project-row">'
    + '<button class="sidebar-project-toggle" type="button" data-sidebar-fold="' + esc(key) + '" aria-expanded="' + open + '">'
    + ICONS.chevron + ICONS.folder
    + '<span class="sidebar-project-name">' + esc(project.projectName) + '</span>'
    + (multipleDevices ? '<span class="sidebar-project-device">' + esc(deviceName(project.deviceName)) + '</span>' : '')
    + '</button>'
    + '<button class="sidebar-icon-btn sidebar-row-action" type="button" data-sidebar-new-in'
    + ' data-device="' + esc(project.deviceName) + '" data-phash="' + esc(project.projectHash) + '"'
    + ' data-pname="' + esc(project.projectName) + '" title="New chat in ' + esc(project.projectName) + '"'
    + ' aria-label="New chat in ' + esc(project.projectName) + '">' + NEW_CHAT_ICON_SVG + '</button>'
    + '</div>'
    + '<div class="sidebar-threads"' + (open ? '' : ' hidden') + '>' + threads
    + '<a class="sidebar-thread-more" href="' + esc(href) + '" data-sidebar-project'
    + ' data-device="' + esc(project.deviceName) + '" data-phash="' + esc(project.projectHash) + '"'
    + ' data-pname="' + esc(project.projectName) + '">View all</a></div></div>';
}

function searchResultsHtml(known) {
  const needle = query.trim().toLowerCase();
  const matches = Array.from(known.values()).filter(session => (sessionTitle(session) + ' ' + (session.projectName || ''))
    .toLowerCase().includes(needle))
    .sort((a, b) => (Date.parse(b.lastActive || '') || 0) - (Date.parse(a.lastActive || '') || 0))
    .slice(0, 50);
  return '<div class="sidebar-section"><div class="sidebar-section-title">Results</div>'
    + (matches.length ? matches.map(session => threadHtml(session, known)).join('')
      : '<div class="sidebar-empty">No matching sessions</div>')
    + '</div>';
}

function render() {
  if (!root || !wide.matches) return;
  const known = sessions();
  const projects = data?.active?.recentProjects || [];
  const devices = data?.devices?.devices || [];
  const multipleDevices = devices.length > 1;
  const waiting = Array.from(known.values()).filter(session => session.status === 'needs_input').length;
  const pinned = readPins().map(pin => known.get(pin.deviceName + '\u0000' + pin.sessionId) || pin);
  const searchValue = root.querySelector('.sidebar-search input')?.value ?? query;
  const searchFocused = document.activeElement?.closest?.('.sidebar-search');
  let body;
  if (searchOpen && query.trim()) {
    body = searchResultsHtml(known);
  } else {
    body = (pinned.length ? '<div class="sidebar-section"><div class="sidebar-section-title">Pinned</div>'
      + pinned.map(session => threadHtml(session, known)).join('') + '</div>' : '')
      + '<div class="sidebar-section"><div class="sidebar-section-title">Projects</div>'
      + (projects.length ? projects.map(project => projectHtml(project, known, multipleDevices)).join('')
        : '<div class="sidebar-empty">' + (data ? 'No recent sessions yet' : 'Loading…') + '</div>')
      + '</div>'
      + (devices.length ? '<div class="sidebar-section"><div class="sidebar-section-title">Devices</div>'
        + devices.map(device => '<a class="sidebar-device" href="#/' + esc(encodeURIComponent(device.deviceName)) + '"'
          + ' data-sidebar-device="' + esc(device.deviceName) + '">'
          + '<span class="device-dot ' + (device.online ? 'online' : 'offline') + '"></span>'
          + '<span class="sidebar-device-name">' + esc(device.deviceDisplayName || device.deviceName) + '</span>'
          + (device.runningCount ? '<span class="sidebar-device-meta">' + device.runningCount + ' running</span>' : '')
          + '</a>').join('') + '</div>' : '');
  }
  const scroll = root.querySelector('.sidebar-scroll')?.scrollTop || 0;
  root.innerHTML = '<div class="sidebar-header">'
    + '<button class="sidebar-brand" type="button" data-sidebar-home><img src="assets/baton-logo.svg" alt=""><span>Baton</span></button>'
    + '<button class="sidebar-icon-btn" type="button" data-sidebar-collapse title="Hide sidebar" aria-label="Hide sidebar">' + ICONS.panel + '</button>'
    + '</div>'
    + '<nav class="sidebar-nav" aria-label="Primary">'
    + '<button class="sidebar-nav-item" type="button" data-sidebar-new>' + NEW_CHAT_ICON_SVG + '<span>New chat</span></button>'
    + '<button class="sidebar-nav-item" type="button" data-sidebar-search aria-expanded="' + searchOpen + '">' + ICONS.search
    + '<span>Search</span><kbd>' + (/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K') + '</kbd></button>'
    + '<button class="sidebar-nav-item" type="button" data-sidebar-home>' + ICONS.recents + '<span>Recents</span></button>'
    + '<button class="sidebar-nav-item" type="button" data-sidebar-approve>' + ICONS.approve + '<span>Needs input</span>'
    + (waiting ? '<span class="sidebar-count">' + waiting + '</span>' : '') + '</button>'
    + '</nav>'
    + '<div class="sidebar-search"' + (searchOpen ? '' : ' hidden') + '><input type="search" placeholder="Search chats"'
    + ' aria-label="Search chats" value="' + esc(searchValue) + '" autocomplete="off" spellcheck="false"></div>'
    + '<div class="sidebar-scroll">' + body + '</div>'
    + '<div class="sidebar-footer"><a class="sidebar-nav-item" href="setup.html">' + ICONS.settings + '<span>Settings</span></a></div>';
  const scroller = root.querySelector('.sidebar-scroll');
  if (scroller) scroller.scrollTop = scroll;
  if (searchFocused) {
    const input = root.querySelector('.sidebar-search input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function refresh() {
  if (!wide.matches || typeof window.api !== 'function') return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = Promise.all([
    window.api('/api/bridge/active-sessions', window.__homeActiveParams?.()),
    window.api('/api/bridge/devices'),
  ]).then(([active, devices]) => {
    data = { active, devices };
    loadedAt = Date.now();
    render();
  }).catch(() => {}).finally(() => { refreshing = null; });
  return refreshing;
}

function goHome(tab) {
  window.__setHomeTab?.(tab);
  window.loadDevices?.();
}

function openSearch() {
  searchOpen = true;
  render();
  root.querySelector('.sidebar-search input')?.focus();
}

function onClick(event) {
  const target = event.target.closest('a, button');
  if (!target || !root.contains(target)) return;
  const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0;
  if (target.tagName === 'A' && modified) return;
  const d = target.dataset;
  if (target.hasAttribute('data-sidebar-open')) {
    event.preventDefault();
    window.openActiveSession?.(target);
  } else if (target.hasAttribute('data-sidebar-project')) {
    event.preventDefault();
    window.loadSessions?.(d.device, d.phash, d.pname);
  } else if (target.hasAttribute('data-sidebar-device')) {
    event.preventDefault();
    window.loadProjects?.(d.sidebarDevice);
  } else if (target.hasAttribute('data-sidebar-fold')) {
    const key = d.sidebarFold;
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    try { sessionStorage.setItem(FOLDED_KEY, JSON.stringify(Array.from(folded))); } catch {}
    render();
  } else if (target.hasAttribute('data-sidebar-new-in')) {
    window.startNewSessionIn?.(d.device, d.phash, d.pname);
  } else if (target.hasAttribute('data-sidebar-new')) {
    const app = state.appState;
    if (app.device && app.project) window.startNewSessionIn?.(app.device, app.project.hash, app.project.name);
    else window.openNewTaskSheet?.();
  } else if (target.hasAttribute('data-sidebar-search')) {
    if (searchOpen) {
      searchOpen = false;
      query = '';
      render();
    } else {
      openSearch();
    }
  } else if (target.hasAttribute('data-sidebar-approve')) {
    goHome('approve');
  } else if (target.hasAttribute('data-sidebar-home')) {
    goHome('tasks');
  } else if (target.hasAttribute('data-sidebar-collapse')) {
    window.toggleSidebar?.(false);
  }
}

function onInput(event) {
  if (!event.target.closest('.sidebar-search')) return;
  query = event.target.value;
  render();
}

function onKeydown(event) {
  if (!wide.matches) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    window.toggleSidebar?.(true);
    openSearch();
  } else if (event.key === 'Escape' && event.target.closest?.('.sidebar-search')) {
    searchOpen = false;
    query = '';
    render();
  }
}

export function updateSidebar() {
  if (!wide.matches) return;
  render();
  if (Date.now() - loadedAt > STALE_MS) void refresh();
}

if (root) {
  const cached = readCache();
  if (cached?.active && cached.devices) data = { active: cached.active, devices: cached.devices };
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('baton:home-data', event => {
    data = { active: event.detail.active, devices: event.detail.devices };
    loadedAt = Date.now();
    render();
  });
  window.addEventListener('baton:pins', render);
  wide.addEventListener?.('change', () => { if (wide.matches) updateSidebar(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateSidebar();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && wide.matches) void refresh();
  }, REFRESH_MS);
  window.__sidebarUpdate = updateSidebar;
  render();
  if (wide.matches) void refresh();
}
