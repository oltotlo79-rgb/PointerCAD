import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('W19 fixed-point Coulomb friction state', () => {
  it('executes all 18 independent state, derivative and provenance checks', () => {
    const result = spawnSync('python', ['-B', '-X', 'utf8',
      fileURLToPath(new URL('./solidContactFriction.test.py', import.meta.url)), '-v'], {
      cwd: fileURLToPath(new URL('./', import.meta.url)), encoding: 'utf8',
      timeout: 60_000, maxBuffer: 2_000_000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    const detail = `Python exit=${String(result.status)} signal=${String(result.signal)}\n`
      + `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    expect(result.error, detail).toBeUndefined();
    expect(result.signal, detail).toBeNull();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 18 tests in [\d.]+s(?:\r?\n|$)/u);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)OK(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/^test_[^\r\n]+ \.\.\. ok\r?$/gmu)], detail).toHaveLength(18);
    console.info(result.stdout.trim());
    console.info(result.stderr.trim());
  }, 65_000);
});
