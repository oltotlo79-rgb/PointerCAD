import type { CaptureRegistry } from '../manual/captureRegistry.mjs';
import type { OfflineAssetInput } from '../vite/offlineAssets.mjs';
import type { ReleaseCandidateInput, ReleaseManifestInput } from './releaseManifest.mjs';

/** manual: one generated manual only (P12-20), with the same manual checks that pre-release runs (P13-15). */
export type ReleaseReadinessMode = 'pre-release' | 'post-release' | 'manual';
/** all: every condition, the Web ones included. desktop: the desktop-first release (2026-09-27); Web-only conditions are deferred. */
export type ReleaseReadinessScope = 'all' | 'desktop';
/** deferred: a Web-only condition in the desktop scope, judged for reference and left for the Web publication. */
export type ReleaseReadinessStatus = 'pass' | 'fail' | 'pending' | 'not-implemented' | 'deferred';

export interface ReleaseReadinessCheck {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly status: ReleaseReadinessStatus;
  readonly summary: string;
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}
export interface ReleaseReadinessReport {
  readonly format: 'pointercad-release-readiness/1';
  readonly mode: ReleaseReadinessMode;
  readonly scope: ReleaseReadinessScope;
  /** The gate never certifies publication; the post-release check against the real URLs is separate (P13-20). */
  readonly releaseCertified: false;
  readonly checks: readonly ReleaseReadinessCheck[];
  /** Deferred checks do not block exit code 0 (desktop scope only). */
  readonly summary: { readonly pass: number; readonly fail: number; readonly pending: number; readonly notImplemented: number;
    readonly deferred: number };
  readonly exitCode: number;
}

export interface CurrentHelpChapter {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly volumeId: string;
  readonly order: number;
}
export interface CurrentHelpVolume {
  readonly id: string;
  readonly title: string;
  readonly topics: readonly string[];
}
export interface CurrentHelpFeatureEntry {
  readonly id: string;
  readonly topicIds: readonly string[];
  readonly pending?: string;
  readonly mergedInto?: string;
}
export interface CurrentHelpFeatureCoverage {
  readonly entries: readonly CurrentHelpFeatureEntry[];
  readonly pending: readonly string[];
}
export interface CurrentHelpCommandEntry {
  readonly commandId: string;
  readonly topicId: string;
  readonly chapterPath: string;
}
export interface ManualEditionVerification {
  readonly manualBuildId: string;
  readonly chapters: number;
  readonly images: number;
}
/** The current help, read from the same sources the application uses (loadCurrentHelp) or built by a test. */
export interface CurrentHelpEdition {
  readonly chapters: readonly CurrentHelpChapter[];
  readonly volumes: readonly CurrentHelpVolume[];
  readonly featureCoverage: CurrentHelpFeatureCoverage;
  readonly commandCoverage: readonly CurrentHelpCommandEntry[];
  /** Chapter id → Markdown source, including its {{ui:key}} references. */
  readonly chapterSources: ReadonlyMap<string, string>;
  /** Today's screen labels (the ja message table). */
  readonly uiLabels: Readonly<Record<string, string>>;
  /** help-content's assertDocumentedFeatureCoverage: throws while a feature has no written explanation. */
  readonly assertDocumentedFeatureCoverage: (coverage: CurrentHelpFeatureCoverage) => void;
  /** Whole-edition equality with the current help (verifyCurrentManualEdition); throws on the first difference. */
  readonly verifyManualEdition: (manualFiles: readonly OfflineAssetInput[]) => ManualEditionVerification | Promise<ManualEditionVerification>;
}

export interface CaptureFreshnessRequest {
  readonly manualBuildId: string;
  readonly sourceCommit: string | null;
  readonly images: readonly { readonly path: string; readonly sha256: string }[];
}
export interface CaptureFreshnessResult {
  /** Images that are not the current build's capture output. */
  readonly stale: readonly string[];
  /** Images that the capture registry does not list. */
  readonly unregistered: readonly string[];
  readonly notes?: readonly string[];
}
export type CaptureFreshnessHook = (request: CaptureFreshnessRequest) => CaptureFreshnessResult | Promise<CaptureFreshnessResult>;

export interface PreReleaseInput {
  readonly mode: 'pre-release';
  /** Omitted: all. */
  readonly scope?: ReleaseReadinessScope;
  readonly packageFiles: ReleaseManifestInput['packageFiles'];
  readonly builderConfig: string;
  readonly readme: string;
  /** null when the part could not be read; readErrors gives the reason and the dependent checks fail. */
  readonly sourceCommit: string | null;
  readonly sourceInputs: ReleaseManifestInput['sourceInputs'] | null;
  readonly candidates: readonly ReleaseCandidateInput[] | null;
  readonly webFiles: readonly OfflineAssetInput[] | null;
  readonly releaseManifest: Uint8Array | null;
  readonly sbom: Uint8Array | null;
  readonly currentHelp: CurrentHelpEdition | null;
  /** null makes condition ④ pending (exit code 2); loadCaptureFreshness() always returns a working hook. */
  readonly captureFreshness: CaptureFreshnessHook | null;
  readonly readErrors?: Readonly<Record<string, string>>;
}
/** One download from the published release; sha256 is null unless status is 200. */
export interface ReleaseDownloadResult {
  readonly status: number;
  readonly bytes: number;
  readonly sha256: string | null;
}
export type ReleaseDownloadHook = (url: string) => ReleaseDownloadResult | Promise<ReleaseDownloadResult>;
/** Whole post-release mode (Web included): still an entry point only (exit code 3) until the Web version is published. */
export interface PostReleaseInput {
  readonly mode: 'post-release';
  readonly scope?: 'all';
  readonly releaseManifest: Uint8Array | null;
  readonly webUrl: string;
  readonly downloadUrl: string;
  readonly readErrors?: Readonly<Record<string, string>>;
}
/** Desktop part of post-release mode: the GitHub Release's packages and manual PDFs, and README's Desktop links. */
export interface PostReleaseDesktopInput {
  readonly mode: 'post-release';
  readonly scope: 'desktop';
  /** null when dist/<release>/release-manifest.json could not be read; readErrors.releaseManifest gives the reason. */
  readonly releaseManifest: Uint8Array | null;
  readonly downloadUrl: string;
  /** README.md of the released commit; null when unreadable (readErrors.readme). */
  readonly readme: string | null;
  /** createReleaseDownloader() for the real release; a test passes a fake one. */
  readonly download: ReleaseDownloadHook | null;
  readonly readErrors?: Readonly<Record<string, string>>;
}
/** Manual mode: dist/<name>/ from scripts/manual/generate.mjs (paths relative to that folder) against the current help. */
export interface ManualReleaseInput {
  readonly mode: 'manual';
  /** null when the manual could not be read; readErrors.manual gives the reason and every check fails. */
  readonly manualFiles: readonly OfflineAssetInput[] | null;
  readonly currentHelp: CurrentHelpEdition | null;
  /** null makes condition ④ pending (exit code 2); loadCaptureFreshness() always returns a working hook. */
  readonly captureFreshness: CaptureFreshnessHook | null;
  readonly readErrors?: Readonly<Record<string, string>>;
}
export type ReleaseReadinessInput = PreReleaseInput | PostReleaseInput | PostReleaseDesktopInput | ManualReleaseInput;

export interface ReleaseReadinessOptions {
  readonly mode: ReleaseReadinessMode;
  /** parseReleaseReadinessArguments always sets it (all when --scope is not given). */
  readonly scope?: ReleaseReadinessScope;
  readonly windows?: string;
  readonly linux?: string;
  readonly web?: string;
  readonly release?: string;
  readonly sbom?: string;
  readonly webUrl?: string;
  readonly downloadUrl?: string;
  readonly manual?: string;
  readonly report?: string;
}
export interface ReadmeReleaseLinkRow {
  readonly kind: 'windows-installer' | 'windows-portable' | 'linux-appimage' | 'manual' | 'web-app';
  readonly label: string;
  readonly keywords: readonly string[];
}
export interface ReadmeReleaseLinkResult {
  readonly problems: readonly string[];
  readonly summary: string;
  /** asset: the release asset's file name, for links into a GitHub Release. */
  readonly links: readonly { readonly kind: string; readonly url: string; readonly asset?: string }[];
}

export const RELEASE_READINESS_FORMAT: 'pointercad-release-readiness/1';
export const RELEASE_READINESS_EXIT: {
  readonly ready: 0; readonly failed: 1; readonly pending: 2; readonly notImplemented: 3; readonly usage: 64; readonly internal: 70;
};
export const RELEASE_READINESS_CHECK_IDS: readonly string[];
/** The manual checks: manual mode runs only these; pre-release mode runs them among its fourteen. */
export const MANUAL_CHECK_IDS: readonly string[];
export const PAGES_MAX_FILES: number;
export const PAGES_MAX_FILE_BYTES: number;
export const CAPTURE_REGISTRY_PENDING: string;
export const RELEASE_LINKS_START: string;
export const RELEASE_LINKS_END: string;
export const README_LINK_ROWS: readonly ReadmeReleaseLinkRow[];
export const RELEASE_READINESS_SCOPES: readonly ReleaseReadinessScope[];
export const WEB_DEFERRED_PHRASE: string;
/** Checks that the desktop scope reports as deferred (Cloudflare's limits on the Web files). */
export const DESKTOP_DEFERRED_CHECK_IDS: readonly string[];
export const POST_RELEASE_DESKTOP_CHECK_IDS: readonly string[];
export const RELEASE_DOWNLOAD_MAX_BYTES: number;
/** PointerCAD-<version>-manual-<volume>.pdf: one manual PDF volume attached to the GitHub Release. */
export function manualPdfReleaseAssetName(version: string, volumeId: string): string;

export class ReleaseReadinessUsageError extends Error {
  constructor(message: string);
}
export function evaluateReleaseReadiness(input: ReleaseReadinessInput): Promise<ReleaseReadinessReport>;
/** volumeIds null: the volume list is unknown, so PDF links are only required to exist. scope omitted: all. */
export function checkReadmeReleaseLinks(readme: string,
  expected: { readonly version: string; readonly volumeIds: readonly string[] | null; readonly scope?: ReleaseReadinessScope }): ReadmeReleaseLinkResult;
export function formatReleaseReadinessReport(report: ReleaseReadinessReport, context?: { readonly targets?: readonly string[] }): string;
export function parseReleaseReadinessArguments(args: readonly string[]): ReleaseReadinessOptions;
export function loadCurrentHelp(root: string): Promise<CurrentHelpEdition>;
/** The registry match behind loadCaptureFreshness(), callable with a fabricated CaptureRegistry for tests. */
export function captureFreshnessFromRegistry(registry: CaptureRegistry, files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  options: { readonly applicationBuildId: string; readonly scripts?: ReadonlyMap<string, Uint8Array>;
    /** The manual's own copies; one that differs from `files` (the capture folder's current bytes) is stale. */
    readonly manualImages?: CaptureFreshnessRequest['images'] }): CaptureFreshnessResult;
export function loadCaptureFreshness(): CaptureFreshnessHook;
export function readPreReleaseInput(root: string, options: ReleaseReadinessOptions): Promise<PreReleaseInput>;
export function readManualInput(root: string, options: ReleaseReadinessOptions): Promise<ManualReleaseInput>;
export function readPostReleaseInput(root: string, options: ReleaseReadinessOptions,
  context?: { readonly download?: ReleaseDownloadHook | null }): Promise<PostReleaseInput | PostReleaseDesktopInput>;
/** Streams the body into SHA-256 (redirects followed); any status but 200 is returned without reading the body. */
export function createReleaseDownloader(options?: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number;
  readonly maxBytes?: number }): ReleaseDownloadHook;
export function runReleaseReadiness(args: readonly string[],
  options?: { readonly root?: string; readonly write?: (text: string) => void; readonly download?: ReleaseDownloadHook | null }): Promise<number>;
