import { drawingViewBasis, validateDrawingPolygon, type BreakSpec, type ClipRegion, type DrawingDocument, type DrawingExpressionValue,
  type DrawingPlaneDefinition, type DrawingView, type Point2, type Vector3 } from '@pointercad/drawing';
import { evaluateExpression } from '@pointercad/expression';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { ResolvedPlane } from '../geometry/planeSpec.js';
import { resolveDrawingPlane } from './resolveDrawingPlane.js';
import { auxiliaryDirectionFromPlane } from './viewDirection.js';
import { validateSectionBoundary, type SectionSpec } from './sectionSpec.js';
import type { DrawingSourceResolution } from './resolveDrawing.js';

export interface ConstructedDrawingView {
  readonly view: DrawingView;
  readonly modelCenter: Vector3;
  readonly clips?: readonly ClipRegion[];
  readonly breakSpec?: BreakSpec;
  readonly section?: { readonly plane: ResolvedPlane; readonly kind: SectionSpec['kind']; readonly keepSide: SectionSpec['keepSide']; readonly boundary?: readonly Point2[] };
}
export type DrawingConstructionResult = { readonly ok: true; readonly views: ReadonlyMap<string, ConstructedDrawingView> }
  | { readonly ok: false; readonly viewId: string; readonly message: string };

const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const planeDependencies = (plane: DrawingPlaneDefinition): readonly string[] => plane.kind === 'viewLine' ? [plane.sourceViewId]
  : plane.kind === 'face' ? [plane.target.viewId] : plane.kind === 'threePoints' ? plane.points.map((point) => point.viewId) : [];

/** 保存した作成条件を親図から順に解く。座標・投影・寸法で同じ結果を共有する。 */
export function resolveViewConstructions(document: DrawingDocument, source: DrawingSourceResolution): DrawingConstructionResult {
  if (new Set(document.views.map((view) => view.id)).size !== document.views.length) {
    return { ok: false, viewId: '', message: '図の識別が重複しています。図面を確認してください。' };
  }
  const complete = new Map<string, ConstructedDrawingView>();
  const visiting = new Set<string>();
  let failure: Extract<DrawingConstructionResult, { ok: false }> | null = null;
  const fail = (viewId: string, message: string): null => { failure ??= { ok: false, viewId, message }; return null; };
  const scalar = (input: DrawingExpressionValue): number | null => {
    const result = evaluateExpression(input.source, analyzeParameters(document.parameters, [input.source]));
    return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
  };
  function visit(id: string): ConstructedDrawingView | null {
    const cached = complete.get(id); if (cached !== undefined) return cached;
    const original = document.views.find((view) => view.id === id);
    if (original === undefined) return fail(id, 'もとにする図が見つかりません。図を選び直してください。');
    if (visiting.has(id)) return fail(id, '図どうしの参照が循環しています。もとの図を選び直してください。');
    visiting.add(id);
    const definition = original.construction;
    if (definition !== undefined && original.kind !== definition.kind) return fail(id, '図の種類と作成条件が一致しません。');
    const dependencies = definition === undefined ? [] : [
      ...('sourceViewId' in definition ? [definition.sourceViewId] : []),
      ...('plane' in definition ? planeDependencies(definition.plane) : []),
    ];
    for (const dependency of dependencies) if (visit(dependency) === null) return null;
    let frame: ConstructedDrawingView = { view: original, modelCenter: source.center };
    const parent = definition !== undefined && 'sourceViewId' in definition ? complete.get(definition.sourceViewId) : undefined;
    if (parent !== undefined) frame = { ...frame, modelCenter: parent.modelCenter,
      view: { ...original, direction: parent.view.direction, xDir: parent.view.xDir },
      ...(parent.section === undefined ? {} : { section: parent.section }),
      // 補助投影は新しい投影面。親図の二次元切り抜き領域を異なる面へ流用しない。
      ...(parent.clips === undefined || definition?.kind === 'auxiliary' ? {} : { clips: parent.clips }) };
    if (definition?.kind === 'section' || definition?.kind === 'auxiliary') {
      const views = document.views.map((view) => complete.get(view.id)?.view ?? view);
      const contextCenter = definition.plane.kind === 'viewLine' ? complete.get(definition.plane.sourceViewId)?.modelCenter ?? source.center : source.center;
      const plane = resolveDrawingPlane(definition.plane, { ...document, views }, { instances: source.dimensionInstances ?? [], modelCenter: contextCenter });
      if (!plane.ok) return fail(id, plane.message);
      if (definition.kind === 'section') {
        // 境界の個数・切り方は既存の切断契約で検証する。面の値は既に上で再評価済み。
        const invalid = validateSectionBoundary({ kind: definition.mode, boundary: definition.boundary });
        if (invalid !== null || definition.label.trim() === '') return fail(id, invalid ?? '断面の符号を入力してください。');
        // 正側を残した切り口は負側から正側へ見る。directionはカメラ位置ではなく視線の向き。
        const sign = (definition.keepSide === 'positive' ? 1 : -1) * (definition.reversed ? -1 : 1);
        const direction: Vector3 = [plane.plane.normal[0] * sign, plane.plane.normal[1] * sign, plane.plane.normal[2] * sign];
        frame = { ...frame, view: { ...original, direction, xDir: plane.plane.axisU },
          section: { plane: plane.plane, kind: definition.mode, keepSide: definition.keepSide, boundary: definition.boundary } };
      } else {
        const basis = parent === undefined ? null : drawingViewBasis({ normal: parent.view.direction, xDir: parent.view.xDir });
        if (basis === null) return fail(id, '補助投影図のもとの向きを決められません。');
        const direction = auxiliaryDirectionFromPlane(plane.plane, basis.y);
        if (!direction.ok) return fail(id, direction.message);
        frame = { ...frame, view: { ...original, direction: direction.direction.normal, xDir: direction.direction.xDir } };
      }
    } else if (definition !== undefined && parent !== undefined) {
      const basis = drawingViewBasis({ normal: parent.view.direction, xDir: parent.view.xDir });
      if (basis === null) return fail(id, 'もとの図の向きを決められません。');
      const rawCenter: Point2 = [dot(parent.modelCenter, basis.x), dot(parent.modelCenter, basis.y)];
      const rawPoint = (point: Point2): Point2 => [rawCenter[0] + point[0], rawCenter[1] + point[1]];
      if (definition.kind === 'detail') {
        const radius = scalar(definition.radius), scale = scalar(definition.scale);
        if (radius === null || radius <= 0 || scale === null || scale <= 0 || !definition.center.every(Number.isFinite)
          || definition.label.trim() === '') return fail(id, '詳細図の中心・半径・縮尺・符号を確認してください。');
        const coordinate = (axis: number): number => parent.modelCenter[axis] + basis.x[axis] * definition.center[0] + basis.y[axis] * definition.center[1];
        const center: Vector3 = [coordinate(0), coordinate(1), coordinate(2)];
        frame = { ...frame, modelCenter: center, view: { ...frame.view, scale }, clips: [...(frame.clips ?? []), { kind: 'circle', center: rawPoint(definition.center), radius }] };
      } else if (definition.kind === 'partial') {
        const region = definition.region;
        if (region.kind === 'circle') {
          const radius = scalar(region.radius);
          if (radius === null || radius <= 0 || !region.center.every(Number.isFinite)) return fail(id, '表示する円の中心と半径を確認してください。');
          frame = { ...frame, clips: [...(frame.clips ?? []), { kind: 'circle', center: rawPoint(region.center), radius }] };
        } else {
          const invalid = validateDrawingPolygon(region.points);
          if (invalid !== null) return fail(id, invalid);
          frame = { ...frame, clips: [...(frame.clips ?? []), { kind: 'polygon', points: region.points.map(rawPoint) }] };
        }
      } else if (definition.kind === 'broken') {
        const from = scalar(definition.from), to = scalar(definition.to), gap = scalar(definition.gap), scale = frame.view.scale ?? document.sheet.scale;
        if (from === null || to === null || gap === null || from >= to || gap < 0 || !Number.isFinite(scale) || scale <= 0
          || gap >= (to - from) * scale) return fail(id, '破断区間と残す隙間を正しく指定してください。');
        const origin = frame.view.position[definition.axis === 'u' ? 0 : 1];
        frame = { ...frame, breakSpec: { axis: definition.axis, from: origin + from * scale, to: origin + to * scale, keepGap: gap } };
      }
    }
    if (drawingViewBasis({ normal: frame.view.direction, xDir: frame.view.xDir }) === null) return fail(id, 'この向きでは図を作れません。');
    visiting.delete(id); complete.set(id, frame); return frame;
  }
  for (const view of document.views) if (visit(view.id) === null) break;
  return failure ?? { ok: true, views: complete };
}
