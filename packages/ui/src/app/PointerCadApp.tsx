import {
  createKernelBridge,
  createOffsetCache,
  createProjectionCache,
  createSubShapeCache,
  recomputePart,
} from '@pointercad/model';
import { useEffect } from 'react';

import { startAutoSave } from '../file/attachAutoSave.js';
import { attachDisplaySettings } from '../shell/applyDisplaySettings.js';
import { AppShell } from '../shell/AppShell.js';
import { attachPartRecompute } from '../store/useAppStore.js';

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
    // オフセット(FR-321、タスク15・21)の計算済みの結果を持ち回る。1 つ作って渡さないと
    // 呼び出しのたびにカーネルへ頼み直すことになる(NFR-PF-2、`recomputePart` の注釈)。
    const offsets = createOffsetCache();
    // 投影・交差(FR-325、タスク25)と、立体の面・辺・頂点の選び直し(FR-328〜330 の
    // 上流追従)も同じ理由で持ち回る。持ち回らないと、上流が変わっていない再計算でも
    // 毎回カーネルへ頼み直し、解決も 2 巡することになる(NFR-PF-2、NFR-PF-3)。
    const projections = createProjectionCache();
    const subShapes = createSubShapeCache();
    const detach = attachPartRecompute((document, options) =>
      recomputePart(document, bridge, { ...options, offsets, projections, subShapes }),
    );

    return () => {
      detach();
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
