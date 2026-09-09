import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import * as allocationModule from './allocations.js';
import type { OcctDeletable } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { measureVolume } from './solidMesh.js';
import { hiddenLineView, hiddenLineViewForBodies, NO_DRAWABLE_SOLID_MESSAGE } from './makeHiddenLineViews.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => { oc = await loadOcctForNode(); });

const runtimeClasses = [
  'HLRBRep_Algo_1', 'Handle_HLRBRep_Algo_2', 'HLRBRep_HLRToShape', 'HLRAlgo_Projector_2',
  'HLRBRep_PolyAlgo_3', 'Handle_HLRBRep_PolyAlgo_2', 'HLRBRep_PolyHLRToShape',
  'BRepAlgoAPI_Section_5', 'gp_Ax2_2', 'gp_Pln_2',
] as const;

function runBox(mode: 'precise' | 'poly', normal: readonly [number, number, number] = [0, 0, 1]) {
  const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
  try {
    return hiddenLineView(oc, {
      viewId: 'front', shape: box.shape, bodyId: 'box', origin: [0, 0, 0],
      normal, xDir: normal[0] === 0 ? [1, 0, 0] : [0, 1, 0], mode, includeHidden: true,
    });
  } finally { box.delete(); }
}

describe('図面の隠線処理', () => {
  it.each(runtimeClasses)('%s が実行時にも存在する', (name) => {
    expect(oc[name]).toBeTypeOf('function');
  });

  it('空入力は投げずに理由を返す', () => {
    expect(hiddenLineViewForBodies(oc, {
      viewId: 'empty', sources: [], origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0],
      mode: 'precise', includeHidden: true,
    })).toEqual({ ok: false, message: NO_DRAWABLE_SOLID_MESSAGE });
  });

  it('0法線は投げずに失敗を返す', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      expect(hiddenLineView(oc, {
        viewId: 'bad', shape: box.shape, origin: [0, 0, 0], normal: [0, 0, 0], xDir: [1, 0, 0],
        mode: 'precise', includeHidden: true,
      }).ok).toBe(false);
    } finally { box.delete(); }
  });

  it.each(['precise', 'poly'] as const)('%sで20立方体の正面図を返す', (mode) => {
    const outcome = runBox(mode);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.viewId).toBe('front');
      expect(outcome.result.visible).toHaveLength(4);
      expect(outcome.result.hidden).toHaveLength(4);
      expect(outcome.result.visible.every((item) => item.provenance.bodyId === 'box')).toBe(true);
    }
  });

  it('隠線を切るとhiddenは空になる', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const outcome = hiddenLineView(oc, {
        viewId: 'front', shape: box.shape, origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0],
        mode: 'precise', includeHidden: false,
      });
      expect(outcome.ok && outcome.result.hidden).toEqual([]);
    } finally { box.delete(); }
  });

  it('等角図には正面図より多い可視線がある', () => {
    const front = runBox('precise');
    const iso = runBox('precise', [1, 1, 1]);
    expect(front.ok && iso.ok).toBe(true);
    if (front.ok && iso.ok) expect(iso.result.visible.length).toBeGreaterThan(front.result.visible.length);
  });

  it('同じ入力の線数と座標は決定的', () => {
    expect(runBox('precise')).toEqual(runBox('precise'));
  });

  it('近似の円弧出力は折れ線へ正規化する', () => {
    const maker = new oc.BRepPrimAPI_MakeCylinder_1(10, 20);
    const shape = maker.Shape();
    try {
      const outcome = hiddenLineView(oc, {
        viewId: 'circle', shape, origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0],
        mode: 'poly', includeHidden: true,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.result.visible.some((item) => item.curve.kind === 'polyline')).toBe(true);
    } finally { shape.delete(); maker.delete(); }
  });

  it('繰り返し後も無関係な形を扱える', () => {
    for (let index = 0; index < 20; index += 1) expect(runBox('poly').ok).toBe(true);
    const box = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    expect(box.shape.IsNull()).toBe(false);
    box.delete();
  });

  it('等角図は可視9本・隠線3本で、元辺と径数範囲をすべて識別する', () => {
    const outcome = runBox('precise', [1, 1, 1]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.visible).toHaveLength(9);
    expect(outcome.result.hidden).toHaveLength(3);
    const edges = [...outcome.result.visible, ...outcome.result.hidden].map((item) => item.provenance);
    expect(edges.every((edge) => edge.kind === 'edge' && edge.edgeIndex !== null
      && edge.dimensionTarget && edge.parameterRange !== null
      && Math.abs(edge.parameterRange[1] - edge.parameterRange[0] - 20) < 1e-7)).toBe(true);
    expect(new Set(edges.flatMap((edge) => edge.kind === 'edge' ? [edge.edgeIndex] : []))).toHaveLength(12);
  });

  it('正面で重なる手前と奥の4辺は別の元辺として返す', () => {
    const outcome = runBox('precise');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const visible = outcome.result.visible.flatMap((item) => item.provenance.kind === 'edge' ? [item.provenance.edgeIndex] : []);
    const hidden = outcome.result.hidden.flatMap((item) => item.provenance.kind === 'edge' ? [item.provenance.edgeIndex] : []);
    expect(visible).toHaveLength(4);
    expect(hidden).toHaveLength(4);
    expect(visible.some((index) => hidden.includes(index))).toBe(false);
  });

  it('正面図の寸法20×20、外周面積400を保つ', () => {
    const outcome = runBox('precise');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const points = outcome.result.visible.flatMap((item) => item.curve.kind === 'segment' ? [item.curve.from, item.curve.to] : []);
    const width = Math.max(...points.map((point) => point[0])) - Math.min(...points.map((point) => point[0]));
    const height = Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]));
    expect(width).toBeCloseTo(20, 9); expect(height).toBeCloseTo(20, 9);
    expect(width * height).toBeCloseTo(400, 9);
  });

  it('箱の精密と近似で可視・隠線の本数が一致する', () => {
    const precise = runBox('precise', [1, 1, 1]); const poly = runBox('poly', [1, 1, 1]);
    expect(precise.ok && poly.ok).toBe(true);
    if (precise.ok && poly.ok) {
      expect(poly.result.visible).toHaveLength(precise.result.visible.length);
      expect(poly.result.hidden).toHaveLength(precise.result.hidden.length);
    }
  });

  it('球の輪郭は元面のシルエットで、元辺と取り違えない', () => {
    const maker = new oc.BRepPrimAPI_MakeSphere_1(10); const shape = maker.Shape();
    try {
      const outcome = hiddenLineView(oc, { viewId: 'sphere', shape, origin: [0, 0, 0], normal: [1, 1, 1], xDir: [1, -1, 0], mode: 'precise', includeHidden: true });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.visible.some((item) => item.provenance.kind === 'silhouette'
          && item.provenance.faceIndex === 0 && !item.provenance.dimensionTarget)).toBe(true);
      }
    } finally { shape.delete(); maker.delete(); }
  });

  it('直径8の貫通穴は正面で半径4の可視円・隠れ円を保つ', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const point = new oc.gp_Pnt_3(10, 10, 0); const normal = new oc.gp_Dir_4(0, 0, 1);
    const axis = new oc.gp_Ax2_3(point, normal); const maker = new oc.BRepPrimAPI_MakeCylinder_3(axis, 4, 20);
    const tool = maker.Shape(); const holed = booleanOp(oc, 'subtract', box.shape, tool);
    try {
      const outcome = hiddenLineView(oc, { viewId: 'hole', shape: holed.shape, origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0], mode: 'precise', includeHidden: true });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) for (const curves of [outcome.result.visible, outcome.result.hidden]) {
        const circles = curves.filter((item) => item.curve.kind === 'arc');
        expect(circles).toHaveLength(1);
        expect(circles[0]?.curve).toMatchObject({ center: [10, 10], radius: 4 });
        expect(circles[0]?.provenance).toMatchObject({ kind: 'edge', dimensionTarget: true });
      }
    } finally { holed.delete(); tool.delete(); maker.delete(); axis.delete(); normal.delete(); point.delete(); box.delete(); }
  });

  it('成功と例外の反復後に観測した全wrapperを解放する', () => {
    const original = allocationModule.createAllocations;
    let live = 0;
    const spy = vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
      const allocation = original();
      return {
        keep<T extends OcctDeletable>(item: T): T {
          live += 1; const dispose = item.delete.bind(item);
          item.delete = () => { try { dispose(); } finally { live -= 1; } };
          return allocation.keep(item);
        },
        release: allocation.release,
      };
    });
    try {
      for (let index = 0; index < 100; index += 1) {
        expect(runBox(index % 2 === 0 ? 'poly' : 'precise').ok).toBe(true);
        expect(live).toBe(0);
      }
      const update = vi.spyOn(oc.HLRBRep_Algo_1.prototype, 'Update').mockImplementation(() => { throw new Error('HLR failure'); });
      try { expect(runBox('precise').ok).toBe(false); expect(live).toBe(0); }
      finally { update.mockRestore(); }
      const box = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
      try { expect(measureVolume(oc, box.shape)).toBeCloseTo(24, 9); }
      finally { box.delete(); }
    } finally { spy.mockRestore(); }
  });
});
