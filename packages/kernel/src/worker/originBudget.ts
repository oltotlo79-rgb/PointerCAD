import type { CurrentOriginIndex } from '../subShapeOrigin.js';
import type { SolidBodyMesh } from '../types.js';

export const ORIGIN_BODY_MAX_ROWS = 100_000;
export const ORIGIN_BODY_MAX_LINKS = 400_000;
export const ORIGIN_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const ORIGIN_REPLY_MAX_BYTES = 32 * 1024 * 1024;
export const ORIGIN_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export const limitOrigins = (): CurrentOriginIndex => ({ version: 1, state: 'untracked', reason: 'limit' });

export function originRows(index: CurrentOriginIndex): number {
  return index.state === 'tracked' ? index.bindings.length + (index.fingerprintFallback?.length ?? 0) : 1;
}

function links(index: CurrentOriginIndex): number {
  if (index.state !== 'tracked') return 0;
  let count = index.fingerprintFallback?.length ?? 0;
  for (const binding of index.bindings) {
    if (binding.state === 'unique') count += 1;
    else if (binding.state === 'split') count += binding.candidates.length;
    else if (binding.state === 'merged') count += 1 + binding.coOrigins.length;
    if (count > ORIGIN_BODY_MAX_LINKS) return count;
  }
  return count;
}

/** Every emitted table counts, including anonymous proof rows and untracked envelopes. */
export function originBytes(index: CurrentOriginIndex): number {
  if (originRows(index) > ORIGIN_BODY_MAX_ROWS || links(index) > ORIGIN_BODY_MAX_LINKS) return Infinity;
  return new TextEncoder().encode(JSON.stringify(index)).length;
}

/** No partial table is emitted when any limit is exceeded. */
export function withinBodyOriginBudget(index: CurrentOriginIndex): CurrentOriginIndex {
  return originBytes(index) <= ORIGIN_BODY_MAX_BYTES ? index : limitOrigins();
}

/** Response budget is all-or-none across visible bodies. Cache tables remain untouched. */
export function withinReplyOriginBudget(
  bodies: readonly SolidBodyMesh[], maxBytes = ORIGIN_REPLY_MAX_BYTES,
): readonly SolidBodyMesh[] {
  let total = 0;
  for (const body of bodies) {
    if (body.origins === undefined) continue;
    total += originBytes(body.origins);
    if (total > maxBytes) return bodies.map((value) => ({ ...value, origins: limitOrigins() }));
  }
  return bodies;
}

/** Accounts every origin table that still belongs to a live ShapeCache entry. */
export class OriginCacheBudget {
  private readonly byKey = new Map<string, number>();
  private total = 0;
  constructor(private readonly maxBytes = ORIGIN_CACHE_MAX_BYTES) {}

  /** Internal diagnostic count; neither cache rows nor native history are exposed. */
  get trackedKeyCount(): number { return this.byKey.size; }

  private forget(key: string): void {
    const previous = this.byKey.get(key);
    if (previous === undefined) return;
    this.byKey.delete(key);
    this.total -= previous;
  }

  admit(key: string, origins: CurrentOriginIndex, cacheEmpty: boolean,
    isLive: (key: string) => boolean): CurrentOriginIndex {
    if (cacheEmpty) { this.byKey.clear(); this.total = 0; }
    else for (const cachedKey of this.byKey.keys()) if (!isLive(cachedKey)) this.forget(cachedKey);
    const bytes = originBytes(origins);
    if (bytes === 0) { this.forget(key); return origins; }
    if (bytes > ORIGIN_BODY_MAX_BYTES || this.total - (this.byKey.get(key) ?? 0) + bytes > this.maxBytes) {
      this.forget(key);
      return limitOrigins();
    }
    this.total += bytes - (this.byKey.get(key) ?? 0);
    this.byKey.set(key, bytes);
    return origins;
  }
}
