export interface Sha256SumEntry {
  readonly name: string;
  readonly sha256: string;
}
export interface DesktopCandidateAssets {
  readonly platform: 'win32' | 'linux';
  readonly version: string;
  readonly assets: ReadonlyMap<string, string>;
}
export interface BuildSha256SumsInput {
  readonly folder: string;
  readonly windowsStage: string;
  readonly linuxStage: string;
}
export interface BuildSha256SumsResult {
  readonly path: string;
  readonly entries: readonly Sha256SumEntry[];
  readonly content: string;
}
export function collectReleaseFileDigests(folder: string): Promise<Sha256SumEntry[]>;
export function readDesktopCandidateAssets(stagePath: string): Promise<DesktopCandidateAssets>;
export function verifyReleaseDigestsAgainstCandidates(entries: readonly Sha256SumEntry[],
  candidateAssetSets: readonly DesktopCandidateAssets[]): void;
export function formatSha256Sums(entries: readonly Sha256SumEntry[]): string;
export function buildSha256Sums(input: BuildSha256SumsInput): Promise<BuildSha256SumsResult>;
