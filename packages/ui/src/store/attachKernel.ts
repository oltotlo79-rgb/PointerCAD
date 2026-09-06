/**
 * カーネル(Worker)の手立てをストアへ差し出す口(P6 タスク52 で `useAppStore.ts` から
 * 切り出した)。**ストアを読む側**なので、スライスからは参照しない(輪を作らないため)。
 */
import type { PcadAttachments } from '@pointercad/io';
import {
  affectsShape,
  documentUpTo,
  type PartDocument,
  type PartRecomputeOptions,
  type PartRecomputeResult,
} from '@pointercad/model';
import type { ExchangeKernel } from '../file/exchangeFile.js';
import type { PartMeasurer } from '../solid/measureCommands.js';
import type { PartInspector } from '../solid/printCheckCommands.js';
import type { AppState } from './appState.js';
import { useAppStore } from './useAppStore.js';

/**
 * 書き出し・読み込みの口を差し出す(FR-802、FR-803。P6 タスク32)。
 *
 * `attachPartMeasure` とまったく同じ形にしてある。**書き出しも読み込みも再計算を
 * 起こさない読み取り**なので、文書の変化は見張らない(差し出して、片付けで取り下げるだけ)。
 *
 * 戻り値を呼ぶと取り下げる。
 */
export function attachExchangeKernel(kernel: ExchangeKernel): () => void {
  useAppStore.getState().setExchangeKernel(kernel);
  return () => {
    // 自分が差し出したものが今も立っているときだけ下ろす(`attachPartMeasure` と同じ)。
    if (useAppStore.getState().exchangeKernel === kernel) {
      useAppStore.getState().setExchangeKernel(null);
    }
  };
}

/**
 * いまの添付の表(`.pcad` へ一緒に書くもの。P6 §0.a-0.55、タスク32)。
 *
 * **保存・自動保存はここ 1 か所から取る。** 3 つを別々に読み集めると、片方だけ渡し忘れた
 * ときに「開き直せないファイル」ができる(`packages/io` の `findMissingAttachment` が
 * `missingField` で断る)。下絵(`canvases`、タスク39)も同じ表に載る。
 */
export function currentPcadAttachments(): PcadAttachments {
  const state = useAppStore.getState();
  return {
    shapes: state.importedShapes,
    meshes: state.importedMeshes,
    canvases: state.canvases,
  };
}

/**
 * 形を測る手立てを差し出す(FR-1101、FR-1102。P5 タスク32)。
 *
 * カーネル(Worker)を持っているのは入口(`PointerCadApp`)だけなので、`attachPartRecompute`
 * と同じ流儀で外から差し込む。**測定は再計算を起こさない読み取り**(§0.a-0.30)なので、
 * 文書の変化は見張らない(差し出して、片付けで取り下げるだけ)。
 *
 * 戻り値を呼ぶと取り下げる。
 */
export function attachPartMeasure(measurer: PartMeasurer): () => void {
  useAppStore.getState().setPartMeasurer(measurer);
  return () => {
    // 自分が差し出したものが今も立っているときだけ下ろす(別の入口が差し替えた後に
    // 片付けが走っても、新しい手立てを消さない)。
    if (useAppStore.getState().partMeasurer === measurer) {
      useAppStore.getState().setPartMeasurer(null);
    }
  };
}

/**
 * 3D プリントの点検の手立てを差し出す(FR-815。P6 タスク46)。
 *
 * `attachPartMeasure` とまったく同じ形。**点検も再計算を起こさない読み取り**
 * (§0.a-0.30)なので、文書の変化は見張らない(差し出して、片付けで取り下げるだけ)。
 *
 * 戻り値を呼ぶと取り下げる。
 */
export function attachPartInspector(inspector: PartInspector): () => void {
  useAppStore.getState().setPartInspector(inspector);
  return () => {
    if (useAppStore.getState().partInspector === inspector) {
      useAppStore.getState().setPartInspector(null);
    }
  };
}

/**
 * 部品を 1 回計算するもの。実物は `recomputePart(document, bridge, options)`。
 * カーネル(Worker)を持たない検査では偽物を差し込めるよう、関数の型で受ける。
 */
export type PartRecomputer = (
  document: PartDocument,
  options: PartRecomputeOptions,
) => Promise<PartRecomputeResult>;

/**
 * 文書の変化を見張り、変わるたびに再計算を予約する(要件§6.3)。
 *
 * 1 本ずつしか走らせない。計算中に文書が何度変わっても覚えるのは**最新の 1 つだけ**で、
 * 間に挟まった版は捨てる。連続入力のたびに Worker を往復させて詰まらせないため
 * (NFR-PF-1)。古い版の結果は捨てるので、`isComputing` が下りるのは最新の計算が
 * 終わったときだけになる。失敗しても例外を投げず、理由を画面に出す(FR-504、NFR-RE-1)。
 *
 * 依頼のたびに世代番号を 1 つ増やして渡す(NFR-PF-4)。番号はここに閉じて持ち、
 * ストアへは出さない。計算を始めるたびにストアを書き換えると、購読の通知の中で
 * さらに書き換えることになるため。中止は `cancelRecompute` が数える回数で拾う。
 *
 * 戻り値を呼ぶと見張りをやめる。
 */
export function attachPartRecompute(recompute: PartRecomputer): () => void {
  let detached = false;
  let running = false;
  /** 実行中に届いた最新の文書。1 つだけ持つ。 */
  let queued: PartDocument | null = null;
  /** 依頼ごとに 1 つ増える世代番号。1 から始まる。 */
  let generation = 0;

  /** 1 本分が終わったときの後始末。次に回す文書があれば返す。 */
  function takeQueued(): PartDocument | null {
    running = false;
    const next = queued;
    queued = null;
    return next;
  }

  function start(document: PartDocument): void {
    running = true;
    generation += 1;
    const current = generation;
    // 中止は「この計算を始めた後に頼まれたか」で判る。始まっていない計算は止められない。
    const cancelBaseline = useAppStore.getState().cancelRequestCount;
    // 前の計算の進み具合は用済み。計算中の札は applyDocument が立てるのでここでは触らない。
    useAppStore.getState().setRecomputeProgress(null);

    void recompute(document, {
      generation: current,
      onProgress: (progress) => {
        // 古い世代の通知は捨てる。画面の進み具合を決めるのは最新の計算だけ。
        if (detached || current !== generation) {
          return;
        }
        useAppStore.getState().setRecomputeProgress(progress);
      },
      shouldCancel: () => useAppStore.getState().cancelRequestCount > cancelBaseline,
      /*
       * 読み込んだ形の B-rep(FR-802、P6 §0.a-0.9)。**渡さないと `importedSolid` の段が
       * 「読み込んだ形が見つかりません」で失敗する。** 表は文書と一緒に差し替わるので、
       * 依頼を出すそのときの表を読む(`PointerCadApp` の覚え書きと同じ約束)。
       */
      importedShapes: useAppStore.getState().importedShapes,
    }).then(
      (result) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          // もっと新しい文書が来ている。この結果は使わずに次を計算する。
          start(next);
          return;
        }
        useAppStore.getState().applyRecompute(document, result);
      },
      (error: unknown) => {
        if (detached) {
          return;
        }
        const next = takeQueued();
        if (next !== null) {
          start(next);
          return;
        }
        useAppStore.getState().setError(error instanceof Error ? error.message : String(error));
      },
    );
  }

  function request(document: PartDocument): void {
    if (running) {
      queued = document;
      return;
    }
    start(document);
  }

  /**
   * 計算に渡す文書。**保存されるのは常に `document`(全体)で、ここで切ったものは
   * 画面に出す形を決めるためだけに使う**(FR-506、タスク19 の落とし穴)。
   * つまみが末尾(`null`)のときは `documentUpTo` が同じ文書をそのまま返す(`===`)ので、
   * これまでの経路と 1 ミリ秒も変わらない(NFR-PF-3)。
   */
  function shownDocument(state: AppState): PartDocument {
    return documentUpTo(state.document, state.timelineIndex);
  }

  request(shownDocument(useAppStore.getState()));

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    // つまみを動かしたときも計算し直す(FR-507)。切った文書のフィーチャーは複製されない
    // ので段の鍵は変わらず、前半の段は全部キャッシュに当たる(§2.7)。
    // **外観の割り当てだけが変わったときは投げない**(FR-1106〜1110、要件§4.12、
    // P5 §2.3.2)。色を変えるたびに 100 フィーチャーの解決と Worker の往復が起きるのを
    // 避けるための、P5 で最も効く 1 行。形の変化の判定は `model` の `affectsShape` が正本。
    if (
      affectsShape(previous.document, next.document) ||
      next.timelineIndex !== previous.timelineIndex
    ) {
      request(shownDocument(next));
    }
  });

  return () => {
    detached = true;
    queued = null;
    unsubscribe();
  };
}
