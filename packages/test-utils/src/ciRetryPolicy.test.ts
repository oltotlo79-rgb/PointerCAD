import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * 外部検査の中だけ、落ちた画面検査をその場で 1 回やり直す(利用者の決定 2026-11-17「その場で 1 回やり直す」)。
 * 見張りが弱まらない事を確かめる: (1) やり直しは外部検査(CI=true)の中だけで 1 回まで、手元は 0。(2) 上限つきの測定と
 * 起動の確かめの project はやり直さない。(3) 外部検査の出力には list のまとめが残り、やり直しで通った検査は「N flaky」と
 * 名前で出る。2 回とも落ちた検査は失敗で、3 回目は流れない(Playwright の実物で確かめる)。
 */
const root = new URL('../../../', import.meta.url);
const CONFIG = fileURLToPath(new URL('e2e/playwright.config.ts', root));
const RUN_TIMEOUT_MS = 60_000;
/** やり直しで通すと測定の意味が変わる project(描画と応答の上限つきの測定・起動の確かめ)。 */
const NO_RETRY_PROJECTS = ['viewport-performance', 'response-performance', 'startup-firefox', 'startup-electron'];

function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

interface ConfigFacts {
  readonly ciRetries: string | null;
  readonly topRetries: string | null;
  readonly reporter: string | null;
  readonly projectRetries: ReadonlyMap<string, string | null>;
}

function propertyText(object: ts.ObjectLiteralExpression, name: string, source: ts.SourceFile): string | null {
  const property = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item)
    && item.name.getText(source) === name);
  return property === undefined ? null : normalized(property.initializer.getText(source));
}

/** 設定の本文から、やり直しの値・まとめの出し方・project ごとのやり直しの値を読む(設定のコードは実行しない)。 */
function configFacts(text: string): ConfigFacts {
  const source = ts.createSourceFile('playwright.config.ts', text, ts.ScriptTarget.Latest, true);
  let ciRetries: string | null = null, topRetries: string | null = null, reporter: string | null = null;
  const projectRetries = new Map<string, string | null>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'CI_RETRIES' && node.initializer !== undefined) {
      ciRetries = normalized(node.initializer.getText(source));
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'defineConfig') {
      const [options] = node.arguments;
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        topRetries = propertyText(options, 'retries', source);
        reporter = propertyText(options, 'reporter', source);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const name = propertyText(node, 'name', source);
      if (name !== null && /^'[\w-]+'$/u.test(name) && node.parent !== undefined && ts.isArrayLiteralExpression(node.parent)) {
        projectRetries.set(name.slice(1, -1), propertyText(node, 'retries', source));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { ciRetries, topRetries, reporter, projectRetries };
}

/** list のまとめの「N <種類>」の行の下に、深く字下げして並ぶ検査の行(次の浅い行の手前まで)。種類の行が無ければ空。 */
function summaryNames(output: string, kind: 'flaky' | 'failed'): string[] {
  const lines = output.split(/\r?\n/u);
  const heading = kind === 'flaky' ? /^\s*\d+ flaky\s*$/u : /^\s*\d+ failed\s*$/u;
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const depth = (line: string): number => line.length - line.trimStart().length;
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || depth(line) <= depth(lines[start] ?? '')) break;
    names.push(line.trim());
  }
  return names;
}

describe('外部検査の中だけ、落ちた画面検査を 1 回だけやり直す', () => {
  const facts = configFacts(readFileSync(CONFIG, 'utf8'));

  it('やり直しは CI=true の時だけ 1 回、手元は 0(check.ps1 の外部検査の見分けと同じ)', () => {
    expect(facts.ciRetries).toBe("process.env.CI === 'true' ? 1 : 0");
    expect(facts.topRetries).toBe('CI_RETRIES');
  });

  it('上限つきの測定と起動の確かめの project はやり直さず、ほかの project は全体の値のまま', () => {
    expect(facts.projectRetries.size).toBeGreaterThan(NO_RETRY_PROJECTS.length);
    for (const name of NO_RETRY_PROJECTS) expect(facts.projectRetries.get(name), name).toBe('0');
    for (const [name, value] of facts.projectRetries) {
      if (!NO_RETRY_PROJECTS.includes(name)) expect(value, name).toBeNull();
    }
  });

  it('外部検査の出力に list のまとめを残す(やり直しで通った検査の名前が「N flaky」の下に出る)', () => {
    expect(facts.reporter).toBe("process.env.CI ? [['list'], ['github']] : [['list']]");
  });
});

describe('Playwright の実物: 1 回のやり直しで通った検査は名前で残り、2 回とも落ちた検査は失敗', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pcad-retry-policy-'));
  afterAll(() => { rmSync(folder, { recursive: true, force: true }); });

  it('flaky の数と名前がまとめに出て、落ち続ける検査は 2 回で止まって失敗になる', async () => {
    const require = createRequire(new URL('package.json', root));
    const cli = require.resolve('@playwright/test/cli');
    // 一時の spec は .mjs なので、CommonJS の index.js ではなく同じ包の index.mjs を読ませる(CLI と同じ実体)。
    const library = pathToFileURL(join(dirname(require.resolve('@playwright/test')), 'index.mjs')).href;
    const counter = join(folder, 'attempts.txt');
    writeFileSync(join(folder, 'retry.config.mjs'), "export default { testDir: '.', retries: 1, workers: 1, reporter: [['list']] };\n");
    writeFileSync(join(folder, 'retry.spec.mjs'), [
      `import { appendFileSync } from 'node:fs';`,
      `import { test } from ${JSON.stringify(library)};`,
      `test('やり直しで通る検査', async ({}, info) => { if (info.retry === 0) throw new Error('first attempt fails'); });`,
      `test('2 回とも落ちる検査', async () => { appendFileSync(${JSON.stringify(counter)}, 'x'); throw new Error('always fails'); });`,
      '',
    ].join('\n'));
    const env = { ...process.env };
    delete env.CI;
    const run = await new Promise<{ code: number | null; output: string }>((resolve) => {
      execFile(process.execPath, [cli, 'test', '--config', join(folder, 'retry.config.mjs')],
        { cwd: folder, env, encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 4_000_000 },
        (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          output: `${stdout}\n${stderr}` }));
    });
    expect(run.code, run.output).toBe(1);
    expect(summaryNames(run.output, 'flaky'), run.output).toEqual([expect.stringContaining('やり直しで通る検査')]);
    expect(summaryNames(run.output, 'failed'), run.output).toEqual([expect.stringContaining('2 回とも落ちる検査')]);
    expect(run.output).toContain('(retry #1)');
    expect(run.output).not.toContain('(retry #2)');
    expect(readFileSync(counter, 'utf8')).toBe('xx');
  }, RUN_TIMEOUT_MS + 10_000);
});
