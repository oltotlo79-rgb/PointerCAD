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
  /*
   * アセンブリ(P7)。**鍵の先頭語は `assembly` と `assemblyError` の 2 つだけ**にしてある
   * (`solid` の `solidError`・`file` の `exchangeError` と同じ付け方)。組む・合わせる・
   * ジョイント・干渉・分解・部品表の道具名と、断りの文言(計画書 P7 §2.12)がここに入る。
   */
  ...assembly,
  // 図面(P8)。道具・木・プロパティと、利用者へ返す断りの正本。
  ...drawing,
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
  ['assembly', assembly],
  ['drawing', drawing],
];
