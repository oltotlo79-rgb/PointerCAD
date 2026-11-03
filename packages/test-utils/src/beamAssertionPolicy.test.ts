import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rule = 'beam-assertion/separate-result';
const targets = ['attachBeamAnalysis.impact.test.ts', 'attachBeamAnalysis.impactMembers.test.ts',
  'attachBeamAnalysis.impactEndForces.test.ts', 'beamSession.contact.test.ts'];
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js'), fix: false, cache: false,
    overrideConfig: [{ ...tseslint.configs.disableTypeChecked, files: ['**/*.ts'] }] });
});

async function check(path: string, source: string): Promise<string[]> {
  const results = await eslint.lintText(source, { filePath: resolve(root, path) });
  expect(results).toHaveLength(1);
  expect(results[0]?.messages.some(message => message.fatal)).toBe(false);
  return (results[0]?.messages ?? []).map(message => message.ruleId ?? 'unknown');
}

it.each(['expect([x.result, x.status]).toEqual([null, 1]);',
  "expect([x['result'], x.status]).toEqual([null, 1]);",
  'expect([x?.result, x.status]).toEqual([null, 1]);',
  "expect([x?.['result'], x.status]).toEqual([null, 1]);"])('rejects a direct result array element: %s', async source => {
  for (const name of targets) expect(await check(`packages/ui/src/beam/${name}`, source)).toContain(rule);
});

it('allows a separate result, small nested value and out-of-scope files', async () => {
  const path = `packages/ui/src/beam/${targets[0]}`;
  for (const source of ['expect(x.result).toBeNull();', 'expect([x.result.samples[0].timeS]).toEqual([0]);',
    'expect([x.status, x.reviewed]).toEqual([1, null]);']) {
    expect(await check(path, source)).not.toContain(rule);
  }
  expect(await check('packages/ui/src/beam/other.test.ts', 'expect([x.result]).toEqual([null]);')).toContain(rule);
  expect(await check('packages/ui/src/solid/other.test.ts', 'expect([x.result]).toEqual([null]);')).not.toContain(rule);
});

it('preserves the existing layer restriction', async () => {
  const rules = await check(`packages/ui/src/beam/${targets[0]}`, "import { value } from '@pointercad/kernel'; expect([x.result]).toEqual([value]);");
  expect(rules).toContain(rule);
  expect(rules).toContain('no-restricted-imports');
});
