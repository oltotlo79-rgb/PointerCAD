/**
 * 面を張らずに押し出す(M-01)の M01-3: 押し出しの道具で面を選んでいない間だけ、作図面の閉じた領域を見せ、
 * カーソルの下を濃くし、押して選ぶ。選んだ領域から結果と相手の提案(M01-4、`extrudeSuggestion.ts`)も入れる。
 *
 * - 領域の検出は model の純関数(`regionFace.ts` の `sketchRegionScan` が覚える)。ここは「いま領域を選ぶ状態か」
 *   「どの領域を塗るか」「押した所をどうするか」を、ストアの値から決めるだけ(ストアは読むだけで変えない)。
 * - 領域のホバーは、ストアの `hoveredElementId` に領域の id(`@region:` で始まる)を入れて表す。id は要素の id の
 *   区切り(`#`)を持たないので、木・部分形状・スケッチの要素の強調は領域の id を要素と取り違えない。
 * - 3D スケッチ(作図面なし)・組立の画面・面を選んでいる時は出さない(面を選んでいれば今までどおり面で押し出す)。
 * - 面が既に張ってある領域は、面そのものを押せるので塗らない(同じ所を二重に塗らない)。
 */
import {
  addVec3, belowMagnitude, crossVec3, DEFAULT_FACE_COLOR, dotVec3, isFreeWorkPlaneId, regionAtPoint, scaleVec3, subVec3,
  type SketchElementRef, type Vec3,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { NumericInputState } from '../sketch/numericInput.js';
import type { PointerRay } from '../sketch/trackMath.js';
import type { AppState } from '../store/appState.js';
import type { RegionFillInput } from '../viewport/buildRegionFill.js';
import { extrudeTargetCandidates } from './extrudeOperation.js';
import { suggestExtrudeOperations, withExtrudeSuggestions, type SuggestionBody } from './extrudeSuggestion.js';
import {
  pickableSketchRegions, pickExtrudeRegion, sketchRegionScan, type SketchRegion, type SketchRegionScan,
} from './regionFace.js';
import { selectedFaceRef } from './solidCommands.js';

const REGION_ELEMENT_PREFIX = '@region:';

/** 領域を選ぶ状態かを決めるのに読むストアの値。 */
type RegionModeState = Pick<AppState, 'activeTool' | 'numericInput' | 'document' | 'selection' | 'sketch'
  | 'resolvedSketch' | 'workPlaneId' | 'assembly' | 'hoveredElementId'>;

/** 押した所から領域を選ぶ時に、提案のために読む立体(ストアの `bodies`)。 */
type RegionClickState = RegionModeState & { readonly bodies: readonly SuggestionBody[] };

interface PickableRegion {
  readonly elementId: string;
  readonly region: SketchRegion;
}

/** 領域を選ぶ状態の材料(検出の結果と、その中で塗って押せる領域)。 */
interface ActiveExtrudeRegions {
  readonly scan: SketchRegionScan;
  readonly regions: readonly PickableRegion[];
}

/** 視線が作図面とほぼ平行(この値より内積が小さい)なら、その作図面との交点を取らない。 */
const RAY_PARALLEL_EPSILON = 1e-12;

type RegionClickOutcome =
  | { readonly kind: 'picked'; readonly input: NumericInputState }
  | { readonly kind: 'refused'; readonly reasonKey: MessageKey };

/** 領域の id。境界の参照を並べた物で、要素の id の区切り(`#`)を使わない(index は `.` でつなぐ)。 */
function regionElementId(boundary: readonly SketchElementRef[]): string {
  return REGION_ELEMENT_PREFIX + boundary.map(ref => (ref.index === undefined ? ref.featureId : `${ref.featureId}.${String(ref.index)}`))
    .join('+');
}

function isRegionElementId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(REGION_ELEMENT_PREFIX);
}

/** 押し出しの欄を開いていて、面を選んでいない(領域を押して選ぶ)状態か。 */
function choosesRegion(state: RegionModeState): boolean {
  const input = state.numericInput;
  return state.assembly === null && state.activeTool === 'extrude' && input !== null && input.toolId === 'extrude'
    && input.step === 'extrudeDistance' && !isFreeWorkPlaneId(state.workPlaneId)
    && !selectedFaceRef(state.document, state.selection).ok;
}

/** 領域を選ぶ状態なら、塗って押せる領域。そうでなければ null(作図面に乗る輪が 1 つも無い時も null)。 */
export function activeExtrudeRegions(state: RegionModeState): ActiveExtrudeRegions | null {
  if (!choosesRegion(state)) return null;
  const scan = sketchRegionScan(state.sketch, state.resolvedSketch);
  if (scan.frames.length === 0) return null;
  const regions = pickableSketchRegions(state.sketch, scan).map(region => ({ elementId: regionElementId(region.boundary), region }));
  return { scan, regions };
}

/**
 * 視線と各作図面の交点のうち、領域に当たるいちばん手前の物(穴の候補のある領域・面のある領域も含む)。
 * 作図面が複数あっても、画面で手前に見えている領域を選ぶ。どの領域にも当たらなければ null。
 */
function regionHitAlongRay(scan: SketchRegionScan, ray: PointerRay): { readonly point: Vec3; readonly region: SketchRegion } | null {
  let best: { readonly point: Vec3; readonly region: SketchRegion } | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  for (const frame of scan.frames) {
    const normal = crossVec3(frame.u, frame.v), facing = dotVec3(ray.direction, normal);
    if (belowMagnitude(facing, RAY_PARALLEL_EPSILON)) continue;
    const distance = dotVec3(subVec3(frame.origin, ray.origin), normal) / facing;
    if (!(distance > 0) || distance >= nearest) continue;
    const point = addVec3(ray.origin, scaleVec3(ray.direction, distance));
    const region = regionAtPoint(scan, point);
    if (region === null) continue;
    best = { point, region };
    nearest = distance;
  }
  return best;
}

/** 視線の先(いちばん手前の領域)が塗って押せる領域なら、その id。そうでなければ null。 */
export function regionHoverIdAt(active: ActiveExtrudeRegions, ray: PointerRay): string | null {
  const hit = regionHitAlongRay(active.scan, ray);
  return active.regions.find(candidate => candidate.region === hit?.region)?.elementId ?? null;
}

/**
 * 視線の先(いちばん手前の領域)を押し出しの欄へ入れ、位置と押す向きから結果と相手を提案する。
 * 選べない時は、次にする操作が分かる理由を返す。領域を選ぶ状態でなければ null(今までどおりの押下に任せる)。
 */
export function clickExtrudeRegion(state: RegionClickState, ray: PointerRay): RegionClickOutcome | null {
  const input = state.numericInput, active = activeExtrudeRegions(state);
  if (input === null || active === null) return null;
  const hit = regionHitAlongRay(active.scan, ray);
  if (hit === null) {
    return { kind: 'refused', reasonKey: active.scan.crossingFeatureIds.size > 0 ? 'solidError.regionCrossing' : 'solidError.regionNone' };
  }
  const pick = pickExtrudeRegion(state.sketch, state.resolvedSketch, hit.point);
  if (!pick.ok) return { kind: 'refused', reasonKey: pick.reasonKey };
  // 面が張ってある領域は、面を選ぶ今までの押下に任せる(同じ所に面を 2 枚作らない)。
  if (!active.regions.some(candidate => candidate.region === hit.region)) return null;
  const chosen: NumericInputState = { ...input, extrudeRegion: pick.region };
  if (hit.region.normal === null) return { kind: 'picked', input: chosen };
  const candidates = extrudeTargetCandidates(state.document).map(candidate => candidate.value);
  const suggestions = suggestExtrudeOperations(hit.point, hit.region.normal, state.bodies, candidates);
  return { kind: 'picked', input: withExtrudeSuggestions(chosen, suggestions) };
}

/** 領域を選ぶ状態で、まだ領域を選んでいない間だけ、押し出しの欄に出す案内。 */
export function extrudeRegionHintKey(state: RegionModeState): MessageKey | null {
  if (state.numericInput?.extrudeRegion !== undefined) return null;
  return (activeExtrudeRegions(state)?.regions.length ?? 0) > 0 ? 'numericInput.extrudeRegionPick' : null;
}

/** 領域の塗りの材料(塗る領域・カーソルの下・選んだ領域・色)。領域を選ぶ状態でなければ null。 */
export function regionFillInputOf(state: RegionModeState): RegionFillInput | null {
  const active = activeExtrudeRegions(state);
  if (active === null) return null;
  const chosen = state.numericInput?.extrudeRegion;
  return {
    regions: active.regions.map(({ elementId, region }) => ({ elementId, polygon: region.polygon,
      holes: region.holes.map(boundary => active.scan.regions.find(candidate =>
        regionElementId(candidate.boundary) === regionElementId(boundary))?.polygon ?? []) })),
    hoveredElementId: isRegionElementId(state.hoveredElementId) ? state.hoveredElementId : null,
    chosenElementId: chosen === undefined ? null : regionElementId(chosen.boundary),
    color: DEFAULT_FACE_COLOR,
  };
}
