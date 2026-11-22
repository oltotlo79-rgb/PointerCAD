import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExclude } from 'vitest/config';
import { PerformanceFirstSequencer } from './performanceSequencer.js';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from './releasePerformance.js';
import { createPackageVitestConfig } from './vitest.package.testSupport.js';

const include = ['src/**/*.test.ts'];
const files = { include };
const shared = { environment: 'node', testTimeout: 60_000 };
const test = { ...shared, include };
const ordered = { ...test, sequence: { sequencer: PerformanceFirstSequencer } };

afterEach(() => vi.unstubAllEnvs());

describe('パッケージの Vitest 設定', () => {
  it.each([
    [undefined, true], ['0', true], ['1', false],
  ] as const)('厳密性能モード %s で既定値・固定順・worker 数を保つ', (strict, fileParallelism) => {
    vi.stubEnv('POINTERCAD_PERF_STRICT', strict);
    expect(FUNCTIONAL_TEST_TIMEOUT_MS).toBe(60_000);
    expect(createPackageVitestConfig('default', files)).toStrictEqual({ test });
    expect(createPackageVitestConfig('serial', files)).toStrictEqual({ test: { ...test, fileParallelism: false } });
    expect(createPackageVitestConfig('performance-serial', files)).toStrictEqual({ test: { ...ordered, fileParallelism: false } });
    expect(createPackageVitestConfig('performance-strict', files)).toStrictEqual({ test: { ...ordered, fileParallelism } });
    const define = { __PCAD_APP_VERSION__: '"1.0"' };
    expect(createPackageVitestConfig('performance-strict', { include, define })).toStrictEqual({ define, test: { ...ordered, fileParallelism } });
    const occt = { hookTimeout: 180_000, pool: 'forks' as const, reporters: ['default'] };
    expect(createPackageVitestConfig('kernel', { include, ...occt })).toStrictEqual({
      test: { ...ordered, testTimeout: 120_000, fileParallelism: false, ...occt },
    });
  });

  it('desktop の両組に待機上限を渡し、負荷に弱いファイルは後段だけで直列に流す', () => {
    const serialFiles = ['src/main/startupBundle.test.ts'];
    expect(createPackageVitestConfig('desktop', { include, serialFiles })).toStrictEqual({ test: { projects: [
      { test: { ...test, name: 'desktop', exclude: [...defaultExclude, ...serialFiles] } },
      { test: { ...shared, name: 'desktop-serial', include: serialFiles, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ] } });
  });
});
