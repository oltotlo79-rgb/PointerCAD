export const CAPTURE_REGISTRY_FORMAT: 'pointercad-capture-registry/1';
export const CAPTURE_CHAPTER_FOLDER: 'packages/help-content/docs/ja';
export const CAPTURE_IMAGE_FOLDER: 'packages/help-content/docs/ja/images';
export const CAPTURE_REGISTRY_FILE: 'capture-manifest.json';

export type CaptureSize = readonly [number, number];
export interface CaptureViewportPolicy {
  readonly standard: CaptureSize;
  readonly tallException: CaptureSize;
  readonly rule: string;
}
export const CAPTURE_VIEWPORT_POLICY: CaptureViewportPolicy;

export type CaptureUnknownReason =
  | 'no-capture-record' | 'no-capture-time' | 'build-id-null' | 'legacy-no-hash' | 'legacy-no-build-id'
  | 'no-script-path' | 'image-source-no-hash' | 'image-source-no-build-id';
export const CAPTURE_UNKNOWN_REASONS: Readonly<Record<CaptureUnknownReason, string>>;

export type CaptureViewportClass = 'standard' | 'tall-exception' | 'needs-recapture';
export type CaptureViewportSource = 'capture-details' | 'image-sources' | 'capture-manifest' | 'png-size';
export type CaptureProvenanceField = 'script' | 'scriptSha256' | 'fixtureSha256' | 'capturedAt' | 'applicationBuildId';

/** A former entry of the capture-manifest.json array, kept verbatim. */
export interface LegacyCaptureManifestEntry {
  readonly file: string;
  readonly testRun: string;
  readonly testSource: string;
  readonly viewport: CaptureSize;
  readonly sha256: string;
  readonly kind: string;
  readonly edited: boolean;
}
export type CaptureRecordRef =
  | { readonly kind: 'capture-details'; readonly file: string; readonly name: string; readonly image: 'detail' | 'screen' }
  | { readonly kind: 'image-sources'; readonly file: string; readonly image: string }
  | { readonly kind: 'capture-manifest'; readonly entry: LegacyCaptureManifestEntry };

export interface CaptureRegistryEntry {
  readonly file: string;
  readonly sha256: string;
  readonly viewport: CaptureSize;
  readonly viewportClass: CaptureViewportClass;
  readonly viewportSource: CaptureViewportSource;
  readonly script: string | null;
  readonly scriptSha256: string | null;
  readonly fixtureSha256: string | null;
  readonly capturedAt: string | null;
  readonly applicationBuildId: string | null;
  /** The reason for each null provenance value. */
  readonly unknown: Readonly<Partial<Record<CaptureProvenanceField, CaptureUnknownReason>>>;
  /** Capture records that vouch for these exact bytes; empty for an image without any capture record. */
  readonly records: readonly CaptureRecordRef[];
}
export interface CaptureRegistry {
  readonly format: 'pointercad-capture-registry/1';
  readonly viewportPolicy: CaptureViewportPolicy;
  readonly unknownReasons: Readonly<Record<CaptureUnknownReason, string>>;
  readonly images: readonly CaptureRegistryEntry[];
}

export interface CaptureFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}
export interface CaptureChapter {
  readonly name: string;
  readonly text: string;
}
export interface CaptureFolder {
  readonly files: readonly CaptureFile[];
  readonly chapters: readonly CaptureChapter[];
}
export interface CaptureAudit {
  readonly images: number;
  readonly registered: number;
  readonly referenced: number;
  readonly unregistered: readonly string[];
  readonly missingImages: readonly string[];
  readonly shaMismatches: readonly { readonly file: string; readonly registered: string; readonly actual: string }[];
  readonly pixelConflicts: readonly { readonly file: string; readonly pixels: CaptureSize | null; readonly viewport: CaptureSize }[];
  readonly missingReferencedImages: readonly { readonly image: string; readonly chapters: readonly string[] }[];
  readonly unreferenced: readonly string[];
  readonly viewportOutsidePolicy: readonly string[];
  readonly withoutCaptureRecord: readonly string[];
  readonly viewportClasses: Readonly<Partial<Record<CaptureViewportClass, number>>>;
  readonly viewportSources: Readonly<Partial<Record<CaptureViewportSource, number>>>;
}
export interface CaptureImageAssessment {
  readonly checked: number;
  readonly unregistered: readonly string[];
  readonly mismatched: readonly string[];
  /** Registered without an application build id, so the version it shows cannot be confirmed. */
  readonly buildUnknown: readonly string[];
  readonly buildMismatch: readonly string[];
  readonly scriptChanged: readonly string[];
  readonly scriptMissing: readonly string[];
  /** True only when every list above is empty. */
  readonly current: boolean;
}

export class CaptureRegistryError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]);
}
export function sha256Hex(bytes: Uint8Array): string;
/** SHA-256 (hex) fingerprint of the Web app's own build inputs, excluding the manual's docs. See captureRegistry.mjs. */
export function applicationInputDigest(root: string): Promise<string>;
export function readPngSize(bytes: Uint8Array): CaptureSize;
export function classifyCaptureViewport(viewport: CaptureSize): CaptureViewportClass;
export function collectChapterImageReferences(chapters: readonly CaptureChapter[]): ReadonlyMap<string, readonly string[]>;
export function validateCaptureRegistry(value: unknown): CaptureRegistry;
export function parseCaptureRegistry(text: string): CaptureRegistry;
export function buildCaptureRegistry(files: readonly CaptureFile[]): CaptureRegistry;
export function auditCaptureRegistry(registry: CaptureRegistry, folder: CaptureFolder): CaptureAudit;
export function assessCaptureImages(registry: CaptureRegistry, images: Iterable<CaptureFile>, options: {
  readonly applicationBuildId: string;
  readonly scripts?: ReadonlyMap<string, Uint8Array>;
}): CaptureImageAssessment;
export function readCaptureFolder(root: string): Promise<CaptureFolder>;
export function readCaptureRegistry(root: string): Promise<CaptureRegistry>;
export function readCaptureScripts(root: string, registry: CaptureRegistry): Promise<ReadonlyMap<string, Uint8Array>>;
export function formatCaptureRegistry(registry: CaptureRegistry, previousBytes?: Uint8Array | null): string;
