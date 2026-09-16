import type { OfflineAssetInput } from '../vite/offlineAssets.mjs';
export function desktopFileHash(bytes: Uint8Array): string;
export function collectDesktopFiles(projectRoot: string, outputFolder: string): Promise<readonly OfflineAssetInput[]>;
export function desktopOutputHashes(files: readonly OfflineAssetInput[]): Readonly<Record<string, string>>;
