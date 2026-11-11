export interface UnusedExportRow {
  key: string;
  path: string;
  line: number;
  name: string;
  kind: string;
  typeOnly: boolean;
  users?: number;
}
export interface UnresolvedImport { path: string; line: number; spec: string; kind: string }
export interface WholeModuleUse { path: string; line: number; spec: string; target: string }
export interface UnusedExportReport {
  files: number;
  dead: UnusedExportRow[];
  internalOnly: UnusedExportRow[];
  testOnly: UnusedExportRow[];
  orphanModules: string[];
  unresolved: UnresolvedImport[];
  wholeModuleUses: WholeModuleUse[];
}
export function isInventorySource(name: string): boolean;
export function classifyInventoryFile(file: string): 'tool' | 'e2e-spec' | 'e2e-support' | 'config' | 'test' | 'product';
export function collectExportFacts(file: string, text: string): unknown;
export function inspectUnusedExports(rootDir: string, virtualFiles?: ReadonlyMap<string, string>): UnusedExportReport;
export function newUnusedExports(rows: readonly UnusedExportRow[], baselineKeys: readonly string[]): UnusedExportRow[];
