export interface RuntimeCycleReport {
  files: string[];
  sourceHashes: Record<string, string>;
  edges: string[][];
  cycles: string[][];
  diagnostics: string[];
  ok: boolean;
}
export function isRuntimeProductSource(name: string): boolean;
export function inspectRuntimeCycles(rootDir: string, virtualFiles?: ReadonlyMap<string, string>): RuntimeCycleReport;
export function formatRuntimeCycleDiagnostics(result: RuntimeCycleReport): string;
