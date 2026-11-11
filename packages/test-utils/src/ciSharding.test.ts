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
const LIST_TIMEOUT_MS = 45_000;
// 画面検査の組の数(この検査の中の唯一の値。2026-11-12 に3から6へ)。ci.yml の matrix.shard と check.ps1 へ渡す '/N'、
// scripts/check.ps1 の $ciE2EShardTotal、scripts/lib/ci_stage_evidence.py の SHARD_TOTAL と同じにする。ci.yml との一致は
// 下の検査が実物から読み取って確かめ、3か所の一致は ci_stage_evidence.py の自己試験が確かめる。
const SHARD_TOTAL = 6;
const shardNumbers = Array.from({ length: SHARD_TOTAL }, (_, index) => index + 1);

/** ci.yml の画面検査の組の数を、matrix.shard の並びと check.ps1 へ渡す '/N' の両方から読み取る(改行は LF・CRLF のどちらでもよい)。 */
function workflowShardDeclarations(workflow: string): { matrices: number[][]; totals: number[]; shardArguments: number } {
  const matrices = [...workflow.matchAll(/^ +shard: \[([0-9, ]*)\][ \t]*\r?$/gmu)]
    .map(match => (match[1] ?? '').split(',').map(part => Number(part.trim())));
  const totals = [...workflow.matchAll(/-E2EShard '\$\{\{ matrix\.shard \}\}\/([0-9]+)'/gu)].map(match => Number(match[1]));
  return { matrices, totals, shardArguments: workflow.split('-E2EShard').length - 1 };
}

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
    '--list', '--reporter=json', ...(shard === undefined ? [] : [`--shard=${shard}/${SHARD_TOTAL}`])], {
    cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 8_000_000,
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

describe(`CIの${SHARD_TOTAL}分割は全操作を保って別の実行機へ配る`, () => {
  it(`実際のPlaywrightが選ぶ${SHARD_TOTAL}組の和集合は全検査と一致し、通常操作を重複させない`, async () => {
    const labels = ['whole', ...shardNumbers.map(number => `shard${number}`)];
    // Playwrightは変換した検査ファイルと行の対応表(.map)を共有の変換キャッシュへ書き、書く前に同じファイルの
    // 控えを消す。キャッシュが空のまま2つの列挙を同時に流すと、片方が消して書き直す間の .map を他方が読めず、
    // そのファイルの全検査が変換後の行で列挙される(CI run 37260692577 の Linux)。全体の列挙を単独で流して
    // キャッシュを満たし、各組はキャッシュを読むだけの状態で同時に流す(組ごとの列挙の上限 LIST_TIMEOUT_MS は2波目でも1回分)。
    const firstWaveStartedAt = Date.now();
    const firstWave = await Promise.allSettled([listCases()]);
    console.log('[CI分割] 列挙wave1', { elapsedMs: Date.now() - firstWaveStartedAt });
    const secondWaveStartedAt = Date.now();
    const secondWave = await Promise.allSettled(shardNumbers.map(number => listCases(number)));
    console.log('[CI分割] 列挙wave2', { elapsedMs: Date.now() - secondWaveStartedAt });
    const listed = [...firstWave, ...secondWave];
    const failures = listed.flatMap((result, index) => result.status === 'rejected'
      ? [`${labels[index] ?? index}: ${listFailure(result.reason)}`] : []);
    expect(failures).toEqual([]);
    const [whole, ...shards] = listed.map(result => {
      if (result.status !== 'fulfilled') throw new Error(`Playwright列挙に失敗: ${listFailure(result.reason)}`);
      return result.value;
    });
    if (whole === undefined || shards.length !== SHARD_TOTAL) throw new Error(`全体と${SHARD_TOTAL}分割の列挙が揃いません`);
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
    console.log('[CI分割] 全操作の選択と前提検査を照合', { total: whole.size, partitions: SHARD_TOTAL });
  }, LIST_TIMEOUT_MS * 2 + 10_000);

  it(`両OSの前段・単体の先行分・画面検査${SHARD_TOTAL}組を同時に流し、欠落・中止・失敗を既存の合格名へ変えない`, () => {
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
    expect(e2e).toContain(`shard: [${shardNumbers.join(', ')}]`);
    expect(e2e).toContain("./scripts/check.ps1 -Install -CIStage E2E -E2EShard '${{ matrix.shard }}/" + String(SHARD_TOTAL) + "'" + evidence);
    const combined = workflow.slice(workflow.indexOf('\n  checks:'));
    expect(combined).toContain('os: [windows-latest, ubuntu-latest]');
    expect(combined).toContain('if: always()');
    expect(combined).toContain('needs: [front, unit-lead, e2e]');
    for (const job of ['front', 'unit-lead', 'e2e']) expect(combined).toContain('${{ needs.' + job + '.result }}');
    expect(combined).toContain("-ne 'success'");
    expect(combined).toContain('pattern: ci-stage-*');
    expect(combined).toContain('./scripts/check.ps1 -CIStage Verify' + evidence);
  });

  it(`組の数の定数${SHARD_TOTAL}はci.ymlのmatrixと'/N'から読み取った値と一致し、3組の古い形を残さない`, () => {
    // 読み取りの補助が CRLF・古い3組・二重の matrix を見分けること(実物の照合が空振りで通らないように)。
    const sample = (numbers: string, total: number, lineEnding = '\n'): string => '        shard: [' + numbers + ']' + lineEnding
      + "        run: ./scripts/check.ps1 -E2EShard '${{ matrix.shard }}/" + String(total) + "'" + lineEnding;
    expect(workflowShardDeclarations(sample('1, 2, 3, 4, 5, 6', 6, '\r\n')))
      .toEqual({ matrices: [[1, 2, 3, 4, 5, 6]], totals: [6], shardArguments: 1 });
    expect(workflowShardDeclarations(sample('1, 2, 3', 3))).toEqual({ matrices: [[1, 2, 3]], totals: [3], shardArguments: 1 });
    expect(workflowShardDeclarations(sample('1, 2, 3, 4, 5, 6', 6).repeat(2)).matrices).toHaveLength(2);
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    const declared = workflowShardDeclarations(workflow);
    // matrix.shard はちょうど1つで 1〜SHARD_TOTAL の並び、-E2EShard はちょうど1か所で '/SHARD_TOTAL' を渡す。
    expect(declared.matrices).toEqual([shardNumbers]);
    expect(declared.shardArguments).toBe(1);
    expect(declared.totals).toEqual([SHARD_TOTAL]);
    // 3組の時の古い形(組の数を変えた時に古い行が残ると、実行機の組と check.ps1 へ渡す '/N' がずれる)。
    for (const retired of ['shard: [1, 2, 3]', "${{ matrix.shard }}/3'"]) expect(workflow).not.toContain(retired);
  });

  it.each(['\n', '\r\n'])('単体の先行分は両OSで対応するPythonからNumPy固定の仮想環境を用意する（改行 %j）', lineEnding => {
    const checkedOut = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
      .replace(/\r\n/gu, '\n').replace(/\n/gu, lineEnding);
    // Git may check this same workflow out with LF or CRLF; preserve all content and order.
    const workflow = checkedOut.replace(/\r\n/gu, '\n');
    const unitLead = workflow.slice(workflow.indexOf('\n  unit-lead:'), workflow.indexOf('\n  e2e:'));
    expect(unitLead).toContain('os: [windows-latest, ubuntu-latest]');
    expect(unitLead).toContain('runs-on: ${{ matrix.os }}');
    const setup = `      - name: Set up Python for native FEM tests
        uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.6.0
        with:
          python-version: '3.13'`;
    const prepare = `      - name: Prepare Python for native FEM tests
        shell: pwsh
        run: |
          python -c "import sys; assert (3,10) <= sys.version_info[:2] <= (3,13), sys.version"
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
          $venv = Join-Path $env:RUNNER_TEMP pointercad-python
          python -m venv $venv
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
          $bin = if ($IsWindows) { Join-Path $venv Scripts } else { Join-Path $venv bin }
          $python = Join-Path $bin python
          & $python -m pip install numpy==2.2.5
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
          & $python -c "import numpy; assert numpy.__version__ == '2.2.5'"
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
          $bin | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append`;
    expect(unitLead).toContain(setup);
    expect(unitLead).toContain(prepare);
    expect(unitLead.indexOf(setup)).toBeLessThan(unitLead.indexOf(prepare));
    expect(unitLead.indexOf(prepare)).toBeLessThan(unitLead.indexOf('単体の先行分 (scripts/check.ps1)'));
  });
});
