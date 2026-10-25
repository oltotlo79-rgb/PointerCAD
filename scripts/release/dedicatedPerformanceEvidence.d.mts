export interface DedicatedRawReference { path: string; sha256: string; bytes: Uint8Array }
export interface DedicatedPerformanceEvidence {
  records: Record<string, DedicatedRawReference>;
  manifest: string;
  currentInputs: Record<string, string>;
  w21?: readonly Record<string, unknown>[];
  w22?: readonly Record<string, unknown>[];
}
export function loadDedicatedPerformanceEvidence(root: string, path: string, expectedSha256: string,
  sourceInputs?: { web: Record<string, string>; desktop: Record<string, string> } | null): Promise<DedicatedPerformanceEvidence>;
export function readDedicatedPlaywrightTests(report: unknown): readonly { project: string; title: string; titles: string[]; result: Record<string, unknown> }[];
export function checkDedicatedPerformanceEvidence(kind: string, evidence: unknown,
  sourceInputs: { web: Record<string, string>; desktop: Record<string, string> } | null | undefined):
  { status: 'pending' | 'pass' | 'fail'; summary: string; problems?: string[] };
