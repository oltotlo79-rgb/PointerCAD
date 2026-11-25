/**
 * 面を張らずに押し出す(M-01)。編集中のスケッチの閉じた領域を選び、押し出しの確定で、今の形の面
 * (SketchFaceFeature。自動の名前・既定の色・外周と穴の参照)を押し出しと一緒に作る。
 *
 * - 領域の検出は model の純関数(`findSketchRegions`)。ここは、押した点から領域を選ぶ・断る理由を決める・面を足すだけ。
 * - 穴を持つ面だけ保存形式23を要する。面・押し出し・版の変更は同じUndoに入れる。
 * - 交わる曲線の領域は扱わず、トリムへ案内する(統括の決定 2026-11-16 04:0x の (2) a)。
 */
import {
  appendFeature, DEFAULT_FACE_COLOR, findSketchRegions, isFreeWorkPlaneId, nextFeatureId, nextFeatureName, regionAtPoint, replaceSketch,
  resolvePart, resolveSketch,
  type PartDocument, type ResolvedSketch, type SketchDocument, type SketchElementRef, type SketchFaceFeature, type Vec3, type WorkPlaneId,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/** 領域の検出の結果(model は型の名前を公開していないので、関数の戻り値から引く。公開の口を増やさない)。 */
export type SketchRegionScan = ReturnType<typeof findSketchRegions>;
export type SketchRegion = SketchRegionScan['regions'][number];

/** 解決済みスケッチごとの領域の検出の結果。ホバーのたびに探し直さない(スケッチは書き換えずに作り直すので、同じ物なら同じ答え)。 */
const scans = new WeakMap<ResolvedSketch, { readonly sketch: SketchDocument; readonly scan: SketchRegionScan }>();

/** 領域の検出(model の `findSketchRegions`)を、同じスケッチなら覚えた結果で返す。 */
export function sketchRegionScan(sketch: SketchDocument, resolved: ResolvedSketch): SketchRegionScan {
  const known = scans.get(resolved);
  if (known !== undefined && known.sketch === sketch) return known.scan;
  const scan = findSketchRegions(sketch, resolved);
  scans.set(resolved, { sketch, scan });
  return scan;
}

/** 押し出しの欄が持つ、選んだ領域(保存はしない。確定の時に面を作る材料)。 */
export interface ExtrudeRegionChoice {
  readonly sketchId: string;
  readonly planeId: WorkPlaneId;
  readonly boundary: readonly SketchElementRef[];
  readonly holes?: readonly (readonly SketchElementRef[])[];
}

export type ExtrudeRegionPick =
  | { readonly ok: true; readonly region: ExtrudeRegionChoice }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 押した点(作図面の上の世界座標)の領域を選ぶ。選べない時は、次にする操作が分かる理由を返す。 */
export function pickExtrudeRegion(sketch: SketchDocument, resolved: ResolvedSketch, point: Vec3): ExtrudeRegionPick {
  const scan = sketchRegionScan(sketch, resolved);
  const region = regionAtPoint(scan, point);
  if (region === null) {
    return { ok: false, reasonKey: scan.crossingFeatureIds.size > 0 ? 'solidError.regionCrossing' : 'solidError.regionNone' };
  }
  const first = sketch.features.find(feature => feature.id === region.boundary[0].featureId);
  if (first === undefined) return { ok: false, reasonKey: 'solidError.regionNone' };
  return { ok: true, region: { sketchId: sketch.id, planeId: first.planeId, boundary: region.boundary,
    ...(region.holes.length === 0 ? {} : { holes: region.holes }) } };
}

function sameBoundary(first: readonly SketchElementRef[], second: readonly SketchElementRef[]): boolean {
  return first.length === second.length
    && first.every((ref, index) => ref.featureId === second[index].featureId && ref.index === second[index].index);
}

/**
 * 押して選べる領域: 3D スケッチの要素でなく、同じ外周と穴でまだ面が張られていない領域。
 * 面が張ってある領域は面そのものを押して選べるので、塗りと「領域を押して選ぶ」案内の対象から外す(二重に塗らない)。
 */
export function pickableSketchRegions(sketch: SketchDocument, scan: SketchRegionScan): readonly SketchRegion[] {
  const faces = sketch.features.filter(feature => feature.kind === 'face');
  return scan.regions.filter(region => !faces.some(face => sameBoundary(face.boundary, region.boundary)
      && (face.holes?.length ?? 0) === region.holes.length
      && region.holes.every(hole => face.holes?.some(existing => sameBoundary(existing, hole))))
    && sketch.features.some(feature => feature.id === region.boundary[0].featureId && !isFreeWorkPlaneId(feature.planeId)));
}

/** スケッチごとの「押して選べる領域があるか」。スケッチは書き換えずに作り直すので、同じ物なら答えも同じ。 */
const regionPresence = new WeakMap<SketchDocument, boolean>();

/**
 * 編集中のスケッチに、押して選べる閉じた領域が 1 つ以上あるか(押し出しの道具が、面を選んでいなくても開けるか)。
 * 道具の可否は描くたびに聞かれるので、スケッチごとに覚える。
 */
export function activeSketchHasRegions(document: PartDocument): boolean {
  const sketch = document.sketches.find(candidate => candidate.id === document.activeSketchId);
  if (sketch === undefined) return false;
  const known = regionPresence.get(sketch);
  if (known !== undefined) return known;
  const present = pickableSketchRegions(sketch, sketchRegionScan(sketch, resolveSketch(sketch))).length > 0;
  regionPresence.set(sketch, present);
  return present;
}

/** 選んだ外周・穴が、今のスケッチでも同じ領域を表すときだけ、その幾何を返す。 */
export function selectedExtrudeRegion(
  sketch: SketchDocument, resolved: ResolvedSketch, choice: ExtrudeRegionChoice,
): SketchRegion | undefined {
  if (choice.sketchId !== sketch.id
    || sketch.features.find(feature => feature.id === choice.boundary[0]?.featureId)?.planeId !== choice.planeId) {
    return undefined;
  }
  const holes = choice.holes ?? [];
  return pickableSketchRegions(sketch, sketchRegionScan(sketch, resolved)).find(region =>
    sameBoundary(region.boundary, choice.boundary) && region.holes.length === holes.length
    && holes.every(hole => region.holes.some(candidate => sameBoundary(candidate, hole))));
}

/** 選んだ領域から面を 1 つ足した文書と、その面の要素 id。境界の要素が消えていたら断る。 */
export function appendRegionFace(document: PartDocument, region: ExtrudeRegionChoice):
  { readonly ok: true; readonly document: PartDocument; readonly faceElementId: string } | { readonly ok: false; readonly reasonKey: MessageKey } {
  const sketch = document.sketches.find(candidate => candidate.id === region.sketchId);
  const boundaries = [region.boundary, ...(region.holes ?? [])];
  if (sketch === undefined || !boundaries.every(loop => loop.every(ref => sketch.features.some(feature => feature.id === ref.featureId)))) {
    return { ok: false, reasonKey: 'solidError.regionStale' };
  }
  const id = nextFeatureId(sketch, 'face');
  const face: SketchFaceFeature = {
    id, name: nextFeatureName(sketch, 'face'), planeId: region.planeId, kind: 'face', boundary: region.boundary, color: DEFAULT_FACE_COLOR,
    ...((region.holes?.length ?? 0) === 0 ? {} : { holes: region.holes }),
  };
  const next = replaceSketch(document, appendFeature(sketch, face));
  if ((face.holes?.length ?? 0) === 0) return { ok: true, document: next, faceElementId: id };
  // 部品の作図面・パラメーターと同じ条件で、穴の閉鎖・平面・接触・包含を検査する。
  const resolved = resolvePart(next).sketches.find(entry => entry.sketchId === sketch.id)?.resolved;
  if (!resolved?.faces.some(candidate => candidate.featureId === id)) return { ok: false, reasonKey: 'solidError.regionInvalid' };
  return { ok: true, document: { ...next, schemaVersion: Math.max(next.schemaVersion, 23) }, faceElementId: id };
}
