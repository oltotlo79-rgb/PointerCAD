/**
 * 面を張らずに押し出す(M-01)。編集中のスケッチの閉じた領域を選び、押し出しの確定で、今の形の面
 * (SketchFaceFeature。自動の名前・既定の色・境界の参照)を押し出しと一緒に作る。保存の形は変えない。
 *
 * - 領域の検出は model の純関数(`findSketchRegions`)。ここは、押した点から領域を選ぶ・断る理由を決める・面を足すだけ。
 * - 穴の候補のある領域は、穴つきの面(M01-5、保存の形の変更)までは理由を出して断る(黙って穴を埋めない)。
 * - 交わる曲線の領域は扱わず、トリムへ案内する(統括の決定 2026-11-16 04:0x の (2) a)。
 */
import {
  appendFeature, DEFAULT_FACE_COLOR, findSketchRegions, nextFeatureId, nextFeatureName, regionAtPoint, replaceSketch, resolveSketch,
  type PartDocument, type ResolvedSketch, type SketchDocument, type SketchElementRef, type SketchFaceFeature, type Vec3, type WorkPlaneId,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/** 押し出しの欄が持つ、選んだ領域(保存はしない。確定の時に面を作る材料)。 */
export interface ExtrudeRegionChoice {
  readonly sketchId: string;
  readonly planeId: WorkPlaneId;
  readonly boundary: readonly SketchElementRef[];
}

export type ExtrudeRegionPick =
  | { readonly ok: true; readonly region: ExtrudeRegionChoice }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 押した点(作図面の上の世界座標)の領域を選ぶ。選べない時は、次にする操作が分かる理由を返す。 */
export function pickExtrudeRegion(sketch: SketchDocument, resolved: ResolvedSketch, point: Vec3): ExtrudeRegionPick {
  const scan = findSketchRegions(sketch, resolved);
  const region = regionAtPoint(scan, point);
  if (region === null) {
    return { ok: false, reasonKey: scan.crossingFeatureIds.size > 0 ? 'solidError.regionCrossing' : 'solidError.regionNone' };
  }
  if (region.holes.length > 0) return { ok: false, reasonKey: 'solidError.regionHasHoles' };
  const first = sketch.features.find(feature => feature.id === region.boundary[0].featureId);
  if (first === undefined) return { ok: false, reasonKey: 'solidError.regionNone' };
  return { ok: true, region: { sketchId: sketch.id, planeId: first.planeId, boundary: region.boundary } };
}

/** スケッチごとの「閉じた領域があるか」。スケッチは書き換えずに作り直すので、同じ物なら答えも同じ。 */
const regionPresence = new WeakMap<SketchDocument, boolean>();

/**
 * 編集中のスケッチに、押し出せる閉じた領域が 1 つ以上あるか(押し出しの道具が、面を選んでいなくても開けるか)。
 * 道具の可否は描くたびに聞かれるので、スケッチごとに覚える。
 */
export function activeSketchHasRegions(document: PartDocument): boolean {
  const sketch = document.sketches.find(candidate => candidate.id === document.activeSketchId);
  if (sketch === undefined) return false;
  const known = regionPresence.get(sketch);
  if (known !== undefined) return known;
  const present = findSketchRegions(sketch, resolveSketch(sketch)).regions.some(region => region.holes.length === 0);
  regionPresence.set(sketch, present);
  return present;
}

/** 選んだ領域から面を 1 つ足した文書と、その面の要素 id。境界の要素が消えていたら断る。 */
export function appendRegionFace(document: PartDocument, region: ExtrudeRegionChoice):
  { readonly ok: true; readonly document: PartDocument; readonly faceElementId: string } | { readonly ok: false; readonly reasonKey: MessageKey } {
  const sketch = document.sketches.find(candidate => candidate.id === region.sketchId);
  if (sketch === undefined || !region.boundary.every(ref => sketch.features.some(feature => feature.id === ref.featureId))) {
    return { ok: false, reasonKey: 'solidError.regionStale' };
  }
  const id = nextFeatureId(sketch, 'face');
  const face: SketchFaceFeature = {
    id, name: nextFeatureName(sketch, 'face'), planeId: region.planeId, kind: 'face', boundary: region.boundary, color: DEFAULT_FACE_COLOR,
  };
  return { ok: true, document: replaceSketch(document, appendFeature(sketch, face)), faceElementId: id };
}
