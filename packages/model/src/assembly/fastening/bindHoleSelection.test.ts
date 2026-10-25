import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type {
  CurrentOriginIndex, HoleFaceOrigin, HoleThreadGrooveOrigin, OriginBinding, SubShapeOrigin,
} from '../../geometry/subShapeOrigin.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry, SolidBody } from '../../kernelBridge.js';
import { resolveSubShapeReference, type SubShapeReferenceResolution } from '../../kernelBridge/referenceResolution.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { HoleFeature, ThreadHoleFeature } from '../../part/types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import {
  bindHoleSelection, faceResolverFromBodies, type FaceResolution, type FasteningGeometryContext, type FasteningHolePick,
  holeFeatureForSelection, holeWallOriginAt,
  type HoleWallOrigin, modeledThreadEvidence, type ModeledThreadEvidence, modeledThreadGroupPickAt,
  modeledThreadResolverFromBodies, modeledThreadWallAt,
} from './bindHoleSelection.js';

function reference(index: number): SubShapeRef {
  return { bodyFeatureId: 'hole', index, fingerprint: { kind: 'face', surfaceKind: 'plane',
    area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
}

const PICK: FasteningHolePick = {
  componentId: 'component-1', holeFeatureId: 'hole', holeFace: reference(0), matingFace: reference(1),
};
const FULL: MateSubShapeGeometry = {
  kind: 'face', surfaceKind: 'cylinder', area: 100 * Math.PI, position: [0, 0, 5],
  axis: [0, 0, 1], axisOrigin: [0, 0, 0], cylinderSpan: [0, 10], radius: 5,
};

/** kernel の makeHole が下穴の壁に付ける由来(bore/wall)。中心は文書の点と同じ生成元。 */
function boreWall(featureId: string, pointFeatureId = 'center'): HoleFaceOrigin {
  return { kind: 'hole-face', featureId, center: { sketchId: 'sketch', producer: { kind: 'point', featureId: pointFeatureId } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' };
}
const WALL: HoleWallOrigin = { status: 'hole', origin: boreWall('hole') };

function context(cylinder: MateSubShapeGeometry, point: Vec3 = [0, 0, 0], normal: Vec3 = [0, 0, 1],
  wall: HoleWallOrigin = WALL, extra: readonly HoleFeature[] = [], extraFirst = false): FasteningGeometryContext {
  let document = createAssemblyDocument('穴の境界');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plate' }));
  const feature: HoleFeature = {
    id: 'hole', name: '穴', suppressed: false, kind: 'hole', targetFeatureId: 'plate', face: reference(1),
    centers: [{ sketchId: 'sketch', pointFeatureId: 'center' }], diameter: expressionValueFromNumber(10),
    depth: { kind: 'through' }, tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
  };
  const ordered = extraFirst ? [...extra, feature] : [feature, ...extra];
  const part = ordered.reduce((document, solid) => appendSolid(document, solid), createEmptyPartDocument());
  return { document, partRevisions: new Map([['plate', 'rev1']]), partDocument: () => part,
    resolveFace: (_component, ref) => ref.index === 0 ? { status: 'matched', geometry: cylinder, wall }
      : { status: 'matched', wall: { status: 'unnamed' }, geometry: {
        kind: 'face', surfaceKind: 'plane', area: 100, position: point, axis: normal, radius: null,
      } },
  };
}

describe('全周の現在円筒範囲で穴を結ぶ', () => {
  it('通常の穴は長さ10と実際の入口を返し、旧保存参照を変更しない', () => {
    const current = context(FULL), before = JSON.stringify([PICK, current.document]);
    expect(bindHoleSelection(current, PICK)).toMatchObject({ axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1],
      hole: { kind: 'clearance', diameter: 10, length: 10 } });
    expect(JSON.stringify([PICK, current.document])).toBe(before);
  });

  it('半円筒の重心と半分の面積から作った偽の端z=2.5を拒否する', () => {
    const partial: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', radius: 5,
      area: 50 * Math.PI, position: [0, 10 / Math.PI, 5], axis: [0, 0, 1], axisOrigin: [0, 0, 0] };
    expect(bindHoleSelection(context(partial, [0, 0, 2.5]), PICK)).toMatchObject({ code: 'holeFaceMissing',
      detail: { reason: 'uncertifiedCylinderBand' } });
  });

  it('対称切欠きで重心が軸上でも、面積由来の偽の端を採らない', () => {
    const partial: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', radius: 5,
      area: 80 * Math.PI, position: [0, 0, 5], axis: [0, 0, 1], axisOrigin: [0, 0, 0] };
    expect(bindHoleSelection(context(partial, [0, 0, 1]), PICK)).toMatchObject({ code: 'holeFaceMissing' });
  });

  it('解析軸上点と確認済範囲を使い、位置指紋や面積を寸法へ再解釈しない', () => {
    expect(bindHoleSelection(context({ ...FULL, position: [40, 50, 60], area: 50 * Math.PI }), PICK))
      .toMatchObject({ axisOrigin: [0, 0, 0], hole: { length: 10 } });
  });

  it('回転・移動済みの解析軸と反転面の範囲は同じ物理的入口を返す', () => {
    for (const reversed of [false, true]) {
      const axis: Vec3 = reversed ? [0, 1, 0] : [0, -1, 0];
      const span: readonly [number, number] = reversed ? [-10, 0] : [0, 10];
      const cylinder: MateSubShapeGeometry = { ...FULL, position: [11, 8, 17],
        axisOrigin: [11, 13, 17], axis, cylinderSpan: span };
      const result = bindHoleSelection(context(cylinder, [11, 13, 17], [0, 1, 0]), PICK);
      if ('code' in result) throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({ axisOrigin: [11, 13, 17], hole: { length: 10 } });
      result.axisDirection.forEach((value, index) => expect(Math.abs(value - [0, -1, 0][index])).toBeLessThanOrEqual(1e-12));
    }
  });

  it('円筒の内部を横切る平面は合わせ面にしない', () => {
    expect(bindHoleSelection(context(FULL, [0, 0, 2.5]), PICK)).toMatchObject({ code: 'holeNotOnMatingFace' });
    expect(bindHoleSelection(context(FULL, [0, 0, 0], [1, 0, 0]), PICK)).toMatchObject({ code: 'faceAxisMismatch' });
  });

  it('古い現在形状に解析点または全周範囲が無ければ再計算を要する', () => {
    const withoutOrigin: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', area: 100 * Math.PI,
      position: [0, 0, 5], axis: [0, 0, 1], radius: 5, cylinderSpan: [0, 10] };
    const withoutSpan: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', area: 100 * Math.PI,
      position: [0, 0, 5], axis: [0, 0, 1], radius: 5, axisOrigin: [0, 0, 0] };
    for (const cylinder of [withoutOrigin, withoutSpan]) {
      expect(bindHoleSelection(context(cylinder), PICK)).toMatchObject({ code: 'holeFaceMissing',
        detail: { reason: 'uncertifiedCylinderBand' } });
    }
  });

  it.each<readonly [number, number]>([[NaN, 10], [0, Infinity], [10, 0], [0, 0], [-1e308, 1e308]])(
    '不正な範囲 %s..%s を拒否する', (first, last) => {
      expect(bindHoleSelection(context({ ...FULL, cylinderSpan: [first, last] }), PICK)).toMatchObject({ code: 'holeFaceMissing' });
    },
  );
});

/** 同じ径・同じ面の別の穴(離れた位置)。径だけでは区別できない。 */
const SECOND: HoleFeature = {
  id: 'hole-b', name: '穴2', suppressed: false, kind: 'hole', targetFeatureId: 'plate', face: reference(1),
  centers: [{ sketchId: 'sketch', pointFeatureId: 'center-b' }], diameter: expressionValueFromNumber(10),
  depth: { kind: 'through' }, tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
};

function tracked(...bindings: OriginBinding[]): CurrentOriginIndex {
  return { version: 1, state: 'tracked', bindings };
}

describe('選んだ壁の今の由来でフィーチャーを決める(径だけで決めない)', () => {
  it('離れた同径の2穴は、選んだ壁の由来ごとに別のフィーチャーになる(順を入れ替えても同じ)', () => {
    for (const extraFirst of [false, true]) {
      for (const featureId of ['hole', 'hole-b']) {
        const current = context(FULL, [0, 0, 0], [0, 0, 1], { status: 'hole', origin: boreWall(featureId) }, [SECOND], extraFirst);
        const component = current.document.components[0];
        if (component === undefined) throw new Error('component');
        expect(holeFeatureForSelection(current, component, PICK.holeFace)).toBe(featureId);
        expect(bindHoleSelection(current, { ...PICK, holeFeatureId: featureId })).toMatchObject({ holeFeatureId: featureId });
      }
    }
  });

  it('明示の id が別の穴の壁を指していれば、残る候補が1つでも断る', () => {
    // 文書に同径の穴は 'hole' だけ。選んだ壁は文書に無い生成元のもの(旧版は径だけで通していた)。
    const lone = context(FULL, [0, 0, 0], [0, 0, 1], { status: 'hole', origin: boreWall('other-feature') });
    expect(bindHoleSelection(lone, PICK)).toMatchObject({ code: 'holeFaceMismatch',
      detail: { reason: 'holeIdentityMismatch', holeFeatureId: 'hole', originFeatureId: 'other-feature' } });
    const two = context(FULL, [0, 0, 0], [0, 0, 1], { status: 'hole', origin: boreWall('hole-b') }, [SECOND]);
    expect(bindHoleSelection(two, PICK)).toMatchObject({ code: 'holeFaceMismatch', detail: { reason: 'holeIdentityMismatch' } });
  });

  it.each<Exclude<HoleWallOrigin['status'], 'hole'>>(['untracked', 'unnamed', 'ambiguous', 'notHoleWall'])(
    '由来が %s なら形が合っても認めない(形だけの代わりの照合をしない)', (status) => {
      const current = context(FULL, [0, 0, 0], [0, 0, 1], { status });
      expect(bindHoleSelection(current, PICK)).toMatchObject({ code: 'holeFaceMismatch',
        detail: { reason: 'holeIdentityUnproven', origin: status } });
      const component = current.document.components[0];
      if (component === undefined) throw new Error('component');
      expect(holeFeatureForSelection(current, component, PICK.holeFace)).toBeNull();
    },
  );
});

describe('今の番地から下穴の壁の由来を引く', () => {
  const face = (index: number) => ({ kind: 'face', index }) as const;
  it('番地を主張する unique な bore/wall だけを採る', () => {
    expect(holeWallOriginAt(tracked({ origin: { version: 1, shapeKind: 'face', identity: boreWall('hole') },
      state: 'unique', current: face(3) }), 3)).toEqual({ status: 'hole', origin: boreWall('hole') });
  });
  it('向きだけが違う2つの穴の壁が同じ番地を主張すれば曖昧(順で選ばない)', () => {
    const origins = tracked(
      { origin: { version: 1, shapeKind: 'face', identity: boreWall('hole') }, state: 'unique', current: face(3) },
      { origin: { version: 1, shapeKind: 'face', identity: boreWall('hole-b') }, state: 'unique', current: face(3) },
    );
    expect(holeWallOriginAt(origins, 3)).toEqual({ status: 'ambiguous' });
  });
  it('分かれた・まとまった面、底・入口の面、無い表は採らない', () => {
    const identity = boreWall('hole');
    expect(holeWallOriginAt(tracked({ origin: { version: 1, shapeKind: 'face', identity }, state: 'split',
      candidates: [face(3), face(4)] }), 3)).toEqual({ status: 'ambiguous' });
    expect(holeWallOriginAt(tracked({ origin: { version: 1, shapeKind: 'face', identity }, state: 'merged', current: face(3),
      coOrigins: [{ version: 1, shapeKind: 'face', identity }, { version: 1, shapeKind: 'face', identity: boreWall('hole-b') }] }), 3))
      .toEqual({ status: 'ambiguous' });
    expect(holeWallOriginAt(tracked({ origin: { version: 1, shapeKind: 'face', identity: { ...identity, role: 'floor' } },
      state: 'unique', current: face(3) }), 3)).toEqual({ status: 'notHoleWall' });
    expect(holeWallOriginAt(tracked(), 3)).toEqual({ status: 'unnamed' });
    expect(holeWallOriginAt({ version: 1, state: 'untracked', reason: 'limit' }, 3)).toEqual({ status: 'untracked' });
    expect(holeWallOriginAt(undefined, 3)).toEqual({ status: 'untracked' });
  });
});

describe('実らせんの壁の小片と自分の溝の由来(明示経路だけ)', () => {
  const face = (index: number) => ({ kind: 'face', index }) as const;
  const groove = (wall: HoleFaceOrigin): HoleThreadGrooveOrigin => ({ ...wall, stage: 'thread', role: 'groove' });
  const wallSplit = (identity: HoleFaceOrigin, indices: readonly [number, number, ...number[]]): OriginBinding => ({
    origin: { version: 1, shapeKind: 'face', identity }, state: 'split',
    candidates: [face(indices[0]), face(indices[1]), ...indices.slice(2).map(face)] });
  const grooveSplit = (identity: HoleThreadGrooveOrigin, indices: readonly [number, number, ...number[]]): OriginBinding => ({
    origin: { version: 1, shapeKind: 'face', identity }, state: 'split',
    candidates: [face(indices[0]), face(indices[1]), ...indices.slice(2).map(face)] });
  const wall = boreWall('thread');

  it('分かれた bore/wall と同じ穴の溝がそろえば、全ての小片と溝の面を返す(普通の経路は今までどおり断る)', () => {
    const origins = tracked(wallSplit(wall, [7, 8, 11]), grooveSplit(groove(wall), [9, 10]));
    expect(modeledThreadWallAt(origins, 8)).toEqual({ status: 'candidate', origin: wall, walls: [7, 8, 11], grooves: [9, 10] });
    expect(holeWallOriginAt(origins, 8)).toEqual({ status: 'ambiguous' });
  });

  it('同じフィーチャーの別の穴(中心・配置が違う)の溝は拾わない', () => {
    const otherCenter = groove(boreWall('thread', 'other-center'));
    const otherPlacement: HoleThreadGrooveOrigin = { ...groove(wall), placement: { kind: 'linear', step: 1 } };
    for (const other of [otherCenter, otherPlacement]) {
      expect(modeledThreadWallAt(tracked(wallSplit(wall, [7, 8]), grooveSplit(other, [9, 10])), 8))
        .toEqual({ status: 'notThreadWall' });
    }
  });

  it('溝が無い・2つある・消えた/名前なし、壁が unique・底・入口なら断る', () => {
    const own = grooveSplit(groove(wall), [9, 10]);
    const cases: readonly CurrentOriginIndex[] = [
      tracked(wallSplit(wall, [7, 8])),
      tracked(wallSplit(wall, [7, 8]), own, grooveSplit(groove(wall), [12, 13])),
      tracked(wallSplit(wall, [7, 8]), { origin: own.origin, state: 'missing', reason: 'deleted' }),
      tracked(wallSplit(wall, [7, 8]), { origin: own.origin, state: 'untracked', reason: 'unsupported-producer' }),
      tracked(wallSplit({ ...wall, role: 'floor' }, [7, 8]), own),
      tracked(wallSplit({ ...wall, stage: 'counterbore' }, [7, 8]), own),
    ];
    for (const origins of cases) expect(modeledThreadWallAt(origins, 8)).toEqual({ status: 'notThreadWall' });
    expect(modeledThreadWallAt(tracked({ origin: { version: 1, shapeKind: 'face', identity: wall }, state: 'unique',
      current: face(8) }, own), 8)).toEqual({ status: 'ambiguous' });
  });

  it('壁か溝の面を別の binding も主張する(後の加工の面・merged)なら曖昧、表が無ければ untracked', () => {
    const later: OriginBinding = { origin: { version: 1, shapeKind: 'face', identity: boreWall('later-cut') },
      state: 'unique', current: face(10) };
    expect(modeledThreadWallAt(tracked(wallSplit(wall, [7, 8]), grooveSplit(groove(wall), [9, 10]), later), 8))
      .toEqual({ status: 'ambiguous' });
    expect(modeledThreadWallAt(tracked(wallSplit(wall, [7, 8]), wallSplit(boreWall('later-cut'), [8, 12]),
      grooveSplit(groove(wall), [9, 10])), 8)).toEqual({ status: 'ambiguous' });
    expect(modeledThreadWallAt(tracked(), 8)).toEqual({ status: 'unnamed' });
    expect(modeledThreadWallAt({ version: 1, state: 'untracked', reason: 'limit' }, 8)).toEqual({ status: 'untracked' });
    expect(modeledThreadWallAt(undefined, 8)).toEqual({ status: 'untracked' });
  });
});

describe('実らせんの壁の今の形の証拠(隣の面・すき間・両端)', () => {
  const face = (index: number) => ({ kind: 'face', index }) as const;
  const wall = boreWall('thread');
  const grooveOrigin: HoleThreadGrooveOrigin = { ...wall, stage: 'thread', role: 'groove' };
  const cylinder = (index: number, extent: readonly [number, number], adjacentFaces?: readonly number[], radius = 2.5) => ({
    index, surfaceKind: 'cylinder' as const, area: 10, centroid: [0, 0, 14] as Vec3, axis: [0, 0, 1] as Vec3,
    axisOrigin: [0, 0, 20] as Vec3, cylinderSpan: null, cylinderAxialExtent: extent, radius, triangleOffset: 0, triangleCount: 1,
    ...(adjacentFaces === undefined ? {} : { adjacentFaces }) });
  const other = (index: number, adjacentFaces: readonly number[]) => ({ index, surfaceKind: 'other' as const, area: 1,
    centroid: [2, 0, 14] as Vec3, axis: null, radius: null, triangleOffset: 0, triangleCount: 1, adjacentFaces });
  const plane = (index: number, z: number, axis: Vec3 = [0, 0, 1], adjacentFaces: readonly number[] = []) => ({ index,
    surfaceKind: 'plane' as const, area: 100, centroid: [5, 5, z] as Vec3, axis, radius: null, triangleOffset: 0, triangleCount: 1,
    adjacentFaces });
  const bare = (index: number, z: number) => ({ index, surfaceKind: 'plane' as const, area: 1, centroid: [2, 0, z] as Vec3,
    axis: [0, 1, 0] as Vec3, radius: null, triangleOffset: 0, triangleCount: 1 });
  type Face = ReturnType<typeof cylinder> | ReturnType<typeof other> | ReturnType<typeof plane> | ReturnType<typeof bare>;
  const origins = (groove: HoleThreadGrooveOrigin = grooveOrigin): CurrentOriginIndex => tracked(
    { origin: { version: 1, shapeKind: 'face', identity: wall }, state: 'split', candidates: [face(0), face(1)] },
    { origin: { version: 1, shapeKind: 'face', identity: groove }, state: 'unique', current: face(2) });
  // 壁 0 は z 8..15、壁 1 は z 14..20(重なってつながる)。溝 2。入口の平面 3(z 20)と底 4(z 8)。
  const faces = (overrides: Partial<Record<number, Face>> = {}): readonly Face[] => [
    cylinder(0, [-12, -5], [1, 2, 4]), cylinder(1, [-6, 0], [0, 2, 3]), other(2, [0, 1, 3]), plane(3, 20), plane(4, 8),
    plane(5, 14), other(6, [1]),
  ].map((entry, index) => overrides[index] ?? entry);
  const body = (list: readonly Face[], index: CurrentOriginIndex = origins()) => ({ origins: index, faces: list });
  const EVIDENCE: ModeledThreadEvidence = { origin: wall, radius: 2.5, axis: [0, 0, 1], span: [-12, 0] };

  it('閉じた鎖で両端が平面に接すれば、つながった範囲を返す(普通の経路は今までどおり断る)', () => {
    expect(modeledThreadEvidence(body(faces()), 1)).toEqual(EVIDENCE);
    expect(holeWallOriginAt(origins(), 1)).toEqual({ status: 'ambiguous' });
  });

  it('後からの窓・同じピッチの偽の溝・途中の平面が壁に接すれば断る', () => {
    for (const adjacent of [[0, 2, 3, 6], [0, 2, 3, 5]]) {
      expect(modeledThreadEvidence(body(faces({ 1: cylinder(1, [-6, 0], adjacent) })), 1)).toBeNull();
    }
    expect(modeledThreadEvidence(body(faces({ 2: other(2, [0, 1, 3, 6]) })), 1)).toBeNull();
  });

  it('溝の平面の端: 隣の一覧が無い、または溝の端だけに後の加工の面が接すれば断る(壁・範囲・両端は元のまま)', () => {
    expect(modeledThreadEvidence(body(faces({ 2: bare(2, 14) })), 1)).toBeNull();
    expect(modeledThreadEvidence(body(faces({ 2: plane(2, 14, [0, 1, 0], [0, 1, 6]) })), 1)).toBeNull();
    expect(modeledThreadEvidence(body(faces({ 2: plane(2, 14, [0, 1, 0], [0, 1, 3]) })), 1)).toEqual(EVIDENCE);
  });

  it('すき間・片方の端が無い・隣の一覧が無い・半径や軸の違いは断る(範囲の min/max だけで認めない)', () => {
    const cases: readonly Partial<Record<number, Face>>[] = [
      { 1: cylinder(1, [-4, 0], [0, 2, 3]) },
      { 0: cylinder(0, [-12, -5], [1, 2]) },
      { 1: cylinder(1, [-6, 0], [0, 2]) },
      { 0: cylinder(0, [-12, -5]) },
      { 0: cylinder(0, [-12, -5], [1, 2, 4], 3) },
      { 4: plane(4, 8, [1, 0, 0]) },
    ];
    for (const overrides of cases) expect(modeledThreadEvidence(body(faces(overrides)), 1)).toBeNull();
  });

  it('同じフィーチャーの別の穴の溝、溝の由来が無い表、表が無い時は断る', () => {
    const otherHole: HoleThreadGrooveOrigin = { ...grooveOrigin, placement: { kind: 'linear', step: 1 } };
    expect(modeledThreadEvidence(body(faces(), origins(otherHole)), 1)).toBeNull();
    expect(modeledThreadEvidence(body(faces(), tracked({ origin: { version: 1, shapeKind: 'face', identity: wall },
      state: 'split', candidates: [face(0), face(1)] })), 1)).toBeNull();
    expect(modeledThreadEvidence(body(faces(), { version: 1, state: 'untracked', reason: 'limit' }), 1)).toBeNull();
  });

  it('普通の穴のフィーチャーでは、証拠があっても部分の円筒で結ばない', () => {
    const PARTIAL: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', area: 50 * Math.PI, position: [0, 0, 5],
      axis: [0, 0, 1], axisOrigin: [0, 0, 0], radius: 5 };
    const base = context(PARTIAL);
    const withEvidence: FasteningGeometryContext = { ...base, resolveFace: (component, ref) => {
      const resolved = base.resolveFace(component, ref);
      return resolved.status === 'matched' && ref.index === 0
        ? { ...resolved, modeledThread: { ...EVIDENCE, radius: 5, span: [0, 10] } } : resolved;
    } };
    expect(bindHoleSelection(withEvidence, PICK)).toMatchObject({ code: 'holeFaceMissing' });
  });
});

describe('kernel から model へ渡る実際の SolidBody の形で実らせんの証拠を読む', () => {
  const wall = boreWall('thread');
  const grooveOrigin: HoleThreadGrooveOrigin = { ...wall, stage: 'thread', role: 'groove' };
  const wallFace = (index: number, extent: readonly [number, number], adjacentFaces: readonly number[]) => ({ index,
    surfaceKind: 'cylinder' as const, area: 10, centroid: [0, 0, 14] as Vec3, axis: [0, 0, 1] as Vec3, axisOrigin: [0, 0, 20] as Vec3,
    cylinderSpan: null, cylinderAxialExtent: extent, radius: 2.5, triangleOffset: 0, triangleCount: 0, adjacentFaces });
  const planeFace = (index: number, z: number, adjacentFaces: readonly number[]) => ({ index, surfaceKind: 'plane' as const,
    area: 100, centroid: [5, 5, z] as Vec3, axis: [0, 0, 1] as Vec3, radius: null, triangleOffset: 0, triangleCount: 0, adjacentFaces });
  const current: SolidBody = { featureId: 'plate', mesh: {
    positions: new Float32Array([0, 0, 0, 40, 30, 20]), normals: new Float32Array(),
    indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0,
  }, volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [],
    faces: [wallFace(0, [-12, -5], [1, 2, 4]), wallFace(1, [-6, 0], [0, 2, 3]),
      { index: 2, surfaceKind: 'other', area: 1, centroid: [2, 0, 14], axis: null, radius: null, triangleOffset: 0, triangleCount: 0,
        adjacentFaces: [0, 1, 3] }, planeFace(3, 20, [1, 2]), planeFace(4, 8, [0])],
    origins: { version: 1, state: 'tracked', bindings: [
      { origin: { version: 1, shapeKind: 'face', identity: wall }, state: 'split', candidates: [{ kind: 'face', index: 0 }, { kind: 'face', index: 1 }] },
      { origin: { version: 1, shapeKind: 'face', identity: grooveOrigin }, state: 'unique', current: { kind: 'face', index: 2 } },
    ] } };

  it('body.faces から証拠を作る。保存された壁の意味の参照は今も ambiguous で、指紋では救わない(残る選択の経路)', () => {
    expect(modeledThreadEvidence(current, 1)).toEqual({ origin: wall, radius: 2.5, axis: [0, 0, 1], span: [-12, 0] });
    expect(modeledThreadEvidence({ ...current, faces: current.faces.map((face) => face.index === 2
      ? { index: 2, surfaceKind: 'other' as const, area: 1, centroid: [2, 0, 14] as Vec3, axis: null, radius: null,
        triangleOffset: 0, triangleCount: 0 } : face) }, 1)).toBeNull();
    const saved: SubShapeRef = { bodyFeatureId: 'plate', index: 1, origin: { version: 1, shapeKind: 'face', identity: wall },
      fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 10, position: [0, 0, 14], axis: [0, 0, 1], radius: 2.5 } };
    const resolveFace = faceResolverFromBodies(() => [current], resolveSubShapeReference);
    const component = createComponentFor(createAssemblyDocument('結び付け'), { kind: 'part', partRef: 'plate' });
    expect(resolveFace(component, saved)).toEqual({ status: 'ambiguous' });
  });

  it('締結の組の選択: 当たった面から今の由来で組を作り、結び直しは同じ由来・同じボディ・今の一員の時だけ合う', () => {
    const component = createComponentFor(createAssemblyDocument('組'), { kind: 'part', partRef: 'plate' });
    const group = modeledThreadGroupPickAt(current, 1);
    expect(group).toEqual({ bodyFeatureId: 'plate', origin: wall, hitFaceIndex: 1 });
    expect(modeledThreadGroupPickAt(current, 3)).toBeNull();
    if (group === null) throw new Error('group');
    const resolve = modeledThreadResolverFromBodies(() => [current]);
    expect(resolve(component, group)).toEqual({ status: 'matched', axisOrigin: [0, 0, 20],
      evidence: { origin: wall, radius: 2.5, axis: [0, 0, 1], span: [-12, 0] } });
    expect(resolve(component, { ...group, hitFaceIndex: 0 })).toMatchObject({ status: 'matched' });
    const missing = [
      { ...group, origin: { ...wall, placement: { kind: 'linear', step: 1 } } },
      { ...group, bodyFeatureId: 'other-body' },
      { ...group, hitFaceIndex: 3 },
    ] as const;
    for (const stale of missing) expect(resolve(component, stale)).toEqual({ status: 'missing' });
    const damaged: SolidBody = { ...current, faces: current.faces.map((face) => face.index === 2
      ? { index: 2, surfaceKind: 'other' as const, area: 1, centroid: [2, 0, 14] as Vec3, axis: null, radius: null,
        triangleOffset: 0, triangleCount: 0 } : face) };
    expect(modeledThreadResolverFromBodies(() => [damaged])(component, group)).toEqual({ status: 'missing' });
  });

  it('無効なボディ: 初めから無効なら組を作らず、選んだ後に作り直しで無効になれば結び直さない(形と由来は同じでも)', () => {
    const component = createComponentFor(createAssemblyDocument('無効'), { kind: 'part', partRef: 'plate' });
    const invalid: SolidBody = { ...current, isValid: false };
    expect(modeledThreadGroupPickAt(invalid, 1)).toBeNull();
    const group = modeledThreadGroupPickAt(current, 1);
    if (group === null) throw new Error('group');
    expect(modeledThreadResolverFromBodies(() => [current])(component, group)).toMatchObject({ status: 'matched' });
    expect(modeledThreadResolverFromBodies(() => [invalid])(component, group)).toEqual({ status: 'missing' });
  });

  it('同じ id のボディが2つあれば、中身が同じでも、片方の証拠が違っても、どちらの順でも結び直さない', () => {
    const component = createComponentFor(createAssemblyDocument('重複'), { kind: 'part', partRef: 'plate' });
    const group = modeledThreadGroupPickAt(current, 1);
    if (group === null) throw new Error('group');
    const broken: SolidBody = { ...current, faces: current.faces.map((face) => face.index === 2
      ? { index: 2, surfaceKind: 'other' as const, area: 1, centroid: [2, 0, 14] as Vec3, axis: null, radius: null,
        triangleOffset: 0, triangleCount: 0 } : face) };
    for (const bodies of [[current, { ...current }], [current, broken], [broken, current]]) {
      expect(modeledThreadResolverFromBodies(() => bodies)(component, group)).toEqual({ status: 'missing' });
    }
    expect(modeledThreadResolverFromBodies(() => [current])(component, group)).toMatchObject({ status: 'matched' });
  });
});

describe('貫通のねじ穴の入口の面: 消費された元のボディだけを由来で今の穴のボディに結び直す', () => {
  const ENTRY_ORIGIN: SubShapeOrigin = { version: 1, shapeKind: 'face',
    identity: { kind: 'box-face', featureId: 'plate', role: 'top' } };
  /** フィーチャーの入口の面(加工前の板のボディ 'plate' の番地5)。 */
  const entryFace = (origin?: SubShapeOrigin): SubShapeRef => ({ ...reference(5), bodyFeatureId: 'plate',
    ...(origin === undefined ? {} : { origin }) });
  const plane = (z: number): FaceResolution => ({ status: 'matched', wall: { status: 'unnamed' }, geometry: {
    kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, z], axis: [0, 0, 1], radius: null } });
  const CONSUMED: FaceResolution = { status: 'missing', reason: 'body-missing' };

  /** 円筒 z0..10・合わせ面 z=0・ねじ部8の貫通のねじ穴。入口の面の直接と、穴のボディでの選び直しの結果を分けて返す。 */
  function threaded(face: SubShapeRef, direct: FaceResolution, rebound: FaceResolution) {
    let document = createAssemblyDocument('ねじ穴の入口');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plate' }));
    const feature: ThreadHoleFeature = {
      id: 'hole', name: 'ねじ穴', suppressed: false, kind: 'threadHole', targetFeatureId: 'plate', face,
      centers: [{ sketchId: 'sketch', pointFeatureId: 'center' }], designation: 'M12', series: 'coarse',
      pitch: expressionValueFromNumber(1.75), drillDiameter: expressionValueFromNumber(10), depth: { kind: 'through' },
      threadLength: expressionValueFromNumber(8), representation: 'simplified',
      tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
    };
    const part = appendSolid(createEmptyPartDocument(), feature);
    const faces = new Map<string, FaceResolution>([['plate:5', direct], ['hole:5', rebound],
      ['hole:0', { status: 'matched', geometry: FULL, wall: WALL }], ['hole:1', plane(0)]]);
    const calls: SubShapeRef[] = [];
    const current: FasteningGeometryContext = { document, partRevisions: new Map([['plate', 'rev1']]), partDocument: () => part,
      resolveFace: (_component, ref) => {
        calls.push(ref);
        return faces.get(`${ref.bodyFeatureId}:${ref.index}`) ?? { status: 'missing' };
      } };
    return { current, retried: () => calls.filter((ref) => ref.bodyFeatureId === 'hole' && ref.index === 5) };
  }

  it('元のボディが消費された(body-missing)時だけ、同じ由来・同じ指紋の参照を穴のボディで選び直し、その面で入口を決める', () => {
    const face = entryFace(ENTRY_ORIGIN);
    const { current, retried } = threaded(face, CONSUMED, plane(10));
    expect(bindHoleSelection(current, PICK)).toMatchObject({ hole: { kind: 'throughThreaded', threadStart: 2, threadLength: 8, length: 10 } });
    expect(retried()).toEqual([{ ...face, bodyFeatureId: 'hole' }]);
  });

  it('元のボディで直接選べた時は、その結果をそのまま使い、選び直さない', () => {
    const { current, retried } = threaded(entryFace(ENTRY_ORIGIN), plane(10), plane(0));
    expect(bindHoleSelection(current, PICK)).toMatchObject({ hole: { kind: 'throughThreaded', threadStart: 2 } });
    expect(retried()).toEqual([]);
  });

  it.each<readonly [string, SubShapeOrigin | undefined, FaceResolution]>([
    ['由来の無い(指紋だけの)参照', undefined, CONSUMED],
    ['元のボディで曖昧', ENTRY_ORIGIN, { status: 'ambiguous' }],
    ['元のボディはあるが面・履歴が無い', ENTRY_ORIGIN, { status: 'missing' }],
  ])('%s は、穴のボディでは選べる面があっても選び直さず断る', (_case, origin, direct) => {
    const { current, retried } = threaded(entryFace(origin), direct, plane(10));
    expect(bindHoleSelection(current, PICK)).toMatchObject({ code: 'threadEntryUnknown',
      detail: { componentId: 'component-1', holeFeatureId: 'hole' } });
    expect(retried()).toEqual([]);
  });

  it('穴のボディで選び直しても曖昧なら断る(番地や指紋で救わない)', () => {
    const { current, retried } = threaded(entryFace(ENTRY_ORIGIN), CONSUMED, { status: 'ambiguous' });
    expect(bindHoleSelection(current, PICK)).toMatchObject({ code: 'threadEntryUnknown' });
    expect(retried()).toHaveLength(1);
  });

  it('既定の口は、ボディが無い時だけ body-missing を付け、ボディの中の消失・曖昧はそのまま返す', () => {
    const body: SolidBody = { featureId: 'plate', mesh: { positions: new Float32Array(), normals: new Float32Array(),
      indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [], faces: [] };
    const component = createComponentFor(createAssemblyDocument('口'), { kind: 'part', partRef: 'plate' });
    const face = entryFace(ENTRY_ORIGIN);
    const missing = (_body: SolidBody, ref: SubShapeRef): SubShapeReferenceResolution =>
      ({ status: 'missing', reason: 'history-missing', originalReference: ref, candidates: [] });
    const ambiguous = (_body: SolidBody, ref: SubShapeRef): SubShapeReferenceResolution =>
      ({ status: 'ambiguous', reason: 'split', originalReference: ref, candidates: [] });
    expect(faceResolverFromBodies(() => [], missing)(component, face)).toEqual(CONSUMED);
    expect(faceResolverFromBodies(() => null, missing)(component, face)).toEqual(CONSUMED);
    expect(faceResolverFromBodies(() => [body], missing)(component, face)).toEqual({ status: 'missing' });
    expect(faceResolverFromBodies(() => [body], ambiguous)(component, face)).toEqual({ status: 'ambiguous' });
  });
});
