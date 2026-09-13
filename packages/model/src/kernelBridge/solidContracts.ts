/** solid data exchanged through the model's kernel bridge. Types only; no Worker lifetime. */
import type {
  SubShapeFingerprint,
  SubShapeRef,
} from '../geometry/subShapeRef.js';
import type {
  EdgeCurveKind,
  FaceSurfaceKind,
} from '../part/types.js';
import type {
  Vec3,
} from '../sketch/vec3.js';
import type {
  SolidBodyMeshData,
} from './sketchContracts.js';


/**
 * 面 1 枚の素性(計画書 P3 §2.2、§2.8)。部分形状の当たり判定・強調・指紋の材料になる。
 * kernel の `SolidFaceInfo` と同じ形だが、model は kernel の型を再輸出しないので
 * この場に自分の型として持つ(P0 §0.11)。
 */
export interface SolidFaceEntry {
  /** `TopExp.MapShapes_2` の順で数えた 0 始まりの通し番号。 */
  readonly index: number;
  readonly surfaceKind: FaceSurfaceKind;
  /** 面積(mm²)。 */
  readonly area: number;
  /** 重心(mm)。 */
  readonly centroid: Vec3;
  /** 平面は法線、円柱・円錐は軸。求まらなければ null。 */
  readonly axis: Vec3 | null;
  /** 円筒・円錐の解析軸上点または球の解析中心(mm、部品座標)。面積重心とは別物。旧fixtureでは省略可。 */
  readonly axisOrigin?: Vec3 | null;
  /** 円柱・円錐・球の半径(mm)。平面では null。 */
  readonly radius: number | null;
  /** この面の三角形が mesh.indices の何番目から何枚あるか。 */
  readonly triangleOffset: number;
  readonly triangleCount: number;
}

/** 辺 1 本の素性。並びは面と同じく通し番号の順(計画書 P3 §2.2、§2.8)。 */
export interface SolidEdgeEntry {
  readonly index: number;
  readonly curveKind: EdgeCurveKind;
  /** 長さ(mm)。 */
  readonly length: number;
  /** 中点(mm)。 */
  readonly midpoint: Vec3;
  readonly start: Vec3;
  readonly end: Vec3;
  /** 直線は向き、円は軸。求まらなければ null。 */
  readonly axis: Vec3 | null;
  /** 円の解析中心(mm、部品座標)。円弧の重心とは別物。旧fixtureでは省略可。 */
  readonly axisOrigin?: Vec3 | null;
  /** 円の半径(mm)。それ以外は null。 */
  readonly radius: number | null;
  /** この辺の線分が mesh.edgePositions の何番目から何本あるか。 */
  readonly segmentOffset: number;
  readonly segmentCount: number;
}

/** 頂点 1 つの素性。位置しか持たない(計画書 P3 §2.2、§2.8)。 */
export interface SolidVertexEntry {
  readonly index: number;
  readonly position: Vec3;
}

/**
 * ねじの簡略表示の印(§0.a-0.15)。B-rep には現れない、描画だけのための情報。
 * 下穴は実際に掘るが、ねじ山は形を作らずに細い円と軸線で表すので、再計算の費用がかからない。
 */
export interface ThreadMarkEntry {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly majorDiameter: number;
  readonly length: number;
}

/**
 * 形の種類(FR-428、P5 §0.a-0.45。P6 §0.a-0.24 で `'mesh'` が加わった)。閉じた立体を含む形は
 * `'solid'`、面だけのボディ(押し出し面・回転面など)は `'shell'`、**読み込んだ三角形の形**
 * (STL / OBJ / glTF / 3MF のベースボディ、FR-802、P6 §2.8)は `'mesh'`。
 *
 * 閉じた立体と開いた面が混在するボディは `'mixed'`。開いた面は体積に含めない。
 * kernel にも同じ名前・同じ4値の型があるが、**kernel の型は再輸出しない**約束
 * (このファイルの冒頭、P0 §0.11)なので model 側で同じ並びを持つ(P6 タスク10 が
 * kernel 側を広げ、タスク20 の前借りとして model 側もここで追随した)。P5 タスク3 の
 * 時点ではどの段も閉じた立体しか作らないので必ず `'solid'` で、`'shell'` が実際に来るのは
 * 曲面の段が入るタスク41 から、`'mesh'` が来るのは読み込んだ形のベースボディ
 * (`importedMesh` のフィーチャー)が入る P6 タスク20 から。
 */
export type SolidBodyKind = 'solid' | 'shell' | 'mesh' | 'mixed';

/**
 * 外観を割り当てた面 1 つぶんの照合の依頼(FR-1106、P5 §2.2.3、§0.a-0.2)。
 *
 * 文書は面を指紋(`SubShapeRef`)で覚えているだけなので、形を作り直すと面の通し番号が
 * ずれる。**選び直しの採点はカーネルにしか無い**(`matchSubShape.ts`。重みとしきい値を
 * model へ複製しない、§0.a-0.2)ので、再計算のたびにこの依頼をカーネルへ添えて
 * 選び直してもらう。`bodyFeatureId` はその面を持つボディを作ったフィーチャーの id で、
 * 橋がそれを段の鍵(`ResolvedSolidStep.key`)へ引き直してからカーネルへ渡す。
 */
export interface AppearanceFaceRequest {
  /** 割り当て 1 つの id(`AppearanceEntry.id`)。結果との対応づけだけに使う。 */
  readonly id: string;
  readonly bodyFeatureId: string;
  readonly ref: SubShapeRef;
}

/**
 * 外観の面の照合の結果 1 件(FR-1106)。**依頼と同じ並び・同じ件数で返る**
 * (1 件も落とさない)。
 *
 * `faceIndex` が `null` なら「選び直せなかった」で、呼び出し側(ui)は警告を出して
 * その面を既定の外観で描く(FR-1106「選び直せなかった割り当ては警告し、既定の外観に
 * 戻す」)。**割り当て自体は文書から消さない**ので、利用者が形を元に戻せば復活する。
 */
export interface AppearanceMatchEntry {
  readonly id: string;
  readonly bodyFeatureId: string;
  readonly faceIndex: number | null;
}

/** 画面に出るボディ 1 つ。id はそれを作ったフィーチャーの id と同じ(§0.a-0.5)。 */
export interface SolidBody {
  readonly featureId: string;
  readonly mesh: SolidBodyMeshData;
  /** 体積(mm³)。プロパティ欄に出す(FR-501)。 */
  readonly volume: number;
  /**
   * 表面積(mm²)。測定(FR-1102)と曲面(FR-428)で使う。
   *
   * **任意の欄にしてあるのは、`SolidBody` を組み立てている見本(`packages/ui` の
   * ビューポートとストアの検査、`part/subShapeCache.test.ts`)を直せるのが、
   * それぞれのパッケージを受け持つ後続のタスク(ui のタスク10・11)だからである。**
   * ここを必須にすると、P5 タスク4 の担当が触れない範囲の型検査が落ちる。
   * カーネルから来た値はそのまま写し、**カーネルが返さなかったときは欄ごと省く**
   * (0 と偽らない)。kernel 側で必須へ引き上げる話は kernel の後続タスクが持つ。
   */
  readonly area?: number;
  /**
   * 形の種類(FR-428)。**model の型ではまだ任意**にしてあるが、任意にしてある理由は
   * `area` と同じ(`SolidBody` を組み立てている ui の見本を直せるのが ui のタスク)。
   * **詰め替えでは必ず値を入れる**——カーネル側は §0.a-0.77(タスク42b)で必須の欄に
   * なったので、`toSolidBody` は既定へ落とさずカーネルの値をそのまま写す。
   * 実際の再計算の結果でこの欄が空になることは無い。
   */
  readonly bodyKind?: SolidBodyKind;
  /**
   * 描画可能なCAD形状か。三角形があり、閉じた立体は正の体積を持つ。開面に正の体積は要求しない。
   *
   * カーネルは立体になっていない形(体積 0、B-rep として壊れている形)を作った時点で
   * 断って failures へ回すので、いまここへ来るボディは必ず true になる。それでも欄を持つのは、
   * 表示側が「形は返ったが中身が無い」を毎回自分で確かめずに済ませるため(FR-504、NFR-RE-1)。
   */
  readonly isValid: boolean;
  /**
   * 部分形状(面・辺・頂点)の一覧(計画書 P3 §2.2、§2.8、タスク10・17)。並びは通し番号の順で、
   * `faces.length` / `edges.length` は必ずカーネルの `faceCount` / `edgeCount` と一致する
   * (kernel 側の buildSolidBodyMesh・subShapes.ts が保証し、本ファイルの検査で固定する)。
   * 加工フィーチャー(穴・面取り等)が保存する `SubShapeRef` の指紋は、この一覧から作る。
   */
  readonly faces: readonly SolidFaceEntry[];
  readonly edges: readonly SolidEdgeEntry[];
  readonly vertices: readonly SolidVertexEntry[];
  /** ねじの簡略表示の印(§0.a-0.15)。無ければ空配列。 */
  readonly threadMarks: readonly ThreadMarkEntry[];
}

/** 立体を 1 つ作れなかった理由。カーネルが日本語で返したものをそのまま持ち回る(FR-504)。 */
export interface SolidBodyFailure {
  /** 作れなかったフィーチャーの id。 */
  readonly featureId: string;
  readonly message: string;
}

/** 立体の再計算の結果。1 段失敗しても止めずに残りを返す(FR-504、NFR-RE-1)。 */
export interface SolidRecomputeOutcome {
  readonly bodies: readonly SolidBody[];
  readonly failures: readonly SolidBodyFailure[];
  /** 作り直さずに済んだ段の数(NFR-PF-3 の効き目の実測値)。 */
  readonly cacheHits: number;
  /** 段と段の間で打ち切られたか(NFR-PF-4)。 */
  readonly cancelled: boolean;
  /**
   * 外観の面の照合の結果(FR-1106)。`SolidRecomputeOptions.appearance` と
   * 同じ並び・同じ件数で返り、頼まなければ空配列。
   *
   * 任意の欄にしてあるのは `SolidBody.area` と同じ理由(この型を組み立てている見本を
   * 直せるのが別のタスクの担当だから)で、詰め替えでは必ず値を入れる。
   */
  readonly appearanceMatches?: readonly AppearanceMatchEntry[];
}

/** 計算の進み具合(NFR-PF-4)。kernel の SolidProgress を model の言葉へ写したもの。 */
export interface PartProgress {
  /** これから計算する段のフィーチャー id。 */
  readonly featureId: string;
  /** これから計算する段の位置。0 から始まる。画面には index + 1 を出す。 */
  readonly index: number;
  /** 段の総数。 */
  readonly total: number;
  /** 画面に出す段の名前。 */
  readonly label: string;
}

/** 段を始める前に 1 回ずつ呼ばれる(NFR-PF-4)。 */
export type PartProgressCallback = (progress: PartProgress) => void;

/**
 * 中止を尋ねる口。true を返すと、段と段の間で残りを打ち切る(NFR-PF-4)。
 * 1 段の演算そのものは途中で止められない(§2.6 の限界)。
 */
export type PartCancelToken = () => boolean;

/** 立体の再計算に添える設定。どれも省略できる。 */
export interface SolidRecomputeOptions {
  /** 文書/session 内で安定した部品の識別子。省略時は part:current。 */
  readonly partId?: string;
  /**
   * 世代番号。呼び出しごとに 1 つ増やし、古い応答を捨てる目印にする
   * (P1 の attachSketchRecompute と同じ発想)。
   */
  readonly generation?: number;
  readonly onProgress?: PartProgressCallback;
  readonly shouldCancel?: PartCancelToken;
  /**
   * 外観を割り当てた面(FR-1106、§2.2.3)。**省略か空なら照合を一切頼まない。**
   * 照合の物差し(境界箱の対角長)を測るのにもカーネルは OCCT を呼ぶので、外観を
   * 1 つも割り当てていない文書では費用をゼロにする(§0.a-0.54)。
   */
  readonly appearance?: readonly AppearanceFaceRequest[];
  /**
   * ボディの表面積(`SolidBody.area`)を測るか(FR-1102、統括の決定 2026-09-05 07:28)。
   *
   * **既定は測らない。** 表面積は測定・質量特性(タスク29 以降)が求めたときだけ要る値で、
   * 測る費用(カーネルの実測で面 26 枚の板に 11.4ms)を毎回の再計算で払わないため。
   * **外観の面の照合はこの値を使わない**(照合が見るのは面ごとの面積で、それは
   * 面の一覧に元から入っている)ので、`appearance` を渡してもここは真にならない。
   */
  readonly measureAreas?: boolean;
}

/**
 * 再計算で得た合致用の幾何。保存する指紋に解析軸上点を添えた実行時だけの値。
 * SubShapeRef・schema・鍵には足さず、古い文書も現在の面・辺から解析点を取り直す。
 */
export type MateSubShapeGeometry = SubShapeFingerprint & { readonly axisOrigin?: Vec3 };
