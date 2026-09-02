function escapeAttribute(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function loadingSpinner(options) {
  options = options || {};
  var size = options.size === 'small' ? 'small' : 'medium';
  var label = options.label || 'Loading';
  return '<span class="loading-spinner loading-spinner-' + size + '"'
    + ' role="status" aria-label="' + escapeAttribute(label) + '"></span>';
}
