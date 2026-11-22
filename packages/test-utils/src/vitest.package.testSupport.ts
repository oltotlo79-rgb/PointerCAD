import { defaultExclude, type ViteUserConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from './performanceSequencer.js';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from './releasePerformance.js';

interface TestFiles {
  include: string[];
}

type PackageConfigArgs =
  | [profile: 'default' | 'serial' | 'performance-serial', options: TestFiles]
  | [profile: 'performance-strict', options: TestFiles & { define?: Record<string, string> }]
  | [profile: 'kernel', options: TestFiles & { hookTimeout: number; pool: 'forks'; reporters: string[] }]
  | [profile: 'desktop', options: TestFiles & { serialFiles: string[] }];

/** パッケージの検査対象に、実行順と待機上限を組み合わせる。 */
export function createPackageVitestConfig(...[profile, options]: PackageConfigArgs): ViteUserConfig {
  const shared = { environment: 'node', testTimeout: profile === 'kernel' ? 120_000 : FUNCTIONAL_TEST_TIMEOUT_MS };
  const singleWorker = { fileParallelism: false };
  const test = { ...shared, include: options.include };
  if (profile === 'desktop') {
    return { test: { projects: [
      { test: { ...test, name: 'desktop', exclude: [...defaultExclude, ...options.serialFiles] } },
      { test: { ...shared, name: 'desktop-serial', include: options.serialFiles, ...singleWorker, sequence: { groupOrder: 1 } } },
    ] } };
  }
  if (profile === 'default') return { test };
  if (profile === 'serial') return { test: { ...test, ...singleWorker } };
  const ordered = { ...test, sequence: { sequencer: PerformanceFirstSequencer } };
  if (profile === 'performance-strict') {
    const config = { test: { ...ordered, fileParallelism: process.env.POINTERCAD_PERF_STRICT !== '1' } };
    return options.define === undefined ? config : { ...config, define: options.define };
  }
  const serial = { ...ordered, ...singleWorker };
  if (profile === 'kernel') {
    const { hookTimeout, pool, reporters } = options;
    return { test: { ...serial, hookTimeout, pool, reporters } };
  }
  return { test: serial };
}
