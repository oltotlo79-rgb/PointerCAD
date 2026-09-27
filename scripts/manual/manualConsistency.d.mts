export interface ExpectedManualEdition {
  readonly chapters: readonly unknown[];
  readonly volumes: readonly unknown[];
  readonly featureCoverage: unknown;
  readonly commandCoverage: unknown;
  readonly supplementaryCoverage: unknown;
  readonly nativeControlCoverage: unknown;
  readonly pages: ReadonlyMap<string, string>;
  readonly images: ReadonlyMap<string, Uint8Array>;
}
export function verifyManualConsistency(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  expected: ExpectedManualEdition,
): { readonly manualBuildId: string; readonly chapters: number; readonly images: number;
  readonly contentMatchesCurrentHelp: true; readonly releaseCertified: false };
