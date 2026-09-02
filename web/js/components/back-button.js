function escapeAttribute(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const BACK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none"'
  + ' stroke="currentColor" stroke-width="2" stroke-linecap="round"'
  + ' stroke-linejoin="round" aria-hidden="true">'
  + '<path d="m15 6-6 6 6 6"/></svg>';

export function backButtonHtml(options) {
  options = options || {};
  const label = escapeAttribute(options.label || 'Back');
  const extraClass = options.className
    ? ` ${escapeAttribute(options.className)}`
    : '';
  return '<button class="back-button' + extraClass + '" type="button"'
    + ' aria-label="' + label + '" title="' + label + '">'
    + BACK_ICON_SVG + '</button>';
}

export function mountBackButton(container, onBack, options) {
  container.innerHTML = backButtonHtml(options);
  const button = container.querySelector('.back-button');
  button.addEventListener('click', onBack);
  return button;
}
