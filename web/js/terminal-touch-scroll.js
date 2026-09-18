export function attachTerminalTouchScroll(terminal, screen) {
  const window = screen.ownerDocument.defaultView;
  const listeners = [];
  let gesture = null;
  let animation = 0;
  let position = 0;
  const listen = (name, callback, options) => {
    screen.addEventListener(name, callback, options);
    listeners.push(() => screen.removeEventListener(name, callback, options));
  };
  const cancel = () => {
    gesture = null;
    window.cancelAnimationFrame(animation);
    animation = 0;
  };
  const scroll = pixels => {
    const rowHeight = screen.querySelector('.xterm-screen')?.getBoundingClientRect().height / terminal.rows;
    if (!(rowHeight > 0)) return false;
    const previous = position;
    position = Math.max(0, Math.min(terminal.buffer.active.baseY, position + pixels / rowHeight));
    terminal.scrollToLine(Math.round(position));
    return position !== previous;
  };

  listen('touchstart', event => {
    cancel();
    if (event.touches.length !== 1 || event.target.closest?.('.scrollbar, a, button, textarea')) return;
    const touch = event.touches[0];
    position = terminal.buffer.active.viewportY;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY,
      time: event.timeStamp, velocity: 0, scrolling: false };
  }, { passive: true });
  listen('touchmove', event => {
    if (!gesture) return;
    if (event.touches.length !== 1 || event.touches[0].identifier !== gesture.id) return cancel();
    const touch = event.touches[0];
    if (!gesture.scrolling) {
      const horizontal = Math.abs(touch.clientX - gesture.x);
      const vertical = Math.abs(touch.clientY - gesture.y);
      if (Math.max(horizontal, vertical) <= 8) return;
      if (horizontal >= vertical) return cancel();
      gesture.scrolling = true;
    }
    event.preventDefault();
    const delta = gesture.lastY - touch.clientY;
    const elapsed = Math.max(1, event.timeStamp - gesture.time);
    gesture.velocity = elapsed > 100 ? delta / elapsed : gesture.velocity * 0.4 + delta / elapsed * 0.6;
    gesture.lastY = touch.clientY;
    gesture.time = event.timeStamp;
    scroll(delta);
  }, { passive: false });
  listen('touchend', event => {
    const finished = gesture;
    gesture = null;
    if (!finished?.scrolling || event.touches.length || event.timeStamp - finished.time > 100) return;
    let velocity = finished.velocity;
    let previous = window.performance.now();
    const coast = now => {
      animation = 0;
      const elapsed = Math.min(32, now - previous);
      previous = now;
      velocity *= Math.exp(-elapsed / 220);
      if (Math.abs(velocity) < 0.02 || !scroll(velocity * elapsed)) return;
      animation = window.requestAnimationFrame(coast);
    };
    animation = window.requestAnimationFrame(coast);
  }, { passive: true });
  for (const name of ['touchcancel', 'contextmenu', 'wheel', 'keydown']) listen(name, cancel, { passive: true });
  const resize = terminal.onResize(cancel);
  const bufferChange = terminal.buffer.onBufferChange(cancel);
  return () => {
    cancel();
    resize.dispose();
    bufferChange.dispose();
    for (const dispose of listeners) dispose();
  };
}
