/**
 * 入出力(FR-802・FR-803)と 3D プリントの点検(FR-815)のスライス。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import type { ImportedMeshBytes } from '@pointercad/io';
import type { PrintabilityReport } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { ExchangeKernel } from '../file/exchangeFile.js';
import { t } from '../i18n/t.js';
import {
  type PartInspector,
  PRINT_CHECK_STALE_KEY,
  runPrintCheck,
} from '../solid/printCheckCommands.js';
import type { AppState } from './appState.js';

/**
 * 3D プリント向けの点検の要約と結果(FR-815、P6 §0.51・§0.53・§2.16、タスク42・43・46)。
 *
 * **43b が ui 側へ仮に写して置いていた型を、タスク46 で model が輸出する型へ差し替えた。**
 * 欄の名前も型も最初からそろえてあったので、詰め替えは 1 か所も要らなかった
 * (`packages/ui` は `@pointercad/kernel` に依存しない——依存は model 経由だけ、rules/04)。
 * **画面に出る欄の意味の正本は `model` の `PrintabilitySummary`** で、ここには写さない。
 */
export type { PrintabilityReport, PrintabilitySummary } from '@pointercad/model';

/** 入出力と点検のスライスが持つ欄と操作。 */
export interface ExchangeSlice {
  /**
   * 3D プリントの点検の結果(FR-815、P6 §0.53、タスク42・43)。まだ点検していなければ `null`。
   *
   * **再計算を起こさない。** 文書に触らないので `affectsShape` の経路を通らず、点検を
   * 閉じれば元の色に戻る(§0.53)。文書を作り直したら消える(古い形の三角形の並びを
   * 新しい形が指すことは無い)ので、`sectionView` と同じく
   * `createInitialDocumentState` の側に置いてある。
   *
   * 欄と型を 43b が置き、タスク46 が中身(`KernelBridge.inspectPrintability` の配線と
   * 色の層)を入れた。`null` のあいだ、プロパティの節は「まだ点検していません。」と
   * 説明だけを出す。
   */
  readonly printability: PrintabilityReport | null;
  /**
   * 点検の色を塗る相手(立体を作ったフィーチャーの id → 結果の中での先頭の三角形の番号)。
   * `printability` と必ず同時に入れ替わる(片方だけ残ると、色をどこへ塗るか分からない)。
   *
   * ここに**無い立体には色を塗らない**(点検を頼まなかった立体は元の外観のまま)。
   * 作るのは `solid/printabilityColors.ts` の `printabilityTriangleOffsets` 1 か所だけ。
   */
  readonly printabilityOffsets: ReadonlyMap<string, number> | null;
  /**
   * いま点検を走らせている最中か(FR-815、NFR-PF-4)。
   *
   * **再計算の `isComputing` とは別の札**にする。点検は文書を 1 バイトも変えない読み取り
   * (§0.a-0.30)なので、再計算の札を立てると「形を計算しています…」と出て、
   * 履歴の操作まで塞いでしまう(`isComputing` を見て止まる場所が幾つもある)。
   */
  readonly isInspectingPrint: boolean;
  /**
   * 点検の中止を頼んだか(NFR-PF-4)。走っている最中に入口をもう一度押すと立つ。
   *
   * **やめても、そこまでに分かったことは結果として返る**(水密性とせり出しは先に終えて
   * あり、肉厚だけが測ったところまでになる)。点検が終われば必ず下ろす。
   */
  readonly printCheckCancelRequested: boolean;
  /**
   * 点検を断った理由(NFR-UX-5)。そのまま帯へ出せる日本語 1 行で、点検できたら `null`。
   * 文言の正本は断りを出した層(`solid/printCheckCommands.ts` かカーネル)に置く。
   */
  readonly printCheckErrorMessage: string | null;
  /**
   * 書き出しの添え物(FR-803、P6 タスク45 の指摘・43b の申し送り)。「弾いた立体が
   * 1 つあります」のような**うまくいったときの知らせ**で、無ければ `null`。
   *
   * **失敗の口(`errorMessage`)へ入れない。** あちらはステータスバーで頭に
   * 「計算に失敗しました:」を付けて赤くするので、書き出せたのに失敗したように見えていた。
   */
  readonly exchangeNotice: string | null;
  /**
   * 書き出し・読み込みの口(FR-802、FR-803。P6 タスク32)。
   *
   * `partMeasurer` とまったく同じ理由で外から差し出してもらう(幾何カーネル(Worker)を
   * 持っているのは `PointerCadApp` だけで、`packages/ui` は幾何カーネルへ直接依存できない)。
   * 差し出されていなければ、書き出しも読み込みも日本語の理由で断る
   * (`file/exchangeActions.ts` の `EXCHANGE_KERNEL_MISSING_MESSAGE`)。
   */
  readonly exchangeKernel: ExchangeKernel | null;
  /**
   * 読み込んだファイルの単位を利用者へ訊いている最中か(FR-811、§0.a-0.6。P6 タスク32b)。
   *
   * **単位を書かない形式(STL / OBJ・単位の無い DXF)を読み込んだときだけ**立つ。
   * 答え(ミリメートル / インチ / やめる)は `file/exchangeActions.ts` の
   * `answerImportUnit` が受け取り、待っている読み込みへ返す。
   *
   * **確認の窓(`confirm`)にしないのは、2 択を「OK / キャンセル」で訊くと誤操作を招く**
   * ため(NFR-UX-5)。3 つ目の答え(やめる)も窓の × と区別できない。
   */
  readonly importUnitAsked: boolean;
  /**
   * 読み込んだ形の B-rep のバイト列(FR-802、P6 §0.a-0.9、タスク32)。鍵は
   * `ImportedSolidFeature.shapeRef` で、`.pcad` の ZIP のエントリ `shapes/<shapeRef>.brep` と
   * 1 対 1。**上の `canvases` と同じ「添付の表」の 3 つ目**である。
   *
   * **再計算のたびにそのまま `PartRecomputeOptions.importedShapes` へ渡す。** 渡さないと
   * `importedSolid` の段は「読み込んだ形が見つかりません」で失敗する(FR-504)。
   * 保存・自動保存でも一緒に書く。書かないと、開き直したときに読み手が
   * `missingField` で断る(`packages/io` の `findMissingAttachment`。タスク21 の申し送り)。
   */
  readonly importedShapes: ReadonlyMap<string, Uint8Array>;
  /**
   * 読み込んだ三角形(FR-802、P6 §0.a-0.24、タスク32)。鍵は `ImportedMeshFeature.meshRef` で、
   * `.pcad` の ZIP のエントリ `meshes/<meshRef>.bin` と 1 対 1。
   *
   * **再計算には渡さない**(三角形の形は幾何カーネルの段にならない、§0.a-0.23)。
   * 持つのは保存と画面表示のためだけである。
   */
  readonly importedMeshes: ReadonlyMap<string, ImportedMeshBytes>;
  /**
   * 3D プリントの点検の口(FR-815。P6 タスク46)。
   *
   * `partMeasurer` とまったく同じ理由で外から差し出してもらう(幾何カーネル(Worker)を
   * 持っているのは `PointerCadApp` だけで、`packages/ui` は幾何カーネルへ直接依存できない)。
   * 差し出されていなければ、点検は日本語の理由で断る(NFR-UX-5)。
   */
  readonly partInspector: PartInspector | null;
  /** 書き出し・読み込みの口を差し出す・取り下げる(`attachExchangeKernel` が呼ぶ)。 */
  readonly setExchangeKernel: (kernel: ExchangeKernel | null) => void;
  /** 単位を訊く小窓を出す・しまう(`file/exchangeActions.ts` だけが呼ぶ)。 */
  readonly setImportUnitAsked: (asked: boolean) => void;
  readonly setImportedAttachments: (
    shapes: ReadonlyMap<string, Uint8Array>,
    meshes: ReadonlyMap<string, ImportedMeshBytes>,
  ) => void;
  /**
   * 読み込んだ形を**足す**(FR-802、タスク32)。いま開いている部品へ 1 ファイルぶんを
   * 取り込むときに使うので、前からある添付は残す(差し替えない)。
   */
  readonly addImportedAttachments: (
    shapes: ReadonlyMap<string, Uint8Array>,
    meshes: ReadonlyMap<string, ImportedMeshBytes>,
  ) => void;
  /**
   * 3D プリントの点検の結果を置く・消す(FR-815、タスク42・43・46)。
   *
   * `offsets` は色を塗る相手(省くと空 = どの立体にも塗らない)。`null` を渡すと
   * **点検を閉じる**——色が消えて元の外観に戻り、形も体積も 1 つも変わらない(§0.53)。
   */
  readonly setPrintability: (
    report: PrintabilityReport | null,
    offsets?: ReadonlyMap<string, number> | null,
  ) => void;
  /** 再計算で点検時の表示メッシュが古くなったとき、色と結果を捨てて理由を出す。 */
  readonly invalidatePrintability: () => void;
  /**
   * いまの文書を 3D プリント向けに点検する(FR-815。ツールバーの「表示」の入口)。
   *
   * 判断と組み立ては `solid/printCheckCommands.ts` の `runPrintCheck` 1 か所に置き、
   * ここは「ストアの値を渡す」「結果か理由を置く」だけにする(`measureSelection` と同じ)。
   * **文書は 1 バイトも変えない**ので取り消しの段も積まず、再計算も起きない(§0.a-0.30)。
   * 走っているあいだは `isInspectingPrint` が立つ(`isComputing` は立てない)。
   */
  readonly inspectPrintability: () => void;
  /** 点検を走らせる手立てを差し出す・取り下げる(`attachPartInspector` が呼ぶ)。 */
  readonly setPartInspector: (inspector: PartInspector | null) => void;
  /** 書き出しの添え物を出す・消す(FR-803、タスク45・46)。断りではないので赤くしない。 */
  readonly setExchangeNotice: (notice: string | null) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(入出力と点検)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type ExchangeInitialState = Pick<
  ExchangeSlice,
  | 'printability'
  | 'printabilityOffsets'
  | 'isInspectingPrint'
  | 'printCheckCancelRequested'
  | 'printCheckErrorMessage'
  | 'exchangeNotice'
  | 'exchangeKernel'
  | 'importUnitAsked'
  | 'importedShapes'
  | 'importedMeshes'
  | 'partInspector'
>;

export const createExchangeSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<ExchangeSlice, keyof ExchangeInitialState>
> = (set, get) => ({
  setExchangeKernel: (exchangeKernel) => {
    set({ exchangeKernel });
  },
  setImportUnitAsked: (importUnitAsked) => {
    set({ importUnitAsked });
  },
  setImportedAttachments: (shapes, meshes) => {
    set({ importedShapes: shapes, importedMeshes: meshes });
  },
  addImportedAttachments: (shapes, meshes) => {
    set((state) => ({
      // 表は不変なので、足すたびに新しい `Map` を作る(rules/04。前の表は触らない)。
      importedShapes: new Map([...state.importedShapes, ...shapes]),
      importedMeshes: new Map([...state.importedMeshes, ...meshes]),
    }));
  },
  setPrintability: (printability, offsets = null) => {
    // 結果と塗る相手は必ず一緒に入れ替える(片方だけ残ると色の行き先が食い違う)。
    // 出せたら前の断りは用済み(NFR-UX-5「押したら必ず何かが起きる」)。
    set({
      printability,
      printabilityOffsets: printability === null ? null : offsets,
      printCheckErrorMessage: null,
    });
  },
  invalidatePrintability: () => {
    set({
      printability: null,
      printabilityOffsets: null,
      printCheckErrorMessage: t(PRINT_CHECK_STALE_KEY),
    });
  },
  inspectPrintability: () => {
    const state = get();
    if (state.isInspectingPrint) {
      /*
        すでに 1 本走っている。二重に頼むと結果がどちらの順で返るか決まらないので、
        **2 回目の押しは「やめる」にする**(ヘルプ `print-check.md` の「途中でやめたく
        なったら、もう一度押せば止まります」。やめてもそこまでの結果は返る、NFR-PF-4)。
      */
      set({ printCheckCancelRequested: true });
      return;
    }
    set({
      isInspectingPrint: true,
      printCheckCancelRequested: false,
      printCheckErrorMessage: null,
    });
    void runPrintCheck({
      document: state.document,
      // カーネルが返したボディはそのまま `PrintCheckBody`(三角形の枚数つき)を満たす。
      bodies: state.bodies,
      selection: state.selection,
      inspector: state.partInspector,
      // 中止の答えは**その場のストア**から読む(押した瞬間の値を閉じ込めない)。
      shouldCancel: () => get().printCheckCancelRequested,
    }).then((outcome) => {
      // 待っているあいだに文書が変わっていることがあるので、置く先は取り直す。
      const after = get();
      if (outcome.ok) {
        after.setPrintability(outcome.report, outcome.offsets);
        set({ isInspectingPrint: false, printCheckCancelRequested: false });
        return;
      }
      set({
        isInspectingPrint: false,
        printCheckCancelRequested: false,
        printCheckErrorMessage: outcome.message,
      });
    });
  },
  setPartInspector: (partInspector) => {
    set({ partInspector });
  },
  setExchangeNotice: (exchangeNotice) => {
    set({ exchangeNotice });
  },
});
