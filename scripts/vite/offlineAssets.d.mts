export interface OfflineAssetInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}
import type { OfflineAssetManifest } from './offlineProtocol.mjs';
export type { OfflineAssetManifest, OfflineAssetRecord } from './offlineProtocol.mjs';
export const OFFLINE_ASSET_FORMAT: 'pointercad-offline-assets/1';
export const OFFLINE_CONTROL_FILES: readonly string[];
export const OFFLINE_DEPLOYMENT_FILES: readonly string[];
export const OFFLINE_MAX_FILES: number;
export const OFFLINE_MAX_FILE_BYTES: number;
export const OFFLINE_MAX_TOTAL_BYTES: number;
export function offlineAssetUrl(path: string): string;
export function createOfflineAssetManifest(files: readonly OfflineAssetInput[], requiredPaths: readonly string[]): OfflineAssetManifest;
export function collectOfflineAssetFiles(projectRoot: string, outputFolder: string): Promise<{
  files: OfflineAssetInput[];
  excluded: string[];
}>;
