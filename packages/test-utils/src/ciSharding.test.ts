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

  it('両OSの前段・単体の先行分・画面検査3組を同時に流し、欠落・中止・失敗を既存の合格名へ変えない', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    const section = (name: string, next: string): string =>
      workflow.slice(workflow.indexOf(`\n  ${name}:`), workflow.indexOf(`\n  ${next}:`));
    const front = section('front', 'unit-lead');
    const unitLead = section('unit-lead', 'e2e');
    const e2e = section('e2e', 'checks');
    const evidence = " -StageEvidence '${{ runner.temp }}/pointercad-ci-stage'";
    for (const stage of [front, unitLead, e2e]) {
      expect(stage).toContain('os: [windows-latest, ubuntu-latest]');
      expect(stage).toContain('fail-fast: false');
      expect(stage).toContain('if-no-files-found: error');
      // 各段は他の段を待たずに同時に流れる(画面検査は前段の成果物を使わない)。
      expect(stage).not.toContain('needs:');
      expect(stage).not.toContain('--no-deps');
    }
    expect(front).toContain('./scripts/check.ps1 -Install -CIStage Front' + evidence);
    expect(unitLead).toContain('./scripts/check.ps1 -Install -CIStage UnitLead' + evidence);
    expect(e2e).toContain('shard: [1, 2, 3]');
    expect(e2e).toContain("./scripts/check.ps1 -Install -CIStage E2E -E2EShard '${{ matrix.shard }}/3'" + evidence);
    const combined = workflow.slice(workflow.indexOf('\n  checks:'));
    expect(combined).toContain('os: [windows-latest, ubuntu-latest]');
    expect(combined).toContain('if: always()');
    expect(combined).toContain('needs: [front, unit-lead, e2e]');
    for (const job of ['front', 'unit-lead', 'e2e']) expect(combined).toContain('${{ needs.' + job + '.result }}');
    expect(combined).toContain("-ne 'success'");
    expect(combined).toContain('pattern: ci-stage-*');
    expect(combined).toContain('./scripts/check.ps1 -CIStage Verify' + evidence);
  });
});
