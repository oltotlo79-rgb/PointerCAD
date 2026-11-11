import type { Linter } from 'eslint';
import { collectSites, headStart, identity, isNode, type AstNode, type FunctionSite }
  from './functionSizePolicy.testSupport.js';

/**
 * Per-function parameter-count and nesting-depth baseline (code rule P06). ESLint's own max-params and max-depth
 * find every violation; this module only names the function each report belongs to (same identities as the
 * function-size baseline), so a grandfathered function is held to its own measured value.
 */
export const PARAMS_RULE = 'max-params';
export const DEPTH_RULE = 'max-depth';

const PARAMS_EXCEED = /^.+ has too many parameters \((\d+)\)\. Maximum allowed is (\d+)\.$/u;
const DEPTH_EXCEED = /^Blocks are nested too deeply \((\d+)\)\. Maximum allowed is (\d+)\.$/u;
// The node types ESLint max-params checks.
const PARAM_SITES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'TSDeclareFunction', 'TSFunctionType']);
// The node types for which ESLint max-depth starts a new counter (Program is the module scope).
const DEPTH_SCOPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'StaticBlock']);
export const MODULE_SCOPE = '<module>';

/** [id, value] for parameters; [id, deepest, blocks over the cap] for depth. */
type ComplexityEntry = readonly [id: string, ...values: number[]];

interface ComplexityRow {
  readonly file: string;
  readonly functions: readonly ComplexityEntry[];
}

 interface ComplexityDrift {
  readonly grown: readonly string[];
  readonly stale: readonly string[];
  readonly unlisted: readonly string[];
  readonly obsolete: readonly string[];
  readonly ambiguous: readonly string[];
  readonly duplicateRows: readonly string[];
  readonly withinCap: readonly string[];
  readonly malformed: readonly string[];
}

interface MeasuredComplexity {
  readonly entries: readonly ComplexityEntry[];
  readonly ambiguous: readonly string[];
}

export function complexityConfig(parser: Linter.Parser, rule: string, max: number): Linter.Config {
  return { files: ['**/*.{ts,tsx}'], languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: { [rule]: [2, { max }] } };
}

function lint(linter: Linter, parser: Linter.Parser, filename: string, source: string, rule: string, max: number) {
  const messages = linter.verify(source, [complexityConfig(parser, rule, max)], { filename });
  const fatal = messages.find(message => message.fatal);
  if (fatal) throw new Error(`${filename}: ${fatal.message}`);
  const sourceCode = linter.getSourceCode();
  const ast: unknown = sourceCode.ast;
  if (!isNode(ast)) throw new Error(`${filename}: no program`);
  return { reports: messages.filter(message => message.ruleId === rule), sourceCode, ast };
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) { if (seen.has(id)) repeated.add(id); seen.add(id); }
  return [...repeated].sort();
}

/** Lint one source with ESLint's max-params at `cap` and name every reported function by its head. */
export function measureParams(linter: Linter, parser: Linter.Parser, filename: string, source: string,
  cap: number): MeasuredComplexity {
  const { reports, sourceCode, ast } = lint(linter, parser, filename, source, PARAMS_RULE, cap);
  const byHead = new Map<number, FunctionSite[]>();
  for (const site of collectSites(ast, sourceCode.visitorKeys, PARAM_SITES)) {
    const start = headStart(site, sourceCode.ast.tokens);
    byHead.set(start, [...(byHead.get(start) ?? []), site]);
  }
  const entries: ComplexityEntry[] = reports.map((message) => {
    const counted = PARAMS_EXCEED.exec(message.message);
    if (!counted) throw new Error(`${filename}:${message.line}: unexpected report ${message.message}`);
    const sites = byHead.get(sourceCode.getIndexFromLoc({ line: message.line, column: message.column - 1 })) ?? [];
    const site = sites[0];
    if (sites.length !== 1 || !site) throw new Error(`${filename}:${message.line}: report matches ${sites.length} functions`);
    return [identity(site, source), Number(counted[1])];
  });
  return { entries, ambiguous: duplicates(entries.map(([id]) => id)) };
}

function innermostScope(scopes: readonly FunctionSite[], index: number): FunctionSite | undefined {
  let found: FunctionSite | undefined;
  for (const scope of scopes) {
    const [start, end] = scope.node.range;
    if (start < index && index < end && (!found || start >= found.node.range[0])) found = scope;
  }
  return found;
}

/**
 * Lint one source with ESLint's max-depth at `cap`; group reports by the innermost function (ESLint resets the
 * counter there) into [id, deepest, blocks]. Reports outside every function belong to MODULE_SCOPE.
 */
export function measureDepth(linter: Linter, parser: Linter.Parser, filename: string, source: string,
  cap: number): MeasuredComplexity {
  const { reports, sourceCode, ast } = lint(linter, parser, filename, source, DEPTH_RULE, cap);
  const scopes = collectSites(ast, sourceCode.visitorKeys, DEPTH_SCOPES);
  const byScope = new Map<AstNode | null, number[]>();
  for (const message of reports) {
    const counted = DEPTH_EXCEED.exec(message.message);
    if (!counted) throw new Error(`${filename}:${message.line}: unexpected report ${message.message}`);
    const index = sourceCode.getIndexFromLoc({ line: message.line, column: message.column - 1 });
    const scope = innermostScope(scopes, index)?.node ?? null;
    byScope.set(scope, [...(byScope.get(scope) ?? []), Number(counted[1])]);
  }
  const entries: ComplexityEntry[] = [...byScope].map(([node, depths]) => {
    const site = node === null ? undefined : scopes.find(scope => scope.node === node);
    return [site ? identity(site, source) : MODULE_SCOPE, Math.max(...depths), depths.length];
  });
  return { entries, ambiguous: duplicates(entries.map(([id]) => id)) };
}

function compareValues(actual: readonly number[], allowed: readonly number[]): 'same' | 'grown' | 'stale' {
  if (actual.some((value, index) => value > (allowed[index] ?? -Infinity))) return 'grown';
  return actual.every((value, index) => value === allowed[index]) ? 'same' : 'stale';
}

/**
 * Every difference between one baseline row and the measured functions; all lists must be empty. `width` is the
 * number of values per entry (1 for parameters, 2 for depth); the first value must exceed `cap`.
 */
export function compareComplexity(row: ComplexityRow, measured: MeasuredComplexity, cap: number,
  width: number): ComplexityDrift {
  const expected = new Map<string, readonly number[]>();
  const duplicateRows: string[] = [];
  const withinCap: string[] = [];
  const malformed: string[] = [];
  for (const [id, ...values] of row.functions) {
    if (expected.has(id)) duplicateRows.push(id);
    if (values.length !== width || !values.every(value => Number.isInteger(value) && value > 0)) malformed.push(id);
    else if ((values[0] ?? 0) <= cap) withinCap.push(id);
    expected.set(id, values);
  }
  const grown: string[] = [];
  const stale: string[] = [];
  const unlisted: string[] = [];
  const actualIds = new Set<string>();
  for (const [id, ...values] of measured.entries) {
    actualIds.add(id);
    const allowed = expected.get(id);
    if (allowed === undefined) { unlisted.push(id); continue; }
    const change = compareValues(values, allowed);
    if (change === 'grown') grown.push(id); else if (change === 'stale') stale.push(id);
  }
  const obsolete = [...expected.keys()].filter(id => !actualIds.has(id));
  return { grown, stale, unlisted, obsolete, ambiguous: measured.ambiguous, duplicateRows, withinCap, malformed };
}
