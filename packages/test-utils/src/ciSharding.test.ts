import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ListedSuite {
  suites?: ListedSuite[];
  specs?: { file: string; line: number; column: number; title: string; tests: { projectName: string }[] }[];
}

const root = new URL('../../../', import.meta.url);
const prerequisiteProjects = new Set(['viewport-performance', 'startup-firefox', 'startup-electron']);

function listCases(shard?: number): Map<string, string> {
  const cli = createRequire(new URL('package.json', root)).resolve('@playwright/test/cli');
  const output = execFileSync(process.execPath, [cli, 'test', '--config=e2e/playwright.config.ts',
    '--list', '--reporter=json', ...(shard === undefined ? [] : [`--shard=${shard}/3`])], {
    cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 8_000_000,
  });
  const report = JSON.parse(output) as ListedSuite;
  const cases = new Map<string, string>();
  function collect(suite: ListedSuite): void {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      const key = JSON.stringify([test.projectName, spec.file, spec.line, spec.column, spec.title]);
      if (cases.has(key)) throw new Error(`検査が二重に登録されています: ${key}`);
      cases.set(key, test.projectName);
    }
    for (const child of suite.suites ?? []) collect(child);
  }
  collect(report);
  return cases;
}

describe('CIの3分割は全操作を保って別の実行機へ配る', () => {
  it('実際のPlaywrightが選ぶ3組の和集合は全検査と一致し、通常操作を重複させない', () => {
    const whole = listCases();
    expect(whole.size).toBeGreaterThan(300);
    const counts = new Map<string, number>();
    for (const shard of [1, 2, 3]) {
      const selected = listCases(shard);
      expect(selected.size).toBeGreaterThan(0);
      for (const [key, project] of selected) {
        expect(whole.get(key), key).toBe(project);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect([...counts.keys()].sort()).toEqual([...whole.keys()].sort());
    for (const [key, project] of whole) {
      if (!prerequisiteProjects.has(project)) expect(counts.get(key), key).toBe(1);
    }
    console.log('[CI分割] 全操作の選択と前提検査を照合', { total: whole.size, partitions: 3 });
  });

  it('両OSの3組を実行し、欠落・中止・失敗を既存の合格名へ変えない', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    const shards = workflow.slice(workflow.indexOf('  sharded-checks:'), workflow.indexOf('\n  checks:'));
    expect(shards).toContain('os: [windows-latest, ubuntu-latest]');
    expect(shards).toContain('shard: [1, 2, 3]');
    expect(shards).toContain('fail-fast: false');
    expect(shards).toContain("./scripts/check.ps1 -Install -E2EShard '${{ matrix.shard }}/3'");
    expect(shards).not.toContain('--no-deps');
    const combined = workflow.slice(workflow.indexOf('\n  checks:'));
    expect(combined).toContain('if: always()');
    expect(combined).toContain('needs: sharded-checks');
    expect(combined).toContain('${{ needs.sharded-checks.result }}');
    expect(combined).toContain("if ($env:SHARDED_RESULT -ne 'success') { throw");
  });
});
