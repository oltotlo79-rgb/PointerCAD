import type { MathEvaluation } from '@pointercad/expression/math/contracts';

/**
 * 数学の目録（パレット・検索・説明の対応表の元）の共通の型と欄。
 * 項目は分野別の3ファイル（mathPaletteBasic.ts・mathPaletteCalculus.ts・mathPaletteSetsLogic.ts）に置き、
 * mathPalette.ts がこの順に連結して下書き全体（MATH_PALETTE_DRAFT）にする。
 */

/** 数学の分野。パレットの「数学の分野」の絞込みに使う（表示名は math.json の math.category.*）。 */
export type MathPaletteGroup = 'basic' | 'functions' | 'calculus' | 'linear-algebra' | 'complex'
  | 'series' | 'statistics' | 'sets-logic' | 'equations' | 'symbols';

/**
 * 結果型。計算部の評価結果（MathEvaluation の値）の kind と同じ名前を使う。
 * 'candidates' だけは例外で、status:'value' ではなく status:'multiple'（±・∓ 等、符号ごとの候補を
 * 確定させない結果。mathInputContract.ts）を表す。実例の expected は数値でなく候補の一覧で書く（下記）。
 * 'antiderivative' も例外で、計算部が実際に返す kind は写像などと同じ'function'のまま変えない
 * （MC-20系）が、目録ではその中の不定積分の答え（積分定数Cを持つ原始関数の族。座標・成分・係数の
 * 数値にも関数作図にも使えない）だけを区別する表示用の種類として使う。実例の照合
 * （mathPaletteExamples.test.ts）は kind:'function' に加え、返った関数が元の積分自身の束縛変数への
 * lambdaであることまで確かめる。
 */
export type MathPaletteResultType = Extract<MathEvaluation, { readonly status: 'value' }>['kind'] | 'candidates' | 'antiderivative';

/**
 * 引数型。結果型の名前（前の演算の結果をそのまま渡す引数を含む）に、入力だけで使う種類を加える。
 * integer は整数、natural は0以上の整数、probability は0以上1以下の確率、angle は度・ラジアンの設定が掛かる角度、
 * expression は変数を含んでよい式、variable は変数名、variable-list は変数名の一覧、condition は等式・不等式などの条件、
 * equation-list は等式の一覧、list は値や条件の一覧（空でもよい）。tensor はベクトル・行列を含む配列、set は区間を含む。
 */
export type MathPaletteArgumentType = MathPaletteResultType
  | 'integer' | 'natural' | 'probability' | 'angle'
  | 'expression' | 'variable' | 'variable-list' | 'condition' | 'equation-list' | 'list';

/** 計算方式。native はこの場の計算（分数・40桁）、exact-runtime は追加計算部（記号計算）を読み込んで使う。 */
export type MathPaletteMethod = 'native' | 'exact-runtime';

/** 説明の節がある章（F1 で開く数学入力の説明）のトピックID。 */
export const MATH_PALETTE_HELP_TOPIC = 'math-input';

/** 目録の欄のうち、項目ごとに必ず指定するもの。欠落は型検査と mathPaletteExamples.test.ts が止める。 */
export interface MathPaletteFields {
  /** 実装が受け付ける定義域と上限。分野別の math.paletteDomain.* の文言。 */
  readonly domain: string;
  /** 引数型。ひな形に #0 があればその型を先頭に、続けて #? の出現順（実例の selection・slots と同じ並び）。 */
  readonly argumentTypes: readonly MathPaletteArgumentType[];
  /** 結果型。公開項目では、実例の実際の計算結果の種類と一致する。 */
  readonly resultType: MathPaletteResultType;
  /** 計算方式。公開項目では、実例の計算で追加計算部が使われたかどうかと一致する。 */
  readonly method: MathPaletteMethod;
  /**
   * 関数作図（曲線・曲面の式）で、X・Y・Z・T・U・Vを含む値を引数に入れて使えるか。
   * 引数の無い記号は、実数の定数として関数作図に使えるか。公開項目では実際の関数の翻訳と一致する。
   */
  readonly functionUse: boolean;
  /** 説明の節。MATH_PALETTE_HELP_TOPIC の章にある見出しの文言。 */
  readonly help: string;
}

/** パレットの表示・検索・挿入に使う欄（数式編集画面はこの欄だけを使う）。 */
export interface MathPaletteItem {
  readonly id: string;
  readonly group: MathPaletteGroup;
  readonly label: string;
  readonly symbol: string;
  readonly template: string;
  readonly keywords: readonly string[];
  readonly requiredOperations: readonly string[];
  readonly acceptanceIds: readonly string[];
  readonly meaning: string;
}

/** 目録の項目。表示に使う欄に、目録の欄（引数型・結果型・計算方式・関数作図での利用・説明の節）を加えたもの。 */
export interface MathPaletteCatalogItem extends MathPaletteItem, MathPaletteFields {}

/** 公開パレットの実例。selection は #0、slots は #? へ出現順に入れ、expected は実数の答え・結果の種類・宣言の未評価状態。 */
export interface MathPaletteExample {
  readonly id: string;
  readonly selection: string;
  readonly slots: readonly string[];
  readonly expected: number | Exclude<MathPaletteResultType, 'real' | 'candidates'> | 'unevaluated'
    /** status:'multiple' の候補一覧。順序どおり（rationalOfExpression で有理数へ変換して比較）。 */
    | { readonly candidates: readonly number[] };
  /** 追加計算部を使ってよい実例。実際に使ったかどうかは検査が記録し、目録の method と照合する。 */
  readonly exact?: boolean;
  /** 関数作図で展開する実例。成分は1からの番号、空ならスカラー自身を検査する。pointはXYZ順、媒介変数だけの曲線では先頭がその値。 */
  readonly functionContext?: {
    readonly axes: readonly ('X' | 'Y' | 'Z')[];
    readonly parameters: readonly ('T' | 'U' | 'V')[];
    readonly samples: readonly {
      readonly point: readonly [number, number, number];
      readonly components: readonly { readonly indices: readonly number[]; readonly value: number }[];
    }[];
  };
}

export function mathPaletteItem(id: string, group: MathPaletteGroup, label: string, symbol: string, template: string,
  operations: readonly string[], meaning: string, keywords: readonly string[], fields: MathPaletteFields): MathPaletteCatalogItem {
  // Empty acceptanceIds intentionally prevents a draft entry from claiming tested availability.
  return { id, group, label, symbol, template, requiredOperations: operations, acceptanceIds: [], meaning, keywords, ...fields };
}
