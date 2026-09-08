import {
  createKernelBridge,
  createOffsetCache,
  createProjectionCache,
  createSubShapeCache,
  recomputePart,
} from '@pointercad/model';
import { useEffect } from 'react';

import { attachAssembly } from '../assembly/attachAssembly.js';
import { attachAssemblyInterference } from '../assembly/attachAssemblyInterference.js';
import { activeDocumentKind, type DocumentKind } from '../store/documentKind.js';
import { startAutoSave } from '../file/attachAutoSave.js';
import { createPartExchanger } from '../file/partExchanger.js';
import { attachDisplaySettings } from '../shell/applyDisplaySettings.js';
import { AppShell } from '../shell/AppShell.js';
import { createPartMeasurer } from '../solid/measureCommands.js';
import { createPartInspector } from '../solid/printCheckCommands.js';
import {
  attachExchangeKernel,
  attachPartInspector,
  attachPartMeasure,
  attachPartRecompute,
} from '../store/attachKernel.js';
import type { RecomputeOutcome } from '../store/recomputeSlice.js';
import { useAppStore } from '../store/useAppStore.js';

/** 検査だけが使う読み取り口の 1 件ぶんの形(下の `useEffect` の注釈が理由)。 */
interface RecomputeStats {
  readonly pendingWaiters: number;
  readonly activeDocumentKind: DocumentKind;
  /** 作り直さずに済んだ段の数(ストアの `cacheHits`)。 */
  readonly cacheHits: number;
  /** 計算中か(ストアの `isComputing`)。 */
  readonly isComputing: boolean;
  /** 最後に開始を依頼した再計算の世代。 */
  readonly requestedGeneration: number;
  /** 最後に結末まで記録した再計算の世代。 */
  readonly completedGeneration: number;
  /** `completedGeneration` の結末。 */
  readonly lastOutcome: RecomputeOutcome;
}

declare global {
  interface Window {
    /**
     * **検査専用**。いまの再計算の様子を読む(アプリは 1 か所も呼ばない)。
     * 頁を開いてから `PointerCadApp` が載るまでの間は `undefined`。
     */
    pcadRecomputeStats?: () => RecomputeStats;
  }
}

/**
 * アプリの入口。Web 版とデスクトップ版で同じものを使う(要件§1.5、機能差を作らない)。
 *
 * 起動時は空のスケッチ 1 本だけを持つ部品(ストアの初期値 `createEmptyPartDocument()`)から
 * 始め(§0.a-0.2、NFR-UX-6)、部品文書が変わるたびに計算し直す(要件§6.3)。
 * `recomputePart` は面が 1 枚も無く立体の段も無ければカーネルを呼ばないので、起動直後に
 * 50MB の WASM は読み込まれない。最初に面を作ったときに読み込みが起き、そのあいだは
 * 計算中の札が出る。計算の進み具合と中止(NFR-PF-4)も同じ経路で流れる。
 */
export function PointerCadApp(): React.JSX.Element {
  useEffect(() => {
    const bridge = createKernelBridge();
    window.pcadRecomputeStats = () => {
      const state = useAppStore.getState();
      return {
        pendingWaiters: bridge.pendingWaiters(),
        activeDocumentKind: activeDocumentKind(state),
        cacheHits: state.cacheHits,
        isComputing: state.isComputing,
        requestedGeneration: state.requestedGeneration,
        completedGeneration: state.completedGeneration,
        lastOutcome: state.lastOutcome,
      };
    };
    const detachAssembly = attachAssembly(bridge);
    const detachAssemblyInterference = attachAssemblyInterference(bridge);
    // オフセット(FR-321、タスク15・21)の計算済みの結果を持ち回る。1 つ作って渡さないと
    // 呼び出しのたびにカーネルへ頼み直すことになる(NFR-PF-2、`recomputePart` の注釈)。
    const offsets = createOffsetCache();
    // 投影・交差(FR-325、タスク25)と、立体の面・辺・頂点の選び直し(FR-328〜330 の
    // 上流追従)も同じ理由で持ち回る。持ち回らないと、上流が変わっていない再計算でも
    // 毎回カーネルへ頼み直し、解決も 2 巡することになる(NFR-PF-2、NFR-PF-3)。
    const projections = createProjectionCache();
    const subShapes = createSubShapeCache();
    /*
     * **文書が丸ごと差し替わったら、3 つの覚え書きを空にする**(新規・開く・復元、
     * および Undo / Redo。ストアの `documentVersion` が進むのがこの 5 つ)。
     *
     * 覚え書きは頁を開いている間ずっと生き続けるので、これをしないと**前の文書の参照が
     * 次の文書に残る**。フィーチャーの id は文書ごとに `solid-1` から振り直される
     * (`createPartDocument.ts` の `nextSolidId`)ため、前の文書の面・辺・頂点の参照が
     * 新しい文書の**別物の同じ id のボディ**へ照合し直され、`refresh` が毎回「変わった」と
     * 言い続けて `recomputePart` が毎回 2 巡目に入り、覚えている参照も増え続ける
     * (NFR-PF-3。`subShapeCache.ts` の `clear` の注釈)。2026-09-06 の目視で
     * 「頁を読み込み直すと直る」状態が残っていた 2 か所のうちの 1 つ。
     *
     * **`attachPartRecompute` より先に見張りを始める**(購読の通知は登録順に届く)。
     * 後にすると、差し替え直後の 1 回だけ古い覚え書きで解決してしまう。
     *
     * 判定に文書の id を使わないのは、`createEmptyPartDocument()` の id が常に `part-1` で
     * 「新規」の前後で変わらないため。**Undo / Redo でも空にする**のは、`documentVersion`
     * がその 2 つでも進むからで、id が振り直されない分だけ捨てすぎではあるが、覚え書きは
     * 次の再計算で入り直る(費用は往復 1 回ぶん)。
     */
    const unwatchDocument = useAppStore.subscribe((next, previous) => {
      if (next.documentVersion === previous.documentVersion) {
        return;
      }
      offsets.clear();
      projections.clear();
      subShapes.clear();
    });
    const detach = attachPartRecompute((document, options) =>
      recomputePart(document, bridge, { ...options, offsets, projections, subShapes }),
    );
    /*
     * 測定・質量特性(FR-1101、FR-1102、P5 タスク32)。**再計算とは別の口**で、覚えてある形を
     * 読むだけ(§0.a-0.30)。組み立ては `solid/measureCommands.ts` にあり、ここは
     * カーネルの口と覚え書き(上の 3 つ)を渡すだけにする。同じ覚え書きを渡さないと、
     * 段の鍵が食い違って「測れませんでした」になる。
     */
    const detachMeasure = attachPartMeasure(
      createPartMeasurer({
        measure: (steps, targets, kind) => bridge.measure(steps, targets, kind),
        offsets,
        projections,
        subShapes,
        // 読み込んだ形(FR-802)は文書の外にあるので、解くたびにストアの表を渡す。
        // 渡さないと読み込んだ立体だけ段が作れず、測れも書き出せもしなくなる。
        importedShapes: () => useAppStore.getState().importedShapes,
      }),
    );
    /*
     * 書き出しと読み込み(FR-802、FR-803、P6 タスク32b)。**測定とまったく同じ形の配線**で、
     * 覚えてある形を読むだけ(再計算は起こさない)。同じ覚え書きを渡さないと、段の鍵が
     * 食い違って「もとになる立体が見つかりませんでした」になる。
     *
     * 今の文書と外観の照合はストアから読む。**書き出しのたびに読む**(押した時点の
     * 文書で書き出すため。ここで 1 度だけ読むと、開き直した後も古い文書を書き出す)。
     */
    const detachExchange = attachExchangeKernel(
      createPartExchanger({
        snapshot: () => {
          const state = useAppStore.getState();
          return { document: state.document, appearanceMatches: state.appearanceMatches };
        },
        exportShapes: (steps, options) => bridge.exportShapes(steps, options),
        importShape: (options) => bridge.importShape(options),
        offsets,
        projections,
        subShapes,
        importedShapes: () => useAppStore.getState().importedShapes,
      }),
    );
    /*
     * 3D プリントの点検(FR-815、P6 タスク46)。**測定・書き出しとまったく同じ形の配線**で、
     * 覚えてある形を読むだけ(再計算は起こさない、§0.a-0.30)。同じ覚え書きを渡さないと
     * 段の鍵が食い違って「もとになる立体が見つかりませんでした」になる。
     */
    const detachInspect = attachPartInspector(
      createPartInspector({
        inspectPrintability: (steps, options) => bridge.inspectPrintability(steps, options),
        offsets,
        projections,
        subShapes,
        importedShapes: () => useAppStore.getState().importedShapes,
      }),
    );

    return () => {
      detachInspect();
      detachExchange();
      detachMeasure();
      detach();
      unwatchDocument();
      detachAssemblyInterference();
      detachAssembly();
      delete window.pcadRecomputeStats;
      bridge.dispose();
    };
  }, []);

  useEffect(() => {
    /*
     * 自動保存とクラッシュ復元(FR-805、NFR-RE-2)。控えがあれば案内を出し、
     * 文書が変わったら 5 分ごとに控えを書く。中身は `attachAutoSave.ts` にあり、
     * ここは始めて片付けるだけにする(docs/報告記録.md 2026-09-02 22:10 の④)。
     */
    return startAutoSave();
  }, []);

  useEffect(() => {
    /*
     * 表示テーマ・拡大率をルート要素へ反映する(FR-908、FR-909)。起動時の値をすぐに
     * 反映し、以後はストアの `displaySettings` の変化を見張って追従する(切り替えは
     * 再起動なしに即時反映、§0.a-0.1・0.2)。中身は `applyDisplaySettings.ts` にあり、
     * ここは始めて片付けるだけにする。
     */
    return attachDisplaySettings(document.documentElement);
  }, []);

  return <AppShell />;
}
