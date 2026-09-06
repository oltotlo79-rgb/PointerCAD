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

/** 機能ごとの表を 1 つに合わせたもの。鍵の型(`MessageKey`)はここから導く。 */
export const ja = {
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
};

/** 分けた表そのもの(重なりの検査が読む)。並びは `ja` を合わせる順と同じ。 */
export const JA_PARTS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['numericInput', numericInput],
  ['propertyPanel', propertyPanel],
  ['toolbar', toolbar],
  ['statusBar', statusBar],
  ['sketch', sketch],
  ['solid', solid],
  ['file', file],
  ['view', view],
  ['parameters', parameters],
];
