import type { Point2, Vector3 } from '../types.js';
import type { InkBounds } from '../render/types.js';
import type { Dimension, DimensionTarget } from './types.js';
import { drawingViewBasis } from './series.js';
import { formatDimension } from './format.js';
import { createLinearDimensionGeometry } from './geometry.js';
import { arrangeDimensions, type DimensionArrangementItem, type DimensionTextBox } from './placement.js';

/** targetはモデルの頂点・円の参照。紙面の点だけを元寸法としない。 */
export interface AutoDimensionPoint {
  readonly id: string;
  readonly target: DimensionTarget;
  readonly modelPoint: Vector3;
  readonly paperPoint: Point2;
}
export interface AutoDimensionCircle extends AutoDimensionPoint {
  readonly radius: number;
  readonly full: boolean;
}
export interface AutoDimensionInput {
  readonly viewId: string;
  readonly direction: Vector3;
  readonly xDir: Vector3;
  readonly boundary: readonly AutoDimensionPoint[];
  readonly circles: readonly AutoDimensionCircle[];
  readonly existing: readonly Dimension[];
  readonly layerId: string;
  readonly measureText: (text: string) => { readonly inkBounds: InkBounds; readonly advanceMm: number } | null;
  /** 手動寸法など、動かしてはいけない既存文字の実測矩形。 */
  readonly existingTextBoxes?: readonly DimensionTextBox[];
}
export interface AutoDimensionResult {
  readonly dimensions: readonly Dimension[];
  readonly createdIds: readonly string[];
  readonly unresolvedOverlapIds: readonly string[];
}
const GAP = 8;
const TOLERANCE = 1e-7;
// 字形が接触していなくても隣の寸法と読める間隔を取る。両側1mmで計2mm。
const paddedTextBox = (box: DimensionTextBox): DimensionTextBox => ({ ...box, bounds: {
  left: box.bounds.left - 1, right: box.bounds.right + 1, bottom: box.bounds.bottom - 1, top: box.bounds.top + 1,
} });

/** 全体幅/高さ、同径の円、穴の位置を安定した順番で記入する(P8-38)。 */
export function autoDimension(input: AutoDimensionInput): AutoDimensionResult | null {
  const basis = drawingViewBasis({ normal: input.direction, xDir: input.xDir });
  if (basis === null || input.boundary.length === 0) return null;
  const all = [...input.boundary, ...input.circles];
  if (new Set(all.map((point) => point.id)).size !== all.length
    || all.some((point) => point.target.viewId !== input.viewId || ![...point.modelPoint, ...point.paperPoint].every(Number.isFinite)
      || (point.target.kind === 'point' && point.target.modelPoint === undefined))
    || input.circles.some((circle) => !Number.isFinite(circle.radius) || circle.radius <= 0)) return null;
  const component = (point: AutoDimensionPoint, axis: 0 | 1): number => {
    const vector = axis === 0 ? basis.x : basis.y;
    return point.modelPoint[0] * vector[0] + point.modelPoint[1] * vector[1] + point.modelPoint[2] * vector[2];
  };
  const sorted = (points: readonly AutoDimensionPoint[], axis: 0 | 1) => [...points].sort((a, b) =>
    component(a, axis) - component(b, axis) || a.id.localeCompare(b.id, 'en'));
  const xPoints = sorted(input.boundary, 0), yPoints = sorted(input.boundary, 1);
  const left = xPoints[0], right = xPoints[xPoints.length - 1], bottom = yPoints[0], top = yPoints[yPoints.length - 1];
  const paperLeft = Math.min(...input.boundary.map((point) => point.paperPoint[0]));
  const paperBottom = Math.min(...input.boundary.map((point) => point.paperPoint[1]));
  const paperTop = Math.max(...input.boundary.map((point) => point.paperPoint[1]));
  const created: Dimension[] = [];
  const items: DimensionArrangementItem[] = [];
  const boxes: DimensionTextBox[] = [];
  let failed = false;
  const append = (dimension: Dimension, text: string, center: Point2, normal: Point2, reference: number): void => {
    const measured = input.measureText(text);
    if (measured === null || !Number.isFinite(measured.advanceMm) || measured.advanceMm < 0
      || !Object.values(measured.inkBounds).every(Number.isFinite)) { failed = true; return; }
    const ink = measured.inkBounds;
    const width = ink.right - ink.left, height = ink.top - ink.bottom;
    if (width < 0 || height < 0) { failed = true; return; }
    created.push({ ...dimension, placement: { ...dimension.placement, textPosition: center } });
    items.push({ id: dimension.id, viewId: input.viewId, placement: created[created.length - 1].placement,
      normal, referenceNormalCoordinate: reference });
    boxes.push({ ownerId: dimension.id, bounds: {
      left: center[0] - measured.advanceMm / 2 + ink.left, right: center[0] - measured.advanceMm / 2 + ink.right,
      bottom: center[1], top: center[1] + height } });
  };
  const length = (first: AutoDimensionPoint, second: AutoDimensionPoint, axis: 0 | 1, role: string): void => {
    const value = Math.abs(component(second, axis) - component(first, axis));
    if (value < TOLERANCE) return;
    const id = `auto:${input.viewId}:${role}:${first.id}:${second.id}`;
    const h = axis === 0 ? paperBottom - GAP : -paperLeft + GAP;
    const geometry = createLinearDimensionGeometry({ first: first.paperPoint, second: second.paperPoint,
      direction: axis === 0 ? [1, 0] : [0, 1], commonNormalCoordinate: h });
    if (geometry === null) { failed = true; return; }
    append({ id, kind: 'length', measurement: axis === 0 ? 'horizontal' : 'vertical', targets: [first.target, second.target],
      placement: { commonNormalCoordinate: h, textPosition: null }, reference: false, origin: 'auto', layerId: input.layerId },
    formatDimension({ value, kind: 'length' }), geometry.textPosition, axis === 0 ? [0, 1] : [-1, 0],
    axis === 0 ? (first.paperPoint[1] + second.paperPoint[1]) / 2 : -(first.paperPoint[0] + second.paperPoint[0]) / 2);
  };
  length(left, right, 0, 'width');
  length(bottom, top, 1, 'height');
  const circles = [...input.circles].sort((a, b) => a.radius - b.radius || a.id.localeCompare(b.id, 'en'));
  const groups: AutoDimensionCircle[][] = [];
  for (const circle of circles) {
    const group = groups.find((candidate) => candidate[0].full === circle.full && Math.abs(candidate[0].radius - circle.radius) <= TOLERANCE);
    if (group === undefined) groups.push([circle]); else group.push(circle);
  }
  for (const [index, group] of groups.entries()) {
    const first = group[0], kind = first.full ? 'diameter' : 'radius';
    const prefix = group.length > 1 ? `${group.length}×` : undefined;
    const id = `auto:${input.viewId}:${kind}:${first.id}`;
    const h = paperTop + GAP * (index + 1);
    append({ id, kind, measurement: 'radius', targets: [first.target], placement: { commonNormalCoordinate: h, textPosition: null },
      ...(prefix === undefined ? {} : { prefix }), reference: false, origin: 'auto', layerId: input.layerId },
    formatDimension({ value: first.radius * (first.full ? 2 : 1), kind, prefix }), [first.paperPoint[0], h], [0, 1], first.paperPoint[1]);
  }
  const centers = [...input.circles].filter((circle) => circle.full).sort((a, b) =>
    component(a, 1) - component(b, 1) || component(a, 0) - component(b, 0) || a.id.localeCompare(b.id, 'en'));
  const rows: AutoDimensionCircle[][] = [];
  for (const center of centers) {
    const row = rows.find((candidate) => Math.abs(component(candidate[0], 1) - component(center, 1)) <= TOLERANCE);
    if (row === undefined) rows.push([center]);
    else if (!row.some((candidate) => Math.abs(component(candidate, 0) - component(center, 0)) <= TOLERANCE)) row.push(center);
  }
  for (const row of rows) {
    length(bottom, row[0], 1, 'holeY');
    let previous: AutoDimensionPoint = left;
    for (const center of row) { length(previous, center, 0, 'holeX'); previous = center; }
  }
  if (failed) return null;
  const arranged = arrangeDimensions(items, [...boxes, ...(input.existingTextBoxes ?? [])].map(paddedTextBox));
  if (arranged === null) return null;
  const untouched = input.existing.filter((dimension) => dimension.origin !== 'auto'
    || !dimension.targets.some((target) => target.viewId === input.viewId));
  const occupiedIds = new Set(untouched.map((dimension) => dimension.id));
  if (created.some((dimension) => occupiedIds.has(dimension.id))) return null;
  return { dimensions: [...untouched, ...created.map((dimension, index) => ({ ...dimension, placement: arranged.placements[index] }))],
    createdIds: created.map((dimension) => dimension.id), unresolvedOverlapIds: arranged.unresolvedOverlapIds };
}
