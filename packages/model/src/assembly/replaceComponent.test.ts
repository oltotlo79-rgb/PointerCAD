import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SolidBody } from '../kernelBridge.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { applyReplacement, planReplacement } from './replaceComponent.js';
import type { AssemblyComponent, AssemblyDocument, MateTarget } from './types.js';

function component(id: string): AssemblyComponent {
  return {
    id, name: id, source: { kind: 'part', partRef: 'part-1' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false,
  };
}

function faceRef(index = 0, area = 100): SubShapeRef {
  return {
    bodyFeatureId: 'solid-1', index,
    fingerprint: {
      kind: 'face', surfaceKind: 'plane', area, position: [5, 5, 0], axis: [0, 0, 1], radius: null,
    },
  };
}

function faceTarget(componentId: string, ref = faceRef()): MateTarget {
  return { kind: 'subShape', componentId, ref };
}

function originTarget(componentId: string): MateTarget {
  return { kind: 'origin', componentId, element: 'origin' };
}

function body(faceIndex = 0, includeFace = true): SolidBody {
  return {
    featureId: 'solid-1', volume: 1000, area: 600, bodyKind: 'solid', isValid: true,
    mesh: {
      positions: new Float32Array([0, 0, 0, 10, 10, 10]), normals: new Float32Array(6),
      indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 1,
    },
    faces: includeFace ? [{
      index: faceIndex, surfaceKind: 'plane', area: 100, centroid: [5, 5, 0],
      axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1,
    }] : [],
    edges: [], vertices: [], threadMarks: [],
  };
}

function document(target: MateTarget = faceTarget('component-1')): AssemblyDocument {
  return {
    ...createAssemblyDocument('組立1'),
    components: [component('component-1'), component('component-2')],
    mates: [{
      id: 'mate-1', name: '合致1', kind: 'coincident', a: target,
      b: originTarget('component-2'), value: expressionValueFromNumber(0),
      flipped: false, suppressed: false,
    }],
  };
}

const NEXT_SOURCE = { kind: 'part', partRef: 'part-2' } as const;

describe('planReplacement', () => {
  it('対象の部品が無ければ文書を変えずnullを返す', () => {
    expect(planReplacement(document(), 'component-9', NEXT_SOURCE, { bodies: [body()] })).toBeNull();
  });

  it('予告だけでは元の文書を変えない', () => {
    const before = document();
    planReplacement(before, 'component-1', NEXT_SOURCE, { bodies: [body()] });
    expect(before.components[0].source).toEqual({ kind: 'part', partRef: 'part-1' });
  });

  it('確定後は指定した部品の参照だけが変わる', () => {
    const plan = planReplacement(document(), 'component-1', NEXT_SOURCE, { bodies: [body()] });
    expect(plan?.after.components.map((item) => item.source)).toEqual([
      NEXT_SOURCE, { kind: 'part', partRef: 'part-1' },
    ]);
  });

  it('同じ面の指紋は選び直せる', () => {
    const plan = planReplacement(document(), 'component-1', NEXT_SOURCE, { bodies: [body()] });
    expect([plan?.matchedCount, plan?.unmatchedCount]).toEqual([1, 0]);
  });

  it('面の通し番号が変わっても指紋で新しい番号へ直す', () => {
    const plan = planReplacement(document(), 'component-1', NEXT_SOURCE, { bodies: [body(7)] });
    expect(plan?.after.mates[0].a).toMatchObject({ kind: 'subShape', ref: { index: 7 } });
  });

  it('面が消えたときは合致を消さず未解決として数える', () => {
    const before = document();
    const plan = planReplacement(before, 'component-1', NEXT_SOURCE, { bodies: [body(0, false)] });
    expect(plan?.unmatchedCount).toBe(1);
    expect(plan?.unresolvedIds).toEqual(['mate-1']);
    expect(plan?.after.mates[0].a).toEqual(before.mates[0].a);
  });

  it('原点の合致は形が無くても保てる', () => {
    const plan = planReplacement(document(originTarget('component-1')), 'component-1', NEXT_SOURCE, { bodies: [] });
    expect([plan?.matchedCount, plan?.unmatchedCount]).toEqual([1, 0]);
  });

  it('対象でない合致は予告の本数に含めない', () => {
    const plan = planReplacement(document(faceTarget('component-2')), 'component-1', NEXT_SOURCE, { bodies: [] });
    expect(plan?.affectedCount).toBe(0);
  });

  it('ジョイントも同じ経路で選び直す', () => {
    const before: AssemblyDocument = {
      ...document(), mates: [], joints: [{
        id: 'joint-1', name: '回転1', kind: 'revolute',
        a: faceTarget('component-1'), b: originTarget('component-2'),
        minValue: null, maxValue: null, suppressed: false,
      }],
    };
    const plan = planReplacement(before, 'component-1', NEXT_SOURCE, { bodies: [body(4)] });
    expect(plan?.after.joints[0].a).toMatchObject({ kind: 'subShape', ref: { index: 4 } });
    expect(plan?.matchedCount).toBe(1);
  });

  it('予告の合計は影響を受ける合致とジョイントの本数に一致する', () => {
    const before = document();
    const withJoint: AssemblyDocument = {
      ...before,
      joints: [{
        id: 'joint-1', name: '回転1', kind: 'revolute', a: faceTarget('component-1'),
        b: originTarget('component-2'), minValue: null, maxValue: null, suppressed: false,
      }],
    };
    const plan = planReplacement(withJoint, 'component-1', NEXT_SOURCE, { bodies: [] });
    expect((plan?.matchedCount ?? 0) + (plan?.unmatchedCount ?? 0)).toBe(2);
  });

  it('applyReplacementは予告した文書をそのまま確定する', () => {
    const plan = planReplacement(document(), 'component-1', NEXT_SOURCE, { bodies: [body()] });
    if (plan === null) throw new Error('置換計画ができなかった');
    expect(applyReplacement(plan)).toBe(plan.after);
  });

  it('Undo用に置換前の文書を1個だけ保持する', () => {
    const before = document();
    const plan = planReplacement(before, 'component-1', NEXT_SOURCE, { bodies: [body()] });
    expect(plan?.before).toBe(before);
  });

  it('同じ入力から同じ予告と文書ができる', () => {
    const before = document();
    const first = planReplacement(before, 'component-1', NEXT_SOURCE, { bodies: [body(8)] });
    const second = planReplacement(before, 'component-1', NEXT_SOURCE, { bodies: [body(8)] });
    expect(first).toEqual(second);
  });

  it('合致10本の選び直しは1秒以内', () => {
    const base = document();
    const assembly: AssemblyDocument = {
      ...base,
      mates: Array.from({ length: 10 }, (_, index) => ({
        ...base.mates[0], id: `mate-${index + 1}`, name: `合致${index + 1}`,
      })),
    };
    const started = performance.now();
    const plan = planReplacement(assembly, 'component-1', NEXT_SOURCE, { bodies: [body(9)] });
    expect(plan?.matchedCount).toBe(10);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
