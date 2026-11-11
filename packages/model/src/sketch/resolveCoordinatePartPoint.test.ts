import { describe, expect, it } from 'vitest';

import { NO_PART_POINT, type PartPointLookup, resolvePointReference, type ResolveContext } from './resolveCoordinate.js';
import type { ResolvedPoint } from './types.js';

/** The bridge contract of PointReference kind 'point' against local sketch points and part reference points. */
function context(points: readonly ResolvedPoint[], partPoint?: (pointId: string) => PartPointLookup): ResolveContext {
  return { plane: null, points, previous: null, vertices: new Map(), ...(partPoint === undefined ? {} : { partPoint }) };
}

const LOCAL: ResolvedPoint = { id: 'point-1', featureId: 'point-1', position: [1, 2, 3] };
const ref = (pointId: string) => ({ kind: 'point', pointId }) as const;

describe('sketch point base resolves part reference points only through the explicit bridge', () => {
  it('without the bridge, behaviour is unchanged: local points resolve, unknown ids are missing', () => {
    expect(resolvePointReference(ref('point-1'), context([LOCAL]), 'f')).toEqual({ ok: true, value: [1, 2, 3] });
    expect(resolvePointReference(ref('refpoint-1'), context([LOCAL]), 'f')).toMatchObject({ ok: false,
      error: { code: 'missingBase' } });
  });

  it('a part reference point resolves when no local point has its id', () => {
    const bridge = (id: string): PartPointLookup => id === 'refpoint-1' ? { kind: 'point', position: [10, 15, 10] } : NO_PART_POINT;
    expect(resolvePointReference(ref('refpoint-1'), context([LOCAL], bridge), 'f')).toEqual({ ok: true, value: [10, 15, 10] });
    expect(resolvePointReference(ref('point-1'), context([LOCAL], bridge), 'f')).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('the same id as both a local point and a part reference point is refused, never silently chosen', () => {
    const bridge = (): PartPointLookup => ({ kind: 'point', position: [9, 9, 9] });
    expect(resolvePointReference(ref('point-1'), context([LOCAL], bridge), 'f')).toMatchObject({ ok: false,
      error: { code: 'invalidValue', featureId: 'f' } });
  });

  it('a refused part point (stale or cycle-unsafe) fails with its own message', () => {
    const bridge = (): PartPointLookup => ({ kind: 'refused', message: 'unsupported reference point' });
    expect(resolvePointReference(ref('refpoint-1'), context([], bridge), 'f')).toEqual({ ok: false,
      error: { featureId: 'f', code: 'missingBase', message: 'unsupported reference point' } });
    // A refused lookup with a same-id local point is still ambiguous rather than falling back to the local point.
    expect(resolvePointReference(ref('point-1'), context([LOCAL], bridge), 'f')).toMatchObject({ ok: false,
      error: { code: 'invalidValue' } });
  });
});
