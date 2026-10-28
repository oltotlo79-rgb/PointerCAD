import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SolidFaceInfo, SubShapeQuery, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import {
  editSolidFace,
  FACE_OFFSET_ADJACENT_MESSAGE,
  FACE_OFFSET_COLLISION_MESSAGE,
  FACE_OFFSET_DISTANCE_MESSAGE,
  FACE_OFFSET_INVALID_BODY_MESSAGE,
  FACE_OFFSET_MISSING_FACE_MESSAGE,
  FACE_OFFSET_NOT_PLANAR_MESSAGE,
} from './editSolidFace.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeDraft } from './makeDraft.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * 平らな面の移動(EX-18 の限られた一段)の実カーネルの検査。
 *
 * 形は Root の probe(probe-face-offset.mjs、実行 2026-10-15 19:39)と同じ L 字のブラケット:
 * 底板 60×40×8、x=0 に立ち上がり 8×40×40、底板に (45, 20) を通る半径 4 の貫通穴。
 * 体積 V0 = 19200 + 10240 − π·4²·8。期待値はすべてこの式と「V0 + 距離 × 面積」から出す。
 * probe の実測: 上面 ±5・+12.5、端面 ±5 は面 9 枚の正しい立体 1 つ、端面 −20 / −60 は穴を消して
 * 体積が合わない(面 8 枚・6 枚)。後者を**断る**ことがこの段の安全条件である。
 */

const HOLE_RADIUS = 4;
const BRACKET_VOLUME = 60 * 40 * 8 + 8 * 40 * 32 - Math.PI * HOLE_RADIUS * HOLE_RADIUS * 8;
/** 立ち上がりの上面(z=40)と底板の端面(x=60)は、どちらも 320 mm²。 */
const MOVED_FACE_AREA = 320;
const HOLE_AREA = 2 * Math.PI * HOLE_RADIUS * 8;

describe('平らな面の移動(EX-18、平面・隣が直角の段)', () => {
  let oc: OpenCascadeInstance;
  const fixtures = createAllocations();

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  afterAll(() => {
    fixtures.release();
  });

  function collectTables(shape: TopoDS_Shape): SubShapeTables {
    const surface = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, surface.faceRanges, lines.edgeRanges);
  }

  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return { kind: 'face', index: info.index, surfaceKind: info.surfaceKind, area: info.area,
      position: info.centroid, axis: info.axis, radius: info.radius };
  }

  function near(a: Vec3Tuple, b: Vec3Tuple, tolerance = 1e-6): boolean {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
  }

  /** 法線と重心の条件で平面をちょうど 1 枚選ぶ。0 枚・2 枚以上なら検査の前提が崩れている。 */
  function planarFace(tables: SubShapeTables, normal: Vec3Tuple, test: (centroid: Vec3Tuple) => boolean): SolidFaceInfo {
    const found = tables.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
      && near(face.axis, normal, 1e-9) && test(face.centroid));
    expect(found).toHaveLength(1);
    return found[0];
  }

  function holeFaces(tables: SubShapeTables): readonly SolidFaceInfo[] {
    return tables.faces.filter((face) => face.surfaceKind === 'cylinder' && face.radius !== null
      && Math.abs(face.radius - HOLE_RADIUS) < 1e-9);
  }

  function unify(shape: TopoDS_Shape): TopoDS_Shape {
    const maker = fixtures.keep(new oc.ShapeUpgrade_UnifySameDomain_1());
    maker.Initialize(shape, true, true, false);
    maker.AllowInternalEdges(false);
    maker.Build();
    return fixtures.keep(maker.Shape());
  }

  function box(x: number, y: number, z: number, dx: number, dy: number, dz: number): TopoDS_Shape {
    const corner = fixtures.keep(new oc.gp_Pnt_3(x, y, z));
    return fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeBox_3(corner, dx, dy, dz)).Shape());
  }

  /** probe と同じブラケット。和の後に同じ平面をまとめ、穴を開ける。 */
  function bracket(): { readonly shape: TopoDS_Shape; readonly tables: SubShapeTables } {
    const fused = fixtures.keep(booleanOp(oc, 'union', box(0, 0, 0, 60, 40, 8), box(0, 0, 0, 8, 40, 40)));
    const body = unify(fused.shape);
    const origin = fixtures.keep(new oc.gp_Pnt_3(45, 20, -1));
    const up = fixtures.keep(new oc.gp_Dir_4(0, 0, 1));
    const axes = fixtures.keep(new oc.gp_Ax2_3(origin, up));
    const tool = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, HOLE_RADIUS, 10)).Shape());
    const drilled = fixtures.keep(booleanOp(oc, 'subtract', body, tool));
    return { shape: drilled.shape, tables: collectTables(drilled.shape) };
  }

  function uprightTop(tables: SubShapeTables): SolidFaceInfo {
    return planarFace(tables, [0, 0, 1], (c) => Math.abs(c[2] - 40) < 1e-6);
  }

  function baseEnd(tables: SubShapeTables): SolidFaceInfo {
    return planarFace(tables, [1, 0, 0], (c) => Math.abs(c[0] - 60) < 1e-6);
  }

  /** 借りた形が生きていて、体積・妥当性・面の一覧が元のままであること。 */
  function expectUntouched(shape: TopoDS_Shape, tables: SubShapeTables): void {
    expect(shape.IsNull()).toBe(false);
    expect(isValidShape(oc, shape)).toBe(true);
    expect(measureVolume(oc, shape)).toBeCloseTo(BRACKET_VOLUME, 6);
    const again = collectTables(shape);
    expect(again.faces.map((face) => [face.surfaceKind, face.area, face.centroid]))
      .toEqual(tables.faces.map((face) => [face.surfaceKind, face.area, face.centroid]));
  }

  it('固定の形が probe と同じであること(面 9 枚、体積 V0、半径 4 の穴 1 つ)', () => {
    const { shape, tables } = bracket();
    expect(tables.faces).toHaveLength(9);
    expect(measureVolume(oc, shape)).toBeCloseTo(BRACKET_VOLUME, 6);
    expect(holeFaces(tables)).toHaveLength(1);
  });

  it.each([
    ['立ち上がりの上面を +5', 'top', 5],
    ['立ち上がりの上面を −5', 'top', -5],
    ['立ち上がりの上面を +12.5', 'top', 12.5],
    ['底板の端面を +5', 'end', 5],
    ['底板の端面を −5', 'end', -5],
  ] as const)('%s: 体積が V0 + 距離×面積、面は動き、関係のない穴は元のまま', (_title, which, offset) => {
    const { shape, tables } = bracket();
    const face = which === 'top' ? uprightTop(tables) : baseEnd(tables);
    expect(face.area).toBeCloseTo(MOVED_FACE_AREA, 9);
    const holesBefore = holeFaces(tables);
    expect(holesBefore).toHaveLength(1);
    const holeBefore = holesBefore[0];

    const result = editSolidFace(oc, shape, tables, { face: faceQuery(face), offset });
    try {
      expect(countSolidShapes(oc, result.shape, 2)).toBe(1);
      expect(isValidShape(oc, result.shape)).toBe(true);
      expect(result.volume).toBeCloseTo(BRACKET_VOLUME + offset * MOVED_FACE_AREA, 6);
      expect(measureVolume(oc, result.shape)).toBeCloseTo(result.volume, 9);

      const after = collectTables(result.shape);
      expect(after.faces).toHaveLength(9);
      const normal = face.axis;
      if (normal === null) throw new Error('動かす面の法線が読めません(検査の前提が崩れています)。');
      const movedCentroid: Vec3Tuple = [face.centroid[0] + normal[0] * offset,
        face.centroid[1] + normal[1] * offset, face.centroid[2] + normal[2] * offset];
      const moved = after.faces.filter((candidate) => candidate.surfaceKind === 'plane'
        && near(candidate.centroid, movedCentroid) && Math.abs(candidate.area - MOVED_FACE_AREA) < 1e-6);
      expect(moved).toHaveLength(1);
      // 元の位置に面が残っていない(全体の移動や、面を足しただけの形ではない)。
      expect(after.faces.some((candidate) => candidate.surfaceKind === 'plane'
        && near(candidate.centroid, face.centroid))).toBe(false);

      const holes = holeFaces(after);
      expect(holes).toHaveLength(1);
      const hole = holes[0];
      expect(hole.area).toBeCloseTo(HOLE_AREA, 6);
      expect(hole.area).toBeCloseTo(holeBefore.area, 9);
      expect(near(hole.centroid, holeBefore.centroid)).toBe(true);
    } finally {
      result.delete();
    }
    // 成功のあとも、借りた形は生きていて変わっていない。
    expectUntouched(shape, tables);
  });

  it('寸法の編集: 同じ参照で距離を変えて計算し直すと、その距離の形になる', () => {
    const { shape, tables } = bracket();
    const query = faceQuery(uprightTop(tables));
    const first = editSolidFace(oc, shape, tables, { face: query, offset: 5 });
    const firstVolume = first.volume;
    first.delete();
    const second = editSolidFace(oc, shape, tables, { face: query, offset: 10 });
    try {
      expect(firstVolume).toBeCloseTo(BRACKET_VOLUME + 5 * MOVED_FACE_AREA, 6);
      expect(second.volume).toBeCloseTo(BRACKET_VOLUME + 10 * MOVED_FACE_AREA, 6);
    } finally {
      second.delete();
    }
    expectUntouched(shape, tables);
  });

  it.each([-20, -60])('底板の端面を %s: 穴に当たるので断り、元の形は残る(probe では穴が消えた)', (offset) => {
    const { shape, tables } = bracket();
    expect(() => editSolidFace(oc, shape, tables, { face: faceQuery(baseEnd(tables)), offset }))
      .toThrow(FACE_OFFSET_COLLISION_MESSAGE);
    expectUntouched(shape, tables);
  });

  it.each([0, 1e-9, Number.NaN, Number.POSITIVE_INFINITY])('距離 %s は動かさない・数でないとして断る', (offset) => {
    const { shape, tables } = bracket();
    expect(() => editSolidFace(oc, shape, tables, { face: faceQuery(uprightTop(tables)), offset }))
      .toThrow(FACE_OFFSET_DISTANCE_MESSAGE);
    expectUntouched(shape, tables);
  });

  it('参照が今の形に届かない(形が変わった)ときは選び直しを求めて断る', () => {
    const { shape, tables } = bracket();
    const stale: SubShapeQuery = { kind: 'face', index: 99, surfaceKind: 'plane', area: 5000,
      position: [500, 500, 500], axis: [0, 1, 0], radius: null };
    expect(() => editSolidFace(oc, shape, tables, { face: stale, offset: 5 }))
      .toThrow(FACE_OFFSET_MISSING_FACE_MESSAGE);
    const vertex: SubShapeQuery = { kind: 'vertex', index: 0, position: [0, 0, 0] };
    expect(() => editSolidFace(oc, shape, tables, { face: vertex, offset: 5 }))
      .toThrow(FACE_OFFSET_MISSING_FACE_MESSAGE);
    expectUntouched(shape, tables);
  });

  it('穴の円柱面は平らでないので断る', () => {
    const { shape, tables } = bracket();
    const holes = holeFaces(tables);
    expect(holes).toHaveLength(1);
    const hole = holes[0];
    expect(() => editSolidFace(oc, shape, tables, { face: faceQuery(hole), offset: 1 }))
      .toThrow(FACE_OFFSET_NOT_PLANAR_MESSAGE);
    expectUntouched(shape, tables);
  });

  it('隣が円錐の面(円錐台の上面)は、面の枚数を見る前に隣の幾何で断る', () => {
    const origin = fixtures.keep(new oc.gp_Pnt_3(0, 0, 0));
    const up = fixtures.keep(new oc.gp_Dir_4(0, 0, 1));
    const axes = fixtures.keep(new oc.gp_Ax2_3(origin, up));
    const cone = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeCone_3(axes, 10, 6, 12)).Shape());
    const tables = collectTables(cone);
    const top = planarFace(tables, [0, 0, 1], (c) => Math.abs(c[2] - 12) < 1e-6);
    const volume = measureVolume(oc, cone);
    expect(() => editSolidFace(oc, cone, tables, { face: faceQuery(top), offset: 2 }))
      .toThrow(FACE_OFFSET_ADJACENT_MESSAGE);
    expect(measureVolume(oc, cone)).toBeCloseTo(volume, 9);
  });

  it('隣が斜めの平面(抜き勾配を付けた板の上面)も断る', () => {
    const plate = box(0, 0, 0, 40, 30, 10);
    const plateTables = collectTables(plate);
    const bottom = planarFace(plateTables, [0, 0, -1], (c) => Math.abs(c[2]) < 1e-6);
    const sides = plateTables.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
      && Math.abs(face.axis[2]) < 1e-9);
    expect(sides).toHaveLength(4);
    const drafted = fixtures.keep(makeDraft(oc, plate, plateTables, {
      faces: sides.map(faceQuery), neutralFace: faceQuery(bottom), angle: (5 * Math.PI) / 180, reversed: false }));
    const tables = collectTables(drafted.shape);
    const top = planarFace(tables, [0, 0, 1], (c) => Math.abs(c[2] - 10) < 1e-6);
    const volume = measureVolume(oc, drafted.shape);
    for (const offset of [2, -2]) {
      expect(() => editSolidFace(oc, drafted.shape, tables, { face: faceQuery(top), offset }))
        .toThrow(FACE_OFFSET_ADJACENT_MESSAGE);
    }
    expect(measureVolume(oc, drafted.shape)).toBeCloseTo(volume, 9);
  });

  it('立体が 2 つの形は、正しい 1 つの立体ではないので断る', () => {
    const builder = fixtures.keep(new oc.BRep_Builder());
    const compound = fixtures.keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    builder.Add(compound, box(0, 0, 0, 10, 10, 10));
    builder.Add(compound, box(20, 0, 0, 10, 10, 10));
    const tables = collectTables(compound);
    // 2 つの箱の上面はどちらも +Z なので、0 にならないことだけを確かめて 1 枚目を使う。
    const tops = tables.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
      && near(face.axis, [0, 0, 1], 1e-9));
    expect(tops).toHaveLength(2);
    const top = tops[0];
    expect(() => editSolidFace(oc, compound, tables, { face: faceQuery(top), offset: 1 }))
      .toThrow(FACE_OFFSET_INVALID_BODY_MESSAGE);
    expect(measureVolume(oc, compound)).toBeCloseTo(2000, 9);
  });
});

describe('EX18 W05 direct-edit borrowed shape ownership', () => {
  it.each([2, -30])('offset %s preserves exact source and unselected B-rep bytes without deleting either borrow', async offset => {
    const { createHash } = await import('node:crypto');
    const { vi } = await import('vitest');
    const { writeBrepBytes } = await import('./brepBytes.js');
    const oc = await loadOcctForNode(), owned = createAllocations();
    const digest = (shape: TopoDS_Shape): string => createHash('sha256').update(writeBrepBytes(oc, shape)).digest('hex');
    try {
      const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number): TopoDS_Shape => {
        const point = owned.keep(new oc.gp_Pnt_3(x, y, z));
        return owned.keep(owned.keep(new oc.BRepPrimAPI_MakeBox_3(point, dx, dy, dz)).Shape());
      };
      const base = box(0, 0, 0, 40, 30, 8), unselected = box(100, 100, 100, 2, 4, 6);
      const axis = owned.keep(new oc.gp_Ax2_3(owned.keep(new oc.gp_Pnt_3(10, 15, -1)), owned.keep(new oc.gp_Dir_4(0, 0, 1))));
      const bore = owned.keep(owned.keep(new oc.BRepPrimAPI_MakeCylinder_3(axis, 3, 10)).Shape());
      const drilled = owned.keep(booleanOp(oc, 'subtract', base, bore)), target = drilled.shape;
      const mesh = tessellate(oc, target), edges = extractEdges(oc, target);
      const tables = collectSubShapes(oc, target, mesh.faceRanges, edges.edgeRanges);
      const normal: Vec3Tuple = offset > 0 ? [0, 0, 1] : [1, 0, 0];
      const selected = tables.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
        && Math.hypot(...face.axis.map((value, index) => value - normal[index])) < 1e-9);
      expect(selected).toHaveLength(1);
      const face = selected[0];
      const query: SubShapeQuery = { kind: 'face', index: face.index, surfaceKind: face.surfaceKind,
        area: face.area, position: face.centroid, axis: face.axis, radius: face.radius };
      const targetBefore = digest(target), unselectedBefore = digest(unselected);
      const targetDelete = vi.spyOn(target, 'delete'), otherDelete = vi.spyOn(unselected, 'delete');
      try {
        if (offset > 0) {
          const edited = editSolidFace(oc, target, tables, { face: query, offset });
          try {
            expect(edited.shape.IsSame(target)).toBe(false);
            expect(Math.abs(edited.volume - (12000 - 90 * Math.PI)) / (12000 - 90 * Math.PI)).toBeLessThanOrEqual(1e-9);
            expect(countSolidShapes(oc, edited.shape, 2)).toBe(1);
          } finally { edited.delete(); }
        } else {
          expect(() => editSolidFace(oc, target, tables, { face: query, offset })).toThrow(FACE_OFFSET_COLLISION_MESSAGE);
        }
        expect(targetDelete).not.toHaveBeenCalled(); expect(otherDelete).not.toHaveBeenCalled();
        expect.soft(digest(target)).toBe(targetBefore); expect(digest(unselected)).toBe(unselectedBefore);
        // A later consumer must still be able to edit the original after either success or refusal.
        const followup = editSolidFace(oc, target, tables, { face: query, offset: 1 });
        try { expect(isValidShape(oc, followup.shape)).toBe(true); } finally { followup.delete(); }
        expect(targetDelete).not.toHaveBeenCalled(); expect(otherDelete).not.toHaveBeenCalled();
        expect.soft(digest(target)).toBe(targetBefore); expect(digest(unselected)).toBe(unselectedBefore);
      } finally { targetDelete.mockRestore(); otherDelete.mockRestore(); }
    } finally { owned.release(); }
  });
});

it('EX18 W05b releases every copied shape and copier once on success and collision refusal, retaining both borrows', async () => {
  const { createHash } = await import('node:crypto');
  const { stdout } = await import('node:process');
  const { vi } = await import('vitest');
  const { writeBrepBytes } = await import('./brepBytes.js');
  const oc = await loadOcctForNode(), owned = createAllocations();
  try {
    const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number): TopoDS_Shape => {
      const corner = owned.keep(new oc.gp_Pnt_3(x, y, z));
      return owned.keep(owned.keep(new oc.BRepPrimAPI_MakeBox_3(corner, dx, dy, dz)).Shape());
    };
    const base = box(0, 0, 0, 40, 30, 8), unselected = box(100, 100, 100, 2, 4, 6);
    const axes = owned.keep(new oc.gp_Ax2_3(owned.keep(new oc.gp_Pnt_3(10, 15, -1)), owned.keep(new oc.gp_Dir_4(0, 0, 1))));
    const tool = owned.keep(owned.keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 10)).Shape());
    const owner = owned.keep(booleanOp(oc, 'subtract', base, tool)), target = owner.shape;
    const mesh = tessellate(oc, target), edges = extractEdges(oc, target);
    const tables = collectSubShapes(oc, target, mesh.faceRanges, edges.edgeRanges);
    const snapshot = (shape: TopoDS_Shape) => {
      const bytes = writeBrepBytes(oc, shape);
      return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const before = snapshot(target), otherBefore = snapshot(unselected);
    const targetDelete = vi.spyOn(target, 'delete'), otherDelete = vi.spyOn(unselected, 'delete');
    const ownerDelete = vi.spyOn(owner, 'delete');
    const copies: { shape: TopoDS_Shape; shapeDeletes: number; makerDeletes: number }[] = [];
    // Observe real instances and their releases; leave the embind constructors and algorithms intact.
    const copyShape = vi.spyOn(oc.BRepBuilderAPI_Copy.prototype, 'Shape').mockImplementation(function (
      this: InstanceType<typeof oc.BRepBuilderAPI_Copy>,
    ) {
      const shape = oc.BRepBuilderAPI_MakeShape.prototype.Shape.call(this);
      const entry = { shape, shapeDeletes: 0, makerDeletes: 0 };
      const releaseShape = shape.delete.bind(shape), releaseMaker = this.delete.bind(this);
      shape.delete = () => { entry.shapeDeletes += 1; releaseShape(); };
      this.delete = () => { entry.makerDeletes += 1; releaseMaker(); };
      copies.push(entry);
      return shape;
    });
    try {
      for (const offset of [2, -30]) {
        const normal: Vec3Tuple = offset > 0 ? [0, 0, 1] : [1, 0, 0];
        const faces = tables.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
          && Math.hypot(...face.axis.map((value, index) => value - normal[index])) < 1e-9);
        expect(faces).toHaveLength(1);
        const face = faces[0];
        const query: SubShapeQuery = { kind: 'face', index: face.index, surfaceKind: face.surfaceKind,
          area: face.area, position: face.centroid, axis: face.axis, radius: face.radius };
        const copyCount = copies.length;
        if (offset > 0) {
          const edited = editSolidFace(oc, target, tables, { face: query, offset });
          try {
            expect(isValidShape(oc, edited.shape)).toBe(true);
            expect(edited.volume).toBeCloseTo(12000 - 90 * Math.PI, 8);
          } finally { edited.delete(); }
        } else {
          // The real kernel constructs the slab and Boolean result before rejecting the hole collision.
          expect(() => editSolidFace(oc, target, tables, { face: query, offset })).toThrow(FACE_OFFSET_COLLISION_MESSAGE);
        }
        // Face editing owns one copy. Strict subtraction additionally probes material
        // removal on two disposable copies in booleanOp.assertSolidRemains.
        const editCopyCount = offset > 0 ? 1 : 3;
        expect(copies).toHaveLength(copyCount + editCopyCount);
        for (const copy of copies.slice(copyCount)) {
          expect(copy.shapeDeletes).toBe(1); expect(copy.makerDeletes).toBe(1);
        }
        const after = snapshot(target);
        expect(after).toEqual(before); expect(snapshot(unselected)).toEqual(otherBefore);
        const followup = editSolidFace(oc, target, tables, { face: query, offset: 1 });
        try { expect(isValidShape(oc, followup.shape)).toBe(true); } finally { followup.delete(); }
        expect(copies).toHaveLength(copyCount + editCopyCount + 1);
        expect(copies.every(entry => entry.shapeDeletes === 1 && entry.makerDeletes === 1)).toBe(true);
        const afterFollowup = snapshot(target);
        expect(afterFollowup).toEqual(before); expect(snapshot(unselected)).toEqual(otherBefore);
        expect(targetDelete).not.toHaveBeenCalled(); expect(otherDelete).not.toHaveBeenCalled();
        expect(ownerDelete).not.toHaveBeenCalled();
        stdout.write(`EX18 W05b ownership: ${JSON.stringify({ offset, before, after, afterFollowup,
          unselected: otherBefore, targetDeleteCalls: targetDelete.mock.calls.length,
          unselectedDeleteCalls: otherDelete.mock.calls.length, ownerDeleteCalls: ownerDelete.mock.calls.length,
          copiedShapeDeleteCalls: copies.slice(copyCount).map(entry => entry.shapeDeletes),
          copierDeleteCalls: copies.slice(copyCount).map(entry => entry.makerDeletes) })}${String.fromCharCode(10)}`);
      }
    } finally {
      copyShape.mockRestore(); targetDelete.mockRestore(); otherDelete.mockRestore(); ownerDelete.mockRestore();
    }
  } finally { owned.release(); }
}, 180_000);

describe('EX18 W16 real-shape scope probes (not product implementations)', () => {
  let oc: OpenCascadeInstance;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  function tablesOf(shape: TopoDS_Shape): SubShapeTables {
    const mesh = tessellate(oc, shape), edges = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, edges.edgeRanges);
  }

  function queryOf(face: SolidFaceInfo): SubShapeQuery {
    return { kind: 'face', index: face.index, surfaceKind: face.surfaceKind, area: face.area,
      position: face.centroid, axis: face.axis, radius: face.radius };
  }

  function separation(a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function onePlane(tables: SubShapeTables, normal: Vec3Tuple): SolidFaceInfo {
    const matches = tables.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
      && separation(face.axis, normal) <= 1e-9);
    expect(matches).toHaveLength(1);
    return matches[0];
  }

  function expectVolume(shape: TopoDS_Shape, expected: number): number {
    const measured = measureVolume(oc, shape);
    expect(Math.abs(measured - expected) / expected).toBeLessThanOrEqual(1e-9);
    expect(countSolidShapes(oc, shape, 2)).toBe(1);
    expect(isValidShape(oc, shape)).toBe(true);
    return measured;
  }

  /** Each probe owns its temporary wrappers; neither borrowed source nor unrelated body is released. */
  async function scope(drilled: boolean) {
    const { createHash } = await import('node:crypto');
    const { stdout } = await import('node:process');
    const { vi } = await import('vitest');
    const { writeBrepBytes } = await import('./brepBytes.js');
    const { faceAt } = await import('./subShapes.js');
    const fixtures = createAllocations(), owned = createAllocations();
    const releases: { calls: number }[] = [];
    const keep: typeof owned.keep = item => {
      const entry = { calls: 0 }, originalDelete = item.delete.bind(item);
      item.delete = () => { entry.calls += 1; originalDelete(); };
      releases.push(entry);
      return owned.keep(item);
    };
    const box = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeBox_2(40, 30, 8)).Shape());
    const unrelated = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeBox_3(
      fixtures.keep(new oc.gp_Pnt_3(100, 100, 100)), 2, 4, 6)).Shape());
    const axes = fixtures.keep(new oc.gp_Ax2_3(fixtures.keep(new oc.gp_Pnt_3(10, 15, -1)),
      fixtures.keep(new oc.gp_Dir_4(0, 0, 1))));
    const bore = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 10)).Shape());
    const source = drilled ? fixtures.keep(booleanOp(oc, 'subtract', box, bore)).shape : box;
    const tables = tablesOf(source);
    const digest = (shape: TopoDS_Shape): string => createHash('sha256').update(writeBrepBytes(oc, shape)).digest('hex');
    const before = digest(source), otherBefore = digest(unrelated);
    expect(digest(source)).toBe(before);
    const sourceDelete = vi.spyOn(source, 'delete'), otherDelete = vi.spyOn(unrelated, 'delete');
    const record = (operation: string, data: object): void => {
      stdout.write(`EX18 W16 probe: ${JSON.stringify({ operation, ...data })}${String.fromCharCode(10)}`);
    };
    const unchanged = (): void => {
      expect(digest(source)).toBe(before);
      expect(digest(unrelated)).toBe(otherBefore);
      expect(sourceDelete).not.toHaveBeenCalled();
      expect(otherDelete).not.toHaveBeenCalled();
    };
    return {
      keep, source, tables, record, unchanged,
      copy: (): TopoDS_Shape => keep(keep(new oc.BRepBuilderAPI_Copy_2(source, true, false)).Shape()),
      face: (shape: TopoDS_Shape, index: number) => {
        const face = faceAt(oc, shape, index);
        if (face === null) throw new Error('W16 selected face disappeared');
        return keep(face);
      },
      unify: (shape: TopoDS_Shape): TopoDS_Shape => {
        const maker = keep(new oc.ShapeUpgrade_UnifySameDomain_1());
        maker.SetSafeInputMode(true);
        maker.Initialize(shape, true, true, false);
        maker.AllowInternalEdges(false);
        maker.Build();
        return keep(maker.Shape());
      },
      close: (): void => {
        try {
          owned.release();
          expect(releases.every(entry => entry.calls === 1)).toBe(true);
          unchanged();
          // Reuse the exact original after disposing all experimental results, including failed sewing.
          const top = onePlane(tables, [0, 0, 1]);
          const later = editSolidFace(oc, source, tables, { face: queryOf(top), offset: 1 });
          try { expectVolume(later.shape, drilled ? 10800 - 81 * Math.PI : 10800); }
          finally { later.delete(); }
          unchanged();
          record('ownership', { drilled, before, after: digest(source), unrelatedBefore: otherBefore,
            unrelatedAfter: digest(unrelated), sourceDeletes: sourceDelete.mock.calls.length,
            unrelatedDeletes: otherDelete.mock.calls.length, ownedWrappers: releases.length,
            ownedDeletes: releases.reduce((sum, entry) => sum + entry.calls, 0), followupOffset: 1 });
        } finally {
          sourceDelete.mockRestore(); otherDelete.mockRestore(); fixtures.release();
        }
      },
    };
  }

  it('hole X+2: current entry refuses a cylinder; copy/fill/translate/cut moves one straight through-hole', async () => {
    const probe = await scope(true), { keep, source, tables } = probe;
    try {
      const cylinders = tables.faces.filter(face => face.surfaceKind === 'cylinder');
      expect(cylinders).toHaveLength(1);
      const selected = cylinders[0];
      expect(selected.cylinderExterior).toBe(false);
      const bindingNames = ['BRepBuilderAPI_Copy_2', 'BRepBuilderAPI_Transform_2', 'BRepBuilderAPI_Sewing',
        'BRepOffsetAPI_ThruSections', 'BRepOffsetAPI_DraftAngle_2', 'ShapeUpgrade_UnifySameDomain_1'];
      for (const name of bindingNames) expect(typeof Reflect.get(oc, name)).toBe('function');
      const absentBindings = ['BRepFeat_SplitShape', 'BRepFeat_MakePrism', 'LocOpe_SplitShape', 'LocOpe_BuildShape',
        'ShapeFix_Shape', 'ShapeFix_Solid', 'ShapeFix_Shell', 'ShapeFix_Face', 'BRepTools_ReShape', 'BRepOffset_MakeOffset'];
      for (const name of absentBindings) expect(Reflect.has(oc, name)).toBe(false);
      probe.record('bindings', { present: bindingNames, absent: absentBindings });
      expect(() => editSolidFace(oc, source, tables, { face: queryOf(selected), offset: 2 }))
        .toThrow(FACE_OFFSET_NOT_PLANAR_MESSAGE);
      probe.unchanged();
      const measurements: object[] = [];
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const copied = probe.copy(), face = probe.face(copied, selected.index);
        const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
        const cylinder = keep(adaptor.Cylinder()), axis = keep(cylinder.Axis());
        const origin = keep(axis.Location()), along = keep(axis.Direction());
        const first = adaptor.FirstVParameter(), last = adaptor.LastVParameter();
        const start = keep(new oc.gp_Pnt_3(origin.X() + first * along.X(), origin.Y() + first * along.Y(),
          origin.Z() + first * along.Z()));
        expect(separation([start.X(), start.Y(), start.Z()], [10, 15, 0])).toBeLessThanOrEqual(1e-6);
        expect(last - first).toBeCloseTo(8, 9);
        const toolAxes = keep(new oc.gp_Ax2_3(start, along));
        // Tool dimensions come from the selected trimmed cylinder, not from the expected final box.
        const plug = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(toolAxes, cylinder.Radius(), last - first)).Shape());
        const filled = keep(booleanOp(oc, 'union', copied, plug));
        expectVolume(filled.shape, 9600);
        const shift = keep(new oc.gp_Trsf_1());
        shift.SetTranslation_1(keep(new oc.gp_Vec_4(2, 0, 0)));
        const translated = keep(keep(new oc.BRepBuilderAPI_Transform_2(plug, shift, true)).Shape());
        const cut = keep(booleanOp(oc, 'subtract', filled.shape, translated, undefined, undefined, { requireRemoval: true }));
        const result = probe.unify(cut.shape), after = tablesOf(result);
        probe.record('hole-candidate', { repeat, volume: measureVolume(oc, result), faces: after.faces });
        const volume = expectVolume(result, 9600 - 72 * Math.PI);
        expect(after.faces).toHaveLength(7);
        const holes = after.faces.filter(candidate => candidate.surfaceKind === 'cylinder');
        expect(holes).toHaveLength(1);
        const hole = holes[0];
        if (hole.axisOrigin === undefined || hole.axisOrigin === null || hole.axis === null) {
          throw new Error('W16 hole axis is unavailable');
        }
        const axisError = Math.hypot(hole.axisOrigin[0] - 12, hole.axisOrigin[1] - 15);
        expect(axisError).toBeLessThanOrEqual(1e-6);
        expect(Math.hypot(hole.axis[0], hole.axis[1])).toBeLessThanOrEqual(1e-9);
        expect(hole.radius).toBeCloseTo(3, 9);
        expect(hole.cylinderExterior).toBe(false);
        for (const normal of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as const) {
          const oldFace = onePlane(tables, normal), newFace = onePlane(after, normal);
          expect(separation(oldFace.centroid, newFace.centroid)).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(oldFace.area - newFace.area)).toBeLessThanOrEqual(1e-6);
        }
        measurements.push({ volume, axisOrigin: hole.axisOrigin, axisError, radius: hole.radius,
          faces: after.faces.length, solids: countSolidShapes(oc, result, 2) });
        probe.unchanged();
      }
      probe.record('hole-X+2', { currentEntry: FACE_OFFSET_NOT_PLANAR_MESSAGE, measurements });
    } finally { probe.close(); }
  }, 180_000);

  it('side tangent X+2: transformed face alone leaves an open shell; two-section prism rebuild gives the explicit shear', async () => {
    const probe = await scope(false), { keep, source, tables } = probe;
    try {
      const selected = onePlane(tables, [0, -1, 0]), opposite = onePlane(tables, [0, 1, 0]);
      const displacement: Vec3Tuple = [2, 0, 0];
      if (selected.axis === null) throw new Error('W16 side normal is unavailable');
      const projectedOffset = selected.axis.reduce((sum, component, index) => sum + component * displacement[index], 0);
      expect(projectedOffset).toBe(0);
      // The current scalar-normal contract cannot represent this request; projection is explicitly zero.
      expect(() => editSolidFace(oc, source, tables, { face: queryOf(selected), offset: projectedOffset }))
        .toThrow(FACE_OFFSET_DISTANCE_MESSAGE);
      const copied = probe.copy(), face = probe.face(copied, selected.index);
      const shift = keep(new oc.gp_Trsf_1());
      shift.SetTranslation_1(keep(new oc.gp_Vec_4(...displacement)));
      const transformed = keep(keep(new oc.BRepBuilderAPI_Transform_2(face, shift, true)).Shape());
      const movedFace = keep(oc.TopoDS.Face_1(transformed));
      const sew = keep(new oc.BRepBuilderAPI_Sewing(1e-7, true, true, true, false));
      for (const item of tables.faces) {
        sew.Add(item.index === selected.index ? movedFace : probe.face(copied, item.index));
      }
      sew.Perform(keep(new oc.Message_ProgressRange_1()));
      const sewed = keep(sew.SewedShape());
      const freeEdges = sew.NbFreeEdges(), solids = countSolidShapes(oc, sewed, 2);
      expect(freeEdges).toBe(8);
      expect(solids).toBe(0);
      expect(isValidShape(oc, sewed)).toBe(true);
      probe.record('tangent-transform-sew', { freeEdges, solids, validAsShape: isValidShape(oc, sewed) });

      // A different, explicit operation: preserve the opposite section and rebuild only a hole-free prism.
      // This is not a generic planar-support edit and must not discard features on an arbitrary solid.
      const measurements: object[] = [];
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const prismCopy = probe.copy(), moving = probe.face(prismCopy, selected.index);
        const shifted = keep(keep(new oc.BRepBuilderAPI_Transform_2(moving, shift, true)).Shape());
        const firstWire = keep(oc.BRepTools.OuterWire(keep(oc.TopoDS.Face_1(shifted))));
        const lastWire = keep(oc.BRepTools.OuterWire(probe.face(prismCopy, opposite.index)));
        const loft = keep(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-7));
        loft.CheckCompatibility(true);
        loft.AddWire(firstWire); loft.AddWire(lastWire);
        loft.Build(keep(new oc.Message_ProgressRange_1()));
        expect(loft.IsDone()).toBe(true);
        const result = keep(loft.Shape()), after = tablesOf(result);
        probe.record('tangent-candidate', { repeat, volume: measureVolume(oc, result), faces: after.faces,
          vertices: after.vertices.map(vertex => vertex.position) });
        const volume = expectVolume(result, 9600);
        const moved = onePlane(after, [0, -1, 0]), fixed = onePlane(after, [0, 1, 0]);
        const expectedCentroid: Vec3Tuple = [selected.centroid[0] + 2, selected.centroid[1], selected.centroid[2]];
        const displacementError = separation(moved.centroid, expectedCentroid);
        expect(displacementError).toBeLessThanOrEqual(1e-6);
        expect(separation(fixed.centroid, opposite.centroid)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(moved.area - selected.area)).toBeLessThanOrEqual(1e-6);
        expect(after.faces).toHaveLength(6);
        expect(after.vertices).toHaveLength(8);
        // Independent vertex oracle for x'=x+2(1-y/30), y'=y, z'=z; not a rigid body translation.
        for (const x of [0, 40]) for (const y of [0, 30]) for (const z of [0, 8]) {
          const wanted: Vec3Tuple = [x + 2 * (1 - y / 30), y, z];
          expect(after.vertices.filter(vertex => separation(vertex.position, wanted) <= 1e-6)).toHaveLength(1);
        }
        measurements.push({ volume, displacementError, movedCentroid: moved.centroid, fixedCentroid: fixed.centroid,
          faces: after.faces.length, vertices: after.vertices.map(vertex => vertex.position) });
        probe.unchanged();
      }
      probe.record('tangent-two-section-shear', { projectedOffset, currentEntry: FACE_OFFSET_DISTANCE_MESSAGE, measurements });
    } finally { probe.close(); }
  }, 180_000);

  it('top rotation +5 degrees about its X edge: DraftAngle extends adjacent planar supports on a private copy', async () => {
    const probe = await scope(false), { keep, source, tables } = probe;
    try {
      const selected = onePlane(tables, [0, 0, 1]), neutral = onePlane(tables, [0, -1, 0]);
      const hinges = tables.edges.filter(edge => edge.curveKind === 'line'
        && separation(edge.midpoint, [20, 0, 8]) <= 1e-6 && Math.abs(edge.length - 40) <= 1e-6);
      expect(hinges).toHaveLength(1);
      const angle = 5 * Math.PI / 180;
      // Positive scalar offset remains a parallel plane, not a rotation command.
      const normalControl = editSolidFace(oc, source, tables, { face: queryOf(selected), offset: 2 });
      try {
        expectVolume(normalControl.shape, 12000);
        expect(separation(onePlane(tablesOf(normalControl.shape), [0, 0, 1]).centroid, [20, 15, 10]))
          .toBeLessThanOrEqual(1e-6);
      } finally { normalControl.delete(); }
      const measurements: object[] = [];
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const copied = probe.copy(), top = probe.face(copied, selected.index);
        const neutralAdaptor = keep(new oc.BRepAdaptor_Surface_2(probe.face(copied, neutral.index), false));
        const plane = keep(neutralAdaptor.Plane()), pull = keep(new oc.gp_Dir_4(0, -1, 0));
        const draft = keep(new oc.BRepOffsetAPI_DraftAngle_2(copied));
        draft.Add(top, pull, angle, plane, true);
        probe.record('rotation-add', { repeat, addDone: draft.AddDone() });
        expect(draft.AddDone()).toBe(true);
        draft.Build(keep(new oc.Message_ProgressRange_1()));
        expect(draft.IsDone()).toBe(true);
        const result = keep(draft.Shape()), after = tablesOf(result);
        probe.record('rotation-candidate', { repeat, volume: measureVolume(oc, result), faces: after.faces,
          vertices: after.vertices.map(vertex => vertex.position) });
        const volume = expectVolume(result, 9600 + 18000 * Math.tan(angle));
        const expectedNormal: Vec3Tuple = [0, -Math.sin(angle), Math.cos(angle)];
        const moved = onePlane(after, expectedNormal);
        if (moved.axis === null) throw new Error('W16 rotated normal is unavailable');
        const measuredAngle = Math.atan2(-moved.axis[1], moved.axis[2]);
        const angleError = Math.abs(measuredAngle - angle);
        expect(angleError).toBeLessThanOrEqual(1e-8);
        expect(after.faces).toHaveLength(6);
        expect(after.vertices).toHaveLength(8);
        for (const x of [0, 40]) for (const y of [0, 30]) for (const topVertex of [false, true]) {
          const wanted: Vec3Tuple = [x, y, topVertex ? 8 + y * Math.tan(angle) : 0];
          expect(after.vertices.filter(vertex => separation(vertex.position, wanted) <= 1e-6)).toHaveLength(1);
        }
        const fixedBottom = onePlane(after, [0, 0, -1]);
        expect(separation(fixedBottom.centroid, [20, 15, 0])).toBeLessThanOrEqual(1e-6);
        measurements.push({ volume, measuredAngle, angleError, normal: moved.axis,
          hinge: hinges[0].midpoint, vertices: after.vertices.map(vertex => vertex.position) });
        probe.unchanged();
      }
      probe.record('rotation+5', { angle, currentEntry: 'face/offset only; +2 gives a parallel top at z=10', measurements });
    } finally { probe.close(); }
  }, 180_000);
});
