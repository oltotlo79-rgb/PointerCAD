import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rule = 'worker-references/no-worker-references';
const materialPath = ['scratchpad', 'claude', 'agents', 'example'].join('/');
const worker = ['cl', 'v103', 'example'].join('-');
const shortWorker = ['w', '87a'].join('');
const paths = ['packages/model/src/index.ts', 'packages/ui/src/shell/PropertyPanel.test.tsx',
  'packages/model/src/part/solidPlanKeyGeometry.ts', 'packages/model/src/kernelBridge/solidContracts.ts',
  'apps/web/src/helpChunkPolicy.ts', 'e2e/tests/example.spec.ts'];
interface ExceptionEntry { file: string; text: string; count: number; reason: string }
let entries: ExceptionEntry[];
let eslint: ESLint;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exceptionEntry(value: unknown): value is ExceptionEntry {
  return record(value) && typeof value.file === 'string' && typeof value.text === 'string'
    && typeof value.count === 'number' && Number.isInteger(value.count) && value.count > 0
    && typeof value.reason === 'string' && value.reason.length > 0;
}

beforeAll(async () => {
  eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js'), fix: false, cache: false,
    overrideConfig: [{ ...tseslint.configs.disableTypeChecked, files: ['**/*.{ts,tsx}'] }] });
  const loaded: unknown = await import(new URL('../../../eslint.workerReferences.js', import.meta.url).href);
  if (!record(loaded) || !Array.isArray(loaded.WORKER_REFERENCE_ALLOWLIST)
    || !loaded.WORKER_REFERENCE_ALLOWLIST.every(exceptionEntry)) throw new Error('Invalid exception metadata');
  entries = loaded.WORKER_REFERENCE_ALLOWLIST;
});

async function messages(path: string, source: string) {
  const results = await eslint.lintText(source, { filePath: resolve(root, path) });
  expect(results).toHaveLength(1);
  expect(results[0]?.messages.some(message => message.fatal), path).toBe(false);
  return (results[0]?.messages ?? []).filter(message => message.ruleId === rule);
}

it('実効設定でpackages・apps・E2Eと狭い規則の対象にも登録される', async () => {
  for (const path of paths) {
    const config: unknown = await eslint.calculateConfigForFile(path);
    if (!record(config) || !record(config.rules)) throw new Error(`Missing configuration: ${path}`);
    expect(config.rules[rule], path).toEqual([2]);
    expect(await messages(path, `// ${materialPath}`), path).toHaveLength(1);
  }
  for (const path of ['eslint.config.js', 'scripts/lint.mjs']) {
    expect(await messages(path, `// ${materialPath}`), path).toEqual([]);
  }
});

describe('既存の7つの不正参照を拒否する', () => {
  const sources = [
    `// see ${materialPath}`,
    `const id = '${worker}';`,
    `// ${shortWorker}`,
    'const path = `' + materialPath.replaceAll('/', '\\\\') + '`;',
    'const path = /' + materialPath.replaceAll('/', '\\/') + '/;',
    `const id = '${['cx', 'mc23', 'example'].join('-')}';`,
    `const id = '${['cx', 'p13', 'example'].join('-')}';`,
  ];
  it.each(sources)('%s', async source => {
    const found = await messages(paths[0], source);
    expect(found).toHaveLength(1);
    expect(found[0]?.messageId).toBe('reference');
  });
});

describe('コメント・文字列・正規表現・テンプレート・JSXを検査する', () => {
  const sources = [`/* ${materialPath.toUpperCase()} */`, `const value = "${materialPath}";`,
    'const value = /' + materialPath.replaceAll('/', '\\/') + '/;',
    'const value = `' + materialPath + '${value}`;',
    `const value = <div>${materialPath}</div>;`];
  it.each(sources)('%s', async source => {
    expect(await messages(paths[1], source)).toHaveLength(1);
  });
});

it('既存の対照文字列と識別子を誤検出しない', async () => {
  for (const value of ['w21-test-fixture', 'row1a', 'W91A', 'cx-1', 'pointercad-w21-test', 'scratchpad/temp']) {
    expect(await messages(paths[0], `// ${value}\nconst value = '${value}';`)).toEqual([]);
  }
  expect(await messages(paths[0], `const ${shortWorker} = 1;`)).toEqual([]);
});

it('6例外のファイル・文字列・件数・理由を固定する', () => {
  expect(entries).toHaveLength(6);
  expect(new Set(entries.map(entry => entry.file)).size).toBe(6);
  expect(entries.map(entry => entry.count)).toEqual([22, 1, 2, 1, 1, 1]);
  expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex'))
    .toBe('54c067d768a7bbde825e1ff64c0554bc1bc2e67b788b35d4dac61f1c3d91a43d');
});

it('実在する6例外を許可し、同じ文字列を別ファイルでは拒否する', async () => {
  for (const entry of entries) {
    const source = readFileSync(resolve(root, entry.file), 'utf8');
    expect(await messages(entry.file, source), entry.file).toEqual([]);
    expect((await messages(paths[0], `// ${entry.text}`)).some(message => message.messageId === 'reference')).toBe(true);
  }
});

it('例外の件数の増減と、許可文字列に混ざる別の参照を拒否する', async () => {
  for (const entry of entries) {
    const exact = Array.from({ length: entry.count }, () => `// ${entry.text}`).join('\n');
    expect(await messages(entry.file, exact), entry.file).toEqual([]);
    const fewer = Array.from({ length: entry.count - 1 }, () => `// ${entry.text}`).join('\n');
    for (const source of [exact + `\n// ${entry.text}`, fewer]) {
      const found = await messages(entry.file, source);
      expect(found, entry.file).toHaveLength(1);
      expect(found[0]?.messageId).toBe('allowlistCount');
    }
    const found = await messages(entry.file, exact + ` ${worker}`);
    expect(found, entry.file).toHaveLength(1);
    expect(found[0]?.messageId).toBe('reference');
  }
});
