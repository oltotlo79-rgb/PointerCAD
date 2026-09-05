import type {
  BRepOffset_Mode,
  GeomAbs_JoinType,
  OpenCascadeInstance,
  TopTools_ListOfShape,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { SubShapeQuery } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { matchFace } from './matchSubShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, faceAt } from './subShapes.js';

/**
 * くり抜き(シェル、FR-418。計画書 P5 §2.12・§0.a-0.47、タスク53)。
 *
 * 立体の中身を抜いて、指定した厚さの壁だけを残す。開ける面(開口面)を選べば
 * そこに口が空き、1 枚も選ばなければ**外から見た形は変わらず中だけが空になる**。
 *
 * **作り方(2 通り):**
 *   ① 開口面あり: `BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin` に開口面の一覧
 *      (`ClosingFaces`)を渡すと、その面を取り除いた壁つきの立体がそのまま返る。
 *   ② 開口面なし: 壁を作る API が無いので、`BRepOffsetAPI_MakeOffsetShape.PerformByJoin` で
 *      「厚みぶん内側(または外側)へずらした立体」を作り、元の立体との差
 *      (`booleanOp` の `subtract`)を取って壁にする。
 *
 * **2026-09-05 に Node で実測したこと:**
 *   - `MakeThickSolidBySimple(box, ±2)` は 20³ の箱で `IsDone()` が**偽**になり、
 *     何も作れなかった(計画書 §1.5-4 の確認点。**この API は使えない**)。
 *   - `MakeThickSolidByJoin(box20, 空の一覧, -2, …)` は `IsDone()` が真だが、返るのは
 *     体積 4096(= 16³)の**中身の詰まった小さい箱**で、壁(3904 = 8000 − 4096)にはならない。
 *     さらに**外向き(+2)では体積が −13587.49 と負になり、向きが裏返った立体が返った**。
 *     裏返った立体はブーリアンに掛けると何も残らないので、②では使わない。
 *   - `PerformByJoin(box20, ±2, …)` は内向き 4096・外向き +13587.492558290382 の
 *     どちらも向きの正しい立体を返した。②はこちらを使う。
 *   - `MakeThickSolidByJoin(box20, [上面], -2, …)` は体積 3391.9999999999986、面 11 枚
 *     (外 5 + 内 5 + 口の縁 1)の壁つき立体になった(計画書の期待値 3392 と一致)。
 *   - 厚さ 12(20³ の箱)は `IsDone()` が偽になった。例外は飛ばない。
 */

/** これ未満の体積(mm³)は「立体が残らなかった」とみなす(booleanOp.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/**
 * `MakeThickSolidByJoin` の `Tol`(mm)。OCCT の `Precision::Confusion()` と同じ値で、
 * 面どうしが同じ位置にあるとみなす距離。2026-09-05 の実測はこの値で行った。
 */
const OFFSET_TOLERANCE_MM = 1e-7;

/** 肉厚が 0 以下・非数のとき(計画書 タスク53 の検証表の文言)。 */
const THICKNESS_MESSAGE = '肉厚は 0 より大きい数にしてください。';

/** 肉厚が形に対して大きすぎるとき(同上)。 */
const TOO_THICK_MESSAGE = '肉厚が大きすぎます。小さくしてください。';

/** くり抜くもとの立体が空だったとき。 */
const EMPTY_TARGET_MESSAGE = 'くり抜くもとの立体がありません。';

/** 指紋から開ける面を選び直せなかったとき(makeDraft.ts と同じ言い回し)。 */
const MISSING_FACE_MESSAGE =
  '開ける面が見つかりません。形が大きく変わったため、選び直してください。';

/** くり抜いた結果が立体になっていないとき。 */
const NOT_SOLID_MESSAGE = 'くり抜いた結果が立体になりませんでした。肉厚を小さくしてください。';

/** 述語ガードが偽になったとき(下の isOffsetMode / isJoinType の注釈を参照)。 */
const KERNEL_NOT_READY_MESSAGE =
  '幾何カーネルの準備ができていません。アプリを再読み込みしてください。';

/**
 * 列挙(`BRepOffset_Mode`)を引数に取る API のための述語ガード。
 *
 * `MakeThickSolidByJoin` は引数 10 個のうち 2 個が列挙で、**列挙を避ける別版が存在しない**
 * (2026-09-04 に opencascade.full.d.ts の 11066 行で確認。`MakeThickSolidBySimple` は
 * 列挙を取らないが、上の実測のとおり `IsDone()` が偽で使えない)。
 * 型定義では列挙の各値が**空の型 `{}`** になっており、引数の型
 * (`{ BRepOffset_Skin: {}; BRepOffset_Pipe: {}; BRepOffset_RectoVerso: {} }`)に合わないため、
 * そのままでは型検査を通らない(makeFillet.ts の `ChFi3d_FilletShape`、
 * makeOffsetWire.ts の `GeomAbs_JoinType` と同じ壁)。
 *
 * **これは統括が計画書 §0.a-0.47 と §4 で承認した、P5 で新しく作る唯一の述語ガードの置き場**
 * である(P3 の `makeFillet.ts`、P4 の `makeOffsetWire.ts`、P5 タスク37 の `makeSweep.ts` に
 * 続く 4 か所目。着手時に Grep で数えた既存は 3 か所)。`as` / `any` / `@ts-ignore` /
 * `eslint-disable` は 1 つも使っていない。
 *
 * **この判定が確かめられること:** 「値が null でないオブジェクトであること」だけ。
 * **確かめられないこと(限界):** それが本当に `BRepOffset_Mode` の列挙値かどうか。
 * embind が作る列挙値は中身の見えない空のオブジェクトなので、形を見て見分ける手立てが無い。
 * したがってこのガードは「OCCT の読み込みが済んでいない/壊れている」ことだけを捕まえる網である。
 *
 * **他の箇所へ広げない。** 別の API で同じ壁に当たったら、写す前に統括へ諮る。
 */
function isOffsetMode(value: unknown): value is BRepOffset_Mode {
  return typeof value === 'object' && value !== null;
}

/**
 * 列挙(`GeomAbs_JoinType`)を引数に取る API のための述語ガード。
 * 理由・限界・承認の範囲は上の `isOffsetMode` と同じ(§0.a-0.47 が
 * この 2 つを `makeShell.ts` の 1 か所へ置くことを承認している)。
 *
 * `makeOffsetWire.ts` にも同じ名前のガードがあるが、あちらは輸出していない
 * (P4 の承認範囲に閉じた作りのまま触らない、という統括の指示)。
 */
function isJoinType(value: unknown): value is GeomAbs_JoinType {
  return typeof value === 'object' && value !== null;
}

/** くり抜き 1 段の依頼(計画書 §2.12)。 */
export interface ShellInput {
  /**
   * 開ける面の指紋。**0 枚でもよい**(そのときは外から見た形が変わらない、
   * 中だけが空の立体になる)。同じ面を 2 度指しても 1 度だけ数える。
   */
  readonly openFaces: readonly SubShapeQuery[];
  /** 壁の厚さ(mm)。0 より大きいこと。 */
  readonly thickness: number;
  /**
   * true で外向きに肉を付ける(元の形が空洞になり、まわりに壁ができる)。
   * false(既定の使い方)で内向き。元の形の外側の大きさは変わらない。
   */
  readonly outward: boolean;
}

/**
 * 指紋の一覧から、開ける面の通し番号を決める。重複は取り除き、番号の昇順で返す。
 *
 * **1 つでも選び直せない指紋があれば断る**(`makeFillet.ts` の `resolveFilletEdges`・
 * `makeDraft.ts` の `resolveTargetFaces` と同じ判断)。「3 枚のうち 2 枚だけ開いた形」は
 * 利用者が意図していない別の形だからである。並びを昇順に固定するのは、
 * 同じ入力から必ず同じ順で `Append_1` して同じ形が出るようにするため(決定性)。
 */
function resolveOpenFaces(
  tables: SubShapeTables,
  queries: readonly SubShapeQuery[],
  scale: number,
): readonly number[] {
  const found = new Set<number>();
  for (const query of queries) {
    if (query.kind !== 'face') {
      // 面以外の指紋が来るのは model 側の取り違えだが、利用者への直し方は同じ。
      throw new Error(MISSING_FACE_MESSAGE);
    }
    const match = matchFace(tables.faces, query, scale);
    if (match === null) {
      throw new Error(MISSING_FACE_MESSAGE);
    }
    found.add(match.index);
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * 例外を利用者へ見せる日本語へ揃える。
 *
 * OCCT の C++ 側が投げる例外は、embind を通ると**数値(実体へのポインタ)**として飛んでくる
 * (makeFillet.ts / makeDraft.ts と同じ)。自分で投げた Error はそのまま通す。
 */
function toJapaneseFailure(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message);
}

/**
 * 2 つの API へ同じ形で渡す指定。厚さの符号は「内向きが負」(上の実測)。
 * 列挙の 2 つは述語ガードを通した値だけが入る。
 */
interface OffsetSettings {
  readonly offset: number;
  readonly mode: BRepOffset_Mode;
  readonly join: GeomAbs_JoinType;
}

/**
 * ①開口面を指定して壁つきの立体を作る(`MakeThickSolidByJoin`)。
 *
 * 引数は (対象, 開口面, 厚さ, 許容, 種類, 交差を解く, 自己交差を見る, 角の作り方,
 * 内部の辺を消す, 進捗)。交差と自己交差は OCCT の既定と同じ false にする
 * (true にしても 2026-09-05 の実測では結果が変わらず、重くなるだけだった)。
 */
function buildOpenedShell(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  target: TopoDS_Shape,
  closingFaces: TopTools_ListOfShape,
  settings: OffsetSettings,
): TopoDS_Shape {
  const maker = keep(new oc.BRepOffsetAPI_MakeThickSolid());
  const range = keep(new oc.Message_ProgressRange_1());
  try {
    maker.MakeThickSolidByJoin(
      target,
      closingFaces,
      settings.offset,
      OFFSET_TOLERANCE_MM,
      settings.mode,
      false,
      false,
      settings.join,
      false,
      range,
    );
  } catch (error) {
    throw toJapaneseFailure(error, TOO_THICK_MESSAGE);
  }
  // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ
  // (docs/報告記録.md 2026-09-03 06:56 の⑤。makeFillet.ts と同じ扱い)。
  if (!maker.IsDone()) {
    throw new Error(TOO_THICK_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * ②厚みぶんずらしただけの立体を作る(`PerformByJoin`)。開口面を取らない版。
 *
 * 引数は開口面が無いだけで①と同じ並び。**外向きでも向きの正しい立体が返る**ところが
 * `MakeThickSolidByJoin` に空の一覧を渡した場合との違い(上の実測)。
 */
function buildOffsetSolid(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  target: TopoDS_Shape,
  settings: OffsetSettings,
): TopoDS_Shape {
  const maker = keep(new oc.BRepOffsetAPI_MakeOffsetShape());
  const range = keep(new oc.Message_ProgressRange_1());
  try {
    maker.PerformByJoin(
      target,
      settings.offset,
      OFFSET_TOLERANCE_MM,
      settings.mode,
      false,
      false,
      settings.join,
      false,
      range,
    );
  } catch (error) {
    throw toJapaneseFailure(error, TOO_THICK_MESSAGE);
  }
  if (!maker.IsDone()) {
    throw new Error(TOO_THICK_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * くり抜き(FR-418)。**対象は消費せず、新しい形を返す。**
 *
 * 引数の `target` は解放しない(形はキャッシュの持ち物。booleanOp.ts と同じ約束)。
 * 断ったときも触れない。失敗は必ず日本語の理由を持つ `Error` で返し、
 * アプリを落とさない(NFR-RE-1、FR-504)。
 *
 * **失敗の扱いは 3 段構え**(計画書 タスク53 の手順5)。
 *   ① 事前検査: 肉厚が 0 以下、対象が空、肉厚が形の大きさに見合わない、の 3 つをここで断る。
 *   ② 結果の検証: `IsDone()` に加えて、立体が残ったか・体積が出たか・B-rep として妥当かを見る。
 *   ③ Worker の再起動: 段の失敗を受け止める仕組みは既存(`worker/recomputeSolids.ts`)。
 */
export function makeShell(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: ShellInput,
): OcctShapeHandle {
  if (!Number.isFinite(input.thickness) || input.thickness <= 0) {
    throw new Error(THICKNESS_MESSAGE);
  }

  const diagonal = boundingDiagonal(oc, target);
  if (!(diagonal > 0)) {
    throw new Error(EMPTY_TARGET_MESSAGE);
  }
  // 壁を左右に 1 枚ずつ立てるだけの幅も無い肉厚は、OCCT を呼ぶまでもなく作れない。
  // 境界箱の対角長は形の差し渡しの上限なので、ここで断っても正しい入力を弾くことはない。
  if (input.thickness * 2 >= diagonal) {
    throw new Error(TOO_THICK_MESSAGE);
  }

  // 位置の点を正規化する長さ。境界箱の対角長の半分(matchSubShape.ts の scorePosition)。
  const scale = diagonal * 0.5;
  const faceIndices = resolveOpenFaces(tables, input.openFaces, scale);

  // 列挙値は unknown を経由してから述語ガードで絞る(§0.a-0.47。isOffsetMode の注釈)。
  const mode: unknown = oc.BRepOffset_Mode.BRepOffset_Skin;
  const join: unknown = oc.GeomAbs_JoinType.GeomAbs_Arc;
  if (!isOffsetMode(mode) || !isJoinType(join)) {
    throw new Error(KERNEL_NOT_READY_MESSAGE);
  }

  const { keep, release } = createAllocations();

  try {
    const closingFaces = keep(new oc.TopTools_ListOfShape_1());
    for (const index of faceIndices) {
      const face = faceAt(oc, target, index);
      if (face === null) {
        // 一覧の番号が形と食い違っている(別の形から作った一覧を渡された)合図。
        throw new Error(MISSING_FACE_MESSAGE);
      }
      try {
        // Append_1 は面を一覧の中へ写し取るので、その場で返してよい(makeFillet.ts の
        // Add_2 と同じ。戻り値は一覧の中の実体への参照なので、こちらでは解放しない)。
        closingFaces.Append_1(face);
      } finally {
        face.delete();
      }
    }

    const offset = input.outward ? input.thickness : -input.thickness;
    const settings: OffsetSettings = { offset, mode, join };

    // 開口面が 1 枚でもあれば①、無ければ②。②で得られるのは「ずらしただけの立体」なので、
    // 元の立体との差を取って壁にする(内向きは 元 − ずらした形、外向きはその逆)。
    const shape = ((): TopoDS_Shape => {
      if (faceIndices.length > 0) {
        return buildOpenedShell(oc, keep, target, closingFaces, settings);
      }
      const shifted = buildOffsetSolid(oc, keep, target, settings);
      const hollow = keep(
        input.outward
          ? booleanOp(oc, 'subtract', shifted, target)
          : booleanOp(oc, 'subtract', target, shifted),
      );
      return hollow.shape;
    })();

    if (!hasSolid(oc, shape) || Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME_MM3) {
      throw new Error(NOT_SOLID_MESSAGE);
    }
    if (!isValidShape(oc, shape)) {
      throw new Error(NOT_SOLID_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
