import type { DimensionTarget, DrawingDocument, DrawingPlaneDefinition, DrawingView, DrawingViewConstruction, Point2 } from '@pointercad/drawing';
import { evaluateExpression } from '@pointercad/expression';
import { analyzeParameters } from '@pointercad/model';

export interface ConstructedViewFields {
  readonly name: string; readonly x: string; readonly y: string; readonly scale: string;
  readonly centerX: string; readonly centerY: string; readonly radius: string;
  readonly offset: string; readonly from: string; readonly to: string; readonly gap: string;
  readonly lineX1: string; readonly lineY1: string; readonly lineX2: string; readonly lineY2: string;
  readonly boundary: string; readonly label: string;
}
export function initialConstructedViewFields(view: DrawingView | undefined, name: string): ConstructedViewFields {
  const construction = view?.construction;
  const plane = construction !== undefined && 'plane' in construction ? construction.plane : undefined;
  const region = construction?.kind === 'partial' ? construction.region : undefined;
  const center = construction?.kind === 'detail' ? construction.center : region?.kind === 'circle' ? region.center : [0, 0];
  return {
    name: view?.name ?? name, x: String(view?.position[0] ?? 220), y: String(view?.position[1] ?? 160),
    scale: construction?.kind === 'detail' ? construction.scale.source : view?.scale == null ? '' : String(view.scale),
    centerX: String(center[0]), centerY: String(center[1]),
    radius: construction?.kind === 'detail' ? construction.radius.source : region?.kind === 'circle' ? region.radius.source : '10',
    offset: plane !== undefined && 'offset' in plane ? plane.offset.source : '0',
    from: construction?.kind === 'broken' ? construction.from.source : '-5',
    to: construction?.kind === 'broken' ? construction.to.source : '5', gap: construction?.kind === 'broken' ? construction.gap.source : '3',
    lineX1: String(plane?.kind === 'viewLine' ? plane.from[0] : -15), lineY1: String(plane?.kind === 'viewLine' ? plane.from[1] : 0),
    lineX2: String(plane?.kind === 'viewLine' ? plane.to[0] : 15), lineY2: String(plane?.kind === 'viewLine' ? plane.to[1] : 0),
    boundary: (construction?.kind === 'section' ? construction.boundary : region?.kind === 'polygon' ? region.points : undefined)
      ?.map((point) => point.join(',')).join('\n') ?? '-10,-10\n10,-10\n10,10\n-10,10',
    label: construction !== undefined && 'label' in construction ? construction.label : 'A',
  };
}

export interface ConstructedViewChoices {
  readonly kind: DrawingViewConstruction['kind']; readonly sourceViewId: string;
  readonly planeKind: DrawingPlaneDefinition['kind']; readonly workPlane: 'xy' | 'xz' | 'yz';
  readonly mode: Extract<DrawingViewConstruction, { kind: 'section' }>['mode'];
  readonly keepSide: 'positive' | 'negative'; readonly reversed: boolean;
  readonly regionKind: 'circle' | 'polygon'; readonly axis: 'u' | 'v';
}

/** 文字入力を値と式へ変換し、不完全な状態を文書へ保存しない。 */
export function parseConstructedViewDraft(document: DrawingDocument, fields: ConstructedViewFields, choices: ConstructedViewChoices,
  targets: readonly DimensionTarget[], original?: DrawingViewConstruction): {
    readonly construction: DrawingViewConstruction; readonly position: Point2; readonly scale: number | null;
  } | null {
  const parameters = analyzeParameters(document.parameters, Object.values(fields));
  const expression = (source: string) => {
    if (source.trim() === '') return null;
    const result = evaluateExpression(source, parameters);
    return result.ok && Number.isFinite(result.value.value) ? result.value : null;
  };
  const xy = (x: string, y: string): Point2 | null => {
    const first = expression(x), second = expression(y);
    return first === null || second === null ? null : [first.value, second.value];
  };
  const position = xy(fields.x, fields.y), scale = fields.scale.trim() === '' ? null : expression(fields.scale);
  if (position === null || fields.scale.trim() !== '' && scale === null) return null;
  const polygon = (): readonly Point2[] | null => {
    const points: Point2[] = [];
    for (const line of fields.boundary.trim().split(/[\n;]+/)) {
      const coordinates = line.trim().split(',');
      if (coordinates.length !== 2) return null;
      const point = xy(coordinates[0], coordinates[1]); if (point === null) return null; points.push(point);
    }
    return points;
  };
  const plane = (): DrawingPlaneDefinition | null => {
    const previous = original !== undefined && 'plane' in original ? original.plane : undefined;
    if (choices.planeKind === 'threePoints') {
      const points = targets.length === 0 && previous?.kind === 'threePoints' ? previous.points : targets;
      return points.length === 3 ? { kind: 'threePoints', points: [points[0], points[1], points[2]] } : null;
    }
    if (choices.planeKind === 'viewLine') {
      const from = xy(fields.lineX1, fields.lineY1), to = xy(fields.lineX2, fields.lineY2);
      return from === null || to === null ? null : { kind: 'viewLine', sourceViewId: choices.sourceViewId, from, to };
    }
    const offset = expression(fields.offset); if (offset === null) return null;
    if (choices.planeKind === 'workPlane') return { kind: 'workPlane', planeId: choices.workPlane, offset };
    const target = targets.length === 0 && previous?.kind === 'face' ? previous.target : targets.length === 1 ? targets[0] : null;
    return target === null ? null : { kind: 'face', target, offset };
  };
  let construction: DrawingViewConstruction;
  if (choices.kind === 'section' || choices.kind === 'auxiliary') {
    const definition = plane(); if (definition === null) return null;
    if (choices.kind === 'auxiliary') construction = { kind: 'auxiliary', sourceViewId: choices.sourceViewId, plane: definition };
    else {
      const boundary = choices.mode === 'full' || choices.mode === 'revolved' ? undefined : polygon();
      if (boundary === null) return null;
      construction = { kind: 'section', plane: definition, mode: choices.mode, keepSide: choices.keepSide, reversed: choices.reversed,
        label: fields.label.trim(), ...(boundary === undefined ? {} : { boundary }) };
    }
  } else if (choices.kind === 'broken') {
    const from = expression(fields.from), to = expression(fields.to), gap = expression(fields.gap);
    if (from === null || to === null || gap === null) return null;
    construction = { kind: 'broken', sourceViewId: choices.sourceViewId, axis: choices.axis, from, to, gap };
  } else if (choices.kind === 'partial' && choices.regionKind === 'polygon') {
    const points = polygon(); if (points === null) return null;
    construction = { kind: 'partial', sourceViewId: choices.sourceViewId, region: { kind: 'polygon', points } };
  } else {
    const center = xy(fields.centerX, fields.centerY), radius = expression(fields.radius);
    if (center === null || radius === null) return null;
    if (choices.kind === 'detail') {
      if (scale === null) return null;
      construction = { kind: 'detail', sourceViewId: choices.sourceViewId, center, radius, scale, label: fields.label.trim() };
    } else construction = { kind: 'partial', sourceViewId: choices.sourceViewId, region: { kind: 'circle', center, radius } };
  }
  return { construction, position, scale: choices.kind === 'detail' ? null : scale?.value ?? null };
}
