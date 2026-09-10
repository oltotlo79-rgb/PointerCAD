import { describe, expect, it } from 'vitest';
import type { DrawingView, Point2 } from '@pointercad/drawing';
import type { DrawingProjectionCurve } from './resolveDrawing.js';
import { projectionCenterMarks } from './projectionCenterMarks.js';

const view: DrawingView = { id: 'front', name: '正面', kind: 'front', direction: [0, 0, 1], xDir: [1, 0, 0], position: [100, 100],
  showCenterLines: true, showHidden: true, scale: null, layerId: 'layer-1' };
const circle = (edgeIndex = 0, radius = 5): DrawingProjectionCurve => ({ provenance: { kind: 'edge', bodyId: 'body', edgeIndex },
  curve: { kind: 'arc', center: [10, 20], radius, startAngle: 0, endAngle: Math.PI * 2 } });
const toPaper = ([x, y]: Point2): Point2 => [x * 2 + 100, y * 2 + 100];
describe('実投影の円と円柱から用紙上の中心線を作る', () => {
  it('縮尺2でも中心マークのはみ出しは紙面3mmで、同心の穴は最大径へまとめる', () => {
    expect(projectionCenterMarks(view, [circle(), circle(1, 3)], toPaper, 2)).toEqual([
      { kind: 'segment', from: [107, 140], to: [133, 140] }, { kind: 'segment', from: [120, 127], to: [120, 153] },
    ]);
  });
  it('線の順序と重複でマークを増やさず、表示を切れば全出力から消える', () => {
    expect(projectionCenterMarks(view, [circle(1), circle(), circle()], toPaper, 2)).toEqual(projectionCenterMarks(view, [circle(), circle(1)], toPaper, 2));
    expect(projectionCenterMarks({ ...view, showCenterLines: false }, [circle()], toPaper, 2)).toEqual([]);
  });
  it('同心輪の一つを非表示にした記録を辺の順序が変わっても保持する', () => {
    const sourceId = JSON.stringify(['body', null, 'edge', 0]);
    expect(projectionCenterMarks({ ...view, hiddenCenterMarkIds: [JSON.stringify([view.id, sourceId])] }, [circle(1), circle()], toPaper, 2)).toEqual([]);
  });
  it('逆向きの円柱の2側線を結び、その中心線を両端3mmだけ伸ばす', () => {
    const provenance = { kind: 'silhouette', bodyId: 'body', faceIndex: 4 };
    expect(projectionCenterMarks(view, [
      { provenance, curve: { kind: 'segment', from: [0, 0], to: [0, 20] } },
      { provenance, curve: { kind: 'segment', from: [10, 20], to: [10, 0] } },
    ], toPaper, 2, new Set([JSON.stringify(['body', null, 'silhouette', 4])]))).toEqual([{ kind: 'segment', from: [110, 97], to: [110, 143] }]);
  });
  it('途切れた円弧や一方だけの側線から架空の軸を補わない', () => {
    const arc = circle(); if (arc.curve.kind !== 'arc') throw new Error('circle');
    expect(projectionCenterMarks(view, [{ ...arc, curve: { ...arc.curve, endAngle: Math.PI } },
      { provenance: { kind: 'silhouette', faceIndex: 1 }, curve: { kind: 'segment', from: [0, 0], to: [10, 10] } }], toPaper, 2)).toEqual([]);
  });
});
