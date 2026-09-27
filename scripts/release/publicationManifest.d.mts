import type { ReleaseManifestInput } from './releaseManifest.mjs';

export interface PublicationFileRecord { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface PublicationSizeSummary {
  readonly files: number;
  readonly totalBytes: number;
  readonly largest: { readonly path: string; readonly bytes: number } | null;
}
export interface PublicationSizes {
  readonly limits: { readonly pagesFileBytes: number; readonly pagesFiles: number; readonly releaseAssetBytes: number };
  readonly web: PublicationSizeSummary & { readonly headroomBytes: number; readonly fileHeadroom: number;
    readonly categories: Readonly<Record<string, PublicationSizeSummary>> };
  readonly desktop: { readonly windows: PublicationSizeSummary; readonly linux: PublicationSizeSummary };
}
export interface OcctRestoration {
  readonly manifest: PublicationFileRecord;
  readonly compression: 'gzip';
  readonly parts: readonly PublicationFileRecord[];
  readonly restored: { readonly bytes: number; readonly sha256: string };
}
export interface PublicationManifestInput {
  readonly release: ReleaseManifestInput;
  readonly releaseManifestBytes: Uint8Array;
  readonly sbomBytes: Uint8Array;
  readonly captureRegistryBytes: Uint8Array;
}
export interface PublicationManifest {
  readonly format: 'pointercad-publication/1';
  readonly version: string;
  readonly tag: string | null;
  readonly sourceCommit: string;
  readonly releaseCertified: false;
  readonly targets: readonly string[];
  readonly records: {
    readonly releaseManifest: { readonly format: 'pointercad-release/1'; readonly sha256: string };
    readonly sbom: { readonly format: 'CycloneDX'; readonly sha256: string; readonly serialNumber: string;
      readonly components: number; readonly distributedFilesChecked: number };
    readonly captureRegistry: { readonly path: string; readonly sha256: string };
    readonly desktop: { readonly windows: string; readonly linux: string };
    readonly web: { readonly buildId: string; readonly webBuildSha256: string; readonly offlineAssetsSha256: string;
      readonly serviceWorkerSha256: string; readonly headersSha256: string };
    readonly manual: { readonly buildId: string; readonly pdfVolumes: number; readonly manifestSha256: string;
      readonly pdfManifestSha256: string };
  };
  readonly versions: Readonly<Record<string, string>>;
  readonly runtimes: {
    readonly occt: OcctRestoration;
    readonly exactMath: PublicationFileRecord;
    readonly scriptVm: PublicationFileRecord;
    readonly fonts: readonly PublicationFileRecord[];
  };
  readonly sizes: PublicationSizes;
}
export interface PublicationSizeInput { readonly path?: string; readonly name?: string; readonly bytes: number }

export const PUBLICATION_FORMAT: 'pointercad-publication/1';
export const PUBLICATION_LIMITS: { readonly pagesFileBytes: number; readonly pagesFiles: number; readonly releaseAssetBytes: number };
export const PUBLICATION_RUNTIMES: readonly string[];
export const CAPTURE_REGISTRY_PATH: string;
export function publicationCategory(path: string): string;
export function measurePublicationSizes(webFiles: readonly PublicationSizeInput[],
  desktop: { readonly windows: readonly PublicationSizeInput[]; readonly linux: readonly PublicationSizeInput[] }): PublicationSizes;
/** Throws when the Pages headers would decode the compressed kernel on the way or not serve it as octet-stream. */
export function checkKernelDeliveryHeaders(headersBytes: Uint8Array, files: readonly string[]): void;
export function restoreOcctKernel(web: ReadonlyMap<string, Uint8Array>): OcctRestoration;
export function createPublicationManifest(inputs: PublicationManifestInput): Promise<PublicationManifest>;
export function verifyPublicationManifest(manifest: unknown, inputs: PublicationManifestInput): Promise<PublicationManifest>;
