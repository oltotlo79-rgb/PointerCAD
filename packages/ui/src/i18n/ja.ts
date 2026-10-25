/**
 * 画面に出す日本語の文言(NFR-MA-5)。
 *
 * **表は機能ごとの JSON に分けてある**(P6 タスク52)。1 本の大きな表を複数の担当で
 * 取り合うと、末尾へ足すだけの追記どうしでも衝突するため。**鍵も文言も分ける前から
 * 1 つも変えていない。** 足すときはこのファイルではなく、その機能の JSON へ書く。
 *
 * 分けた JSON のあいだで鍵が重なると、後から重ねたほうが黙って勝ってしまう。
 * それを落とすのが `jaMessages.test.ts` の「鍵が重なっていない」1 件。
 */
import numericInput from './ja/numericInput.json';
import propertyPanel from './ja/propertyPanel.json';
import toolbar from './ja/toolbar.json';
import statusBar from './ja/statusBar.json';
import sketch from './ja/sketch.json';
import solid from './ja/solid.json';
import file from './ja/file.json';
import view from './ja/view.json';
import parameters from './ja/parameters.json';
import assembly from './ja/assembly.json';
import drawing from './ja/drawing.json';
import help from './ja/help.json';
import sheetMetal from './ja/sheetMetal.json';
import strength from './ja/strength.json';
import beam from './ja/beam.json';
import plasticBar from './ja/plasticBar.json';
import fatigue from './ja/fatigue.json';
import fatigueStrain from './ja/fatigueStrain.json';
import fatigueLocalCycle from './ja/fatigueLocalCycle.json';
import solidAnalysis from './ja/solidAnalysis.json';
import solidPlastic from './ja/solidPlastic.json';
import script from './ja/script.json';
import math from './ja/math.json';
import mathGeometry from './ja/mathGeometry.json';
import mathPaletteBasic from './ja/mathPaletteBasic.json';
import mathPaletteCalculus from './ja/mathPaletteCalculus.json';
import mathPaletteSetsLogic from './ja/mathPaletteSetsLogic.json';
import commands from './ja/commands.json';

const steelBend = {
  'assembly.steel.bend.enable': '曲げ部品を作る',
  'assembly.steel.bend.enableGuide': '選択した鋼材断面から新しい曲げ部品を作り、位置を指定して配置します。',
  'assembly.steel.bend.radius': '曲げ半径 R (mm)',
  'assembly.steel.bend.angle': '曲げ角度 (度)',
  'assembly.steel.bend.direction': '断面に対する曲げ方向 (度)',
  'assembly.steel.bend.directionGuide': '開始接線は+Zです。断面を固定し、0度は+X、90度は+Y、180度は−X、270度は−Yへ曲げます。平鋼は0度が幅方向、90度が厚さ方向です。',
  'assembly.steel.bend.invalidDirection': '曲げ方向に有限の角度を入力してください。',
  'assembly.steel.bend.firstLeg': '第1脚の寸法 (mm)',
  'assembly.steel.bend.secondLeg': '第2脚の寸法 (mm)',
  'assembly.steel.bend.expressionGuide': '数値または式を入力してください。',
  'assembly.steel.bend.radiusConvention': '半径の基準',
  'assembly.steel.bend.legConvention': '脚寸法の基準',
  'assembly.steel.bend.inside': '内側',
  'assembly.steel.bend.outside': '外側',
  'assembly.steel.bend.tangent': '接線の直線部分',
  'assembly.steel.bend.requiredLength': '幾何学上の必要素材長: {length} mm',
  'assembly.steel.bend.allowance': '断面の面積重心経路による長さです。製造用の曲げ代・中立軸・スプリングバックを指定するものではありません。既存の購入材は変更せず、この長さの新規部品を作ります。',
  'assembly.steel.bend.place': '曲げ部品の配置へ',
  'assembly.steel.bend.unavailable': '現在は配置を開始できません。実行中の操作を終了してください。',
  'assembly.steel.bend.invalidExpression': '半径・角度・脚寸法に有効な数値または式を入力してください。',
  'assembly.steel.bend.invalidRadius': '半径の基準と、正の内側半径を確認してください。',
  'assembly.steel.bend.invalidAngle': '曲げ角度は0度より大きく180度より小さくしてください。',
  'assembly.steel.bend.invalidLength': '両脚の寸法に有限の正の値を入力してください。',
  'assembly.steel.bend.invalidSection': 'この断面は曲げ部品に対応していません。',
  'assembly.steel.bend.insufficientLegLength': '指定した半径と角度では脚の直線部分が残りません。脚寸法を増やしてください。',
  'assembly.steel.bend.radiusTooTight': '断面に対して曲げ半径が小さすぎます。半径を増やしてください。',
  'assembly.steel.bend.unsupportedSource': 'この鋼材の出自または生成版は曲げに対応していません。',
  'assembly.steel.bend.invalidStockLength': '幾何学上の必要素材長が対応する素材長の範囲外です。',
  'assembly.steel.bend.stockLengthMismatch': '素材長と曲げ形状の幾何学上の長さが一致しません。',
} as const;

/** 機能ごとの表を 1 つに合わせたもの。鍵の型(`MessageKey`)はここから導く。 */
export const ja = {
  ...steelBend,
  // その場入力(道具ごとの段・欄・つまみ・選択肢)
  ...numericInput,
  // プロパティ区画
  ...propertyPanel,
  // ツールバー
  ...toolbar,
  // ステータスバーとコマンドライン
  ...statusBar,
  // スケッチ(拘束・編集の断り・原点)
  ...sketch,
  // ソリッドと外観(作る・加工の断り・材質)
  ...solid,
  // ファイルと入出力(保存・ひな形・書き出し・下絵・点検)
  ...file,
  // 表示とツリー(ビューキューブ・断面・測る・つまみ・設定)
  ...view,
  // パラメータ(FR-207)
  ...parameters,
  /*
   * アセンブリ(P7)。**鍵の先頭語は `assembly` と `assemblyError` の 2 つだけ**にしてある
   * (`solid` の `solidError`・`file` の `exchangeError` と同じ付け方)。組む・合わせる・
   * ジョイント・干渉・分解・部品表の道具名と、断りの文言(計画書 P7 §2.12)がここに入る。
   */
  ...assembly,
  // 図面(P8)。道具・木・プロパティと、利用者へ返す断りの正本。
  ...drawing,
  ...help,
  ...sheetMetal,
  ...strength,
  ...beam,
  ...plasticBar,
  ...fatigue,
  ...fatigueStrain,
  ...fatigueLocalCycle,
  ...solidAnalysis,
  ...solidPlastic,
  ...script,
  ...math,
  ...mathGeometry,
  ...mathPaletteBasic,
  ...mathPaletteCalculus,
  ...mathPaletteSetsLogic,
  // 共通command登録。ショートカット一覧もこの名前を参照する。
  ...commands,
};

/** 分けた表そのもの(重なりの検査が読む)。並びは `ja` を合わせる順と同じ。 */
export const JA_PARTS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['math', math],
  ['mathGeometry', mathGeometry],
  ['mathPaletteBasic', mathPaletteBasic],
  ['mathPaletteCalculus', mathPaletteCalculus],
  ['mathPaletteSetsLogic', mathPaletteSetsLogic],
  ['script', script],
  ['numericInput', numericInput],
  ['propertyPanel', propertyPanel],
  ['toolbar', toolbar],
  ['statusBar', statusBar],
  ['sketch', sketch],
  ['solid', solid],
  ['file', file],
  ['view', view],
  ['parameters', parameters],
  ['assembly', assembly],
  ['steelBend', steelBend],
  ['drawing', drawing],
  ['help', help],
  ['sheetMetal', sheetMetal],
  ['strength', strength],
  ['beam', beam],
  ['plasticBar', plasticBar],
  ['fatigue', fatigue],
  ['fatigueStrain', fatigueStrain],
  ['fatigueLocalCycle', fatigueLocalCycle],
  ['solidAnalysis', solidAnalysis],
  ['solidPlastic', solidPlastic],
  ['commands', commands],
];
