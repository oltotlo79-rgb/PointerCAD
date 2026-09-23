/** Public types for the checked-in Vite plugin. */
import type { Plugin } from 'vite';

export interface MathNoticeDistribution {
  assets: Map<string, Buffer>;
  fonts: Map<string, string>;
}
export function collectMathNotices(root?: string): MathNoticeDistribution;
export function verifyMathFontAssets(
  bundle: Record<string, { type: string; fileName: string; source?: string | Uint8Array }>,
  expectedFonts: ReadonlyMap<string, string>,
): void;
export function mathNotices(): Plugin;
export function verifyRemovedMathModules(bundle: Record<string, { type: string; modules?: Record<string, unknown> }>): void;
