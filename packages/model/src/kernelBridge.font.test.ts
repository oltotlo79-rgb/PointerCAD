/** P8-44: 固定字体の輪郭が実OCCTでも穴を保つことを確認する。 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFontStore, outlineCurves } from '@pointercad/drawing';
import { createAllocations, bsplineDataForSpline, measureArea, measureVolume } from '@pointercad/kernel';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { makeCurveEdge } from '../../kernel/src/occt/makeSketchEdges.js';

const root = new URL('../../../', import.meta.url);
if (!existsSync(new URL('pnpm-workspace.yaml', root))) throw new Error('字体検査のリポジトリ起点が違います。');
const fontPath = new URL('apps/web/public/fonts/NotoSansJP-Regular.otf', root);
const available = existsSync(fontPath);
if (!available) console.warn('字体が未導入のため、文字の実OCCT面張りと押し出し検査を省略します。');

describe.skipIf(!available)('固定字体の3次B-spline・穴あき面・押し出し(P8-44)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(fontPath)).buffer) });
  beforeAll(async () => {
    expect(await font.load()).toBe('ready');
    oc = await loadOcctForNode();
  });

  // 固定したSans2.004の各Mの対応。外周/穴の向きはoutlineCurvesが保ったまま渡す。
  // 「板」は右の囲み(輪0+穴1)と左の木へん(輪2)の2面。
  it.each([
    { character: '8', regions: [[0, 1, 2]] },
    { character: 'φ', regions: [[1, 0, 2]] },
    { character: '日', regions: [[2, 0, 1]] },
    { character: '板', regions: [[0, 1], [2]] },
  ])('$characterは穴を保ったまま面積と体積が一致する', ({ character, regions }) => {
    const outlined = font.outline(character, 3.5);
    expect(outlined.status).toBe('ready');
    const contours = outlineCurves(outlined.subpaths);
    if (contours === null) throw new Error('閉じた文字輪郭を作れません。');
    expect(contours).toHaveLength(3);
    const { keep, release } = createAllocations();
    try {
      const wires = contours.map((contour) => {
        const builder = keep(new oc.BRepBuilderAPI_MakeWire_1());
        for (const curve of contour.curves) {
          if (curve.kind === 'spline') {
            const data = bsplineDataForSpline(curve);
            expect(data.degree).toBe(3);
            expect(data.knots).toEqual([0, 1]);
            expect(data.multiplicities).toEqual([4, 4]);
            expect(data.poles).toEqual(curve.points);
          }
          builder.Add_1(keep(makeCurveEdge(oc, curve)).edge);
        }
        expect(builder.IsDone()).toBe(true);
        const wire = keep(builder.Wire());
        expect(wire.Closed_1()).toBe(true);
        return wire;
      });
      let area = 0;
      let volume = 0;
      const thickness = 2;
      for (const [outer, ...holes] of regions) {
        expect(contours[outer].signedArea).toBeGreaterThan(0);
        const builder = keep(new oc.BRepBuilderAPI_MakeFace_15(wires[outer], true));
        for (const hole of holes) {
          expect(contours[hole].signedArea).toBeLessThan(0);
          builder.Add(wires[hole]);
        }
        expect(builder.IsDone()).toBe(true);
        const face = keep(builder.Face());
        expect(oc.BRepAlgo.IsValid_1(face)).toBe(true);
        area += measureArea(oc, face);
        const vector = keep(new oc.gp_Vec_4(0, 0, thickness));
        const extruder = keep(new oc.BRepPrimAPI_MakePrism_1(face, vector, false, true));
        expect(extruder.IsDone()).toBe(true);
        const solid = keep(extruder.Shape());
        expect(oc.BRepAlgo.IsValid_1(solid)).toBe(true);
        volume += measureVolume(oc, solid);
      }
      const exactArea = contours.reduce((sum, contour) => sum + contour.signedArea, 0);
      expect(exactArea).toBeGreaterThan(0);
      expect(Math.abs(area - exactArea)).toBeLessThan(1e-6);
      expect(Math.abs(volume - exactArea * thickness)).toBeLessThan(2e-6);
      console.log(`[字体の実測] ${character}: ${regions.length}面、面積${area}mm²、厚み${thickness}の体積${volume}mm³`);
    } finally {
      release();
    }
  });
});
