import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('straight weld span Python kernel', () => {
  it('executes all 16 independent pure Python checks through the normal test entry', () => {
    const folder = fileURLToPath(new URL('./', import.meta.url));
    const script = fileURLToPath(new URL('./beamWeldSpan.test.py', import.meta.url));
    const result = spawnSync('python', ['-B', '-X', 'utf8', script, '-v'], {
      cwd: folder,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 2_000_000,
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    const detail = `Python exit=${String(result.status)} signal=${String(result.signal)}\n`
      + `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    expect(result.error, detail).toBeUndefined();
    expect(result.signal, detail).toBeNull();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 16 tests in [\d.]+s(?:\r?\n|$)/u);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)OK(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/^test_[^\r\n]+ \.\.\. ok\r?$/gmu)], detail).toHaveLength(16);
    // Preserve the successful Python names/summary in the ordinary unit output too.
    console.info(result.stderr.trim());
  }, 65_000); // 60s child deadline plus bounded process completion/reporting.
  it('executes the existing 15 contact checks plus 4 pure runtime-entry checks', () => {
    const folder = fileURLToPath(new URL('./', import.meta.url));
    const script = fileURLToPath(new URL('./beamWeldSpanContact.test.py', import.meta.url));
    const result = spawnSync('python', ['-B', '-X', 'utf8', script, '-v'], {
      cwd: folder, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    const detail = `Python exit=${String(result.status)} signal=${String(result.signal)}\n`
      + `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    expect(result.error, detail).toBeUndefined();
    expect(result.signal, detail).toBeNull();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 19 tests in [\d.]+s(?:\r?\n|$)/u);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)OK(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/^test_[^\r\n]+ \.\.\. ok\r?$/gmu)], detail).toHaveLength(19);
    console.info(result.stderr.trim());
  }, 65_000);
});
