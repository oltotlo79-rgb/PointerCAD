import type { CaptureRegistry } from '../manual/captureRegistry.mjs';
import type { OfflineAssetInput } from '../vite/offlineAssets.mjs';
import type { ReleaseCandidateInput, ReleaseManifestInput } from './releaseManifest.mjs';

export type ReleaseReadinessMode = 'pre-release' | 'post-release';
export type ReleaseReadinessStatus = 'pass' | 'fail' | 'pending' | 'not-implemented';

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
  /** The gate never certifies publication; the post-release check against the real URLs is separate (P13-20). */
  readonly releaseCertified: false;
  readonly checks: readonly ReleaseReadinessCheck[];
  readonly summary: { readonly pass: number; readonly fail: number; readonly pending: number; readonly notImplemented: number };
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
export interface PostReleaseInput {
  readonly mode: 'post-release';
  readonly releaseManifest: Uint8Array | null;
  readonly webUrl: string;
  readonly downloadUrl: string;
  readonly readErrors?: Readonly<Record<string, string>>;
}
export type ReleaseReadinessInput = PreReleaseInput | PostReleaseInput;

export interface ReleaseReadinessOptions {
  readonly mode: ReleaseReadinessMode;
  readonly windows?: string;
  readonly linux?: string;
  readonly web?: string;
  readonly release?: string;
  readonly sbom?: string;
  readonly webUrl?: string;
  readonly downloadUrl?: string;
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
  readonly links: readonly { readonly kind: string; readonly url: string }[];
}

export const RELEASE_READINESS_FORMAT: 'pointercad-release-readiness/1';
export const RELEASE_READINESS_EXIT: {
  readonly ready: 0; readonly failed: 1; readonly pending: 2; readonly notImplemented: 3; readonly usage: 64; readonly internal: 70;
};
export const RELEASE_READINESS_CHECK_IDS: readonly string[];
export const PAGES_MAX_FILES: number;
export const PAGES_MAX_FILE_BYTES: number;
export const CAPTURE_REGISTRY_PENDING: string;
export const RELEASE_LINKS_START: string;
export const RELEASE_LINKS_END: string;
export const README_LINK_ROWS: readonly ReadmeReleaseLinkRow[];

export class ReleaseReadinessUsageError extends Error {
  constructor(message: string);
}
export function evaluateReleaseReadiness(input: ReleaseReadinessInput): Promise<ReleaseReadinessReport>;
/** volumeIds null: the volume list is unknown, so PDF links are only required to exist. */
export function checkReadmeReleaseLinks(readme: string,
  expected: { readonly version: string; readonly volumeIds: readonly string[] | null }): ReadmeReleaseLinkResult;
export function formatReleaseReadinessReport(report: ReleaseReadinessReport, context?: { readonly targets?: readonly string[] }): string;
export function parseReleaseReadinessArguments(args: readonly string[]): ReleaseReadinessOptions;
export function loadCurrentHelp(root: string): Promise<CurrentHelpEdition>;
/** The registry match behind loadCaptureFreshness(), callable with a fabricated CaptureRegistry for tests. */
export function captureFreshnessFromRegistry(registry: CaptureRegistry, files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  options: { readonly applicationBuildId: string; readonly scripts?: ReadonlyMap<string, Uint8Array> }): CaptureFreshnessResult;
export function loadCaptureFreshness(): CaptureFreshnessHook;
export function readPreReleaseInput(root: string, options: ReleaseReadinessOptions): Promise<PreReleaseInput>;
export function runReleaseReadiness(args: readonly string[],
  options?: { readonly root?: string; readonly write?: (text: string) => void }): Promise<number>;
