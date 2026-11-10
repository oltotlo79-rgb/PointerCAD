import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleAnalysis, productFiles } from './packageImportBoundary.testSupport.js';

type ModuleAnalysis = ReturnType<typeof moduleAnalysis>;

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directories = ['packages/ui/src', 'packages/ui/integration', 'packages/help-content/src',
  'packages/model/src', 'packages/test-utils/src'] as const;
const sourceFile = (path: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path);
interface Violation { consumer: string; specifier: string; typeOnly: boolean; reason: string }
// Exact source and AST expression only; any edit or new consumer requires review.
const dynamicBaseline = [
  { consumer: 'packages/ui/src/math/localExactMathEngine.ts',
    sha256: 'ff2ea75ac30155819f7aa42410b67490d7f098d0ff6c765e1ca7d00a1928ff00',
    expression: 'moduleUrl', reason: 'Loads the shipped pyodide.mjs from the fixed runtime folder.' },
  { consumer: 'packages/test-utils/src/functionSizePolicy.test.ts',
    sha256: 'fdd61741dd3dbe49260312b0524ab51ff47a9a93d10d9ca3d922ef57967f93ae',
    expression: "new URL('../../../eslint.functionSizeBaseline.js', import.meta.url).href",
    reason: 'Loads the fixed root ESLint function-size baseline.' },
  { consumer: 'packages/test-utils/src/complexityPolicy.test.ts',
    sha256: '7bae3516350179aa404f1d4519f2aad3e0fa0feb07797835640bdf6c7029d81b',
    expression: "new URL('../../../eslint.complexityBaseline.js', import.meta.url).href",
    reason: 'Loads only the fixed root parameter-count and nesting-depth baseline.' },
  { consumer: 'packages/test-utils/src/workerReferencesPolicy.test.ts',
    sha256: '4412da7b032b10e25bb3a3e56e33e3c6258eb0012d3b5b52f21010c97df68849',
    expression: "new URL('../../../eslint.workerReferences.js', import.meta.url).href",
    reason: 'Loads only the fixed root ESLint worker-reference allowlist.' },
] as const;
// The parsed expressions are passed in when the caller already analysed the same text, so each file is parsed once.
function dynamicFindings(consumer: string, text: string,
  expressions: readonly string[] = moduleAnalysis(consumer, text).dynamicExpressions): { expression: string; approved: boolean }[] {
  if (expressions.length === 0) return [];
  const hash = createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
  const seen = new Set<string>();
  return expressions.map(expression => {
    const match = dynamicBaseline.some(item => item.consumer === consumer && item.sha256 === hash
      && item.expression === expression);
    const approved = match && !seen.has(expression);
    seen.add(expression);
    return { expression, approved };
  });
}


function violations(consumer: string, text: string, analysis?: ModuleAnalysis): Violation[] {
  const owner = /^packages\/(ui|help-content|model|test-utils)\//u.exec(consumer)?.[1];
  if (owner === undefined) return [];
  const { references, dynamicExpressions } = analysis ?? moduleAnalysis(consumer, text);
  const unknown: Violation[] = dynamicFindings(consumer, text, dynamicExpressions).filter(item => !item.approved)
    .map(item => ({ consumer, specifier: item.expression, typeOnly: false, reason: 'unresolved-dynamic-import' }));
  return unknown.concat(references.flatMap(({ specifier, typeOnly }) => {
    const path = (specifier.split(/[?#]/u, 1)[0] ?? '').replaceAll('\\', '/');
    const relative = path.startsWith('./') || path.startsWith('../');
    const target = relative ? posix.normalize(posix.join(posix.dirname(consumer), path)) : path;
    const pkg = relative ? /^packages\/([^/]+)(?:\/|$)/u.exec(target)?.[1]
      : /^@pointercad\/([^/]+)(?:\/|$)/u.exec(target)?.[1];
    if (pkg === undefined || pkg === owner) return [];
    const targetSubpath = relative ? target.slice(`packages/${pkg}`.length) : target.slice(`@pointercad/${pkg}`.length);
    const privatePath = relative && /^\/(?:src|dist)(?:\/|$)/u.test(targetSubpath);
    const privateAlias = !relative && /^\/(?:src|dist)(?:\/|$)/u.test(targetSubpath);
    const forbiddenDirection = (owner === 'ui' && pkg === 'kernel')
      || (['help-content', 'model'].includes(owner) && pkg === 'ui')
      || (owner === 'test-utils' && pkg === 'model' && !typeOnly);
    const reason = forbiddenDirection ? 'forbidden-direction' : privatePath || privateAlias ? 'private-src-or-dist' : '';
    return reason ? [{ consumer, specifier, typeOnly, reason }] : [];
  }));
}
const forms = [
  (p: string) => `import value from '${p}';`,
  (p: string) => `import type { Value } from '${p}';`,
  (p: string) => `export { value } from '${p}';`,
  (p: string) => `export * from '${p}';`,
  (p: string) => `export type { Value } from '${p}';`,
  (p: string) => `const load = () => import('${p}');`,
  (p: string) => `type Value = typeof import('${p}').value;`,
];

describe('P10 source module boundaries', () => {
  it('rejects actual private references and forbidden directions in the specified layers', () => {
    const failures: Violation[] = [];
    const approvedDynamic: string[] = [];
    for (const directory of directories) {
      const files = productFiles(root, directory, sourceFile);
      expect(files.length, directory).toBeGreaterThan(0);
      for (const path of files) {
        const text = readFileSync(resolve(root, path), 'utf8');
        const analysis = moduleAnalysis(path, text);
        failures.push(...violations(path, text, analysis));
        for (const item of dynamicFindings(path, text, analysis.dynamicExpressions)) if (item.approved) approvedDynamic.push(path);
      }
    }
    expect(approvedDynamic.sort()).toEqual(dynamicBaseline.map(item => item.consumer).sort());
    expect(failures).toEqual([]);
  });
  it.each(dynamicBaseline)('binds the dynamic import allowance to exact bytes and consumer: $consumer', item => {
    const original = readFileSync(resolve(root, item.consumer), 'utf8').replaceAll('\r\n', '\n');
    expect(dynamicFindings(item.consumer, original).map(finding => finding.approved)).toEqual([true]);
    expect(dynamicFindings(item.consumer, original.replaceAll('\n', '\r\n')).map(finding => finding.approved)).toEqual([true]);
    expect(dynamicFindings(item.consumer, original + '\n').every(finding => !finding.approved)).toBe(true);
    expect(dynamicFindings(item.consumer + '.other.ts', original).every(finding => !finding.approved)).toBe(true);
    expect(dynamicFindings(item.consumer, original, ['otherUrl']).map(finding => finding.approved)).toEqual([false]);
    expect(dynamicFindings(item.consumer, original, [item.expression, item.expression]).map(finding => finding.approved)).toEqual([true, false]);
  });
  it('rejects private paths and forbidden directions across static, type, export and dynamic forms', () => {
    for (const form of forms) {
      expect(violations('packages/ui/src/future.ts', form('@pointercad/kernel/testing/occt-node'))).toHaveLength(1);
      expect(violations('packages/model/src/future.ts', form('../../ui/src/private.js?raw'))).toHaveLength(1);
      expect(violations('packages/help-content/src/future.ts', form('@pointercad/ui'))).toHaveLength(1);
      expect(violations('packages/ui/integration/future.ts', form('../../model/src/unused/../private.js'))).toHaveLength(1);
    }
    for (const form of [forms[0], forms[2], forms[3], forms[5]]) {
      expect(violations('packages/test-utils/src/future.ts', form('@pointercad/model'))).toHaveLength(1);
    }
  });
  it('allows public testing entries in permitted directions, type-only model references, and ordinary text', () => {
    expect(violations('packages/ui/src/future.ts', forms[0]('@pointercad/model/testing/fixtures'))).toEqual([]);
    expect(violations('packages/test-utils/src/future.ts', forms[1]('@pointercad/model'))).toEqual([]);
    expect(violations('packages/test-utils/src/future.ts', "import { type A, type B } from '@pointercad/model';")).toEqual([]);
    expect(violations('packages/test-utils/src/future.ts', "export { type A } from '@pointercad/model';")).toEqual([]);
    expect(violations('packages/test-utils/src/future.ts', "import { type A, B } from '@pointercad/model';")).toHaveLength(1);
    expect(violations('packages/model/src/future.ts', "// import x from '@pointercad/ui';\nconst text = '@pointercad/ui';")).toEqual([]);
    expect(violations('e2e/tests/future.ts', forms[0]('@pointercad/kernel'))).toEqual([]);
    expect(violations('packages/ui/src/future.ts', "const load = () => import('../../' + name);")).toHaveLength(1);
    expect(violations('packages/ui/src/future.ts', "const load = () => import/* split */(name);")).toHaveLength(1);
    const item = dynamicBaseline[0];
    const original = readFileSync(resolve(root, item.consumer), 'utf8');
    const lf = original.replaceAll('\r\n', '\n');
    const crlf = lf.replaceAll('\n', '\r\n');
    expect(dynamicFindings(item.consumer, lf).map(v => v.approved)).toEqual([true]);
    expect(dynamicFindings(item.consumer, crlf).map(v => v.approved)).toEqual([true]);
    expect(dynamicFindings('packages/ui/src/math/other.ts', lf).map(v => v.approved)).toEqual([false]);
    const changed = readFileSync(resolve(root, item.consumer), 'utf8') + '\n';
    expect(violations(item.consumer, changed).some(v => v.reason === 'unresolved-dynamic-import')).toBe(true);
    expect(violations(item.consumer, "const load = () => import(otherUrl);")).toHaveLength(1);
  });
});
