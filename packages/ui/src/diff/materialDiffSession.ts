import { createKernelBridge, type PartDocument, type PartRecomputeOptions, type PartRecomputeResult,
  type MaterialComparisonResult } from '@pointercad/model';
import { createMathPartRecomputer } from '../math/recomputePartWithMath.js';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';

/** 比較だけが所有する計算処理。編集中の部品のWorkerや保存先を受け取らない。 */
export interface MaterialDiffSession {
  compute(document: PartDocument, options: PartRecomputeOptions): Promise<PartRecomputeResult>;
  compare(beforeKeys: readonly string[], afterKeys: readonly string[], shouldCancel: () => boolean): Promise<MaterialComparisonResult>;
  dispose(): void;
}
export function createMaterialDiffSession(): MaterialDiffSession {
  const bridge = createKernelBridge(), recompute = createMathPartRecomputer(createBrowserMathClient);
  let disposed = false;
  return {
    compute: (document, options) => recompute(document, bridge, options),
    compare: (beforeKeys, afterKeys, shouldCancel) => bridge.compareMaterials(beforeKeys, afterKeys, shouldCancel),
    dispose() {
      if (disposed) return;
      disposed = true;
      // 中止は独立Workerを終え、計算途中の所有者と借用中の形をまとめて手放す。
      try { recompute.releaseOwner(bridge); } finally { bridge.dispose(); }
    },
  };
}
