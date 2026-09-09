/**
 * OCCT HLR の所有者表(FR-702、rules/06 10.13)。
 *
 * | 値 | 所有権 |
 * |---|---|
 * | `new` した点・方向・軸・projector・converter | この関数の単独所有。allocations が逆順解放 |
 * | `new HLRBRep_*Algo` | Handle 構築成功時に所有を移譲。本体を別途 delete しない |
 * | `handle.get()` | 借用。呼び出し側は delete しない |
 * | `VCompound/HCompound/OutLine*Compound` | 新しい TopoDS wrapper。この関数が keep して解放 |
 * | 入力 shape | 形状キャッシュからの借用。この関数は解放しない |
 *
 * HLRToShape の形は projector の XY 座標へ変換済みであるため、元の作図面で再投影しない。
 * その形を XY 恒等平面で読み、二重変換を防ぐ。
 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type {
  HiddenLineCurve,
  HiddenLineMode,
  HiddenLineViewResult,
  Vec3Tuple,
} from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { readHlrSource } from './hlrProvenance.js';
import { boundingBoxOf, boundingBoxRange } from './placeBodies.js';
import { planeBasisOf, projectPointToPlane } from './makeProjection.js';
import { hasSolid } from './solidMesh.js';

export const NO_DRAWABLE_SOLID_MESSAGE = '図にできる立体がありません。';
const HLR_FAILED_MESSAGE = 'この形からは図を作れませんでした。';

export interface HiddenLineSource {
  readonly bodyId: string;
  readonly occurrenceId?: string | null;
  readonly shape: TopoDS_Shape;
}

export interface HiddenLineBodiesSpec {
  readonly viewId: string;
  readonly sources: readonly HiddenLineSource[];
  readonly origin: Vec3Tuple;
  readonly normal: Vec3Tuple;
  readonly xDir: Vec3Tuple;
  readonly mode: HiddenLineMode;
  readonly includeHidden: boolean;
}

export interface HiddenLineViewSpec extends Omit<HiddenLineBodiesSpec, 'sources'> {
  readonly shape: TopoDS_Shape;
  readonly bodyId?: string;
  readonly occurrenceId?: string | null;
}

export type HiddenLineViewOutcome =
  | { readonly ok: true; readonly result: HiddenLineViewResult }
  | { readonly ok: false; readonly message: string };

function finiteVector(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

function validateDirection(spec: HiddenLineBodiesSpec): boolean {
  if (!finiteVector(spec.origin) || !finiteVector(spec.normal) || !finiteVector(spec.xDir)) return false;
  const normalLength = Math.hypot(...spec.normal);
  const xLength = Math.hypot(...spec.xDir);
  if (!(normalLength > 0) || !(xLength > 0)) return false;
  const cosine = Math.abs(
    (spec.normal[0] * spec.xDir[0] + spec.normal[1] * spec.xDir[1] + spec.normal[2] * spec.xDir[2])
      / (normalLength * xLength),
  );
  return cosine < 1 - 1e-12;
}

/** 投影した境界箱が交わらない立体は互いを隠さない。重なるものだけ同じHLRへ渡す。 */
function occlusionGroups(oc: OpenCascadeInstance, spec: HiddenLineBodiesSpec): readonly (readonly HiddenLineSource[])[] {
  if (spec.sources.length < 2) return [spec.sources];
  const basis = planeBasisOf({ origin: spec.origin, normal: spec.normal, axisU: spec.xDir });
  const rectangles = spec.sources.map((source) => {
    const box = boundingBoxOf(oc, source.shape);
    try {
      const range = boundingBoxRange(box.box);
      const corners = [range.min[0], range.max[0]].flatMap((x) => [range.min[1], range.max[1]].flatMap((y) =>
        [range.min[2], range.max[2]].map((z) => projectPointToPlane([x, y, z], basis))));
      return { minU: Math.min(...corners.map((p) => p[0])), maxU: Math.max(...corners.map((p) => p[0])),
        minV: Math.min(...corners.map((p) => p[1])), maxV: Math.max(...corners.map((p) => p[1])) };
    } finally { box.delete(); }
  });
  const parents = rectangles.map((_, index) => index);
  const root = (index: number): number => { while (parents[index] !== index) index = parents[index]; return index; };
  for (let a = 0; a < rectangles.length; a += 1) {
    for (let b = a + 1; b < rectangles.length; b += 1) {
      const first = rectangles[a]; const second = rectangles[b];
      if (first.maxU < second.minU - 1e-7 || second.maxU < first.minU - 1e-7 ||
          first.maxV < second.minV - 1e-7 || second.maxV < first.minV - 1e-7) continue;
      parents[root(b)] = root(a);
    }
  }
  const groups = new Map<number, HiddenLineSource[]>();
  spec.sources.forEach((source, index) => {
    const key = root(index); const group = groups.get(key) ?? []; group.push(source); groups.set(key, group);
  });
  return [...groups.values()];
}

function preciseResult(
  oc: OpenCascadeInstance,
  spec: HiddenLineBodiesSpec,
  projector: InstanceType<OpenCascadeInstance['HLRAlgo_Projector_2']>,
  allocations: Allocations,
): HiddenLineViewResult {
  const raw = new oc.HLRBRep_Algo_1();
  let transferred = false;
  try {
    for (const source of spec.sources) raw.Add_2(source.shape, 0);
    raw.Projector_1(projector);
    raw.Update();
    raw.Hide_1();
    const handle = allocations.keep(new oc.Handle_HLRBRep_Algo_2(raw));
    transferred = true;
    // 借用が有効であることを確認するだけで、返った本体は所有・解放しない。
    if (handle.get() === undefined) throw new Error(HLR_FAILED_MESSAGE);
    const converter = allocations.keep(new oc.HLRBRep_HLRToShape(handle));
    const visible: HiddenLineCurve[] = [];
    const hidden: HiddenLineCurve[] = [];
    for (const source of spec.sources) {
      const bounds = allocations.keep(raw.ShapeBounds(raw.Index(source.shape)));
      const outliner = allocations.keep(bounds.Shape_2());
      const curves = readHlrSource(oc, converter, source,
        { origin: spec.origin, normal: spec.normal, axisU: spec.xDir },
        spec.mode, spec.includeHidden, allocations, outliner.get());
      visible.push(...curves.visible);
      hidden.push(...curves.hidden);
    }
    return { viewId: spec.viewId, visible, hidden };
  } finally {
    if (!transferred) raw.delete();
  }
}

function polyResult(
  oc: OpenCascadeInstance,
  spec: HiddenLineBodiesSpec,
  projector: InstanceType<OpenCascadeInstance['HLRAlgo_Projector_2']>,
  allocations: Allocations,
): HiddenLineViewResult {
  // 必要な精度の三角形が既にあれば読み取るだけ。無いときだけ複製へ分割を書き込む。
  const sources = spec.sources.map((source) => {
    if (oc.BRepTools.Triangulation(source.shape, 0.1, false)) return source;
    const copy = allocations.keep(new oc.BRepBuilderAPI_Copy_2(source.shape, true, true));
    const shape = allocations.keep(copy.Shape());
    allocations.keep(new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false));
    return { ...source, shape };
  });
  const raw = new oc.HLRBRep_PolyAlgo_1();
  let transferred = false;
  try {
    for (const source of sources) raw.Load(source.shape);
    raw.Projector_2(projector);
    raw.Update();
    const handle = allocations.keep(new oc.Handle_HLRBRep_PolyAlgo_2(raw));
    transferred = true;
    if (handle.get() === undefined) throw new Error(HLR_FAILED_MESSAGE);
    const converter = allocations.keep(new oc.HLRBRep_PolyHLRToShape());
    converter.Update(handle);
    const visible: HiddenLineCurve[] = [];
    const hidden: HiddenLineCurve[] = [];
    for (const source of sources) {
      const curves = readHlrSource(oc, converter, source,
        { origin: spec.origin, normal: spec.normal, axisU: spec.xDir },
        spec.mode, spec.includeHidden, allocations);
      visible.push(...curves.visible);
      hidden.push(...curves.hidden);
    }
    return { viewId: spec.viewId, visible, hidden };
  } finally {
    if (!transferred) raw.delete();
  }
}

/** 複数ボディを互いに隠し合う1つの投影として処理する。 */
export function hiddenLineViewForBodies(
  oc: OpenCascadeInstance,
  spec: HiddenLineBodiesSpec,
): HiddenLineViewOutcome {
  if (spec.sources.length === 0 || !spec.sources.some((source) => hasSolid(oc, source.shape))) {
    return { ok: false, message: NO_DRAWABLE_SOLID_MESSAGE };
  }
  if (!validateDirection(spec)) return { ok: false, message: HLR_FAILED_MESSAGE };

  const allocations = createAllocations();
  try {
    const point = allocations.keep(new oc.gp_Pnt_3(...spec.origin));
    const normal = allocations.keep(new oc.gp_Dir_4(...spec.normal));
    const xDir = allocations.keep(new oc.gp_Dir_4(...spec.xDir));
    const axes = allocations.keep(new oc.gp_Ax2_2(point, normal, xDir));
    const projector = allocations.keep(new oc.HLRAlgo_Projector_2(axes));
    projector.Scaled(false);
    const visible: HiddenLineCurve[] = []; const hidden: HiddenLineCurve[] = [];
    for (const sources of occlusionGroups(oc, spec)) {
      const groupAllocations = createAllocations();
      try {
        const group = { ...spec, sources };
        const projected = spec.mode === 'precise'
          ? preciseResult(oc, group, projector, groupAllocations)
          : polyResult(oc, group, projector, groupAllocations);
        visible.push(...projected.visible); hidden.push(...projected.hidden);
      } finally { groupAllocations.release(); }
    }
    const result = { viewId: spec.viewId, visible, hidden };
    if (result.visible.length === 0 && result.hidden.length === 0) {
      return { ok: false, message: HLR_FAILED_MESSAGE };
    }
    return { ok: true, result };
  } catch {
    return { ok: false, message: HLR_FAILED_MESSAGE };
  } finally {
    allocations.release();
  }
}

/** 単一ボディ用の便宜口。 */
export function hiddenLineView(
  oc: OpenCascadeInstance,
  spec: HiddenLineViewSpec,
): HiddenLineViewOutcome {
  return hiddenLineViewForBodies(oc, {
    ...spec,
    sources: [{ bodyId: spec.bodyId ?? 'body-1', occurrenceId: spec.occurrenceId, shape: spec.shape }],
  });
}
