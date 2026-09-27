import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/validation-progress.mjs', import.meta.url));
function progress(log: string | Buffer, exit?: string, now?: number) {
  const args = [script, '--stdin', ...(exit === undefined ? [] : [exit])];
  const launch = now === undefined ? args : ['--input-type=module', '--eval',
    `Date.now = () => ${String(now)}; process.argv = [process.execPath, ...${JSON.stringify(args)}]; await import(${JSON.stringify(pathToFileURL(script).href)});`];
  const result = spawnSync(process.execPath, launch, { input: log, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { status: string; e2ePassedEvents: number; e2eFailedEvents: number; failedE2E: string[];
    report: { latestEntry: string | null; ageMinutes: number | null; updateDue: boolean; action: string | null } };
}

describe('進捗報告は成功行だけを数えず実際の失敗を保持する', () => {
  it.each(['✘', '×', 'x', 'not ok'])('%sの失敗が後続の成功や終了コード0で隠れない', marker => {
    const result = progress(`✓ 63 [functional] › 保存 (1s)\n${marker} 64 [functional] › 保存再開 (1m)\n✓ 65 [functional] › 次の操作 (1s)`, '0');
    expect(result).toMatchObject({ status: 'failed', e2ePassedEvents: 2, e2eFailedEvents: 1 });
    expect(result.failedE2E[0]).toContain('保存再開');
  });
  it('ASCIIの成功と色付きUnicodeの失敗を同じログから数える', () => {
    const escape = String.fromCharCode(27);
    expect(progress(`ok 1 [electron] › 開く\n${escape}[31m✘ 2 [firefox] › 保存${escape}[0m`))
      .toMatchObject({ status: 'failed', e2ePassedEvents: 1, e2eFailedEvents: 1 });
  });
  it('最後まで成功行しかなくても実行中を合格とは表示しない', () => {
    expect(progress('✓ 1 [functional] › 開く\n')).toMatchObject({ status: 'running', e2ePassedEvents: 1 });
    expect(progress('✓ 1 [functional] › 開く\n', '0').status).toBe('passed');
  });
  it.each(['Test Files 1 failed | 67 passed (68)', 'Tests 2 failed | 973 passed (975)',
    '3 failed', '[NG] (3/5) pnpm run test が失敗しました'])('%sは成功件数があっても失敗とする', summary => {
    expect(progress(`✓ 1 [functional] › 開く\n${summary}`).status).toBe('failed');
  });
  it('終了コードの失敗を結果行の欠落で合格にしない', () => {
    expect(progress('操作記録が途切れた', '1').status).toBe('failed');
  });
  it('期待した拒否の説明文や寸法の掛け算記号を失敗件数にしない', () => {
    expect(progress('[OK] 入力を拒否した\n✓ 3 [functional] › 20 × 30 の板 (1s)\n[診断] Error: invalid input\n', '0'))
      .toMatchObject({ status: 'passed', e2ePassedEvents: 1, e2eFailedEvents: 0 });
  });
  it('Windowsの旧来の日本語文字コードでもASCIIの失敗を見落とさない', () => {
    const log = Buffer.concat([Buffer.from('x 1 [firefox] '), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from('\n')]);
    expect(progress(log)).toMatchObject({ status: 'failed', e2eFailedEvents: 1 });
  });
  it.each([[9, false], [10, true], [18, true], [-2, true]] as const)(
    '実ファイルの報告から%s分なら更新警告は%sとなり、検査の成功とは分ける', (minutes, due) => {
      const report = readFileSync(new URL('../../../docs/報告記録.md', import.meta.url), 'utf8');
      const heading = report.match(/^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?:\s|$)/mu);
      if (heading === null) throw new Error('報告記録の日時が見つかりません。');
      const recordedAt = Date.parse(`${heading[1]}T${heading[2]}:00+09:00`);
      const result = progress('✓ 1 [functional] › 保存\n', '0', recordedAt + minutes * 60_000);
      expect(result.status).toBe('passed');
      expect(result.report).toMatchObject({ latestEntry: heading[0].trim(), ageMinutes: minutes, updateDue: due });
      expect(result.report.action === null).toBe(!due);
    });
});
