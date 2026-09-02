import type { KernelBridge } from './kernelBridge.js';
import type { PartDocument, RecomputeResult } from './types.js';

/**
 * フィーチャー履歴を先頭から順に評価してメッシュを得る(要件§6.3)。
 * 失敗しても例外を投げずエラー箇所を返す(FR-504、NFR-RE-1)。
 */
export async function recomputePart(
  document: PartDocument,
  bridge: KernelBridge,
): Promise<RecomputeResult> {
  const feature = document.features.at(-1);
  if (feature === undefined) {
    return { status: 'error', featureId: '', message: 'フィーチャーが1つもありません。' };
  }

  try {
    const mesh = await bridge.tessellateBox(feature.dx, feature.dy, feature.dz);
    return { status: 'ok', mesh };
  } catch (error) {
    return {
      status: 'error',
      featureId: feature.id,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
