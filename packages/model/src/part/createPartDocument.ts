/**
 * 部品(パート)文書の生成と履歴操作(計画書 docs/plans/P2-ソリッド基礎.md タスク9b、
 * docs/plans/P3-加工フィーチャー.md タスク13)。
 *
 * 履歴を書き換えず、変更のたびに新しい配列を作る。Undo / Redo(FR-505)はこの不変性の上に乗る。
 * 参照は id で持ち、座標や形を複製しない(FR-311、FR-502)。
 * ここに置くのは文書そのものの操作だけで、解決(座標・向き・キャッシュの鍵の計算)は
 * part/resolvePart.ts の担当にする。
 */

import { type ExpressionValue, expressionValueFromNumber } from '@pointercad/expression';

import { emptyAppearanceTable } from '../appearance/appearanceTable.js';
import type { AxisSpec } from '../geometry/planeSpec.js';
import {
  createEmptySketchDocument,
  nextSerialId,
  nextSerialName,
} from '../sketch/createSketchDocument.js';
import type { BaseWorkPlaneId } from '../sketch/planeMath.js';
import type { SketchDocument } from '../sketch/types.js';
import type {
  BooleanOperation,
  CutFeature,
  ExtrudeEnd,
  ExtrudeFeature,
  FilletFeature,
  HoleEntry,
  HoleFeature,
  PartDocument,
  PrimitiveFeature,
  PrimitiveShape,
  PrimitiveShapeKind,
  ReferenceFeature,
  ReferenceFeatureKind,
  RibSide,
  RuledSphereSegments,
  SolidFeature,
  SolidFeatureKind,
  SolidOrigin,
  ThicknessSide,
  ThreadHoleFeature,
} from './types.js';

/**
 * 部品文書の保存形式の版(§0.a-0.3)。P3 で 3 になり(P3 計画書 §0.a-0.22、タスク19)、
 * P4 タスク31(§0.a-0.24)で 4 になり、P4b タスク21(§0.a-0.17、案 A)で 5 になった。
 *
 * P4 が足したのは新しいスケッチの種類(矩形・正多角形・長穴・楕円・スプライン・オフセット・
 * 複製・投影/交差)と基準ジオメトリ・任意平面・3D スケッチ・構築線フラグで、版 3 まで
 * 一部のファイルで省略できていた欄(`construction`・点列の `layout`・`references`)を
 * 版 4 からは必須にした。P4b が足したのはパラメータ表(`parameters`、FR-207)とスケッチの
 * 拘束(`SketchDocument.constraints`、FR-313)で、`parameters` は版 5 から必須の欄にする
 * (拘束は型自体が恒常的に省略可能なままなので、版を理由に必須化はしない。
 * `packages/io/src/pcad/documentJson.ts` の `readSketch` を参照)。
 * この値は io 側の `PCAD_SCHEMA_VERSION`
 * (`packages/io/src/pcad/schema.ts`)と必ず同じにする(`documentJson.test.ts` が検査する)。
 * 版 4 以前のファイルは `SCHEMA_MIGRATIONS[4]` が `parameters` の省略を明示的に補って読み込む。
 *
 * P5 タスク2 で足した外観の割り当て(`PartDocument.appearance`、FR-1106〜1110)は、
 * P5 タスク5(§0.a-0.15、P4b が版 5 を使ったための読み替えで版 6)で `packages/io` が
 * 読み書きと移行(`SCHEMA_MIGRATIONS[5]`)を実装したので版 6 から必須の欄にした。
 * 版 5 以前のファイルは `SCHEMA_MIGRATIONS[5]` が `appearance` の省略を空の表で補って読み込む。
 *
 * P6 タスク20 で足した読み込んだ形のベースボディ 2 種(`importedSolid` / `importedMesh`、
 * FR-802)と、P6 タスク21 が `.pcad` の ZIP へ足した添付のエントリ
 * (`shapes/*.brep` / `meshes/*.bin` / `canvases/*.png`)で版 7 になった(§0.a-0.55)。
 * **版は 1 回しか上げない**ので、まだ欄になっていない選択セット(`selectionSets`、FR-112)と
 * 下絵(`canvases`、FR-332)も版 7 に含め、版 6 以前のファイルは
 * `SCHEMA_MIGRATIONS[6]` がこの 2 欄の省略を空配列で補って読み込む。
 */
export const PART_SCHEMA_VERSION = 8;

/** 縫合のつなぎ目の既定の許容量(mm、§0.a-0.7)。 */
export const DEFAULT_SEW_TOLERANCE_MM = 0.01;

/** 穴の直径の既定(mm、P3 §タスク13)。 */
export const DEFAULT_HOLE_DIAMETER_MM = 6;

/** 止まり穴の深さの既定(mm)。 */
export const DEFAULT_HOLE_DEPTH_MM = 10;

/** R 面取りの半径の既定(mm)。 */
export const DEFAULT_FILLET_RADIUS_MM = 2;

/** C 面取りの距離の既定(mm)。 */
export const DEFAULT_CHAMFER_DISTANCE_MM = 1;

/** C 面取りの角度の既定(度)。 */
export const DEFAULT_CHAMFER_ANGLE_DEGREES = 45;

/** 直線パターンの間隔の既定(mm、§0.a-0.21)。 */
export const DEFAULT_PATTERN_SPACING_MM = 20;

/** 直線パターンの個数の既定(§0.a-0.21)。 */
export const DEFAULT_PATTERN_COUNT = 3;

/** 円形パターンの個数の既定(§0.a-0.21)。 */
export const DEFAULT_CIRCULAR_PATTERN_COUNT = 4;

/** パターンの個数の上限(P3 §2.7)。これを超える指定は解決のときに断る。 */
export const MAX_PATTERN_COUNT = 100;

/** ばねのコイル中心径の既定(mm、FR-414、§0.a-0.30)。 */
export const DEFAULT_SPRING_COIL_DIAMETER_MM = 20;

/** ばねの線径の既定(mm)。 */
export const DEFAULT_SPRING_WIRE_DIAMETER_MM = 2;

/** ばねのピッチの既定(mm)。 */
export const DEFAULT_SPRING_PITCH_MM = 5;

/** ばねの巻数の既定。既定の全長は ピッチ × 巻数 = 20mm になる(§0.a-0.30)。 */
export const DEFAULT_SPRING_TURNS = 4;

/** ばねの巻数の上限(§0.a-0.35)。これを超える指定は解決のときに断る。 */
export const MAX_SPRING_TURNS = 200;

/*
  基本形状5種の既定の寸法(mm。FR-429、P5 計画書 §2.7.1 の表と §0.a-0.16 の決定)。

  何も選ばずに道具を押して決めただけで意味のある形ができる大きさにしてある
  (NFR-UX-4「Enter 連打で意味のある結果」)。利用者は作ったあとに式で直せる(FR-202)。
*/

/** 球の半径の既定(mm)。 */
export const DEFAULT_SPHERE_RADIUS_MM = 10;

/** 箱の一辺の既定(mm)。X / Y / Z とも同じ。 */
export const DEFAULT_BOX_SIZE_MM = 20;

/** 円柱の半径の既定(mm)。 */
export const DEFAULT_CYLINDER_RADIUS_MM = 10;

/** 円柱の高さの既定(mm)。底面の中心から軸の向きへ伸びる(§0.a-0.17)。 */
export const DEFAULT_CYLINDER_HEIGHT_MM = 20;

/** 円錐の下半径の既定(mm)。 */
export const DEFAULT_CONE_BOTTOM_RADIUS_MM = 10;

/** 円錐の上半径の既定(mm)。0 なら尖った円錐、0 より大きければ円錐台(§0.a-0.16)。 */
export const DEFAULT_CONE_TOP_RADIUS_MM = 0;

/** 円錐の高さの既定(mm)。 */
export const DEFAULT_CONE_HEIGHT_MM = 20;

/** トーラスの主半径(中心から管の中心までの半径)の既定(mm)。 */
export const DEFAULT_TORUS_MAJOR_RADIUS_MM = 20;

/** トーラスの管の半径の既定(mm)。主半径より小さくする(同じ以上だと自己交差する)。 */
export const DEFAULT_TORUS_MINOR_RADIUS_MM = 5;

/**
 * 基本形状の向きの既定(§0.a-0.16)。世界の Z 軸。
 *
 * 球・トーラスは向きを変えても形が変わらないが、欄を種類ごとに出し分けないほうが
 * 作りが単純なので5種すべてが同じ欄を持つ(表示の出し分けは UI の仕事)。
 */
export const DEFAULT_PRIMITIVE_AXIS: AxisSpec = { kind: 'world', axis: 'z' };

/**
 * ねじれの補正の既定(§0.a-0.28)。0 なら `ThruSections` に任せたそのままの対応になる。
 * 整数の式で持ち、小数を書かれたら解決のときに断る(切り捨てない)。
 */
export const DEFAULT_RULED_TWIST = 0;

/**
 * 球へつなぐときの近似の点の数の既定(§0.a-0.74)。
 * 24 / 48 / 72 から選べるうちのいちばん軽いもの(タスク24 の実測で 72 点は 5〜6 秒)。
 */
export const DEFAULT_RULED_SPHERE_SEGMENTS: RuledSphereSegments = 24;

/** 段ごとに選べる球の近似の点の数(§0.a-0.74)。UI の選択肢と io の妥当性検査が共有する。 */
export const RULED_SPHERE_SEGMENT_CHOICES: readonly RuledSphereSegments[] = [24, 48, 72];

/*
  P5 の Should 群(FR-401、FR-409、FR-415〜425、FR-428。計画書 §2.11、§2.15、タスク43)の
  既定値と上限。

  既定値は §2.15 の「その場数値入力」の表の「既定」列をそのまま写したもので、表に無いものは
  「何も選ばずに道具を押しただけで意味のある形ができる」大きさにしてある(NFR-UX-4)。
  上限は解決(タスク45・46)が範囲の検査に使い、UI(タスク49)も同じ値を見る
  (同じ数を 2 か所に書かない)。
*/

/**
 * 押し出しの終端の既定(FR-415)。`{ kind: 'distance' }` = P2 からの「長さを指定して片側へ」。
 * この欄が無い古い文書は `symmetric` の真偽から作る(`packages/io`)。
 */
export const DEFAULT_EXTRUDE_END: ExtrudeEnd = { kind: 'distance' };

/** 押し出しのテーパ角の既定(度、FR-401)。0 なら傾けない(P2 からの押し出しと同じ形)。 */
export const DEFAULT_TAPER_ANGLE_DEGREES = 0;

/**
 * 押し出しのテーパ角の上限(度、FR-401)。
 *
 * カーネル(`occt/makeSolidSweep.ts`)は「0 度以上 90 度未満」で受けるが、**抜き勾配と
 * 同じ 60 度で止める**(§0.a-0.72)。89.99999 度のような値が妥当性検査を通ると巨大な形が
 * できてしまうのは押し出しの傾きでも同じで、2 つの道具で上限が違うと利用者が覚えられない
 * (NFR-UX-1)ためである。統括の判断が要る決定なので報告に載せる。
 */
export const MAX_TAPER_ANGLE_DEGREES = 60;

/** 薄板押し出しの厚みの向きの既定(FR-416、§0.a-0.46)。輪郭を壁の外側の境界にする。 */
export const DEFAULT_THICKNESS_SIDE: ThicknessSide = 'inner';

/** 薄板押し出しの厚みの既定(mm、FR-416)。`thickness` に数を入れたときの最初の値。 */
export const DEFAULT_EXTRUDE_THICKNESS_MM = 2;

/** 穴の入口の既定(FR-422、§0.a-0.39)。広げない。欄が無い古い文書もこれになる。 */
export const DEFAULT_HOLE_ENTRY: HoleEntry = { kind: 'plain' };

/** ざぐりの径の既定(mm、FR-422)。穴の径(既定 6mm)より大きくする。 */
export const DEFAULT_COUNTERBORE_DIAMETER_MM = 11;

/** ざぐりの深さの既定(mm、FR-422)。 */
export const DEFAULT_COUNTERBORE_DEPTH_MM = 4;

/** 皿もみの頭径の既定(mm、FR-422)。 */
export const DEFAULT_COUNTERSINK_DIAMETER_MM = 12;

/** 皿もみの開き角の既定(度、FR-422)。JIS の皿頭ねじの標準。 */
export const DEFAULT_COUNTERSINK_ANGLE_DEGREES = 90;

/** 抜き勾配の角度の既定(度、§2.15 の段の表)。 */
export const DEFAULT_DRAFT_ANGLE_DEGREES = 1;

/**
 * 抜き勾配の角度の上限(度、§0.a-0.72)。計画書タスク43 の手順5 は 89 だったが、
 * **統括の決定 §0.a-0.72(2026-09-05 14:21)が 60 度に狭めた**のでそちらを採る。
 */
export const MAX_DRAFT_ANGLE_DEGREES = 60;

/** ミラーの鏡にする平面の既定(§0.a-0.36)。基準の 3 面のうち XY。 */
export const DEFAULT_MIRROR_PLANE_ID: BaseWorkPlaneId = 'xy';

/** 移動/回転の回転角の既定(度、§2.15 の段の表)。0 なら平行移動だけ。 */
export const DEFAULT_TRANSFORM_ROTATION_DEGREES = 0;

/** 移動/回転の移動量の既定(mm、§2.15 の段の表)。X / Y / Z とも 0。 */
export const DEFAULT_TRANSLATION_MM = 0;

/** 拡大縮小の倍率の既定(§2.15 の段の表)。全体倍率・軸ごとのどちらも 2 倍から始める。 */
export const DEFAULT_SCALE_FACTOR = 2;

/** 拡大縮小の倍率の下限(§2.11、計画書タスク43 の手順5)。 */
export const MIN_SCALE = 0.001;

/** 拡大縮小の倍率の上限(§2.11、計画書タスク43 の手順5)。 */
export const MAX_SCALE = 1000;

/**
 * スイープの向きの決め方の既定(FR-409、§2.15 の段の表)。
 * false は「ねじれを抑える」側で、つまみを入れると Frenet になる。
 */
export const DEFAULT_SWEEP_FRENET = false;

/** リブの厚みの既定(mm、§2.15 の段の表)。 */
export const DEFAULT_RIB_THICKNESS_MM = 3;

/** リブの厚みを付ける側の既定(§2.15 の段の表のつまみ「両側へ」)。 */
export const DEFAULT_RIB_SIDE: RibSide = 'both';

/** リブを材料に届くまで伸ばすかの既定(FR-420)。届かない壁は用を成さないので true。 */
export const DEFAULT_RIB_EXTEND_TO_BODY = true;

/** エンボスの高さ(深さ)の既定(mm、§2.15 の段の表)。 */
export const DEFAULT_EMBOSS_HEIGHT_MM = 1;

/** エンボスが浮き出すかの既定(FR-421)。false は彫る側(§2.15 の段の表のつまみ「浮き出す」)。 */
export const DEFAULT_EMBOSS_RAISED = false;

/** 外ねじの長さの既定(mm、§2.15 の段の表)。 */
export const DEFAULT_THREAD_SHAFT_LENGTH_MM = 20;

/** 外ねじを切り始める端の既定(FR-423)。円柱面の軸のパラメータが小さいほうの端。 */
export const DEFAULT_THREAD_SHAFT_FROM_END: 'first' | 'last' = 'first';

/**
 * 外ねじを実らせんで切るかの既定(FR-423、§0.a-0.15)。
 * 実らせんは 1 本で数秒かかる(2026-09-05 実測 中央値 4184ms)ので、既定は簡略表示。
 */
export const DEFAULT_THREAD_SHAFT_MODELED = false;

/** 曲面の押し出し・ロフトの既定の距離(mm、FR-428)。押し出しの既定と揃える必要はない。 */
export const DEFAULT_SURFACE_DISTANCE_MM = 20;

/** 曲面の回転の既定の角度(度、FR-428)。全周。 */
export const DEFAULT_SURFACE_ANGLE_DEGREES = 360;

/**
 * 曲面のオフセットの既定の距離(mm、FR-428、タスク42b で足した 6 種目)。
 * 押し出しの距離(20mm)と分けてあるのは、面を「少し離す」使い方が普通だからである。
 */
export const DEFAULT_SURFACE_OFFSET_MM = 5;

/* -- P5 の Could 群のうちタスク46 が前倒しした 2 つ(FR-418、FR-426、§2.12)-- */

/** くり抜きの壁の厚さの既定(mm、FR-418、§0.a-0.47)。 */
export const DEFAULT_SHELL_THICKNESS_MM = 2;

/** くり抜きの向きの既定(FR-418)。false = 内向き(外側の大きさが変わらない)。 */
export const DEFAULT_SHELL_OUTWARD = false;

/**
 * 可変半径フィレットの終点側の半径の既定(mm、FR-426、§0.a-0.48)。
 * 始点側の既定(`DEFAULT_FILLET_RADIUS_MM` = 2)と違う値にしてあるのは、
 * 「可変にする」を選んだ瞬間に一定半径と同じ形にならないようにするためである。
 */
export const DEFAULT_FILLET_RADIUS_END_MM = 5;

/* -- 平面による切断(FR-432、§2.9b、タスク27c)-- */

/**
 * 切断で残す側の既定(§0.a-0.57、§2.9b.2)。法線の側を残す。
 *
 * 既定値は 1 か所だけに置く(`extrudeShapingOf` / `filletRadiusOf` と同じ約束)。
 * コマンド(タスク27e)とプロパティ(タスク27f)はこの値を写さずにここから読む。
 */
export const DEFAULT_CUT_KEEP: CutFeature['keep'] = 'positive';

/*
 * 省略できる欄の約束(P5 仕上げ (h)、`docs/報告記録.md` 2026-09-05 23:08 の t47 指摘②)。
 *
 * この下にある3つの口(`extrudeShapingOf` / `holeEntryOf` / `filletRadiusOf`)が
 * 「省略できる欄」を埋める場所を1か所に揃えている。約束は次のとおり:
 *
 * - **欄が無い(`undefined`)= 既定。** 既定値は各既定定数(`DEFAULT_EXTRUDE_END` 等)が
 *   持ち、読む側は必ずこの3つの口を通す。`feature.end ?? ...` を呼び出し側ごとに
 *   書き直さない(書けば既定値の写しが増え、片方だけ直したときに黙って食い違う)。
 * - **`null` は、その欄が「無い」こと自体に意味があるときだけ使う。** 例:
 *   押し出しの `thickness: null` = 中実(壁を作らない、という積極的な指定。
 *   `undefined` の「値を決めていない」とは別の意味)。
 * - **それ以外の省略できる欄は `undefined` だけを使う。** `radiusEnd`(可変半径の終点側)
 *   は `undefined` も `null` も同じ「一定半径」を表す(`thickness` ほど強い意味を
 *   `null` に持たせていない)ので、読み手(`packages/io` の `readFilletFeature`)は
 *   `null` を「欄ごと省略」として読み、書き手と対称にする。`entry`(穴の入口)・`end`
 *   (押し出しの終端)は `undefined` だけを使い、`null` を書かない(書いても
 *   意味を割り当てていないので、読み手は型違いとして断ってよい)。
 * - **io はこの既定値を書き出さない。** 欄が既定と同じなら省く(古い版と同じ字面のまま
 *   保存する、`serializeSolidFeature` の各 `kind` の分岐を参照)。
 */

/**
 * 押し出しの「終端・傾き・薄板」の欄をすべて埋めた形(FR-415、FR-401、FR-416)。
 *
 * 欄名はカーネルの `ExtrudeShapeOptions`(`occt/makeSolidSweep.ts`)と同じにしてあるので、
 * 解決(タスク45)は式を数へ直すだけで詰め替えられる。
 */
export interface ExtrudeShaping {
  readonly end: ExtrudeEnd;
  readonly taperAngle: ExpressionValue;
  readonly taperOutward: boolean;
  readonly thickness: ExpressionValue | null;
  readonly thicknessSide: ThicknessSide;
}

/**
 * 押し出しの省略された欄を既定で埋める(FR-415、FR-401、FR-416。タスク43)。
 *
 * **既定値をここ 1 か所だけに置くための口。** 解決・読み書き・プロパティ・その場入力は
 * `feature.end ?? ...` と自分で書かず、必ずこれを通す(同じ既定を各所へ写すと、片方だけ
 * 変えたときに黙って食い違う。`RuledSphereSegments` の既定と同じ考え方)。
 *
 * **終端の省略は `symmetric` から決める。** `end` は P5 タスク43 で足した欄で、それ以前の
 * 文書は「両側へ出すか」を `symmetric`(P2 からの欄)だけで表していた。既定を一律に
 * `distance` にすると、両側へ出していた古い押し出しが片側へ変わってしまう。
 */
export function extrudeShapingOf(feature: ExtrudeFeature): ExtrudeShaping {
  return {
    end: feature.end ?? (feature.symmetric ? { kind: 'symmetric' } : DEFAULT_EXTRUDE_END),
    taperAngle: feature.taperAngle ?? expressionValueFromNumber(DEFAULT_TAPER_ANGLE_DEGREES),
    taperOutward: feature.taperOutward ?? false,
    thickness: feature.thickness ?? null,
    thicknessSide: feature.thicknessSide ?? DEFAULT_THICKNESS_SIDE,
  };
}

/**
 * 穴・ねじ穴の入口の形(FR-422)。省略は「広げない」(§0.a-0.39)。
 * 既定を 1 か所に置く理由は `extrudeShapingOf` と同じ。
 */
export function holeEntryOf(feature: HoleFeature | ThreadHoleFeature): HoleEntry {
  return feature.entry ?? DEFAULT_HOLE_ENTRY;
}

/**
 * R 面取りの半径(FR-407、可変半径は FR-426)。省略は「一定半径」(§0.a-0.48)。
 *
 * 既定を 1 か所に置く理由は `extrudeShapingOf` / `holeEntryOf` と同じ。
 * 種類を付けて返すのは、読む側(解決・鍵・プロパティ)が `radiusEnd` の null 判定を
 * それぞれ書かずに済ませるためである。カーネルの `FilletRadiusSpec`
 * (`number | { start; end }`)とは 1 対 1 に対応する。
 */
export type FilletRadius =
  | { readonly kind: 'constant'; readonly radius: ExpressionValue }
  | {
      readonly kind: 'variable';
      /** 辺の始点側の半径。`FilletFeature.radius` そのもの。 */
      readonly start: ExpressionValue;
      /** 辺の終点側の半径。 */
      readonly end: ExpressionValue;
    };

export function filletRadiusOf(feature: FilletFeature): FilletRadius {
  const end = feature.radiusEnd;
  if (end === undefined || end === null) {
    return { kind: 'constant', radius: feature.radius };
  }
  return { kind: 'variable', start: feature.radius, end };
}

/**
 * 連番を分ける単位。ブーリアンは演算ごとに別の連番にするので、
 * フィーチャーの種類そのもの(`boolean`)ではなく演算名を鍵にする(§2.3)。
 * パターンも同じ理由で配置ごと(直線 / 円形)に分ける。
 */
export type SolidLabelKey =
  | 'extrude'
  | 'revolve'
  | 'sew'
  | BooleanOperation
  | 'hole'
  | 'threadHole'
  | 'fillet'
  | 'chamfer'
  | 'linearPattern'
  | 'circularPattern'
  | 'spring'
  /*
    基本形状(FR-429)は5種を別々の連番にする(「球1」「箱1」…)。
    ブーリアンを演算ごとに分けているのと同じ理由で、利用者から見て別の道具だからである
    (「基本形状1」「基本形状2」では、木を見ても何を置いたのか分からない)。
  */
  | PrimitiveShapeKind
  /*
    面をつなぐ(FR-430)とロフト(FR-410)も別々の連番にする。カーネルの段は 1 種類だが、
    利用者から見て別の道具なので(§0.a-0.25)、木に「面をつなぐ1」「ロフト1」と出す。
  */
  | 'ruled'
  | 'loft'
  /*
    P5 の Should 群(§2.11、タスク43)。9 種はフィーチャーの種類とそのまま 1 対 1 で、
    ブーリアン・パターン・基本形状のように 1 つの種類を複数の連番へ分けるものは無い
    (曲面 5 種は「押し出し面1」ではなく「曲面1」で数える。利用者から見て道具が 1 つだから)。
  */
  | 'draft'
  | 'mirror'
  | 'transform'
  | 'scale'
  | 'sweep'
  | 'rib'
  | 'emboss'
  | 'threadShaft'
  | 'surface'
  /*
    点集合パターン(FR-425、§0.a-0.42)。直線・円形と同じ理由で配置ごとに連番を分ける
    (`PatternPlacement` に case が 1 つ増えたので、鍵も 1 つ増える)。
  */
  | 'pointPattern'
  /** くり抜き(FR-418、§2.12)。P5 の Could 群のうちタスク46 が前倒しした 1 種。 */
  | 'shell'
  /** 平面による切断(FR-432、§2.9b、タスク27c)。分割(FR-424)もこれで満たす。 */
  | 'cut'
  /*
    読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。B-rep(STEP)と
    三角形(STL / OBJ / 3MF / glTF)は利用者から見て別のもの——**三角形の形は加工できない**
    (§0.a-0.23)——なので、ブーリアンの演算・基本形状の 5 種と同じ理由で連番も分ける。
  */
  | 'importedSolid'
  | 'importedMesh';

/**
 * `Record<K, true>` の鍵をそのまま `K[]` として返す小さな道具(h-③)。
 *
 * `Object.keys` はいつも `string[]` を返す(TypeScript の仕様)。`as` で無理やり型を
 * 付け直すのではなく、型ガード(`key is K`)で絞り込む。`record` の鍵がちょうど `K` の
 * 全体と一致することは、呼び出し側の `satisfies Record<K, true>` が型検査で保証する。
 */
function keysOf<K extends string>(record: Readonly<Record<K, true>>): readonly K[] {
  const isKeyOfRecord = (key: string): key is K => key in record;
  return Object.keys(record).filter(isKeyOfRecord);
}

/**
 * `SolidFeatureKind`(26 種)を漏れなく1つずつ持つ表。**この表に種類を1つ足し忘れると
 * `satisfies Record<SolidFeatureKind, true>` が型検査で落ちる**(余分な鍵を書いても同様)。
 * `SOLID_FEATURE_KINDS` はこの表の鍵をそのまま並べたもの。
 */
const SOLID_FEATURE_KIND_TABLE = {
  extrude: true,
  revolve: true,
  sew: true,
  boolean: true,
  hole: true,
  threadHole: true,
  fillet: true,
  chamfer: true,
  pattern: true,
  spring: true,
  primitive: true,
  ruled: true,
  loft: true,
  draft: true,
  mirror: true,
  transform: true,
  scale: true,
  sweep: true,
  rib: true,
  emboss: true,
  threadShaft: true,
  surface: true,
  shell: true,
  cut: true,
  importedSolid: true,
  importedMesh: true,
} satisfies Record<SolidFeatureKind, true>;

/**
 * 実行時に持てる `SolidFeatureKind` の一覧(26 種。P5 仕上げ (h) で 24 種、P6 タスク20 で
 * 読み込んだ形の 2 種を足した。
 * `docs/報告記録.md` 2026-09-05 23:08 の t47 指摘③)。
 *
 * これまで `packages/io`(妥当性検査の選択肢)と `packages/ui`(自前の一覧)が
 * それぞれ種類の一覧を手書きで持っていて、`SolidFeatureKind` に種類を1つ足しても
 * 揃えて直す仕組みが無かった。ここを唯一の実行時の一覧にし、`io` はこれを輸入する
 * (このタスクで置き換え済み)。`ui` の自前の一覧の置き換えは後続タスクの担当。
 *
 * `SOLID_LABELS`(`SolidLabelKey` の表、34 種)とは鍵の粒度が違うので**同じ配列にはならない**
 * (ブーリアン・パターン・基本形状は複数の連番の単位に分かれる。上の `SolidLabelKey` の
 * 定義を参照)。網羅は `SOLID_FEATURE_KIND_TABLE` の `satisfies` が型検査で保証していて、
 * こちらの一覧は実行時にその鍵を並べただけである。
 */
export const SOLID_FEATURE_KINDS: readonly SolidFeatureKind[] = keysOf(SOLID_FEATURE_KIND_TABLE);

/**
 * ソリッドの種類ごとの既定名。ドキュメントの既定データとしてここに置く
 * (UI 文字列 ja.json とは別扱い。スケッチの KIND_LABELS と同じ考え方)。
 */
export const SOLID_LABELS: Readonly<Record<SolidLabelKey, string>> = {
  extrude: '押し出し',
  revolve: '回転',
  sew: '縫合',
  union: '和',
  subtract: '差',
  intersect: '積',
  hole: '穴',
  threadHole: 'ねじ穴',
  fillet: 'R面取り',
  chamfer: 'C面取り',
  linearPattern: '直線パターン',
  circularPattern: '円形パターン',
  spring: 'ばね',
  sphere: '球',
  box: '箱',
  cylinder: '円柱',
  cone: '円錐',
  torus: 'トーラス',
  ruled: '面をつなぐ',
  loft: 'ロフト',
  // P5 の Should 群(§2.11、タスク43)。ツールバーの道具の名前(タスク48 の ja.json)と
  // 同じ言葉にする(FR-501「木の名前と道具の名前が食い違わない」)。
  draft: '抜き勾配',
  mirror: 'ミラー',
  transform: '移動・回転',
  scale: '拡大縮小',
  sweep: 'スイープ',
  rib: 'リブ',
  emboss: 'エンボス',
  threadShaft: '外ねじ',
  surface: '曲面',
  pointPattern: '点パターン',
  // くり抜き(FR-418、§2.12。P5 の Could 群、タスク46 で前倒し)。
  shell: 'くり抜き',
  // 平面による切断(FR-432、§2.9b、タスク27c)。「反対側も残す」で 2 つ積んだときは
  // 「切断1」「切断2」と連番が並ぶ(同じ種類なので分けない)。
  cut: '切断',
  // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8)。利用者の言葉で「読み込んだ形」と
  // 「読み込んだ三角形の形」に分ける(断りの文言(§2.8 の表)と同じ言い回しにそろえる)。
  importedSolid: '読み込んだ形',
  importedMesh: '読み込んだ三角形の形',
};

/**
 * 基準ジオメトリの種類ごとの既定名(FR-328、FR-329)。
 * `SOLID_LABELS` と同じくドキュメントの既定データとしてここに置く(UI 文字列とは別扱い)。
 */
export const REFERENCE_LABELS: Readonly<Record<ReferenceFeatureKind, string>> = {
  referencePlane: '作業平面',
  referenceAxis: '基準軸',
  referencePoint: '基準点',
  referenceCoordinateSystem: '座標系',
};

/**
 * スケッチの既定名の見出し(P4 仕上げ (g))。「スケッチ1」「スケッチ2」…と連番を付ける。
 * `createEmptySketchDocument` が起動時に付ける名前(「スケッチ1」)と必ず同じ言葉にする。
 * `SOLID_LABELS` / `REFERENCE_LABELS` と同じくドキュメントの既定データ(UI 文字列とは別扱い)。
 */
export const SKETCH_LABEL = 'スケッチ';

/** 起動時の部品。空のスケッチを1本だけ持ち、基準ジオメトリもソリッドも無い(NFR-UX-6)。 */
export function createEmptyPartDocument(): PartDocument {
  const sketch = createEmptySketchDocument();
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PART_SCHEMA_VERSION,
    sketches: [sketch],
    activeSketchId: sketch.id,
    references: [],
    solids: [],
    // パラメータ表(FR-207)の既定は空。名前を付けた数値は利用者が足す(P4b タスク2)。
    parameters: [],
    // 外観の割り当て(FR-1106〜1110)の既定は空の表。割り当てが1つも無い文書は
    // P2 からの単色(`DEFAULT_APPEARANCE`)で描かれ、見た目は変わらない(P5 §0.a-0.4)。
    appearance: emptyAppearanceTable(),
    // 選択セット(FR-112、P6 §0.a-0.44)の既定は空。名前を付けた組は利用者が作る
    // (タスク37)。外観と同じく形に影響しない札なので、起動時の見た目は変わらない。
    selectionSets: [],
    // 下絵の画像(FR-332、P6 §0.a-0.45)の既定も空。読み込んだときだけ増える(タスク38)。
    canvases: [],
  };
}

export function findReference(
  document: PartDocument,
  featureId: string,
): ReferenceFeature | undefined {
  return document.references.find((feature) => feature.id === featureId);
}

/**
 * 基準ジオメトリを履歴の末尾へ足す(FR-328、FR-329)。
 * 作業平面の id はそのまま作図面の id になるので、すでに同じ id があれば足さずに返す。
 */
export function appendReference(
  document: PartDocument,
  feature: ReferenceFeature,
): PartDocument {
  if (findReference(document, feature.id) !== undefined) {
    return document;
  }
  return { ...document, references: [...document.references, feature] };
}

/** 1つを差し替える(名前の変更・表示の切替もこれで行う)。見つからなければそのまま返す。 */
export function replaceReference(
  document: PartDocument,
  featureId: string,
  next: ReferenceFeature,
): PartDocument {
  if (findReference(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    references: document.references.map((feature) =>
      feature.id === featureId ? next : feature,
    ),
  };
}

/**
 * 1つを取り除く。これを作図面にしていたスケッチや、これを軸にしていたフィーチャーは
 * 履歴に残し、解決のときに理由つきで断る(FR-504。止めずに警告する)。
 */
export function removeReference(document: PartDocument, featureId: string): PartDocument {
  if (findReference(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    references: document.references.filter((feature) => feature.id !== featureId),
  };
}

/** 同じ種類の既存の名前の最大連番 + 1(ソリッドと同じ方式、§0.a-0.19)。 */
export function nextReferenceName(document: PartDocument, kind: ReferenceFeatureKind): string {
  const usedNames = document.references
    .filter((feature) => feature.kind === kind)
    .map((feature) => feature.name);
  return nextSerialName(usedNames, REFERENCE_LABELS[kind]);
}

/** 同じ種類の既存の id の最大連番 + 1(ソリッドと同じ方式、§0.a-0.19)。 */
export function nextReferenceId(document: PartDocument, kind: ReferenceFeatureKind): string {
  const usedIds = document.references
    .filter((feature) => feature.kind === kind)
    .map((feature) => feature.id);
  return nextSerialId(usedIds, `${kind}-`);
}

export function findSketch(document: PartDocument, sketchId: string): SketchDocument | undefined {
  return document.sketches.find((sketch) => sketch.id === sketchId);
}

/**
 * スケッチを1本足す。編集中のスケッチは変えない(切り替えは setActiveSketch)。
 * 同じ id がすでにあれば、id の一意性を守るため元の文書をそのまま返す。
 */
export function addSketch(document: PartDocument, sketch: SketchDocument): PartDocument {
  if (findSketch(document, sketch.id) !== undefined) {
    return document;
  }
  return { ...document, sketches: [...document.sketches, sketch] };
}

/**
 * この文書へ足せる空のスケッチを1本作る(P4 仕上げ (g)、FR-501)。
 * まだ足してはいない(足すのは `addSketch`)。id と名前だけを採番して返す。
 */
export function createSketchFor(document: PartDocument): SketchDocument {
  return {
    ...createEmptySketchDocument(),
    id: nextSketchId(document),
    name: nextSketchName(document),
  };
}

/**
 * 新しいスケッチの id(ソリッド・基準ジオメトリと同じ連番方式、§0.a-0.19)。
 * 途中の 1 本を消しても残ったものと重ならない(「スケッチ1」を消しても次は「スケッチ3」)。
 */
export function nextSketchId(document: PartDocument): string {
  return nextSerialId(
    document.sketches.map((sketch) => sketch.id),
    'sketch-',
  );
}

/** 新しいスケッチの名前(id と同じ方式、§0.a-0.19)。利用者が改名した名前とも重ならない。 */
export function nextSketchName(document: PartDocument): string {
  return nextSerialName(
    document.sketches.map((sketch) => sketch.name),
    SKETCH_LABEL,
  );
}

/**
 * スケッチを1本取り除く(P4 仕上げ (g)、FR-503)。
 *
 * **最後の1本は消さない。** 消すと作図する場所が無くなり、`activeSketchId` の指し先も
 * 作れなくなるため(§0.a-0.4「activeSketchId は sketches のいずれかを指す」)。
 * 消したものを編集中だったときは、残りの先頭を編集中にする。
 * このスケッチの要素を参照していた立体は履歴に残し、解決のときに理由つきで断る
 * (FR-504。止めずに警告する。`removeSolid` / `removeReference` と同じ扱い)。
 */
export function removeSketch(document: PartDocument, sketchId: string): PartDocument {
  if (document.sketches.length <= 1 || findSketch(document, sketchId) === undefined) {
    return document;
  }
  const sketches = document.sketches.filter((sketch) => sketch.id !== sketchId);
  return {
    ...document,
    sketches,
    activeSketchId:
      document.activeSketchId === sketchId ? sketches[0].id : document.activeSketchId,
  };
}

/** スケッチを1本差し替える。同じ id が無ければ元の文書をそのまま返す。 */
export function replaceSketch(document: PartDocument, sketch: SketchDocument): PartDocument {
  if (findSketch(document, sketch.id) === undefined) {
    return document;
  }
  return {
    ...document,
    sketches: document.sketches.map((current) => (current.id === sketch.id ? sketch : current)),
  };
}

/** 編集中のスケッチを切り替える。実在しない id なら元の文書をそのまま返す(§0.a-0.4)。 */
export function setActiveSketch(document: PartDocument, sketchId: string): PartDocument {
  if (findSketch(document, sketchId) === undefined) {
    return document;
  }
  return { ...document, activeSketchId: sketchId };
}

export function findSolid(document: PartDocument, featureId: string): SolidFeature | undefined {
  return document.solids.find((feature) => feature.id === featureId);
}

/**
 * ソリッドフィーチャーを履歴の末尾へ足す。
 * id はボディの id でもあり他のフィーチャーから参照されるので、
 * すでに同じ id があれば足さずに元の文書をそのまま返す(§0.a-0.5)。
 */
export function appendSolid(document: PartDocument, feature: SolidFeature): PartDocument {
  if (findSolid(document, feature.id) !== undefined) {
    return document;
  }
  return { ...document, solids: [...document.solids, feature] };
}

/**
 * 1つを差し替える。抑制(FR-503)と名前の変更もこれで行う。
 * 見つからなければ元の文書をそのまま返す。id は変えない前提(id はボディの識別子)。
 */
export function replaceSolid(
  document: PartDocument,
  featureId: string,
  next: SolidFeature,
): PartDocument {
  if (findSolid(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    solids: document.solids.map((feature) => (feature.id === featureId ? next : feature)),
  };
}

/**
 * 1つを取り除く。これを参照していたブーリアンは履歴に残し、
 * 解決のときに理由つきで失敗させる(FR-504。止めずに警告する)。
 */
export function removeSolid(document: PartDocument, featureId: string): PartDocument {
  if (findSolid(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    solids: document.solids.filter((feature) => feature.id !== featureId),
  };
}

/**
 * 同じ種類の既存の名前の最大連番 + 1(§0.a-0.19)。削除しても重複しない。
 * 数えるのは履歴の全部の名前で、利用者が改名した名前とも重ならないようにする。
 */
export function nextSolidName(document: PartDocument, key: SolidLabelKey): string {
  const usedNames = document.solids.map((feature) => feature.name);
  return nextSerialName(usedNames, SOLID_LABELS[key]);
}

/** 同じ接頭辞の既存 id の最大連番 + 1(名前と同じ方式、§0.a-0.19)。 */
export function nextSolidId(document: PartDocument, key: SolidLabelKey): string {
  const usedIds = document.solids.map((feature) => feature.id);
  return nextSerialId(usedIds, `${key}-`);
}

/**
 * 基本形状の基準点の既定(FR-429、NFR-UX-4)。何も選ばずに置いたときの原点。
 *
 * 座標の式(絶対座標の 0, 0, 0)にするのは、点も頂点も選ばずに道具を押しただけで
 * 形ができ、あとからプロパティで式を書き直せるようにするためである(FR-202、FR-502)。
 */
export function defaultPrimitiveOrigin(): SolidOrigin {
  return {
    kind: 'coordinate',
    value: {
      mode: 'absolute',
      x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0),
      z: expressionValueFromNumber(0),
    },
  };
}

/**
 * 基本形状5種の既定の寸法(§2.7.1 の表)。式は既定値の数をそのまま書いた文字列になる
 * (`expressionValueFromNumber`)ので、プロパティ欄に「10」と出て、そのまま直せる。
 */
export function defaultPrimitiveShape(kind: PrimitiveShapeKind): PrimitiveShape {
  switch (kind) {
    case 'sphere':
      return { kind: 'sphere', radius: expressionValueFromNumber(DEFAULT_SPHERE_RADIUS_MM) };
    case 'box':
      return {
        kind: 'box',
        sizeX: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
        sizeY: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
        sizeZ: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
      };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radius: expressionValueFromNumber(DEFAULT_CYLINDER_RADIUS_MM),
        height: expressionValueFromNumber(DEFAULT_CYLINDER_HEIGHT_MM),
      };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: expressionValueFromNumber(DEFAULT_CONE_BOTTOM_RADIUS_MM),
        topRadius: expressionValueFromNumber(DEFAULT_CONE_TOP_RADIUS_MM),
        height: expressionValueFromNumber(DEFAULT_CONE_HEIGHT_MM),
      };
    case 'torus':
      return {
        kind: 'torus',
        majorRadius: expressionValueFromNumber(DEFAULT_TORUS_MAJOR_RADIUS_MM),
        minorRadius: expressionValueFromNumber(DEFAULT_TORUS_MINOR_RADIUS_MM),
      };
  }
}

/**
 * 基本形状のフィーチャーを1つ作る(FR-429)。まだ履歴へは足していない(足すのは
 * `appendSolid`)。id と名前は形ごとの連番で採る(「球1」「箱1」…、§0.a-0.19)。
 *
 * 基準点と向きを省くと、原点に既定の向き(Z 軸)で置く(NFR-UX-4)。
 */
export function createPrimitiveFeature(
  document: PartDocument,
  kind: PrimitiveShapeKind,
  origin: SolidOrigin = defaultPrimitiveOrigin(),
  axis: AxisSpec = DEFAULT_PRIMITIVE_AXIS,
): PrimitiveFeature {
  return {
    id: nextSolidId(document, kind),
    name: nextSolidName(document, kind),
    suppressed: false,
    kind: 'primitive',
    origin,
    axis,
    shape: defaultPrimitiveShape(kind),
  };
}

/**
 * そのフィーチャーが対象として消費するボディの id(§0.a-0.5、P3 §2.6 / §2.7 / §2.7b)。
 *
 * - ブーリアンは対象と相手の2つ。
 * - 加工(穴・ねじ穴・R 面取り・C 面取り)は対象のボディ1つを消費して新しいボディを1つ作る。
 * - パターンは繰り返しのもとにした加工フィーチャーのボディ1つを消費する(§0.a-0.20)。
 * - 押し出し・回転・縫合・**ばね**は何も消費しない(ばねは §0.a-0.36 で「作る」フィーチャー)。
 * - **基本形状**も何も消費しない(P5 §0.a-0.19)。基準点に立体の頂点を指したときも
 *   消費しない: 頂点の座標を読むだけなので、貸した立体はそのまま画面に残る。
 * - **面をつなぐ(罫線面)・ロフト**も何も消費しない(P5 §0.a-0.27)。立体の面や球を
 *   輪郭に借りても、輪郭を読むだけなので元の立体はそのまま画面に残る。残しておかないと
 *   「球と柱を罫線でつないだあと和でまとめる」ができなくなる。
 *
 * P5 の Should 群(§2.11、タスク43)は種類ごとに分かれる:
 * - **抜き勾配・移動/回転・拡大縮小・リブ・エンボス・外ねじ**は対象1つを消費する
 *   (加工と同じで、変換・加工した立体1つだけが残る。§0.a-0.41)。
 * - **ミラー**は消費しない(§0.a-0.36)。鏡像を作ったあと元と鏡像を和でつなぐのが普通の
 *   使い方で、元を消すと和が取れない。
 * - **スイープ**は対象を取らない「作る」フィーチャー。
 * - **曲面**も消費しない。作り方が `face`(既にある立体の面を取り出す)のときだけ相手の
 *   立体を指すが、面を読むだけなので貸した立体はそのまま画面に残る(罫線面の
 *   `solidFace`・基本形状の頂点と同じ扱い。§0.a-0.45)。
 *

 * 順序は文書に書かれた順のまま返す(重複の除去はしない。同じ id を2度指すブーリアンは
 * 解決のときに `consumedTwice` で断る)。
 */
export function consumedTargetsOf(feature: SolidFeature): readonly string[] {
  switch (feature.kind) {
    case 'extrude':
    case 'revolve':
    case 'sew':
    case 'spring':
    case 'primitive':
    case 'ruled':
    case 'loft':
    case 'mirror':
    case 'sweep':
    case 'importedSolid':
    case 'importedMesh':
      // ミラー(§0.a-0.36)は対象を指すが消費しない。スイープは対象を取らない。
      // 読み込んだ形の 2 種(FR-802、P6 §2.8)も対象を取らない「作る」フィーチャーで、
      // 基本形状(P5 §0.a-0.19)とまったく同じ扱いになる。
      return [];
    case 'boolean':
      return [feature.targetFeatureId, feature.toolFeatureId];
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'draft':
    case 'transform':
    case 'scale':
    case 'rib':
    case 'emboss':
    case 'threadShaft':
    case 'shell':
    case 'cut':
      // 加工4種、P5 の Should 群のうち対象1つを消費するもの(§2.11 の表)、そして
      // くり抜き(FR-418、§2.12。中身を抜いた立体 1 つだけが残る)と
      // 平面による切断(FR-432、§2.9b。残す側 1 つだけが残る)。
      //
      // **切断は「対」でも 1 つずつ対象を返す**(§0.a-0.58)。対を 1 度だけ数えるのは
      // 消費する側の役目で(`consumedBodyIds` の注釈)、ここは種類ごとの規則だけを持つ。
      return [feature.targetFeatureId];
    case 'pattern':
      return [feature.sourceFeatureId];
    case 'surface':
      // 曲面(FR-428)。`face` のときだけ相手の立体を指すが、面を読むだけなので
      // **どの作り方でも消費しない**(§0.a-0.45)。分岐を残してあるのは、面のオフセット・
      // 厚み付け(消費しうる種類)が後で足されたときにここを直すと分かるようにするため。
      return [];
  }
}

/**
 * そのフィーチャーが加工(対象のボディを1つだけ取る種類)か。
 * 穴・ねじ穴・R 面取り・C 面取り・パターンが該当する。
 * ブーリアンは対象を2つ取るので加工には数えない。ばねは対象を取らないので `false`(§0.a-0.36)。
 * 基本形状も対象を取らないので `false`(P5 §0.a-0.19)。
 * 面をつなぐ・ロフトも対象を取らない「作る」フィーチャーなので `false`(P5 §0.a-0.27)。
 *
 * P5 の Should 群(§2.11 の表、タスク43)では、**抜き勾配・リブ・エンボス・外ねじ**が
 * `true`(対象1つを取って形を変える加工)、**ミラー・移動/回転・拡大縮小・スイープ・曲面**が
 * `false` になる。移動/回転と拡大縮小は対象を1つ消費するが、形そのものは変えず位置と
 * 大きさを変えるだけなので「加工」には数えない(§2.11 の表が `isMachining` を分けている
 * のはこのため。§2.15 のツールバーでは「加工」の一覧に同居する)。
 */
export function isMachiningFeature(feature: SolidFeature): boolean {
  switch (feature.kind) {
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
    case 'draft':
    case 'rib':
    case 'emboss':
    case 'threadShaft':
    case 'shell':
    case 'cut':
      // くり抜き(FR-418、§2.12)と切断(FR-432、§2.9b)も対象 1 つを取って形を変えるので
      // 加工に数える(ツールバーでも「加工」の畳んだ一覧に入る。§0.a-0.64)。
      return true;
    case 'extrude':
    case 'revolve':
    case 'sew':
    case 'boolean':
    case 'spring':
    case 'primitive':
    case 'ruled':
    case 'loft':
    case 'mirror':
    case 'transform':
    case 'scale':
    case 'sweep':
    case 'surface':
    case 'importedSolid':
    case 'importedMesh':
      // 読み込んだ形の 2 種(FR-802、P6 §2.8)は対象を取らないので加工ではない。
      // **加工の「される側」にはなる**——`importedSolid` の上には穴も面取りも積める
      // (FR-802)。`importedMesh` だけは対象にできず、断りは `resolvePart.ts` が出す。
      return false;
  }
}

/**
 * パターン(FR-411、FR-412)の対象にできるか。穴・ねじ穴だけ(§0.a-0.20)。
 *
 * フィレット・面取りを外すのは「工具の形」が無く、変換した位置の辺を指紋で選び直す必要が
 * あって危ういため。ばねも対象にしない(§0.a-0.36)。基本形状も同じく対象にしない
 * (工具ではなく「作る」フィーチャーだから。P5 §0.a-0.19)。
 *
 * **面をつなぐ・ロフトも対象にしない**(P5 §0.a-0.27)。押し出し・回転・縫合・ばね・
 * 基本形状と同じ「作る」フィーチャーで、差し引く工具の形を持たないためである。
 *
 * **P5 の Should 群 9 種もすべて対象にしない**(§0.a-0.42)。P5 で足すパターンの拡張は
 * 「点の集まりへ複製」だけで、複製できるもとを穴・ねじ穴から広げる話ではない
 * (面取り・R 面取りを対象にする案は Could として P6 以降へ回した)。
 */
export function isPatternSource(feature: SolidFeature): boolean {
  return feature.kind === 'hole' || feature.kind === 'threadHole';
}

/**
 * ほかのフィーチャーに消費されたボディの id(§0.a-0.5)。
 *
 * 消費できるのは「履歴で自分より前にあり、抑制されていない」フィーチャーのボディだけ。
 * 抑制されたフィーチャーは再計算で飛ばされるので何も消費せず、ボディも作らない。
 * 参照先が消えている場合(FR-504 で失敗させる場合)は消費に数えない。
 * ここは文書だけを見る判定で、実際に形が作れたかどうかは resolvePart が決める。
 *
 * **「反対側も残す」で対になった 2 つの切断(FR-432、§0.a-0.58)も、対象を 1 度だけ
 * 数える。** 消費の記録が集合(`Set`)なので、同じ id を 2 度足しても 1 つのままになり、
 * 「対の片方だけが消費した」と数える特別扱いは要らない。結果として対象は画面から消え、
 * 切断 2 つが `liveBodyIds` に並ぶ(これが §0.a-0.58 の求める形である)。
 * 対の片方だけを抑制すれば、残ったほうが単独の切断として対象を消費する。
 */
export function consumedBodyIds(document: PartDocument): ReadonlySet<string> {
  const consumed = new Set<string>();
  const available = new Set<string>();
  for (const feature of document.solids) {
    if (feature.suppressed) {
      continue;
    }
    for (const id of consumedTargetsOf(feature)) {
      if (available.has(id)) {
        consumed.add(id);
      }
    }
    // 自分の id は消費の判定を終えてから足す。自分自身や後ろのボディは参照できない。
    available.add(feature.id);
  }
  return consumed;
}

/**
 * いま画面に出るボディの id を履歴順に並べる(§0.a-0.5)。
 * 抑制されておらず、まだ消費されていないフィーチャーのボディ。
 * 作成に失敗したものを外すのは resolvePart の役目(文書だけでは分からない)。
 */
export function liveBodyIds(document: PartDocument): readonly string[] {
  const consumed = consumedBodyIds(document);
  return document.solids
    .filter((feature) => !feature.suppressed && !consumed.has(feature.id))
    .map((feature) => feature.id);
}
