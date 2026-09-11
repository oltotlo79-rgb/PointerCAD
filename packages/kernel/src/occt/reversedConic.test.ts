import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CurveSpec } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeCurveEdge } from './makeSketchEdges.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
describe('時計回りの円弧・楕円弧を反対側の長い弧へ変えない', () => {
  it.each(['arc', 'ellipse'] as const)('%sの短い区間・半周・全周を同じ向きで作る', (kind) => {
    for (const endAngle of [-Math.PI / 2, -Math.PI, -2 * Math.PI]) {
      const common = { center: [0, 0, 0], normal: [0, 0, 1], startAngle: 0, endAngle } as const;
      const curve: CurveSpec = kind === 'arc' ? { ...common, kind, xAxis: [1, 0, 0], radius: 3 }
        : { ...common, kind, majorAxis: [1, 0, 0], majorRadius: 3, minorRadius: 2 };
      const handle = makeCurveEdge(oc, curve), adaptor = new oc.BRepAdaptor_Curve_2(handle.edge);
      try {
        expect(handle.edge.Orientation_1()).toBe(oc.TopAbs_Orientation.TopAbs_REVERSED);
        expect(adaptor.LastParameter() - adaptor.FirstParameter()).toBeCloseTo(Math.abs(endAngle), 10);
        if (endAngle > -2 * Math.PI) {
          const middle = adaptor.Value((adaptor.FirstParameter() + adaptor.LastParameter()) / 2);
          try {
            expect(middle.X()).toBeCloseTo(3 * Math.cos(endAngle / 2), 9);
            expect(middle.Y()).toBeCloseTo((kind === 'arc' ? 3 : 2) * Math.sin(endAngle / 2), 9);
          } finally { middle.delete(); }
        }
      } finally { adaptor.delete(); handle.delete(); }
    }
  });
});
