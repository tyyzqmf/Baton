import assert from 'node:assert/strict';
import test from 'node:test';
import { loadingSpinner } from '../../web/js/components/loading.js';

test('shared loading spinner renders reusable sizes and one accessible status', () => {
  assert.equal(
    loadingSpinner({ size: 'small', label: 'Loading directory' }),
    '<span class="loading-spinner loading-spinner-small"'
      + ' role="status" aria-label="Loading directory"></span>',
  );
  assert.match(
    loadingSpinner({ label: 'Loading "file"' }),
    /loading-spinner-medium[^]*aria-label="Loading &quot;file&quot;"/,
  );
});
