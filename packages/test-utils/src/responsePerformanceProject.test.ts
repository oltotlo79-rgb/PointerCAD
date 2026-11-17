import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/*
 * 読込・保存の中の100入力の応答(p95)を測る6本を、専用の project response-performance(workers: 1)で1本ずつ流す
 * (A-20、2026-11-17。2本の worker で読込と保存の検査が並ぶと CPU を取り合い、p95 が上限 100ms を超えた)。
 * 見張る物が減らない事を、実際の Playwright の一覧(--list)で確かめる: 6本の検査は response-performance にだけ1回ずつあり、
 * 件数は組み替えの前と同じで、response-performance に6本以外は入らない。ファイルの名前の表は e2e/tests の実物と一致させる
 * (応答の検査が増えた時に、どの project で流すかを決めさせる)。上限・測り方・回数は spec と流れの側で変えていない。
 */
const root = new URL('../../../', import.meta.url);
const execFileAsync = promisify(execFile);
const LIST_TIMEOUT_MS = 60_000;
const PROJECT = 'response-performance';
/** 組み替えの前(functional 30 件・electron 15 件)と同じ件数(2026-11-17 の --list)。 */
const RESPONSE_SPECS: Readonly<Record<string, number>> = {
  'read-response.spec.ts': 9, 'firefox-read-response.spec.ts': 9, 'electron-read-response.spec.ts': 9,
  'save-performance.spec.ts': 6, 'firefox-save-performance.spec.ts': 6, 'electron-save-performance.spec.ts': 6,
};
const RESPONSE_FILE = /^(?:electron-|firefox-)?(?:read-response|save-performance)\.spec\.ts$/u;

interface ListedCase { readonly project: string; readonly file: string; readonly key: string }

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

function listItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** --reporter=json の suites を辿り、(project・ファイル・行・列・題)を集める。形が違えば止める。 */
function collectCases(suite: unknown, cases: ListedCase[]): void {
  for (const spec of listItems(field(suite, 'specs'))) {
    const file = field(spec, 'file'), line = field(spec, 'line'), column = field(spec, 'column'), title = field(spec, 'title');
    if (typeof file !== 'string' || typeof line !== 'number' || typeof column !== 'number' || typeof title !== 'string') {
      throw new Error('Playwright の一覧の spec の形が違います');
    }
    for (const test of listItems(field(spec, 'tests'))) {
      const project = field(test, 'projectName');
      if (typeof project !== 'string') throw new Error('Playwright の一覧の test に projectName がありません');
      cases.push({ project, file, key: JSON.stringify([project, file, line, column, title]) });
    }
  }
  for (const child of listItems(field(suite, 'suites'))) collectCases(child, cases);
}

async function listAllCases(): Promise<ListedCase[]> {
  const cli = createRequire(new URL('package.json', root)).resolve('@playwright/test/cli');
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, 'test', '--config=e2e/playwright.config.ts', '--list',
    '--reporter=json'], { cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 16_000_000 });
  if (stderr.trim() !== '') throw new Error(`Playwright列挙 stderr: ${stderr}`);
  const report: unknown = JSON.parse(stdout);
  const cases: ListedCase[] = [];
  for (const suite of listItems(field(report, 'suites'))) collectCases(suite, cases);
  return cases;
}

describe('入力の応答を測る検査は専用の project で1本ずつ流す(A-20)', () => {
  it('応答の検査のファイルの名前の表は e2e/tests の実物と一致する', () => {
    const files = readdirSync(new URL('e2e/tests/', root)).filter(name => RESPONSE_FILE.test(name)).sort();
    expect(files).toEqual(Object.keys(RESPONSE_SPECS).sort());
  });

  it('6本の検査は response-performance にだけ、組み替えの前と同じ件数で1回ずつあり、ほかの spec は入らない', async () => {
    const cases = await listAllCases();
    expect(cases.length).toBeGreaterThan(300);
    expect(new Set(cases.map(row => row.key)).size).toBe(cases.length);
    const response = cases.filter(row => row.file in RESPONSE_SPECS);
    expect(response.filter(row => row.project !== PROJECT).map(row => row.key)).toEqual([]);
    const counts = Object.fromEntries(Object.keys(RESPONSE_SPECS).map(file => [file, response.filter(row => row.file === file).length]));
    expect(counts).toEqual(RESPONSE_SPECS);
    expect(cases.filter(row => row.project === PROJECT && !(row.file in RESPONSE_SPECS)).map(row => row.key)).toEqual([]);
  }, LIST_TIMEOUT_MS + 10_000);
});
