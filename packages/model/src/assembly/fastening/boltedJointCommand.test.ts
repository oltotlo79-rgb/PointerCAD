import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry } from '../../kernelBridge.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { HoleFeature, PartDocument, ThreadHoleFeature } from '../../part/types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { threadMinorDiameter } from '../../thread/metricThread.js';
import { addComponent, createComponentFor, moveComponent, replaceComponent, setFixed } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { joinRigidGroup } from '../rigidGroups.js';
import type { AssemblyComponent, AssemblyDocument, Mate, Placement } from '../types.js';
import type { FaceResolution, FasteningGeometryContext, FasteningHolePick } from './bindHoleSelection.js';
import { commitBoltedJoint, previewBoltedJoint, type BoltedJointChoices } from './boltedJointCommand.js';
import type { BoltedJointPlan, BoltedJointPlanResult } from './types.js';

/*
 * 板A: 部品の z=0 の面から −Z へ厚さ10、直径9 の通し穴(中心 x=20, y=10)。
 * 板B: 部品の z=0 の面から +Z へ M8 の止まりねじ穴(下穴深さ20、ねじ部16)。
 * 面の幾何は形状計算の代わりに、下の表から独立に与える(穴の面積 = 2πr·長さ)。
 * 期待する配置・長さは手で求めた値。呼び長さの「確認済み」候補は検査用の入力で JIS の値ではない。
 */

const HALF = Math.SQRT1_2;
const DRILL = threadMinorDiameter(8, 1.25);
const REVISIONS = new Map([['plateA', 'rev-a'], ['plateB', 'rev-b']]);

function ref(bodyFeatureId: string, index: number): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
}

function value(n: number) { return expressionValueFromNumber(n); }

function plateA(): PartDocument {
  const hole: HoleFeature = {
    id: 'hole-1', name: '穴1', suppressed: false, kind: 'hole', targetFeatureId: 'extrude-1', face: ref('extrude-1', 0),
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }], diameter: value(9), depth: { kind: 'through' },
    tiltAngle: value(0), tiltAzimuth: value(0),
  };
  return appendSolid(createEmptyPartDocument(), hole);
}

function plateB(): PartDocument {
  const hole: ThreadHoleFeature = {
    id: 'threadHole-1', name: 'ねじ穴1', suppressed: false, kind: 'threadHole', targetFeatureId: 'extrude-1',
    face: ref('extrude-1', 0), centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }], designation: 'M8',
    series: 'coarse', pitch: value(1.25), drillDiameter: value(DRILL), depth: { kind: 'blind', depth: value(20) },
    threadLength: value(16), representation: 'simplified', tiltAngle: value(0), tiltAzimuth: value(0),
  };
  return appendSolid(createEmptyPartDocument(), hole);
}

function cylinder(center: Vec3, radius: number, length: number): MateSubShapeGeometry {
  return { kind: 'face', surfaceKind: 'cylinder', area: 2 * Math.PI * radius * length, position: center,
    axis: [0, 0, 1], axisOrigin: center, cylinderSpan: [-length / 2, length / 2], radius };
}

function plane(position: Vec3): MateSubShapeGeometry {
  return { kind: 'face', surfaceKind: 'plane', area: 400, position, axis: [0, 0, 1], radius: null };
}

/** 部品ごとの面の表。index 1 が穴の円筒面、2 が合わせ面。 */
const FACES: Readonly<Record<string, Readonly<Record<number, MateSubShapeGeometry>>>> = {
  plateA: { 1: cylinder([20, 10, -5], 4.5, 10), 2: plane([20, 10, 0]) },
  plateB: { 1: cylinder([0, 0, 10], DRILL / 2, 20), 2: plane([0, 0, 0]) },
};

function placement(position: Vec3, rotation: readonly [number, number, number, number]): Placement {
  return { position: [value(position[0]), value(position[1]), value(position[2])], rotation };
}

function assembly(bPlacement: Placement): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 0, 0], [0, 0, 0, 1]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: bPlacement }));
}

function partRefOf(component: AssemblyComponent): string {
  return component.source.kind === 'part' ? component.source.partRef : '';
}

/** kernel が各板の下穴の壁(index 1)に付ける今の由来。中心は文書の点 point-1 と同じ生成元。 */
const WALL_FEATURES: Readonly<Record<string, string>> = { plateA: 'hole-1', plateB: 'threadHole-1' };

function context(document: AssemblyDocument, faces = FACES, revisions = REVISIONS): FasteningGeometryContext {
  return {
    document, partRevisions: revisions,
    partDocument: (component) => (partRefOf(component) === 'plateA' ? plateA() : partRefOf(component) === 'plateB' ? plateB() : null),
    resolveFace: (component, reference): FaceResolution => {
      const geometry = faces[partRefOf(component)]?.[reference.index];
      if (geometry === undefined) return { status: 'missing' };
      const featureId = reference.index === 1 ? WALL_FEATURES[partRefOf(component)] : undefined;
      return { status: 'matched', geometry, wall: featureId === undefined ? { status: 'unnamed' } : { status: 'hole', origin: {
        kind: 'hole-face', featureId, center: { sketchId: 'sketch-1', producer: { kind: 'point', featureId: 'point-1' } },
        placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } };
    },
  };
}

const PICK_A: FasteningHolePick = { componentId: 'component-1', holeFeatureId: 'hole-1', holeFace: ref('hole-1', 1), matingFace: ref('hole-1', 2) };
const PICK_B: FasteningHolePick = { componentId: 'component-2', holeFeatureId: 'threadHole-1', holeFace: ref('threadHole-1', 1), matingFace: ref('threadHole-1', 2) };

const CHOICES: BoltedJointChoices = {
  dimensionSeries: 'annexJA', engagement: 12, blindBottomClearance: 2, headWashers: [], nutWashers: [],
  lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [20, 22, 30], basis: 'perDiameterEvidence',
    verified: true, source: 'test fixture (not a JIS value)' }],
};

// 板B は Y 軸まわりに 90° 回して (100,0,0) に置いた(部品の +Z は組立の +X)。
const TILTED_B = placement([100, 0, 0], [0, HALF, 0, HALF]);

function planned(result: BoltedJointPlanResult): BoltedJointPlan {
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function expectPlacement(actual: Placement | undefined, position: Vec3, rotation: readonly number[]): void {
  actual?.position.forEach((entry, index) => expect(entry.value).toBeCloseTo(position[index] ?? NaN, 9));
  actual?.rotation.forEach((entry, index) => expect(entry).toBeCloseTo(rotation[index] ?? NaN, 12));
  expect(actual).toBeDefined();
}

describe('選んだ穴を現在の形へ結び付けて締結する', () => {
  it('適合する既存合致を保存し、予告後に矛盾する合致が増えたら確定を拒否する', () => {
    const mate: Mate = { id: 'mate-1', name: 'distance', kind: 'distance', suppressed: false, flipped: false, value: value(0),
      a: { kind: 'origin', componentId: 'component-2', element: 'xy' },
      b: { kind: 'origin', componentId: 'component-1', element: 'xy' } };
    const document = { ...assembly(TILTED_B), mates: [mate] };
    const plan = planned(previewBoltedJoint(context(document), PICK_A, PICK_B, CHOICES));
    const accepted = commitBoltedJoint(context(document), PICK_A, PICK_B, CHOICES, plan);
    expect(accepted.ok).toBe(true);
    expect(accepted.document.mates).toEqual([mate]);
    const changed = { ...document, mates: [{ ...mate, value: value(10) }] };
    const rejected = commitBoltedJoint(context(changed), PICK_A, PICK_B, CHOICES, plan);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? [] : rejected.rejections).toMatchObject([{ code: 'existingConstraintConflict' }]);
    expect(rejected.document).toBe(changed);
  });

  it('離れて傾いた板Bを板Aの穴へ合わせ、ボルトを足して 3 つを 1 つの組にする', () => {
    const document = assembly(TILTED_B);
    const before = JSON.stringify(document);
    const plan = planned(previewBoltedJoint(context(document), PICK_A, PICK_B, CHOICES));
    // 締め付け10、ねじ込み12 → 22 以上、底のすきま2 → 10+14=24 以下 → 22。重なりは先端12mm。
    expect([plan.configuration, plan.boltLength]).toEqual(['tappedBlind', 22]);
    // 全周の軸方向範囲から板厚を読み、倍精度の丸めの範囲で比べる。
    expect(plan.engagedLength).toBeCloseTo(12, 9);
    expect(plan.penetration).toBeCloseTo(12, 9);
    expect(plan.protrusion).toBeNull();
    expect(JSON.stringify(document)).toBe(before);
    const result = commitBoltedJoint(context(document), PICK_A, PICK_B, CHOICES, plan);
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    expect(JSON.stringify(document)).toBe(before);
    const [a, b, bolt] = result.document.components;
    // 板Bの +Z(組立の +X)を +Z へ戻す回転は Y 軸まわり −90°。元の +90° と打ち消して向きは恒等。
    // 板Bのねじ穴の入口(部品の原点)は板Aの入口 (20,10,0) に来る。
    expectPlacement(b?.placement, [20, 10, 0], [0, 0, 0, 1]);
    // ボルトの首下は板Aの外面 z=−10、+Z は板Bへ向かう +Z。
    expectPlacement(bolt?.placement, [20, 10, -10], [0, 0, 0, 1]);
    expect(a?.placement).toEqual(document.components[0]?.placement);
    expect(result.document.components.map((component) => component.rigidGroupId)).toEqual(['fastening-1', 'fastening-1', 'fastening-1']);
    expect(result.document.components.map((component) => component.fixed)).toEqual([true, false, false]);
  });

  it('予告の後に版・配置が変わったら足さずに元の文書を返す', () => {
    const document = assembly(TILTED_B);
    const plan = planned(previewBoltedJoint(context(document), PICK_A, PICK_B, CHOICES));
    const revised = commitBoltedJoint(context(document, FACES, new Map([['plateA', 'rev-a'], ['plateB', 'rev-b2']])),
      PICK_A, PICK_B, CHOICES, plan);
    expect(revised.ok ? [] : revised.rejections.map((entry) => entry.code)).toEqual(['staleSource']);
    expect(revised.document).toBe(document);
    const moved = moveComponent(document, 'component-2', placement([101, 0, 0], [0, HALF, 0, HALF]));
    const afterMove = commitBoltedJoint(context(moved), PICK_A, PICK_B, CHOICES, plan);
    expect(afterMove.ok ? null : afterMove.rejections[0]?.detail.reason).toBe('previewChanged');
    expect(afterMove.document).toBe(moved);
  });

  it('壊れた配置・空の版・形の不一致を、文書を変えずに断る', () => {
    const document = assembly(TILTED_B);
    const component = document.components[1];
    if (component === undefined) throw new Error('fixture');
    const broken = replaceComponent(document, 'component-2', { ...component,
      placement: { position: [value(Number.NaN), value(0), value(0)], rotation: [0, HALF, 0, HALF] } });
    const codes = (result: BoltedJointPlanResult) => (result.ok ? [] : result.rejections.map((entry) => entry.code));
    expect(codes(previewBoltedJoint(context(broken), PICK_A, PICK_B, CHOICES))).toEqual(['invalidPlacement']);
    const zeroRotation = replaceComponent(document, 'component-2', { ...component, placement: { ...component.placement, rotation: [0, 0, 0, 0] } });
    expect(codes(previewBoltedJoint(context(zeroRotation), PICK_A, PICK_B, CHOICES))).toEqual(['invalidPlacement']);
    expect(codes(previewBoltedJoint(context(document, FACES, new Map([['plateA', ''], ['plateB', 'rev-b']])), PICK_A, PICK_B, CHOICES)))
      .toEqual(['missingSourceRevision']);
    const shifted = { ...FACES, plateA: { 1: cylinder([20, 10, -6], 4.5, 10), 2: plane([20, 10, 0]) } };
    expect(codes(previewBoltedJoint(context(document, shifted), PICK_A, PICK_B, CHOICES))).toEqual(['holeNotOnMatingFace']);
    const wrongSize = { ...FACES, plateA: { 1: cylinder([20, 10, -5], 5, 10), 2: plane([20, 10, 0]) } };
    expect(codes(previewBoltedJoint(context(document, wrongSize), PICK_A, PICK_B, CHOICES))).toEqual(['holeFaceMismatch']);
    expect(codes(previewBoltedJoint(context(document, { ...FACES, plateB: {} }), PICK_A, PICK_B, CHOICES))).toEqual(['holeFaceMissing']);
    expect(codes(previewBoltedJoint(context(document), PICK_A, { ...PICK_B, holeFeatureId: 'hole-9' }, CHOICES))).toEqual(['holeFeatureMissing']);
  });
});

describe('互いに固定した組', () => {
  function fastened(): AssemblyDocument {
    const document = assembly(TILTED_B);
    const plan = planned(previewBoltedJoint(context(document), PICK_A, PICK_B, CHOICES));
    const result = commitBoltedJoint(context(document), PICK_A, PICK_B, CHOICES, plan);
    if (!result.ok) throw new Error('commit failed');
    return result.document;
  }

  it('組の中に固定の部品があれば、他の部品を動かしても何もしない', () => {
    const document = fastened();
    expect(moveComponent(document, 'component-2', placement([0, 0, 50], [0, 0, 0, 1]))).toBe(document);
  });

  it('固定を外すと、1 つを動かした変位と同じ剛体変位で組の全部品が動く', () => {
    const document = setFixed(fastened(), 'component-1', false);
    // 板Aを Z 軸まわり 90° 回し (5,0,0) へ動かす。点 p は R·p + (5,0,0) へ写る(R: x→y, y→−x)。
    const moved = moveComponent(document, 'component-1', placement([5, 0, 0], [0, 0, HALF, HALF]));
    const [, b, bolt] = moved.components;
    // 板B: 元 (20,10,0) → (−10,20,0)+(5,0,0)。ボルト: 元 (20,10,−10) → (−10,20,−10)+(5,0,0)。
    expectPlacement(b?.placement, [-5, 20, 0], [0, 0, HALF, HALF]);
    expectPlacement(bolt?.placement, [-5, 20, -10], [0, 0, HALF, HALF]);
  });

  it('既にある組どうしをつなぐと 1 つの組になる', () => {
    let document = createAssemblyDocument('組立1');
    for (const partRef of ['p1', 'p2', 'p3', 'p4']) {
      document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }, {}));
    }
    document = joinRigidGroup(joinRigidGroup(document, ['component-1', 'component-2']), ['component-3', 'component-4']);
    expect(document.components.map((component) => component.rigidGroupId)).toEqual(['fastening-1', 'fastening-1', 'fastening-2', 'fastening-2']);
    document = joinRigidGroup(document, ['component-2', 'component-3']);
    expect(document.components.map((component) => component.rigidGroupId)).toEqual(['fastening-1', 'fastening-1', 'fastening-1', 'fastening-1']);
  });
});
