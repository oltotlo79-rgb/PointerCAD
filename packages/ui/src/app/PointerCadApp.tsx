import { createKernelBridge, recomputeSketch } from '@pointercad/model';
import { useEffect } from 'react';

import { AppShell } from '../shell/AppShell.js';
import { attachSketchRecompute } from '../store/useAppStore.js';

/**
 * アプリの入口。Web 版とデスクトップ版で同じものを使う(要件§1.5、機能差を作らない)。
 *
 * 起動時は空のスケッチから始め(§0.a-0.2、NFR-UX-6)、履歴が変わるたびに再計算する
 * (要件§6.3)。`recomputeSketch` は面が 1 枚も無ければカーネルを呼ばないので、
 * 起動直後に 50MB の WASM は読み込まれない。最初に面を作ったときに読み込みが起き、
 * そのあいだは計算中の札が出る。
 */
export function PointerCadApp(): React.JSX.Element {
  useEffect(() => {
    const bridge = createKernelBridge();
    const detach = attachSketchRecompute((document) => recomputeSketch(document, bridge));

    return () => {
      detach();
      bridge.dispose();
    };
  }, []);

  return <AppShell />;
}
