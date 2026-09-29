export const KNOWN_UNUSED_CAPTURE_NAMES: Readonly<Record<string, string>>;
export interface UnusedCaptureNamesResult {
  readonly flowFiles: number;
  readonly captureNames: number;
  readonly unresolvedCalls: readonly { readonly path: string; readonly calls: number; readonly literalNames: number }[];
  readonly unused: readonly string[];
  readonly known: readonly { readonly name: string; readonly reason: string }[];
  readonly newlyFound: readonly string[];
  readonly staleKnownEntries: readonly string[];
}
export function checkUnusedCaptureNames(
  flowSources: readonly { readonly path: string; readonly text: string }[],
  chapters: readonly { readonly name: string; readonly text: string }[],
): UnusedCaptureNamesResult;
