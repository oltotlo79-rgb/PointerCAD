import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Shell,
} from 'opencascade.js/dist/opencascade.full.js';

import type { SewStepSpec, TessellationOptions } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import { validateToleranceMm } from './tolerances.js';

/**
 * 縫合に要る面の最小の枚数。
 * 1 枚だけ渡すと縫合の結果は殻にならず面のまま返るので、先に断る
 * (2026-09-03 に Node 上で実測。SewedShape().ShapeType() が TopAbs_FACE になる)。
 */
const MINIMUM_PROFILE_COUNT = 2;

/** これ未満の体積は「立体になっていない」とみなす(mm³)。 */
const MINIMUM_VOLUME = 1e-9;

/** Worker 内の面入力。所有は呼出側に残し、面・辺・下地の幾何を変更しない。 */
export interface SewFacesInput {
  readonly faces: readonly { readonly ownership: 'borrowed'; readonly face: TopoDS_Face }[];
  readonly tolerance: number;
}

const SEW_FACES_MESSAGES = {
  'insufficient-faces': '立体にするには面が 2 枚以上必要です。',
  'invalid-tolerance': 'つなぎ目の許容量は 0 より大きい有限の数にしてください。',
  'invalid-face': '縫い合わせる面が正しくありません。面を選び直してください。',
  'duplicate-face': '同じ面が重複しています。面を選び直してください。',
  'open-shell': '面のつながりに隙間があるため、立体にできませんでした。',
  'non-manifold': '面のつなぎ目に 3 枚以上の面が重なっています。',
  'multiple-shells': '面が 2 つ以上の閉じた殻に分かれています。面を選び直してください。',
  'invalid-solid': '面が閉じた 1 つの立体になっていません。面を選び直してください。',
  'sewing-failed': '面を縫い合わせられませんでした。面と許容量を見直してください。',
  'missing-face': '縫い合わせる面が見つかりません。面を選び直してください。',
} as const;

export type SewFacesReason = keyof typeof SEW_FACES_MESSAGES;

/** 理由コードと日本語の説明。拒否時には結果の形を返さない。 */
export class SewFacesError extends Error {
  constructor(readonly reason: SewFacesReason) {
    super(SEW_FACES_MESSAGES[reason]);
    this.name = 'SewFacesError';
  }
}

interface SewFacesResult extends OcctShapeHandle {
  readonly volume: number;
  readonly freeEdgeCount: 0;
}

/**
 * 借用した曲面を縫い、閉じた 1 solid だけを返す。
 * 円筒側面 1 枚と端面 2 枚を実 OCCT で検証する。一般自由曲面の成立は保証しない。
 * 同じ位相面の再指定は向きに関係なく拒否する(別々に作った同一幾何の検出ではない)。
 * 入力の所有は移さず、各面を Copy_2(..., true, false) で幾何ごと複製してから扱う。
 * Copy.Shape / SewedShape / Shell_1 / Solid / Reversed は所有する wrapper なので keep する。
 * 成功時の全資源の所有は返す handle に移り、拒否・例外時はここで全て解放する。
 */
export function sewSolidFaces(oc: OpenCascadeInstance, input: SewFacesInput): SewFacesResult {
  if (input.faces.length < MINIMUM_PROFILE_COUNT) throw new SewFacesError('insufficient-faces');
  if (!Number.isFinite(input.tolerance) || input.tolerance <= 0) {
    throw new SewFacesError('invalid-tolerance');
  }
  const { keep, release } = createAllocations();
  try {
    const unique = keep(new oc.TopTools_IndexedMapOfShape_1());
    for (const entry of input.faces) {
      if (entry.ownership !== 'borrowed' || entry.face.IsNull()
        || entry.face.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) {
        throw new SewFacesError('invalid-face');
      }
      // IndexedMap は IsSame (TShape + Location、Orientation を無視) で重複を検出する。
      if (unique.Contains(entry.face)) throw new SewFacesError('duplicate-face');
      unique.Add(entry.face);
    }
    const sewing = keep(new oc.BRepBuilderAPI_Sewing(input.tolerance, true, true, true, false));
    for (const { face } of input.faces) {
      const copier = keep(new oc.BRepBuilderAPI_Copy_2(face, true, false));
      const copied = keep(copier.Shape());
      if (copied.IsNull() || !isValidShape(oc, copied)) throw new SewFacesError('invalid-face');
      sewing.Add(copied);
    }
    sewing.Perform(keep(new oc.Message_ProgressRange_1()));
    if (Number(sewing.NbMultipleEdges()) !== 0) throw new SewFacesError('non-manifold');
    if (Number(sewing.NbFreeEdges()) !== 0) throw new SewFacesError('open-shell');
    if (Number(sewing.NbDeletedFaces()) !== 0) throw new SewFacesError('invalid-solid');
    const sewed = keep(sewing.SewedShape());
    if (sewed.IsNull()) throw new SewFacesError('invalid-solid');
    const shells = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(sewed, oc.TopAbs.ShapeTypeFromString_1('SHELL'), shells);
    if (shells.Size() > 1) throw new SewFacesError('multiple-shells');
    // 入れ物の中から一部だけを取り出すことはしない。全入力が 1 殻になる必要がある。
    if (shells.Size() !== 1 || sewed.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
      throw new SewFacesError('invalid-solid');
    }
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(sewed, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
    if (faces.Size() !== input.faces.length) throw new SewFacesError('invalid-solid');
    const shell = keep(oc.TopoDS.Shell_1(sewed));
    const maker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell));
    if (!maker.IsDone()) throw new SewFacesError('invalid-solid');
    const solid = keep(maker.Solid());
    const rawVolume = measureVolume(oc, solid);
    const shape = rawVolume < 0 ? keep(solid.Reversed()) : solid;
    const volume = rawVolume < 0 ? measureVolume(oc, shape) : rawVolume;
    if (!Number.isFinite(volume) || volume < MINIMUM_VOLUME
      || countSolidShapes(oc, shape, 2) !== 1 || !isValidShape(oc, shape)) {
      throw new SewFacesError('invalid-solid');
    }
    return { shape, volume, freeEdgeCount: 0, delete: release };
  } catch (error) {
    release();
    // 数値として届く WASM 例外も理由付きで返す。JS の例外は原因の情報を保つ。
    if (error instanceof Error) throw error;
    throw new SewFacesError('sewing-failed');
  }
}

/**
 * 縫合した形の中にある殻を全て取り出す。
 *
 * 2026-09-03 に Node 上で実測した SewedShape() の種類:
 *   箱の 6 面(閉じる)  → TopAbs_SHELL、自由辺 0
 *   箱の 5 面(開く)    → TopAbs_SHELL、自由辺 4
 *   面 1 枚だけ          → TopAbs_FACE、自由辺 4
 *   離れた 2 枚          → TopAbs_COMPOUND、自由辺 8(殻は 1 つも入っていない)
 * 殻がそのまま返る場合と入れ物(COMPOUND)で返る場合があるので、両方を扱う。
 *
 * 部分形状の取り出しに TopExp_Explorer を使わないのは、opencascade.js の型定義で
 * 列挙の各値(TopAbs_SHELL 等)が空の型 `{}` になっており、列挙を引数に取る Init は
 * 強制変換なしでは型検査を通らないため(tessellate.ts・solidMesh.ts と同じ理由)。
 */
function findShells(oc: OpenCascadeInstance, shape: TopoDS_Shape, keep: Allocations['keep']): readonly TopoDS_Shell[] {
  const shellType = oc.TopAbs_ShapeEnum.TopAbs_SHELL;
  if (shape.ShapeType() === shellType) return [keep(oc.TopoDS.Shell_1(shape))];

  const mapOwner = createAllocations();
  try {
    const subShapes = mapOwner.keep(new oc.TopTools_IndexedMapOfShape_1());
    const shells: TopoDS_Shell[] = [];
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const subShapeCount = Number(subShapes.Size());
    for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
      const keyOwner = createAllocations();
      try {
        const subShape = keyOwner.keep(subShapes.FindKey(subShapeIndex));
        if (subShape.ShapeType() === shellType) shells.push(keep(oc.TopoDS.Shell_1(subShape)));
      } finally { keyOwner.release(); }
    }
    return shells;
  } finally { mapOwner.release(); }
}

/**
 * 面を縫い合わせて閉じた殻にし、立体へ変える(FR-403)。
 * 縫合 → 殻の取り出し → MakeSolid_3 → 向きの直し → 閉じているかの確認 の順。
 *
 * 断るときは利用者へそのまま見せられる日本語の Error を投げ、呼び出し側が理由として拾う
 * (FR-504。止めずに理由を出す)。閉じない・つながらない場合の文言は断りの表に従う。
 *
 * **向きの直し.** BRepBuilderAPI_Sewing は面の向きを揃えるが、揃える先が内側になることがある。
 * 2026-09-03 に Node 上で実測したところ、10 × 20 × 30 の箱の 6 面を縫って作った立体の体積は
 * -6000 mm³ になり(面の並びを逆にしても -6000)、裏返しの立体になっていた。
 * 裏返しのままではブーリアンや表示の表裏が狂うため、体積が負なら Reversed() で向きを反転する。
 * 反転後は体積 +6000、BRepCheck_Analyzer も妥当と答える(実測)。
 * 向きの判定に BRepClass3d_SolidClassifier を使わないのは、体積が閉じの確認にどのみち要り、
 * 判定を 1 つの値で済ませられるため。
 */
export function sewSolid(
  oc: OpenCascadeInstance,
  spec: SewStepSpec,
  options: TessellationOptions = {},
): OcctShapeHandle {
  if (spec.profiles.length < MINIMUM_PROFILE_COUNT) {
    throw new Error('立体にするには面が 2 枚以上必要です。');
  }
  const tolerance = validateToleranceMm(spec.tolerance);

  const { keep, release } = createAllocations();
  try {
    const faces = spec.profiles.map(profile => keep(makePlanarFace(oc, profile, options)));
    const sewing = keep(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
    for (const handle of faces) sewing.Add(handle.face);
    const progressOwner = createAllocations();
    try { sewing.Perform(progressOwner.keep(new oc.Message_ProgressRange_1())); }
    finally { progressOwner.release(); }

    const freeEdgeCount = Number(sewing.NbFreeEdges());
    if (freeEdgeCount !== 0) throw new Error(`面のつながりに隙間があるため、立体にできませんでした。隙間は ${freeEdgeCount} 本です。`);
    const sewed = keep(sewing.SewedShape());
    const shells = findShells(oc, sewed, keep);
    if (shells.length === 0) throw new Error('面をつなげませんでした。面が重なっていないか確かめてください。');
    if (shells.length > 1) throw new Error('面が 2 つ以上の閉じた殻に分かれています。面を選び直してください。');
    const solidMaker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shells[0]));
    if (!solidMaker.IsDone()) throw new Error('つないだ面から立体を作れませんでした。');
    const solid = keep(solidMaker.Solid());
    const rawVolume = measureVolume(oc, solid);
    const reversed = rawVolume < 0 ? keep(solid.Reversed()) : null;
    const shape = reversed ?? solid;
    const volume = reversed === null ? rawVolume : measureVolume(oc, shape);
    if (!(volume >= MINIMUM_VOLUME) || !hasSolid(oc, shape) || !isValidShape(oc, shape)) {
      throw new Error('面が閉じた立体になっていません。足りない面を足してください。');
    }
    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
