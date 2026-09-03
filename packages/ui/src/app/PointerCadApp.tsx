import { createKernelBridge, recomputePart } from '@pointercad/model';
import { useEffect } from 'react';

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
    const detach = attachPartRecompute((document, options) =>
      recomputePart(document, bridge, options),
    );

    return () => {
      detach();
      bridge.dispose();
    };
  }, []);

  return <AppShell />;
}
