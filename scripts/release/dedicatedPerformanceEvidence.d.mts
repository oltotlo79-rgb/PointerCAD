export interface DedicatedRawReference { path: string; sha256: string; bytes: Uint8Array }
export interface DedicatedPerformanceEvidence {
  records: Record<string, DedicatedRawReference>;
  manifest: string;
  currentInputs: Record<string, string>;
  w21?: readonly Record<string, unknown>[];
  w22?: readonly Record<string, unknown>[];
}
/** One W21 host × network: the recorded cold/warm medians and whether the original warm <= cold * 0.8 condition holds. */
export interface DedicatedW21Ratio {
  readonly project: string;
  readonly network: 'online' | 'offline';
  readonly coldMedianMs: number;
  readonly warmMedianMs: number;
  readonly ratio: number;
  readonly meetsOriginalCondition: boolean;
}
export function loadDedicatedPerformanceEvidence(root: string, path: string, expectedSha256: string,
  sourceInputs?: { web: Record<string, string>; desktop: Record<string, string> } | null): Promise<DedicatedPerformanceEvidence>;
export function readDedicatedPlaywrightTests(report: unknown): readonly { project: string; title: string; titles: string[]; result: Record<string, unknown> }[];
/**
 * w21Ratios accompanies a W21 result whose thirty pairs were all qualified; ratioOnly is true only when the original
 * twenty-percent condition is the sole reason for refusal.
 */
export function checkDedicatedPerformanceEvidence(kind: string, evidence: unknown,
  sourceInputs: { web: Record<string, string>; desktop: Record<string, string> } | null | undefined):
  { status: 'pending' | 'pass' | 'fail'; summary: string; problems?: string[]; w21Ratios?: readonly DedicatedW21Ratio[]; ratioOnly?: boolean };
