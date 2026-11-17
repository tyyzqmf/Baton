import { readDarkStyles } from './helpers/theme-css.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const indexHtml = readDarkStyles(
  new URL('../../web/index.html', import.meta.url),
  'utf8',
);
const landingSource = readFileSync(
  new URL('../../web/js/entry-landing.js', import.meta.url),
  'utf8',
);
const appSource = readFileSync(
  new URL('../../web/js/app.js', import.meta.url),
  'utf8',
);
const styleSource = readDarkStyles(
  new URL('../../web/css/style.css', import.meta.url),
  'utf8',
);
const shellSource = readDarkStyles(
  new URL('../../web/css/shell.css', import.meta.url),
  'utf8',
);
const skeletonSource = readFileSync(
  new URL('../../web/js/components/skeleton.js', import.meta.url),
  'utf8',
);
const launchScreen = readFileSync(
  new URL('../../src-tauri/gen/apple/LaunchScreen.storyboard', import.meta.url),
  'utf8',
);
const nativeMain = readFileSync(
  new URL('../../src-tauri/gen/apple/Sources/baton/main.mm', import.meta.url),
  'utf8',
);
const cargoToml = readFileSync(
  new URL('../../src-tauri/Cargo.toml', import.meta.url),
  'utf8',
);
const tauriConfig = JSON.parse(readFileSync(
  new URL('../../src-tauri/tauri.conf.json', import.meta.url),
  'utf8',
));

test('native startup handoff releases after the Web shell is painted', () => {
  assert.match(indexHtml, /new MutationObserver\(check\)/);
  assert.match(
    indexHtml,
    /html\.native-mobile-app body\.ready\{opacity:1;transition:none\}/,
  );
  assert.equal(
    indexHtml.match(/window\.__skelReady = 1/g)?.length,
    1,
    'only the two-frame Web shell callback may release the native overlay',
  );

  const renderSkeleton = indexHtml.slice(
    indexHtml.indexOf('function renderSkeleton'),
    indexHtml.indexOf('// Wait for #content'),
  );
  assert.match(renderSkeleton, /markFirstWebFrameReady\(\)/);
  assert.match(indexHtml, /setTimeout\(function \(\) \{\s*window\.__skelReady = 1;/);
  assert.match(indexHtml, /\}, 120\);/);
  assert.doesNotMatch(indexHtml, /first non-skeleton content/);
});

test('macOS webview paints the configured dark background before HTML loads', () => {
  assert.match(
    cargoToml,
    /tauri = \{ version = "2\.11\.1", features = \["macos-private-api"\] \}/,
  );
  assert.equal(tauriConfig.app.macOSPrivateApi, true);
  assert.equal(tauriConfig.app.windows[0].backgroundColor, '#181818');
});

test('native container keeps the shared skeleton until WKWebView is ready', () => {
  const skeletonSection = nativeMain.slice(
    nativeMain.indexOf('// Native skeleton overlay'),
    nativeMain.indexOf('int main('),
  );
  assert.match(skeletonSection, /UIStoryboard storyboardWithName:@"LaunchScreen"/);
  assert.match(skeletonSection, /@selector\(makeKeyAndVisible\)/);
  assert.match(skeletonSection, /@selector\(setHidden:\)/);
  assert.match(skeletonSection, /@selector\(setRootViewController:\)/);
  assert.match(skeletonSection, /UIWindowDidBecomeVisibleNotification/);
  assert.match(
    skeletonSection,
    /UIViewController \*existing = objc_getAssociatedObject\([\s\S]*_baton_skeleton_controller_key/,
  );
  assert.match(skeletonSection, /\[hostController addChildViewController:skeletonController\]/);
  assert.match(skeletonSection, /\[hostView addSubview:skel\]/);
  assert.match(skeletonSection, /\[hostView bringSubviewToFront:skel\]/);
  assert.match(skeletonSection, /baton_window_top_inset\(UIWindow \*window\)/);
  assert.match(skeletonSection, /window\.windowScene\.statusBarManager\.statusBarFrame/);
  assert.match(
    skeletonSection,
    /launchController\.view\.frame = CGRectMake\(\s*0, top,/,
  );
  assert.match(
    skeletonSection,
    /skel\.backgroundColor = baton_appearance_color\(@"surface", @"#181818"\)/,
  );
  assert.doesNotMatch(skeletonSection, /UIWindowLevelNormal \+ 1\.0/);
  assert.doesNotMatch(skeletonSection, /\[hostView layoutIfNeeded\]/);
  assert.doesNotMatch(skeletonSection, /BATON_SKEL_LOG|BatonSkeleton/);
  assert.match(skeletonSection, /objc_getAssociatedObject\(kw, &_baton_skeleton_installed_key\)/);
  assert.match(skeletonSection, /for \(UIWindow \*window in app\.windows\)/);
  assert.match(skeletonSection, /if \(!wv\) \{[\s\S]*if \(poll\) poll\(\)/);
  assert.match(skeletonSection, /window\.__skelReady\?1:0/);
  assert.match(skeletonSection, /\[cover removeFromSuperview\]/);
  assert.match(
    skeletonSection,
    /objc_setAssociatedObject\(weakKw, &_baton_skeleton_controller_key,\s*nil/,
  );
  assert.doesNotMatch(skeletonSection, /animateWithDuration/);
});

test('Start URL page releases the native skeleton after redirect decisions', () => {
  assert.match(
    landingSource,
    /function releaseNativeSkeleton\(\)[\s\S]*nextFrame\(function \(\) \{[\s\S]*nextFrame\(function \(\) \{[\s\S]*window\.__skelReady = 1;/,
  );
  assert.match(
    landingSource,
    /if \(state\.KEY && \(!isNativeApp \|\| localStorage\.getItem\('_as'\)\)\) \{[\s\S]*location\.replace\('index\.html'\);[\s\S]*return;[\s\S]*\}\s*releaseNativeSkeleton\(\);/,
  );
});

test('list skeletons mirror the final row structure', () => {
  const context = { window: {} };
  vm.runInNewContext(skeletonSource, context);

  const sessions = context.window.skeletonItems(1, 'session');
  const projects = context.window.skeletonItems(1, 'project');
  const devices = context.window.skeletonItems(1, 'device');
  const cards = context.window.skeletonCards(1);

  assert.match(sessions, /skeleton-item-session/);
  assert.match(sessions, /skeleton-item-session"><div class="item-main">/);
  assert.match(sessions, /item-bottom session-item-bottom/);
  assert.match(projects, /skeleton-item-project/);
  assert.match(projects, /class="subtitle"/);
  assert.match(projects, /class="item-bottom"/);
  assert.match(devices, /skeleton-item-device/);
  assert.match(devices, /class="item-bottom"/);
  assert.match(cards, /class="task-row skeleton-row"/);
  assert.match(cards, /class="task-meta"/);
  assert.equal(cards, indexHtml.match(/function skelRow\(\) \{\s*return ([\s\S]*?);\s*\}/)[1]
    .split('\n').map(line => line.trim().replace(/^\+ /, '')).join('').replace(/'\s*\+?\s*'/g, '').replace(/^'|'$/g, ''),
    'the module skeleton and the inline first-paint skeleton draw the same row');

  const messages = context.window.skeletonMessages();
  assert.match(messages, /skeleton-user/);
  assert.match(messages, /skeleton-msg-meta/);
  assert.match(messages, /tool-details-collapsed skeleton-tool/);
  assert.match(messages, /skeleton-thinking/);
  assert.match(messages, /skeleton-copy-line/);
});

test('LaunchScreen uses the mobile content geometry', () => {
  // Five 61pt task rows (10pt padding, 21pt title, 2pt gap, 18pt meta) under a Today heading.
  assert.equal(launchScreen.match(/constant="61" id="r[1-5]h"/g)?.length, 5);
  assert.equal(launchScreen.match(/constant="13\.5" id="r[1-5]tt"/g)?.length, 5);
  assert.equal(launchScreen.match(/constant="8\.5" id="r[1-5]mt"/g)?.length, 5);
  assert.match(launchScreen, /text="Today"/);
  assert.match(launchScreen, /id="tabbar"[\s\S]*constant="-58" id="tab-t"/);
  assert.match(launchScreen, /id="tabnew"[\s\S]*?constant="46" id="tbn-w"/);
  assert.doesNotMatch(launchScreen, /ACTIVE SESSIONS|RECENT PROJECTS/);
  assert.match(shellSource, /html\.native-mobile \.task-title, html\.native-mobile \.recent-project-name \{ font-size: 16px; line-height: 21px; \}/);
  assert.match(shellSource, /html\.native-mobile \.task-meta, html\.native-mobile \.task-detail,[\s\S]*?\{ font-size: 13px; line-height: 18px; \}/);
  assert.match(shellSource, /html\.native-mobile \.task-row \{ padding-block: 10px; \}/);
  assert.match(shellSource, /\.task-main \{ display: flex; flex-direction: column; gap: 2px;/);
  assert.match(shellSource, /\.tab-bar-item \{[\s\S]*?height: 50px;/);
  assert.match(shellSource, /\.tab-bar-new \{[\s\S]*?width: 46px; height: 46px;/);
  assert.match(styleSource, /html\.native-mobile \.session-item \.item-top \{ min-height: 21px; \}/);
  assert.match(styleSource, /html\.native-mobile \.project-item \.item-top \{ min-height: 19px; \}/);
  assert.match(styleSource, /html\.native-mobile \.device-item \.item-top \{ min-height: 18px; \}/);
});

test('desktop and mobile skeleton rows use the final content line boxes', () => {
  assert.match(styleSource, /\.project-item \.item-top \{ min-height: 18px; \}/);
  assert.match(styleSource, /\.project-item \.subtitle \{ min-height: 15px; \}/);
  assert.match(styleSource, /\.project-item \.item-bottom \{ min-height: 13px; \}/);
  assert.match(styleSource, /\.session-item \.item-top \{ min-height: 18px; \}/);
  assert.match(styleSource, /\.session-item \.session-item-bottom \{ min-height: 17px; \}/);
  assert.match(styleSource, /\.skeleton-msg-meta \{ min-height: 16px;/);
  assert.match(
    styleSource,
    /html\.native-mobile \.skeleton-messages \.skeleton-user \.skeleton-copy-line \{ min-height: 25px; \}/,
  );
});

test('browse lists reserve scrollbar width even when WebKit ignores stable gutters', () => {
  const criticalStyle = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(criticalStyle);

  for (const source of [criticalStyle, styleSource]) {
    const browseStyle = source.match(/body\.browse-view #content\s*\{([^}]+)\}/)?.[1];
    assert.ok(browseStyle);
    assert.match(browseStyle, /overflow-y:\s*scroll;/);
    assert.match(browseStyle, /scrollbar-gutter:\s*stable;?/);
    assert.match(source, /(?:^|\n)\s*#content\s*\{[^}]*overflow-y:\s*auto[;}]/);
  }
});

test('home skeleton and loaded heading share the natural group heading height', () => {
  assert.match(indexHtml, /content\.innerHTML = '<section class="home-tasks" aria-hidden="true"><div class="home-group">'/);
  assert.match(indexHtml, /'<h2 class="home-group-title">Today<\/h2><div class="home-group-rows">'/);
  const headingStyle = shellSource.match(/\.home-group-title,\s*\.section-title\.home-section-heading \{([^}]+)\}/)?.[1];
  assert.ok(headingStyle);
  assert.doesNotMatch(headingStyle, /(?<![\w-])(?:min-|max-)?height\s*:/);
});

test('home devices keep bottom safe-area spacing outside the collapsible list', () => {
  assert.match(
    shellSource,
    /\.home-devices \{[^}]*padding-bottom: calc\(8px \+ var\(--sab, env\(safe-area-inset-bottom, 0px\)\)\);/,
  );
  assert.match(indexHtml, /id="devices-section" class="home-device-list"/);
});

test('mobile agent sheet stays flush to the viewport without edge borders', () => {
  assert.match(
    styleSource,
    /@media \(max-width: 600px\) \{[\s\S]*?\.agent-threads-overlay \{\s*align-items: flex-end;/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-box \{[\s\S]*?margin: 0;\s*padding: 18px 16px 0 14px;[\s\S]*?border: 0; border-radius: 16px 16px 0 0;/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-header \{\s*padding-right: 0; display: flex;/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-list \{[\s\S]*?margin-right: calc\(0px - var\(--agent-threads-scrollbar-width\) - var\(--agent-threads-scrollbar-gap\)\);[\s\S]*?padding-right: 2px;[\s\S]*?scrollbar-gutter: stable;/,
  );
  assert.match(
    styleSource,
    /html\.native-mobile \.agent-threads-list \{[^}]*margin-right: -8px;[^}]*padding-right: 8px;[^}]*scrollbar-gutter: auto;/s,
  );
  assert.match(
    styleSource,
    /\.agent-threads-list \{\s*padding-bottom: max\(24px, calc\(var\(--sab, env\(safe-area-inset-bottom, 0px\)\) \+ 8px\)\);/,
  );
  assert.match(
    styleSource,
    /\.agent-thread-row \{[\s\S]*?padding: 9px 10px;/,
  );
});

test('subagent sheet names the root thread Main Session', () => {
  assert.match(indexHtml, />Main Session<\/button>/);
  assert.match(indexHtml, /aria-label="Return to main session"/);
  assert.match(appSource, /mainButton\.textContent = 'Main Session';/);
  assert.match(appSource, /currently viewing main session/);
  assert.doesNotMatch(indexHtml, />Main Agent<\/button>/);
});

test('subagent connector rails meet across row gaps without overlapping stems', () => {
  assert.doesNotMatch(appSource, /agent-thread-child-stem/);
  assert.match(
    styleSource,
    /\.agent-thread-rail \{ top: -5px; bottom: -1px; \}/,
  );
  assert.match(
    styleSource,
    /\.agent-thread-elbow \{\s*position: absolute; left: -11px; top: 50%;\s*width: 10px;/,
  );
  assert.match(
    styleSource,
    /\.agent-thread-rail\.current\.last \{ bottom: calc\(50% - 1px\); \}/,
  );
  assert.doesNotMatch(styleSource, /\.agent-thread-child-stem/);
});

test('mobile agent sheet uses a full-height bottom-sheet transition', () => {
  assert.match(
    styleSource,
    /\.agent-threads-overlay \{[\s\S]*?opacity: 1; transition: none;[\s\S]*?background: transparent; backdrop-filter: none;/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-overlay::before \{[\s\S]*?opacity: 0; transition: opacity 220ms ease-out;/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-overlay\.open::before \{ opacity: 1; \}/,
  );
  assert.match(
    styleSource,
    /transform: translate3d\(0, 100%, 0\); transform-origin: center bottom;/,
  );
  assert.match(
    styleSource,
    /transition: transform 340ms cubic-bezier\(\.32, \.72, 0, 1\);/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-overlay:not\(\.open\) \.agent-threads-box \{[\s\S]*?transition-duration: 240ms;/,
  );
  assert.match(
    styleSource,
    /\.agent-threads-overlay\.open \.agent-threads-box \{ transform: translate3d\(0, 0, 0\); \}/,
  );
  assert.match(
    styleSource,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-threads-overlay::before,[\s\S]*?\.agent-threads-box \{ transition: none !important; \}/,
  );
  assert.match(
    appSource,
    /modal\.classList\.remove\('open'\);\s*void modal\.offsetWidth;\s*modal\.classList\.add\('open'\);/,
  );
  assert.match(appSource, /box\.addEventListener\('transitionend', finishClose\);/);
});

test('mobile assistant paragraphs do not collapse space outside the timeline node', () => {
  const paragraphSpacing = styleSource.indexOf(
    'html.native-mobile .assistant-text p { margin-bottom: 10px; }',
  );
  const lastParagraphReset = styleSource.indexOf(
    'html.native-mobile .assistant-text p:last-child { margin-bottom: 0; }',
  );
  assert.ok(paragraphSpacing >= 0);
  assert.ok(lastParagraphReset > paragraphSpacing);
  assert.match(
    styleSource,
    /html\.native-mobile \.msg-interrupt \{ font-size: 14px; line-height: 21px; \}/,
  );
});

test('mobile header separator is drawn inside the fixed 44px bar', () => {
  assert.match(
    indexHtml,
    /html\.native-mobile \.top-bar\{[^}]*border-bottom:0;box-shadow:inset 0 -1px #2e2e2e/,
  );
  assert.match(
    styleSource,
    /html\.native-mobile \.top-bar \{[^}]*border-bottom: 0;[^}]*box-shadow: inset 0 -1px #2e2e2e;/s,
  );
});

test('mobile header title uses the same 20px logo slot and 6px gap as LaunchScreen', () => {
  assert.match(
    indexHtml,
    /class="top-logo" aria-hidden="true"><img src="assets\/baton-logo\.svg" alt=""><\/span><span class="top-title">Baton/,
  );
  assert.match(
    indexHtml,
    /html\.native-mobile \.top-left\{[^}]*gap:6px/,
  );
  assert.match(
    indexHtml,
    /html\.native-mobile \.top-logo\{width:20px;height:21px;line-height:21px;flex:0 0 20px;margin-right:0\}/,
  );
  assert.match(
    indexHtml,
    /html\.native-mobile \.top-title\{display:inline-flex;align-items:center;height:21px;line-height:21px\}/,
  );
  assert.match(launchScreen, /id="tbemoji">[\s\S]*?<rect key="frame" x="12"[^>]*width="20"/);
  assert.match(launchScreen, /id="tbtitle">[\s\S]*?<rect key="frame" x="38"/);
  assert.match(
    launchScreen,
    /firstItem="tbemoji"[^>]*constant="-21\.6666666667" id="tbe-cy"/,
  );
  assert.match(
    launchScreen,
    /firstItem="tbtitle"[^>]*constant="-22\.6666666667" id="tbt-cy"/,
  );
  assert.match(
    launchScreen,
    /firstItem="tbgear"[^>]*secondItem="topbar"[^>]*constant="-22" id="tbg-cy"/,
  );
});

test('runtime icons load on demand instead of using unconditional image preloads', () => {
  assert.doesNotMatch(
    indexHtml,
    /<link[^>]+rel="preload"[^>]+(?:claude-code|codex)\.svg/,
  );
  assert.match(indexHtml, /runtime === 'codex' \? 'codex\.svg' : 'claude-code\.svg'/);
});
