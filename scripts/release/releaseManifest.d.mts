import type { OfflineAssetInput } from '../vite/offlineAssets.mjs';

export interface ReleaseCandidateInput {
  readonly receiptBytes: Uint8Array;
  readonly packageManifestBytes: Uint8Array;
  readonly stagedFiles: readonly OfflineAssetInput[];
  readonly artifacts: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
}
export interface ReleaseManifestInput {
  readonly packageFiles: { readonly root: Uint8Array; readonly desktop: Uint8Array; readonly web: Uint8Array };
  readonly builderConfig: string;
  readonly tag?: string | null;
  readonly sourceCommit: string;
  readonly sourceInputs: { readonly web: Readonly<Record<string, string>>; readonly desktop: Readonly<Record<string, string>>;
    readonly manual: Readonly<Record<string, string>> };
  readonly candidates: readonly ReleaseCandidateInput[];
  readonly webFiles: readonly OfflineAssetInput[];
}
export interface ReleaseManifest {
  readonly format: 'pointercad-release/1';
  readonly version: string;
  readonly tag: string | null;
  readonly sourceCommit: string;
  readonly releaseCertified: false;
  readonly targets: readonly ['windows-x64-nsis', 'windows-x64-portable', 'linux-x64-AppImage', 'cloudflare-pages'];
  readonly inputs: { readonly webSha256: string; readonly desktopSha256: string; readonly manualSha256: string };
  readonly desktop: {
    readonly windows: { readonly platform: 'win32'; readonly arch: 'x64'; readonly candidate: Readonly<Record<string, unknown>>;
      readonly candidateSha256: string; readonly packageManifestSha256: string;
      readonly assets: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[] };
    readonly linux: { readonly platform: 'linux'; readonly arch: 'x64'; readonly candidate: Readonly<Record<string, unknown>>;
      readonly candidateSha256: string; readonly packageManifestSha256: string;
      readonly assets: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[] };
  };
  readonly web: { readonly platform: 'cloudflare-pages'; readonly buildId: string; readonly webBuildSha256: string;
    readonly offlineAssetsSha256: string; readonly totalBytes: number;
    readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[] };
  readonly manual: { readonly buildId: string; readonly pdfVolumes: number;
    readonly volumes: readonly { readonly id: string; readonly title: string; readonly html: string; readonly pdf: string }[] };
}
export function createReleaseManifest(inputs: ReleaseManifestInput): Promise<ReleaseManifest>;
export function verifyReleaseManifest(manifest: unknown, inputs: ReleaseManifestInput): Promise<ReleaseManifest>;
