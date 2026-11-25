import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';

import { exceedsMagnitude } from '../../../numericTolerance.js';
import { appendSolid, nextSolidId, nextSolidName, replaceSketch } from '../../../part/createPartDocument.js';
import type { HoleFeature, PartDocument } from '../../../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../../../sketch/createSketchDocument.js';
import { activeSketch, planeFace } from '../../standard/partPrimitives.js';
import type { CatalogItemRow, CatalogOptionSpec } from '../types.js';
import { buildPanelBoardPart, type PanelBoardDimensions } from './panelBoard.js';

const SOLID_BOARD = /^(?:plate-(?:a5052|ss400)|resin-(?:pc|petg?|pmma|pvc))-/u;
const EDGE_TOLERANCE_MM = 0.000001;

/** Only modeled, solid stock with order dimensions accepts an additional machining operation. */
export function canMachinePanelBoard(row: CatalogItemRow): boolean {
  return SOLID_BOARD.test(row.key) && row.dims.width === undefined && row.dims.height === undefined
    && (row.simplified?.length ?? 0) === 0;
}

export const PANEL_HOLE_OPTIONS: readonly CatalogOptionSpec[] = [
  { key: 'holeDiameter', kind: 'numberExpression', labelKey: 'catalog.framePanel.holeDiameter', defaultValue: '0', min: 0, optional: true },
  { key: 'holeX', kind: 'numberExpression', labelKey: 'catalog.framePanel.holeX', defaultValue: '0', min: 0, optional: true },
  { key: 'holeY', kind: 'numberExpression', labelKey: 'catalog.framePanel.holeY', defaultValue: '0', min: 0, optional: true },
];

interface PanelHole {
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
}

function readLength(text: string | undefined): number {
  const result = evaluateExpression(text ?? '0');
  return result.ok ? result.value.value : NaN;
}

/** Offsets are measured from the selected face's local left and bottom edges. */
export function panelBoardHole(row: CatalogItemRow, size: readonly [number, number], values: Readonly<Record<string, string>>):
PanelHole | null | false {
  const diameter = readLength(values.holeDiameter), x = readLength(values.holeX), y = readLength(values.holeY);
  if (diameter === 0 && x === 0 && y === 0) return null;
  if (!canMachinePanelBoard(row) || ![diameter, x, y].every(Number.isFinite) || diameter <= EDGE_TOLERANCE_MM) return false;
  const [width, height] = size;
  const margin = diameter / 2 + EDGE_TOLERANCE_MM;
  const inside = (at: number, span: number): boolean => at > 0 && span > at
    && exceedsMagnitude(at, margin) && exceedsMagnitude(span - at, margin);
  return inside(x, width) && inside(y, height) ? { x, y, diameter } : false;
}

/** Add the usual machining feature so the bore has a hole identity in the evaluated part. */
export function makeMachinedPanelBoard(dims: PanelBoardDimensions, hole: PanelHole | null): PartDocument | null {
  const board = buildPanelBoardPart(dims);
  if (board === null || hole === null) return board;
  const stock = board.solids[0];
  if (stock?.kind !== 'extrude') return null;
  const sketch = activeSketch(board);
  const point = createPointFeature(sketch, absoluteCoordinate(hole.x - dims.width / 2, hole.y - dims.height / 2, 0));
  const feature: HoleFeature = {
    id: nextSolidId(board, 'hole'), name: nextSolidName(board, 'hole'), kind: 'hole', suppressed: false,
    targetFeatureId: stock.id, face: planeFace(stock.id, dims.width * dims.height, dims.thickness),
    centers: [{ sketchId: sketch.id, pointFeatureId: point.id }], diameter: expressionValueFromNumber(hole.diameter),
    depth: { kind: 'through' }, tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
  };
  return appendSolid(replaceSketch(board, appendFeature(sketch, point)), feature);
}
