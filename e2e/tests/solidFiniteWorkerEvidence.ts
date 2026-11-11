import { createHash } from 'node:crypto';
import type { Page, Request } from '@playwright/test';

export interface AssetResponseEvidence {
  readonly id: number;
  readonly url: string;
  readonly status: number;
  readonly location: string | null;
  readonly redirectedFromId: number | null;
  readonly cachedFromId: number | null;
  bytes?: number;
  sha256?: string;
}

/** A local blob request is not an external network request. Only the registered Electron authority is handled as a custom origin. */
export function isLocalFiniteRequest(value: string, pageUrl: string): boolean {
  const origin = new URL(pageUrl), url = new URL(value);
  if (!['http:', 'https:', 'app:'].includes(origin.protocol)) return false;
  // Electron registers only app://pointercad as a standard, secure scheme in main/appProtocol.ts.
  const desktop = origin.protocol === 'app:' && origin.host === 'pointercad'
    && origin.username === '' && origin.password === '';
  if (origin.protocol === 'app:' && !desktop) return false;
  if (url.protocol === 'blob:') {
    if (desktop) {
      // Node's URL.origin remains null for app:, even though Electron registered this exact authority.
      if (!url.pathname.startsWith('app://')) return false;
      try {
        const inner = new URL(url.pathname);
        return inner.protocol === origin.protocol && inner.host === origin.host
          && inner.username === '' && inner.password === '';
      } catch { return false; }
    }
    return origin.origin !== 'null' && url.origin === origin.origin;
  }
  return url.protocol === origin.protocol && url.host === origin.host;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Validate only actually observed responses; never fetch replacement bytes. */
export function assetEvidenceErrors(rows: readonly AssetResponseEvidence[]): string[] {
  const errors: string[] = [];
  const complete = (row: AssetResponseEvidence): boolean => row.status === 200
    && typeof row.bytes === 'number' && row.bytes > 0
    && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256);
  for (const row of rows) {
    if (row.status === 200) {
      if (!complete(row)) errors.push(`Missing 200 body evidence: ${row.id} ${row.url}`);
    } else if (row.status === 304) {
      const source = rows.find(item => item.id === row.cachedFromId);
      if (source === undefined || source.id >= row.id || source.url !== row.url || !complete(source))
        errors.push(`304 lacks prior same-URL 200 body evidence: ${row.id} ${row.url}`);
    } else if (REDIRECTS.has(row.status)) {
      let current = row;
      const seen = new Set<number>();
      while (REDIRECTS.has(current.status) && !seen.has(current.id)) {
        seen.add(current.id);
        const next = rows.find(item => item.redirectedFromId === current.id);
        if (current.location === null || next === undefined
          || new URL(current.location, current.url).href !== next.url) break;
        current = next;
      }
      if (!complete(current)) errors.push(`Redirect lacks final 200 body evidence: ${row.id} ${row.url}`);
    } else errors.push(`Unexpected response status ${row.status}: ${row.url}`);
  }
  return errors;
}

export function observeFiniteAssets(page: Page, names: readonly string[]) {
  const responses: AssetResponseEvidence[] = [];
  const requests = new Map<Request, AssetResponseEvidence>();
  const errors: string[] = [], pending: Promise<void>[] = [];
  page.on('response', response => {
    const request = response.request(), previous = request.redirectedFrom();
    const parent = previous === null ? undefined : requests.get(previous);
    const path = new URL(response.url()).pathname;
    if (parent === undefined && !path.endsWith('/fem/worker.js')
      && !names.some(name => path.endsWith('/fem/assets/' + name))) return;
    const status = response.status();
    const prior = status === 304
      ? responses.slice().reverse().find(row => row.url === response.url() && row.status === 200) : undefined;
    const row: AssetResponseEvidence = { id: responses.length + 1, url: response.url(), status,
      location: response.headers()['location'] ?? null, redirectedFromId: parent?.id ?? null,
      cachedFromId: prior?.id ?? null };
    responses.push(row); requests.set(request, row);
    if (status === 200) pending.push(response.body().then(bytes => {
      row.bytes = bytes.byteLength; row.sha256 = createHash('sha256').update(bytes).digest('hex');
    }, (error: unknown) => { errors.push(`${row.id} ${row.url}: ${String(error)}`); }));
  });
  return { responses, errors, pending, validationErrors: (): string[] => assetEvidenceErrors(responses) };
}
