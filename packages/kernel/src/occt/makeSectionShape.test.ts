import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { booleanOp } from './booleanOp.js';
import { makeSectionShape, NO_SECTION_AT_POSITION_MESSAGE } from './makeSectionShape.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });

const xy = (z: number) => ({ origin: [0, 0, z], axisU: [1, 0, 0], normal: [0, 0, 1] } as const);

describe('断面の切り出し', () => {
  it('Z方向のφ8貫通穴を軸を通るXZ面で切ると切り口の合計面積は240', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const point = new oc.gp_Pnt_3(10, 10, 0);
    const normal = new oc.gp_Dir_4(0, 0, 1);
    const axis = new oc.gp_Ax2_3(point, normal);
    const maker = new oc.BRepPrimAPI_MakeCylinder_3(axis, 4, 20);
    const tool = maker.Shape();
    const holed = booleanOp(oc, 'subtract', box.shape, tool);
    try {
      const result = makeSectionShape(oc, { target: holed.shape,
        plane: { origin: [0, 10, 0], axisU: [1, 0, 0], normal: [0, 1, 0] }, keepSide: 'positive' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        try {
          expect(result.cutFaces.reduce((sum, face) => sum + face.area, 0)).toBeCloseTo(400 - 8 * 20, 6);
          expect(result.volume).toBeCloseTo((8000 - Math.PI * 16 * 20) / 2, 6);
        } finally { result.delete(); }
      }
    } finally { holed.delete(); tool.delete(); maker.delete(); axis.delete(); normal.delete(); point.delete(); box.delete(); }
  });
  it.each([
    ['positive', 4000], ['negative', 4000],
  ] as const)('20立方体の中央で%s側を残すと体積4000', (keepSide, volume) => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = makeSectionShape(oc, { target: box.shape, plane: xy(10), keepSide });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.volume).toBeCloseTo(volume, 6);
        result.delete();
      }
    } finally { box.delete(); }
  });

  it('箱の切り口は1面・面積400・交線4本', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = makeSectionShape(oc, { target: box.shape, plane: xy(10), keepSide: 'positive' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.cutFaces).toHaveLength(1);
        expect(result.cutFaces[0]?.area).toBeCloseTo(400, 6);
        expect(result.cutCurves).toHaveLength(4);
        result.delete();
      }
    } finally { box.delete(); }
  });

  it.each([-10, 30])('交わらないz=%iは理由を返す', (z) => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      expect(makeSectionShape(oc, { target: box.shape, plane: xy(z), keepSide: 'positive' }))
        .toEqual({ ok: false, message: NO_SECTION_AT_POSITION_MESSAGE });
    } finally { box.delete(); }
  });

  it('半径10の球の中央は半球の体積と円の面積になる', () => {
    const maker = new oc.BRepPrimAPI_MakeSphere_1(10);
    const shape = maker.Shape();
    try {
      const result = makeSectionShape(oc, { target: shape, plane: xy(0), keepSide: 'positive' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.volume).toBeCloseTo((2 / 3) * Math.PI * 1000, 5);
        expect(result.cutFaces).toHaveLength(1);
        expect(result.cutFaces[0]?.area).toBeCloseTo(Math.PI * 100, 5);
        expect(result.cutCurves).toHaveLength(1);
        result.delete();
      }
    } finally { shape.delete(); maker.delete(); }
  });

  it('x方向の中央断面にも対応する', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    try {
      const result = makeSectionShape(oc, {
        target: box.shape,
        plane: { origin: [10, 0, 0], axisU: [0, 1, 0], normal: [1, 0, 0] },
        keepSide: 'negative',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.volume).toBeCloseTo(12000, 5);
        expect(result.cutFaces[0]?.area).toBeCloseTo(1200, 5);
        result.delete();
      }
    } finally { box.delete(); }
  });

  it('同じ入力の数値は決定的', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const values: number[] = [];
      for (let index = 0; index < 2; index += 1) {
        const result = makeSectionShape(oc, { target: box.shape, plane: xy(10), keepSide: 'positive' });
        expect(result.ok).toBe(true);
        if (result.ok) { values.push(result.volume, result.cutFaces[0]?.area ?? 0); result.delete(); }
      }
      expect(values.slice(0, 2)).toEqual(values.slice(2));
    } finally { box.delete(); }
  });

  it('0法線を投げずに断る', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      expect(makeSectionShape(oc, {
        target: box.shape,
        plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, 0, 0] },
        keepSide: 'positive',
      })).toEqual({ ok: false, message: NO_SECTION_AT_POSITION_MESSAGE });
    } finally { box.delete(); }
  });

  it('半断面は中心線の片側だけ切り、残りの体積は6000', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = makeSectionShape(oc, { target: box.shape, plane: xy(10), keepSide: 'positive',
        kind: 'half', boundary: [[10, 0], [10, 20]] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        try {
          expect(result.volume).toBeCloseTo(6000, 6);
          expect(result.cutFaces.reduce((sum, face) => sum + face.area, 0)).toBeCloseTo(200, 6);
          expect(result.cutCurves.every((curve) => curve.kind !== 'segment' || Math.max(curve.from[0], curve.to[0]) <= 10 + 1e-7)).toBe(true);
        } finally { result.delete(); }
      }
    } finally { box.delete(); }
  });

  it('部分断面は10角の輪郭内だけ深さ10を除き、体積7000・切り口100', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = makeSectionShape(oc, { target: box.shape, plane: xy(10), keepSide: 'negative',
        kind: 'local', boundary: [[5, 5], [15, 5], [15, 15], [5, 15]] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        try {
          expect(result.volume).toBeCloseTo(7000, 6);
          expect(result.cutFaces.reduce((sum, face) => sum + face.area, 0)).toBeCloseTo(100, 6);
          expect(result.cutCurves).toHaveLength(4);
        } finally { result.delete(); }
      }
    } finally { box.delete(); }
  });

  it('自己交差した部分断面は元の立体を壊さずに断る', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = makeSectionShape(oc, { target: box.shape, plane: xy(10), keepSide: 'negative',
        kind: 'local', boundary: [[5, 5], [15, 15], [5, 15], [15, 5]] });
      expect(result.ok).toBe(false);
      expect(box.shape.IsNull()).toBe(false);
    } finally { box.delete(); }
  });
  it('段付き断面は左右で高さ5と15に切り、合計体積4000を残す', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const result = makeSectionShape(oc, { target: box.shape, plane: xy(0), keepSide: 'negative',
        kind: 'stepped', boundary: [[0, 5], [10, 5], [10, 15], [20, 15]] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        try { expect(result.volume).toBeCloseTo(4000, 6); expect(result.cutFaces.length).toBeGreaterThanOrEqual(2); }
        finally { result.delete(); }
      }
    } finally { box.delete(); }
  });
});
