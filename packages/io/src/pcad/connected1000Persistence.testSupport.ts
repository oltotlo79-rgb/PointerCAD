import { createEmptyPartDocument, replaceSketch, type ConstraintTarget, type CoordinateInput,
  type PartDocument, type SketchConstraint, type SketchFeature } from '@pointercad/model';
import { connected1000PointId, connected1000Sketch }
  from '../../../model/src/sketch/constraints/connected1000Fixture.testSupport.js';

// EX-13 W12/W13 fixture construction only. No test registration, solver,
// residual, file IO or scratchpad dependency; both layers use identical input.
const point = (index: number): ConstraintTarget => ({ kind: 'point', pointId: connected1000PointId(index) });
const curve = (featureId: string): ConstraintTarget => ({ kind: 'curve', element: { featureId } });
const vertex = (featureId: string, which: 'start' | 'end' | 'center'): ConstraintTarget =>
  ({ kind: 'vertex', featureId, vertex: which });
const expression = (source: string, value: number) => ({ source, value, display: String(value) });

// A separate schema21 fixture: the pure W01 distance fan, one fixed anchor,
// and consistent examples of ALL fourteen legacy kinds. The six auxiliary
// curves use expression-defined coordinates/radii and add no solver variables.
// There are 1000 authored point features (999 movable), not a schema21 file
// relabelled from the new vertical-distance fixture. Current W01 stays unchanged.
export function legacyConnected1000Part(): PartDocument {
  const base = createEmptyPartDocument();
  const fan = connected1000Sketch(base.sketches[0], false);
  const at = (x: number, y: number): CoordinateInput => ({ mode: 'absolute',
    x: expression(`${x}+0`, x), y: expression(`${y}+0`, y), z: expression('0+0', 0) });
  const line = (id: string, x: number, y: number, u: number, v: number): SketchFeature =>
    ({ id, name: id, kind: 'line', planeId: 'xy', from: at(x, y), to: at(u, v), construction: true });
  const circle = (id: string): SketchFeature => ({ id, name: id, kind: 'arc', planeId: 'xy',
    center: at(105, 95), radius: expression('10/2', 5), startAngle: expression('0', 0),
    endAngle: expression('360', 360), construction: true });
  const extra: SketchConstraint[] = [
    { id: 'old-coincident', name: 'coincident', kind: 'coincident', a: vertex('old-h', 'start'), b: vertex('old-v', 'start') },
    { id: 'old-horizontal', name: 'horizontal', kind: 'horizontal', target: curve('old-h') },
    { id: 'old-vertical', name: 'vertical', kind: 'vertical', target: curve('old-v') },
    { id: 'old-parallel', name: 'parallel', kind: 'parallel', a: curve('old-h'), b: curve('old-p') },
    { id: 'old-perpendicular', name: 'perpendicular', kind: 'perpendicular', a: curve('old-h'), b: curve('old-v') },
    { id: 'old-tangent', name: 'tangent', kind: 'tangent', line: curve('old-h'), circle: curve('old-c1') },
    { id: 'old-concentric', name: 'concentric', kind: 'concentric', a: vertex('old-c1', 'center'), b: vertex('old-c2', 'center') },
    { id: 'old-equal', name: 'equal', kind: 'equal', a: curve('old-c1'), b: curve('old-c2') },
    { id: 'old-symmetric', name: 'symmetric', kind: 'symmetric', a: vertex('old-h', 'start'), b: vertex('old-h', 'end'), axis: { featureId: 'old-axis' } },
    { id: 'old-fix', name: 'fix', kind: 'fix', target: point(1) },
    { id: 'old-angle', name: 'angle', kind: 'angle', a: curve('old-h'), b: curve('old-v'), angle: expression('180/2', 90) },
    { id: 'old-radius', name: 'radius', kind: 'radius', target: curve('old-c1'), size: expression('10/2', 5) },
    { id: 'old-diameter', name: 'diameter', kind: 'diameter', target: curve('old-c2'), size: expression('2*5', 10) },
  ];
  return { ...replaceSketch(base, { ...fan, features: [...fan.features,
    line('old-h', 100, 100, 110, 100), line('old-v', 100, 100, 100, 110),
    line('old-p', 100, 102, 110, 102), line('old-axis', 105, 90, 105, 110), circle('old-c1'), circle('old-c2')],
  constraints: [...(fan.constraints ?? []), ...extra] }), schemaVersion: 21 };
}

export function currentConnected1000Part(): PartDocument {
  const base = createEmptyPartDocument();
  return replaceSketch(base, connected1000Sketch(base.sketches[0]));
}

