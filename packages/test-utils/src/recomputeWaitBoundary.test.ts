import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const file = 'e2e/tests/assembly.spec.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('E2Eの再計算待ちを共通の世代・結末・有限上限へ集約する', () => {
  it('実効lintが独自の待機を拒否し、通常の状態読取と共通待機を許可する', async () => {
    const configured: unknown = await new ESLint({ cwd: root }).calculateConfigForFile(file);
    if (!record(configured) || !record(configured.rules)) throw new Error('Missing effective E2E rules');
    const guard: unknown = configured.rules['no-restricted-syntax'];
    if (!Array.isArray(guard)) throw new Error('Missing recomputation polling guard');
    const parts: readonly unknown[] = guard;
    expect(parts[0]).toBe(2);
    const config: Linter.Config = {
      files: ['**/*.ts'], languageOptions: { parser: tseslint.parser, sourceType: 'module' },
      rules: { 'no-restricted-syntax': [2, ...parts.slice(1)] },
    };
    const lint = (source: string) => new Linter().verify(source, [config], { filename: file });
    for (const source of [
      'await expect.poll(async () => (await readRecomputeStats(page)).lastOutcome).toBe("success");',
      'await expect.poll(async () => stats.completedGeneration === stats.requestedGeneration).toBe(true);',
      'await expect.poll(async () => !stats.isComputing).toBe(true);',
      'const width = Number(getComputedStyle(element).width);',
      'import data from "./fixture.json";',
    ]) {
      const messages = lint(source);
      expect(messages.some(message => message.ruleId === 'no-restricted-syntax'), source).toBe(true);
      expect(messages.some(message => message.fatal), source).toBe(false);
    }
    for (const source of [
      'await waitForRecompute(page, token);',
      'await waitForRecomputeOutcome(page, token, "failed");',
      'const state = await readRecomputeStats(page); expect(state.requestedGeneration).toBe(2);',
      'await expect.poll(async () => page.locator(".row").count()).toBe(2);',
    ]) expect(lint(source), source).toEqual([]);
  });
});
