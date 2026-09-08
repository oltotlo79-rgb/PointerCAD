import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface RootPackageJson {
  scripts?: Record<string, string>;
}

const rootUrl = new URL('../../../', import.meta.url);

function readRootFile(path: string): string {
  return readFileSync(new URL(path, rootUrl), 'utf8');
}

describe('品質ゲートのテスト実行順', () => {
  it('性能検査を含む各パッケージを専有実行し、長いkernelを後へ回す', () => {
    const packageJson = JSON.parse(readRootFile('package.json')) as RootPackageJson;

    expect(packageJson.scripts?.test).toBe(
      'pnpm --recursive --reverse --workspace-concurrency=1 --if-present run test',
    );
  });

  it.each([
    'packages/expression/vitest.config.ts',
    'packages/io/vitest.config.ts',
    'packages/kernel/vitest.config.ts',
    'packages/model/vitest.config.ts',
    'packages/ui/vitest.config.ts',
  ])('%sが厳密性能検査の固定順を使う', (path) => {
    const config = readRootFile(path);

    expect(config).toContain('PerformanceFirstSequencer');
    expect(config).toContain('sequence: { sequencer: PerformanceFirstSequencer }');
    expect(config).toContain('fileParallelism:');
  });

  it('連続E2Eはほかの4段を重複させず品質ゲートの正本から実行する', () => {
    const checkScript = readRootFile('scripts/check.ps1');

    expect(checkScript).toContain('[int]$E2ERepeats = 1');
    expect(checkScript).toContain('$e2eRun -le $E2ERepeats');
    expect(checkScript).toContain('$e2eArgs = @("run", "test:e2e")');
    expect(checkScript).toMatch(/Invoke-Check[^\r\n]*pnpm \$e2eArgs/u);
  });

  it('E2E操作上限をPlaywrightのuse内に置き、遮られた操作を15秒で止める', () => {
    const config = readRootFile('e2e/playwright.config.ts');
    const useIndex = config.indexOf('use: {');

    expect(useIndex).toBeGreaterThan(0);
    expect(config.slice(0, useIndex)).not.toContain('actionTimeout:');
    expect(config.slice(useIndex)).toMatch(/use:\s*\{[\s\S]*?actionTimeout:\s*15_000,/u);
  });

  it('絞り込み診断は余分な区切りを挟まずgrepをPlaywrightへ渡す', () => {
    const checkScript = readRootFile('scripts/check.ps1');

    expect(checkScript).toContain('$e2eArgs += @("--grep", $E2EGrep)');
    expect(checkScript).not.toContain('@("--", "--grep", $E2EGrep)');
  });
});
