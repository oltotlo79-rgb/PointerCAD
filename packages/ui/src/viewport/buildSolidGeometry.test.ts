/**
 * `buildSolidGeometry` と、サムネイルの純関数部分(`file/thumbnail.ts`)の検査
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク20)。
 *
 * どちらも three.js にも DOM にも触れないので Node のまま検査できる。
 * サムネイルの検査をここへ同居させているのは、タスク20 で作ってよいファイルが
 * 6 つに限られているため(統括の指示書 §1)。canvas を触る `captureThumbnailPng` は
 * 実ブラウザでしか動かないので、E2E と統括の目視に任せる。
 *
 * P5 タスク7(計画書 docs/plans/P5-高度なソリッド・外観と測定.md)で、箱投影 UV
 * (`buildBoxProjectedUv`、FR-1108)と面のまとまり(FR-1106)の検査を足した。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appearanceFromPreset,
  DEFAULT_APPEARANCE,
  type AppearanceSpec,
  type SolidBody,
} from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { dataUrlToBytes, THUMBNAIL_SIZE, thumbnailFitRect } from '../file/thumbnail.js';
import type { SolidFaceEntry } from '../solid/subShapeSelection.js';

import {
  buildBoxProjectedUv,
  AllocatedBackingRegistrationError,
  buildSolidGeometry,
  DisplayCopyCache,
  distinctBackingBytes,
  EMPTY_SOLID_GEOMETRY,
  solidEmphasisOf,
  type AppearanceInput,
  type BodyAppearanceInput,
  type SolidBodyWithSubShapes,
  type SolidGeometryBundle,
} from './buildSolidGeometry.js';
import { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';

/**
 * 検査用のボディ。三角形の数と稜線の本数だけを指定し、中身は 0 のままにする
 * (組み立てが見ているのは長さと参照だけで、座標の値は見ていない)。
 */
function makeBody(
  featureId: string,
  triangleCount: number,
  edgeCount: number,
  isValid = true,
): SolidBody {
  const indices = new Uint32Array(triangleCount * 3);
  for (let position = 0; position < indices.length; position += 1) {
    indices[position] = position;
  }
  return {
    featureId,
    mesh: {
      positions: new Float32Array(triangleCount * 9),
      normals: new Float32Array(triangleCount * 9),
      indices,
      edgePositions: new Float32Array(edgeCount * 6),
      triangleCount,
    },
    volume: 1000,
    isValid,
    // P3 タスク17 で SolidBody に必須で足された欄。この検査では中身を使わない。
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 数値だけを取り出して比べる(Float32Array の中身は別に確かめる)。 */
function shapeOf(bundle: SolidGeometryBundle): unknown {
  return {
    triangleCount: bundle.triangleCount,
    edgeCount: bundle.edgeCount,
    entries: bundle.entries.map((entry) => ({
      featureId: entry.featureId,
      emphasis: entry.emphasis,
      drawIndex: entry.drawIndex,
      triangleOffset: entry.triangleOffset,
      triangleCount: entry.triangleCount,
      edgeOffset: entry.edgeOffset,
      edgeCount: entry.edgeCount,
    })),
  };
}

describe('buildSolidGeometry(FR-105、FR-106)', () => {
  it.each([0, 1e6, -1e6, 1e9, -1e9])(
    'local patterned triangle keeps a continuous 20 mm phase across a tile boundary at origin %s',
    (originX) => {
      const source = makeBody('phase', 2, 0);
      const positions = Float32Array.from([
        19.99, 0, 0, 20.01, 0, 0, 19.99, 1, 0, 20.01, 1, 0,
      ]);
      const normals = Float32Array.from([
        0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      ]);
      const indices = Uint32Array.from([0, 1, 2, 1, 3, 2]);
      const body: SolidBody = { ...source, mesh: { ...source.mesh, positions, normals, indices },
        coordinateFrame: { space: 'local', origin: [originX, 0, 0], maximumFloat32ErrorMm: 0.01 } };
      const preset = appearanceFromPreset('checkerPlate');
      const patterned: AppearanceSpec = preset.pattern.kind === 'none' ? preset : {
        ...preset, pattern: { ...preset.pattern, spacing: expressionValueFromNumber(20) },
      };
      const appearance: AppearanceInput = {
        defaultAppearance: DEFAULT_APPEARANCE,
        byBody: new Map([['phase', { bodyAppearance: patterned, faceAppearances: new Map() }]]),
      };
      const first = buildSolidGeometry([body], null, [], appearance).entries[0];
      const repeat = buildSolidGeometry([body], 'phase', [], appearance).entries[0];
      expect(repeat.positions).toBe(first.positions);
      expect(repeat.uv).toBe(first.uv);
      expect(first.positions).not.toBe(positions);
      expect(Array.from(first.indices)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(Array.from(indices)).toEqual([0, 1, 2, 1, 3, 2]);
      expect(Array.from(positions)).toEqual([
        19.989999771118164, 0, 0, 20.010000228881836, 0, 0,
        19.989999771118164, 1, 0, 20.010000228881836, 1, 0,
      ]);
      expect(Math.abs((first.uv[0] + first.uv[2]) / 2 - 20)).toBeLessThan(2e-5);
      expect(Math.abs((first.uv[6] + first.uv[10]) / 2)).toBeLessThan(2e-5);
      expect(first.groups).toEqual([{ start: 0, count: 6, materialIndex: 0 }]);
      expect(first.triangleCount).toBe(2);
    },
  );

  it('reserves source and drawing copies before constructing patterned local buffers', () => {
    const source = makeBody('budget', 1, 0);
    const body: SolidBody = { ...source, coordinateFrame: {
      space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.01,
    } };
    const patterned = appearanceFromPreset('expandedMetal');
    const appearance: AppearanceInput = {
      defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['budget', { bodyAppearance: patterned, faceAppearances: new Map() }]]),
    };
    const sourceBytes = source.mesh.positions.byteLength + source.mesh.normals.byteLength
      + source.mesh.indices.byteLength + source.mesh.edgePositions.byteLength;
    const drawBytes = source.mesh.indices.length * 36;
    expect(() => buildSolidGeometry([body], null, [], appearance, sourceBytes + drawBytes - 1))
      .toThrow(/live-byte budget/);
    const entry = buildSolidGeometry([body], null, [], appearance, sourceBytes + drawBytes).entries[0];
    expect(entry.uv.length).toBe(source.mesh.indices.length * 2);
    expect(() => buildSolidGeometry([body], null, [], appearance, Number.POSITIVE_INFINITY))
      .toThrow(/positive safe integer/);
  });

  it('uses the stricter caller or local-result budget before patterned drawing allocation', () => {
    const source = makeBody('budget-result', 1, 0);
    const required = source.mesh.positions.byteLength + source.mesh.normals.byteLength
      + source.mesh.indices.byteLength + source.mesh.edgePositions.byteLength
      + source.mesh.indices.length * 36;
    const patterned = appearanceFromPreset('expandedMetal');
    const appearance: AppearanceInput = {
      defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['budget-result', { bodyAppearance: patterned, faceAppearances: new Map() }]]),
    };
    const framed = (limit: number): SolidBody => ({ ...source, coordinateFrame: {
      space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.01,
      maximumLiveMeshBytes: limit,
    } });
    expect(() => buildSolidGeometry([framed(required - 1)], null, [], appearance))
      .toThrow(/live-byte budget/);
    expect(buildSolidGeometry([framed(required)], null, [], appearance).entries).toHaveLength(1);
    expect(() => buildSolidGeometry([framed(required + 1)], null, [], appearance, required - 1))
      .toThrow(/live-byte budget/);
    expect(buildSolidGeometry([framed(required + 1)], null, [], appearance, required).entries).toHaveLength(1);
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 512 * 1024 * 1024 + 1]) {
      expect(() => buildSolidGeometry([framed(limit)], null, [], appearance))
        .toThrow(/positive safe integer/);
    }
  });

  it('does not reuse a larger local-result budget for a second body in the same bundle', () => {
    const first = makeBody('first-budget', 1, 0);
    const second = makeBody('second-budget', 1, 0);
    const required = first.mesh.positions.byteLength + first.mesh.normals.byteLength
      + first.mesh.indices.byteLength + first.mesh.edgePositions.byteLength
      + first.mesh.indices.length * 36;
    const patterned = appearanceFromPreset('expandedMetal');
    const appearance: AppearanceInput = {
      defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map<string, BodyAppearanceInput>(['first-budget', 'second-budget'].map((id) => [id, {
        bodyAppearance: patterned, faceAppearances: new Map(),
      }])),
    };
    const framed = (body: SolidBody, limit: number): SolidBody => ({ ...body, coordinateFrame: {
      space: 'local', origin: [1e9, 0, 0], maximumFloat32ErrorMm: 0.01,
      maximumLiveMeshBytes: limit,
    } });
    const large = framed(first, 2 * required + 1);
    expect(() => buildSolidGeometry([large, framed(second, 2 * required - 1)], null, [], appearance))
      .toThrow(/live-byte budget/);
    expect(buildSolidGeometry([large, framed(second, 2 * required)], null, [], appearance)
      .entries.map((entry) => entry.featureId)).toEqual(['first-budget', 'second-budget']);
  });

  it('uses the double origin remainder before interpolation for non-aligned positive and negative origins', () => {
    const source = makeBody('remainder', 1, 0);
    source.mesh.positions.set([19.99, 0, 0, 20.01, 0, 0, 19.99, 1, 0]);
    source.mesh.normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const preset = appearanceFromPreset('checkerPlate');
    if (preset.pattern.kind === 'none') throw new Error('expected patterned preset');
    const patterned: AppearanceSpec = { ...preset, pattern: {
      ...preset.pattern, spacing: expressionValueFromNumber(20),
    } };
    const appearance: AppearanceInput = { defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['remainder', { bodyAppearance: patterned, faceAppearances: new Map() }]]),
    };
    for (const [originX, expectedMidpoint] of [[1e9 + 7, 7], [-1e9 - 7, 13]] as const) {
      const body: SolidBody = { ...source, coordinateFrame: {
        space: 'local', origin: [originX, 0, 0], maximumFloat32ErrorMm: 0.01,
      } };
      const uv = buildSolidGeometry([body], null, [], appearance).entries[0].uv;
      expect(Math.abs((uv[0] + uv[2]) / 2 - expectedMidpoint)).toBeLessThan(2e-5);
    }
  });

  it('projects a normal-X patterned face to the YZ axes at a double origin', () => {
    const source = makeBody('yz', 1, 0);
    source.mesh.positions.set([0, 19.99, 3, 0, 20.01, 3, 0, 19.99, 4]);
    source.mesh.normals.set([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    const preset = appearanceFromPreset('checkerPlate');
    if (preset.pattern.kind === 'none') throw new Error('expected patterned preset');
    const patterned: AppearanceSpec = { ...preset, pattern: {
      ...preset.pattern, spacing: expressionValueFromNumber(20),
    } };
    const appearance: AppearanceInput = { defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['yz', { bodyAppearance: patterned, faceAppearances: new Map() }]]),
    };
    const body: SolidBody = { ...source, coordinateFrame: {
      space: 'local', origin: [0, 1e9, -1e9], maximumFloat32ErrorMm: 0.01,
    } };
    const uv = buildSolidGeometry([body], null, [], appearance).entries[0].uv;
    expect(Math.abs((uv[0] + uv[2]) / 2 - 20)).toBeLessThan(2e-5);
    expect(uv[1]).toBe(3);
    expect(uv[5]).toBe(4);
  });

  it('keeps face groups and indices while shared source vertices take per-face spacing and projection', () => {
    const source = makeBody('shared', 2, 0);
    const positions = Float32Array.from([
      19.99, 2, 3, 20.01, 2, 3, 19.99, 4, 3, 20.01, 4, 5,
    ]);
    const normals = Float32Array.from([
      0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0,
    ]);
    const indices = Uint32Array.from([0, 1, 2, 1, 3, 2]);
    const template = makeBoxBody('template', 1, 1, 1);
    const faces: SolidFaceEntry[] = [
      { ...template.faces[0], index: 0, triangleOffset: 0, triangleCount: 1 },
      { ...template.faces[1], index: 1, triangleOffset: 1, triangleCount: 1 },
    ];
    const body: SolidBodyWithSubShapes = { ...source, faces,
      mesh: { ...source.mesh, positions, normals, indices },
      coordinateFrame: { space: 'local', origin: [1e9, -1e9, 1e6], maximumFloat32ErrorMm: 0.01 },
    };
    const checker = appearanceFromPreset('checkerPlate');
    const metal = appearanceFromPreset('expandedMetal');
    const withSpacing = (spec: AppearanceSpec, value: number): AppearanceSpec =>
      spec.pattern.kind === 'none' ? spec : {
        ...spec, pattern: { ...spec.pattern, spacing: expressionValueFromNumber(value) },
      };
    const appearance = appearanceInputFor('shared', new Map([
      [0, withSpacing(checker, 20)], [1, withSpacing(metal, 30)],
    ]));
    const entry = buildSolidGeometry([body], null, [], appearance).entries[0];
    expect(entry.groups).toEqual([
      { start: 0, count: 3, materialIndex: 1 },
      { start: 3, count: 3, materialIndex: 2 },
    ]);
    expect(Array.from(entry.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(indices)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(entry.positions.slice(3, 6)).toEqual(entry.positions.slice(9, 12));
    // Face 0 projects XY; face 1 projects XZ and uses a different 30 mm repeat.
    expect(Math.abs(entry.uv[3] - 2)).toBeLessThan(2e-5);
    expect(Math.abs(entry.uv[7] - 13)).toBeLessThan(2e-5);
    expect(Math.abs(entry.uv[6] - entry.uv[2])).toBeGreaterThan(1);
    expect(entry.faces).toBe(faces);
  });

  it('replaces one cached phase across 100 origins and rejects malformed patterned input before a copy', () => {
    const source = makeBody('phase-cache', 1, 0);
    source.mesh.normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const patterned = appearanceFromPreset('wood');
    const appearance: AppearanceInput = { defaultAppearance: DEFAULT_APPEARANCE,
      byBody: new Map([['phase-cache', {
        bodyAppearance: patterned, faceAppearances: new Map(),
      }]]),
    };
    const framed = (x: number): SolidBody => ({ ...source,
      coordinateFrame: { space: 'local', origin: [x, 0, 0], maximumFloat32ErrorMm: 0.01 },
    });
    const initial = buildSolidGeometry([framed(0)], null, [], appearance).entries[0];
    for (let x = 1; x <= 100; x += 1) {
      const entry = buildSolidGeometry([framed(x)], null, [], appearance).entries[0];
      expect(entry.uv).not.toBe(initial.uv);
      expect(buildSolidGeometry([framed(x)], 'phase-cache', [], appearance).entries[0].uv).toBe(entry.uv);
    }
    expect(buildSolidGeometry([framed(0)], null, [], appearance).entries[0].uv).not.toBe(initial.uv);
    const badIndex = { ...source, mesh: { ...source.mesh, indices: Uint32Array.from([0, 1, 99]) },
      coordinateFrame: framed(0).coordinateFrame };
    expect(() => buildSolidGeometry([badIndex], null, [], appearance)).toThrow(/index is invalid/);
    const badPositions = Float32Array.from(source.mesh.positions);
    badPositions[0] = Number.NaN;
    expect(() => buildSolidGeometry([{ ...source,
      mesh: { ...source.mesh, positions: badPositions },
      coordinateFrame: framed(0).coordinateFrame,
    }], null, [], appearance)).toThrow(/coordinate is invalid/);
    if (patterned.pattern.kind === 'none') throw new Error('expected patterned preset');
    const invalidPattern: AppearanceSpec = { ...patterned, pattern: {
      ...patterned.pattern, spacing: { ...patterned.pattern.spacing, value: Number.POSITIVE_INFINITY },
    } };
    const invalidAppearance: AppearanceInput = { ...appearance, byBody: new Map([[
      'phase-cache', { bodyAppearance: invalidPattern, faceAppearances: new Map() },
    ]]) };
    expect(() => buildSolidGeometry([framed(0)], null, [], invalidAppearance)).toThrow(/spacing is invalid/);
  });

  it('local frameを保持し、面と稜線の配列を写さず、UVだけworld基準にする', () => {
    for (const origin of [[0, 0, 0], [1e6, -1e6, 0], [-1e9, 1e9, 1e9]] as const) {
      const body = makeBody('local', 1, 1);
      body.mesh.positions.set([2, 3, 4, 3, 3, 4, 2, 4, 4]);
      body.mesh.normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      const framed: SolidBody = {
        ...body,
        coordinateFrame: { space: 'local', origin, maximumFloat32ErrorMm: 0.01 },
      };
      const entry = buildSolidGeometry([framed], null, []).entries[0];
      expect(entry.coordinateFrame).toBe(framed.coordinateFrame);
      expect(entry.positions).toBe(body.mesh.positions);
      expect(entry.edgePositions).toBe(body.mesh.edgePositions);
      expect(Array.from(entry.uv.slice(0, 2))).toEqual([
        Math.fround(origin[0] + 2), Math.fround(origin[1] + 3),
      ]);
      expect(Array.from(entry.positions.slice(0, 3))).toEqual([2, 3, 4]);
    }
  });

  it('同じmeshのUVは直近の法線とoriginだけ再利用し、古いframeを保持しない', () => {
    const body = makeBody('uv-cache', 1, 1);
    body.mesh.positions.set([2, 3, 4, 3, 3, 4, 2, 4, 4]);
    body.mesh.normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const withOrigin = (x: number, normals = body.mesh.normals): SolidBody => ({
      ...body,
      mesh: { ...body.mesh, normals },
      coordinateFrame: { space: 'local', origin: [x, 0, 0], maximumFloat32ErrorMm: 0.01 },
    });
    const first = buildSolidGeometry([withOrigin(0)], null, []).entries[0];
    const repeated = buildSolidGeometry([withOrigin(0)], 'uv-cache', []).entries[0];
    expect(repeated.uv).toBe(first.uv);
    expect(repeated.positions).toBe(first.positions);
    expect(repeated.indices).toBe(first.indices);
    expect(repeated.groups).toEqual(first.groups);
    expect(repeated.appearances).toEqual(first.appearances);
    expect(repeated.emphasis).toBe('hovered');

    for (let x = 1; x <= 100; x += 1) {
      const shifted = buildSolidGeometry([withOrigin(x)], null, []).entries[0];
      expect(Array.from(shifted.uv.slice(0, 2))).toEqual([x + 2, 3]);
    }
    const revisited = buildSolidGeometry([withOrigin(0)], null, []).entries[0];
    expect(revisited.uv).not.toBe(first.uv);
    expect(Array.from(revisited.uv.slice(0, 2))).toEqual([2, 3]);

    const xNormals = Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    const changedNormal = buildSolidGeometry([withOrigin(0, xNormals)], null, []).entries[0];
    expect(changedNormal.uv).not.toBe(revisited.uv);
    expect(Array.from(changedNormal.uv.slice(0, 2))).toEqual([3, 4]);
    expect(buildSolidGeometry([withOrigin(0, xNormals)], null, []).entries[0].uv).toBe(changedNormal.uv);
  });

  it('不正なlocal frameをworld配列として黙って描かない', () => {
    const body = makeBody('invalid', 1, 1);
    const sparse: [number, number, number] = [1e9, 0, 0];
    Reflect.deleteProperty(sparse, '0');
    const inherited: [number, number, number] = [1e9, 0, 0];
    Reflect.deleteProperty(inherited, '0');
    Object.setPrototypeOf(inherited, [1e9]);
    expect(inherited[0]).toBe(1e9);
    for (const frame of [
      { space: 'local' as const, origin: [Number.NaN, 0, 0] as const, maximumFloat32ErrorMm: 0.01 },
      { space: 'local' as const, origin: [0, 0, 0] as const, maximumFloat32ErrorMm: 0 },
      { space: 'local' as const, origin: sparse, maximumFloat32ErrorMm: 0.01 },
      { space: 'local' as const, origin: inherited, maximumFloat32ErrorMm: 0.01 },
    ]) {
      expect(buildSolidGeometry([{ ...body, coordinateFrame: frame }], null, []).entries).toEqual([]);
    }
    const legacy = buildSolidGeometry([body], null, []).entries[0];
    expect(legacy.coordinateFrame).toBeUndefined();
  });

  it('ボディが 1 つも無ければ空の結果になる', () => {
    const bundle = buildSolidGeometry([], null, []);
    expect(bundle.entries).toEqual([]);
    expect(bundle.triangleCount).toBe(0);
    expect(bundle.edgeCount).toBe(0);
    expect(bundle.index.size).toBe(0);
    expect(shapeOf(bundle)).toEqual(shapeOf(EMPTY_SOLID_GEOMETRY));
  });

  it('ボディ 2 つの三角形と稜線を合計し、通し番号の始まりを持つ', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect(bundle.entries.length).toBe(2);
    expect(bundle.triangleCount).toBe(6);
    expect(bundle.edgeCount).toBe(18);
    expect(shapeOf(bundle)).toEqual({
      triangleCount: 6,
      edgeCount: 18,
      entries: [
        {
          featureId: 'extrude-1',
          emphasis: 'none',
          drawIndex: 0,
          triangleOffset: 0,
          triangleCount: 4,
          edgeOffset: 0,
          edgeCount: 12,
        },
        {
          featureId: 'revolve-1',
          emphasis: 'none',
          drawIndex: 1,
          triangleOffset: 4,
          triangleCount: 2,
          edgeOffset: 12,
          edgeCount: 6,
        },
      ],
    });
  });

  it('バッファの長さが三角形・稜線の数と合う', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 4, 12)], null, []);
    const entry = bundle.entries[0];
    expect(entry.indices.length).toBe(12);
    expect(entry.positions.length).toBe(36);
    expect(entry.normals.length).toBe(36);
    expect(entry.edgePositions.length).toBe(72);
    expect(entry.edgeCount).toBe(entry.edgePositions.length / 6);
  });

  it('並びは写さずカーネルが返したものをそのまま指す(NFR-PF-1)', () => {
    const body = makeBody('extrude-1', 2, 3);
    const entry = buildSolidGeometry([body], null, []).entries[0];
    expect(entry.positions).toBe(body.mesh.positions);
    expect(entry.normals).toBe(body.mesh.normals);
    expect(entry.indices).toBe(body.mesh.indices);
    expect(entry.edgePositions).toBe(body.mesh.edgePositions);
  });

  it('対応表から featureId で描画の範囲を引ける', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect([...bundle.index.keys()]).toEqual(['extrude-1', 'revolve-1']);
    expect(bundle.index.get('revolve-1')).toBe(bundle.entries[1]);
    expect(bundle.index.get('revolve-1')?.triangleOffset).toBe(4);
    expect(bundle.index.get('missing')).toBeUndefined();
  });

  it('ホバー中のボディだけが hovered になる', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1), makeBody('revolve-1', 1, 1)],
      'revolve-1',
      [],
    );
    expect(bundle.entries.map((entry) => entry.emphasis)).toEqual(['none', 'hovered']);
  });

  it('選択中のボディが selected になり、ホバーと重なったら選択を優先する', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1), makeBody('revolve-1', 1, 1), makeBody('cut-1', 1, 1)],
      'revolve-1',
      ['revolve-1', 'cut-1'],
    );
    expect(bundle.entries.map((entry) => entry.emphasis)).toEqual([
      'none',
      'selected',
      'selected',
    ]);
  });

  it('スケッチの要素 id が混ざっていてもボディは強調されない', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1)],
      'point-1',
      ['point-1', 'pa1#0', 'extrude-10'],
    );
    expect(bundle.entries[0].emphasis).toBe('none');
  });

  it('立体になっていないボディ(isValid が false)は描かない', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12, false), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect(bundle.entries.map((entry) => entry.featureId)).toEqual(['revolve-1']);
    expect(bundle.triangleCount).toBe(2);
    expect(bundle.entries[0].drawIndex).toBe(0);
  });

  it('三角形も稜線も無いボディは描かない', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 0, 0)], null, []);
    expect(bundle.entries).toEqual([]);
    expect(bundle.index.size).toBe(0);
  });

  it('稜線だけのボディは描く(ワイヤーフレーム表示のため)', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 0, 4)], null, []);
    expect(bundle.entries.length).toBe(1);
    expect(bundle.entries[0].triangleCount).toBe(0);
    expect(bundle.entries[0].edgeCount).toBe(4);
  });

  it('同じ id のボディが 2 つ来たら先のものだけを描く(§0.a-0.5)', () => {
    const first = makeBody('extrude-1', 4, 12);
    const bundle = buildSolidGeometry([first, makeBody('extrude-1', 2, 6)], null, []);
    expect(bundle.entries.length).toBe(1);
    expect(bundle.entries[0].indices).toBe(first.mesh.indices);
    expect(bundle.triangleCount).toBe(4);
  });

  it('同じ入力を 2 回組み立てると同じ結果になる(決定性)', () => {
    const bodies = [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)];
    const first = buildSolidGeometry(bodies, 'extrude-1', ['revolve-1']);
    const second = buildSolidGeometry(bodies, 'extrude-1', ['revolve-1']);
    expect(shapeOf(second)).toEqual(shapeOf(first));
    expect(second.entries[0].positions).toBe(first.entries[0].positions);
  });

  it('faces/edges/vertices を持たないボディ(タスク17 前)は、エントリの範囲表が空配列になる(計画書タスク22)', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 4, 12)], null, []);
    expect(bundle.entries[0].faces).toEqual([]);
    expect(bundle.entries[0].edges).toEqual([]);
    expect(bundle.entries[0].vertices).toEqual([]);
  });

  it('faces/edges/vertices を持つボディは、エントリがその参照をそのまま持つ(タスク22、写さない)', () => {
    const face: SolidFaceEntry = {
      index: 0,
      surfaceKind: 'plane',
      area: 10,
      centroid: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 4,
    };
    const body: SolidBodyWithSubShapes = { ...makeBody('extrude-1', 4, 12), faces: [face], edges: [], vertices: [] };
    const bundle = buildSolidGeometry([body], null, []);
    expect(bundle.entries[0].faces).toBe(body.faces);
    expect(bundle.entries[0].edges).toBe(body.edges);
    expect(bundle.entries[0].vertices).toBe(body.vertices);
  });
});

describe('scene-managed display copies on a kernel baseline (B2)', () => {
  it('registers exact new UV backing before a subsequent actual cache insertion throws', () => {
    const body = makeBody('cache-throw', 1, 0), cache = new DisplayCopyCache(), ledger = new AssemblyUiBackingLedger();
    const borrowed: ArrayBufferLike[] = [];
    const set = vi.spyOn(cache.uv, 'set').mockImplementationOnce(() => { throw new Error('Actual cache insertion failed'); });
    expect(() => buildSolidGeometry([body], null, [], undefined, undefined,
      { cache, allocated: buffer => { ledger.allocated(buffer); borrowed.push(buffer); } })).toThrow('Actual cache insertion failed');
    expect(set).toHaveBeenCalledTimes(1); expect(cache.buffers()).toEqual([]);
    expect(borrowed).toHaveLength(1); expect(ledger.bytes()).toBe(24);
    expect(borrowed[0]).not.toBe(body.mesh.positions.buffer); expect(borrowed[0].byteLength).toBe(24);
  });

  it('registers constructor-returned UV before normal-value fill throws and retains that actual backing', () => {
    const positions = new Float32Array([1, 2, 3]), ledger = new AssemblyUiBackingLedger(), borrowed: ArrayBufferLike[] = [];
    let reads = 0;
    const normals = new Proxy(new Float32Array([0, 0, 1]), { get(target, key): unknown {
      if (key === '0') { reads += 1; throw new Error('Actual normal fill read failed'); }
      return Reflect.get(target, key, target);
    } });
    expect(() => buildBoxProjectedUv(positions, normals, [0, 0, 0], buffer => {
      ledger.allocated(buffer); borrowed.push(buffer);
    })).toThrow('Actual normal fill read failed');
    expect(reads).toBe(1); expect(borrowed).toHaveLength(1); expect(ledger.bytes()).toBe(8);
    expect(borrowed[0]).not.toBe(positions.buffer);
  });

  it('a callback failure carries the actual constructed backing without filling or caching it', () => {
    const body = makeBody('callback-throw', 1, 0), cache = new DisplayCopyCache(), ledger = new AssemblyUiBackingLedger();
    let failure: unknown;
    try { buildSolidGeometry([body], null, [], undefined, undefined, { cache, allocated: () => { throw new Error('Observer failed'); } }); }
    catch (error) { failure = error; }
    if (!(failure instanceof AllocatedBackingRegistrationError)) throw new Error('Actual backing was not handed back');
    expect(failure.backing.byteLength).toBe(24); expect(cache.buffers()).toEqual([]);
    ledger.retainUnregistered(failure.backing); expect(ledger.known()).toBe(false);
    ledger.retryRegistration(); expect(ledger.known()).toBe(true); expect(ledger.bytes()).toBe(24);
  });

  const local = (body: SolidBody, origin: [number, number, number] = [1e9, 0, 0]): SolidBody => ({
    ...body, coordinateFrame: { space: 'local', origin, maximumFloat32ErrorMm: 0.01 },
  });
  const patternedAppearance = (ids: readonly string[]): AppearanceInput => ({
    defaultAppearance: DEFAULT_APPEARANCE,
    byBody: new Map<string, BodyAppearanceInput>(ids.map((id) => [id, {
      bodyAppearance: appearanceFromPreset('expandedMetal'), faceAppearances: new Map(),
    }])),
  });
  /** The kernel's post-token union of 1000 bytes already contains the received source arrays. */
  const budget = (limitBytes: number, retained: readonly ArrayBufferLike[] = []) =>
    ({ limitBytes, baselineBytes: 1000, retained });

  it('adds only the 24-byte UV of a plain one-triangle body and refuses before allocating it', () => {
    const body = local(makeBody('plain', 1, 0));
    const refused = new DisplayCopyCache();
    expect(() => buildSolidGeometry([body], null, [], undefined, undefined, { cache: refused, budget: budget(1023) }))
      .toThrow(/live-byte budget/);
    expect(refused.buffers()).toEqual([]);
    const cache = new DisplayCopyCache();
    const bundle = buildSolidGeometry([body], null, [], undefined, undefined, { cache, budget: budget(1024) });
    expect(bundle.displayCopies).toEqual([bundle.entries[0].uv.buffer]);
    expect(distinctBackingBytes(bundle.displayCopies ?? [])).toBe(24);
    expect(cache.buffers()).toEqual([bundle.entries[0].uv.buffer]);
    expect(bundle.entries[0].positions).toBe(body.mesh.positions);
  });

  it('adds 108 bytes for a patterned copy and 132 bytes for a plain and a patterned body together', () => {
    const patterned = local(makeBody('pattern', 1, 0));
    const appearance = patternedAppearance(['pattern']);
    const refused = new DisplayCopyCache();
    expect(() => buildSolidGeometry([patterned], null, [], appearance, undefined,
      { cache: refused, budget: budget(1107) })).toThrow(/live-byte budget/);
    expect(refused.buffers()).toEqual([]);
    const one = buildSolidGeometry([patterned], null, [], appearance, undefined,
      { cache: new DisplayCopyCache(), budget: budget(1108) });
    // positions 36 + normals 36 + indices 12 + UV 24.
    expect(distinctBackingBytes(one.displayCopies ?? [])).toBe(108);
    const plain = local(makeBody('plain', 1, 0), [0, 1e9, 0]);
    expect(() => buildSolidGeometry([plain, patterned], null, [], appearance, undefined,
      { cache: new DisplayCopyCache(), budget: budget(1131) })).toThrow(/live-byte budget/);
    const both = buildSolidGeometry([plain, patterned], null, [], appearance, undefined,
      { cache: new DisplayCopyCache(), budget: budget(1132) });
    expect(distinctBackingBytes(both.displayCopies ?? [])).toBe(132);
  });

  it('counts a shared UV once and keeps the published copy until the next candidate replaces it', () => {
    const source = makeBody('shared-a', 1, 0);
    const a = local(source, [5, 0, 0]);
    const b: SolidBody = { ...local(source, [5, 0, 0]), featureId: 'shared-b' };
    const cache = new DisplayCopyCache();
    const shared = buildSolidGeometry([a, b], null, [], undefined, undefined, { cache, budget: budget(1024) });
    expect(shared.entries[1].uv).toBe(shared.entries[0].uv);
    expect(distinctBackingBytes(shared.displayCopies ?? [])).toBe(24);
    // A moved origin needs a new UV while the published one is still alive: 24 old plus 24 new.
    const moved = local(source, [6, 0, 0]);
    expect(() => buildSolidGeometry([moved], null, [], undefined, undefined,
      { cache, budget: budget(1047, shared.displayCopies) })).toThrow(/live-byte budget/);
    const next = buildSolidGeometry([moved], null, [], undefined, undefined,
      { cache, budget: budget(1048, shared.displayCopies) });
    expect(next.entries[0].uv).not.toBe(shared.entries[0].uv);
    cache.retainBodies([moved]);
    expect(cache.buffers()).toEqual([next.entries[0].uv.buffer]);
  });

  it('prunes copies of unpublished sources and leaves pure callers on the shared cache', () => {
    const first = local(makeBody('first-prune', 1, 0));
    const second = local(makeBody('second-prune', 1, 0));
    const cache = new DisplayCopyCache();
    const bundle = buildSolidGeometry([first, second], null, [], undefined, undefined, { cache });
    expect(cache.buffers()).toHaveLength(2);
    expect(bundle.displayCopies).toHaveLength(2);
    cache.retainBodies([second]);
    expect(cache.buffers()).toEqual([bundle.entries[1].uv.buffer]);
    cache.clear();
    expect(cache.buffers()).toEqual([]);
    const pure = buildSolidGeometry([first], null, []);
    expect(pure.displayCopies).toBeUndefined();
    expect(cache.buffers()).toEqual([]);
    // A world display uses the managed cache without a byte limit.
    expect(buildSolidGeometry([makeBody('world-managed', 1, 0)], null, [], undefined, undefined,
      { cache }).displayCopies).toHaveLength(1);
  });

  it('refuses an invalid budget before any copy', () => {
    const body = local(makeBody('invalid-budget', 1, 0));
    for (const bad of [{ limitBytes: 0, baselineBytes: 0, retained: [] },
      { limitBytes: 100, baselineBytes: -1, retained: [] },
      { limitBytes: 512 * 1024 * 1024 + 1, baselineBytes: 0, retained: [] },
      { limitBytes: 100, baselineBytes: 0.5, retained: [] }]) {
      const cache = new DisplayCopyCache();
      expect(() => buildSolidGeometry([body], null, [], undefined, undefined, { cache, budget: bad }))
        .toThrow(/live-byte budget/);
      expect(cache.buffers()).toEqual([]);
    }
  });
});

describe('solidEmphasisOf(FR-106)', () => {
  it('選択 > ホバー > なし の順に強い', () => {
    expect(solidEmphasisOf('extrude-1', null, new Set())).toBe('none');
    expect(solidEmphasisOf('extrude-1', 'extrude-1', new Set())).toBe('hovered');
    expect(solidEmphasisOf('extrude-1', 'extrude-1', new Set(['extrude-1']))).toBe('selected');
    expect(solidEmphasisOf('extrude-1', 'revolve-1', new Set(['extrude-1']))).toBe('selected');
  });
});

describe('サムネイルの大きさ(§0.a-0.18)', () => {
  it('一辺の上限は 256', () => {
    expect(THUMBNAIL_SIZE).toBe(256);
  });

  it('横長の絵は幅を合わせ、上下を余白にする', () => {
    expect(thumbnailFitRect(800, 600)).toEqual({ x: 0, y: 32, width: 256, height: 192 });
  });

  it('縦長の絵は高さを合わせ、左右を余白にする', () => {
    expect(thumbnailFitRect(600, 800)).toEqual({ x: 32, y: 0, width: 192, height: 256 });
  });

  it('正方形は余白なしで埋まる', () => {
    expect(thumbnailFitRect(512, 512)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
  });

  it('元が小さいときは拡大せず中央に置く', () => {
    expect(thumbnailFitRect(100, 50)).toEqual({ x: 78, y: 103, width: 100, height: 50 });
  });

  it('大きさが決められないときは null', () => {
    expect(thumbnailFitRect(0, 600)).toBeNull();
    expect(thumbnailFitRect(800, -1)).toBeNull();
    expect(thumbnailFitRect(800, 600, 0)).toBeNull();
    expect(thumbnailFitRect(Number.NaN, 600)).toBeNull();
  });
});

describe('サムネイルのバイト列(§0.a-0.18)', () => {
  it('PNG の data URL をバイト列へ直す', () => {
    // "iVBORw0KGgo=" は PNG の署名 8 バイトそのもの。
    const bytes = dataUrlToBytes('data:image/png;base64,iVBORw0KGgo=');
    expect(bytes).not.toBeNull();
    expect([...(bytes ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('中身が空でも空のバイト列を返す', () => {
    expect(dataUrlToBytes('data:image/png;base64,')?.length).toBe(0);
  });

  it('PNG でない data URL は受け取らない', () => {
    expect(dataUrlToBytes('data:image/jpeg;base64,iVBORw0KGgo=')).toBeNull();
    expect(dataUrlToBytes('')).toBeNull();
  });

  it('base64 が壊れていたら例外を投げずに null を返す', () => {
    expect(dataUrlToBytes('data:image/png;base64,!!!!')).toBeNull();
  });
});

/** 箱の面 1 枚(頂点 4・三角形 2)。角が原点の w×d×h の箱を面 6 枚で作るための材料。 */
interface BoxFace {
  readonly corners: readonly (readonly [number, number, number])[];
  readonly normal: readonly [number, number, number];
}

/**
 * 角が原点の w×d×h の箱。面の並びは 上(+Z)・下(-Z)・前(-Y)・後(+Y)・左(-X)・右(+X)。
 * 面ごとに頂点 4・三角形 2 で、面の範囲表(`SolidFaceEntry`)も同じ並びで作る。
 */
function makeBoxBody(
  featureId: string,
  width: number,
  depth: number,
  height: number,
): SolidBodyWithSubShapes {
  const w = width;
  const d = depth;
  const h = height;
  const boxFaces: readonly BoxFace[] = [
    { corners: [[0, 0, h], [w, 0, h], [w, d, h], [0, d, h]], normal: [0, 0, 1] },
    { corners: [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0]], normal: [0, 0, -1] },
    { corners: [[0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]], normal: [0, -1, 0] },
    { corners: [[0, d, 0], [w, d, 0], [w, d, h], [0, d, h]], normal: [0, 1, 0] },
    { corners: [[0, 0, 0], [0, d, 0], [0, d, h], [0, 0, h]], normal: [-1, 0, 0] },
    { corners: [[w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h]], normal: [1, 0, 0] },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: SolidFaceEntry[] = [];
  boxFaces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (const corner of face.corners) {
      positions.push(corner[0], corner[1], corner[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faces.push({
      index: faceIndex,
      surfaceKind: 'plane',
      area: 1,
      centroid: [0, 0, 0],
      axis: [face.normal[0], face.normal[1], face.normal[2]],
      radius: null,
      triangleOffset: faceIndex * 2,
      triangleCount: 2,
    });
  });

  return {
    featureId,
    mesh: {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices: Uint32Array.from(indices),
      edgePositions: new Float32Array(12 * 6),
      triangleCount: 12,
    },
    volume: w * d * h,
    isValid: true,
    faces,
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 面 1 枚だけに外観を割り当てた入力を作る。 */
function appearanceInputFor(
  featureId: string,
  faceAppearances: ReadonlyMap<number, AppearanceSpec>,
  bodyAppearance: AppearanceSpec | null = null,
): AppearanceInput {
  const entry: BodyAppearanceInput = { bodyAppearance, faceAppearances };
  return {
    defaultAppearance: DEFAULT_APPEARANCE,
    byBody: new Map([[featureId, entry]]),
  };
}

/** 頂点 1 つぶんの UV を読み出す。 */
function uvAt(uv: Float32Array, vertex: number): readonly [number, number] {
  return [uv[vertex * 2], uv[vertex * 2 + 1]];
}

describe('buildBoxProjectedUv(FR-1108、§0.a-0.7)', () => {
  it('法線 [0,0,1] の頂点は (x, y) を UV にする', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, 1]));
    expect([...uv]).toEqual([3, 4]);
  });

  it('法線 [0,-1,0] の頂点は (x, z) を UV にする(符号では規則を変えない)', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, -1, 0]));
    expect([...uv]).toEqual([3, 5]);
  });

  it('法線 [1,0,0] の頂点は (y, z) を UV にする', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([1, 0, 0]));
    expect([...uv]).toEqual([4, 5]);
  });

  it('法線 [0,0,-1] は [0,0,1] と同じ UV になる(継ぎ目で柄が反転しない)', () => {
    const front = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, 1]));
    const back = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, -1]));
    expect([...back]).toEqual([...front]);
  });

  it('法線 [0,0,0] の頂点は [0, 0] にする(投影面を選べない)', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, 0]));
    expect([...uv]).toEqual([0, 0]);
  });

  it('法線が数でない頂点も [0, 0] にする(落ちない)', () => {
    const uv = buildBoxProjectedUv(
      Float32Array.from([3, 4, 5]),
      Float32Array.from([Number.NaN, Number.NaN, Number.NaN]),
    );
    expect([...uv]).toEqual([0, 0]);
  });

  it('法線の並びが足りなくても落ちず、足りない頂点は [0, 0] になる', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5, 6, 7, 8]), Float32Array.from([0, 0, 1]));
    expect([...uv]).toEqual([3, 4, 0, 0]);
  });

  it('45°の面(絶対値が並ぶ)は z → y → x の順で投影面を選ぶ', () => {
    const diagonal = Math.SQRT1_2;
    const xy = buildBoxProjectedUv(
      Float32Array.from([3, 4, 5]),
      Float32Array.from([diagonal, diagonal, 0]),
    );
    expect([...xy]).toEqual([3, 5]);
    const yz = buildBoxProjectedUv(
      Float32Array.from([3, 4, 5]),
      Float32Array.from([0, diagonal, diagonal]),
    );
    expect([...yz]).toEqual([3, 4]);
  });

  it('UV の長さは頂点数 × 2 になる', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const uv = buildBoxProjectedUv(body.mesh.positions, body.mesh.normals);
    expect(uv.length).toBe((body.mesh.positions.length / 3) * 2);
    expect(uv.length).toBe(48);
  });

  it('40×30×10 の箱は、上面が (x, y)・前面が (x, z) の mm 値になる', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const uv = buildBoxProjectedUv(body.mesh.positions, body.mesh.normals);
    // 上面(面 0)の頂点 0〜3 = (0,0,10) (40,0,10) (40,30,10) (0,30,10)。
    expect(uvAt(uv, 0)).toEqual([0, 0]);
    expect(uvAt(uv, 1)).toEqual([40, 0]);
    expect(uvAt(uv, 2)).toEqual([40, 30]);
    expect(uvAt(uv, 3)).toEqual([0, 30]);
    // 前面(面 2、頂点 8〜11)= (0,0,0) (40,0,0) (40,0,10) (0,0,10)。
    expect(uvAt(uv, 8)).toEqual([0, 0]);
    expect(uvAt(uv, 9)).toEqual([40, 0]);
    expect(uvAt(uv, 10)).toEqual([40, 10]);
    // 右面(面 5、頂点 20〜23)= (40,0,0) …。(y, z) を使う。
    expect(uvAt(uv, 20)).toEqual([0, 0]);
    expect(uvAt(uv, 21)).toEqual([30, 0]);
    expect(uvAt(uv, 22)).toEqual([30, 10]);
  });

  it('20³ の箱の UV はすべて [0, 20] の中に入る(mm 単位)', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const uv = buildBoxProjectedUv(body.mesh.positions, body.mesh.normals);
    for (const value of uv) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it('頂点 10 万の UV を 16ms 未満で作れる(NFR-PF-1)', () => {
    const vertexCount = 100_000;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const base = vertex * 3;
      positions[base] = vertex % 97;
      positions[base + 1] = vertex % 89;
      positions[base + 2] = vertex % 83;
      normals[base + (vertex % 3)] = vertex % 2 === 0 ? 1 : -1;
    }
    // 暖機 1 回を計測の外へ出す。JIT の初回コンパイルが乗ると、並列作業中の CPU 競合と
    // 重なって初回の実測が跳ねる(2026-09-05 実測: 暖機なしで初回 33.8ms / 2 回目 2.0ms)。
    // 暖機の結果そのものは使わない(solidPerformance.test.ts の beforeAll の捨て計算と同じ理由)。
    buildBoxProjectedUv(positions, normals);
    const startedAt = performance.now();
    const uv = buildBoxProjectedUv(positions, normals);
    const elapsed = performance.now() - startedAt;
    // 2 回目(暖機後にもう一段速くなるか)も測る。実際の呼び出しは文書を開くたびに何度も起きる。
    const warmStartedAt = performance.now();
    buildBoxProjectedUv(positions, normals);
    const warmElapsed = performance.now() - warmStartedAt;
    // 実測値を報告できるよう出力に残す(`pickSolidSubShapePerformance.test.ts` と同じ流儀)。
    console.log(
      `buildBoxProjectedUv: 頂点 ${vertexCount} で 暖機後1回目 ${elapsed.toFixed(3)}ms / 2回目 ${warmElapsed.toFixed(3)}ms`,
    );
    expect(uv.length).toBe(vertexCount * 2);
    expectWithinBudget(elapsed, 16, 'buildBoxProjectedUv 暖機後1回目');
    expectWithinBudget(warmElapsed, 16, 'buildBoxProjectedUv 2回目');
  });
});

describe('buildSolidGeometry の外観(FR-1106、計画書 P5 タスク7)', () => {
  it('外観を渡さないと、まとまりも材質も 1 つで既定の外観になる(§0.a-0.12)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const entry = buildSolidGeometry([body], null, []).entries[0];
    expect(entry.appearances).toEqual([DEFAULT_APPEARANCE]);
    expect(entry.groups).toEqual([{ start: 0, count: 36, materialIndex: 0 }]);
    expect(entry.appearanceLimitExceeded).toBe(false);
  });

  it('割り当ての無いボディも既定の外観 1 つになる', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const other = makeBoxBody('box-2', 10, 10, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    const bundle = buildSolidGeometry(
      [body, other],
      null,
      [],
      appearanceInputFor('box-1', new Map([[0, red]])),
    );
    expect(bundle.entries[1].appearances).toEqual([DEFAULT_APPEARANCE]);
    expect(bundle.entries[1].groups.length).toBe(1);
  });

  it('上面(面 0)だけに別の色を割り当てるとまとまりが 2 つになる', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', new Map([[0, red]])),
    ).entries[0];
    expect(entry.appearances.length).toBe(2);
    expect(entry.appearances[0]).toBe(DEFAULT_APPEARANCE);
    expect(entry.appearances[1]).toBe(red);
    expect(entry.groups).toEqual([
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 30, materialIndex: 0 },
    ]);
  });

  it('まとまりが索引の全体をちょうど覆う(three の addGroup の約束)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', new Map([[2, red]])),
    ).entries[0];
    let cursor = 0;
    for (const group of entry.groups) {
      expect(group.start).toBe(cursor);
      cursor += group.count;
    }
    expect(cursor).toBe(body.mesh.indices.length);
  });

  it('面の範囲表に隙間があっても、覆われない索引が残らない(描かれない三角形を作らない)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    // 面 3〜5 を落とした範囲表(索引 18 以降が範囲表から外れる)。
    const gapped: SolidBodyWithSubShapes = { ...body, faces: body.faces.slice(0, 3) };
    const entry = buildSolidGeometry(
      [gapped],
      null,
      [],
      appearanceInputFor('box-1', new Map([[1, red]])),
    ).entries[0];
    const total = entry.groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(36);
    expect(entry.groups[entry.groups.length - 1].materialIndex).toBe(0);
  });

  it('立体全体の割り当てがあると、材質 1 つのまま色だけ変わる', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const green = appearanceFromPreset('custom', '#00ff00');
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', new Map(), green),
    ).entries[0];
    expect(entry.appearances).toEqual([green]);
    expect(entry.groups).toEqual([{ start: 0, count: 36, materialIndex: 0 }]);
  });

  it('箱の 6 面に別々の色(既定 + 6 = 7 種類)は上限の中で作れる(§0.a-0.11)', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const faceAppearances = new Map<number, AppearanceSpec>();
    for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
      faceAppearances.set(faceIndex, appearanceFromPreset('custom', `#00000${faceIndex + 1}`));
    }
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', faceAppearances),
    ).entries[0];
    expect(entry.appearanceLimitExceeded).toBe(false);
    expect(entry.appearances.length).toBe(7);
    expect(entry.groups.length).toBe(6);
  });

  it('材質 9 種になる割り当ては断り(appearanceLimitExceeded)、既定 1 色 1 まとまりに落とす', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const faces: SolidFaceEntry[] = [];
    const faceAppearances = new Map<number, AppearanceSpec>();
    for (let faceIndex = 0; faceIndex < 8; faceIndex += 1) {
      faces.push({ ...body.faces[0], index: faceIndex, triangleOffset: faceIndex, triangleCount: 1 });
      faceAppearances.set(faceIndex, appearanceFromPreset('custom', `#00000${faceIndex + 1}`));
    }
    const manyMaterials: SolidBodyWithSubShapes = { ...body, faces };
    const entry = buildSolidGeometry(
      [manyMaterials],
      null,
      [],
      appearanceInputFor('box-1', faceAppearances),
    ).entries[0];
    expect(entry.appearanceLimitExceeded).toBe(true);
    expect(entry.appearances).toEqual([DEFAULT_APPEARANCE]);
    expect(entry.groups).toEqual([{ start: 0, count: 36, materialIndex: 0 }]);
  });

  it('ホバーが変わっただけの組み立て直しでは UV を作り直さない(同一参照、NFR-PF-1)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const first = buildSolidGeometry([body], null, []).entries[0];
    const second = buildSolidGeometry([body], 'box-1', []).entries[0];
    expect(second.emphasis).toBe('hovered');
    expect(second.uv).toBe(first.uv);
  });

  it('穴 20 個の板(面 26)のまとまりと UV を 1 コマ(16ms)の中で作れる', () => {
    const body = makeBoxBody('plate-1', 200, 100, 6);
    // 板の 6 面 + 穴 20 個の円筒面(1 面あたり三角形 32 枚)= 面 26。
    const faces: SolidFaceEntry[] = [...body.faces];
    let triangleOffset = 12;
    for (let hole = 0; hole < 20; hole += 1) {
      faces.push({
        index: 6 + hole,
        surfaceKind: 'cylinder',
        area: 50,
        centroid: [0, 0, 0],
        axis: [0, 0, 1],
        radius: 3,
        triangleOffset,
        triangleCount: 32,
      });
      triangleOffset += 32;
    }
    const triangleCount = triangleOffset;
    const plate: SolidBodyWithSubShapes = {
      ...body,
      mesh: {
        positions: new Float32Array(triangleCount * 9),
        normals: new Float32Array(triangleCount * 9),
        indices: new Uint32Array(triangleCount * 3),
        edgePositions: body.mesh.edgePositions,
        triangleCount,
      },
      faces,
    };
    const red = appearanceFromPreset('custom', '#ff0000');
    const faceAppearances = new Map<number, AppearanceSpec>();
    for (let hole = 0; hole < 20; hole += 1) {
      faceAppearances.set(6 + hole, red);
    }
    const startedAt = performance.now();
    const entry = buildSolidGeometry(
      [plate],
      null,
      [],
      appearanceInputFor('plate-1', faceAppearances),
    ).entries[0];
    const elapsed = performance.now() - startedAt;
    console.log(
      `buildSolidGeometry(面 ${faces.length}・三角形 ${triangleCount}): ${elapsed.toFixed(3)}ms`,
    );
    expect(entry.appearances.length).toBe(2);
    // 板の 6 面(既定)+ 穴 20 面(赤)が索引の上で続いているので、まとまりは 2 つに畳まれる。
    expect(entry.groups.length).toBe(2);
    expect(entry.groups.reduce((sum, group) => sum + group.count, 0)).toBe(triangleCount * 3);
    expect(entry.uv.length).toBe(triangleCount * 6);
    expectWithinBudget(
      elapsed,
      16,
      `buildSolidGeometry(面 ${String(faces.length)}・三角形 ${String(triangleCount)})`,
    );
  });
});
