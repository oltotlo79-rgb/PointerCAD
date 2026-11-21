import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 規格部品の族の登録の表と、検査(単体・画面検査)が持つ族の一覧・並びを読み比べる。
 * 族を足した束が、画面検査の族の一覧(e2e/tests/aluminumFrameCatalogFlow.ts の FRAME_KINDS)を直し忘れ、
 * 外部検査で初めて落ちた(2026-11-19)。その漏れを、送る前の単体の決まりの検査で落とす。
 *
 * - ほぼ全部の一覧: 検査のファイルの配列(入れ子を含む)のうち、登録の表の族の id か種類の鍵を、すべての族・1 つの分類・
 *   1 つの包み(registry/<包み>.ts)のどれかの 9 割以上(かつ 5 つ以上)持つ配列は、そのどれかの並びと完全に同じでなければならない。
 *   入れ子のうち一番内側の「ほぼ全部」の配列だけを照らす。
 * - 末尾から数える切り出し: `catalogFamilyEntries('<分類>').slice(a, b).map((entry) => entry.id)).toEqual(<期待>)` の期待を、
 *   登録の表のその分類の並びの同じ切り出しと比べる。期待は配列の文字か、同じファイルの `const 名前 = [...]` の id の並び。
 * 製品のモジュールは読み込まない(test-utils は製品のパッケージに依存しない)。登録の表もファイルの文字として読む。
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const REGISTRY = 'packages/model/src/assembly/catalog/registry.ts';
const ENTRY = /^\s*\{ id: '([^']+)', group: '([^']+)', kindKey: '([^']+)'/gmu;
const IMPORT = /import \{ (K[0-9A-Z]+)_CATALOG_FAMILIES \} from '\.\/registry\/([a-z0-9]+)\.js';/gu;
const SPREAD = /\.\.\.(K[0-9A-Z]+)_CATALOG_FAMILIES/gu;
const SLICE = /catalogFamilyEntries\('([A-Za-z]+)'\)\.slice\((-?\d+)(?:,\s*(-?\d+))?\)\.map\(\(entry\) => entry\.id\)\)\s*\.toEqual\(([^;]+?)\);/gsu;
const NAMED = /^([A-Z][A-Z0-9_]*)\.map\(/u;
const SHARE = 0.9;
const MINIMUM = 5;
const EXCLUDED = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);

interface FamilyEntry { readonly id: string; readonly group: string; readonly kindKey: string; readonly pack: string }
interface ArraySpan { readonly start: number; readonly end: number; readonly literals: readonly string[] }
interface Target { readonly name: string; readonly order: readonly string[] }
interface Findings { readonly checked: string[]; readonly failures: string[] }

/** 登録口の `...K*_CATALOG_FAMILIES` の順に、包みのファイルの項目を読む。 */
function registryEntries(read: (path: string) => string): FamilyEntry[] {
  const text = read(REGISTRY);
  const modules = new Map([...text.matchAll(IMPORT)].map((match) => [match[1], match[2]] as const));
  const order = [...text.slice(text.indexOf('PRODUCT_CATALOG_REGISTRY')).matchAll(SPREAD)].map((match) => match[1]);
  if (order.length === 0) throw new Error('登録口の並びを読めない');
  return order.flatMap((name) => {
    const pack = modules.get(name);
    if (pack === undefined) throw new Error(`登録口の ${name} の読み込みが無い`);
    const found = [...read(`packages/model/src/assembly/catalog/registry/${pack}.ts`).matchAll(ENTRY)];
    if (found.length === 0) throw new Error(`包み ${pack} の族を読めない`);
    return found.map((match) => ({ id: match[1], group: match[2], kindKey: match[3], pack }));
  });
}

/** `/` が正規表現の始まりに立つ所か(直前の空白でない文字が演算子・括弧の開き・区切り、または行の頭)。 */
function regexAllowed(text: string, index: number): boolean {
  let before = index - 1;
  while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before -= 1;
  return before < 0 || '(,=:[!&|?{};+-*%<>~^\n'.includes(text[before]);
}

/** 正規表現の文字の終わりの次の位置(角括弧の中の / と逆斜線の後の 1 文字は終わりに数えない)。行の内で閉じなければ割り算とみる。 */
function regexEnd(text: string, index: number): number {
  let position = index + 1;
  let inClass = false;
  while (position < text.length && text[position] !== '\n') {
    const char = text[position];
    if (char === '\\') { position += 2; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return position + 1;
    position += 1;
  }
  return index + 1;
}

/** 配列の文字の範囲と、その中(入れ子を含む)の文字列の並び。文字列・注釈・正規表現の中の括弧は数えない。 */
function arraySpans(text: string): ArraySpan[] {
  const spans: ArraySpan[] = [];
  const stack: { start: number; literals: string[] }[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (char === '/' && regexAllowed(text, index)) {
      index = regexEnd(text, index);
    } else if (char === '\'' || char === '"' || char === '`') {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      const literal = text.slice(index + 1, end);
      for (const open of stack) open.literals.push(literal);
      index = end + 1;
    } else {
      if (char === '[') stack.push({ start: index, literals: [] });
      else if (char === ']') {
        const open = stack.pop();
        if (open !== undefined) spans.push({ start: open.start, end: index, literals: open.literals });
      }
      index += 1;
    }
  }
  return spans;
}

/** 「ほぼ全部」を量る相手: すべての族・分類ごと・包みごと(どれも登録の表の並び)。 */
function targetsOf(entries: readonly FamilyEntry[], pick: (entry: FamilyEntry) => string): Target[] {
  const targets: Target[] = [{ name: 'すべての族', order: entries.map(pick) }];
  for (const [label, by] of [['分類', (entry: FamilyEntry) => entry.group], ['包み', (entry: FamilyEntry) => entry.pack]] as const) {
    for (const name of [...new Set(entries.map(by))]) {
      targets.push({ name: `${label} ${name}`, order: entries.filter((entry) => by(entry) === name).map(pick) });
    }
  }
  return targets;
}

/** ほぼ全部の一覧なら、合う相手か、一番近い相手(合わない)。どの相手にも「ほぼ全部」でなければ undefined。 */
function judge(values: readonly string[], targets: readonly Target[]): { readonly matched: boolean; readonly target: Target } | undefined {
  const unique = new Set(values);
  let nearest: { readonly share: number; readonly target: Target } | undefined;
  for (const target of targets) {
    const overlap = target.order.filter((value) => unique.has(value)).length;
    if (overlap < Math.max(MINIMUM, SHARE * target.order.length)) continue;
    if (values.length === target.order.length && values.every((value, index) => value === target.order[index])) {
      return { matched: true, target };
    }
    const share = overlap / target.order.length;
    if (nearest === undefined || share > nearest.share) nearest = { share, target };
  }
  return nearest === undefined ? undefined : { matched: false, target: nearest.target };
}

function lineOf(text: string, position: number): number {
  return text.slice(0, position).split('\n').length;
}

/** ほぼ全部の一覧を照らす。合った物は checked に、外れは failures に足す。 */
function checkLists(path: string, text: string, entries: readonly FamilyEntry[], findings: Findings): void {
  const spans = arraySpans(text);
  for (const [label, pick] of [['族の id', (entry: FamilyEntry) => entry.id], ['種類の鍵', (entry: FamilyEntry) => entry.kindKey]] as const) {
    const known = new Set(entries.map(pick));
    const targets = targetsOf(entries, pick);
    const candidates = spans.flatMap((span) => {
      const values = span.literals.filter((literal) => known.has(literal));
      const verdict = values.length > 0 ? judge(values, targets) : undefined;
      return verdict === undefined ? [] : [{ span, values, verdict }];
    });
    for (const { span, values, verdict } of candidates) {
      if (candidates.some((other) => other.span.start > span.start && other.span.end < span.end)) continue;
      const place = `${path}:${lineOf(text, span.start)} ${label}(${verdict.target.name})`;
      if (verdict.matched) { findings.checked.push(place); continue; }
      const missing = verdict.target.order.filter((value) => !values.includes(value));
      const extra = values.filter((value) => !verdict.target.order.includes(value));
      findings.failures.push(`${place}: ${values.length} 個 / 登録 ${verdict.target.order.length} 個。無い ${missing.join(', ')} 多い ${extra.join(', ')}`);
    }
  }
}

/** 期待の文字(配列の文字か、同じファイルの `const 名前 = [...]` の名前)から、族の id の並びを読む。読めなければ undefined。 */
function expectedIds(text: string, expectation: string, ids: ReadonlySet<string>): string[] | undefined {
  let source = expectation;
  const named = NAMED.exec(expectation);
  if (named !== null) {
    const definition = new RegExp(`const ${named[1]}\\b[^=]*=\\s*\\[`, 'u').exec(text);
    if (definition === null) return undefined;
    const begin = definition.index + definition[0].length - 1;
    const outer = arraySpans(text.slice(begin)).find((span) => span.start === 0);
    if (outer === undefined) return undefined;
    source = text.slice(begin, begin + outer.end + 1);
  } else if (!expectation.startsWith('[')) return undefined;
  const outer = arraySpans(source).find((span) => span.start === 0);
  return outer?.literals.filter((literal) => ids.has(literal));
}

/** 末尾から数える切り出しの期待を、登録の表の同じ切り出しと比べる。 */
function checkSlices(path: string, text: string, entries: readonly FamilyEntry[], findings: Findings): void {
  const ids = new Set(entries.map((entry) => entry.id));
  for (const match of text.matchAll(SLICE)) {
    const order = entries.filter((entry) => entry.group === match[1]).map((entry) => entry.id);
    const actual = match[3] === undefined ? order.slice(Number(match[2])) : order.slice(Number(match[2]), Number(match[3]));
    const expected = expectedIds(text, match[4].trim(), ids);
    const range = match[3] === undefined ? match[2] : match[2] + ', ' + match[3];
    const place = `${path}:${lineOf(text, match.index ?? 0)} slice(${range})`;
    if (expected === undefined) findings.failures.push(`${place}: 期待を読めない`);
    else if (expected.join(',') === actual.join(',')) findings.checked.push(place);
    else findings.failures.push(`${place}: 期待 ${expected.join(', ')} / 登録の表 ${actual.join(', ')}`);
  }
}

function testFiles(directory: string, pattern: RegExp): string[] {
  if (!existsSync(resolve(root, directory))) return [];
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return EXCLUDED.has(entry.name) ? [] : testFiles(path, pattern);
    return entry.isFile() && pattern.test(entry.name) ? [path] : [];
  });
}

function sourceTestFiles(): string[] {
  const roots = ['packages', 'apps'].flatMap((group) => readdirSync(resolve(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => posix.join(group, entry.name, 'src')));
  return [...testFiles('e2e/tests', /\.ts$/u), ...roots.flatMap((directory) => testFiles(directory, /\.test\.tsx?$/u))].sort();
}

function audit(read: (path: string) => string, paths: readonly string[]): Findings {
  const entries = registryEntries(read);
  const findings: Findings = { checked: [], failures: [] };
  for (const path of paths) {
    const text = read(path);
    checkLists(path, text, entries, findings);
    checkSlices(path, text, entries, findings);
  }
  return findings;
}

const FAMILIES_DIR = 'packages/model/src/assembly/catalog/families';
const LOAD = /^\s*\{ id: '([^']+)'[\s\S]*?import\('\.\.\/families\/([A-Za-z0-9]+)\.js'\)\)\.([A-Z][A-Z0-9_]*)/gmu;
const EXPORTED_FAMILY = /^export const ([A-Z][A-Z0-9_]*_FAMIL(?:Y|IES))\b/gmu;
const LOCAL_IMPORT = /from '\.\/([A-Za-z0-9]+)\.js'/gu;
/**
 * 独立の読みの表(*Oracle*.test.ts が読む fixture)を持たない族と、その理由(P2)。読みの表を足した時は、ここから消す。
 * 登録の表に無い id を書くと落ちる(書き損じを残さない)。
 */
const NO_READING_TABLE: ReadonlyMap<string, string> = new Map([
  ['compression-spring', '線径・中心径・自由長・巻数を入れる族'],
  ['oil-seal-specified', '内径・外径・幅を入れる族'],
  ['t-slot-frame-specified', '断面の寸法を入れる族'],
  ['angle-bracket-specified', '寸法を入れる族'],
  ['join-plate-specified', '寸法を入れる族'],
  ['slot-nut-specified', '寸法を入れる族'],
  ['t-slot-frame-series', '製造元の寸法に合わせた系列。独立の読みの表が無い(今の状態のまま)'],
]);

interface FamilySource { readonly id: string; readonly module: string; readonly exportName: string }

/** 登録の表の包みのファイルの `load` から、族ごとの本体のファイルと書き出しの名前を読む。 */
function familySources(read: (path: string) => string, packs: readonly string[]): FamilySource[] {
  return packs.flatMap((pack) => [...read(`packages/model/src/assembly/catalog/registry/${pack}.ts`).matchAll(LOAD)]
    .map((match) => ({ id: match[1], module: match[2], exportName: match[3] })));
}

function mentions(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(text);
}

/**
 * 族の検査の網羅(P2)。(A) 本体のファイル(families の下)が書き出す族は、全部登録の表にある(登録の表から消し忘れ・足し忘れを止める)。
 * (B) 登録の表の族は、(i) 書き出しの名前か、それを作る関数の名前を、行を読む families の検査のどれかが持ち、
 * (ii) 本体か、本体が読む同じフォルダーのファイル(行の表)を、独立の読みの検査(*Oracle*.test.ts)のどれかが読む。
 * 製品のモジュールは読み込まない(ファイルの文字として読む)。
 */
function coverage(read: (path: string) => string, list: (directory: string) => readonly string[],
  exempt: ReadonlyMap<string, string>): string[] {
  const entries = registryEntries(read);
  const packs = [...new Set(entries.map((entry) => entry.pack))];
  const sources = familySources(read, packs);
  const failures: string[] = [];
  const ids = new Set(entries.map((entry) => entry.id));
  for (const id of exempt.keys()) if (!ids.has(id)) failures.push(`読みの表の無い族の例外 ${id} が登録の表に無い`);
  if (sources.map((source) => source.id).join(',') !== entries.map((entry) => entry.id).join(',')) {
    failures.push(`登録の表の族 ${entries.length} のうち、本体の読み込みを読めた族 ${sources.length}`);
  }
  const names = list(FAMILIES_DIR).filter((name) => name.endsWith('.ts'));
  const tests = names.filter((name) => name.endsWith('.test.ts')).map((name) => ({ name, text: read(`${FAMILIES_DIR}/${name}`) }));
  const oracles = tests.filter((test) => test.name.includes('Oracle'));
  const registryText = packs.map((pack) => read(`packages/model/src/assembly/catalog/registry/${pack}.ts`)).join('\n');
  for (const name of names.filter((candidate) => !/\.(test|testSupport|fixture)\./u.test(candidate))) {
    for (const match of read(`${FAMILIES_DIR}/${name}`).matchAll(EXPORTED_FAMILY)) {
      if (!mentions(registryText, match[1])) failures.push(`${FAMILIES_DIR}/${name} の ${match[1]} が登録の表に無い`);
    }
  }
  for (const source of sources) {
    if (exempt.has(source.id)) continue;
    const body = read(`${FAMILIES_DIR}/${source.module}.ts`);
    const factory = new RegExp(`^export const ${source.exportName}\\b[^=]*=\\s*([A-Za-z][A-Za-z0-9_]*)\\(`, 'mu').exec(body)?.[1];
    const words = factory === undefined ? [source.exportName] : [source.exportName, factory];
    if (!tests.some((test) => test.text.includes('.rows') && words.some((word) => mentions(test.text, word)))) {
      failures.push(`${source.id}: ${words.join(' か ')} の行を読む検査が無い`);
    }
    const local = [source.module, ...[...body.matchAll(LOCAL_IMPORT)].map((match) => match[1])];
    if (!oracles.some((test) => local.some((module) => test.text.includes(`from './${module}.js'`)))) {
      failures.push(`${source.id}: ${source.module} かそれが読む行の表を読む独立の読みの検査が無い`);
    }
  }
  return failures;
}

describe('規格部品の族の一覧と登録の表', () => {
  it('検査が持つ族のほぼ全部の一覧と末尾から数える切り出しは、登録の表の並びと同じ', () => {
    const findings = audit((path) => readFileSync(resolve(root, path), 'utf8'), sourceTestFiles());
    expect(findings.failures).toEqual([]);
    // 族を足す時に直していた 4 本は、族の一覧を登録の表から導く形へ直した。手で写した一覧と位置の切り出しを戻していない事。
    // (登録の表を読めない時は registryEntries が投げるので、0 件のまま素通りしない。)
    const files = new Set(findings.checked.map((place) => place.slice(0, place.indexOf(':'))));
    expect(['e2e/tests/aluminumFrameCatalogFlow.ts', 'packages/model/src/assembly/catalog/catalogItem.test.ts',
      'packages/ui/src/assembly/CatalogFamilyPicker.test.tsx', 'packages/ui/src/assembly/frameCatalogChoices.test.ts']
      .filter((path) => files.has(path))).toEqual([]);
  });

  const registry = [
    "import { KA_CATALOG_FAMILIES } from './registry/ka.js';",
    "import { KB_CATALOG_FAMILIES } from './registry/kb.js';",
    'export const PRODUCT_CATALOG_REGISTRY = createCatalogRegistry([...KA_CATALOG_FAMILIES, ...KB_CATALOG_FAMILIES]);',
  ].join('\n');
  const pack = (group: string, names: readonly string[]): string =>
    names.map((name) => `  { id: '${name}', group: '${group}', kindKey: 'kind.${name}',`).join('\n');
  // 仮の登録の表: 分類 frame の 10 族(包み ka)と分類 pipe の 1 族(包み kb)。9 割は 9 族。
  const FRAME = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
  const fixture = (test: string): ((path: string) => string) => (path) => {
    if (path === REGISTRY) return registry;
    if (path.endsWith('/ka.ts')) return pack('frame', FRAME);
    if (path.endsWith('/kb.ts')) return pack('pipe', ['b1']);
    return test;
  };
  // 入れ子の文字の型(テンプレートの中のテンプレート)を書かない(この検査が自分のファイルも読むので、読みを易しく保つ)。
  const list = (names: readonly string[]): string => '[' + names.map((name) => "'" + name + "'").join(', ') + ']';
  // 切り出しの呼び出しの文字は、つないで作る(この検査が自分のファイルの文字を本物の切り出しと読まないため)。
  const entriesCall = 'catalogFamily' + 'Entries';

  it('自己試験: ほぼ全部の一覧に 1 つ足りない・並びが違うは外れ、9 割に届かない一覧と同じ並びは外れない', () => {
    const pairs = FRAME.slice(0, 9).map((name) => `['${name}', 'kind.${name}']`).join(', ');
    expect(audit(fixture(`const KINDS = [${pairs}];`), ['x.test.ts']).failures).toEqual([
      'x.test.ts:1 族の id(分類 frame): 9 個 / 登録 10 個。無い a9 多い ',
      'x.test.ts:1 種類の鍵(分類 frame): 9 個 / 登録 10 個。無い kind.a9 多い ',
    ]);
    const swapped = ['a0', 'a1', 'a3', 'a2', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    expect(audit(fixture(`expect(ids).toEqual(${list(swapped)});`), ['x.test.ts']).failures).toHaveLength(1);
    expect(audit(fixture(`ensure(${list(FRAME.slice(0, 3))});\nexpect(ids).toEqual(${list([...FRAME, 'b1'])});`), ['x.test.ts']))
      .toEqual({ checked: ['x.test.ts:2 族の id(すべての族)'], failures: [] });
  });

  it('自己試験: 末尾から数える切り出しは、配列の文字と名前の付いた並びの両方を登録の表と比べる', () => {
    const text = [
      "const LAST = [['a8', 'hint'], ['a9', 'hint']] as const;",
      'expect(' + entriesCall + "('frame').slice(-2).map((entry) => entry.id)).toEqual(LAST.map(([id]) => id));",
      'expect(' + entriesCall + "('frame').slice(-3, -1).map((entry) => entry.id)).toEqual(['a7', 'a9']);",
    ].join('\n');
    expect(audit(fixture(text), ['x.test.ts'])).toEqual({ checked: ['x.test.ts:2 slice(-2)'],
      failures: ['x.test.ts:3 slice(-3, -1): 期待 a7, a9 / 登録の表 a7, a8'] });
  });

  it('自己試験: 正規表現・注釈・文字列の中の括弧と引用符で、配列の切れ目を誤らない', () => {
    const text = [
      `const quote = /['"[]/u; // ${list(FRAME.slice(0, 9))}`,
      "const words = '[not an array';",
      `expect(ids).toEqual(${list(FRAME)});`,
    ].join('\n');
    expect(audit(fixture(text), ['x.test.ts'])).toEqual({ checked: ['x.test.ts:3 族の id(分類 frame)'], failures: [] });
  });

  it('規格部品の族は、本体の書き出しが全部登録の表にあり、登録の表の族は全部、行を読む検査と独立の読みの検査に照らされる', () => {
    const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
    expect(coverage(read, (directory) => readdirSync(resolve(root, directory)), NO_READING_TABLE)).toEqual([]);
  });

  // 仮の本体のファイル: alpha は行の表 alphaRows を読み、beta は作る関数 createBeta で作る。
  const coverageFiles: Readonly<Record<string, string>> = {
    [REGISTRY]: "import { KA_CATALOG_FAMILIES } from './registry/ka.js';\n"
      + 'export const PRODUCT_CATALOG_REGISTRY = createCatalogRegistry([...KA_CATALOG_FAMILIES]);',
    'packages/model/src/assembly/catalog/registry/ka.ts': [
      "  { id: 'alpha', group: 'frame', kindKey: 'kind.alpha',",
      "    load: async () => (await import('../families/alpha.js')).ALPHA_FAMILY },",
      "  { id: 'beta', group: 'frame', kindKey: 'kind.beta',",
      "    load: async () => (await import('../families/beta.js')).BETA_FAMILY },",
    ].join('\n'),
    [`${FAMILIES_DIR}/alpha.ts`]: "import { ALPHA_RECORDS } from './alphaRows.js';\nexport const ALPHA_FAMILY = createAlpha(ALPHA_RECORDS);",
    [`${FAMILIES_DIR}/alphaOracle.test.ts`]: "import { ALPHA_RECORDS } from './alphaRows.js';",
    [`${FAMILIES_DIR}/alpha.test.ts`]: 'expect(ALPHA_FAMILY.rows).not.toEqual([]);',
    [`${FAMILIES_DIR}/beta.ts`]: 'export const BETA_FAMILY: Family = createBeta(ROWS);',
    [`${FAMILIES_DIR}/betaOracle.test.ts`]: "import { ROWS } from './beta.js';",
    [`${FAMILIES_DIR}/beta.test.ts`]: 'expect(createBeta(RECORDS).rows).not.toEqual([]);',
  };
  const coverageOf = (files: Readonly<Record<string, string>>, exempt: ReadonlyMap<string, string> = new Map()): string[] =>
    coverage((path) => files[path] ?? '', (directory) => Object.keys(files)
      .filter((path) => path.startsWith(`${directory}/`)).map((path) => path.slice(directory.length + 1)), exempt);
  const without = (name: string): Readonly<Record<string, string>> =>
    Object.fromEntries(Object.entries(coverageFiles).filter(([path]) => path !== `${FAMILIES_DIR}/${name}`));

  it('自己試験: 族の網羅は、行を読む検査・独立の読みの検査・登録の表の足し忘れ・例外の書き損じを外れにする', () => {
    expect(coverageOf(coverageFiles)).toEqual([]);
    expect(coverageOf(without('alpha.test.ts'))).toEqual(['alpha: ALPHA_FAMILY か createAlpha の行を読む検査が無い']);
    expect(coverageOf(without('betaOracle.test.ts'))).toEqual(['beta: beta かそれが読む行の表を読む独立の読みの検査が無い']);
    expect(coverageOf(without('betaOracle.test.ts'), new Map([['beta', '理由'], ['gamma', '理由']])))
      .toEqual(['読みの表の無い族の例外 gamma が登録の表に無い']);
    expect(coverageOf({ ...coverageFiles, [`${FAMILIES_DIR}/gamma.ts`]: 'export const GAMMA_FAMILY = createGamma(ROWS);' }))
      .toEqual([`${FAMILIES_DIR}/gamma.ts の GAMMA_FAMILY が登録の表に無い`]);
  });
});
