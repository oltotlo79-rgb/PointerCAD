import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import {
  absoluteCoordinate, appendSolid, createEmptyPartDocument, createPrimitiveFeature, replaceSketch, synchronizeConfigurations,
  type PartDocument, type PrimitiveFeature, type SketchFeature,
} from '../../packages/model/src/index.js';

/**
 * The document of plan appendix D (scratchpad/claude/plans/geomref-plan.md, GR-24): box 1 (20 x 30 x 40 at the
 * origin), box 2 (width = coefficient 幅B, 10 x 10, at x = 100) and one XY sketch with a 0 degree and a 0.5 degree
 * segment. Only the history is stored; the real kernel measures every value during the screen test.
 */
export const MATH_GEOMETRY_FIXTURE_FILE = 'math-geometry-fixture.pcad';
export const MATH_GEOMETRY_FIXTURE = {
  box1: { id: 'box-1', name: '箱1', size: [20, 30, 40] },
  box2: { id: 'box-2', name: '箱2', size: [10, 10, 10], origin: [100, 0, 0] },
  width: { name: '幅B', value: 10 },
  sketch: { id: 'sketch-1', name: 'スケッチ1' },
  line1: { id: 'line-1', name: '線分1', from: [0, 0], to: [50, 0] },
  /** (0, 20) -> (50, 20 + 50 tan 0.5 deg): 0.5 degrees from line 1 and 50 / cos 0.5 deg long. */
  line2: { id: 'line-2', name: '線分2', from: [0, 20], to: [50, 20 + 50 * Math.tan(0.5 * Math.PI / 180)] },
} as const;

function box(document: PartDocument, name: string, size: readonly [number, number, number],
  origin: readonly [number, number, number], widthSource?: string): PrimitiveFeature {
  const primitive = createPrimitiveFeature(document, 'box', { kind: 'coordinate', value: absoluteCoordinate(...origin) });
  if (primitive.shape.kind !== 'box') throw new Error('箱の基本形状を作れませんでした');
  const [x, y, z] = size.map(value => expressionValueFromNumber(value));
  return { ...primitive, name, shape: { ...primitive.shape,
    sizeX: widthSource === undefined ? x : { ...x, source: widthSource }, sizeY: y, sizeZ: z } };
}

export function mathGeometryFixtureDocument(): PartDocument {
  const { box1, box2, width, sketch, line1, line2 } = MATH_GEOMETRY_FIXTURE;
  const empty: PartDocument = { ...createEmptyPartDocument(), name: '図形の測定値の検査',
    parameters: [{ name: width.name, value: expressionValueFromNumber(width.value), unit: 'mm', description: '' }] };
  const base = empty.sketches[0];
  if (base === undefined || base.id !== sketch.id) throw new Error('初期スケッチが想定と異なります');
  const lines = [line1, line2].map((line): SketchFeature => ({ id: line.id, name: line.name, kind: 'line',
    planeId: 'xy', construction: false, from: absoluteCoordinate(line.from[0], line.from[1], 0),
    to: absoluteCoordinate(line.to[0], line.to[1], 0) }));
  let document = replaceSketch(empty, { ...base, name: sketch.name, features: lines });
  document = appendSolid(document, box(document, box1.name, box1.size, [0, 0, 0]));
  document = appendSolid(document, box(document, box2.name, box2.size, box2.origin, width.name));
  const ids = document.solids.map(solid => solid.id);
  if (ids.join() !== [box1.id, box2.id].join()) throw new Error(`箱の id が想定と異なります: ${ids.join()}`);
  return synchronizeConfigurations(document);
}

export function mathGeometryFixtureFile(): Uint8Array {
  return writePcadFile(mathGeometryFixtureDocument(), { savedAt: '2026-09-24T00:00:00.000Z' });
}
