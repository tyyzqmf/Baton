import { createListPageStore, mergeListItems } from './list-pagination.js';
import { readListCache, writeListCache } from './list-cache.js';

export const HOME_UI_KEY = 'baton-home-ui';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const chevron = '<svg class="collapse-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>';
const PROJECT_SESSION_PAGE_SIZE = 5;
const PROJECT_PAGE_SIZE = 50;
const PROJECT_CATALOG_KEY = 'home-projects';
const projectKey = (device, hash) => JSON.stringify([device, hash]);
const activeStatus = status => status === 'running' || status === 'needs_input';

function ago(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function sessionRow(session, deviceLabel) {
  const s = session;
  const runtime = s.runtime === 'codex' || String(s.sessionId).startsWith('codex:') ? 'codex' : 'claude';
  const runtimeName = runtime === 'codex' ? 'Codex' : 'Claude Code';
  const status = activeStatus(s.status) ? s.status : 'completed';
  const label = { running: 'Running', needs_input: 'Needs input', completed: 'Done' }[status];
  const statusClass = { running: 'running', needs_input: 'idle', completed: 'stopped' }[status];
  const title = s.isAgent && s.agentName ? s.agentName : (s.preview || 'No preview');
  const agentCount = Math.max(0, Number(s.agentCount) || 0);
  const agents = agentCount ? `${agentCount} agent${agentCount === 1 ? '' : 's'}` : s.isAgent ? 'Agent' : '';
  const path = [s.deviceName, s.projectHash, s.sessionId].map(encodeURIComponent).join('/');
  const scope = [s.projectName, deviceLabel].filter(Boolean).join(' · ');
  const detail = s.status === 'needs_input' ? s.agentDetail : '';
  return `<a class="item session-item wh-session" href="#/${escapeHtml(path)}" data-nav="active"
    data-sid="${escapeHtml(s.sessionId)}" data-preview="${escapeHtml(s.preview || title)}"
    data-device="${escapeHtml(s.deviceName)}" data-phash="${escapeHtml(s.projectHash)}"
    data-pname="${escapeHtml(s.projectName)}" data-runtime="${runtime}" data-isagent="${s.isAgent ? 'true' : ''}"
    title="${escapeHtml([title, detail, scope].filter(Boolean).join('\n'))}">
    <div class="item-main">
      <div class="item-top"><span class="title wh-row-title">${escapeHtml(title)}</span>
        <span class="session-badges">
          ${agents ? `<span class="badge agent wh-agent">${escapeHtml(agents)}</span>` : ''}
          <span class="badge ${statusClass} wh-status">${label}</span>
          <span class="runtime-mark${runtime === 'codex' ? ' runtime-mark-codex' : ''} wh-runtime" role="img" aria-label="${runtimeName}" title="${runtimeName}">
            <img class="runtime-icon" src="assets/${runtime === 'codex' ? 'codex.svg' : 'claude-code.svg'}" alt="" aria-hidden="true" width="16" height="16" decoding="sync">
          </span>
        </span>
      </div>
      <div class="item-bottom session-item-bottom">
        <span class="session-secondary-slot"><span class="session-secondary-static wh-scope">${escapeHtml(detail || scope)}</span></span>
        <time class="item-time" datetime="${escapeHtml(s.lastActive)}">${ago(s.lastActive)}</time>
      </div>
    </div>
  </a>`;
}

export function createWorkspaceHome({ window: win, request, onRender = () => {} }) {
  const doc = win.document;
  let saved = {};
  try { saved = JSON.parse(win.sessionStorage.getItem(HOME_UI_KEY) || '{}') || {}; } catch {}
  const ui = {
    mode: ['project', 'device'].includes(saved.mode) ? saved.mode : 'status',
    activeCollapsed: !!saved.activeCollapsed,
    completedCollapsed: !!saved.completedCollapsed,
    completedLimit: Math.min(20, Math.max(5, Number(saved.completedLimit) || 5)),
    open: new Set(Array.isArray(saved.open) ? saved.open : []),
    sessionPages: saved.sessionPages && typeof saved.sessionPages === 'object' ? saved.sessionPages : {},
    projectPages: Math.min(1000, Math.max(1, Math.floor(Number(saved.projectPages) || 1))),
    scroll: Number(saved.scroll) || 0,
  };
  let data = { active: { sessions: [], recentSessions: [] }, devices: { devices: [] } };
  let version = 0;
  let homeRefreshId;
  let disposed = false;
  let pendingScroll = ui.scroll || null;
  let pressed = null;
  let pointerTimer = null;
  let paintTimer = null;
  let deferredPaint = null;
  // Loaded groups own their pages; opening many groups must not evict the catalog or each other.
  const pages = createListPageStore(Infinity);
  const catalog = createListPageStore(1);
  const fetchedVersion = new Map();
  const errors = new Map();
  const projects = new Map();
  const refreshes = new Map();
  let cacheRestored = false;
  function accountScope() {
    try { return JSON.stringify([win.localStorage.getItem('_ak'), win.localStorage.getItem('_as')]); } catch { return ''; }
  }
  let account;
  const visible = () => !disposed && accountScope() === account && doc.body?.classList.contains('workspace-home');
  const devices = () => data.devices.devices || [];
  const deviceName = device => devices().find(d => d.deviceName === device)?.deviceDisplayName || device;

  function pageSnapshot(entry, items = entry.items) {
    return { items, hasMore: entry.hasMore, nextCursor: entry.nextCursor, pageDepth: entry.pageDepth || 1 };
  }

  function validSnapshot(page, validItem) {
    return page && Array.isArray(page.items) && page.items.every(validItem)
      && Number.isInteger(page.pageDepth) && page.pageDepth >= 1 && page.pageDepth <= 1000
      && typeof page.hasMore === 'boolean'
      && (page.hasMore ? typeof page.nextCursor === 'string' && !!page.nextCursor : page.nextCursor === null);
  }

  function restoreProjectCache() {
    if (cacheRestored || ui.mode !== 'project') return;
    cacheRestored = true;
    const cached = readListCache(PROJECT_CATALOG_KEY);
    const validProject = p => p && typeof p.deviceName === 'string' && !!p.deviceName
      && typeof p.projectHash === 'string' && !!p.projectHash;
    const validSession = s => s && typeof s.sessionId === 'string' && !!s.sessionId;
    if (cached?.schema !== 1 || !validSnapshot(cached.catalog, validProject)
      || !cached.sessions || !cached.catalog.items.every(p =>
        validSnapshot(cached.sessions[projectKey(p.deviceName, p.projectHash)], validSession))) return;
    const items = mergeListItems([], cached.catalog.items.map(p => ({
      ...p, groupKey: projectKey(p.deviceName, p.projectHash),
    })), 'groupKey');
    Object.assign(catalog.get(PROJECT_CATALOG_KEY), pageSnapshot(cached.catalog, items), { loaded: true });
    ui.projectPages = Math.max(ui.projectPages, cached.catalog.pageDepth);
    items.forEach(p => {
      projects.set(p.groupKey, p);
      const page = cached.sessions[p.groupKey];
      Object.assign(pages.get('sessions:' + p.groupKey), pageSnapshot(page), { loaded: true });
      ui.sessionPages[p.groupKey] = Math.max(Number(ui.sessionPages[p.groupKey]) || 1, page.pageDepth);
    });
  }

  function persistProjectCache() {
    const entry = catalog.peek(PROJECT_CATALOG_KEY);
    if (!entry?.loaded) return;
    const items = entry.items.map(({ sessionPage, ...p }) => p);
    writeListCache(PROJECT_CATALOG_KEY, {
      schema: 1,
      catalog: pageSnapshot(entry, items),
      sessions: Object.fromEntries(items.map(p => [p.groupKey, pageSnapshot(pages.peek('sessions:' + p.groupKey))])),
    });
  }

  function pageProgress(key, store = pages) {
    return refreshes.get(key) || store.peek(key);
  }

  function applyPage(store, key, page, itemsKey, idKey, append = false) {
    const entry = store.get(key);
    if (!append) {
      refreshes.delete(key);
      if (entry.loaded && entry.pageDepth > 1 && page.hasMore && page.nextCursor) {
        refreshes.set(key, { items: [], pageDepth: 0, targetDepth: entry.pageDepth });
      }
    }
    const refresh = refreshes.get(key);
    if (refresh) {
      refresh.items = mergeListItems(refresh.items, page[itemsKey], idKey);
      refresh.pageDepth++;
      refresh.nextCursor = page.nextCursor || null;
      refresh.hasMore = !!page.hasMore && !!refresh.nextCursor;
      // Keep the displayed tail until fresh pages reach the previously loaded depth.
      if (refresh.hasMore && refresh.pageDepth < refresh.targetDepth) {
        entry.items = mergeListItems(entry.items, refresh.items, idKey);
        return;
      }
      store.applyFirst(key, {
        [itemsKey]: refresh.items, hasMore: refresh.hasMore, nextCursor: refresh.nextCursor,
      }, itemsKey, idKey, false);
      entry.pageDepth = refresh.pageDepth;
      refreshes.delete(key);
    } else {
      if (append) store.append(key, page, itemsKey, idKey);
      else store.applyFirst(key, page, itemsKey, idKey, false);
      entry.pageDepth = append ? (entry.pageDepth || 1) + 1 : 1;
    }
  }

  function save() {
    try { win.sessionStorage.setItem(HOME_UI_KEY, JSON.stringify({ ...ui, open: [...ui.open] })); } catch {}
  }

  function toolbar() {
    return `<div class="wh-toolbar">
      <div class="file-tabs wh-segments" role="group" aria-label="首页视图">
        <button class="file-tab${ui.mode === 'status' ? ' active' : ''}" type="button" data-wh="mode" data-value="status" aria-pressed="${ui.mode === 'status'}">状态</button>
        <button class="file-tab${ui.mode === 'project' ? ' active' : ''}" type="button" data-wh="mode" data-value="project" aria-pressed="${ui.mode === 'project'}">项目</button>
        <button class="file-tab${ui.mode === 'device' ? ' active' : ''}" type="button" data-wh="mode" data-value="device" aria-pressed="${ui.mode === 'device'}">设备</button>
      </div>
    </div>`;
  }

  function deviceView() {
    return `<div class="list">${devices().map(d => {
      const os = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[d.os] || d.os || '未知系统';
      return `<a class="item device-item" href="#/${escapeHtml(encodeURIComponent(d.deviceName))}" data-nav="device" data-name="${escapeHtml(d.deviceName)}">
        <div class="item-top"><span class="device-dot ${d.online ? 'online' : 'offline'}" role="img" aria-label="${d.online ? '在线' : '离线'}"></span><span class="title">${escapeHtml(d.deviceDisplayName || d.deviceName)}</span><time class="item-time" datetime="${escapeHtml(d.lastActive)}">${ago(d.lastActive)}</time></div>
        <div class="item-bottom"><span class="subtitle">${escapeHtml(os)} · ${Number(d.projectCount) || 0} projects</span><span class="item-status">${Number(d.runningCount) || 0} running · ${Number(d.needsInputCount) || 0} needs input</span></div>
      </a>`;
    }).join('')}</div>`;
  }

  function statusSection(kind, sessions) {
    const isActive = kind === 'active';
    const collapsed = isActive ? ui.activeCollapsed : ui.completedCollapsed;
    const shown = isActive ? sessions : sessions.slice(0, ui.completedLimit);
    const waiting = isActive ? sessions.filter(s => s.status === 'needs_input').length : 0;
    return `<section class="wh-section">
      <div class="section-title collapsible${collapsed ? '' : ' expanded'} wh-section-heading"><h2><button class="wh-heading-trigger" type="button" data-wh="collapse" data-value="${kind}"
        aria-expanded="${!collapsed}" aria-controls="wh-${kind}">${chevron}<span>${isActive ? 'Active' : 'Completed'} (<span class="wh-count">${sessions.length}</span>)</span></button></h2>
        ${waiting ? `<span class="badge idle wh-attention">${waiting} 个待处理</span>` : ''}
      </div>
      <div id="wh-${kind}" ${collapsed ? 'hidden' : ''}>
        <div class="list wh-session-list">${shown.length ? shown.map(s => sessionRow(s, deviceName(s.deviceName))).join('')
          : `<p class="empty">${isActive ? '暂无活跃会话' : '暂无最近完成的会话'}</p>`}</div>
        ${!isActive && sessions.length ? `<div class="wh-footer"><span class="meta-left">最近完成 · 已展示 ${shown.length} / ${sessions.length}</span>
          ${shown.length < sessions.length ? '<button type="button" class="text-btn" data-wh="more-completed">展示更多 ↓</button>' : '<button type="button" class="text-btn" data-wh="mode" data-value="project">按项目查看历史 →</button>'}
        </div>` : ''}
      </div>
    </section>`;
  }

  function feedback(key, retryAction, value, store = pages) {
    const entry = store.peek(key);
    if (errors.has(key)) {
      return `<div class="ws-banner error wh-feedback" role="alert">加载失败，已保留现有内容。
        <button type="button" class="text-btn" data-wh="${retryAction}" data-value="${escapeHtml(value)}">重试</button></div>`;
    }
    return entry?.loading || !entry?.loaded ? '<p class="empty wh-feedback" role="status">正在加载…</p>' : '';
  }

  function projectGroup(p) {
    const key = projectKey(p.deviceName, p.projectHash);
    const pageKey = 'sessions:' + key;
    projects.set(key, p);
    const open = ui.open.has(key);
    const entry = pages.peek(pageKey);
    const id = 'wh-project-' + encodeURIComponent(key);
    const projectPath = p.projectPath || p.projectName;
    const deviceLabel = p.deviceDisplayName || deviceName(p.deviceName);
    return `<section class="wh-section wh-project-group${open ? ' open' : ''}">
      <div class="section-title collapsible${open ? ' expanded' : ''} wh-section-heading wh-project-heading">
        <h2><button class="wh-heading-trigger wh-project-toggle" type="button" data-wh="project" data-value="${escapeHtml(key)}"
          aria-expanded="${open}" aria-controls="${escapeHtml(id)}" aria-describedby="${escapeHtml(id)}-path" title="${escapeHtml(projectPath)}">
          ${chevron}<span class="wh-project-name">${escapeHtml(p.projectName)} (<span class="wh-count">${Number(p.sessionCount) || 0}</span>)</span>
        </button></h2>
        <span class="item-status wh-project-device">${escapeHtml(deviceLabel)}</span>
        <div class="meta-left wh-project-path" id="${escapeHtml(id)}-path">${escapeHtml(projectPath)}</div>
      </div>
      <div id="${escapeHtml(id)}" class="wh-project-content" ${open ? '' : 'hidden'}>
        <div class="list wh-session-list">
          ${open && entry?.loaded ? entry.items.map(s => sessionRow({ ...s, deviceName: p.deviceName, projectHash: p.projectHash, projectName: p.projectName }, deviceLabel)).join('') : ''}
          ${open ? feedback(pageKey, 'more-sessions', key) : ''}
          ${open && entry?.loaded && !entry.items.length && !entry.loading && !errors.has(pageKey) ? '<p class="empty">暂无会话</p>' : ''}
        </div>
        ${open && entry?.hasMore && !errors.has(pageKey) ? `<div class="wh-footer">
          <button class="text-btn" type="button" data-wh="more-sessions" data-value="${escapeHtml(key)}" ${entry.loading || refreshes.has(pageKey) || fetchedVersion.get(pageKey) !== version ? 'disabled' : ''}>展示更多 ↓</button>
        </div>` : ''}
      </div>
    </section>`;
  }

  function projectView() {
    const entry = catalog.peek(PROJECT_CATALOG_KEY);
    const groups = [...(entry?.items || [])];
    groups.sort((a, b) => {
      for (const field of ['lastActive', 'deviceName', 'projectHash']) {
        const left = String(a[field] || ''), right = String(b[field] || '');
        if (left !== right) return left < right ? 1 : -1;
      }
      return 0;
    });
    return groups.map(projectGroup).join('')
      + feedback(PROJECT_CATALOG_KEY, 'more-projects', '', catalog)
      + (entry?.loaded && !groups.length && !errors.has(PROJECT_CATALOG_KEY) ? '<p class="empty">暂无项目</p>' : '')
      + (entry?.hasMore && !errors.has(PROJECT_CATALOG_KEY) ? `<div class="wh-footer"><button type="button" class="text-btn" data-wh="more-projects" ${entry.loading || refreshes.has(PROJECT_CATALOG_KEY) || fetchedVersion.get(PROJECT_CATALOG_KEY) !== version ? 'disabled' : ''}>加载更多项目 ↓</button></div>` : '');
  }

  function paint(options = {}) {
    if (!visible()) { deferredPaint = null; return; }
    const content = doc.getElementById('content');
    if (!content) return;
    if (pressed?.target.isConnected && content.contains(pressed.target)) {
      deferredPaint = options;
      return;
    }
    deferredPaint = null;
    win.clearTimeout(paintTimer);
    paintTimer = null;
    const { restoreScroll = false } = options;
    const previousScroll = content.scrollTop;
    const focused = content.contains(doc.activeElement) ? doc.activeElement : null;
    const focusKey = focused?.dataset.wh;
    const focusValue = focused?.dataset.value;
    const active = data.active.sessions || [];
    const recent = (data.active.recentSessions || []).slice(0, 20);
    content.innerHTML = `<main class="wh-workspace" lang="zh-CN"><h1 class="wh-sr-only">会话</h1>${toolbar()}
      ${ui.mode === 'project' || devices().length ? '' : '<div class="empty">还没有连接的设备。<a class="text-btn" href="setup.html">前往设置安装 Bridge →</a></div>'}
      ${ui.mode === 'status' ? statusSection('active', active) + statusSection('completed', recent) : ui.mode === 'project' ? projectView() : deviceView()}
    </main>`;
    if (focusKey) {
      [...content.querySelectorAll('[data-wh]')].find(el => el.dataset.wh === focusKey && el.dataset.value === focusValue)?.focus({ preventScroll: true });
    }
    if (restoreScroll && ui.scroll) pendingScroll = ui.scroll;
    content.scrollTop = pendingScroll ?? (restoreScroll ? ui.scroll : previousScroll);
    if (pendingScroll !== null && Math.abs(content.scrollTop - pendingScroll) < 1) pendingScroll = null;
    onRender();
  }

  function seedSessions(project, fetchedAt) {
    const key = projectKey(project.deviceName, project.projectHash);
    const pageKey = 'sessions:' + key;
    const entry = pages.get(pageKey);
    const requestId = pages.begin(pageKey, true);
    applyPage(pages, pageKey, project.sessionPage, 'sessions', 'sessionId');
    if (!entry.hasMore) ui.sessionPages[key] = entry.pageDepth;
    errors.delete(pageKey);
    fetchedVersion.set(pageKey, fetchedAt);
    pages.finish(pageKey, requestId);
  }

  async function fetchPage(key, path, params, itemsKey, idKey, append = false, store = pages) {
    const entry = store.get(key);
    const progress = pageProgress(key, store);
    if (entry.loading || (append && !progress.hasMore)) return;
    const cursor = append ? progress.nextCursor : null;
    const startedVersion = version;
    const requestId = store.begin(key, false);
    const isCurrent = () => !disposed && accountScope() === account
      && startedVersion === version && store.peek(key)?.requestId === requestId;
    errors.delete(key);
    paint();
    try {
      const page = await request(path, { ...params, ...(cursor ? { cursor } : {}) });
      if (!isCurrent()) return;
      if (!page || !Array.isArray(page[itemsKey])) throw new Error('Invalid list response');
      if (itemsKey === 'projects') {
        if (page.projects.some(p => !p?.deviceName || !p.projectHash || !Array.isArray(p.sessionPage?.sessions))) {
          throw new Error('Invalid project overview');
        }
        page.projects = page.projects.map(p => ({ ...p, groupKey: projectKey(p.deviceName, p.projectHash) }));
      }
      applyPage(store, key, page, itemsKey, idKey, append);
      if (itemsKey === 'sessions') {
        const groupKey = key.slice('sessions:'.length);
        ui.sessionPages[groupKey] = entry.hasMore
          ? Math.max(Number(ui.sessionPages[groupKey]) || 1, entry.pageDepth)
          : entry.pageDepth;
      } else {
        ui.projectPages = entry.hasMore ? Math.max(ui.projectPages, entry.pageDepth) : entry.pageDepth;
        projects.clear();
        entry.items.forEach(p => projects.set(p.groupKey, p));
        page.projects.forEach(p => seedSessions(p, startedVersion));
      }
      save();
      persistProjectCache();
      fetchedVersion.set(key, startedVersion);
    } catch (error) {
      if (isCurrent()) errors.set(key, error);
    } finally {
      store.finish(key, requestId);
      paint();
      ensureVisiblePages();
    }
  }

  function fetchProjects(append = false) {
    return fetchPage(PROJECT_CATALOG_KEY, '/api/bridge/project-sessions',
      { limit: PROJECT_PAGE_SIZE }, 'projects', 'groupKey', append, catalog);
  }

  function fetchSessions(key, append = false) {
    const p = projects.get(key);
    if (!p) return Promise.resolve();
    return fetchPage('sessions:' + key, '/api/bridge/sessions',
      { device: p.deviceName, project: p.projectHash, limit: PROJECT_SESSION_PAGE_SIZE }, 'sessions', 'sessionId', append);
  }

  function ensureVisiblePages() {
    if (!visible()) return;
    if (ui.mode !== 'project') {
      pendingScroll = null;
      return;
    }
    const overview = catalog.peek(PROJECT_CATALOG_KEY);
    const catalogProgress = pageProgress(PROJECT_CATALOG_KEY, catalog);
    const currentCatalog = fetchedVersion.get(PROJECT_CATALOG_KEY) === version;
    if (!errors.has(PROJECT_CATALOG_KEY) && !overview?.loading) {
      if (!currentCatalog) { fetchProjects(); return; }
      if (catalogProgress.hasMore && catalogProgress.pageDepth < ui.projectPages) fetchProjects(true);
    }
    if (currentCatalog) {
      (overview?.items || []).forEach(p => {
        const key = p.groupKey;
        const entry = pages.peek('sessions:' + key);
        const progress = pageProgress('sessions:' + key);
        if (ui.open.has(key) && !errors.has('sessions:' + key) && entry?.loaded
          && !entry.loading && progress.hasMore
          && progress.pageDepth < Math.min(100, Number(ui.sessionPages[key]) || 1)) fetchSessions(key, true);
      });
    }
    const catalogSettled = errors.has(PROJECT_CATALOG_KEY) || (currentCatalog && !overview?.loading
      && (!catalogProgress.hasMore || catalogProgress.pageDepth >= ui.projectPages));
    const sessionsSettled = errors.has(PROJECT_CATALOG_KEY) || (overview?.items || []).every(p => {
      const entry = pages.peek('sessions:' + p.groupKey);
      const progress = pageProgress('sessions:' + p.groupKey);
      return !ui.open.has(p.groupKey) || errors.has('sessions:' + p.groupKey)
        || (entry?.loaded && !entry.loading && (!progress.hasMore
          || progress.pageDepth >= Math.min(100, Number(ui.sessionPages[p.groupKey]) || 1)));
    });
    if (pendingScroll !== null && catalogSettled && sessionsSettled) {
      pendingScroll = null;
      ui.scroll = doc.getElementById('content').scrollTop;
      save();
    }
  }

  function render(active, deviceData, refreshId) {
    if (account === undefined) account = accountScope();
    data = { active: active || {}, devices: deviceData || {} };
    if (refreshId === undefined || refreshId !== homeRefreshId) {
      homeRefreshId = refreshId;
      version++;
      errors.clear();
      refreshes.clear();
    }
    restoreProjectCache();
    save();
    paint({ restoreScroll: true });
    ensureVisiblePages();
  }

  function click(event) {
    const target = event.target.closest('[data-wh]');
    if (!target || !visible() || !target.closest('.wh-workspace') || target.disabled) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
    const action = target.dataset.wh;
    const value = target.dataset.value;
    event.preventDefault();
    if (pressed?.target === target) releasePointer();
    if (action === 'more-projects') {
      fetchProjects(!!catalog.peek(PROJECT_CATALOG_KEY)?.loaded && fetchedVersion.get(PROJECT_CATALOG_KEY) === version);
      return;
    }
    if (action === 'more-sessions') {
      const key = 'sessions:' + value;
      fetchSessions(value, !!pages.peek(key)?.loaded && fetchedVersion.get(key) === version);
      return;
    }
    if (action === 'mode') ui.mode = ['project', 'device'].includes(value) ? value : 'status';
    if (action === 'collapse') {
      if (value === 'active') ui.activeCollapsed = !ui.activeCollapsed;
      else ui.completedCollapsed = !ui.completedCollapsed;
    }
    if (action === 'more-completed') ui.completedLimit += 5;
    if (action === 'project') {
      if (ui.open.has(value)) ui.open.delete(value);
      else ui.open.add(value);
    }
    if (action === 'mode') { pendingScroll = null; ui.scroll = 0; doc.getElementById('content').scrollTop = 0; }
    restoreProjectCache();
    save();
    paint();
    ensureVisiblePages();
  }

  function scroll(event) {
    if (visible() && event.target.id === 'content' && pendingScroll === null) {
      ui.scroll = event.target.scrollTop;
      save();
    }
  }
  function cancelScrollRestore(event) {
    if (visible() && event.target.closest?.('#content')) pendingScroll = null;
  }
  function releasePointer() {
    pressed = null;
    win.clearTimeout(pointerTimer);
    pointerTimer = null;
    if (deferredPaint && paintTimer === null) {
      // Flush after click dispatch and link activation, never between pointerup and click.
      paintTimer = win.setTimeout(() => {
        paintTimer = null;
        if (deferredPaint) paint(deferredPaint);
      }, 0);
    }
  }
  function pointerDown(event) {
    const target = event.target.closest?.('.wh-workspace a, .wh-workspace button');
    if (!target || !visible() || event.isPrimary === false || event.button > 0) return;
    win.clearTimeout(pointerTimer);
    pointerTimer = null;
    pressed = { id: event.pointerId, target };
  }
  function pointerEnd(event) {
    if (!pressed || pressed.id !== event.pointerId) return;
    if (event.type === 'pointercancel') releasePointer();
    else {
      win.clearTimeout(pointerTimer);
      pointerTimer = win.setTimeout(releasePointer, 500);
    }
  }
  function clickEnd(event) {
    if (pressed?.target.contains(event.target)) releasePointer();
  }
  doc.addEventListener('click', click);
  doc.addEventListener('click', clickEnd);
  doc.addEventListener('pointerdown', pointerDown, true);
  doc.addEventListener('pointerup', pointerEnd, true);
  doc.addEventListener('pointercancel', pointerEnd, true);
  win.addEventListener('blur', releasePointer);
  doc.addEventListener('scroll', scroll, true);
  doc.addEventListener('pointerdown', cancelScrollRestore, { passive: true });
  doc.addEventListener('wheel', cancelScrollRestore, { passive: true });
  return {
    render,
    dispose() {
      disposed = true;
      version++;
      win.clearTimeout(pointerTimer);
      win.clearTimeout(paintTimer);
      pressed = null;
      deferredPaint = null;
      doc.removeEventListener('click', click);
      doc.removeEventListener('click', clickEnd);
      doc.removeEventListener('pointerdown', pointerDown, true);
      doc.removeEventListener('pointerup', pointerEnd, true);
      doc.removeEventListener('pointercancel', pointerEnd, true);
      win.removeEventListener('blur', releasePointer);
      doc.removeEventListener('scroll', scroll, true);
      doc.removeEventListener('pointerdown', cancelScrollRestore);
      doc.removeEventListener('wheel', cancelScrollRestore);
    },
  };
}
