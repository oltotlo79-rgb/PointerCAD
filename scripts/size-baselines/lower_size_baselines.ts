// 送る前に、根の基準の表(eslint.functionSizeBaseline.js・eslint.complexityBaseline.js)を実測へ下げる道具(P3 の候補)。
// 利用者の回答 2026-11-20 18:2x「短くした時は落とさない」: 検査は長くなった時だけ落とし、短くなった分の表の書き直しはこの道具が行う。
// 数え方は決まりの検査と同じ関数(packages/test-utils/src/functionSizePolicy.testSupport.ts・complexityPolicy.testSupport.ts)。
// やる事は「下げる・消す」だけ: 表より小さくなった値を実測へ下げ、上限以下になった・消えた関数の項目と、ファイルが無くなった行を消す。
// 上げる・足す事はしない。長くなった・一覧外の超過・識別できない重複・表の誤りが 1 つでもあれば、何も書かずに終わる(終わりの値 1)。
// 使い方: node --import <TS の読み込みの口 register-hooks.mjs> lower_size_baselines.ts <repo-root> [--overlay <dir>]... [--out <dir> | --write]
//   既定は乾いた流し(何も書かない。変わる所を出す)。--out は <dir> に新しい表の 2 本を書く(下書き用)、--write は根の 2 本を書き換える。
import console from 'node:console';
import process from 'node:process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { snapshotReader } from './snapshot-input.mjs';

type Entry = readonly [string, ...number[]];
interface Row { readonly file: string; readonly functions: readonly Entry[] }
interface Drift {
  readonly grown: readonly string[]; readonly stale: readonly string[]; readonly unlisted: readonly string[];
  readonly obsolete: readonly string[]; readonly ambiguous: readonly string[]; readonly duplicateRows: readonly string[];
  readonly withinCap: readonly string[]; readonly malformed?: readonly string[];
}
interface Measured { readonly values: ReadonlyMap<string, readonly number[]>; readonly drift: Drift }

const args = process.argv.slice(2);
const root = path.resolve(args[0] ?? '.');
const overlays: string[] = [];
let out: string | null = null;
let write = false;
let snapshot = false;
for (let index = 1; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--overlay') overlays.push(path.resolve(args[(index += 1)] ?? ''));
  else if (arg === '--out') out = path.resolve(args[(index += 1)] ?? '');
  else if (arg === '--write') write = true;
  else if (arg === '--snapshot') snapshot = true;
  else throw new Error(`知らない引数: ${arg}`);
}
if (out !== null && write) throw new Error('--out と --write は同時に使えない');
if (snapshot && (out !== null || write || overlays.length > 0)) {
  throw new Error('--snapshot は乾いた流しだけに使える');
}
const pick = (relative: string): string => {
  for (const overlay of [...overlays].reverse()) {
    const candidate = path.join(overlay, relative);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(root, relative);
};

const SIZE_POLICY = 'packages/test-utils/src/functionSizePolicy.testSupport.ts';
const COMPLEXITY_POLICY = 'packages/test-utils/src/complexityPolicy.testSupport.ts';
const SIZE_FILE = 'eslint.functionSizeBaseline.js';
const COMPLEXITY_FILE = 'eslint.complexityBaseline.js';
const readSnapshot = snapshot ? snapshotReader(root) : null;
const snapshotPolicy = readSnapshot?.([SIZE_POLICY, COMPLEXITY_POLICY, SIZE_FILE, COMPLEXITY_FILE]);
const url = (file: string): string => pathToFileURL(path.join(root, file)).href;
if (snapshotPolicy) {
  const sources = new Map<string, string>();
  for (const file of [SIZE_POLICY, COMPLEXITY_POLICY, SIZE_FILE, COMPLEXITY_FILE]) {
    const source = snapshotPolicy.get(file);
    if (source === undefined) throw new Error(`送信候補に計測の入力が無い: ${file}`);
    sources.set(url(file), source);
  }
  register('./ts-hooks.mjs?snapshot', { parentURL: import.meta.url, data: sources });
}

const size = await import(url(SIZE_POLICY)) as {
  measureFunctions(linter: Linter, parser: Linter.Parser, file: string, source: string, cap: number):
    { functions: readonly { id: string; lines: number }[]; ambiguous: readonly string[] };
  compareBaseline(row: Row, measured: unknown, cap: number): Drift;
};
const complexity = await import(url(COMPLEXITY_POLICY)) as {
  measureParams(linter: Linter, parser: Linter.Parser, file: string, source: string, cap: number): { entries: readonly Entry[]; ambiguous: readonly string[] };
  measureDepth(linter: Linter, parser: Linter.Parser, file: string, source: string, cap: number): { entries: readonly Entry[]; ambiguous: readonly string[] };
  compareComplexity(row: Row, measured: unknown, cap: number, width: number): Drift;
};
const sizeTable = await import(snapshot ? url(SIZE_FILE) : pathToFileURL(pick(SIZE_FILE)).href) as { FUNCTION_SIZE_CAP: number; FUNCTION_SIZE_BASELINE: readonly Row[] };
const complexityTable = await import(snapshot ? url(COMPLEXITY_FILE) : pathToFileURL(pick(COMPLEXITY_FILE)).href) as {
  PARAMS_CAP: number; DEPTH_CAP: number; PARAMS_BASELINE: readonly Row[]; DEPTH_BASELINE: readonly Row[];
};
const parser = tseslint.parser;

interface Kind {
  readonly name: string; readonly file: string; readonly table: string; readonly cap: number; readonly rows: readonly Row[];
  measure(file: string, source: string): Measured;
}
const kinds: Kind[] = [
  { name: '関数の長さ', file: SIZE_FILE, table: 'FUNCTION_SIZE_BASELINE', cap: sizeTable.FUNCTION_SIZE_CAP, rows: sizeTable.FUNCTION_SIZE_BASELINE,
    measure(file, source) {
      const measured = size.measureFunctions(new Linter(), parser, file, source, this.cap);
      const row = this.rows.find((candidate) => candidate.file === file);
      if (row === undefined) throw new Error(`行が無い: ${file}`);
      return { values: new Map(measured.functions.map((entry) => [entry.id, [entry.lines]])),
        drift: size.compareBaseline(row, measured, this.cap) };
    } },
  { name: '引数', file: COMPLEXITY_FILE, table: 'PARAMS_BASELINE', cap: complexityTable.PARAMS_CAP, rows: complexityTable.PARAMS_BASELINE,
    measure(file, source) {
      const measured = complexity.measureParams(new Linter(), parser, file, source, this.cap);
      const row = this.rows.find((candidate) => candidate.file === file);
      if (row === undefined) throw new Error(`行が無い: ${file}`);
      return { values: new Map(measured.entries.map(([id, ...values]) => [id, values])),
        drift: complexity.compareComplexity(row, measured, this.cap, 1) };
    } },
  { name: '入れ子', file: COMPLEXITY_FILE, table: 'DEPTH_BASELINE', cap: complexityTable.DEPTH_CAP, rows: complexityTable.DEPTH_BASELINE,
    measure(file, source) {
      const measured = complexity.measureDepth(new Linter(), parser, file, source, this.cap);
      const row = this.rows.find((candidate) => candidate.file === file);
      if (row === undefined) throw new Error(`行が無い: ${file}`);
      return { values: new Map(measured.entries.map(([id, ...values]) => [id, values])),
        drift: complexity.compareComplexity(row, measured, this.cap, 2) };
    } },
];

const quote = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const rowLine = (row: Row): string =>
  `  { file: ${quote(row.file)}, functions: [${row.functions.map(([id, ...values]) => `[${[quote(id), ...values].join(', ')}]`).join(', ')}] },`;

const refusals: string[] = [];
const changes: [file: string, detail: string][] = [];
const newRows = new Map<string, Row[]>();
const measuredSources = readSnapshot?.(kinds.flatMap((kind) => kind.rows.map((row) => row.file)));
for (const kind of kinds) {
  const kept: Row[] = [];
  for (const row of kind.rows) {
    const report = (detail: string): void => { changes.push([row.file, `${kind.name} ${row.file}${detail}`]); };
    const sourcePath = pick(row.file);
    const source = measuredSources ? measuredSources.get(row.file)
      : existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : undefined;
    if (source === undefined) { report(': ファイルが無いので行を消す'); continue; }
    const { values, drift } = kind.measure(row.file, source);
    for (const key of ['grown', 'unlisted', 'ambiguous', 'duplicateRows', 'malformed'] as const) {
      for (const id of drift[key] ?? []) refusals.push(`${kind.name} ${row.file} ${id}: ${key}`);
    }
    const functions: Entry[] = [];
    for (const [id, ...allowed] of row.functions) {
      const actual = values.get(id);
      if (actual === undefined || (allowed[0] ?? 0) <= kind.cap) {
        report(` ${id}: 上限以下になった・消えたので項目を消す`);
        continue;
      }
      // 長くなった項目は断る(上で数えた)。表の値はそのまま残す(上げない)。
      if (actual.some((value, index) => value > (allowed[index] ?? -Infinity))) { functions.push([id, ...allowed]); continue; }
      if (actual.some((value, index) => value !== allowed[index])) {
        report(` ${id}: ${allowed.join('/')} → ${actual.join('/')}`);
      }
      functions.push([id, ...actual]);
    }
    if (functions.length > 0) kept.push({ file: row.file, functions });
    else report(': 項目が無くなったので行を消す');
  }
  newRows.set(kind.table, kept);
}
for (const change of changes) console.log('変える', snapshot ? JSON.stringify(change) : change[1]);
for (const line of refusals) console.log('断る', line);
if (refusals.length > 0) {
  console.log(`断る ${refusals.length} 件。表は書かない(長くなった・一覧外の超過は、関数を縮めるか、統括が判断する)`);
  process.exit(1);
}

/** 表の配列の中身(1 行 1 ファイル)だけを置き換える。注・上限・ほかの行は 1 文字も変えない。 */
function rewrite(text: string, table: string, rows: readonly Row[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = text.indexOf(`export const ${table} = [`);
  if (start < 0) throw new Error(`表が無い: ${table}`);
  const open = text.indexOf(eol, start) + eol.length;
  const close = text.indexOf(`${eol}];`, open - eol.length);
  if (close < 0) throw new Error(`表の終わりが無い: ${table}`);
  const body = rows.map(rowLine).join(eol);
  return text.slice(0, open) + body + text.slice(close);
}
const outputs = new Map<string, string>();
const tableText = (file: string): string => snapshotPolicy?.get(file) ?? readFileSync(pick(file), 'utf8');
for (const kind of kinds) {
  const current = outputs.get(kind.file) ?? tableText(kind.file);
  outputs.set(kind.file, rewrite(current, kind.table, newRows.get(kind.table) ?? []));
}
for (const [file, text] of outputs) {
  const before = tableText(file);
  console.log(`${file}: ${before === text ? '変わらない' : '変わる'}`);
  if (before === text) continue;
  if (out !== null) {
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, file), text, 'utf8');
  } else if (write) writeFileSync(path.join(root, file), text, 'utf8');
}
console.log(`変える ${changes.length} 件・断る 0 件(${out !== null ? `書いた先 ${out}` : write ? '根の表を書き換えた' : '乾いた流し。何も書いていない'})`);
