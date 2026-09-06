/**
 * アセンブリ文書の保存形式(計画書 docs/plans/P7-アセンブリ.md §2.2、要件§8)。
 *
 * 部品(パート)文書 `part/types.ts` と同じ流儀で、保存するのは
 * 「利用者が決めたこと」だけにする(rules/04-設計の規律.md「導出できるものは保存しない」)。
 * すなわち、
 *  - 部品の**形**(B-rep・メッシュ)は入れない。抱き込むのは部品文書だけで、形は開くたびに
 *    部品ごとに 1 回だけ再計算して全インスタンスで使い回す(§0.a-0.3、§0.a-0.4)。
 *  - **合致の解は入れない。** 保存するのは利用者が置いた配置(`Placement`)だけで、
 *    開くたびに解き直す(§0.a-0.6)。
 *  - 規格部品は**呼び寸法だけ**を持ち、形は寸法表から組み立て直す(§0.a-0.35)。
 *
 * 長さは mm・角度は度で、数値の欄はすべて式と評価値の組(`ExpressionValue`)で持つ
 * (FR-202、NFR-RE-3)。参照はすべて id で持ち、座標や形を複製しない(FR-311、FR-502)。
 *
 * **`part/types.ts` の `PartDocument` には 1 欄も足さない**(§0.a-0.1)。部品とアセンブリの
 * 境目をここで引き、部品の側はアセンブリを知らないままにする。
 *
 * ここに置くのは「保存される形」だけで、解の途中で作る型(変数の並び・残差・診断)は
 * `assembly/constraints/**` が自分で持つ(`part/types.ts` と `part/resolvePart.ts` の関係と同じ)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { AppearanceSpec } from '../appearance/types.js';
import type { AxisSpec } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { Parameter } from '../parameters/types.js';

/**
 * 規格部品の種類(FR-612、FR-616、§0.a-0.30〜0.35)。
 *
 * **寸法表そのもの(行の型と数値)は `assembly/standard/**` が持つ**(P7 タスク27・28)。
 * ここに種類の一覧だけを置くのは、`ComponentSource` が保存される形として
 * この id を持つためで、**同じ一覧を 2 か所に書かない**ために標準部品側はここを読む。
 *
 * 出典の規格番号は寸法表の側に注釈で残す(§0.a-0.31。統括が原典と照合して渡す)。
 */
export type StandardCatalogId =
  /** 六角ボルト */
  | 'hexBolt'
  /** 六角ナット */
  | 'hexNut'
  /** 平座金 */
  | 'plainWasher'
  /** ばね座金 */
  | 'springWasher'
  /** 六角穴付きボルト */
  | 'socketHeadCapScrew'
  /** 深溝玉軸受(簡略形状。§0.a-0.33) */
  | 'deepGrooveBallBearing'
  /** 等辺山形鋼 */
  | 'equalAngle'
  /** 溝形鋼 */
  | 'channel'
  /** H 形鋼 */
  | 'hBeam';

/**
 * 部品の出どころ(FR-601、FR-613、§0.a-0.3、§0.a-0.35、§0.a-0.41)。
 *
 * `partRef` / `assemblyRef` は ZIP の中の抱き込んだ文書(`parts/<ref>.json`)を指す名前で、
 * 元のファイルの場所と内容ハッシュは封筒の側(`partFiles`)が持つ(§2.2)。
 * **同じ出どころを複数のインスタンスが共有する**ので、形は出どころごとに 1 回だけ作る。
 */
export type ComponentSource =
  /** 抱き込んだ部品文書(`parts/<partRef>.json`)。 */
  | { readonly kind: 'part'; readonly partRef: string }
  /** 抱き込んだアセンブリ文書(サブアセンブリ、FR-613)。 */
  | { readonly kind: 'subAssembly'; readonly assemblyRef: string }
  /**
   * 規格部品(FR-612・FR-616)。**呼び寸法だけを保存し、組み立てた部品文書は保存しない**
   * (§0.a-0.35)。`size` は寸法表の行の呼び(「M8」「6203」「L50x50x6」など)、
   * `options` は形鋼の長さのように呼び寸法だけでは決まらない指定を入れる(§0.a-0.34)。
   */
  | {
      readonly kind: 'standardPart';
      readonly catalog: StandardCatalogId;
      readonly size: string;
      readonly options: Readonly<Record<string, string>>;
    };

/**
 * 配置(§0.a-0.5、§2.4)。**位置は式で書け、向きは四元数で持つ。**
 *
 * 4×4 の行列では持たない。四元数なら反復のたびに正規化 1 回で回転へ戻せ、行列を直に
 * 書き換えたときのような「回転でなくなる」丸め誤差が漏れないためである(§0.a-0.5)。
 * 成分の並びは `(qx, qy, qz, qw)` で、`qw = cos(θ/2)`、`(qx,qy,qz) = 軸 × sin(θ/2)`。
 *
 * **`q` と `−q` は同じ回転**なので、保存する前に `qw >= 0` へ揃える(§0.a-0.54)。
 * 揃える純関数は 1 か所(`assembly/placementMath.ts` の `normalizePlacement`、P7 タスク2)。
 * 利用者に四元数そのものは見せない(画面では「軸と角度」で入力する。§2.4)。
 */
export interface Placement {
  /** 位置(mm)。式のまま持つ(FR-202)。 */
  readonly position: readonly [ExpressionValue, ExpressionValue, ExpressionValue];
  /** 向き。`qx, qy, qz, qw` の順。長さ 1・`qw >= 0` に正規化して持つ。 */
  readonly rotation: readonly [number, number, number, number];
}

/**
 * 置いた部品 1 つ(インスタンス。FR-601、FR-606)。
 *
 * 同じ部品を何個置いても `source` が同じで `id` と `placement` だけが違う。
 * 形は `source` ごとに 1 つしか作らない(§0.a-0.8)。
 */
export interface AssemblyComponent {
  /** `component-<n>`。番号は再利用しない(`createAssemblyDocument.ts` の `nextComponentId`)。 */
  readonly id: string;
  /** 木と部品表に出す名前。既定は `<部品名>:<n>`(P7 タスク7 が付ける)。 */
  readonly name: string;
  readonly source: ComponentSource;
  /**
   * 利用者が置いた配置。**合致を解いた結果はここへ書き戻さない**(§0.a-0.6)。
   * 引っぱって離した瞬間だけ、この欄が書き換わる(§2.5.4)。
   */
  readonly placement: Placement;
  /**
   * 固定(グラウンド、FR-602)。真なら連立の変数を持たない(動かない)。
   * **固定でも合致の対象にはなる**(地面としてよく使う。§2.11)。
   */
  readonly fixed: boolean;
  /**
   * 表示/非表示(FR-605)。**偽でも組み立ての一部なので変数は持つ**(§2.5.1)。
   * 干渉チェックの対象からは外れる(§0.a-0.28)。
   */
  readonly visible: boolean;
  /** 抑制(FR-503 と同じ流儀)。真なら無いものとして扱い、変数も式も出さない。 */
  readonly suppressed: boolean;
  /** 組図での色分け(FR-605)。無ければ部品自身の外観で描く(上書きしない)。 */
  readonly appearance?: AppearanceSpec;
  /**
   * 材質(部品表と質量。FR-611、§0.a-0.39)。`densityMaterials.ts` の材料の id。
   * **`PartDocument` に材質の欄が無い**ため、アセンブリの側で持つ(2026-09-06 実測)。
   * 将来 `PartDocument` に欄ができたら、そちらを優先して読む。
   */
  readonly materialId?: string;
}

/**
 * 部品の基準ジオメトリ(FR-329)のうち、合致の対象に取れるもの。
 *
 * 面の名前は既存の基準の 3 面(`sketch/planeMath.ts` の `BaseWorkPlaneId`)と同じ綴りにして、
 * 同じものを 2 通りの名前で呼ばないようにする。
 */
export type OriginElement = 'origin' | 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz';

/**
 * 合致の対象(§0.a-0.14)。
 *
 * 部分形状は P3 からの指紋(`SubShapeRef`)で指す。指紋なら部品を作り直しても選び直せ、
 * 部品の置換(FR-614)も同じ仕組みに乗る。`componentId` と組にして初めて
 * アセンブリの中で一意に決まる(`SubShapeRef.bodyFeatureId` は部品の中の id のため)。
 */
export type MateTarget =
  | { readonly kind: 'subShape'; readonly componentId: string; readonly ref: SubShapeRef }
  /** 部品の原点・3 軸・3 平面(基準ジオメトリ、FR-329)。 */
  | { readonly kind: 'origin'; readonly componentId: string; readonly element: OriginElement };

/**
 * 合致の種類(FR-603、FR-609、§0.a-0.13)。**6 種**。
 *
 * 固定(FR-602)は `AssemblyComponent.fixed` が持つので種類には入れない。
 * 点どうしの一致・点と面の一致は `coincident` の対象の組み合わせで表す
 * (§2.5.2 が式の本数を対象の種類から決める)。
 * **直角・対称・歯車比は足さない**(要件に無い。直角は角度 90° で書ける)。
 */
export type MateKind =
  /** 一致(面と面・点と点・点と面)。面どうしはオフセット距離を取れる(FR-603)。 */
  | 'coincident'
  /** 同心(軸合致、FR-603)。 */
  | 'concentric'
  /** 距離(選んだ 2 要素の間、FR-609)。 */
  | 'distance'
  /** 角度(FR-603)。0°・180° に近い指定は断る(§0.a-0.16)。 */
  | 'angle'
  /** 平行(面・軸、FR-609)。 */
  | 'parallel'
  /** 接線(円筒面と平面。FR-609 の Could)。 */
  | 'tangent';

/** 合致 1 本(FR-603、FR-604、FR-609)。 */
export interface Mate {
  /** `mate-<n>`。番号は再利用しない。 */
  readonly id: string;
  /** 木と一覧に出す名前。 */
  readonly name: string;
  readonly kind: MateKind;
  readonly a: MateTarget;
  readonly b: MateTarget;
  /**
   * 距離(mm)・角度(度)。種類によって使う/使わない
   * (`distance` と `angle` は必ず使い、`coincident` は面どうしのオフセットに使う)。
   */
  readonly value?: ExpressionValue;
  /** 向きを裏返す(面合致の「同じ向き」/「向かい合わせ」)。 */
  readonly flipped: boolean;
  /** 抑制(FR-503 と同じ流儀)。真なら式を出さない。 */
  readonly suppressed: boolean;
}

/**
 * ジョイントの種類(FR-618、§0.a-0.22)。**4 種**。
 *
 * 残る自由度は 回転 1 / 移動 1 / 回転と移動の 2 / 向き 3(§2.6)。
 * 平面・剛・ピン-スロットは足さない(要件に無い。「剛」は固定 FR-602 で満たせる)。
 */
export type JointKind = 'revolute' | 'slider' | 'cylindrical' | 'ball';

/**
 * ジョイント 1 つ(FR-618、§0.a-0.21)。
 *
 * 合致(`Mate`)と別の型にするのは、ジョイントが「**残す自由度**」を持ち、画面に
 * 可動範囲のつまみが要るためである(合致は「消す条件」だけを持つ)。
 * 内部では合致と同じ連立に入る(§2.6)。
 */
export interface Joint {
  /** `joint-<n>`。番号は再利用しない。 */
  readonly id: string;
  readonly name: string;
  readonly kind: JointKind;
  readonly a: MateTarget;
  readonly b: MateTarget;
  /**
   * 可動範囲(§0.a-0.23)。`null` は無制限(既定)。角度は度、移動は mm。
   * **連立には入れず、つまみで駆動するときにだけ丸める**(不等式を解かない)。
   */
  readonly minValue: ExpressionValue | null;
  readonly maxValue: ExpressionValue | null;
  readonly suppressed: boolean;
}

/**
 * 分解図とアニメーションのステップ 1 つ(FR-617、FR-618、§0.a-0.24、§0.a-0.36)。
 *
 * 分解とジョイントの動きで**時間軸 `t ∈ [0, 1]` を 1 本だけ共有する**ので、
 * 「分解しながら軸を回す」がステップを並べるだけで書ける。
 * **いまの `t`(再生位置)は文書に持たない**(表示専用の状態。rules/04)。
 */
export interface PresentationStep {
  /** `step-<n>`。番号は再利用しない。 */
  readonly id: string;
  readonly name: string;
  /** 時間軸の中の区間。`0 <= start < end <= 1`。同じ区間に複数のステップを置ける。 */
  readonly start: number;
  readonly end: number;
  readonly body:
    | {
        /** 部品をまとめて向きへ離す(FR-617)。向きは P5 の `AxisSpec` を流用する。 */
        readonly kind: 'explode';
        readonly componentIds: readonly string[];
        readonly direction: AxisSpec;
        readonly distance: ExpressionValue;
      }
    | {
        /** ジョイントを `from` から `to` まで駆動する(FR-618)。 */
        readonly kind: 'joint';
        readonly jointId: string;
        readonly from: ExpressionValue;
        readonly to: ExpressionValue;
      };
}

/** 部品表の列(FR-611 の 4 列 + 質量。§0.a-0.38)。 */
export type BomColumnId = 'number' | 'name' | 'quantity' | 'material' | 'mass';

/** 部品表の並べ替えの基準(§2.10)。 */
export type BomSortKey = 'number' | 'name' | 'quantity' | 'mass';

/**
 * 部品表の見せ方(FR-611)。**集計そのものは純関数 `buildBom` が行う**(§2.10、P7 タスク33)。
 * 表に出す内容(番号・数量・質量)は毎回数え直すので、この欄には持たない。
 */
export interface BomSettings {
  /** 出す列と、その並び順。既定は 5 列すべて(§0.a-0.38)。 */
  readonly columns: readonly BomColumnId[];
  /** 並べ替えの基準。既定は番号順。 */
  readonly sortBy: BomSortKey;
  /**
   * サブアセンブリ(FR-613)の中身も行にするか。**既定は偽(1 行として数える)**(§2.10)。
   */
  readonly expandSubAssemblies: boolean;
}

/**
 * アセンブリ文書(FR-601)。Undo のスナップショットの単位で、`.pcada` に保存される
 * 唯一のもの(FR-801、§0.a-0.1)。変更のたびに新しい配列を作る(不変)。
 *
 * `parameters` を部品文書と同じ型で持つのは、合致の距離・分解の距離・ジョイントの可動範囲も
 * 名前を付けた数値から書けるようにするためである(要件§3、§0.a-0.9)。
 * **部品の側のパラメータはここからは見えない**(部品を開いて直す)。
 */
export interface AssemblyDocument {
  readonly id: string;
  readonly name: string;
  /** 保存形式の版(§0.a-0.2)。部品と同じ系列にする(`ASSEMBLY_SCHEMA_VERSION`)。 */
  readonly schemaVersion: number;
  /** 置いた部品。並び順が部品表の番号と連結成分の順を決める(決定性。§2.5.3、§2.10)。 */
  readonly components: readonly AssemblyComponent[];
  /** 合致(FR-603、FR-609)。 */
  readonly mates: readonly Mate[];
  /** ジョイント(FR-618)。 */
  readonly joints: readonly Joint[];
  /** 分解図とアニメーションのステップ(FR-617、FR-618)。 */
  readonly presentation: readonly PresentationStep[];
  /** 名前を付けた数値の表(FR-207)。部品文書のものとは別物(§0.a-0.9)。 */
  readonly parameters: readonly Parameter[];
  /** 部品表の並びと列(FR-611)。 */
  readonly bom: BomSettings;
}
