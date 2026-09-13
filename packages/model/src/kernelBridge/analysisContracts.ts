/** analysis data exchanged through the model's kernel bridge. Types only; no Worker lifetime. */
import type {
  RigidPlacement,
} from '../assembly/placementMath.js';
import type {
  ExportMeshQuality,
} from '../exchange/types.js';
import type {
  SubShapeRef,
} from '../geometry/subShapeRef.js';
import type {
  Vec3,
} from '../sketch/vec3.js';
import type {
  PartCancelToken,
} from './solidContracts.js';


/* ------------------------------------------------------------------ *
 * 測定(FR-1101、FR-1102、P5 タスク29)
 * ------------------------------------------------------------------ */

/**
 * 測る対象 1 つ(model の言葉)。
 *
 * 立体は「それを作ったフィーチャーの id」で指す(§0.a-0.5「段の id = ボディの id」)。
 * kernel は形状キャッシュの鍵(`ResolvedSolidStep.key`)でしか形を引けないので、
 * `KernelBridge.measure` がこの id を鍵へ引き直してからカーネルへ渡す(外観の面の照合
 * `toAppearanceQueries` と同じ流儀、§2.2.3)。
 */
export interface MeasureTarget {
  readonly bodyFeatureId: string;
  /**
   * アセンブリのように同じ feature id を複数部品が持ちうる場合の明示的な段の鍵。
   * 省略時は従来どおり `steps` から feature id で引く。
   */
  readonly bodyKey?: string;
  /** 面・辺・頂点の指紋。ボディ全体を測るなら null。 */
  readonly subShape: SubShapeRef | null;
  /** 表示中のアセンブリ配置。省略時は部品内の局所座標のまま測る。 */
  readonly placement?: RigidPlacement;
}

/**
 * 測定の結果(FR-1101、FR-1102)。kernel の `MeasureResult` を model の言葉へ詰め替えたもの
 * (kind ごとの欄はそのまま持ち回る)。
 *
 * **距離・重心はワールド座標の mm。慣性モーメント(`principalMoments`)は重心を通る主軸
 * まわりの体積の 2 次モーメントで、密度を掛けていない mm⁵のまま**(§0.a-0.32)。
 * 密度(g/cm³)を掛けた質量(g)・慣性モーメント(g·mm²)は、密度表を持つ model 側の
 * `measure/massProperties.ts`(`massFromVolume` / `inertiaWithDensity`)が別途計算する
 * (統括の決定: 密度の掛け算は model のこの 1 か所だけで行う)。
 */
export type MeasureOutcome =
  | {
      readonly kind: 'distance';
      /** 最短距離(mm)。交わっているときは 0。 */
      readonly distance: number;
      /** 1 つ目の対象の上の最近点(mm)。 */
      readonly pointA: Vec3;
      /** 2 つ目の対象の上の最近点(mm)。 */
      readonly pointB: Vec3;
      /** 一方が他方の内側にある(交わっている)か。 */
      readonly inner: boolean;
    }
  | {
      readonly kind: 'massProperties';
      /** 体積(mm³)。 */
      readonly volume: number;
      /** 表面積(mm²)。 */
      readonly area: number;
      /** 重心(mm)。 */
      readonly centreOfMass: Vec3;
      /** 重心を通る主軸まわりの体積の 2 次モーメント(mm⁵、密度を掛けていない)。 */
      readonly principalMoments: readonly [number, number, number];
      /** 主軸の向き(長さ 1)。第 1・第 2・第 3 の順。 */
      readonly principalAxes: readonly [Vec3, Vec3, Vec3];
    }
  /** 測れなかった。message はそのまま画面に出す日本語(FR-504。kernel の文言を持ち回る)。 */
  | { readonly kind: 'failed'; readonly message: string };

/** 点検のどの段を計算しているか(NFR-PF-4 の進み具合)。重いのは肉厚の段だけ。 */
export type PrintabilityPhase = 'watertight' | 'overhang' | 'thickness';

/** 点検の進み具合(NFR-PF-4)。kernel の `PrintabilityProgress` を model の言葉へ写したもの。 */
export interface PrintabilityProgressView {
  readonly phase: PrintabilityPhase;
  /** その段で見終わった三角形の枚数。 */
  readonly processed: number;
  /** 三角形の総数。 */
  readonly total: number;
  /** 全体でどこまで進んだか(0〜1)。 */
  readonly ratio: number;
}

/** 点検の進み具合を受け取る口(`PartProgressCallback` と同じ流儀)。 */
export type PrintabilityProgressCallback = (progress: PrintabilityProgressView) => void;

/**
 * 点検の要約(数と真偽だけ。画面の文言は ui が作る)。
 *
 * **欄の名前も型もカーネルの `PrintabilitySummary` にそろえてある**ので、詰め替えは
 * 欄を写すだけで済む(`toPrintabilityOutcome`)。名前をそろえるのは、点検の意味を決めて
 * いるのがカーネル側の 1 か所(`occt/inspectPrintability.ts`)だからで、model が別の
 * 言い換えを作ると、しきい値の意味が 2 通りに割れる。
 */
export interface PrintabilitySummary {
  /** 点検した三角形の総数(面積 0 のものを含む)。 */
  readonly triangleCount: number;
  /** 面積 0(または座標が `NaN`)で点検から外した三角形の枚数。 */
  readonly degenerateCount: number;
  /** 肉厚の段で見終わった三角形の枚数。途中でやめると総数より少なくなる。 */
  readonly inspectedTriangleCount: number;
  /** しきい値より薄かった三角形の枚数。 */
  readonly thinCount: number;
  /** 支持が要る(せり出している)三角形の枚数。 */
  readonly overhangCount: number;
  /** ちょうど 2 枚に共有されていない辺の本数。 */
  readonly openEdgeCount: number;
  /** そういう辺を 1 本でも持つ三角形の枚数。 */
  readonly openEdgeTriangleCount: number;
  /** 閉じた形か(開いた辺が 1 本も無いか)。 */
  readonly watertight: boolean;
  /** 測れた肉厚のうち最も薄い値(mm)。1 本も反対側に当たらなければ `null`。 */
  readonly minThicknessFoundMm: number | null;
  /** 判定に使った最小肉厚のしきい値(mm)。 */
  readonly minThicknessMm: number;
  /** 判定に使ったせり出しの角度(度)。 */
  readonly overhangAngleDeg: number;
  /** 肉厚の判定に使った升目の大きさ(mm)。形が大きいと既定より粗くなる。 */
  readonly cellSizeMm: number;
}

/**
 * 点検の結果(FR-815)。
 *
 * 三角形ごとの真偽は**1 ビットずつ詰めてある**(5 万三角形で 1 本 6,250 バイト、
 * 3 本で 18.3KiB。§2.17-9)。読み出しは `readPrintabilityFlag`——**同じビットの並べ方を
 * 2 か所に書かない**ため、model はカーネルの純関数をそのまま輸出し直す
 * (`sketchFilletGeometry` と同じ扱い)。
 */
export interface PrintabilityReport {
  /** 三角形の総数(ビット列の長さの根拠)。 */
  readonly triangleCount: number;
  /** しきい値より薄い三角形。 */
  readonly thinTriangles: Uint8Array;
  /** 支持が要る三角形。 */
  readonly overhangTriangles: Uint8Array;
  /** 開いた辺を持つ三角形。 */
  readonly openEdgeTriangles: Uint8Array;
  /**
   * 点検に実際に使った表示メッシュ。複数ボディでは依頼と同じ順。
   *
   * 任意なのは、既存文書の保存値ではなく実行中だけの結果であり、古い偽物の橋とも
   * 構造互換を保つため。実カーネルの `KernelApi.inspectPrintability` は必ず入れる。
   */
  readonly meshes?: readonly PrintabilityMeshIdentity[];
  readonly summary: PrintabilitySummary;
  /** 途中でやめたか。**やめても結果は返る**(肉厚だけが測ったところまでになる)。 */
  readonly cancelled: boolean;
}

/** 点検した表示メッシュ 1 つの同一性。 */
export interface PrintabilityMeshIdentity {
  readonly bodyKey: string;
  readonly meshRevision: number;
  readonly triangleCount: number;
}

/**
 * 点検の結果。**断りは投げずに `kind: 'failed'` で返す**(測定・書き出しと同じ流儀、
 * FR-504、NFR-RE-1)。理由の日本語はカーネルが持っているものをそのまま持ち回る。
 */
export type PrintabilityOutcome =
  | { readonly kind: 'inspected'; readonly report: PrintabilityReport }
  | { readonly kind: 'failed'; readonly message: string };

/** 点検の依頼(model の言葉)。 */
export interface PrintabilityOptions {
  readonly partId?: string;
  /**
   * 点検する立体を作ったフィーチャーの id。**並びがそのまま結果の三角形の並びになる**
   * (2 つ以上を指すと、カーネルは三角形を 1 つに連ねてから測る)。空なら断る。
   */
  readonly bodies: readonly string[];
  /**
   * 従来の依頼との互換のための欄。点検は実際の表示メッシュを使うので、現在は値に
   * かかわらず同じ三角形を点検する。精密な別メッシュの点検は結果メッシュ自体を表示する
   * 別機能として扱う。
   */
  readonly meshQuality?: ExportMeshQuality | null;
  /** 最小肉厚のしきい値(mm)。省くとカーネルの既定(0.8mm)。 */
  readonly minThicknessMm?: number;
  /** せり出しの角度のしきい値(度)。省くとカーネルの既定(45°)。 */
  readonly overhangAngleDeg?: number;
  readonly onProgress?: PrintabilityProgressCallback;
  readonly shouldCancel?: PartCancelToken;
}
