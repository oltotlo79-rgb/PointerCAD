// CycloneDX 1.6 `licenses[]` entries are either a single license id/name, or (for a
// combination the original notice text itself states - "A OR B", "A AND B", "A WITH B")
// a full SPDX license expression string; the two shapes are alternatives, never combined.
export type SbomLicense =
  | { readonly license: { readonly id: string } }
  | { readonly expression: string };
export interface SbomHash {
  readonly alg: 'SHA-256';
  readonly content: string;
}
export interface SbomExternalReference {
  readonly type: string;
  readonly url: string;
}
export interface SbomProperty {
  readonly name: string;
  readonly value: string;
}
export interface SbomComponent {
  readonly type: 'library' | 'file';
  readonly name: string;
  readonly version?: string;
  readonly purl?: string;
  readonly licenses?: readonly SbomLicense[];
  readonly hashes?: readonly SbomHash[];
  readonly externalReferences?: readonly SbomExternalReference[];
  readonly properties?: readonly SbomProperty[];
}
export interface SbomComponents {
  readonly components: readonly SbomComponent[];
  readonly unresolvedNotices: readonly string[];
}
/**
 * Loose counterpart of SbomComponent/SbomComponents accepted by assembleSbomDocument: `type`
 * and hash `alg` are plain `string` (not the literal unions above) because that function's own
 * job is to validate an untrusted-shaped record at runtime and reject the very values these
 * literal unions would otherwise make un-representable to callers testing that rejection.
 */
export interface SbomComponentInput {
  readonly type: string;
  readonly name: string;
  readonly version?: string;
  readonly purl?: string;
  readonly licenses?: readonly SbomLicense[];
  readonly hashes?: readonly { readonly alg: string; readonly content: string }[];
  readonly externalReferences?: readonly SbomExternalReference[];
  readonly properties?: readonly SbomProperty[];
}
export interface SbomComponentsInput {
  readonly components: readonly SbomComponentInput[];
  readonly unresolvedNotices?: readonly string[];
}
export interface SbomDocument {
  readonly bomFormat: 'CycloneDX';
  readonly specVersion: '1.6';
  readonly serialNumber: string;
  readonly version: 1;
  readonly metadata: {
    readonly timestamp?: string;
    readonly component: { readonly type: 'application'; readonly name: 'PointerCAD'; readonly version: string };
    readonly properties: readonly SbomProperty[];
  };
  readonly components: readonly SbomComponent[];
}
export interface SbomAssembleOptions {
  readonly rootPackageVersion: string;
  readonly sourceCommit?: string;
  readonly generatedAt?: string;
}
export interface SbomBuildOptions {
  readonly sourceCommit?: string;
  readonly generatedAt?: string;
}
export interface SbomGapReport {
  readonly unresolvedNotices: readonly string[];
  readonly unclassifiedLicenses: readonly string[];
  readonly noLicenseInformation: readonly string[];
}
export interface ReleaseManifestFileLike {
  readonly path: string;
  readonly sha256: string;
}
export interface ReleaseManifestLike {
  readonly web: { readonly files: readonly ReleaseManifestFileLike[] };
}
export interface SbomManifestMatch {
  readonly checked: number;
  readonly missing: readonly { readonly path: string; readonly component: string }[];
  readonly mismatched: readonly { readonly path: string; readonly component: string; readonly expected: string; readonly actual: string }[];
}

export function deterministicUuid(seed: string): string;
export function verifyFontAssetParity(root: string): Map<string, string>;
export function collectSbomComponents(root?: string): SbomComponents;
export function assembleSbomDocument(collected: SbomComponentsInput, options: SbomAssembleOptions): SbomDocument;
export function buildSbom(root?: string, options?: SbomBuildOptions): SbomDocument;
// The four functions below validate a JSON-like document at runtime (a saved sbom.json or
// release-manifest.json, or a hand-built test fixture); `unknown` reflects that contract
// instead of asserting a shape the function exists to check.
export function findSbomGaps(sbom: unknown): SbomGapReport;
export function assertSbomPublishable(sbom: unknown): void;
export function matchSbomToReleaseManifest(sbom: unknown, releaseManifest: unknown): SbomManifestMatch;
export function assertSbomMatchesReleaseManifest(sbom: unknown, releaseManifest: unknown): void;
