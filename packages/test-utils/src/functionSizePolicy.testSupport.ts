import type { AST, Linter, SourceCode } from 'eslint';

/**
 * Per-function size baseline (review E09). ESLint's own max-lines-per-function measures every function; this
 * module only names the function each ESLint report belongs to, so a grandfathered function is held to its
 * own measured count instead of the largest count in its file.
 */
export const FUNCTION_SIZE_RULE = 'max-lines-per-function';
export const FUNCTION_SIZE_OPTIONS = { skipBlankLines: true, skipComments: true } as const;

const EXCEED = /^.+ has too many lines \((\d+)\)\. Maximum allowed is (\d+)\.$/u;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// Parents for which ESLint reports a function at the parent's start (ast-utils getFunctionHeadLoc).
const HEAD_PARENTS = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'TSPropertySignature',
  'TSMethodSignature']);
const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition']);
const NAMED = new Set([...FUNCTION_TYPES, 'ClassDeclaration', 'ClassExpression']);
const NAME_KEYS = new Map([['VariableDeclarator', 'id'], ['AssignmentExpression', 'left'], ['JSXAttribute', 'name']]);

interface AstNode {
  readonly type: string;
  readonly range: readonly [number, number];
  readonly [key: string]: unknown;
}

interface FunctionSite {
  readonly node: AstNode;
  readonly ancestors: readonly AstNode[];
}

/** One function over the cap, named by its enclosing declarations, not by its line number. */
export interface MeasuredFunction {
  readonly id: string;
  readonly lines: number;
  /** Index just after the opening brace of a block body, for growth regressions on real sources. */
  readonly bodyStart: number | undefined;
}

export type BaselineEntry = readonly [id: string, lines: number];

export interface BaselineRow {
  readonly file: string;
  readonly functions: readonly BaselineEntry[];
}

export interface BaselineDrift {
  readonly grown: readonly string[];
  readonly stale: readonly string[];
  readonly unlisted: readonly string[];
  readonly obsolete: readonly string[];
  readonly ambiguous: readonly string[];
  readonly duplicateRows: readonly string[];
  readonly withinCap: readonly string[];
}

function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string' &&
    'range' in value && Array.isArray(value.range);
}

function collectFunctions(root: AstNode, keys: SourceCode.VisitorKeys): FunctionSite[] {
  const sites: FunctionSite[] = [];
  const stack: AstNode[] = [];
  const visit = (node: AstNode): void => {
    if (FUNCTION_TYPES.has(node.type)) sites.push({ node, ancestors: [...stack] });
    stack.push(node);
    for (const key of keys[node.type] ?? []) {
      const child = node[key];
      const items: readonly unknown[] = Array.isArray(child) ? child : [child];
      for (const item of items) if (isNode(item)) visit(item);
    }
    stack.pop();
  };
  visit(root);
  return sites;
}

/** An identifier is named without its type annotation; other names use their whitespace-normalized source. */
function text(node: AstNode, source: string): string {
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  return source.slice(node.range[0], node.range[1]).replace(/\s+/gu, ' ');
}

function child(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function label(node: AstNode, parent: AstNode | undefined, source: string): string | undefined {
  if (NAMED.has(node.type)) {
    const id = child(node, 'id');
    if (id) return text(id, source);
    const args = parent?.arguments;
    const callee = parent ? child(parent, 'callee') : undefined;
    const index = Array.isArray(args) ? args.indexOf(node) : -1;
    return callee && index >= 0 ? `${text(callee, source)}(#${index})` : undefined;
  }
  if (KEYED.has(node.type)) {
    const key = child(node, 'key');
    if (!key) return undefined;
    const name = node.computed === true ? `[${text(key, source)}]` : text(key, source);
    const kind = node.kind;
    return kind === 'get' || kind === 'set' ? `${kind} ${name}` : name;
  }
  if (node.type === 'ExportDefaultDeclaration') return 'default';
  const key = NAME_KEYS.get(node.type);
  const target = key === undefined ? undefined : child(node, key);
  return target ? text(target, source) : undefined;
}

/** Stable identity: the names of the enclosing declarations joined by `::` (no line numbers). */
function identity(site: FunctionSite, source: string): string {
  const chain = [...site.ancestors, site.node];
  const parts = chain.map((node, index) => label(node, chain[index - 1], source))
    .filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? '<anonymous>' : parts.join('::');
}

function arrowStart(tokens: readonly AST.Token[], bodyStart: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((tokens[middle]?.range[0] ?? Infinity) < bodyStart) low = middle + 1; else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token?.type === 'Punctuator' && token.value === '=>') return token.range[0];
  }
  throw new Error(`No arrow token before index ${bodyStart}`);
}

/** The index ESLint reports for this function (same rule as ast-utils getFunctionHeadLoc). */
function headStart(site: FunctionSite, tokens: readonly AST.Token[]): number {
  const parent = site.ancestors.at(-1);
  if (parent && HEAD_PARENTS.has(parent.type)) return parent.range[0];
  if (site.node.type === 'ArrowFunctionExpression') {
    const body = child(site.node, 'body');
    if (!body) throw new Error('Arrow function without a body');
    return arrowStart(tokens, body.range[0]);
  }
  return site.node.range[0];
}

export function functionSizeConfig(parser: Linter.Parser, max: number): Linter.Config {
  return { files: ['**/*.{ts,tsx}'], languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: { [FUNCTION_SIZE_RULE]: [2, { max, ...FUNCTION_SIZE_OPTIONS }] } };
}

/**
 * Lint one source with ESLint's own rule at `cap` and name every reported function. Throws when a report cannot
 * be tied to exactly one function; duplicated identities are returned as ambiguous so the caller rejects them.
 */
export function measureFunctions(linter: Linter, parser: Linter.Parser, filename: string, source: string,
  cap: number): { readonly functions: readonly MeasuredFunction[]; readonly ambiguous: readonly string[] } {
  const messages = linter.verify(source, [functionSizeConfig(parser, cap)], { filename });
  const fatal = messages.find(message => message.fatal);
  if (fatal) throw new Error(`${filename}: ${fatal.message}`);
  const sourceCode = linter.getSourceCode();
  const ast: unknown = sourceCode.ast;
  if (!isNode(ast)) throw new Error(`${filename}: no program`);
  const tokens = sourceCode.ast.tokens;
  const byHead = new Map<number, FunctionSite[]>();
  for (const site of collectFunctions(ast, sourceCode.visitorKeys)) {
    const start = headStart(site, tokens);
    byHead.set(start, [...(byHead.get(start) ?? []), site]);
  }
  const functions: MeasuredFunction[] = [];
  for (const message of messages.filter(entry => entry.ruleId === FUNCTION_SIZE_RULE)) {
    const counted = EXCEED.exec(message.message);
    if (!counted) throw new Error(`${filename}:${message.line}: unexpected report ${message.message}`);
    const sites = byHead.get(sourceCode.getIndexFromLoc({ line: message.line, column: message.column - 1 })) ?? [];
    const site = sites[0];
    if (sites.length !== 1 || !site) throw new Error(`${filename}:${message.line}: report matches ${sites.length} functions`);
    const body = child(site.node, 'body');
    functions.push({ id: identity(site, source), lines: Number(counted[1]),
      bodyStart: body?.type === 'BlockStatement' ? body.range[0] + 1 : undefined });
  }
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const { id } of functions) {
    if (seen.has(id)) ambiguous.add(id);
    seen.add(id);
  }
  return { functions, ambiguous: [...ambiguous].sort() };
}

/** Every difference between one baseline row and the measured functions; all lists must be empty. */
export function compareBaseline(row: BaselineRow, measured: { readonly functions: readonly MeasuredFunction[];
  readonly ambiguous: readonly string[] }, cap: number): BaselineDrift {
  const expected = new Map<string, number>();
  const duplicateRows: string[] = [];
  const withinCap: string[] = [];
  for (const [id, lines] of row.functions) {
    if (expected.has(id)) duplicateRows.push(id);
    if (!Number.isInteger(lines) || lines <= cap) withinCap.push(id);
    expected.set(id, lines);
  }
  const actual = new Map(measured.functions.map(entry => [entry.id, entry.lines]));
  const grown: string[] = [];
  const stale: string[] = [];
  const unlisted: string[] = [];
  for (const [id, lines] of actual) {
    const allowed = expected.get(id);
    if (allowed === undefined) unlisted.push(id);
    else if (lines > allowed) grown.push(id);
    else if (lines < allowed) stale.push(id);
  }
  const obsolete = [...expected.keys()].filter(id => !actual.has(id));
  return { grown, stale, unlisted, obsolete, ambiguous: measured.ambiguous, duplicateRows, withinCap };
}
