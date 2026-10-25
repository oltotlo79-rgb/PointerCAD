import { describe, expect, it } from 'vitest';
import type { SubShapeOrigin } from '@pointercad/model';
import { isSubShapeOrigin, readSubShapeOrigin, serializeSubShapeOrigin } from './subShapeOrigin.js';

const top: SubShapeOrigin = { version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box-1', role: 'top' } };
const left: SubShapeOrigin = { version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box-1', role: 'left' } };
const right: SubShapeOrigin = { version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box-1', role: 'right' } };
const cylinderOrigins: readonly SubShapeOrigin[] = [
  ...(['side', 'start', 'end'] as const).map(role => ({ version: 1 as const, shapeKind: 'face' as const,
    identity: { kind: 'cylinder-face' as const, featureId: 'cylinder-1', role } })),
  ...(['start-ring', 'end-ring', 'seam'] as const).map(role => ({ version: 1 as const, shapeKind: 'edge' as const,
    identity: { kind: 'cylinder-edge' as const, featureId: 'cylinder-1', role } })),
  ...(['seam-start', 'seam-end'] as const).map(role => ({ version: 1 as const, shapeKind: 'vertex' as const,
    identity: { kind: 'cylinder-vertex' as const, featureId: 'cylinder-1', role } })),
];

describe('origin-v1 JSON value', () => {
  it('copies all supported identity families as plain values', () => {
    const origins: readonly SubShapeOrigin[] = [
      top,
      { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'box-1', role: 'top-front' } },
      { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'box-1', role: 'top-front-left' } },
      { version: 1, shapeKind: 'face', identity: { kind: 'extrude-side', featureId: 'extrude-1',
        profile: { sketchId: 'sketch-1', faceFeatureId: 'region-1', lineFeatureId: 'line-1', role: 'whole-line' } } },
      { version: 1, shapeKind: 'face', identity: { kind: 'extrude-cap', featureId: 'extrude-1', end: 'end',
        profile: { sketchId: 'sketch-1', faceFeatureId: 'region-1', lineFeatureIds: ['a', 'b', 'c', 'd'] } } },
      { version: 1, shapeKind: 'face', identity: { kind: 'blend-face', featureId: 'fillet-1', operation: 'fillet',
        source: { kind: 'box-edge', featureId: 'box-1', role: 'top-front' } } },
      { version: 1, shapeKind: 'face', identity: { kind: 'merged-face', featureId: 'union-1',
        sources: [top.identity, left.identity] } },
      { version: 1, shapeKind: 'edge', identity: { kind: 'face-intersection-edge', featureId: 'union-1',
        faces: [top.identity, left.identity] } },
      { version: 1, shapeKind: 'edge', identity: { kind: 'merged-edge', featureId: 'union-1',
        sources: [{ kind: 'box-edge', featureId: 'box-1', role: 'top-front' },
          { kind: 'box-edge', featureId: 'box-1', role: 'top-back' }] } },
      { version: 1, shapeKind: 'vertex', identity: { kind: 'face-intersection-vertex', featureId: 'union-1',
        faces: [top.identity, left.identity, right.identity] } },
      { version: 1, shapeKind: 'vertex', identity: { kind: 'merged-vertex', featureId: 'union-1',
        sources: [{ kind: 'box-vertex', featureId: 'box-1', role: 'top-front-left' },
          { kind: 'box-vertex', featureId: 'box-1', role: 'top-front-right' }] } },
      ...cylinderOrigins,
      { version: 1, shapeKind: 'face', identity: { kind: 'merged-face', featureId: 'union-2',
        sources: [top.identity, { kind: 'cylinder-face', featureId: 'cylinder-1', role: 'side' }] } },
    ];
    for (const origin of origins) {
      const serialized = serializeSubShapeOrigin(origin);
      expect(serialized).toEqual(origin);
      expect(serialized).not.toBe(origin);
      expect(readSubShapeOrigin(JSON.parse(JSON.stringify(serialized)) as unknown, 'ref.origin'))
        .toEqual({ ok: true, value: origin });
      expect(isSubShapeOrigin(serialized)).toBe(true);
    }
  });

  it('keeps all eight cylinder roles closed on read and write', () => {
    expect(cylinderOrigins).toHaveLength(8);
    for (const origin of cylinderOrigins) {
      expect(readSubShapeOrigin(origin, 'ref.origin')).toEqual({ ok: true, value: origin });
      expect(serializeSubShapeOrigin(origin)).toEqual(origin);
    }
    for (const origin of cylinderOrigins) {
      const unknownRole = { ...origin, identity: { ...origin.identity, role: 'other' } };
      const extraField = { ...origin, identity: { ...origin.identity, nativeIndex: 4 } };
      const wrongKind = { ...origin, shapeKind: origin.shapeKind === 'face' ? 'edge' : 'face' };
      const invalidValues: readonly unknown[] = [unknownRole, extraField, wrongKind];
      for (const invalid of invalidValues) {
        expect(readSubShapeOrigin(invalid, 'ref.origin').ok).toBe(false);
        expect(isSubShapeOrigin(invalid)).toBe(false);
        expect(() => serializeSubShapeOrigin(invalid as SubShapeOrigin)).toThrow(RangeError);
      }
    }
  });

  it('rejects unknown versions, variants, mixed shapes and runtime tables', () => {
    const invalid: readonly unknown[] = [
      { ...top, version: 2 },
      { ...top, shapeKind: 'edge' },
      { ...top, identity: { kind: 'box-face', featureId: 'box-1', role: 'up' } },
      { ...top, identity: { ...top.identity, bindings: [] } },
      { ...top, bindings: [{ state: 'unique', current: { kind: 'face', index: 0 } }] },
      { ...top, identity: { kind: 'extrude-side', featureId: 'e',
        profile: { sketchId: 's', faceFeatureId: 'f', lineFeatureId: 'l', role: 'piece' } } },
      { ...top, identity: { kind: 'extrude-cap', featureId: 'e', end: 'end',
        profile: { sketchId: 's', faceFeatureId: 'f', lineFeatureIds: ['a', 'b'] } } },
      { version: 1, shapeKind: 'face', identity: { kind: 'merged-face', featureId: 'merge', sources: [top.identity] } },
      { version: 1, shapeKind: 'edge', identity: { kind: 'face-intersection-edge', featureId: 'merge', faces: [top.identity] } },
    ];
    for (const value of invalid) {
      expect(readSubShapeOrigin(value, 'ref.origin').ok).toBe(false);
      expect(isSubShapeOrigin(value)).toBe(false);
    }
  });

  it('rejects cycles and depth, node, array, ID and UTF8 bounds', () => {
    const cyclic: Record<string, unknown> = { version: 1, shapeKind: 'face' };
    cyclic['identity'] = cyclic;
    const overDepth = { version: 1, shapeKind: 'face', identity: top.identity };
    let nested: unknown = overDepth.identity;
    for (let index = 0; index < 17; index += 1) {
      nested = { kind: 'merged-face', featureId: `m-${String(index)}`, sources: [nested, top.identity] };
    }
    const cases: readonly unknown[] = [
      cyclic,
      { version: 1, shapeKind: 'face', identity: nested },
      { ...top, identity: { ...top.identity, featureId: 'x'.repeat(257) } },
      { version: 1, shapeKind: 'face', identity: { kind: 'merged-face', featureId: 'm',
        sources: Array.from({ length: 33 }, () => top.identity) } },
      { version: 1, shapeKind: 'face', identity: { kind: 'merged-face', featureId: 'm',
        sources: Array.from({ length: 32 }, (_, index) => ({ kind: 'merged-face', featureId: `m${String(index)}`,
          sources: [top.identity, top.identity] })) } },
      { ...top, identity: { ...top.identity, featureId: 'あ'.repeat(22000) } },
    ];
    for (const value of cases) expect(readSubShapeOrigin(value, 'ref.origin').ok).toBe(false);
  });
});

describe('hole operation origins persist logical producer and slot source proof', () => {
  const center = { sketchId: 'sketch-1', producer: { kind: 'grid-point', featureId: 'grid-1', row: 2, column: 1 } } as const;
  const wall = { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'hole-1', center,
    placement: { kind: 'point-slot', slotId: 'slot-7', source: { kind: 'sketch-point', anchor: {
      sketchId: 'placement-sketch', producer: { kind: 'copied-point', featureId: 'copy-1',
        source: { kind: 'circular-point', featureId: 'circle-1', numerator: 1, denominator: 4 },
        placement: { kind: 'linear', step: 2 },
      },
    } } }, stage: 'counterbore', role: 'wall' } } as const satisfies SubShapeOrigin;

  it('round-trips nested copy, point-slot source and a native face-intersection rim', () => {
    const rim: SubShapeOrigin = { version: 1, shapeKind: 'edge', identity: { kind: 'face-intersection-edge',
      featureId: 'hole-1', faces: [top.identity, wall.identity] } };
    for (const origin of [wall, rim]) {
      expect(serializeSubShapeOrigin(origin)).toEqual(origin);
      expect(readSubShapeOrigin(serializeSubShapeOrigin(origin), 'origin')).toEqual({ ok: true, value: origin });
    }
  });

  it('rejects naked slot identity, topology index and non-reduced circle fraction', () => {
    const invalid: readonly unknown[] = [
      { ...wall, identity: { ...wall.identity, placement: { kind: 'point-slot', slotId: 'slot-7' } } },
      { ...wall, identity: { ...wall.identity, center: { ...center, producer: { ...center.producer, index: 7 } } } },
      { ...wall, identity: { ...wall.identity, center: { sketchId: 'sketch-1', producer: {
        kind: 'circular-point', featureId: 'circle-1', numerator: 2, denominator: 8,
      } } } },
      { ...wall, identity: { ...wall.identity, placement: { ...wall.identity.placement, slotId: 'slot-0' } } },
    ];
    for (const origin of invalid) expect(readSubShapeOrigin(origin, 'origin').ok).toBe(false);
  });
});


describe('modeled thread groove origin is saved only as the thread/groove pair', () => {
  const center = { sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } } as const;
  const groove = { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'thread-1', center,
    placement: { kind: 'linear', step: 2 }, stage: 'thread', role: 'groove' } } as const satisfies SubShapeOrigin;
  const bore = { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'thread-1', center,
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } as const satisfies SubShapeOrigin;

  it('round-trips the groove pair through JSON and keeps every old stage/role pair readable', () => {
    expect(readSubShapeOrigin(JSON.parse(JSON.stringify(serializeSubShapeOrigin(groove))) as unknown, 'origin'))
      .toEqual({ ok: true, value: groove });
    for (const stage of ['bore', 'counterbore', 'countersink'] as const) {
      for (const role of ['wall', 'floor', 'entry-cap'] as const) {
        const old = { ...bore, identity: { ...bore.identity, stage, role } };
        expect(readSubShapeOrigin(old, 'origin')).toEqual({ ok: true, value: old });
      }
    }
  });

  it('refuses a thread stage with an old role, an old stage with groove, and extra or missing fields', () => {
    const invalid: readonly unknown[] = [
      ...(['wall', 'floor', 'entry-cap'] as const).map(role => ({ ...groove, identity: { ...groove.identity, role } })),
      ...(['bore', 'counterbore', 'countersink'] as const).map(stage => ({ ...groove, identity: { ...groove.identity, stage } })),
      { ...groove, identity: { ...groove.identity, role: 'thread' } },
      { ...groove, identity: { ...groove.identity, stage: 'groove' } },
      { ...groove, identity: { ...groove.identity, faceIndex: 3 } },
      { ...groove, identity: { kind: 'hole-face', featureId: 'thread-1', center, stage: 'thread', role: 'groove' } },
    ];
    for (const origin of invalid) expect(readSubShapeOrigin(origin, 'origin').ok).toBe(false);
  });
});

describe('hole nested source proof retains outer codec budgets', () => {
  const wall = { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'hole',
    center: { sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } },
    placement: { kind: 'point-slot', slotId: 'slot-9', source: { kind: 'sphere-grid', featureId: 'sphere',
      latitudeSource: 'lat', longitudeSource: '0' } }, stage: 'bore', role: 'wall' } } as const satisfies SubShapeOrigin;
  it('round-trips authored sphere source and never persists an evaluated angle', () => {
    expect(readSubShapeOrigin(serializeSubShapeOrigin(wall), 'origin')).toEqual({ ok: true, value: wall });
    expect(readSubShapeOrigin({ ...wall, identity: { ...wall.identity, placement: { ...wall.identity.placement,
      source: { kind: 'sphere-grid', featureId: 'sphere', latitude: 30, longitude: 0 } } } }, 'origin').ok).toBe(false);
  });
  it('refuses an over-depth nested semantic placement source before recursive read resets its budget', () => {
    let nested: unknown = top;
    for (let depth = 0; depth < 17; depth++) nested = { ...wall, identity: { ...wall.identity,
      placement: { kind: 'point-slot', slotId: 'slot-9', source: { kind: 'semantic-subshape', bodyFeatureId: 'body', origin: nested } } } };
    expect(readSubShapeOrigin(nested, 'origin').ok).toBe(false);
    expect(readSubShapeOrigin({ version: 1, shapeKind: 'face', identity: { kind: 'merged-face', featureId: 'many',
      sources: Array.from({ length: 32 }, () => wall.identity) } }, 'origin').ok).toBe(false);
  });
});


it('round-trips the whole sphere surface and rejects invented roles and runtime addresses', () => {
  const sphere = { version: 1, shapeKind: 'face', identity: {
    kind: 'sphere-face', featureId: 'persisted-sphere', role: 'surface',
  } } as const satisfies SubShapeOrigin;
  expect(readSubShapeOrigin(JSON.parse(JSON.stringify(serializeSubShapeOrigin(sphere))) as unknown, 'origin'))
    .toEqual({ ok: true, value: sphere });
  expect(isSubShapeOrigin(sphere)).toBe(true);
  const invalid: readonly unknown[] = [
    { ...sphere, shapeKind: 'edge' },
    { ...sphere, identity: { ...sphere.identity, role: 'side' } },
    { ...sphere, identity: { ...sphere.identity, role: 'pole' } },
    { ...sphere, identity: { ...sphere.identity, index: 0 } },
    { ...sphere, identity: { ...sphere.identity, featureId: '' } },
  ];
  for (const value of invalid) {
    expect(readSubShapeOrigin(value, 'origin').ok).toBe(false);
    expect(isSubShapeOrigin(value)).toBe(false);
    expect(() => serializeSubShapeOrigin(value as SubShapeOrigin)).toThrow(RangeError);
  }
});


it('round-trips cone/torus identities and their composed save graph without accepting unnamed or indexed roles', () => {
  const analytic: readonly SubShapeOrigin[] = [
    ...(['side', 'start', 'end'] as const).map(role => ({ version: 1 as const, shapeKind: 'face' as const,
      identity: { kind: 'cone-face' as const, featureId: 'saved-cone', role } })),
    { version: 1, shapeKind: 'face', identity: { kind: 'torus-face', featureId: 'saved-torus', role: 'surface' } },
  ];
  for (const origin of analytic) {
    const saved = JSON.stringify(serializeSubShapeOrigin(origin));
    expect(readSubShapeOrigin(JSON.parse(saved) as unknown, 'origin')).toEqual({ ok: true, value: origin });
    expect(isSubShapeOrigin(origin)).toBe(true);
    if (origin.shapeKind !== 'face') throw new Error('Expected analytic face');
    const merged: SubShapeOrigin = { version: 1, shapeKind: 'face', identity: {
      kind: 'merged-face', featureId: 'boolean', sources: [top.identity, origin.identity],
    } };
    expect(readSubShapeOrigin(JSON.parse(JSON.stringify(serializeSubShapeOrigin(merged))) as unknown, 'origin'))
      .toEqual({ ok: true, value: merged });
    const invalid: readonly unknown[] = [
      { ...origin, shapeKind: 'edge' },
      { ...origin, identity: { ...origin.identity, role: 'seam' } },
      { ...origin, identity: { ...origin.identity, role: 'apex' } },
      { ...origin, identity: { ...origin.identity, role: origin.identity.kind === 'cone-face' ? 'surface' : 'side' } },
      { ...origin, identity: { ...origin.identity, current: { kind: 'face', index: 0 } } },
      { ...origin, identity: { ...origin.identity, featureId: '' } },
    ];
    for (const value of invalid) {
      expect(readSubShapeOrigin(value, 'origin').ok).toBe(false);
      expect(isSubShapeOrigin(value)).toBe(false);
      expect(() => serializeSubShapeOrigin(value as SubShapeOrigin)).toThrow(RangeError);
    }
  }
});
it('round-trips saved whole-curve origins and rejects mixed legacy fields or ambiguous cap IDs', () => {
  const side = { version: 1, shapeKind: 'face', identity: { kind: 'extrude-curve-side', featureId: 'extrude',
    profile: { sketchId: 'sketch', faceFeatureId: 'region', curveFeatureId: 'spline', role: 'whole-curve' } } } as const satisfies SubShapeOrigin;
  const cap = { version: 1, shapeKind: 'face', identity: { kind: 'extrude-curve-cap', featureId: 'extrude', end: 'start',
    profile: { sketchId: 'sketch', faceFeatureId: 'region', curveFeatureIds: ['spline', 'a', 'b'] } } } as const satisfies SubShapeOrigin;
  for (const origin of [side, cap]) {
    expect(serializeSubShapeOrigin(origin)).toEqual(origin);
    expect(readSubShapeOrigin(JSON.parse(JSON.stringify(origin)) as unknown, 'origin')).toEqual({ ok: true, value: origin });
  }
  for (const invalid of [
    { ...side, identity: { ...side.identity, profile: { ...side.identity.profile, role: 'whole-line' } } },
    { ...side, identity: { ...side.identity, profile: { ...side.identity.profile, lineFeatureId: 'spline' } } },
    { ...side, identity: { ...side.identity, profile: { ...side.identity.profile, curveFeatureId: '' } } },
    { ...cap, identity: { ...cap.identity, profile: { ...cap.identity.profile, curveFeatureIds: ['a', 'a', 'b'] } } },
    { ...cap, identity: { ...cap.identity, profile: { ...cap.identity.profile, curveFeatureIds: ['a', 'b'] } } },
    { ...cap, identity: { ...cap.identity, profile: { ...cap.identity.profile, lineFeatureIds: ['a', 'b', 'c'] } } },
  ]) expect(readSubShapeOrigin(invalid, 'origin').ok).toBe(false);
});

describe('open surface source identity', () => {
  const origin = { version: 1, shapeKind: 'face', identity: { kind: 'surface-side',
    featureId: 'surface', profile: { sketchId: 'sketch', lineFeatureId: 'line', role: 'whole-line' } } } as const;
  it('roundtrips saved line ownership with no fabricated closed-face identity', () => {
    expect(readSubShapeOrigin(JSON.parse(JSON.stringify(serializeSubShapeOrigin(origin))) as unknown, 'origin'))
      .toEqual({ ok: true, value: origin });
  });
  it.each([
    { sketchId: 'sketch', lineFeatureId: 'line', role: 'piece' },
    { sketchId: 'sketch', lineFeatureId: '', role: 'whole-line' },
    { sketchId: 'sketch', lineFeatureId: 'line', role: 'whole-line', faceFeatureId: 'invented' },
    { lineFeatureId: 'line', role: 'whole-line' },
  ])('rejects malformed or fabricated source anchors %j', profile => {
    expect(readSubShapeOrigin({ ...origin, identity: { ...origin.identity, profile } }, 'origin').ok).toBe(false);
  });
});
