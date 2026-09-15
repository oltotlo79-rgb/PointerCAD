export interface OfflineAssetRecord {
  readonly url: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface OfflineManifestBody {
  readonly format: 'pointercad-offline-assets/1';
  readonly entry: 'index.html';
  readonly totalBytes: number;
  readonly required: readonly string[];
  readonly assets: readonly OfflineAssetRecord[];
}
export interface OfflineAssetManifest extends OfflineManifestBody {
  readonly buildId: string;
}
export const OFFLINE_ASSET_FORMAT: 'pointercad-offline-assets/1';
export const OFFLINE_CONTROL_FILES: readonly string[];
export const OFFLINE_DEPLOYMENT_FILES: readonly string[];
export const OFFLINE_MAX_FILES: number;
export const OFFLINE_MAX_FILE_BYTES: number;
export const OFFLINE_MAX_TOTAL_BYTES: number;
export const OFFLINE_MAX_MANIFEST_BYTES: number;
export const OFFLINE_MANUAL_NAVIGATION: 'pointercad-offline-navigation/1';
export const OFFLINE_MANUAL_EDITION_QUERY: 'pcad-offline-edition';
export function isPreparedOfflineCacheName(value: unknown): value is string;
export function offlineAssetUrl(path: string): string;
export function offlineAssetRoute(url: string): string;
export function offlineManifestBody(manifest: OfflineManifestBody): OfflineManifestBody;
export function readOfflineAssetManifest(value: unknown): Promise<OfflineAssetManifest>;
