/** Public types for the checked-in Vite plugin. */
import type { Plugin } from 'vite';

export interface StartupGuardChunk {
  type: string;
  fileName: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports: string[];
  dynamicImports?: string[];
  code: string;
}
export function findStartupGuardChunk(bundle: Record<string, { type: string } | StartupGuardChunk>): StartupGuardChunk;
export function insertStartupGuard(html: string, source: string): string;
export function startupGuard(): Plugin;
