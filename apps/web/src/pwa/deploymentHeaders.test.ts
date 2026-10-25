import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendCloudflareSecurityHeaders } from '@pointercad/ui/security-policy';

const checkedIn = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
const GLUE = '/assets/opencascade.full-C-qpVz7N.js';

/** Apply `_headers` as the host does: every matching block contributes, and repeated names are concatenated. */
function headersFor(text: string, path: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let matches = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/u.test(line)) {
      const expression = line.trim().split(/(\*|:[A-Za-z]\w*)/u).map(part => part === '*' ? '.*'
        : part.startsWith(':') && part.length > 1 ? '[^/]+' : part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('');
      matches = new RegExp('^' + expression + '$', 'u').test(path);
      continue;
    }
    if (!matches) continue;
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim().toLowerCase();
    result.set(name, [...(result.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return result;
}

describe('deployment cache headers', () => {
  it.each([['checked-in', checkedIn], ['published', appendCloudflareSecurityHeaders(checkedIn)]])(
    'caches the content-addressed OCCT glue once, without dropping isolation (%s)', (label, text) => {
      const glue = headersFor(text, GLUE);
      // A second overlapping Cache-Control would be concatenated into an invalid value.
      expect(glue.get('cache-control'), label).toEqual(['public, max-age=31536000, immutable']);
      expect(glue.get('cross-origin-embedder-policy')).toEqual(['require-corp']);
      expect(glue.get('cross-origin-opener-policy')).toEqual(['same-origin']);
      expect(glue.get('cross-origin-resource-policy')).toEqual(['same-origin']);
      expect(glue.get('x-content-type-options')).toEqual(['nosniff']);
      // The script must reach the Worker as served bytes: no re-encoding or type override.
      expect(glue.has('content-encoding')).toBe(false);
      expect(glue.has('content-type')).toBe(false);
    });

  it('keeps the published security headers on the cached glue', () => {
    const glue = headersFor(appendCloudflareSecurityHeaders(checkedIn), GLUE);
    expect(glue.get('x-frame-options')).toEqual(['DENY']);
    expect(glue.get('referrer-policy')).toEqual(['no-referrer']);
  });

  it.each(['/', '/index.html', '/service-worker.js', '/offline-assets.json', '/web-build.json', '/manual/index.html',
    '/assets/opencascade.full.js', '/manual/assets/opencascade.full-C-qpVz7N.js', '/assets/opencascade.full-C-qpVz7N.js.map',
    '/assets/kernel.worker-C-qpVz7N.js', '/assets/index-C-qpVz7N.js'])(
    'leaves %s to the host revalidation so a new release reaches stable entry points', path => {
      const values = headersFor(appendCloudflareSecurityHeaders(checkedIn), path).get('cache-control') ?? [];
      expect(values.filter(value => /immutable|max-age=[1-9]/u.test(value))).toEqual([]);
    });

  it('keeps the OCCT manifest revalidated, so a new kernel hash is found within a minute', () => {
    expect(headersFor(checkedIn, '/occt/manifest.json').get('cache-control')).toEqual(['public, max-age=60, must-revalidate']);
  });
});
