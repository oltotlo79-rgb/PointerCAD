/** 立体のプロパティが読み書きする表示項目の契約。計算・編集・ストアは所有しない。 */
import type { ExpressionValue } from '@pointercad/expression';
import type { SolidLabelKey } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { SheetFieldKey } from '../sheetMetal/sheetFields.js';
import type { FieldUnit, NumericFieldRange, NumericToggleKey } from '../sketch/numericInput.js';

/**
 * プロパティ欄で式のまま直せる欄の種類。種類ごとに1つだけ持つ。
 * P3 タスク27 で加工6種の欄(直径・深さ・半径・面取りの距離2種・傾き2種・ピッチ・下穴径・
 * ねじ部の長さ・パターンの間隔・個数・角度)を足した。ばねの5つ(コイル径〜全長)は
 * タスク29b が使う欄で、型はここでまとめて広げる(計画書タスク27 の型宣言のとおり)。
 */
export type SolidFieldKey =
  | SheetFieldKey
  | 'distance'
  | 'angle'
  | 'tolerance'
  | 'diameter'
  | 'depth'
  | 'radius'
  | 'chamferDistance'
  | 'chamferDistance2'
  | 'chamferAngle'
  | 'pitch'
  | 'drillDiameter'
  | 'threadLength'
  | 'tiltAngle'
  | 'tiltAzimuth'
  | 'spacing'
  | 'count'
  | 'patternAngle'
  /** ばね(FR-414)。タスク29b が使う。 */
  | 'coilDiameter'
  | 'wireDiameter'
  | 'springPitch'
  | 'springTurns'
  | 'springLength'
  /**
   * 面をつなぐ・ロフトのねじれの補正(FR-430、FR-410、§0.a-0.28。P5 タスク27)。
   * 2 つの道具で意味も単位も同じなので欄の名前も 1 つにする(その場入力の
   * `SolidCommitValues.ruledTwist` と同じ名前)。
   */
  | 'ruledTwist'
  /* ---- P5 の Should / Could 群と切断(タスク52・27f・55、§2.11・§2.12・§2.9b) ---- */
  /** 押し出しの側面の傾き(度、FR-401)。向きは `taperOutward` のつまみが持つ。 */
  | 'taperAngle'
  /** 薄板押し出しの壁の厚み(mm、FR-416)。中実のときは欄ごと出さない。 */
  | 'extrudeThickness'
  /* 穴・ねじ穴の入口(FR-422)。入口の種類で出る欄が入れ替わる(§0.a-0.39)。 */
  | 'counterboreDiameter'
  | 'counterboreDepth'
  | 'countersinkDiameter'
  | 'countersinkAngle'
  /** 可変半径フィレットの終点側の半径(mm、FR-426)。一定半径のときは出さない。 */
  | 'radiusEnd'
  /** 抜き勾配の角度(度、FR-417)。 */
  | 'draftAngle'
  /* 移動/回転(FR-424)。平行移動 3 欄と回す角度。 */
  | 'translationX'
  | 'translationY'
  | 'translationZ'
  | 'rotationAngle'
  /* 拡大縮小(FR-424)。全体の倍率 1 欄と軸ごとの 3 欄を切り替える。 */
  | 'scaleFactor'
  | 'scaleX'
  | 'scaleY'
  | 'scaleZ'
  /** リブの壁の厚み(mm、FR-420)。 */
  | 'ribThickness'
  /** エンボスの高さ(mm、FR-421)。彫るときはその深さになる。 */
  | 'embossHeight'
  /* 曲面(FR-428)。作り方ごとに出る欄が違う。 */
  | 'surfaceDistance'
  | 'surfaceAngle'
  | 'surfaceOffset'
  /** くり抜きの壁の厚さ(mm、FR-418)。 */
  | 'shellThickness'
  /* 切断の切る面(FR-432)。面・作図面からずらす距離と、作図面を傾ける角度。 */
  | 'planeOffset'
  | 'planeAngle';

/**
 * プロパティ欄の1行。式は source をそのまま出す(FR-202)。
 *
 * 計画書は `unitKey: MessageKey` としていたが、欄を描く `ExpressionField` が受け取るのは
 * `FieldUnit`(numericInput.ts の UNIT_KEYS がキーへ直す)なので、同じ対応表を2度持たずに
 * 済むよう `unit: FieldUnit` で返す。スケッチ側の `FeatureFieldSummary` とも形がそろう。
 */
export interface SolidFieldSummary {
  readonly key: SolidFieldKey;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
  /**
   * 読み取り専用(既定 false)。ばねの `derived` が指す欄だけ true になる(§0.a-0.30)。
   * true のときプロパティは `ExpressionField` を無効化して値だけを見せる(タスク29b)。
   */
  readonly readOnly: boolean;
  /**
   * 受け付ける値の範囲(NFR-UX-5、P5 タスク52)。**上限・下限の数は model の定数が正本**で、
   * ここはその定数から組み立てるだけにする(同じ数を 2 か所に書かない)。
   *
   * P5 で足した欄にだけ付ける。P1〜P4 からある欄に後から付けると、いままで通っていた
   * 値が黙って弾かれる(その場入力の側で既に範囲を見ているので、二重に狭める理由も無い)。
   * 範囲を持たない欄では欄そのものを持たない(省略)。
   */
  readonly range?: NumericFieldRange;
}

/**
 * 立体側だけが持つつまみ(C面取りの「基準の面を入れ替える」、§0.a-0.18)。
 * その場入力の `NumericToggleKey`(numericInput.ts)には無い。numericInput.ts は
 * P1・P2 の振る舞いを1つも変えない約束(計画書 §4)なので、ここだけで型を広げる。
 */
export type SolidToggleKey =
  | NumericToggleKey
  | 'swapReferenceFace'
  /**
   * リブの「材料に届くまで伸ばす」(FR-420、P5 タスク52)。その場入力の段では既定のまま
   * 作らせる(欄を増やさない)ので `NumericToggleKey` に無く、プロパティでだけ切り替える。
   */
  | 'ribExtendToBody'
  /**
   * 曲面のロフトを「直線でつなぐ」か(FR-428、P5 タスク52)。同上でプロパティ専用。
   */
  | 'surfaceRuled';

/** 入切のつまみ(向きを反転・両側へ等)。式ではないので値は真偽。 */
export interface SolidToggleSummary {
  readonly key: SolidToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/**
 * 深さの種類・ねじの見せ方・面取りの決め方など、いくつかから1つを選ぶ欄(P3 §2.11)。
 * 直線パターンの「向き」と円形パターンの「軸」は、どちらも model の `PatternDirection` を
 * 使うため `patternDirection` 1つのキーを共用する(計画書タスク27 の型宣言のとおり)。
 */
export interface SolidChoiceSummary {
  /** 長い説明を横一列へ詰めず、1つのメニューで選ぶ。 */
  readonly presentation?: 'menu';
  readonly key:
    | 'sweepGuide'
    | 'depthKind'
    | 'threadDesignation'
    | 'threadSeries'
    | 'threadRepresentation'
    | 'chamferMode'
    | 'patternDirection'
    | 'patternKind'
    /** ばね(FR-414)。タスク29b が使う。 */
    | 'springAxis'
    | 'springHandedness'
    | 'springDerived'
    /**
     * 面をつなぐの「なめらかさ」(球へつなぐときの接点の数、§0.a-0.74。P5 タスク27)。
     * **球を含まない断面では形に効かない**ので、そのときは欄ごと出さない(§0.a-0.87)。
     */
    | 'ruledSphereSegments'
    /* ---- P5 の Should / Could 群と切断(タスク52・27f・55) ---- */
    /** 押し出しの終わり方(FR-415)。距離 / 両側へ / 選んだ面まで / 次の面まで。 */
    | 'extrudeEnd'
    /** 薄板押し出しの厚みの側(FR-416)。内側 / 外側 / 両側。 */
    | 'thicknessSide'
    /** 穴・ねじ穴の入口(FR-422)。広げない / ざぐり / 皿もみ。 */
    | 'holeEntry'
    /** ミラーの鏡にする面(FR-419)。XY / XZ / YZ、選んだ面のときはその 1 つだけ。 */
    | 'mirrorPlane'
    /** 移動/回転の回す軸(FR-424)。回さない / X / Y / Z。 */
    | 'transformAxis'
    /** リブの厚みを付ける側(FR-420)。 */
    | 'ribSide'
    /* 外ねじ(FR-423)。呼び・系列・切り始める端。 */
    | 'threadShaftNominal'
    | 'threadShaftSeries'
    | 'threadShaftFromEnd'
    /** 曲面の作り方(FR-428)。同じ材料で作り直せる範囲だけを選択肢に出す。 */
    | 'surfaceOperation'
    | 'sheetLengthBasis'
    | 'sheetFixedSide'
    | 'sheetReliefShape';
  readonly labelKey: MessageKey;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly labelKey?: MessageKey;
    readonly label?: string;
  }[];
}

/** 選んだ部分形状の数(「選んだ辺 4」のように出す)。個々の番号は利用者に意味が無いので数だけ出す。 */
export interface SolidSubShapeCountSummary {
  readonly labelKey: MessageKey;
  readonly count: number;
}

/**
 * 参照しているもの(もとの面・組み合わせる立体)。座標も形も複製せず、名前だけを引く(FR-311)。
 * 計画書の `{ labelKey, name }` に、クリックでその要素を選べるよう `elementId` を足した。
 */
export interface SolidReferenceSummary {
  readonly labelKey: MessageKey;
  /** 表示名。参照先が見つからないときは参照先の id をそのまま出す。 */
  readonly name: string;
  /** クリックで選べる要素の id。参照先が見つからなければ null(FR-504)。 */
  readonly elementId: string | null;
}

/**
 * 回転軸(FR-402、§0.a-0.9)。ワールドの軸は X / Y / Z を選び直せるが、
 * 線分を軸にしたものは線分そのものを選び直す操作が要るので、名前を読み取り専用で出す。
 */
export type SolidAxisSummary =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly name: string; readonly elementId: string | null };

/** ツリーの行とプロパティ欄が共有する、立体1つの見え方。 */
export interface SolidSummary {
  readonly featureId: string;
  readonly name: string;
  /** 連番の単位で見た種類。ブーリアンは演算ごとに分かれる(和・差・積)。 */
  readonly kind: SolidLabelKey;
  readonly kindLabelKey: MessageKey;
  /** 抑制中(FR-503)。true なら形は計算されない。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
  readonly fields: readonly SolidFieldSummary[];
  readonly toggles: readonly SolidToggleSummary[];
  readonly choices: readonly SolidChoiceSummary[];
  readonly references: readonly SolidReferenceSummary[];
  /** 選んだ部分形状の数(穴の面・中心点、面取りの辺)。持たない種類は空配列。 */
  readonly subShapeCounts: readonly SolidSubShapeCountSummary[];
  /** 回転軸。回転以外は null(パターンの向き・軸は choices の `patternDirection` で出す)。 */
  readonly axis: SolidAxisSummary | null;
}
