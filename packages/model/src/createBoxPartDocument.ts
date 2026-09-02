import type { PartDocument } from './types.js';

/** P0 の確認用の既定寸法(mm)。 */
export const DEFAULT_BOX_SIZE = { dx: 40, dy: 60, dz: 20 } as const;

/** 直方体 1 個だけの部品ドキュメントを作る。P2 で作るフィーチャー履歴の最小形。 */
export function createBoxPartDocument(
  size: { dx: number; dy: number; dz: number } = DEFAULT_BOX_SIZE,
): PartDocument {
  return {
    id: 'part-1',
    name: '部品1',
    features: [
      {
        id: 'feature-1',
        kind: 'box',
        name: '直方体1',
        dx: size.dx,
        dy: size.dy,
        dz: size.dz,
      },
    ],
  };
}
