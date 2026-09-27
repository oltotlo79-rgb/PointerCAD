import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 検査ファイル(`*.test.ts` 等)が実在しても、所属パッケージの vitest `include` から
 * 漏れていれば通常の `pnpm run test` では一度も実行されない
 * (`packages/ui/src/assembly/AssemblyMotionControls.test.tsx` が1件、実際に漏れていた)。
 * このファイルは packages/*・apps/* の全検査ファイルが、所属パッケージの
 * vitest.config.ts の include のどれかに一致することを機械的に固定する。
 *
 * 同様に、各パッケージの `src` 配下の Python 検査(`*_test.py`・`test_*.py`)は対になる
 * `*.test.ts` から `spawnSync` 等で名前を渡して起動しない限り vitest/CI から一度も
 * 実行されない(`packages/expression/src/math/exactRuntime/` 配下で実際に1件見つかった)。
 * こちらは同じパッケージのいずれかの `*.test.ts` の本文にファイル名で参照されているかを
 * 機械的に固定する(呼び出し方の妥当性ではなく、名前が本文に現れるかだけを見る)。
 */

const root = new URL('../../../', import.meta.url);

const TEST_FILE_NAME = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/**
 * `vitest.config.ts` の `include: [...]` から文字列リテラルを取り出す。
 * 配列そのものが見つからない・文字列が1件も無い場合は例外を投げて失敗させる
 * (取り出せない書式を黙って合格にしない)。
 */
function extractIncludePatterns(configSource: string, configLabel: string): string[] {
  const arrayMatch = /include:\s*\[([^\]]*)\]/u.exec(configSource);
  if (!arrayMatch) {
    throw new Error(`${configLabel}: include配列を取り出せません(想定した書式 include: [...] が見つかりません)`);
  }
  const patterns = [...arrayMatch[1].matchAll(/'([^']*)'|"([^"]*)"/gu)]
    .map((literal) => literal[1] ?? literal[2] ?? '');
  if (patterns.length === 0) {
    throw new Error(`${configLabel}: include配列に文字列リテラルが1件もありません`);
  }
  return patterns;
}

/**
 * `*`(区切り`/`の中の任意文字列)と `**`(0階層以上のディレクトリ)だけに対応した
 * 最小限のglob照合。依存を追加しないため、この2種類だけを自前でregexへ変換する
 * (この設定ファイル群が実際に使っているのはこの2種類だけ)。
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

function matchesAnyPattern(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

/** ディレクトリを再帰的にたどり、パッケージ根からの `/` 区切り相対パスで、名前が一致するファイルを集める。 */
function collectFiles(dirUrl: URL, relativePrefix: string, matches: (name: string) => boolean, out: string[]): void {
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const relativePath = `${relativePrefix}${entry.name}`;
    if (entry.isDirectory()) {
      collectFiles(new URL(`${entry.name}/`, dirUrl), `${relativePath}/`, matches, out);
    } else if (entry.isFile() && matches(entry.name)) {
      out.push(relativePath);
    }
  }
}

function isTsTestFileName(name: string): boolean {
  return name.endsWith('.test.ts');
}

/** `*_test.py` と `test_*.py` の2種類の命名規約(既存のexactRuntime配下の慣例)。 */
function isPythonTestFileName(name: string): boolean {
  return /_test\.py$/u.test(name) || /^test_.*\.py$/u.test(name);
}

/**
 * pythonファイル(パッケージ根からの相対パス)のうち、`.test.ts` 群を連結した本文へ
 * ベース名(ディレクトリを除いたファイル名)が1度も現れないものを返す。
 */
function findUnreferencedPythonTests(pythonRelativePaths: readonly string[], combinedTsSource: string): string[] {
  return pythonRelativePaths.filter((relativePath) => {
    const baseName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return !combinedTsSource.includes(baseName);
  });
}

/** include のどれにも一致しない検査ファイルを返す(空配列なら漏れ0件)。 */
function findUncovered(relativePaths: readonly string[], patterns: readonly string[]): string[] {
  return relativePaths.filter((relativePath) => !matchesAnyPattern(relativePath, patterns));
}

function topLevelDirectoryNames(folder: string): string[] {
  return readdirSync(new URL(`${folder}/`, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('検査ファイルの取りこぼし防止', () => {
  it('packages/*/src と apps/*/src の全検査ファイルが、所属パッケージのvitest includeに含まれる', () => {
    const uncovered: string[] = [];
    let scannedPackageCount = 0;
    let scannedFileCount = 0;
    for (const folder of ['packages', 'apps']) {
      for (const name of topLevelDirectoryNames(folder)) {
        const packagePrefix = `${folder}/${name}/`;
        const srcUrl = new URL(`${packagePrefix}src/`, root);
        if (!existsSync(srcUrl)) continue;
        scannedPackageCount += 1;
        const files: string[] = [];
        collectFiles(srcUrl, 'src/', (fileName) => TEST_FILE_NAME.test(fileName), files);
        scannedFileCount += files.length;
        const configPath = `${packagePrefix}vitest.config.ts`;
        const configSource = readFileSync(new URL(configPath, root), 'utf8');
        const patterns = extractIncludePatterns(configSource, configPath);
        for (const file of findUncovered(files, patterns)) uncovered.push(`${packagePrefix}${file}`);
      }
    }
    // 実際に走査できていることの下支え(0件のまま素通りする回帰を防ぐ)。件数は増減しうるため緩い下限だけを見る。
    expect(scannedPackageCount).toBeGreaterThanOrEqual(10);
    expect(scannedFileCount).toBeGreaterThan(500);
    expect(uncovered).toEqual([]);
  });

  it('packages/*/src の *_test.py・test_*.py は、同じパッケージのいずれかの*.test.tsから名前で参照されている', () => {
    // spawnSyncで名前を渡さない限りvitest/CIから一度も起動されないPython検査を検出する
    // (packages/expression/src/math/exactRuntime/配下で実際に1件見つかった漏れの再発防止)。
    const unreferenced: string[] = [];
    let scannedPythonTestCount = 0;
    for (const name of topLevelDirectoryNames('packages')) {
      const packagePrefix = `packages/${name}/`;
      const srcUrl = new URL(`${packagePrefix}src/`, root);
      if (!existsSync(srcUrl)) continue;
      const pythonFiles: string[] = [];
      collectFiles(srcUrl, 'src/', isPythonTestFileName, pythonFiles);
      if (pythonFiles.length === 0) continue;
      scannedPythonTestCount += pythonFiles.length;
      const tsTestFiles: string[] = [];
      collectFiles(srcUrl, 'src/', isTsTestFileName, tsTestFiles);
      const combinedTsSource = tsTestFiles
        .map((relativePath) => readFileSync(new URL(`${packagePrefix}${relativePath}`, root), 'utf8'))
        .join('\n');
      for (const file of findUnreferencedPythonTests(pythonFiles, combinedTsSource)) {
        unreferenced.push(`${packagePrefix}${file}`);
      }
    }
    // 実際に走査できていることの下支え(0件のまま素通りする回帰を防ぐ)。
    expect(scannedPythonTestCount).toBeGreaterThan(0);
    expect(unreferenced).toEqual([]);
  });

  it('自己試験: includeがtsだけのときtsxの検査ファイルの漏れを検出する', () => {
    const files = ['src/assembly/AssemblyMotionControls.test.tsx', 'src/foo.test.ts'];
    const patterns = extractIncludePatterns("include: ['src/**/*.test.ts'],", '架空の設定A');
    expect(findUncovered(files, patterns)).toEqual(['src/assembly/AssemblyMotionControls.test.tsx']);
  });

  it('自己試験: includeにtsxも加われば漏れは0件になる', () => {
    const files = ['src/assembly/AssemblyMotionControls.test.tsx', 'src/foo.test.ts', 'src/a/b/c.test.ts'];
    const patterns = extractIncludePatterns("include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],", '架空の設定B');
    expect(findUncovered(files, patterns)).toEqual([]);
  });

  it('自己試験: src直下(0階層)と深い階層のどちらもsrc/**/*.test.tsで拾い、拡張子違いは拾わない', () => {
    const patterns = ['src/**/*.test.ts'];
    expect(matchesAnyPattern('src/top.test.ts', patterns)).toBe(true);
    expect(matchesAnyPattern('src/a/b/c/deep.test.ts', patterns)).toBe(true);
    expect(matchesAnyPattern('src/top.test.tsx', patterns)).toBe(false);
  });

  it('自己試験: includeを取り出せない書式は黙って合格にせず例外を投げる', () => {
    expect(() => extractIncludePatterns('export default {}', '架空の設定C')).toThrow();
    expect(() => extractIncludePatterns('include: [],', '架空の設定D')).toThrow();
  });

  it('自己試験: 起動口の.test.tsから名前を参照されないPython検査を検出する(参照される側は誤検出しない)', () => {
    const pythonFiles = ['src/exactRuntime/cas_example_test.py', 'src/exactRuntime/cas_orphan_test.py'];
    const combinedTsSource =
      "const script = fileURLToPath(new URL('./exactRuntime/cas_example_test.py', import.meta.url));\n"
      + "spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], { input: payload });";
    expect(findUnreferencedPythonTests(pythonFiles, combinedTsSource)).toEqual(['src/exactRuntime/cas_orphan_test.py']);
  });
});
