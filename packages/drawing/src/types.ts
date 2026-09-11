import type { TitleBlockFieldDefinition } from './paper/titleBlock.js';
import type { DrawingViewConstruction } from './view/construction.js';
import type { DatumDefinition, GeometricToleranceFrame } from './gdt/types.js';
import type { WeldSymbol } from './welding/types.js';

/** 図面の用紙座標(mm)。左下が原点で、上が +v(FR-701、§0.58)。 */
export type Point2 = readonly [number, number];

/** 図面が参照するモデルの Z-up 座標または方向。 */
export type Vector3 = readonly [number, number, number];

/** 図面で使える線種(FR-707、FR-730)。 */
export type DrawingLineType = 'solid' | 'dashed' | 'chain' | 'chain2' | 'zigzag';

/** レイヤーの値を部分的に上書きする要素ごとのスタイル(FR-730)。 */
export interface DrawingElementStyle {
  readonly color?: string;
  readonly lineType?: DrawingLineType;
  readonly lineWidth?: number;
}

/** 式を文字列のまま保存するための、model の ExpressionValue と同じ構造(FR-207)。 */
export interface DrawingExpressionValue {
  readonly source: string;
  readonly value: number;
  readonly display: string;
}

/** 図面のパラメータ表の行(FR-207)。drawing を依存の葉に保つため構造をここで定義する。 */
export interface DrawingParameter {
  readonly name: string;
  readonly value: DrawingExpressionValue;
  readonly unit: 'mm' | 'degree' | 'none';
  readonly description: string;
}

/** 部分形状を再計算後に選び直すための保存済み指紋(FR-710)。 */
export type DrawingSubShapeFingerprint =
  | {
      readonly kind: 'face';
      readonly surfaceKind: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';
      readonly area: number;
      readonly position: Vector3;
      readonly axis: Vector3 | null;
      readonly radius: number | null;
    }
  | {
      readonly kind: 'edge';
      readonly curveKind: 'line' | 'circle' | 'ellipse' | 'other';
      readonly length: number;
      readonly position: Vector3;
      readonly axis: Vector3 | null;
      readonly radius: number | null;
    }
  | { readonly kind: 'vertex'; readonly position: Vector3 };

/** 部品またはアセンブリの部分形状への参照(FR-706、FR-710)。 */
export interface DrawingSubShapeRef {
  readonly bodyFeatureId: string;
  readonly index: number;
  readonly fingerprint: DrawingSubShapeFingerprint;
}

/** P10: 抱き込んだ元部品から展開を導出する入力。 */
export interface DrawingSheetFlatReference {
  readonly partId: string;
  readonly sourceFeatureId: string;
  readonly fixedPanelId: string;
  readonly seamConnectionIds: readonly string[];
}

/** 図面 ZIP に抱き込んだ参照元の素性(要件§8、§0.3)。 */
export interface DrawingSource {
  readonly sourceRef: string;
  readonly sourceKind: 'part' | 'assembly';
  /** partだけに指定できる。省略時は従来の折曲げ形状。 */
  readonly flatSheet?: DrawingSheetFlatReference;
  readonly fileName: string;
  readonly path: string;
  readonly contentHash: string;
  readonly importedAt: string;
}

/** 枠を表示するかという利用者の指定。線そのものは開くたびに作る(FR-725)。 */
export interface DrawingFrameSettings {
  readonly visible: boolean;
}

/** 表題欄へ保存する利用者入力。罫線と配置は導出する(FR-701、FR-725)。 */
export interface DrawingTitleBlock {
  readonly title: string;
  readonly drawingNumber: string;
  readonly revision: string;
  readonly author: string;
  readonly date: string;
  readonly material: string;
}

/** 用紙、縮尺、投影法の指定(FR-701、FR-703、FR-723、FR-725)。 */
export interface DrawingSheet {
  readonly paperSizeId: string;
  readonly orientation: 'landscape' | 'portrait';
  readonly scale: number;
  readonly projectionMethod: 'third';
  readonly frame: DrawingFrameSettings;
  readonly titleBlock: DrawingTitleBlock;
  readonly generalTolerance?: string;
  /** 表題欄の項目・並び・固定文字(FR-725)。省略時は既定の項目。 */
  readonly titleBlockFields?: readonly TitleBlockFieldDefinition[];
  /** 新規注記と表題欄の文字高さ(mm)。既存の個別指定はそのまま使う。 */
  readonly textHeight?: number;
  /** 縮尺の候補。値自体はscaleに持つ。 */
  readonly scaleOptions?: readonly number[];
}

/** P8 で扱う投影図の種類(FR-702、FR-704、FR-713〜715)。 */
export type DrawingViewKind =
  | 'front'
  | 'top'
  | 'right'
  | 'left'
  | 'rear'
  | 'bottom'
  | 'isometric'
  | 'section'
  | 'detail'
  | 'auxiliary'
  | 'partial'
  | 'broken';

/** 用紙上の投影図。投影線は保存せず、この指定から作り直す(FR-702)。 */
export interface DrawingView {
  readonly id: string;
  readonly name: string;
  readonly kind: DrawingViewKind;
  readonly position: Point2;
  /** null は図面全体の縮尺を継ぐ(FR-704)。 */
  readonly scale: number | null;
  readonly direction: Vector3;
  readonly xDir: Vector3;
  readonly showHidden: boolean;
  readonly showCenterLines: boolean;
  /** 元形状の安定ID。中心線を消した操作を再投影・保存後も保持する(FR-708)。 */
  readonly hiddenCenterMarkIds?: readonly string[];
  readonly construction?: DrawingViewConstruction;
  readonly section?: {
    readonly cuttingLineId: string;
    readonly direction: 'forward' | 'backward';
    readonly label: string;
  };
  readonly detail?: { readonly center: Point2; readonly radius: number; readonly scale: number };
  readonly breakOut?: { readonly boundary: readonly Point2[]; readonly depth: number };
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}

/** 注記と引出線注記(FR-711、FR-721、FR-723)。 */
export interface Annotation {
  readonly id: string;
  readonly kind: 'note' | 'leaderNote' | 'surfaceFinish' | 'generalTolerance';
  readonly text: string;
  readonly position: Point2;
  readonly leader?: readonly Point2[];
  readonly leaderEnd?: 'arrow' | 'dot';
  readonly target?: DrawingSubShapeRef;
  /** 新しい注記は図・元文書・部品まで含む参照を保持する。targetは旧保存形との互換用。 */
  readonly sourceTarget?: DimensionTarget;
  readonly surfaceFinish?: {
    readonly process: 'basic' | 'removal' | 'noRemoval';
    readonly parameter: 'Ra' | 'Rz';
    readonly value: DrawingExpressionValue;
  };
  /** ねじ等の表示文字は元部品から作る。注記へ複製して保存しない。 */
  readonly machiningFeatureId?: string;
  readonly height: number;
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}

/** 部品表・穴表・改訂欄の保存形(FR-728、FR-729)。 */
export interface DrawingTable {
  readonly id: string;
  readonly kind: 'bom' | 'hole' | 'revision';
  readonly position: Point2;
  readonly columns: readonly string[];
  readonly rows?: readonly (readonly string[])[];
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}

/** 組図の部品番号と引出線(FR-726、FR-728)。 */
export interface Balloon {
  readonly sourceTarget?: DimensionTarget;
  readonly targetKind?: 'face' | 'edge';
  readonly id: string;
  readonly itemNumber: number;
  readonly componentIds: readonly string[];
  readonly position: Point2;
  readonly leader: readonly Point2[];
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}

/** 図面要素が継ぐ表示・印刷スタイル(FR-730)。 */
export interface DrawingLayer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly printable: boolean;
  readonly color: string;
  readonly lineType: DrawingLineType;
  readonly lineWidth: number;
}

import type { Dimension, DimensionTarget } from './dimension/types.js';

/** `.pcadd` の document.json に保存する図面文書。id を除く内容の欄は11個(§2.3)。 */
export interface DrawingDocument {
  readonly id: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly source: DrawingSource;
  readonly sheet: DrawingSheet;
  readonly views: readonly DrawingView[];
  readonly dimensions: readonly Dimension[];
  readonly annotations: readonly Annotation[];
  readonly tables: readonly DrawingTable[];
  readonly balloons: readonly Balloon[];
  readonly datums: readonly DatumDefinition[];
  readonly gdtFrames: readonly GeometricToleranceFrame[];
  readonly weldSymbols: readonly WeldSymbol[];
  readonly layers: readonly DrawingLayer[];
  readonly parameters: readonly DrawingParameter[];
}
