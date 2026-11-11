import type { ESLint } from 'eslint';
export interface LintGroup { label: string; args: string[] }
export interface LintResult {
  group: LintGroup;
  status: number;
  signal: string | null;
  seconds: number;
  output: string;
}
export function listLintGroups(rootDir?: string): LintGroup[];
export function lintParallelism(raw?: string): number;
export function lintGroupParts(group: LintGroup, rootDir?: string, engine?: Pick<ESLint, 'isPathIgnored'>): Promise<LintGroup[]>;
export function combineLintResults(group: LintGroup, results: LintResult[]): LintResult;
