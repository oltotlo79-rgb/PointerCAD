export const DEDICATED_EVIDENCE_PLAN_FORMAT: 'pointercad-dedicated-evidence-plan/1';
export const DEDICATED_W21_HOSTS: readonly ['functional', 'firefox', 'electron'];
export const DEDICATED_W22_SCENARIOS: readonly ['input', 'ADD-23', 'ADD-17', 'hemisphere'];
export const DEDICATED_EVIDENCE_EXIT: Readonly<{ done: 0; refused: 1; ratioOnly: 3; usage: 64 }>;
export const DEDICATED_SOURCE_ROLES: Readonly<{ config: string; flow: string; electronHelper: string; electronSpec: string; browserSpec: string }>;
export class DedicatedEvidenceUsageError extends Error {}
export interface DedicatedQaManifest {
  schema_version: 1;
  checkout: string;
  hash: string;
  files: { path: string; copy_sha256: string }[];
}
export function sourceCopyBytes(bytes: Uint8Array): Uint8Array;
export function dedicatedQaManifest(input: { web: Record<string, string>; desktop: Record<string, string>;
  sources: Record<string, Uint8Array>; checkout: string }): DedicatedQaManifest;
export function changedManifestInputs(manifest: unknown, readHash: (path: string) => string | null): string[];
export interface DedicatedEvidenceIndex {
  records: Record<string, { path: string; sha256: string }>;
  manifest: string;
  w21: Record<string, string>[];
  w22: Record<string, string | Record<string, string>>[];
}
export function assembleDedicatedEvidenceIndex(plan: unknown, readBytes: (path: string) => Uint8Array,
  sourceCopies: Record<string, { path: string; bytes: Uint8Array }>):
  { index: DedicatedEvidenceIndex; records: Record<string, { path: string; sha256: string; bytes: Uint8Array }> };
export function collectPlanPaths(plan: unknown): string[];
export function runBuildDedicatedEvidenceIndex(args: readonly string[],
  options?: { root?: string; write?: (text: string) => void;
    captureInputs?: (root: string) => Promise<{ web: Record<string, string>; desktop: Record<string, string> }>;
    listTestSources?: (root: string) => readonly string[] | Promise<readonly string[]> }): Promise<number>;
