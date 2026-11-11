import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function runPythonChecks(scriptName: string, expectedCount: number): void {
  const folder = fileURLToPath(new URL('./', import.meta.url));
  const script = fileURLToPath(new URL(`./${scriptName}`, import.meta.url));
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, '-v'], {
    cwd: folder,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2_000_000,
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  const detail = `Python ${scriptName} exit=${String(result.status)} signal=${String(result.signal)}\n`
    + `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
  // Keep actual child output on both success and failure in the normal unit log.
  console.info(detail);
  expect(result.error, detail).toBeUndefined();
  expect(result.signal, detail).toBeNull();
  expect(result.status, detail).toBe(0);
  expect(result.stderr, detail).toMatch(new RegExp(`(?:^|\\r?\\n)Ran ${expectedCount} ${expectedCount === 1 ? 'test' : 'tests'} in [\\d.]+s(?:\\r?\\n|$)`, 'u'));
  expect(result.stderr, detail).toMatch(/(?:^|\r?\n)OK(?:\r?\n|$)/u);
  // unittest prints a test's docstring on a second line. Count starts and successful endings separately.
  expect([...result.stderr.matchAll(/^test_[^\r\n]+/gmu)], detail).toHaveLength(expectedCount);
  expect([...result.stderr.matchAll(/ \.\.\. ok\r?$/gmu)], detail).toHaveLength(expectedCount);
}

describe('friction Python normal test entry (pure NumPy)', () => {
  it('executes all 32 independent contact checks', () => {
    runPythonChecks('beamFrictionContact.test.py', 32);
  }, 65_000);

  it('executes all 7 owned runtime checks with the same contact core', () => {
    runPythonChecks('beamFrictionRuntime.test.py', 7);
  }, 65_000);

  it('executes the initial-shortening orientation check (4 directions)', () => {
    runPythonChecks('beamJointConnection.test.py', 1);
  }, 65_000);
});
