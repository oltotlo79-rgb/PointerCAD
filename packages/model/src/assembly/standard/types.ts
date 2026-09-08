/**
 * 規格部品カタログの保存版(P7 §2.8.1)。寸法表を直すときはこの版を増やし、
 * 既に保存された版の表を残す。古いアセンブリの形と質量を黙って変えないためである。
 */
export const STANDARD_CATALOG_REVISION = 'jis-2026-09-08-r1';

/** 寸法表から普通の PartDocument を組み立てる台本の版(P7 §2.8.1)。 */
export const STANDARD_PART_GENERATOR_REVISION = '1';

/** 公開資料との照合結果。false の行は画面で「要確認」と知らせる。 */
export interface StandardDimensionRow {
  /** 規格・版・呼びを含む、版内で不変の行の鍵。 */
  readonly key: string;
  /** 利用者が選ぶ呼び。 */
  readonly size: string;
  readonly verified: boolean;
  /** 未確認または欠測の理由。確認済みなら空文字。 */
  readonly note: string;
}

/** 寸法表に付ける出典。数値と同じ場所から輸出し、UI に複製しない。 */
export interface StandardTableSource {
  readonly standard: string;
  readonly edition: string;
  readonly title: string;
  readonly scope: string;
  readonly sourceUrls: readonly string[];
  /** 全行が確認済みのときだけ true。 */
  readonly verified: boolean;
}

/** 六角ボルト・ナットの寸法系列。利用者の選択を options に保存する。 */
export type FastenerDimensionSeries = 'annexJA' | 'main';

export interface HexBoltRow extends StandardDimensionRow {
  readonly dimensionSeries: FastenerDimensionSeries;
  readonly d: number;
  readonly pitch: number;
  readonly s: number;
  readonly k: number;
  readonly b1: number;
}

export interface HexNutRow extends StandardDimensionRow {
  readonly dimensionSeries: FastenerDimensionSeries;
  readonly d: number;
  readonly pitch: number;
  readonly s: number;
  /** JIS B 1181 は基準寸法を持たないため、形には上限値を使う。 */
  readonly mMax: number;
  /** 附属書 JA の公開表に下限値が無い行は null。 */
  readonly mMin: number | null;
}

export interface PlainWasherRow extends StandardDimensionRow {
  readonly d: number;
  readonly d1: number;
  readonly d2: number;
  readonly thickness: number;
}

export interface SpringWasherRow extends StandardDimensionRow {
  readonly d: number;
  readonly insideDiameter: number;
  readonly outsideDiameter: number;
  readonly width: number;
  readonly thickness: number;
}

export interface SocketHeadCapScrewRow extends StandardDimensionRow {
  readonly d: number;
  readonly pitch: number;
  readonly headDiameter: number;
  readonly headHeight: number;
  readonly socketWidth: number;
  readonly socketDepth: number | null;
  /** 欠測や現行規格外の行は false。選択肢には出さない。 */
  readonly available: boolean;
}

export interface PanHeadScrewRow extends StandardDimensionRow {
  readonly d: number;
  readonly pitch: number;
  readonly headDiameter: number;
  readonly headHeight: number;
  readonly recessNumber: number;
}

export type BearingSeries = '6000' | '6200' | '6300';

export interface DeepGrooveBallBearingRow extends StandardDimensionRow {
  readonly series: BearingSeries;
  readonly boreDiameter: number;
  readonly outsideDiameter: number;
  readonly width: number;
  readonly minimumChamfer: number;
}

export interface EqualAngleRow extends StandardDimensionRow {
  readonly a: number;
  readonly b: number;
  readonly thickness: number;
  readonly innerRadius: number;
  readonly tipRadius: number;
  readonly areaCm2: number;
  readonly massKgPerM: number;
}

export interface ChannelRow extends StandardDimensionRow {
  readonly height: number;
  readonly width: number;
  readonly webThickness: number;
  readonly flangeThickness: number;
  readonly innerRadius: number;
  readonly tipRadius: number;
  readonly areaCm2: number;
  readonly massKgPerM: number;
}

export interface HBeamRow extends StandardDimensionRow {
  readonly height: number;
  readonly width: number;
  readonly webThickness: number;
  readonly flangeThickness: number;
  readonly innerRadius: number;
  readonly areaCm2: number;
  readonly massKgPerM: number;
}

export type SectionRow = EqualAngleRow | ChannelRow | HBeamRow;
