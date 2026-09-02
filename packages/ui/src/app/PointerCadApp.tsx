import { createBoxPartDocument, createKernelBridge, recomputePart } from '@pointercad/model';
import { useEffect } from 'react';

import { AppShell } from '../shell/AppShell.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * アプリの入口。Web 版とデスクトップ版で同じものを使う(要件§1.5、機能差を作らない)。
 * 起動時に「直方体1個の部品」を作り、Worker 内の幾何カーネルで計算して表示する(要件§6.3)。
 */
export function PointerCadApp(): React.JSX.Element {
  useEffect(() => {
    const store = useAppStore.getState();
    const document = createBoxPartDocument();
    store.setDocument(
      document.name,
      document.features.map((feature) => feature.name),
    );
    store.setComputing(true);

    const bridge = createKernelBridge();
    let cancelled = false;

    void (async () => {
      const result = await recomputePart(document, bridge);
      if (cancelled) {
        return;
      }
      if (result.status === 'ok') {
        useAppStore.getState().setMesh(result.mesh);
      } else {
        // 計算に失敗してもアプリは落とさず、理由を画面に出す(FR-504、NFR-RE-1)。
        useAppStore.getState().setError(result.message);
      }
    })();

    return () => {
      cancelled = true;
      bridge.dispose();
    };
  }, []);

  return <AppShell />;
}
