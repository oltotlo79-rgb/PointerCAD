import type { OfflineAssetInput, OfflineAssetManifest } from './offlineAssets.mjs';
export function assembleOfflineDistribution(webFiles: readonly OfflineAssetInput[], manualFiles: readonly OfflineAssetInput[],
  pdfFiles: readonly OfflineAssetInput[]): {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly manifest: OfflineAssetManifest;
    readonly manualBuildId: string;
    readonly pdfVolumes: number;
    readonly releaseCertified: false;
  };
