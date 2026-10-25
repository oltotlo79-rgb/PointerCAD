import { isDeepStrictEqual } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  HoleStepSpec,
  PrimitiveStepSpec,
  RigidTransformSpec,
  SolidFaceInfo,
  SubShapeQuery,
  ThreadStepSpec,
  Vec3Tuple,
} from '../types.js';
import { booleanOp } from './booleanOp.js';
import { buildBooleanShape } from './buildBooleanShape.js';
import * as allocationModule from './allocations.js';
import { writeBrepBytes } from './brepBytes.js';
import type { NativeHoleToolFace } from './subShapeOrigins.js';
import * as holeOriginsModule from './subShapeOrigins.js';
import { OriginHistoryLimitError } from './subShapeHistory.js';
import { lookupSubShapeOrigin } from './composeSubShapeOrigins.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { CYLINDER_ORACLE_PLACEMENTS as placements, cylinderPlacementOracle,
  holeOraclePlus as plus, holeOracleTimes as times, type HoleOracleMatrix as Matrix } from './holePlacementOracle.testSupport.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import type { HoleEntrySpec } from './makeHole.js';
import { makeHole, makeHoleTools, resolveHoleFrame } from './makeHole.js';
import { makePrimitive } from './makePrimitive.js';
import { makeThreadHole } from './makeThread.js';
import { resolveFaceReference, scoreFace, SUB_SHAPE_MATCH_THRESHOLD } from './matchSubShape.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 計画書 タスク6 の検証表が使う板。体積 12000、上の面は z=10、面積 1200。 */
const PLATE = { dx: 40, dy: 30, dz: 10 } as const;

/** φ6 の穴 1 つが板から削る体積(貫通、板厚 10)。π·3²·10 = 282.743338823… */
const THROUGH_HOLE_VOLUME = Math.PI * 3 * 3 * PLATE.dz;

/**
 * 体積の突き合わせ。円柱も箱も解析的に積分されるので近似は入らない。
 * 2026-09-03 の実測では板の穴で 1e-15、200×200 の板の 20 穴で 1.2e-15(いずれも相対)だった。
 * ここでは余裕を見て相対 1e-9 で固定する(計画書の ±1e-6 より厳しい)。
 */
function expectVolume(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-9);
}

/**
 * 計画書 タスク40 の検証表は**絶対 ±1e-6** で期待値を書いているので、そのまま固定する
 * (体積 11450 では相対 8.7e-11 にあたり、上の `expectVolume` より 100 倍以上厳しい)。
 */
function expectVolumeExact(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

describe('穴あけ(FR-405、FR-504)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function subShapesOf(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function facesOf(shape: Parameters<typeof collectSubShapes>[1]): readonly SolidFaceInfo[] {
    return subShapesOf(shape).faces;
  }

  /** 面の素性をそのまま指紋にする(UI が選んだ直後と同じ状態)。 */
  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return {
      kind: 'face',
      index: info.index,
      surfaceKind: info.surfaceKind,
      area: info.area,
      position: info.centroid,
      axis: info.axis,
      radius: info.radius,
    };
  }

  /** 軸が axis に最も近い平面の面を 1 枚選ぶ(上の面・下の面を実名で指すため)。 */
  function planeFacing(faces: readonly SolidFaceInfo[], axis: Vec3Tuple): SolidFaceInfo {
    const found = faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(face.axis[0] - axis[0]) < 1e-9 &&
        Math.abs(face.axis[1] - axis[1]) < 1e-9 &&
        Math.abs(face.axis[2] - axis[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`向き [${axis.join(',')}] の平面が見つかりませんでした`);
    }
    return found;
  }

  function holeSpec(overrides: Partial<HoleStepSpec> & { face: SubShapeQuery }): HoleStepSpec {
    return {
      kind: 'hole',
      targetKey: 'target',
      centers: [[20, 15, 10]],
      diameter: 6,
      depth: null,
      tiltAngle: 0,
      tiltAzimuth: 0,
      transforms: [],
      ...overrides,
    };
  }

  it('実Box保存top起点で低scoreの現面に貫通孔を作り、別feature・曖昧・消失を拒否する', () => {
    const base = { kind: 'primitive' as const, origin: [0, 0, 0] as Vec3Tuple,
      axis: [0, 0, 1] as Vec3Tuple, shape: { kind: 'box' as const, sizeX: 20, sizeY: 20, sizeZ: 20 },
      originQuery: null, targetKey: null };
    const changed = { ...base, origin: [500, 500, 0] as Vec3Tuple,
      shape: { kind: 'box' as const, sizeX: 200, sizeY: 200, sizeZ: 30 } };
    const old = makePrimitive(oc, base, 'hole-source');
    const current = makePrimitive(oc, changed, 'hole-source');
    const other = makePrimitive(oc, changed, 'other-source');
    try {
      if (old.origins?.state !== 'tracked' || current.origins?.state !== 'tracked'
        || other.origins?.state !== 'tracked') throw new Error('実Box起点がありません');
      const binding = old.origins.bindings.find(item => item.origin.identity.kind === 'box-face'
        && item.origin.identity.role === 'top');
      if (binding?.state !== 'unique' || binding.current.kind !== 'face') {
        throw new Error('旧Box topが一意でありません');
      }
      const oldFace = subShapesOf(old.shape).faces.find(item => item.index === binding.current.index);
      if (oldFace === undefined) throw new Error('旧Box topがありません');
      const savedFace = { ...faceQuery(oldFace), origin: binding.origin };
      const savedJson = JSON.stringify(savedFace);
      const tables = subShapesOf(current.shape);
      const scale = boundingDiagonal(oc, current.shape) * 0.5;
      const match = resolveFaceReference(tables.faces, savedFace, scale, current.origins);
      expect(match.status).toBe('matched');
      if (match.status !== 'matched') throw new Error('現Box topを解決できません');
      const score = scoreFace(match.match.candidate, savedFace, scale).total;
      expect(score).toBeLessThan(SUB_SHAPE_MATCH_THRESHOLD);
      console.log(`Hole保存topの実幾何score: ${score}`);
      const spec = holeSpec({ face: savedFace, centers: [[500, 500, 15]] });
      const frame = resolveHoleFrame(oc, current.shape, tables.faces, spec, current.origins);
      expect(frame.origins[0]).toEqual([500, 500, 15]);
      const output = makeHole(oc, spec, current.shape, tables.faces, { kind: 'plain' }, current.origins);
      try {
        expectVolume(output.volume, 1_200_000 - Math.PI * 9 * 30);
        expect(isValidShape(oc, output.shape)).toBe(true);
      } finally {
        output.delete();
      }
      const high = { ...faceQuery(match.match.candidate), origin: savedFace.origin };
      expect(() => makeHole(oc, { ...spec, face: high }, other.shape,
        subShapesOf(other.shape).faces, { kind: 'plain' }, other.origins))
        .toThrow(/もとの面が見つかりません/);
      const currentBinding = current.origins.bindings.find(item => item.origin.identity.kind === 'box-face'
        && item.origin.identity.role === 'top');
      const otherBinding = other.origins.bindings.find(item => item.origin.identity.kind === 'box-face'
        && item.origin.identity.role === 'top');
      if (currentBinding?.state !== 'unique' || currentBinding.current.kind !== 'face'
        || otherBinding?.state !== 'unique') throw new Error('現Box topが一意でありません');
      const another = tables.faces.find(item => item.index !== currentBinding.current.index);
      if (another === undefined) throw new Error('分割反例の別面がありません');
      for (const origins of [undefined,
        { version: 1 as const, state: 'untracked' as const, reason: 'unsupported-operation' as const },
        { version: 1 as const, state: 'tracked' as const, bindings: current.origins.bindings.map(item =>
          item === currentBinding ? { origin: item.origin, state: 'missing' as const,
            reason: 'deleted' as const } : item) },
        { version: 1 as const, state: 'tracked' as const, bindings: current.origins.bindings.map(item =>
          item === currentBinding ? { origin: item.origin, state: 'split' as const,
            candidates: [currentBinding.current, { kind: 'face' as const, index: another.index }] as const } : item) },
        { version: 1 as const, state: 'tracked' as const, bindings: current.origins.bindings.map(item =>
          item === currentBinding ? { origin: item.origin, state: 'merged' as const,
            current: currentBinding.current, coOrigins: [item.origin, otherBinding.origin] as const } : item) }]) {
        expect(() => resolveHoleFrame(oc, current.shape, tables.faces,
          { ...spec, face: high }, origins)).toThrow(/もとの面が見つかりません/);
      }
      expect(measureVolume(oc, current.shape)).toBeCloseTo(1_200_000, 6);
      expect(JSON.stringify(savedFace)).toBe(savedJson);
    } finally {
      other.delete();
      current.delete();
      old.delete();
    }
  });

  it('実円筒の保存start/end cap起点から現capへ内向きに穿孔し、sideと失効起点を拒否する', () => {
    const primitive = (radius: number, height: number, origin: Vec3Tuple) => ({
      kind: 'primitive' as const, origin, axis: [0, 0, 1] as Vec3Tuple,
      shape: { kind: 'cylinder' as const, radius, height }, originQuery: null, targetKey: null,
    });
    const old = makePrimitive(oc, primitive(5, 20, [0, 0, 0]), 'hole-cylinder');
    const current = makePrimitive(oc, primitive(6, 30, [500, 500, 0]), 'hole-cylinder');
    const foreign = makePrimitive(oc, primitive(6, 30, [500, 500, 0]), 'foreign-cylinder');
    try {
      if (old.origins?.state !== 'tracked' || current.origins?.state !== 'tracked'
        || foreign.origins?.state !== 'tracked') throw new Error('実円筒起点がありません');
      const oldOrigins = old.origins;
      const currentOrigins = current.origins;
      const foreignOrigins = foreign.origins;
      const oldTables = subShapesOf(old.shape);
      const currentTables = subShapesOf(current.shape);
      const foreignTables = subShapesOf(foreign.shape);
      const binding = (role: 'start' | 'end' | 'side') => {
        const found = oldOrigins.bindings.find(item => item.origin.identity.kind === 'cylinder-face'
          && item.origin.identity.role === role);
        if (found?.state !== 'unique' || found.current.kind !== 'face') {
          throw new Error(`実円筒${role}起点が一意でありません`);
        }
        const face = oldTables.faces.find(item => item.index === found.current.index);
        if (face === undefined) throw new Error(`実円筒${role}面がありません`);
        return { origin: found.origin, face };
      };
      const volume = Math.PI * 6 ** 2 * 30;
      for (const role of ['start', 'end'] as const) {
        const source = binding(role);
        const saved = JSON.parse(JSON.stringify({ ...faceQuery(source.face), origin: source.origin })) as Extract<SubShapeQuery, { kind: 'face' }>;
        const z = role === 'start' ? 0 : 30;
        const spec = holeSpec({ face: saved, centers: [[500, 500, z]], diameter: 2 });
        const frame = resolveHoleFrame(oc, current.shape, currentTables.faces, spec, currentOrigins);
        expect(frame.origins).toEqual([[500, 500, z]]);
        expect(frame.direction[2]).toBeCloseTo(role === 'start' ? 1 : -1, 9);
        const output = makeHole(oc, spec, current.shape, currentTables.faces,
          { kind: 'plain' }, currentOrigins);
        try {
          expectVolume(output.volume, volume - Math.PI * 30);
          expect(isValidShape(oc, output.shape)).toBe(true);
        } finally { output.delete(); }
        expectVolume(measureVolume(oc, current.shape), volume);
        expect(isValidShape(oc, current.shape)).toBe(true);
        expect(() => resolveHoleFrame(oc, foreign.shape, foreignTables.faces, spec,
          foreignOrigins)).toThrow(/もとの面が見つかりません/);
        expect(() => resolveHoleFrame(oc, current.shape, currentTables.faces, spec))
          .toThrow(/もとの面が見つかりません/);
        const currentBinding = currentOrigins.bindings.find(item => item.origin.identity.kind === 'cylinder-face'
          && item.origin.identity.role === role);
        const otherBinding = foreignOrigins.bindings.find(item => item.origin.identity.kind === 'cylinder-face'
          && item.origin.identity.role === role);
        if (currentBinding?.state !== 'unique' || currentBinding.current.kind !== 'face'
          || otherBinding?.state !== 'unique') throw new Error('現円筒cap起点が一意でありません');
        const otherFace = currentTables.faces.find(item => item.index !== currentBinding.current.index);
        if (otherFace === undefined) throw new Error('分割反例の別面がありません');
        for (const changed of [
          { origin: currentBinding.origin, state: 'missing' as const, reason: 'deleted' as const },
          { origin: currentBinding.origin, state: 'split' as const,
            candidates: [currentBinding.current, { kind: 'face' as const, index: otherFace.index }] as const },
          { origin: currentBinding.origin, state: 'merged' as const,
            current: currentBinding.current, coOrigins: [currentBinding.origin, otherBinding.origin] as const },
        ]) {
          const origins = { version: 1 as const, state: 'tracked' as const,
            bindings: currentOrigins.bindings.map(item => item === currentBinding ? changed : item) };
          expect(() => resolveHoleFrame(oc, current.shape, currentTables.faces, spec, origins))
            .toThrow(/もとの面が見つかりません/);
        }
      }
      const side = binding('side');
      const sideSpec = holeSpec({ face: { ...faceQuery(side.face), origin: side.origin },
        centers: [[506, 500, 15]], diameter: 2 });
      expect(() => resolveHoleFrame(oc, current.shape, currentTables.faces, sideSpec, currentOrigins))
        .toThrow(/平らな面だけです/);
      expectVolume(measureVolume(oc, current.shape), volume);
    } finally {
      foreign.delete();
      current.delete();
      old.delete();
    }
  });

  /** 板と、その上の面の指紋。使い終わったら handle.delete() する。 */
  function plateWithTopFace(): {
    handle: OcctShapeHandle;
    faces: readonly SolidFaceInfo[];
    top: SolidFaceInfo;
  } {
    const handle = makeBox(oc, PLATE);
    const faces = facesOf(handle.shape);
    return { handle, faces, top: planeFacing(faces, [0, 0, 1]) };
  }

  it('実スケッチ輪郭の押出し上面を保存queryで穴後も照合し、直線2工具とmissing/split拒否を保つ', () => {
    const target = makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [
        { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
        { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
        { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
        { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
      ],
      profileOrigin: { sketchId: 'saved-pattern-sketch', faceFeatureId: 'saved-pattern-region',
        lineFeatureIds: ['saved-line-0', 'saved-line-1', 'saved-line-2', 'saved-line-3'] },
      direction: [0, 0, 1], distance: 10,
    }, {}, {}, 'saved-pattern-extrude');
    try {
      const originalShape = target.shape;
      const originalOrigins = target.origins;
      if (originalOrigins?.state !== 'tracked') throw new Error('実押出しoriginがありません');
      const top = planeFacing(facesOf(target.shape), [0, 0, 1]);
      const binding = originalOrigins.bindings.find(item => item.state === 'unique'
        && item.current.kind === 'face' && item.current.index === top.index);
      if (binding?.state !== 'unique') throw new Error('実押出し上面originがありません');
      expect(binding.origin.identity.kind).toBe('extrude-cap');
      const query = { ...faceQuery(top), origin: binding.origin };
      const persisted: unknown = JSON.parse(JSON.stringify(query));
      if (typeof persisted !== 'object' || persisted === null) throw new Error('保存queryがobjectではありません');
      const saved = Object.assign({ ...query }, persisted);
      expect(saved).toEqual(query);
      expect(saved.origin).not.toBe(query.origin);
      const savedBytes = JSON.stringify(saved);
      const first = makeHole(oc, holeSpec({ face: saved, centers: [[5, 15, 10]] }),
        target.shape, facesOf(target.shape), { kind: 'plain' }, originalOrigins, 'saved-first-hole');
      try {
        expectVolumeExact(first.volume, 12000 - THROUGH_HOLE_VOLUME);
        if (first.origins?.state !== 'tracked') throw new Error('実穴後originがありません');
        const afterFaces = facesOf(first.shape);
        const match = resolveFaceReference(afterFaces, saved, boundingDiagonal(oc, first.shape) / 2, first.origins);
        expect(match.status).toBe('matched');
        const current = first.origins.bindings.find(item => item.state === 'unique'
          && isDeepStrictEqual(item.origin, saved.origin));
        if (current?.state !== 'unique') throw new Error('保存した上面originが一意ではありません');
        const another = afterFaces.find(item => item.index !== current.current.index);
        if (another === undefined) throw new Error('別面がありません');
        const spec = holeSpec({ face: saved, centers: [[5, 15, 10]], transforms: [
          { translation: [15, 0, 0], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 },
          { translation: [30, 0, 0], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 },
        ] });
        const patterned = makeHole(oc, spec, first.shape, afterFaces, { kind: 'plain' }, first.origins, 'saved-pattern');
        try {
          expectVolumeExact(patterned.volume, 12000 - 270 * Math.PI);
          expectVolumeExact(measureVolume(oc, patterned.shape), 12000 - 270 * Math.PI);
          expect(isValidShape(oc, patterned.shape)).toBe(true);
          expect(resolveFaceReference(facesOf(patterned.shape), saved,
            boundingDiagonal(oc, patterned.shape) / 2, patterned.origins).status).toBe('matched');
          expect(JSON.stringify(saved)).toBe(savedBytes);
        } finally { patterned.delete(); }
        for (const origins of [undefined,
          { version: 1 as const, state: 'untracked' as const, reason: 'missing-native-map' as const },
          { ...first.origins, bindings: first.origins.bindings.map(item => item === current
            ? { origin: item.origin, state: 'missing' as const, reason: 'deleted' as const } : item) },
          { ...first.origins, bindings: first.origins.bindings.map(item => item === current
            ? { origin: item.origin, state: 'split' as const,
              candidates: [current.current, { kind: 'face' as const, index: another.index }] as const } : item) }]) {
          expect(() => makeHole(oc, spec, first.shape, afterFaces, { kind: 'plain' }, origins, 'saved-pattern'))
            .toThrow(/もとの面が見つかりません/);
        }
        expectVolumeExact(measureVolume(oc, first.shape), 12000 - THROUGH_HOLE_VOLUME);
        expect(JSON.stringify(saved)).toBe(savedBytes);
      } finally { first.delete(); }
      expect(target.shape).toBe(originalShape);
      expect(target.origins).toBe(originalOrigins);
      expectVolumeExact(measureVolume(oc, target.shape), 12000);
      expect(isValidShape(oc, target.shape)).toBe(true);
    } finally { target.delete(); }
  });

  it('穴Cutの上面originを次の2穴へ継承し、別feature・失効・曖昧を拒否する', () => {
    const primitive = { kind: 'primitive' as const, origin: [20, 15, 5] as Vec3Tuple,
      axis: [0, 0, 1] as Vec3Tuple,
      shape: { kind: 'box' as const, sizeX: 40, sizeY: 30, sizeZ: 10 },
      originQuery: null, targetKey: null };
    const target = makePrimitive(oc, primitive, 'pattern-plate');
    const foreign = makePrimitive(oc, primitive, 'foreign-plate');
    try {
      if (target.origins?.state !== 'tracked' || foreign.origins?.state !== 'tracked') {
        throw new Error('実板originがありません');
      }
      const foreignOrigin = foreign.origins.bindings[0].origin;
      const top = planeFacing(facesOf(target.shape), [0, 0, 1]);
      const binding = target.origins.bindings.find(item => item.state === 'unique'
        && item.current.kind === 'face' && item.current.index === top.index);
      if (binding?.state !== 'unique') throw new Error('実上面originがありません');
      const face = { ...faceQuery(top), origin: binding.origin };
      const first = makeHole(oc, holeSpec({ face, centers: [[5, 15, 10]] }),
        target.shape, facesOf(target.shape), { kind: 'plain' }, target.origins, 'first-hole');
      try {
        expect(first.origins?.state).toBe('tracked');
        if (first.origins?.state !== 'tracked') throw new Error('穴後originがありません');
        const faces = facesOf(first.shape);
        const match = resolveFaceReference(faces, face, boundingDiagonal(oc, first.shape) / 2, first.origins);
        expect(match.status).toBe('matched');
        const secondSpec = holeSpec({ face, centers: [[20, 15, 10], [35, 15, 10]] });
        const second = makeHole(oc, secondSpec, first.shape, faces,
          { kind: 'plain' }, first.origins, 'pattern');
        try {
          expectVolumeExact(second.volume, 12000 - 3 * THROUGH_HOLE_VOLUME);
          expectVolumeExact(measureVolume(oc, second.shape), 12000 - 3 * THROUGH_HOLE_VOLUME);
          expect(isValidShape(oc, second.shape)).toBe(true);
          expect(second.origins?.state).toBe('tracked');
          if (second.origins?.state !== 'tracked') throw new Error('パターン後originがありません');
          expect(second.origins.bindings.map(item => item.origin))
            .toEqual(target.origins.bindings.map(item => item.origin));
        } finally { second.delete(); }
        expectVolumeExact(measureVolume(oc, first.shape), 12000 - THROUGH_HOLE_VOLUME);
        const current = first.origins.bindings.find(item => item.state === 'unique'
          && JSON.stringify(item.origin) === JSON.stringify(binding.origin));
        if (current?.state !== 'unique') throw new Error('穴後上面が一意でありません');
        const another = faces.find(item => item.index !== current.current.index);
        if (another === undefined) throw new Error('別面がありません');
        for (const origins of [undefined, foreign.origins,
          { version: 1 as const, state: 'untracked' as const, reason: 'missing-native-map' as const },
          { ...first.origins, bindings: first.origins.bindings.map(item => item === current
            ? { origin: item.origin, state: 'missing' as const, reason: 'deleted' as const } : item) },
          { ...first.origins, bindings: first.origins.bindings.map(item => item === current
            ? { origin: item.origin, state: 'split' as const,
              candidates: [current.current, { kind: 'face' as const, index: another.index }] as const } : item) },
          { ...first.origins, bindings: first.origins.bindings.map(item => item === current
            ? { origin: item.origin, state: 'merged' as const, current: current.current,
              coOrigins: [item.origin, foreignOrigin] as const } : item) }]) {
          expect(() => makeHole(oc, secondSpec, first.shape, faces, { kind: 'plain' }, origins, 'pattern'))
            .toThrow(/もとの面が見つかりません/);
        }
      } finally { first.delete(); }
      expectVolumeExact(measureVolume(oc, target.shape), 12000);
      expect(isValidShape(oc, target.shape)).toBe(true);
    } finally { foreign.delete(); target.delete(); }
  });

  it('refuses colliding native producer claims and never marks their shared face eligible for a fingerprint', () => {
    const target = makePrimitive(oc, { kind: 'primitive', origin: [20, 15, 5], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 }, originQuery: null, targetKey: null }, 'claim-target');
    try {
      if (target.origins?.state !== 'tracked') throw new Error('Missing target proof');
      const faces = facesOf(target.shape), top = planeFacing(faces, [0, 0, 1]);
      const frame = resolveHoleFrame(oc, target.shape, faces, holeSpec({ face: faceQuery(top) }), target.origins);
      const tools = makeHoleTools(oc, frame, 6, null, [], { kind: 'plain' }, { featureId: 'claim-hole',
        centerAnchors: [{ sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } }], placementRoles: [] });
      try {
        const wall = tools.newHoleFaces.find((producer) => producer.origin?.identity.role === 'wall');
        if (wall?.origin === undefined) throw new Error('Missing native tool wall');
        const alternate: NativeHoleToolFace = { face: wall.face, origin: { ...wall.origin,
          identity: { ...wall.origin.identity, center: { sketchId: 'centers', producer: { kind: 'point', featureId: 'B' } } } } };
        const anonymous: NativeHoleToolFace = { face: wall.face, reason: 'unsupported-producer' };
        const cases: readonly (readonly NativeHoleToolFace[])[] = [
          [wall, alternate], [wall, wall], [wall, anonymous], [anonymous, anonymous],
        ];
        for (const producers of cases) {
          const output = booleanOp(oc, 'subtract', target.shape, tools.shape,
            { featureId: 'claim-hole', target: target.origins, newHoleFaces: producers });
          try {
            expectVolumeExact(output.volume, 12000 - Math.PI * 3 ** 2 * 10);
            if (output.origins?.state !== 'tracked') throw new Error('Missing claim result');
            expect(lookupSubShapeOrigin(output.origins, wall.origin).status).not.toBe('matched');
            expect(output.origins.fingerprintFallback ?? []).toEqual([]);
          } finally { output.delete(); }
        }
      } finally { tools.delete(); }
      expectVolumeExact(measureVolume(oc, target.shape), 12000);
    } finally { target.delete(); }
  });

  it('names native new walls, blind floor and uniquely incident rims without changing the tool geometry', () => {
    const primitive = { kind: 'primitive' as const, origin: [20, 15, 5] as Vec3Tuple,
      axis: [0, 0, 1] as Vec3Tuple, shape: { kind: 'box' as const, sizeX: 40, sizeY: 30, sizeZ: 10 },
      originQuery: null, targetKey: null };
    const target = makePrimitive(oc, primitive, 'named-hole-plate');
    try {
      if (target.origins?.state !== 'tracked') throw new Error('Missing native target proof');
      const faces = facesOf(target.shape), top = planeFacing(faces, [0, 0, 1]);
      const binding = target.origins.bindings.find((item) => item.state === 'unique'
        && item.current.kind === 'face' && item.current.index === top.index);
      if (binding === undefined) throw new Error('Missing top identity');
      const cases: readonly { depth: number | null; entry: HoleEntrySpec; walls: number; floors: number; rims: number }[] = [
        { depth: null, entry: { kind: 'plain' }, walls: 1, floors: 0, rims: 2 },
        { depth: 4, entry: { kind: 'plain' }, walls: 1, floors: 1, rims: 2 },
        { depth: null, entry: { kind: 'counterbore', diameter: 10, depth: 3 }, walls: 2, floors: 1, rims: 4 },
        { depth: null, entry: { kind: 'countersink', diameter: 12, angle: Math.PI / 2 }, walls: 2, floors: 0, rims: 3 },
      ];
      for (const fixture of cases) {
        const spec = holeSpec({ face: { ...faceQuery(top), origin: binding.origin }, depth: fixture.depth,
          centerAnchors: [{ sketchId: 'centers', producer: { kind: 'point', featureId: 'center-A' } }],
          placementRoles: [] });
        const result = makeHole(oc, spec, target.shape, faces, fixture.entry, target.origins, 'named-hole');
        const control = makeHole(oc, { ...spec, centerAnchors: undefined, placementRoles: undefined },
          target.shape, faces, fixture.entry, target.origins, 'control-hole');
        try {
          expectVolumeExact(result.volume, control.volume);
          const tables = subShapesOf(result.shape);
          if (result.origins?.state !== 'tracked') throw new Error('Missing output producer proof');
          const fresh = result.origins.bindings.filter((item) => item.origin.shapeKind === 'face'
            && item.origin.identity.kind === 'hole-face' && item.state === 'unique');
          expect(fresh.filter((item) => item.origin.shapeKind === 'face'
            && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'wall')).toHaveLength(fixture.walls);
          expect(fresh.filter((item) => item.origin.shapeKind === 'face'
            && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'floor')).toHaveLength(fixture.floors);
          expect(fresh.some((item) => item.origin.shapeKind === 'face'
            && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'entry-cap')).toBe(false);
          const rims = result.origins.bindings.filter((item) => item.origin.shapeKind === 'edge'
            && item.origin.identity.kind === 'face-intersection-edge' && item.state === 'unique');
          expect(rims).toHaveLength(fixture.rims);
          for (const rim of rims) {
            if (rim.state !== 'unique') throw new Error('Expected proved rim');
            expect(tables.edges.find((edge) => edge.index === rim.current.index)?.curveKind).toBe('circle');
            expect(lookupSubShapeOrigin(result.origins, rim.origin).status).toBe('matched');
          }
          expect(isValidShape(oc, result.shape)).toBe(true);
        } finally { control.delete(); result.delete(); }
      }
      expectVolumeExact(measureVolume(oc, target.shape), 12000);
    } finally { target.delete(); }
  });


  it('R18 saved phi6 wall and incident rim origins resolve the same phi8 hole without fingerprint rescue', () => {
    const primitive = { kind: 'primitive' as const, origin: [20, 15, 5] as Vec3Tuple,
      axis: [0, 0, 1] as Vec3Tuple, shape: { kind: 'box' as const, sizeX: 40, sizeY: 30, sizeZ: 10 },
      originQuery: null, targetKey: null };
    const target = makePrimitive(oc, primitive, 'r18-plate');
    try {
      if (target.origins?.state !== 'tracked') throw new Error('Missing actual plate origins');
      const faces = facesOf(target.shape), top = planeFacing(faces, [0, 0, 1]);
      const topBinding = target.origins.bindings.find(item => item.state === 'unique'
        && item.current.kind === 'face' && item.current.index === top.index);
      if (topBinding === undefined) throw new Error('Missing actual top origin');
      const spec = holeSpec({ face: { ...faceQuery(top), origin: topBinding.origin },
        centerAnchors: [{ sketchId: 'r18-centers', producer: { kind: 'point', featureId: 'r18-center' } }],
        placementRoles: [] });
      const old = makeHole(oc, spec, target.shape, faces, { kind: 'plain' }, target.origins, 'r18-hole');
      try {
        const current = makeHole(oc, { ...spec, diameter: 8 }, target.shape, faces,
          { kind: 'plain' }, target.origins, 'r18-hole');
        try {
          if (old.origins?.state !== 'tracked' || current.origins?.state !== 'tracked')
            throw new Error('Missing actual hole origins');
          expectVolumeExact(old.volume, 12000 - 90 * Math.PI);
          expectVolumeExact(current.volume, 12000 - 160 * Math.PI);
          expect(isValidShape(oc, current.shape)).toBe(true);
          const oldTables = subShapesOf(old.shape), currentTables = subShapesOf(current.shape);
          const wall = old.origins.bindings.find(item => item.state === 'unique'
            && item.origin.shapeKind === 'face' && item.origin.identity.kind === 'hole-face'
            && item.origin.identity.stage === 'bore' && item.origin.identity.role === 'wall');
          if (wall?.state !== 'unique' || wall.current.kind !== 'face'
            || wall.origin.shapeKind !== 'face' || wall.origin.identity.kind !== 'hole-face')
            throw new Error('Missing saved unique wall');
          const oldFace = oldTables.faces.find(item => item.index === wall.current.index);
          if (oldFace === undefined) throw new Error('Missing actual saved face');
          expect(oldFace.radius).toBeCloseTo(3, 9);
          const saved = { ...faceQuery(oldFace), origin: wall.origin }, savedJson = JSON.stringify(saved);
          const match = resolveFaceReference(currentTables.faces, saved,
            boundingDiagonal(oc, current.shape) * 0.5, current.origins);
          expect(match.status).toBe('matched');
          if (match.status !== 'matched') throw new Error('Current semantic wall unavailable');
          expect(match.match.candidate.radius).toBeCloseTo(4, 9);
          expect(match.match.candidate.surfaceKind).toBe('cylinder');
          expect(lookupSubShapeOrigin(current.origins, wall.origin)).toMatchObject({
            status: 'matched', basis: 'semantic', address: { kind: 'face', index: match.match.candidate.index },
          });
          // Incident faces are FaceOrigin identities, not version/shapeKind wrappers.
          const reorderedWallIdentity = Object.fromEntries(Object.entries(wall.origin.identity).reverse());
          expect(isDeepStrictEqual(reorderedWallIdentity, wall.origin.identity)).toBe(true);
          expect(isDeepStrictEqual(wall.origin.identity, wall.origin)).toBe(false);
          const rims = old.origins.bindings.filter(item => item.state === 'unique'
            && item.origin.shapeKind === 'edge' && item.origin.identity.kind === 'face-intersection-edge'
            && item.origin.identity.faces.some(face => isDeepStrictEqual(face, wall.origin.identity)));
          expect(rims).toHaveLength(2);
          for (const rim of rims) {
            const resolved = lookupSubShapeOrigin(current.origins, rim.origin);
            expect(resolved.status).toBe('matched');
            if (resolved.status !== 'matched' || resolved.address.kind !== 'edge')
              throw new Error('Current actual incident rim unavailable');
            const edge = currentTables.edges.find(item => item.index === resolved.address.index);
            expect(edge?.curveKind).toBe('circle');
            expect(edge?.radius).toBeCloseTo(4, 9);
          }
          const currentWall = current.origins.bindings.find(item => item.state === 'unique'
            && item.current.kind === 'face' && item.current.index === match.match.candidate.index);
          const otherFace = currentTables.faces.find(item => item.index !== match.match.candidate.index);
          if (currentWall?.state !== 'unique' || otherFace === undefined) throw new Error('Missing rejection controls');
          const foreign = { ...wall.origin, identity: { ...wall.origin.identity, featureId: 'foreign-hole' } };
          expect(isDeepStrictEqual(foreign.identity, wall.origin.identity)).toBe(false);
          const high = { ...faceQuery(match.match.candidate), origin: wall.origin };
          expect(resolveFaceReference(currentTables.faces, { ...high, origin: foreign }, 100, current.origins).status)
            .toBe('missing');
          const unavailable: readonly (Parameters<typeof lookupSubShapeOrigin>[0])[] = [undefined,
            { version: 1, state: 'tracked', bindings: [{ origin: wall.origin, state: 'missing', reason: 'deleted' }] },
            { version: 1, state: 'tracked', bindings: [{ origin: wall.origin, state: 'split', candidates: [
              currentWall.current, { kind: 'face', index: otherFace.index },
            ] }] },
            { version: 1, state: 'tracked', bindings: [{ origin: wall.origin, state: 'merged',
              current: currentWall.current, coOrigins: [wall.origin, foreign] }] },
          ];
          expect(unavailable.map(origins => resolveFaceReference(currentTables.faces, high, 100, origins).status))
            .toEqual(['missing', 'missing', 'ambiguous', 'ambiguous']);
          expect(JSON.stringify(saved)).toBe(savedJson);
          expect(saved.radius).toBe(3);
        } finally { current.delete(); }
      } finally { old.delete(); }
      expectVolumeExact(measureVolume(oc, target.shape), 12000);
    } finally { target.delete(); }
  });

  it('preserves center producer identity across tool enumeration changes and cold reconstruction', () => {
    const primitive = { kind: 'primitive' as const, origin: [20, 15, 5] as Vec3Tuple,
      axis: [0, 0, 1] as Vec3Tuple, shape: { kind: 'box' as const, sizeX: 40, sizeY: 30, sizeZ: 10 },
      originQuery: null, targetKey: null };
    const target = makePrimitive(oc, primitive, 'reordered-plate');
    try {
      if (target.origins?.state !== 'tracked') throw new Error('Missing target proof');
      const faces = facesOf(target.shape), top = planeFacing(faces, [0, 0, 1]);
      const binding = target.origins.bindings.find((item) => item.state === 'unique'
        && item.current.kind === 'face' && item.current.index === top.index);
      if (binding === undefined) throw new Error('Missing top identity');
      const a = { sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } } as const;
      const c = { sketchId: 'centers', producer: { kind: 'point', featureId: 'C' } } as const;
      const b = { sketchId: 'centers', producer: { kind: 'point', featureId: 'B' } } as const;
      const first = makeHole(oc, holeSpec({ face: { ...faceQuery(top), origin: binding.origin },
        centers: [[8, 15, 10], [20, 15, 10], [30, 15, 10]], centerAnchors: [a, c, b], placementRoles: [] }),
      target.shape, faces, { kind: 'plain' }, target.origins, 'holes');
      const cold = makeHole(oc, holeSpec({ face: { ...faceQuery(top), origin: binding.origin },
        centers: [[30, 15, 10], [8, 15, 10], [20, 15, 10]], centerAnchors: [b, a, c], placementRoles: [] }),
      target.shape, faces, { kind: 'plain' }, target.origins, 'holes');
      try {
        expectVolumeExact(first.volume, 12000 - 3 * Math.PI * 3 ** 2 * 10);
        expectVolumeExact(cold.volume, first.volume);
        if (first.origins?.state !== 'tracked' || cold.origins?.state !== 'tracked') throw new Error('Missing cold producer proof');
        const walls = first.origins.bindings.filter((item) => item.state === 'unique' && item.origin.shapeKind === 'face'
          && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'wall');
        expect(walls).toHaveLength(3);
        for (const wall of walls) expect(lookupSubShapeOrigin(cold.origins, wall.origin).status).toBe('matched');
        const firstWall = walls[0];
        if (firstWall === undefined || firstWall.origin.shapeKind !== 'face' || firstWall.origin.identity.kind !== 'hole-face') throw new Error('Missing wall fixture');
        const foreign = { ...firstWall.origin, identity: { ...firstWall.origin.identity, featureId: 'different-hole' } };
        expect(lookupSubShapeOrigin(cold.origins, foreign).status).toBe('missing');
      } finally { cold.delete(); first.delete(); }
      expectVolumeExact(measureVolume(oc, target.shape), 12000);
    } finally { target.delete(); }
  });

  it.each([
    { observer: 'rebindHoleToolFaces', reason: 'limit' },
    { observer: 'rebindTransformedHoleFaces', reason: 'limit' },
    { observer: 'rebindHoleToolFaces', reason: 'missing-native-map' },
    { observer: 'rebindTransformedHoleFaces', reason: 'missing-native-map' },
  ] as const)('preserves successful native geometry when $observer reports $reason', ({ observer, reason }) => {
    const { handle, faces, top } = plateWithTopFace();
    const spec = holeSpec({ face: faceQuery(top), centers: [[10, 15, 10]],
      centerAnchors: [{ sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } }],
      transforms: [{ translation: [10, 0, 0], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 }],
      placementRoles: [{ kind: 'linear', step: 1 }] });
    const entry: HoleEntrySpec = { kind: 'counterbore', diameter: 10, depth: 3 };
    try {
      const control = makeHole(oc, spec, handle.shape, faces, entry);
      const hook = vi.spyOn(holeOriginsModule, observer).mockImplementation(() => {
        if (reason === 'limit') throw new OriginHistoryLimitError();
        throw new holeOriginsModule.HoleOriginMapError('Foreign native history member');
      });
      try {
        const result = makeHole(oc, spec, handle.shape, faces, entry,
          { version: 1, state: 'untracked', reason: 'legacy' }, 'limited-hole');
        try {
          expect(hook).toHaveBeenCalled();
          expectVolumeExact(result.volume, 12000 - Math.PI * (9 * 10 + (25 - 9) * 3));
          expectVolumeExact(result.volume, control.volume);
          expect(result.origins).toEqual({ version: 1, state: 'untracked', reason });
          expect(isValidShape(oc, result.shape)).toBe(true);
          expectVolumeExact(measureVolume(oc, handle.shape), 12000);
        } finally { result.delete(); }
      } finally { hook.mockRestore(); control.delete(); }
    } finally { handle.delete(); }
  });

  it('keeps circular logical fractions across 4-to-8/cold and refuses a removed quarter in 3', () => {
    const target = makePrimitive(oc, { kind: 'primitive', origin: [20, 15, 5], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 }, originQuery: null, targetKey: null }, 'circular-plate');
    try {
      if (target.origins?.state !== 'tracked') throw new Error('target proof missing');
      const faces = facesOf(target.shape), top = planeFacing(faces, [0, 0, 1]);
      const binding = target.origins.bindings.find(item => item.state === 'unique' && item.current.kind === 'face'
        && item.current.index === top.index);
      if (binding === undefined) throw new Error('top proof missing');
      const run = (fractions: readonly (readonly [number, number])[]) => makeHole(oc, holeSpec({
        face: { ...faceQuery(top), origin: binding.origin }, centers: [[30, 15, 10]],
        centerAnchors: [{ sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } }],
        transforms: fractions.map(([numerator, denominator]) => ({ translation: [0, 0, 0],
          rotationOrigin: [20, 15, 0], rotationAxis: [0, 0, 1], rotationAngle: 2 * Math.PI * numerator / denominator })),
        placementRoles: fractions.map(([numerator, denominator]) => ({ kind: 'circular', fullCircle: true, numerator, denominator })),
      }), target.shape, faces, { kind: 'plain' }, target.origins, 'circular-hole');
      const four = run([[0, 1], [1, 4], [1, 2], [3, 4]]);
      const eight = run([[0, 1], [1, 8], [1, 4], [3, 8], [1, 2], [5, 8], [3, 4], [7, 8]]);
      const three = run([[0, 1], [1, 3], [2, 3]]);
      try {
        expectVolumeExact(four.volume, 12000 - 4 * Math.PI * 9 * 10);
        expectVolumeExact(eight.volume, 12000 - 8 * Math.PI * 9 * 10);
        expectVolumeExact(three.volume, 12000 - 3 * Math.PI * 9 * 10);
        if (four.origins?.state !== 'tracked') throw new Error('four proof missing');
        const walls = four.origins.bindings.filter(item => item.state === 'unique' && item.origin.shapeKind === 'face'
          && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'wall');
        expect(walls).toHaveLength(4);
        for (const wall of walls) expect(lookupSubShapeOrigin(eight.origins, wall.origin).status).toBe('matched');
        const quarter = walls.find(item => item.origin.shapeKind === 'face' && item.origin.identity.kind === 'hole-face'
          && item.origin.identity.placement.kind === 'circular' && item.origin.identity.placement.numerator === 1
          && item.origin.identity.placement.denominator === 4);
        if (quarter === undefined) throw new Error('quarter missing');
        expect(lookupSubShapeOrigin(three.origins, quarter.origin).status).toBe('missing');
      } finally { three.delete(); eight.delete(); four.delete(); }
    } finally { target.delete(); }
  });

  it('uses signed linear roles and persisted slot/source rather than tool array order or equal coordinates', () => {
    const target = makePrimitive(oc, { kind: 'primitive', origin: [20, 15, 5], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 }, originQuery: null, targetKey: null }, 'placement-plate');
    try {
      if (target.origins?.state !== 'tracked') throw new Error('target proof missing');
      const faces = facesOf(target.shape), top = planeFacing(faces, [0, 0, 1]);
      const common = holeSpec({ face: faceQuery(top), centers: [[20, 15, 10]],
        centerAnchors: [{ sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } }] });
      const move = (step: number, spacing: number): RigidTransformSpec => ({ translation: [step * spacing, 0, 0],
        rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 });
      const first = makeHole(oc, { ...common, transforms: [move(-1, 10), move(0, 10), move(1, 10)],
        placementRoles: [{ kind: 'linear', step: -1 }, { kind: 'linear', step: 0 }, { kind: 'linear', step: 1 }] },
      target.shape, faces, { kind: 'plain' }, target.origins, 'linear-hole');
      const cold = makeHole(oc, { ...common, transforms: [move(1, 7), move(-1, 7), move(0, 7)],
        placementRoles: [{ kind: 'linear', step: 1 }, { kind: 'linear', step: -1 }, { kind: 'linear', step: 0 }] },
      target.shape, faces, { kind: 'plain' }, target.origins, 'linear-hole');
      const slot = (source: string) => makeHole(oc, { ...common, transforms: [move(0, 10)], placementRoles: [
        { kind: 'point-slot', slotId: 'slot-7', source: { kind: 'reference-point', featureId: source } },
      ] }, target.shape, faces, { kind: 'plain' }, target.origins, 'slot-hole');
      const a = slot('source-A'), b = slot('source-B');
      try {
        expectVolumeExact(first.volume, 12000 - 3 * Math.PI * 9 * 10);
        expectVolumeExact(cold.volume, first.volume); expectVolumeExact(a.volume, b.volume);
        if (first.origins?.state !== 'tracked' || a.origins?.state !== 'tracked') throw new Error('placement proof missing');
        const walls = first.origins.bindings.filter(item => item.state === 'unique' && item.origin.shapeKind === 'face'
          && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'wall');
        expect(walls).toHaveLength(3);
        for (const wall of walls) expect(lookupSubShapeOrigin(cold.origins, wall.origin).status).toBe('matched');
        const saved = a.origins.bindings.find(item => item.state === 'unique' && item.origin.shapeKind === 'face'
          && item.origin.identity.kind === 'hole-face' && item.origin.identity.role === 'wall');
        if (saved === undefined) throw new Error('slot wall missing');
        expect(lookupSubShapeOrigin(b.origins, saved.origin).status).toBe('missing');
      } finally { b.delete(); a.delete(); cold.delete(); first.delete(); }
    } finally { target.delete(); }
  });

  it.each(['imported', 'legacy'] as const)('re-proves unnamed %s regions and new walls/rims in cold machining', reason => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const input = { version: 1, state: 'untracked', reason } as const;
      const spec = holeSpec({ face: faceQuery(top), centerAnchors: [
        { sketchId: 'centers', producer: { kind: 'point', featureId: 'A' } },
      ], placementRoles: [] });
      const first = makeHole(oc, spec, handle.shape, faces, { kind: 'plain' }, input, 'import-hole');
      const cold = makeHole(oc, spec, handle.shape, faces, { kind: 'plain' }, input, 'import-hole');
      const unsupported = makeHole(oc, { ...spec, centerAnchors: undefined, placementRoles: undefined },
        handle.shape, faces, { kind: 'plain' }, input, 'legacy-hole');
      try {
        expectVolumeExact(first.volume, 12000 - Math.PI * 3 ** 2 * 10);
        expectVolumeExact(cold.volume, first.volume); expectVolumeExact(unsupported.volume, first.volume);
        if (first.origins?.state !== 'tracked' || cold.origins?.state !== 'tracked'
          || unsupported.origins?.state !== 'tracked') throw new Error('native partial proof missing');
        const wall = first.origins.bindings.find(binding => binding.state === 'unique'
          && binding.origin.shapeKind === 'face' && binding.origin.identity.kind === 'hole-face'
          && binding.origin.identity.role === 'wall');
        if (wall === undefined) throw new Error('new wall proof missing');
        expect(lookupSubShapeOrigin(cold.origins, wall.origin).status).toBe('matched');
        expect(lookupSubShapeOrigin(unsupported.origins, wall.origin).status).toBe('missing');
        const tables = subShapesOf(unsupported.shape), eligible = unsupported.origins.fingerprintFallback ?? [];
        const cylinder = tables.faces.find(face => face.surfaceKind === 'cylinder');
        if (cylinder === undefined) throw new Error('actual new wall missing');
        expect(eligible.some(region => region.current.kind === 'face' && region.current.index === cylinder.index)).toBe(true);
        const circles = tables.edges.filter(edge => edge.curveKind === 'circle');
        expect(circles).toHaveLength(2);
        for (const rim of circles) expect(eligible.some(region => region.current.kind === 'edge' && region.current.index === rim.index)).toBe(true);
        expect(unsupported.origins.bindings).toEqual([]);
      } finally { unsupported.delete(); cold.delete(); first.delete(); }
    } finally { handle.delete(); }
  });

  it('上の面に φ6 の貫通穴を 1 つあける', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(oc, holeSpec({ face: faceQuery(top) }), handle.shape, faces);
      try {
        // 12000 − π·3²·10 = 11717.256661176919
        expectVolume(measureVolume(oc, result.shape), 12000 - THROUGH_HOLE_VOLUME);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('貫通穴の後の面は 7 枚(箱の 6 面 + 円筒面 1 枚)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(oc, holeSpec({ face: faceQuery(top) }), handle.shape, faces);
      try {
        expect(facesOf(result.shape)).toHaveLength(7);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('中心を離した 4 つの穴を 1 回であける', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(
        oc,
        holeSpec({
          face: faceQuery(top),
          centers: [
            [10, 8, 10],
            [30, 8, 10],
            [10, 22, 10],
            [30, 22, 10],
          ],
        }),
        handle.shape,
        faces,
      );
      try {
        // 12000 − 4·282.743338823 = 10869.026644707674
        expectVolume(measureVolume(oc, result.shape), 12000 - 4 * THROUGH_HOLE_VOLUME);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('深さ 4 の止まり穴は平底で、立体が残る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(oc, holeSpec({ face: faceQuery(top), depth: 4 }), handle.shape, faces);
      try {
        // 12000 − π·3²·4 = 11886.902664470767
        expectVolume(measureVolume(oc, result.shape), 12000 - Math.PI * 3 * 3 * 4);
        expect(hasSolid(oc, result.shape)).toBe(true);
        // 底が平ら(円錐の先端が無い)なので、面は 6 + 円筒 + 底の円 = 8 枚。
        expect(facesOf(result.shape)).toHaveLength(8);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('傾き 0 の穴は、上の面の法線の逆向き([0,0,-1])へ掘る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
      expect(frame.direction[0]).toBeCloseTo(0, 12);
      expect(frame.direction[1]).toBeCloseTo(0, 12);
      expect(frame.direction[2]).toBeCloseTo(-1, 12);
    } finally {
      handle.delete();
    }
  });

  it('下の面を選ぶと、法線の反転が効いて [0,0,1] へ掘る', () => {
    const { handle, faces } = plateWithTopFace();
    try {
      const bottom = planeFacing(faces, [0, 0, -1]);
      const frame = resolveHoleFrame(
        oc,
        handle.shape,
        faces,
        holeSpec({ face: faceQuery(bottom), centers: [[20, 15, 0]] }),
      );
      expect(frame.direction[2]).toBeCloseTo(1, 12);
    } finally {
      handle.delete();
    }
  });

  it('中心の点は面の平面へ投影される(面から 40mm 離れた点でも同じ穴になる)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(
        oc,
        handle.shape,
        faces,
        holeSpec({ face: faceQuery(top), centers: [[20, 15, 50]] }),
      );
      expect(frame.origins).toHaveLength(1);
      expect(frame.origins[0][0]).toBeCloseTo(20, 9);
      expect(frame.origins[0][1]).toBeCloseTo(15, 9);
      expect(frame.origins[0][2]).toBeCloseTo(10, 9);

      const result = makeHole(
        oc,
        holeSpec({ face: faceQuery(top), centers: [[20, 15, 50]] }),
        handle.shape,
        faces,
      );
      try {
        expectVolume(measureVolume(oc, result.shape), 12000 - THROUGH_HOLE_VOLUME);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('傾き 20 度・方位角 0 の穴は、面の第 1 軸(上の面では +X)へ倒れる', () => {
    const { handle, faces, top } = plateWithTopFace();
    const tilt = (20 * Math.PI) / 180;
    try {
      const spec = holeSpec({ face: faceQuery(top), tiltAngle: tilt, tiltAzimuth: 0 });
      const frame = resolveHoleFrame(oc, handle.shape, faces, spec);
      expect(frame.direction[0]).toBeCloseTo(Math.sin(tilt), 12);
      expect(frame.direction[1]).toBeCloseTo(0, 12);
      expect(frame.direction[2]).toBeCloseTo(-Math.cos(tilt), 12);

      const result = makeHole(oc, spec, handle.shape, faces);
      try {
        // 斜めに貫く円柱が削る量は π r² × 板厚 / cos(傾き)。
        expectVolume(measureVolume(oc, result.shape), 12000 - THROUGH_HOLE_VOLUME / Math.cos(tilt));
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('方位角 90 度では第 2 軸(上の面では +Y)へ倒れる', () => {
    const { handle, faces, top } = plateWithTopFace();
    const tilt = (20 * Math.PI) / 180;
    try {
      const frame = resolveHoleFrame(
        oc,
        handle.shape,
        faces,
        holeSpec({ face: faceQuery(top), tiltAngle: tilt, tiltAzimuth: Math.PI / 2 }),
      );
      expect(frame.direction[0]).toBeCloseTo(0, 12);
      expect(frame.direction[1]).toBeCloseTo(Math.sin(tilt), 12);
      expect(frame.direction[2]).toBeCloseTo(-Math.cos(tilt), 12);
    } finally {
      handle.delete();
    }
  });

  it('中心が 1 つも無ければ断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), centers: [] }), handle.shape, faces),
      ).toThrow(/穴の中心になる点/);
    } finally {
      handle.delete();
    }
  });

  it('中心の座標が数でなければ断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), centers: [[Number.NaN, 15, 10]] }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴の中心の位置が数になっていません/);
    } finally {
      handle.delete();
    }
  });

  it('直径が 0 なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), diameter: 0 }), handle.shape, faces),
      ).toThrow(/穴の直径は 0 より大きい/);
    } finally {
      handle.delete();
    }
  });

  it('止まり穴の深さが 0 なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), depth: 0 }), handle.shape, faces),
      ).toThrow(/穴の深さは 0 より大きい/);
    } finally {
      handle.delete();
    }
  });

  it('傾き角が 90 度以上・負なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), tiltAngle: Math.PI / 2 }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴の傾きは 0 度以上 90 度未満/);
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), tiltAngle: -0.1 }), handle.shape, faces),
      ).toThrow(/穴の傾きは 0 度以上 90 度未満/);
    } finally {
      handle.delete();
    }
  });

  it('方位角が数でなければ断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), tiltAzimuth: Number.POSITIVE_INFINITY }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴の傾きの向きは数/);
    } finally {
      handle.delete();
    }
  });

  it('板より大きい径(φ100)の貫通穴は「立体が残らない」と断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), diameter: 100 }), handle.shape, faces),
      ).toThrow(/立体が残りませんでした/);
    } finally {
      handle.delete();
    }
  });

  it('材料に当たらない位置の穴は「当たらなかった」と断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), centers: [[100, 15, 10]] }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴が材料に当たりませんでした/);
    } finally {
      handle.delete();
    }
  });

  it('指紋が合わない(面積を 100 倍にした)ときは面が見つからないと断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const stale = { ...faceQuery(top), area: top.area * 100, index: 99 };
      expect(() => makeHole(oc, holeSpec({ face: stale }), handle.shape, faces)).toThrow(
        /もとの面が見つかりません/,
      );
    } finally {
      handle.delete();
    }
  });

  it('面以外(辺)の指紋も、面が見つからないと断る', () => {
    const { handle, faces } = plateWithTopFace();
    try {
      const edgeQuery: SubShapeQuery = {
        kind: 'edge',
        index: 0,
        curveKind: 'line',
        length: 40,
        position: [20, 0, 0],
        axis: [1, 0, 0],
        radius: null,
      };
      expect(() => makeHole(oc, holeSpec({ face: edgeQuery }), handle.shape, faces)).toThrow(
        /もとの面が見つかりません/,
      );
    } finally {
      handle.delete();
    }
  });

  it('円柱の側面(平らでない面)を指す指紋は断る', () => {
    // 半径 20 の円を Z へ 5 押し出した円柱。側面は surfaceKind = 'cylinder'。
    const handle = makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 20,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        },
      ],
      direction: [0, 0, 1],
      distance: 5,
    });
    try {
      const faces = facesOf(handle.shape);
      const side = faces.find((face) => face.surfaceKind === 'cylinder');
      expect(side).toBeDefined();
      if (side === undefined) {
        return;
      }
      expect(() => makeHole(oc, holeSpec({ face: faceQuery(side) }), handle.shape, faces)).toThrow(
        /平らな面だけです/,
      );
    } finally {
      handle.delete();
    }
  });

  /**
   * パターンの通し(§0.a-0.20、タスク9)。
   *
   * パターンは**もとの穴のボディを消費して、変換した工具を n−1 組ぶん追加で差し引く**ので、
   * ここでも「①穴を 1 つあける → ②その結果を対象に、変換つきで同じ穴をあける」という
   * 本番と同じ 2 段で確かめる。②の面の指紋は①の結果から取り直す(UI が選び直すのと同じ)。
   */
  function drillThenPattern(
    box: { dx: number; dy: number; dz: number },
    center: Vec3Tuple,
    diameter: number,
    transforms: readonly RigidTransformSpec[],
  ): number {
    const handle = makeBox(oc, box);
    try {
      const first = facesOf(handle.shape);
      const firstResult = makeHole(
        oc,
        holeSpec({ face: faceQuery(planeFacing(first, [0, 0, 1])), centers: [center], diameter }),
        handle.shape,
        first,
      );
      try {
        const second = facesOf(firstResult.shape);
        const patterned = makeHole(
          oc,
          holeSpec({
            face: faceQuery(planeFacing(second, [0, 0, 1])),
            centers: [center],
            diameter,
            transforms,
          }),
          firstResult.shape,
          second,
        );
        try {
          expect(hasSolid(oc, patterned.shape)).toBe(true);
          expect(isValidShape(oc, patterned.shape)).toBe(true);
          return measureVolume(oc, patterned.shape);
        } finally {
          patterned.delete();
        }
      } finally {
        firstResult.delete();
      }
    } finally {
      handle.delete();
    }
  }

  it('直線パターン: 60×20×10 の板に φ6 の貫通穴を 20mm 間隔で 3 つ', () => {
    const volume = drillThenPattern({ dx: 60, dy: 20, dz: 10 }, [10, 10, 10], 6, [
      {
        translation: [20, 0, 0],
        rotationOrigin: [0, 0, 0],
        rotationAxis: [0, 0, 1],
        rotationAngle: 0,
      },
      {
        translation: [40, 0, 0],
        rotationOrigin: [0, 0, 0],
        rotationAxis: [0, 0, 1],
        rotationAngle: 0,
      },
    ]);
    // 12000 − 3·π·3²·10 = 11151.769983531
    expectVolume(volume, 12000 - 3 * THROUGH_HOLE_VOLUME);
  });

  it('円形パターン: 100×100×10 の板に φ5 の貫通穴を Z 軸まわり 90 度刻みで 4 つ', () => {
    const quarter = Math.PI / 2;
    const volume = drillThenPattern({ dx: 100, dy: 100, dz: 10 }, [70, 50, 10], 5, [
      {
        translation: [0, 0, 0],
        rotationOrigin: [50, 50, 0],
        rotationAxis: [0, 0, 1],
        rotationAngle: quarter,
      },
      {
        translation: [0, 0, 0],
        rotationOrigin: [50, 50, 0],
        rotationAxis: [0, 0, 1],
        rotationAngle: 2 * quarter,
      },
      {
        translation: [0, 0, 0],
        rotationOrigin: [50, 50, 0],
        rotationAxis: [0, 0, 1],
        rotationAngle: 3 * quarter,
      },
    ]);
    // 100000 − 4·π·2.5²·10 = 99214.601836603
    expectVolume(volume, 100000 - 4 * Math.PI * 2.5 * 2.5 * 10);
  });

  it('makeHoleTools は変換の数だけ円柱を作る(空なら恒等 1 つ)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
      const single = makeHoleTools(oc, frame, 6, 4, []);
      const doubled = makeHoleTools(oc, frame, 6, 4, [
        {
          translation: [0, 0, 0],
          rotationOrigin: [0, 0, 0],
          rotationAxis: [0, 0, 1],
          rotationAngle: 0,
        },
        {
          translation: [10, 0, 0],
          rotationOrigin: [0, 0, 0],
          rotationAxis: [0, 0, 1],
          rotationAngle: 0,
        },
      ]);
      try {
        const one = measureVolume(oc, single.shape);
        // 離れた 2 本ぶんなので、コンパウンドの体積はちょうど 2 倍になる。
        expectVolume(measureVolume(oc, doubled.shape), one * 2);
      } finally {
        doubled.delete();
        single.delete();
      }
    } finally {
      handle.delete();
    }
  });

  describe('入口の形(ざぐり・皿もみ、FR-422、計画書 P5 タスク40)', () => {
    const COUNTERBORE: HoleEntrySpec = { kind: 'counterbore', diameter: 11, depth: 4 };
    /** 90 度皿(開き角)。角度はラジアンで渡す(度からの換算は model の責務)。 */
    const COUNTERSINK: HoleEntrySpec = { kind: 'countersink', diameter: 12, angle: Math.PI / 2 };
    /** 90 度皿・頭径 12・下穴 φ6 の円錐が余分に削る量。π·3/3·(36+18+9) − π·9·3 = π·36。 */
    const COUNTERSINK_EXTRA = Math.PI * 36;

    function drill(entry: HoleEntrySpec, overrides: Partial<HoleStepSpec> = {}): number {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const result = makeHole(
          oc,
          holeSpec({ face: faceQuery(top), ...overrides }),
          handle.shape,
          faces,
          entry,
        );
        try {
          expect(hasSolid(oc, result.shape)).toBe(true);
          expect(isValidShape(oc, result.shape)).toBe(true);
          return measureVolume(oc, result.shape);
        } finally {
          result.delete();
        }
      } finally {
        handle.delete();
      }
    }

    /** 入口の形が使えないときの断り。OCCT を呼ぶ前に落ちるので、板は作らなくてよい。 */
    function expectRejected(entry: HoleEntrySpec, pattern: RegExp): void {
      const { handle, faces, top } = plateWithTopFace();
      try {
        expect(() =>
          makeHole(oc, holeSpec({ face: faceQuery(top) }), handle.shape, faces, entry),
        ).toThrow(pattern);
      } finally {
        handle.delete();
      }
    }

    it('φ6 の貫通穴 + φ11 深さ 4 のざぐり', () => {
      // 12000 − π·9·10 − (π·5.5² − π·9)·4。計画書 タスク40 の期待値は 11450.221285621786 で、
      // この式を倍精度で評価した値(…785)との差は 1e-12 と、固定した ±1e-6 の中に入る
      // (期待値をそのまま数字で書くと丸めで別の値になるため、導出の式で置く)。
      expectVolumeExact(drill(COUNTERBORE), 12000 - Math.PI * 9 * 10 - (Math.PI * 5.5 * 5.5 - Math.PI * 9) * 4);
    });

    it('φ6 の貫通穴 + 90 度・頭径 12 の皿もみ', () => {
      // 12000 − π·9·10 − π·36。計画書 タスク40 の期待値をそのまま置く。
      expectVolumeExact(drill(COUNTERSINK), 11604.159325647686);
      expectVolumeExact(12000 - Math.PI * 9 * 10 - COUNTERSINK_EXTRA, 11604.159325647686);
    });

    it('皿もみが余分に削る量は π·36(貫通穴だけとの差)', () => {
      expectVolumeExact(drill({ kind: 'plain' }) - drill(COUNTERSINK), COUNTERSINK_EXTRA);
      expect(COUNTERSINK_EXTRA).toBeCloseTo(113.09733552923255, 9);
    });

    it('止まり穴にも皿もみが付く(深さ 5 + 90 度・頭径 12)', () => {
      // 12000 − π·9·5 − π·36。皿もみの円錐と下穴が重なっていても二重に引かれない
      // (和で 1 つにまとめてから差し引くため)。
      expectVolumeExact(
        drill(COUNTERSINK, { depth: 5 }),
        12000 - Math.PI * 9 * 5 - COUNTERSINK_EXTRA,
      );
    });

    it('ざぐりの径が穴の径以下なら断る', () => {
      expectRejected(
        { kind: 'counterbore', diameter: 6, depth: 4 },
        /ざぐりの径は穴の径より大きくしてください。/,
      );
      expectRejected(
        { kind: 'counterbore', diameter: Number.NaN, depth: 4 },
        /ざぐりの径は穴の径より大きくしてください。/,
      );
    });

    it('ざぐりの深さが 0 以下・数でなければ断る', () => {
      expectRejected(
        { kind: 'counterbore', diameter: 11, depth: 0 },
        /ざぐりの深さは 0 より大きい数にしてください。/,
      );
      expectRejected(
        { kind: 'counterbore', diameter: 11, depth: Number.POSITIVE_INFINITY },
        /ざぐりの深さは 0 より大きい数にしてください。/,
      );
    });

    it('皿もみの角度が 0 以下・180 度以上・数でなければ断る', () => {
      const message = /皿もみの角度は 0 度より大きく 180 度未満にしてください。/;
      expectRejected({ kind: 'countersink', diameter: 12, angle: 0 }, message);
      expectRejected({ kind: 'countersink', diameter: 12, angle: Math.PI }, message);
      expectRejected({ kind: 'countersink', diameter: 12, angle: Number.NaN }, message);
    });

    it('皿もみの頭の径が穴の径以下なら断る', () => {
      expectRejected(
        { kind: 'countersink', diameter: 6, angle: Math.PI / 2 },
        /皿もみの頭の径は穴の径より大きくしてください。/,
      );
    });

    it('ざぐりつきの工具は下穴と 1 つに融けている(体積が和で説明できる)', () => {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
        const tools = makeHoleTools(oc, frame, 6, null, [], COUNTERBORE);
        try {
          const diagonal = Math.hypot(PLATE.dx, PLATE.dy, PLATE.dz);
          const margin = diagonal * 0.01 + 1;
          // 貫通の円柱 + ざぐりの円柱 − 重なり(ざぐりの中にある下穴のぶん)。
          // 重なったままコンパウンドへ入れていたら、この和より大きい値になる。
          expectVolume(
            measureVolume(oc, tools.shape),
            Math.PI * 9 * (diagonal + 2 * margin) +
              Math.PI * 5.5 * 5.5 * (4 + margin) -
              Math.PI * 9 * (4 + margin),
          );
        } finally {
          tools.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('ざぐりつきでも変換(パターン)の数だけ工具が作られる', () => {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
        const single = makeHoleTools(oc, frame, 6, null, [], COUNTERBORE);
        const doubled = makeHoleTools(
          oc,
          frame,
          6,
          null,
          [
            {
              translation: [0, 0, 0],
              rotationOrigin: [0, 0, 0],
              rotationAxis: [0, 0, 1],
              rotationAngle: 0,
            },
            {
              translation: [15, 0, 0],
              rotationOrigin: [0, 0, 0],
              rotationAxis: [0, 0, 1],
              rotationAngle: 0,
            },
          ],
          COUNTERBORE,
        );
        try {
          expectVolume(measureVolume(oc, doubled.shape), measureVolume(oc, single.shape) * 2);
        } finally {
          doubled.delete();
          single.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('入口の形を省くと今までどおりの真っ直ぐな穴になる', () => {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
        const omitted = makeHoleTools(oc, frame, 6, 4, []);
        const plain = makeHoleTools(oc, frame, 6, 4, [], { kind: 'plain' });
        try {
          expectVolume(measureVolume(oc, omitted.shape), measureVolume(oc, plain.shape));
        } finally {
          plain.delete();
          omitted.delete();
        }
      } finally {
        handle.delete();
      }
    });
  });

  it('makeHoleTools は貫通で 1 本、止まり穴でも 1 本の円柱を作る(長さが違う)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
      const through = makeHoleTools(oc, frame, 6, null, []);
      const blind = makeHoleTools(oc, frame, 6, 4, []);
      try {
        // 対角長 √2600 = 50.990195…、margin = 0.5099… + 1 = 1.5099…
        const diagonal = Math.hypot(PLATE.dx, PLATE.dy, PLATE.dz);
        const margin = diagonal * 0.01 + 1;
        expectVolume(measureVolume(oc, through.shape), Math.PI * 9 * (diagonal + 2 * margin));
        expectVolume(measureVolume(oc, blind.shape), Math.PI * 9 * (4 + margin));
      } finally {
        blind.delete();
        through.delete();
      }
    } finally {
      handle.delete();
    }
  });
});

/**
 * 円筒の側面の穴(EX05)。期待値は幾何から先に決める(実行の結果に合わせて緩めない)。
 *
 * 半径 R の円筒(軸 z)を、軸と直交して軸を通る半径 r の穴(軸 y)が抜けると、削れるのは
 * x² + z² ≤ r² かつ x² + y² ≤ R² の部分で、その体積は 4∫_{-r}^{r} √(r² − x²)·√(R² − x²) dx。
 * この積分 L(r, R) = ∫ √(r² − x²)√(R² − x²) dx を x = r·sin t で滑らかにし、Simpson 則(4000 区間、
 * 誤差は相対 1e-12 より小さい)で求める。ほかの形も同じ積分から導く:
 * - 中実の円筒の貫通: 4L(r, R)
 * - 外面から深さ d の止まり穴(底は軸から R − d、R² − r² ≥ (R − d)² のとき): 2L(r, R) − (R − d)πr²
 * - 管(外 R、内 Ri)の外面からの貫通(両方の壁): 4(L(r, R) − L(r, Ri))
 * - 管の内面からの貫通(外へ向かうので近い側の壁だけ): 2(L(r, R) − L(r, Ri))
 * - 管の内面から深さ d の止まり穴(Ri + d ≤ √(R² − r²) のとき): (Ri + d)πr² − 2L(r, Ri)
 *
 * 体積の許容は**相対 1e-6** に固定する。円柱どうしの交線は OCCT が許容 1e-7 mm ほどの B スプラインで
 * 近似するので、面で囲む体積はこの近似の分だけずれる(平面の穴の 1e-9 より粗い理由)。位置と向きの
 * 許容は 1e-7 mm(kernel の CYLINDER_LINEAR_TOLERANCE と同じ物差し)と、単位ベクトルの成分で 1e-9。
 */
describe('円筒の側面の穴(EX05)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  const CYLINDER_VOLUME_RELATIVE = 1e-6;
  const POSITION_TOLERANCE = 1e-7;
  const DIRECTION_TOLERANCE = 1e-9;

  function lens(r: number, radius: number): number {
    const intervals = 4000;
    const step = Math.PI / intervals;
    let sum = 0;
    for (let i = 0; i <= intervals; i += 1) {
      const t = -Math.PI / 2 + i * step;
      const value = r * r * Math.cos(t) ** 2 * Math.sqrt(radius * radius - r * r * Math.sin(t) ** 2);
      sum += (i === 0 || i === intervals ? 1 : i % 2 === 1 ? 4 : 2) * value;
    }
    return (sum * step) / 3;
  }

  function expectCylinderVolume(actual: number, expected: number): void {
    expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(CYLINDER_VOLUME_RELATIVE);
  }

  /**
   * 体積は誤差を見積もる積分 BRepGProp.VolumeProperties_2(相対 Eps)で測る。製品の measureVolume は
   * VolumeProperties_1(固定次数の Gauss 積分、誤差の管理なし)で、円柱どうしの交線(B スプライン)で囲まれた面では
   * 解析値から相対 2.7e-6・1.6e-6 ずれた(freeze-3 の実測)。切った形そのものの誤差(交線の近似 1e-7 mm 程度 ×
   * 穴の壁の面積)は体積の 1e-8 より小さいので、判定の 1e-6 は変えず、測り方だけを誤差の分かる積分にする。
   * 積分が自分で見積もった誤差も 1e-8 未満であることを求める(届かなければ試験は落ちる)。
   */
  const ADAPTIVE_EPS = 1e-9;
  const ADAPTIVE_ERROR_LIMIT = 1e-8;
  function adaptiveVolume(shape: Parameters<typeof measureVolume>[1]): number {
    const properties = new oc.GProp_GProps_1();
    try {
      const error = oc.BRepGProp.VolumeProperties_2(shape, properties, ADAPTIVE_EPS, false, false);
      expect(Math.abs(error)).toBeLessThan(ADAPTIVE_ERROR_LIMIT);
      return properties.Mass();
    } finally {
      properties.delete();
    }
  }

  function facesOf(shape: Parameters<typeof collectSubShapes>[1]): readonly SolidFaceInfo[] {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges).faces;
  }

  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return { kind: 'face', index: info.index, surfaceKind: info.surfaceKind, area: info.area,
      position: info.centroid, axis: info.axis, radius: info.radius };
  }

  /** 半径が radius の円筒の面を 1 枚選ぶ(管の外面と内面を半径で見分ける)。 */
  function cylinderFace(faces: readonly SolidFaceInfo[], radius: number): SolidFaceInfo {
    const found = faces.filter((face) => face.surfaceKind === 'cylinder' && face.radius !== null
      && Math.abs(face.radius - radius) < 1e-9);
    const face = found[0];
    if (found.length !== 1 || face === undefined) throw new Error(`半径 ${radius} の円筒の面が 1 枚ではありません`);
    return face;
  }

  function cylinderPrimitive(radius: number, height: number, origin: Vec3Tuple, axis: Vec3Tuple): PrimitiveStepSpec {
    return { kind: 'primitive', origin, axis, shape: { kind: 'cylinder', radius, height }, originQuery: null, targetKey: null };
  }

  /** 外 R・内 Ri・高さ H の管(軸 z、底は z = 0)。内側の工具は上下へ 1 mm はみ出させる(面の境界は z = 0〜H)。 */
  function makePipe(outer: number, inner: number, height: number): OcctShapeHandle {
    const body = makePrimitive(oc, cylinderPrimitive(outer, height, [0, 0, 0], [0, 0, 1]));
    const bore = makePrimitive(oc, cylinderPrimitive(inner, height + 2, [0, 0, -1], [0, 0, 1]));
    try {
      return booleanOp(oc, 'subtract', body.shape, bore.shape);
    } finally {
      bore.delete();
      body.delete();
    }
  }

  function spec(face: SubShapeQuery, locations: readonly { height: number; angle: number }[],
    overrides: Partial<HoleStepSpec> = {}): HoleStepSpec {
    return { kind: 'hole', targetKey: 'target', face, centers: [], diameter: 4, depth: null, tiltAngle: 0, tiltAzimuth: 0,
      transforms: [], cylindrical: { kind: 'cylinder-face', locations }, ...overrides };
  }

  function sub(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dotOf(a: Vec3Tuple, b: Vec3Tuple): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function crossOf(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function scaled(a: Vec3Tuple, s: number): Vec3Tuple { return [a[0] * s, a[1] * s, a[2] * s]; }
  function expectVectorClose(actual: Vec3Tuple, expected: Vec3Tuple, tolerance: number): void {
    expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2])).toBeLessThan(tolerance);
  }

  /** 入口の点の、軸からの放射方向(単位)。高さは軸の原点 base から axis に沿って測った値。 */
  function radialAt(origin: Vec3Tuple, base: Vec3Tuple, axis: Vec3Tuple, height: number, radius: number): Vec3Tuple {
    return scaled(sub(sub(origin, base), scaled(axis, height)), 1 / radius);
  }

  it('preserves nested borrowed topology and releases owned copies on success, refusal and native failure', () => {
    for (const mode of ['success', 'grazing', 'disjoint', 'native-failure'] as const) {
      const sourceOwned = allocationModule.createAllocations();
      const entries: { item: { delete(): void }; deleted: number }[] = [];
      let result: ReturnType<typeof makeHole> | undefined;
      try {
        const radius = 10, height = 40, boreRadius = 2;
        const base: Vec3Tuple = [0, 0, 0], axis: Vec3Tuple = [0, 0, 1];
        const cylinder = sourceOwned.keep(makePrimitive(oc, cylinderPrimitive(radius, height, base, axis)));
        const builder = sourceOwned.keep(new oc.BRep_Builder());
        const inner = sourceOwned.keep(new oc.TopoDS_Compound());
        const target = sourceOwned.keep(new oc.TopoDS_Compound());
        builder.MakeCompound(inner); builder.Add(inner, cylinder.shape);
        builder.MakeCompound(target); builder.Add(target, inner);
        const faces = facesOf(target), side = faceQuery(cylinderFace(faces, radius));
        const holes = spec(side, [{ height: height / 2, angle: 0 }], { diameter: 2 * boreRadius });
        const frame = resolveHoleFrame(oc, target, faces, holes);
        const origin = frame.origins[0];
        if (origin === undefined) throw new Error('Missing nested radial hole origin');
        const tangent = crossOf(axis, radialAt(origin, base, axis, height / 2, radius));
        const offset = mode === 'grazing' ? radius + boreRadius : mode === 'disjoint' ? radius + boreRadius + 1 : 0;
        const operation = { ...holes, transforms: [{ translation: scaled(tangent, offset),
          rotationOrigin: base, rotationAxis: axis, rotationAngle: 0 }] };
        const saved = JSON.stringify(operation), frameBefore = JSON.stringify(frame);
        const bytesBefore = writeBrepBytes(oc, target);
        const flagsBefore = [target.Free_1(), inner.Free_1(), cylinder.shape.Free_1()];
        const create = allocationModule.createAllocations;
        vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
          const owned = create();
          return {
            keep<T extends { delete(): void }>(item: T): T {
              const entry = { item, deleted: 0 }, release = item.delete.bind(item);
              item.delete = (): void => { entry.deleted += 1; release(); };
              entries.push(entry);
              return owned.keep(item);
            },
            release: owned.release,
          };
        });
        if (mode === 'native-failure') {
          vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, 'Build').mockImplementation(() => {
            throw new Error('r833 injected native cut failure');
          });
          expect(() => makeHole(oc, operation, target, faces)).toThrow(/穴をあけられませんでした/);
        } else if (mode === 'success') {
          result = makeHole(oc, operation, target, faces);
          expectCylinderVolume(Math.PI * radius ** 2 * height - adaptiveVolume(result.shape), 4 * lens(boreRadius, radius));
          expect(isValidShape(oc, result.shape)).toBe(true);
          result.delete(); result = undefined;
        } else {
          expect(() => makeHole(oc, operation, target, faces)).toThrow(/穴が材料に当たりませんでした/);
        }
        expect(writeBrepBytes(oc, target)).toEqual(bytesBefore);
        expect([target.Free_1(), inner.Free_1(), cylinder.shape.Free_1()]).toEqual(flagsBefore);
        expectCylinderVolume(adaptiveVolume(target), Math.PI * radius ** 2 * height);
        expect(JSON.stringify(resolveHoleFrame(oc, target, faces, holes))).toBe(frameBefore);
        expect(JSON.stringify(operation)).toBe(saved);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every(entry => entry.deleted === 1)).toBe(true);
      } finally {
        try { result?.delete(); }
        finally { vi.restoreAllMocks(); sourceOwned.release(); }
      }
    }
  });

  it('rejects an exactly grazing radial hole tool and preserves the cylinder before a real cut', () => {
    const radius = 10, height = 40, boreRadius = 2;
    const base: Vec3Tuple = [0, 0, 0];
    const axis: Vec3Tuple = [0, 0, 1];
    const target = makePrimitive(oc, cylinderPrimitive(radius, height, base, axis));
    try {
      const faces = facesOf(target.shape);
      const side = faceQuery(cylinderFace(faces, radius));
      const holes = spec(side, [{ height: height / 2, angle: 0 }], { diameter: 2 * boreRadius });
      const savedSpec = JSON.stringify(holes);
      const frame = resolveHoleFrame(oc, target.shape, faces, holes);
      const origin = frame.origins[0];
      if (origin === undefined) throw new Error('Missing radial hole origin');
      const tangent = crossOf(axis, radialAt(origin, base, axis, height / 2, radius));
      const originalBrep = writeBrepBytes(oc, target.shape);
      const originalVolume = Math.PI * radius ** 2 * height;
      // In radial coordinates the body has x*x+y*y <= R*R. A tool shifted
      // along y has (y-offset)^2+(z-H/2)^2 <= r*r. At offset R+r the
      // only contact is x=0,y=R,z=H/2: zero common volume, not a hole.
      for (const offset of [radius + boreRadius, radius + boreRadius + 1]) {
        const shifted = { ...holes, transforms: [{
          translation: scaled(tangent, offset), rotationOrigin: base,
          rotationAxis: axis, rotationAngle: 0,
        }] };
        expect(() => {
          const unexpected = makeHole(oc, shifted, target.shape, faces);
          unexpected.delete();
        }).toThrow(/穴が材料に当たりませんでした/);
        expect(writeBrepBytes(oc, target.shape)).toEqual(originalBrep);
        expectCylinderVolume(adaptiveVolume(target.shape), originalVolume);
        expect(isValidShape(oc, target.shape)).toBe(true);
        expect(JSON.stringify(holes)).toBe(savedSpec);
      }
      // Positive control: no shift gives the perpendicular-cylinder intersection
      // 4*integral[-r,r] sqrt(r*r-y*y)*sqrt(R*R-y*y) dy, independent of makeHole.
      const output = makeHole(oc, holes, target.shape, faces);
      try {
        const removed = originalVolume - adaptiveVolume(output.shape);
        expect(Number.isFinite(removed)).toBe(true);
        expect(removed).toBeGreaterThan(0);
        expectCylinderVolume(removed, 4 * lens(boreRadius, radius));
        expect(isValidShape(oc, output.shape)).toBe(true);
      } finally {
        output.delete();
      }
      expect(writeBrepBytes(oc, target.shape)).toEqual(originalBrep);
      expect(JSON.stringify(holes)).toBe(savedSpec);
    } finally {
      target.delete();
    }
  });

  it('回した円筒の 2 つの角度に、別々の放射方向の貫通穴を 1 回の差で掘る', () => {
    const base: Vec3Tuple = [5, -3, 2];
    const axis: Vec3Tuple = [1 / 3, 2 / 3, 2 / 3];
    const radius = 10;
    const target = makePrimitive(oc, cylinderPrimitive(radius, 40, base, [1, 2, 2]));
    try {
      const faces = facesOf(target.shape);
      const side = cylinderFace(faces, radius);
      const holes = spec(faceQuery(side), [{ height: 12, angle: 0 }, { height: 28, angle: Math.PI / 2 }]);
      const frame = resolveHoleFrame(oc, target.shape, faces, holes);
      const directions = frame.directions;
      if (directions === undefined) throw new Error('位置ごとの向きがありません');
      expect(frame.origins).toHaveLength(2);
      expect(directions).toHaveLength(2);
      expect(frame.concaveRadii).toEqual([null, null]);
      const radials = [12, 28].map((height, index) => {
        const origin = frame.origins[index];
        const direction = directions[index];
        if (origin === undefined || direction === undefined) throw new Error('位置が足りません');
        // 入口は面の上(軸から R)、高さは底から軸に沿って測った値、掘る向きは軸へ向かう放射方向。
        const axial = dotOf(sub(origin, base), axis);
        expect(Math.abs(axial - height)).toBeLessThan(POSITION_TOLERANCE);
        const radial = radialAt(origin, base, axis, height, radius);
        expect(Math.abs(Math.hypot(...radial) - 1)).toBeLessThan(POSITION_TOLERANCE);
        expectVectorClose(direction, scaled(radial, -1), DIRECTION_TOLERANCE);
        return radial;
      });
      const [first, second] = radials;
      if (first === undefined || second === undefined) throw new Error('放射方向が足りません');
      // 角度 0 と 90 度は別の放射方向で、正の向きは軸を親指にした右手の回り(第 2 = 軸 × 第 1)。
      expect(Math.abs(dotOf(first, second))).toBeLessThan(DIRECTION_TOLERANCE);
      expectVectorClose(second, crossOf(axis, first), DIRECTION_TOLERANCE);
      // 1 周回した角度は同じ入口になる。
      const turned = resolveHoleFrame(oc, target.shape, faces, spec(faceQuery(side), [{ height: 12, angle: 2 * Math.PI }]));
      const again = turned.origins[0];
      const original = frame.origins[0];
      if (again === undefined || original === undefined) throw new Error('入口がありません');
      expectVectorClose(again, original, POSITION_TOLERANCE * 100);
      const volume = Math.PI * radius ** 2 * 40;
      const output = makeHole(oc, holes, target.shape, faces);
      try {
        expectCylinderVolume(adaptiveVolume(output.shape), volume - 2 * 4 * lens(2, radius));
        expect(isValidShape(oc, output.shape)).toBe(true);
      } finally {
        output.delete();
      }
      expectCylinderVolume(adaptiveVolume(target.shape), volume);
    } finally {
      target.delete();
    }
  });

  it('外面からの止まり穴は深さで止まり、同じ位置の貫通より少なく削る', () => {
    const radius = 10;
    const target = makePrimitive(oc, cylinderPrimitive(radius, 40, [0, 0, 0], [0, 0, 1]));
    try {
      const faces = facesOf(target.shape);
      const side = faceQuery(cylinderFace(faces, radius));
      const volume = Math.PI * radius ** 2 * 40;
      const blindRemoved = 2 * lens(2, radius) - (radius - 3) * Math.PI * 4;
      const throughRemoved = 4 * lens(2, radius);
      expect(blindRemoved).toBeLessThan(throughRemoved);
      for (const [depth, removed] of [[3, blindRemoved], [null, throughRemoved]] satisfies readonly [number | null, number][]) {
        const output = makeHole(oc, spec(side, [{ height: 20, angle: 1 }], { depth }), target.shape, faces);
        try {
          expectCylinderVolume(adaptiveVolume(output.shape), volume - removed);
          expect(isValidShape(oc, output.shape)).toBe(true);
        } finally {
          output.delete();
        }
      }
    } finally {
      target.delete();
    }
  });

  it('管の外面は両方の壁を、内面は外へ向かって近い側の壁を削り、内面の高さは面の下側の境界から測る', () => {
    const outer = 10, inner = 7;
    const pipe = makePipe(outer, inner, 40);
    try {
      const faces = facesOf(pipe.shape);
      const volume = Math.PI * (outer ** 2 - inner ** 2) * 40;
      expectCylinderVolume(adaptiveVolume(pipe.shape), volume);
      const wall = lens(2, outer) - lens(2, inner);
      const innerFace = faceQuery(cylinderFace(faces, inner));
      const frame = resolveHoleFrame(oc, pipe.shape, faces, spec(innerFace, [{ height: 20, angle: 0.3 }]));
      const origin = frame.origins[0];
      const direction = frame.directions?.[0];
      if (origin === undefined || direction === undefined) throw new Error('内面の入口がありません');
      // 内側の工具は z = −1 から始まるが、面の境界は z = 0 なので入口は z = 20。
      expect(Math.abs(origin[2] - 20)).toBeLessThan(POSITION_TOLERANCE);
      expect(Math.abs(Math.hypot(origin[0], origin[1]) - inner)).toBeLessThan(POSITION_TOLERANCE);
      expectVectorClose(direction, [origin[0] / inner, origin[1] / inner, 0], DIRECTION_TOLERANCE);
      expect(frame.concaveRadii).toEqual([inner]);
      const cases: readonly { face: SubShapeQuery; depth: number | null; removed: number }[] = [
        { face: faceQuery(cylinderFace(faces, outer)), depth: null, removed: 4 * wall },
        { face: innerFace, depth: null, removed: 2 * wall },
        { face: innerFace, depth: 1.5, removed: (inner + 1.5) * Math.PI * 4 - 2 * lens(2, inner) },
      ];
      for (const item of cases) {
        const output = makeHole(oc, spec(item.face, [{ height: 20, angle: 0.3 }], { depth: item.depth }), pipe.shape, faces);
        try {
          expectCylinderVolume(adaptiveVolume(output.shape), volume - item.removed);
          expect(isValidShape(oc, output.shape)).toBe(true);
        } finally {
          output.delete();
        }
      }
    } finally {
      pipe.delete();
    }
  });

  it('細い空洞の内面からの止まり穴は、余裕が空洞より大きくても反対側の壁を削らない(EX05 で直した欠陥)', () => {
    // 対角 √(80² + 80² + 202²) ≈ 231.6 なので margin ≈ 3.3 mm。直す前は戻りが Ri + √(Ri² − r²) ≈ 2.62 mm を
    // 越えて反対側の壁まで削っていた。
    const outer = 40, inner = 1.5;
    const pipe = makePipe(outer, inner, 200);
    try {
      const faces = facesOf(pipe.shape);
      const volume = Math.PI * (outer ** 2 - inner ** 2) * 200;
      const innerFace = faceQuery(cylinderFace(faces, inner));
      const output = makeHole(oc, spec(innerFace, [{ height: 100, angle: 2 }], { diameter: 2, depth: 2 }), pipe.shape, faces);
      try {
        expectCylinderVolume(adaptiveVolume(output.shape), volume - ((inner + 2) * Math.PI - 2 * lens(1, inner)));
        expect(isValidShape(oc, output.shape)).toBe(true);
      } finally {
        output.delete();
      }
      expect(() => makeHole(oc, spec(innerFace, [{ height: 100, angle: 2 }], { diameter: 3, depth: 2 }), pipe.shape, faces))
        .toThrow(/内面の直径以上/);
    } finally {
      pipe.delete();
    }
  });

  it('角度の窓が半分の面では、窓の外の角度を断り、窓の中の入口だけを返す', () => {
    const radius = 10;
    const body = makePrimitive(oc, cylinderPrimitive(radius, 40, [0, 0, 0], [0, 0, 1]));
    const moved = makePrimitive(oc, { kind: 'primitive', origin: [15, 0, 20], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 30, sizeY: 60, sizeZ: 60 }, originQuery: null, targetKey: null });
    try {
      // x > 0 の半分を取り除いた半円柱。残る円筒の面は x ≤ 0 の半分だけ。
      const half = booleanOp(oc, 'subtract', body.shape, moved.shape);
      try {
        const faces = facesOf(half.shape);
        const side = faceQuery(cylinderFace(faces, radius));
        let accepted = 0;
        for (let k = 0; k < 36; k += 1) {
          const angle = ((5 + 10 * k) * Math.PI) / 180;
          let origin: Vec3Tuple | undefined;
          try {
            origin = resolveHoleFrame(oc, half.shape, faces, spec(side, [{ height: 20, angle }])).origins[0];
          } catch (error) {
            expect(String(error)).toMatch(/面の外です/);
            continue;
          }
          if (origin === undefined) throw new Error('入口がありません');
          expect(origin[0]).toBeLessThan(-POSITION_TOLERANCE);
          accepted += 1;
        }
        // 等間隔の 36 本のうち、長さ π の窓に入るのはちょうど 18 本(境界に乗る角度は無い)。
        expect(accepted).toBe(18);
        expect(isValidShape(oc, half.shape)).toBe(true);
      } finally {
        half.delete();
      }
    } finally {
      moved.delete();
      body.delete();
    }
  });

  it('面の外・境界の上・数でない値・古い参照・円筒でない面・使えない組み合わせを、形を変えずに断る', () => {
    const radius = 10;
    const target = makePrimitive(oc, cylinderPrimitive(radius, 40, [0, 0, 0], [0, 0, 1]));
    const elsewhere = makePrimitive(oc, cylinderPrimitive(3, 5, [300, 300, 300], [0, 1, 0]));
    try {
      const faces = facesOf(target.shape);
      const sideInfo = cylinderFace(faces, radius);
      const side = faceQuery(sideInfo);
      const plane = faces.find((face) => face.surfaceKind === 'plane');
      if (plane === undefined) throw new Error('平面の面がありません');
      const stale = faceQuery(cylinderFace(facesOf(elsewhere.shape), 3));
      const refusals: readonly [HoleStepSpec, RegExp][] = [
        [spec(side, [{ height: 41, angle: 0 }]), /面の外です/],
        [spec(side, [{ height: -1, angle: 0 }]), /面の外です/],
        [spec(side, [{ height: 0, angle: 0 }]), /面の外です/],
        [spec(side, [{ height: 40, angle: 0 }]), /面の外です/],
        [spec(side, [{ height: Number.NaN, angle: 0 }]), /数にしてください/],
        [spec(side, [{ height: 10, angle: Number.POSITIVE_INFINITY }]), /数にしてください/],
        [spec(side, []), /1 つもありません/],
        [spec(stale, [{ height: 2, angle: 0 }]), /もとの面が見つかりません/],
        [spec(faceQuery(plane), [{ height: 10, angle: 0 }]), /円筒の面だけです/],
        [spec(side, [{ height: 10, angle: 0 }], { centers: [[0, 0, 10]] }), /まだ使えません/],
        [spec(side, [{ height: 10, angle: 0 }], { tiltAngle: 0.1 }), /まだ使えません/],
        [spec(side, [{ height: 10, angle: 0 }], { tiltAzimuth: 0.1 }), /まだ使えません/],
      ];
      for (const [refused, message] of refusals) {
        expect(() => makeHole(oc, refused, target.shape, faces)).toThrow(message);
      }
      expect(() => makeHole(oc, spec(side, [{ height: 10, angle: 0 }]), target.shape, faces,
        { kind: 'countersink', diameter: 8, angle: Math.PI / 2 })).toThrow(/まだ使えません/);
      // 平面の穴は今までどおり円筒の面を断る(円筒の欄が無ければ今までの意味のまま)。
      expect(() => resolveHoleFrame(oc, target.shape, faces, { face: side, centers: [[10, 0, 10]], tiltAngle: 0, tiltAzimuth: 0 }))
        .toThrow(/平らな面だけです/);
      expectCylinderVolume(adaptiveVolume(target.shape), Math.PI * radius ** 2 * 40);
      expect(isValidShape(oc, target.shape)).toBe(true);
    } finally {
      elsewhere.delete();
      target.delete();
    }
  });

  it('円筒外面の座ぐりは入口から測った底で止まり、貫通と止まりの下穴を保持する', () => {
    const radius = 10, height = 40, boreRadius = 2, entryRadius = 4, entryDepth = 2;
    const target = makePrimitive(oc, cylinderPrimitive(radius, height, [5, -3, 2], [1, 2, 2]));
    try {
      const faces = facesOf(target.shape);
      const side = faceQuery(cylinderFace(faces, radius));
      const entryRemoved = 2 * lens(entryRadius, radius) - (radius - entryDepth) * Math.PI * entryRadius ** 2;
      const boreWithinEntry = 2 * lens(boreRadius, radius) - (radius - entryDepth) * Math.PI * boreRadius ** 2;
      for (const [depth, angle, boreRemoved] of [
        [5, 0, 2 * lens(boreRadius, radius) - (radius - 5) * Math.PI * boreRadius ** 2],
        [null, Math.PI / 2, 4 * lens(boreRadius, radius)],
      ] satisfies readonly [number | null, number, number][]) {
        const output = makeHole(oc, spec(side, [{ height: 20, angle }], { depth }), target.shape, faces,
          { kind: 'counterbore', diameter: 2 * entryRadius, depth: entryDepth });
        try {
          expectCylinderVolume(Math.PI * radius ** 2 * height - adaptiveVolume(output.shape),
            boreRemoved + entryRemoved - boreWithinEntry);
          expect(isValidShape(oc, output.shape)).toBe(true);
        } finally {
          output.delete();
        }
      }
      expectCylinderVolume(adaptiveVolume(target.shape), Math.PI * radius ** 2 * height);
    } finally {
      target.delete();
    }
  });

  it.each([
    { outer: 5, inner: 1.5, entryRadius: 1.2, entryDepth: 0.4 },
    { outer: 10, inner: 7, entryRadius: 6, entryDepth: 0.5 },
  ])('内面座ぐりの最大刃径・反対壁・入口からの深さを保つ Ri=$inner', ({ outer, inner, entryRadius, entryDepth }) => {
    // 細い空洞は margin > Ri、太い刃物は入口の盛り上がり > margin。どちらも独立積分と反対壁で確認する。
    const height = 200, boreRadius = 0.5, depth = 2;
    const pipe = makePipe(outer, inner, height);
    try {
      const faces = facesOf(pipe.shape);
      const side = faceQuery(cylinderFace(faces, inner));
      const holes = spec(side, [{ height: height / 2, angle: 2 }], { diameter: 2 * boreRadius, depth });
      const frame = resolveHoleFrame(oc, pipe.shape, faces, holes);
      const direction = frame.directions?.[0];
      if (direction === undefined) throw new Error('内面の工具の向きがありません');
      const output = makeHole(oc, holes, pipe.shape, faces,
        { kind: 'counterbore', diameter: 2 * entryRadius, depth: entryDepth });
      try {
        const expectedRemoved = (inner + entryDepth) * Math.PI * entryRadius ** 2 - 2 * lens(entryRadius, inner)
          + (depth - entryDepth) * Math.PI * boreRadius ** 2;
        expectCylinderVolume(Math.PI * (outer ** 2 - inner ** 2) * height - adaptiveVolume(output.shape), expectedRemoved);
        expect(isValidShape(oc, output.shape)).toBe(true);
        const middle = (outer + inner) / 2;
        const witness = makePrimitive(oc, cylinderPrimitive(0.25, 0.5,
          [-middle * direction[0], -middle * direction[1], height / 2], direction));
        try {
          const retained = booleanOp(oc, 'intersect', output.shape, witness.shape);
          try {
            expectVolumeExact(retained.volume, Math.PI * 0.25 ** 2 * 0.5);
          } finally {
            retained.delete();
          }
        } finally {
          witness.delete();
        }
      } finally {
        output.delete();
      }
      for (const entryDiameter of [2 * inner, 2 * inner + 1]) {
        expect(() => makeHole(oc, holes, pipe.shape, faces,
          { kind: 'counterbore', diameter: entryDiameter, depth: entryDepth })).toThrow(/内面の直径以上/);
      }
      expectCylinderVolume(adaptiveVolume(pipe.shape), Math.PI * (outer ** 2 - inner ** 2) * height);
    } finally {
      pipe.delete();
    }
  });

  it('積分の対照: 穴の無い円筒は誤差を見積もる積分で πR²H に一致する', () => {
    const target = makePrimitive(oc, cylinderPrimitive(10, 40, [5, -3, 2], [1, 2, 2]));
    try {
      expect(Math.abs(adaptiveVolume(target.shape) - Math.PI * 100 * 40) / (Math.PI * 100 * 40)).toBeLessThan(1e-9);
    } finally {
      target.delete();
    }
  });

  it('全周の面の継ぎ目(角度 0・±2π)は面の中として通し、実際の切り口の境界の上と外は断る', () => {
    const radius = 10;
    const base: Vec3Tuple = [0, 0, 0];
    const axis: Vec3Tuple = [0, 0, 1];
    const body = makePrimitive(oc, cylinderPrimitive(radius, 40, base, axis));
    try {
      const faces = facesOf(body.shape);
      const side = faceQuery(cylinderFace(faces, radius));
      const seam = resolveHoleFrame(oc, body.shape, faces,
        spec(side, [{ height: 20, angle: 0 }, { height: 20, angle: 2 * Math.PI }, { height: 20, angle: -2 * Math.PI }]));
      const [zero, plus, minus] = seam.origins;
      if (zero === undefined || plus === undefined || minus === undefined) throw new Error('継ぎ目の入口がありません');
      expectVectorClose(plus, zero, POSITION_TOLERANCE * 100);
      expectVectorClose(minus, zero, POSITION_TOLERANCE * 100);
      // 継ぎ目の放射方向 r0 と、その +90 度の向き n = 軸 × r0。n の側(sin θ > 0)の半分を大きな箱で取り除く。
      const r0 = radialAt(zero, base, axis, 20, radius);
      const n = crossOf(axis, r0);
      const cutter = makePrimitive(oc, { kind: 'primitive', origin: [n[0] * 50, n[1] * 50, 20], axis: n,
        shape: { kind: 'box', sizeX: 100, sizeY: 100, sizeZ: 100 }, originQuery: null, targetKey: null });
      try {
        const half = booleanOp(oc, 'subtract', body.shape, cutter.shape);
        try {
          expect(isValidShape(oc, half.shape)).toBe(true);
          const halfFaces = facesOf(half.shape);
          const halfSide = faceQuery(cylinderFace(halfFaces, radius));
          // θ = 0 と π は切り口の境界の上(片側は取り除いた側)、π/2 は取り除いた側。どれも断る。
          for (const angle of [0, Math.PI, Math.PI / 2]) {
            expect(() => resolveHoleFrame(oc, half.shape, halfFaces, spec(halfSide, [{ height: 20, angle }])))
              .toThrow(/面の外です/);
          }
          const kept = resolveHoleFrame(oc, half.shape, halfFaces, spec(halfSide, [{ height: 20, angle: (3 * Math.PI) / 2 }])).origins[0];
          if (kept === undefined) throw new Error('残った側の入口がありません');
          expectVectorClose(radialAt(kept, base, axis, 20, radius), scaled(n, -1), DIRECTION_TOLERANCE * 100);
        } finally {
          half.delete();
        }
      } finally {
        cutter.delete();
      }
    } finally {
      body.delete();
    }
  });

  it('平面の穴の座標系には位置ごとの向きも凹みの半径も付かない(今までの作りのまま)', () => {
    const plate = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    try {
      const faces = facesOf(plate.shape);
      const top = faces.find((face) => face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[2] - 1) < 1e-9);
      if (top === undefined) throw new Error('上の面がありません');
      const frame = resolveHoleFrame(oc, plate.shape, faces, { face: faceQuery(top), centers: [[20, 15, 10]], tiltAngle: 0, tiltAzimuth: 0 });
      expect(frame.directions).toBeUndefined();
      expect(frame.concaveRadii).toBeUndefined();
      expect(frame.origins).toEqual([[20, 15, 10]]);
    } finally {
      plate.delete();
    }
  });

  describe('independent cylinder oracle (EX05 W1)', () => {
    type Shape = Parameters<typeof collectSubShapes>[1];
    type Machining = 'plain' | 'counterbore' | 'thread' | 'thread-counterbore';

    /** Observe the same ownership boundary as the nested borrowed-topology regression above. */
    function preserving(target: Shape, run: () => void): void {
      const bytes = writeBrepBytes(oc, target);
      const free = target.Free_1();
      const entries: { deleted: number }[] = [];
      const create = allocationModule.createAllocations;
      const spy = vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
        const owned = create();
        return {
          keep<T extends { delete(): void }>(item: T): T {
            const entry = { deleted: 0 }, release = item.delete.bind(item);
            item.delete = (): void => { entry.deleted += 1; release(); };
            entries.push(entry);
            return owned.keep(item);
          },
          release: owned.release,
        };
      });
      try {
        run();
      } finally {
        spy.mockRestore();
        expect(writeBrepBytes(oc, target)).toEqual(bytes);
        expect(target.Free_1()).toBe(free);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.filter(entry => entry.deleted !== 1)).toEqual([]);
      }
    }

    /** Explicit X/Z axes: the expectation never reads an OCCT frame or a product transform. */
    function placedCylinder(matrix: Matrix, translation: Vec3Tuple): OcctShapeHandle {
      const { keep, release } = allocationModule.createAllocations();
      try {
        const axes = keep(new oc.gp_Ax2_2(keep(new oc.gp_Pnt_3(0, 0, -5)),
          keep(new oc.gp_Dir_4(0, 0, 1)), keep(new oc.gp_Dir_4(1, 0, 0))));
        const maker = keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 10, 40));
        const transform = keep(new oc.gp_Trsf_1());
        transform.SetValues(matrix[0][0], matrix[0][1], matrix[0][2], translation[0],
          matrix[1][0], matrix[1][1], matrix[1][2], translation[1],
          matrix[2][0], matrix[2][1], matrix[2][2], translation[2]);
        const moved = keep(new oc.BRepBuilderAPI_Transform_2(keep(maker.Shape()), transform, true));
        return { shape: keep(moved.Shape()), delete: release };
      } catch (error) { release(); throw error; }
    }

    it.each(placements)('independent placement oracle: $name, $degrees degrees', ({ matrix, translation, reflected, degrees }) => {
      const target = placedCylinder(matrix, translation);
      try {
        const faces = facesOf(target.shape), side = faceQuery(cylinderFace(faces, 10));
        preserving(target.shape, () => {
          const angle = degrees * Math.PI / 180, height = 13;
          const { x, y, radial, axialPoint, expected } = cylinderPlacementOracle(matrix, translation, height, angle);
          const holes = spec(side, [{ height, angle }], { depth: 3 });
          const frame = resolveHoleFrame(oc, target.shape, faces, holes);
          const origin = frame.origins[0], direction = frame.directions?.[0];
          if (origin === undefined || direction === undefined) throw new Error('Missing oracle placement');
          expectVectorClose(origin, expected, 1e-6);
          expectVectorClose(direction, scaled(radial, -1), 1e-9);
          const actualRadial = scaled(sub(origin, axialPoint), 0.1);
          const signed = Math.atan2(dotOf(actualRadial, y), dotOf(actualRadial, x));
          const angleError = Math.atan2(Math.sin(signed - angle), Math.cos(signed - angle)) * 180 / Math.PI;
          expect(Math.abs(angleError)).toBeLessThanOrEqual(1e-6);
          if (reflected) {
            // M*y is left-handed after reflection. Using it silently reverses the requested angle.
            const wrong = plus(axialPoint, times(matrix, [10 * Math.cos(angle), 10 * Math.sin(angle), 0]));
            expect(Math.hypot(...sub(origin, wrong))).toBeGreaterThan(10);
            const leftHanded = Math.atan2(dotOf(actualRadial, times(matrix, [0, 1, 0])), dotOf(actualRadial, x));
            expect(Math.abs(Math.atan2(Math.sin(leftHanded + angle), Math.cos(leftHanded + angle)))).toBeLessThan(1e-9);
          }
          const output = makeHole(oc, holes, target.shape, faces);
          try {
            const removed = Math.PI * 100 * 40 - adaptiveVolume(output.shape);
            expectCylinderVolume(removed, radialIntegral(10, 0, 2, 'outer', 3));
            expect(isValidShape(oc, output.shape)).toBe(true);
          } finally { output.delete(); }
        });
      } finally { target.delete(); }
    });

    /**
     * Integrate the radial x-intervals of the annulus over the tool disk in (y,z).
     * y = r sin(t) removes the disk endpoint singularity. Bounds are input dimensions,
     * independent of the generated BRep, product frame, margin and tool construction.
     */
    function radialIntegral(outer: number, inner: number, radius: number, side: 'inner' | 'outer',
      depth: number | null, intervals = 8000): number {
      const low = side === 'inner' ? 0 : depth === null ? -outer : outer - depth;
      const high = side === 'inner' && depth !== null ? inner + depth : outer;
      const overlap = (a: number, b: number) => Math.max(0, Math.min(b, high) - Math.max(a, low));
      const step = Math.PI / intervals;
      let sum = 0;
      for (let i = 0; i <= intervals; i += 1) {
        const t = -Math.PI / 2 + i * step, y = radius * Math.sin(t);
        const outside = Math.sqrt(outer ** 2 - y ** 2);
        const inside = Math.sqrt(Math.max(0, inner ** 2 - y ** 2));
        const width = overlap(-outside, -inside) + overlap(inside, outside);
        const value = 2 * radius ** 2 * Math.cos(t) ** 2 * width;
        sum += (i === 0 || i === intervals ? 1 : i % 2 === 0 ? 2 : 4) * value;
      }
      return sum * step / 3;
    }

    function cut(kind: Machining, holes: HoleStepSpec, target: Shape, faces: readonly SolidFaceInfo[],
      entry: HoleEntrySpec): OcctShapeHandle {
      if (kind === 'plain' || kind === 'counterbore') return makeHole(oc, holes, target, faces, entry);
      const thread: ThreadStepSpec = { ...holes, kind: 'thread', drillDiameter: holes.diameter,
        thread: null, mark: { majorDiameter: 6, length: 1 }, entry };
      const output = makeThreadHole(oc, thread, target, faces);
      try {
        expect(output.marks).toHaveLength(1);
        const mark = output.marks[0];
        if (mark === undefined) throw new Error('Missing radial thread mark');
        const location = holes.cylindrical?.locations[0];
        if (location === undefined || holes.face.kind !== 'face' || holes.face.radius === null) {
          throw new Error('Missing radial thread input');
        }
        const radius = holes.face.radius;
        const radial: Vec3Tuple = [Math.cos(location.angle), Math.sin(location.angle), 0];
        // Default primitive Z frame has X = +X. Patterned cases are checked separately.
        if (holes.transforms.length === 0) {
          expectVectorClose(mark.origin, [radius * radial[0], radius * radial[1], location.height], 1e-6);
          expectVectorClose(mark.direction, scaled(radial, radius === 12 ? 1 : -1), 1e-9);
        }
        return output.handle;
      } catch (error) { output.handle.delete(); throw error; }
    }

    const machining: readonly Machining[] = ['plain', 'counterbore', 'thread', 'thread-counterbore'];
    const matrixCases = machining.flatMap(kind => (['inner', 'outer'] as const).flatMap(side =>
      [4, null].map(depth => ({ kind, side, depth }))));
    it.each(matrixCases)('independent radial volume oracle: $side $kind depth=$depth', ({ kind, side, depth }) => {
      const outer = 20, inner = 12, height = 60;
      const pipe = makePipe(outer, inner, height);
      try {
        const faces = facesOf(pipe.shape), radius = kind.startsWith('thread') ? (6 - 1.0825317547305482) / 2 : 2;
        const query = faceQuery(cylinderFace(faces, side === 'inner' ? inner : outer));
        const entry: HoleEntrySpec = kind.includes('counterbore') ? { kind: 'counterbore', diameter: 8, depth: 2 } : { kind: 'plain' };
        const expectedAt = (intervals: number) => radialIntegral(outer, inner, radius, side, depth, intervals)
          + (entry.kind === 'counterbore' ? radialIntegral(outer, inner, 4, side, 2, intervals)
            - radialIntegral(outer, inner, radius, side, 2, intervals) : 0);
        const expected = expectedAt(8000);
        expect(Math.abs(expected - expectedAt(4000)) / expected).toBeLessThan(1e-10);
        preserving(pipe.shape, () => {
          const output = cut(kind, spec(query, [{ height: 30, angle: -0.7 }], { diameter: 2 * radius, depth }), pipe.shape, faces, entry);
          try {
            const removed = Math.PI * (outer ** 2 - inner ** 2) * height - adaptiveVolume(output.shape);
            expect(removed).toBeGreaterThan(0);
            expectCylinderVolume(removed, expected);
            expect(isValidShape(oc, output.shape)).toBe(true);
          } finally { output.delete(); }
        });
      } finally { pipe.delete(); }
    });

    const modeledCases = (['inner', 'outer'] as const).flatMap(side => [4, null].map(depth => ({ side, depth })));
    it.each(modeledCases)('modeled thread counterbore oracle: $side depth=$depth', ({ side, depth }) => {
      const pipe = makePipe(20, 12, 60);
      try {
        const faces = facesOf(pipe.shape), query = faceQuery(cylinderFace(faces, side === 'inner' ? 12 : 20));
        const wall = (6 - 1.0825317547305482) / 2, crest = 3 - wall;
        // The groove above the drill wall has axial half-width f(r)=0.3*(3-r)/crest.
        // One screw turn has Jacobian r. The counterbore floor clips only its initial
        // half-profile: integral r*(4*pi*f - pi*f*f) dr, wall <= r <= 3.
        // The entire remainder lies inside the annular material and above the blind floor.
        const integralF = 0.3 * crest * (wall / 2 + crest / 6);
        const integralF2 = 0.09 * crest * (wall / 3 + crest / 12);
        const groove = 4 * Math.PI * integralF - Math.PI * integralF2;
        const expected = radialIntegral(20, 12, wall, side, depth)
          + radialIntegral(20, 12, 4, side, 2) - radialIntegral(20, 12, wall, side, 2) + groove;
        preserving(pipe.shape, () => {
          const holes = spec(query, [{ height: 30, angle: -0.7 }], { depth });
          const thread: ThreadStepSpec = { ...holes, kind: 'thread', drillDiameter: 2 * wall,
            entry: { kind: 'counterbore', diameter: 8, depth: 2 }, mark: { majorDiameter: 6, length: 1 },
            thread: { majorDiameter: 6, pitch: 1, length: 1 } };
          const output = makeThreadHole(oc, thread, pipe.shape, faces);
          try {
            const removed = Math.PI * 256 * 60 - adaptiveVolume(output.handle.shape);
            expectCylinderVolume(removed, expected);
            expect(isValidShape(oc, output.handle.shape)).toBe(true);
          } finally { output.handle.delete(); }
        });
      } finally { pipe.delete(); }
    });

    it.each([0.5, null])('wide inner plain oracle: Ri=7 r=6 H=200 depth=%s', depth => {
      const pipe = makePipe(10, 7, 200);
      try {
        const faces = facesOf(pipe.shape), query = faceQuery(cylinderFace(faces, 7));
        const expected = radialIntegral(10, 7, 6, 'inner', depth);
        expect(Math.abs(expected - radialIntegral(10, 7, 6, 'inner', depth, 4000)) / expected).toBeLessThan(1e-10);
        preserving(pipe.shape, () => {
          const output = makeHole(oc, spec(query, [{ height: 100, angle: 0.4 }], { diameter: 12, depth }), pipe.shape, faces);
          try {
            expectCylinderVolume(Math.PI * 51 * 200 - adaptiveVolume(output.shape), expected);
            expect(isValidShape(oc, output.shape)).toBe(true);
          } finally { output.delete(); }
        });
      } finally { pipe.delete(); }
    });

    const epsilon = 1e-6 * Math.PI / 180;
    const seamCases = (['plain', 'counterbore', 'thread'] as const).flatMap(kind =>
      [-2 * Math.PI - epsilon, -epsilon, epsilon, 2 * Math.PI + epsilon].map(angle => ({ kind, angle })));
    it.each(seamCases)('seam epsilon oracle: $kind angle=$angle', ({ kind, angle }) => {
      const target = makePrimitive(oc, cylinderPrimitive(10, 40, [0, 0, 0], [0, 0, 1]));
      try {
        const faces = facesOf(target.shape), query = faceQuery(cylinderFace(faces, 10));
        const entry: HoleEntrySpec = kind === 'counterbore' ? { kind: 'counterbore', diameter: 8, depth: 2 } : { kind: 'plain' };
        const expected = radialIntegral(10, 0, 2, 'outer', 4) + (kind === 'counterbore'
          ? radialIntegral(10, 0, 4, 'outer', 2) - radialIntegral(10, 0, 2, 'outer', 2) : 0);
        preserving(target.shape, () => {
          const output = cut(kind, spec(query, [{ height: 20, angle }], { depth: 4 }), target.shape, faces, entry);
          try {
            const removed = Math.PI * 100 * 40 - adaptiveVolume(output.shape);
            expect(removed).toBeGreaterThan(0);
            expectCylinderVolume(removed, expected);
            expect(isValidShape(oc, output.shape)).toBe(true);
          } finally { output.delete(); }
        });
      } finally { target.delete(); }
    });

    const grazingCases = (['plain', 'counterbore', 'thread'] as const).flatMap(kind => [-1, 1].map(sign => ({ kind, sign })));
    it.each(grazingCases)('grazing epsilon oracle: $kind tangent sign=$sign', ({ kind, sign }) => {
      const target = makePrimitive(oc, cylinderPrimitive(10, 40, [0, 0, 0], [0, 0, 1]));
      try {
        const faces = facesOf(target.shape), query = faceQuery(cylinderFace(faces, 10));
        const radius = kind === 'counterbore' ? 4 : 2;
        // The entry extends past the cylinder axis, so its larger radius is the grazing tool.
        const entry: HoleEntrySpec = kind === 'counterbore' ? { kind: 'counterbore', diameter: 8, depth: 11 } : { kind: 'plain' };
        for (const delta of [0, 1e-6, -1e-6]) {
          preserving(target.shape, () => {
            const holes = spec(query, [{ height: 20, angle: 0 }], { transforms: [{
              translation: [0, sign * (10 + radius + delta), 0], rotationOrigin: [0, 0, 0],
              rotationAxis: [0, 0, 1], rotationAngle: 0,
            }] });
            const run = () => {
              const output = cut(kind, holes, target.shape, faces, entry);
              const owned = allocationModule.createAllocations();
              try {
                expect(Math.PI * 100 * 40 - adaptiveVolume(output.shape)).toBeGreaterThan(0);
                expect(isValidShape(oc, output.shape)).toBe(true);
                const copy = owned.keep(new oc.BRepBuilderAPI_Copy_2(target.shape, true, true));
                const removed = buildBooleanShape(oc, 'subtract', owned.keep(copy.Shape()), [output.shape],
                  owned.keep(new oc.Message_ProgressRange_1()), owned);
                expect(hasSolid(oc, removed)).toBe(true);
                expect(adaptiveVolume(removed)).toBeGreaterThan(0);
              } finally { owned.release(); output.delete(); }
            };
            if (delta >= 0) expect(run).toThrow(/材料に当たりませんでした/);
            else run();
          });
        }
      } finally { target.delete(); }
    });
  });

  it('保存した側面の起点で寸法の変わった円筒の現側面へ掘り、別の立体・失効・分割の起点は断る', () => {
    const old = makePrimitive(oc, cylinderPrimitive(5, 20, [0, 0, 0], [0, 0, 1]), 'side-hole');
    const current = makePrimitive(oc, cylinderPrimitive(8, 30, [100, 0, 0], [0, 0, 1]), 'side-hole');
    const foreign = makePrimitive(oc, cylinderPrimitive(8, 30, [100, 0, 0], [0, 0, 1]), 'other-side-hole');
    try {
      if (old.origins?.state !== 'tracked' || current.origins?.state !== 'tracked' || foreign.origins?.state !== 'tracked') {
        throw new Error('実円筒の起点がありません');
      }
      const currentOrigins = current.origins;
      const sideOf = (origins: typeof currentOrigins) => {
        const found = origins.bindings.find((item) => item.origin.identity.kind === 'cylinder-face' && item.origin.identity.role === 'side');
        if (found?.state !== 'unique' || found.current.kind !== 'face') throw new Error('側面の起点が一意でありません');
        return found;
      };
      const oldSide = sideOf(old.origins);
      const oldFace = facesOf(old.shape).find((face) => face.index === oldSide.current.index);
      if (oldFace === undefined) throw new Error('もとの側面がありません');
      const saved: SubShapeQuery = { ...faceQuery(oldFace), origin: oldSide.origin };
      const faces = facesOf(current.shape);
      const holes = spec(saved, [{ height: 15, angle: 0 }]);
      const frame = resolveHoleFrame(oc, current.shape, faces, holes, currentOrigins);
      const origin = frame.origins[0];
      if (origin === undefined) throw new Error('入口がありません');
      expect(Math.abs(Math.hypot(origin[0] - 100, origin[1]) - 8)).toBeLessThan(POSITION_TOLERANCE);
      expect(Math.abs(origin[2] - 15)).toBeLessThan(POSITION_TOLERANCE);
      const output = makeHole(oc, holes, current.shape, faces, { kind: 'plain' }, currentOrigins);
      try {
        expectCylinderVolume(adaptiveVolume(output.shape), Math.PI * 64 * 30 - 4 * lens(2, 8));
        expect(isValidShape(oc, output.shape)).toBe(true);
      } finally {
        output.delete();
      }
      expect(() => resolveHoleFrame(oc, foreign.shape, facesOf(foreign.shape), holes, foreign.origins))
        .toThrow(/もとの面が見つかりません/);
      const currentSide = sideOf(currentOrigins);
      const otherFace = faces.find((face) => face.index !== currentSide.current.index);
      if (otherFace === undefined) throw new Error('分割の反例の別面がありません');
      for (const changed of [
        { origin: currentSide.origin, state: 'missing' as const, reason: 'deleted' as const },
        { origin: currentSide.origin, state: 'split' as const,
          candidates: [currentSide.current, { kind: 'face' as const, index: otherFace.index }] as const },
      ]) {
        const origins = { version: 1 as const, state: 'tracked' as const,
          bindings: currentOrigins.bindings.map((item) => (item === currentSide ? changed : item)) };
        expect(() => resolveHoleFrame(oc, current.shape, faces, holes, origins)).toThrow(/もとの面が見つかりません/);
      }
    } finally {
      foreign.delete();
      current.delete();
      old.delete();
    }
  });
});
