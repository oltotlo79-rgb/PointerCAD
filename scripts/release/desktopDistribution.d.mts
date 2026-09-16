import type { OfflineAssetInput } from '../vite/offlineAssets.mjs';
export interface DesktopPackageMetadata {
  readonly version: string;
  readonly sourceCommit: string;
  readonly platform: 'win32' | 'linux';
  readonly arch: 'x64';
  readonly electronVersion: string;
  readonly builderVersion: '26.15.3';
}
export interface DesktopPackageManifest extends DesktopPackageMetadata {
  readonly format: 'pointercad-desktop-package/1';
  readonly signed: false;
  readonly releaseCertified: false;
  readonly manualBuildId: string;
  readonly pdfVolumes: number;
  readonly inputs: Readonly<Record<string, string>>;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly application: Readonly<Record<string, unknown>>;
}
export function desktopJson(bytes: Uint8Array): unknown;
export function assembleDesktopDistribution(desktopFiles: readonly OfflineAssetInput[], manualFiles: readonly OfflineAssetInput[],
  pdfFiles: readonly OfflineAssetInput[], notices: ReadonlyMap<string, Uint8Array>, metadata: DesktopPackageMetadata): {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly manifest: DesktopPackageManifest;
};
export function verifyDesktopDistribution(packagedFiles: readonly OfflineAssetInput[], expectedManifestBytes: Uint8Array): {
  readonly files: number;
  readonly manualBuildId: string;
  readonly pdfVolumes: number;
  readonly applicationMetadataSha256: string;
  readonly releaseCertified: false;
};
