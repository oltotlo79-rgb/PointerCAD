import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

interface ListedSuite {
  suites?: ListedSuite[];
  specs?: { file: string; line: number; column: number; title: string; tests: { projectName: string }[] }[];
}

const root = new URL('../../../', import.meta.url);
const prerequisiteProjects = new Set(['viewport-performance', 'startup-firefox', 'startup-electron']);
const execFileAsync = promisify(execFile);

function listFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error ? error.code : null;
  const signal = 'signal' in error ? error.signal : null;
  const killed = 'killed' in error ? error.killed : null;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  const stdout = 'stdout' in error ? error.stdout : null;
  return JSON.stringify({ message: error.message,
    code: typeof code === 'number' || typeof code === 'string' ? code : null,
    signal: typeof signal === 'string' ? signal : null,
    killed: typeof killed === 'boolean' ? killed : null,
    stderr: stderr.slice(0, 4_000), stderrLength: stderr.length,
    stdoutLength: typeof stdout === 'string' || stdout instanceof Uint8Array ? stdout.length : null });
}

async function listCases(shard?: number): Promise<Map<string, string>> {
  const cli = createRequire(new URL('package.json', root)).resolve('@playwright/test/cli');
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, 'test', '--config=e2e/playwright.config.ts',
    '--list', '--reporter=json', ...(shard === undefined ? [] : [`--shard=${shard}/3`])], {
    cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 8_000_000,
  });
  if (stderr.trim() !== '') throw new Error(`Playwright列挙 stderr (${shard ?? 'whole'}): ${stderr}`);
  const report = JSON.parse(stdout) as ListedSuite;
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
  it('実際のPlaywrightが選ぶ3組の和集合は全検査と一致し、通常操作を重複させない', async () => {
    const labels = ['whole', 'shard1', 'shard2', 'shard3'] as const;
    // Playwrightは変換した検査ファイルと行の対応表(.map)を共有の変換キャッシュへ書き、書く前に同じファイルの
    // 控えを消す。キャッシュが空のまま2つの列挙を同時に流すと、片方が消して書き直す間の .map を他方が読めず、
    // そのファイルの全検査が変換後の行で列挙される(CI run 37260692577 の Linux)。全体の列挙を単独で流して
    // キャッシュを満たし、3組はキャッシュを読むだけの状態で同時に流す。
    const firstWaveStartedAt = Date.now();
    const firstWave = await Promise.allSettled([listCases()]);
    console.log('[CI分割] 列挙wave1', { elapsedMs: Date.now() - firstWaveStartedAt });
    const secondWaveStartedAt = Date.now();
    const secondWave = await Promise.allSettled([listCases(1), listCases(2), listCases(3)]);
    console.log('[CI分割] 列挙wave2', { elapsedMs: Date.now() - secondWaveStartedAt });
    const listed = [...firstWave, ...secondWave];
    const failures = listed.flatMap((result, index) => result.status === 'rejected'
      ? [`${labels[index]}: ${listFailure(result.reason)}`] : []);
    expect(failures).toEqual([]);
    const [whole, ...shards] = listed.map(result => {
      if (result.status !== 'fulfilled') throw new Error(`Playwright列挙に失敗: ${listFailure(result.reason)}`);
      return result.value;
    });
    if (whole === undefined || shards.length !== 3) throw new Error('全体と3分割の列挙が揃いません');
    expect(whole.size).toBeGreaterThan(300);
    const counts = new Map<string, number>();
    for (const [index, selected] of shards.entries()) {
      if (selected === undefined) throw new Error(`shard${index + 1}の列挙がありません`);
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
