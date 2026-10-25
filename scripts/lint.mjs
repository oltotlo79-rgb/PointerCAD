// `pnpm run lint` の本体。eslint を「パッケージごとの別プロセス」で流す。
//
// 理由(2026-10-05 利用者の指示「検査が多過ぎるし長すぎる」、rules/03・rules/00):
// 型情報を使う規則(recommendedTypeChecked + projectService)は、点検したファイルの
// TypeScript プログラムを1つのプロセスの中に溜め続ける。`eslint .` は全パッケージを
// 1プロセスで点検するため、作業ツリーが大きくなると V8 のヒープ約4GBを超えて
// exit 134 で落ちた(未コミット約470パスの作業ツリーで再現)。パッケージごとに
// プロセスを分ければ、プロセスの終了で溜まったプログラムが解放され、ピークは最大の
// パッケージ1つ分になる。UI内も区画ごとに分け、型の規則が蓄積する情報を解放する。
// 各区画も同じTypeScriptプロジェクトを読むため、分割後の必要メモリは実検査で確かめる。
// 点検する規則・対象のファイル・ignores は eslint.config.js のままで、規則は何も弱めない。
// 対象の取りこぼしを防ぐため、packages・apps 以外の根の直下は「packages・apps を除いた .」で点検する。
// 1つ1つが小さくなったので、既定で2組を同時に流して時間を縮める(PCAD_LINT_PARALLEL=1〜4で変える)。
//
// 使い方: `node scripts/lint.mjs`(全体。分割して流す)
//         `node scripts/lint.mjs <eslintの引数...>`(引数があれば分割せず、そのまま eslint へ渡す)
import { ESLint } from 'eslint';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import fs, { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const eslintBin = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');

/** 大きい組を先に流すと、同時に流す時の全体の時間が短くなる。 */
const LARGEST_FIRST = ['packages/ui', 'packages/model', 'packages/expression', 'packages/kernel'];

/** packages/* と apps/* の直下のフォルダーを、パッケージごとの点検の組にする。 */
export function listLintGroups(rootDir = root) {
  const groups = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = path.join(rootDir, parent);
    let names;
    try {
      names = readdirSync(parentDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'node_modules' || !statSync(path.join(parentDir, name)).isDirectory()) continue;
      groups.push({ label: `${parent}/${name}`, args: [`${parent}/${name}`] });
    }
  }
  const rank = (label) => {
    const index = LARGEST_FIRST.indexOf(label);
    return index < 0 ? LARGEST_FIRST.length : index;
  };
  groups.sort((a, b) => rank(a.label) - rank(b.label));
  // 根の直下(e2e・scripts・設定ファイル等)。packages・apps は上で点検済みなので除く。
  groups.push({
    label: '根の直下(packages・apps 以外)',
    args: ['.', '--ignore-pattern', 'packages/**', '--ignore-pattern', 'apps/**'],
  });
  return groups;
}

export function lintParallelism(raw = process.env.PCAD_LINT_PARALLEL) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(4, parsed));
}

/** UIを実ファイル量に基づく3組と、それ以外の完全な残りへ分ける。 */
export async function lintGroupParts(group, rootDir = root, engine = new ESLint({ cwd: rootDir })) {
  if (group.label !== 'packages/ui' || group.args.length !== 1 || group.args[0] !== 'packages/ui') return [group];
  const batches = [['viewport', 'assembly', 'beam'], ['sketch', 'math', 'drawing'], ['solid', 'shell', 'store']]
    .map((names) => names.map((name) => `packages/ui/src/${name}`).filter((directory) => {
      try {
        return fs.statSync(path.join(rootDir, directory)).isDirectory();
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    })).filter((directories) => directories.length > 0);
  const directories = batches.flat();
  if (directories.length === 0) return [group];
  // 空・全無視の区画を明示すると元の一括点検には無い未一致エラーになる。
  // 公開APIで実在する対象を確認する。探索上限でも元の一括点検へ戻す。
  let remaining = 128;
  const selected = async (directory, excluded = new Set()) => {
    // 実在する直下の対象を先に確かめ、無視された生成物で探索枠を使い切らない。
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isFile()) - Number(a.isFile()));
    for (const entry of entries) {
      if (--remaining < 0) return false;
      const file = path.join(directory, entry.name);
      if (entry.isFile() && !await engine.isPathIgnored(file)) return true;
      if (entry.isDirectory() && !excluded.has(file) && await selected(file, excluded)) return true;
    }
    return false;
  };
  for (const directory of directories) {
    if (!await selected(path.join(rootDir, directory))) return [group];
  }
  const excluded = new Set(directories.map((directory) => path.join(rootDir, directory)));
  if (!await selected(path.join(rootDir, 'packages/ui'), excluded)) return [group];
  return [
    ...batches.map((args, index) => ({ label: `packages/ui (${index + 1}/4)`, args })),
    { label: 'packages/ui (残り)', args: ['packages/ui', ...directories.flatMap((directory) => ['--ignore-pattern', `${directory}/**`])] },
  ];
}

/** 子の異常終了は通常のlint違反より優先し、全ての出力と失敗を残す。 */
export function combineLintResults(group, results) {
  const failed = results.find((result) => result.status !== 0 && result.status !== 1)
    ?? results.find((result) => result.signal)
    ?? results.find((result) => result.status !== 0);
  return {
    group, status: failed?.status ?? 0, signal: failed?.signal ?? null,
    seconds: results.reduce((total, result) => total + result.seconds, 0),
    output: results.map((result) => result.output).join(''),
  };
}

async function runGroup(group) {
  const parts = await lintGroupParts(group);
  if (parts.length === 1) return runChild(group);
  const results = [];
  for (const part of parts) {
    const result = await runChild(part);
    result.output = `[lint] ${part.label}: exit=${result.status}${result.signal ? ` signal=${result.signal}` : ''} (${result.seconds}秒)\n${result.output}`;
    results.push(result);
  }
  return combineLintResults(group, results);
}

/** 1組を別プロセスで流し、出力はまとめて終わった時に出す。 */
function runChild(group) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(process.execPath, [eslintBin, ...group.args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => chunks.push(data));
    child.stderr.on('data', (data) => chunks.push(data));
    const finish = (status, signal) => {
      // シグナルで終わった時は status が null になる。失敗として扱う。
      resolve({
        group,
        status: status ?? 1,
        signal,
        seconds: Math.round((Date.now() - started) / 1000),
        output: Buffer.concat(chunks).toString('utf8'),
      });
    };
    child.on('error', () => finish(1, 'spawn-error'));
    child.on('close', (status, signal) => finish(status, signal));
  });
}

async function runAll(groups, parallelism) {
  const results = [];
  const queue = [...groups];
  const failures = [];
  const worker = async () => {
    for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
      console.log(`[lint] ${group.label} を点検します`);
      const result = await runGroup(group);
      if (result.output.length > 0) process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
      console.log(`[lint] ${group.label}: exit=${result.status}${result.signal ? ` signal=${result.signal}` : ''} (${result.seconds}秒)`);
      results.push(result);
      if (result.status !== 0) failures.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelism, groups.length) }, worker));
  return { results, failures };
}

async function main(argv) {
  if (argv.length > 0) {
    const direct = spawnSync(process.execPath, [eslintBin, ...argv], { cwd: root, stdio: 'inherit', env: process.env });
    process.exit(direct.status ?? 1);
  }
  const startedAll = Date.now();
  const parallelism = lintParallelism();
  console.log(`[lint] パッケージごとの別プロセスで点検します(同時 ${parallelism} 組)`);
  const { failures } = await runAll(listLintGroups(), parallelism);
  const total = Math.round((Date.now() - startedAll) / 1000);
  if (failures.length > 0) {
    console.error(`[lint] 失敗した組: ${failures.map((f) => `${f.group.label}(exit=${f.status})`).join(', ')} (全体 ${total}秒)`);
    process.exit(failures.some((f) => f.status !== 1) ? 2 : 1);
  }
  console.log(`[lint] 全ての組が合格しました (全体 ${total}秒)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
