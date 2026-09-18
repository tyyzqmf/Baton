import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { attachTerminalTouchScroll } from '../../web/js/terminal-touch-scroll.js';

function setup(context) {
  const dom = new JSDOM('<main><div class="xterm-screen"></div><div class="scrollbar"></div><textarea></textarea></main>');
  const { window } = dom;
  const screen = window.document.querySelector('main');
  screen.querySelector('.xterm-screen').getBoundingClientRect = () => ({ height: 400 });
  let now = 0;
  let nextFrame = 0;
  const frames = new Map();
  const subscriptions = new Map();
  window.performance.now = () => now;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = frame => frames.delete(frame);
  const subscribe = (name, callback) => {
    subscriptions.set(name, callback);
    return { dispose() { subscriptions.delete(name); } };
  };
  const buffer = { baseY: 200, viewportY: 100 };
  const positions = [];
  const terminal = {
    rows: 20,
    buffer: { active: buffer, onBufferChange: callback => subscribe('buffer', callback) },
    onResize: callback => subscribe('resize', callback),
    scrollToLine(line) { positions.push(line); buffer.viewportY = line; },
  };
  const dispose = attachTerminalTouchScroll(terminal, screen);
  context.after(() => { dispose(); window.close(); });
  const touch = (type, { x = 100, y = 100, delay = 20, count = type === 'touchend' ? 0 : 1, target = screen } = {}) => {
    now += delay;
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) },
      timeStamp: { value: now },
    });
    target.dispatchEvent(event);
    return event;
  };
  const frame = () => {
    now += 16;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(now);
  };
  return { window, screen, buffer, positions, frames, subscriptions, touch, frame, dispose };
}

test('touch drags scroll terminal history in both directions, preserving partial rows and focus', context => {
  const { window, screen, buffer, touch } = setup(context);
  const textarea = screen.querySelector('textarea');
  textarea.focus();
  assert.equal(touch('touchstart').defaultPrevented, false);
  assert.equal(touch('touchmove', { y: 106 }).defaultPrevented, false);
  assert.equal(touch('touchmove', { y: 120 }).defaultPrevented, true);
  assert.equal(buffer.viewportY, 99);
  for (const y of [125, 130, 135, 140]) touch('touchmove', { y });
  assert.equal(buffer.viewportY, 98);
  touch('touchmove', { y: 80 });
  assert.equal(buffer.viewportY, 101);
  assert.equal(screen.scrollTop, 0);
  assert.equal(window.document.activeElement, textarea);
});

test('a released swipe coasts, and a new touch stops the momentum immediately', context => {
  const { buffer, frames, touch, frame } = setup(context);
  touch('touchstart');
  touch('touchmove', { y: 160 });
  touch('touchend');
  const released = buffer.viewportY;
  for (let index = 0; index < 10; index++) frame();
  assert.ok(buffer.viewportY < released);
  assert.equal(frames.size, 1);
  touch('touchstart');
  const stopped = buffer.viewportY;
  for (let index = 0; index < 10; index++) frame();
  assert.equal(frames.size, 0);
  assert.equal(buffer.viewportY, stopped);
});

test('a held swipe does not coast and reaching either boundary allows immediate reversal', context => {
  const { buffer, frames, touch } = setup(context);
  buffer.viewportY = 1;
  touch('touchstart');
  touch('touchmove', { y: 180 });
  assert.equal(buffer.viewportY, 0);
  touch('touchmove', { y: 160 });
  assert.equal(buffer.viewportY, 1);
  touch('touchend', { delay: 150 });
  assert.equal(frames.size, 0);
  buffer.viewportY = 199;
  touch('touchstart');
  touch('touchmove', { y: 20 });
  assert.equal(buffer.viewportY, 200);
  touch('touchmove', { y: 40 });
  assert.equal(buffer.viewportY, 199);
});

test('taps, horizontal swipes, multiple touches, selection and scrollbar interaction are left alone', context => {
  const { window, screen, buffer, frames, touch } = setup(context);
  touch('touchstart');
  assert.equal(touch('touchend').defaultPrevented, false);
  touch('touchstart');
  assert.equal(touch('touchmove', { x: 160, y: 110 }).defaultPrevented, false);
  assert.equal(touch('touchmove', { y: 180 }).defaultPrevented, false);
  touch('touchstart', { count: 2 });
  assert.equal(touch('touchmove', { y: 180 }).defaultPrevented, false);
  touch('touchstart');
  assert.equal(touch('touchmove', { y: 160, count: 2 }).defaultPrevented, false);
  assert.equal(touch('touchmove', { y: 180 }).defaultPrevented, false);
  for (const selector of ['.scrollbar', 'textarea']) {
    touch('touchstart', { target: screen.querySelector(selector) });
    assert.equal(touch('touchmove', { y: 180 }).defaultPrevented, false);
  }
  touch('touchstart');
  screen.dispatchEvent(new window.Event('contextmenu'));
  assert.equal(touch('touchmove', { y: 180 }).defaultPrevented, false);
  assert.equal(buffer.viewportY, 100);
  assert.equal(frames.size, 0);
});

test('touch cancellation, typing, wheel, resize, buffer switching and disposal stop pending scrolling', context => {
  const { window, screen, buffer, frames, subscriptions, touch, frame, dispose } = setup(context);
  for (const cancel of [
    () => touch('touchcancel'),
    () => screen.dispatchEvent(new window.Event('keydown')),
    () => screen.dispatchEvent(new window.Event('wheel')),
    () => subscriptions.get('resize')(),
    () => subscriptions.get('buffer')(),
    dispose,
  ]) {
    touch('touchstart');
    touch('touchmove', { y: 160 });
    touch('touchend');
    assert.equal(frames.size, 1);
    cancel();
    const stopped = buffer.viewportY;
    frame();
    assert.equal(frames.size, 0);
    assert.equal(buffer.viewportY, stopped);
  }
  assert.equal(subscriptions.size, 0);
  touch('touchstart');
  const stopped = buffer.viewportY;
  assert.equal(touch('touchmove', { y: 160 }).defaultPrevented, false);
  assert.equal(buffer.viewportY, stopped);
});
