/**
 * 検査専用。製品のコードからは import しない。
 * 固定の計算部（CPython と同梱の SymPy wheel）を検査から起動する唯一の入口と、同じタイミングの
 * 実計算を1回の準備でまとめる共有エンジン。1回の起動は wheel から SymPy をコンパイルし直すため、
 * CPU で約5〜6秒かかる。1つの検査（it）の中の起動は2回までとし、超えた検査は理由を示して
 * 失敗させる（rules/06 §10.323）。
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { expect, TestRunner, type RunnerTestCase } from 'vitest';
import type { ExactMathEngine } from './exactMathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';

/** Launches one test may make. */
export const EXACT_RUNTIME_LAUNCHES_PER_TEST = 2;
const GUIDANCE = '同じタイミングの計算は共有エンジンでまとめる。rules/06 §10.323';
const launches = new WeakMap<RunnerTestCase, number>();

/** `spawnSync('python', args, options)` for the exact runtime, counted per running test. */
export function spawnExactRuntime(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  const test = TestRunner.getCurrentTest<RunnerTestCase | undefined>();
  if (test !== undefined) {
    const count = (launches.get(test) ?? 0) + 1;
    launches.set(test, count);
    const limit = EXACT_RUNTIME_LAUNCHES_PER_TEST;
    if (count === limit + 1) {
      // A thrown error could be absorbed by the calculation's own error handling
      // (an engine failure becomes an invalid reply); a soft assertion always fails the test.
      expect.soft(count, `1つの検査で計算部を${String(count)}回以上起動しました（上限${String(limit)}回）。${GUIDANCE}`)
        .toBeLessThanOrEqual(limit);
    }
  }
  return spawnSync('python', args, options);
}

/**
 * `--batch` runner for one fixed runtime test script; returns the script's JSON replies unchanged.
 * `timeoutPerRequest` is the allowance each request had when it started its own runtime, so one
 * launch serving `count` requests keeps the same total allowance.
 */
export function exactRuntimeBatch(script: string, timeoutPerRequest: number, maxBuffer = 2_000_000): (input: string, count: number) => string {
  return (input, count) => {
    const execution = spawnExactRuntime(['-B', '-X', 'utf8', script, '--batch'], {
      input, encoding: 'utf8', timeout: timeoutPerRequest * Math.max(1, count), maxBuffer,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (execution.error !== undefined || execution.status !== 0) {
      throw new Error(`${execution.error?.message ?? ''}
${execution.stderr}`);
    }
    return execution.stdout;
  };
}

interface ExactRuntimeRequest { readonly expression: MathNode; readonly angleUnit: 'degree' | 'radian' }

/**
 * Like the product engine, one prepared runtime serves every real calculation requested in the
 * same turn; each request still sends its own prepared expression and receives its own reply.
 * `runBatch` receives the JSON array of requests (and their number) and returns the JSON array
 * of replies. `evaluateMany` keeps one request's inputs together, as the product does.
 */
export function sharedExactEngine(runBatch: (input: string, count: number) => string,
  mismatch = '実計算の返信数が一致しません。'): Required<ExactMathEngine> {
  let waiting: { readonly requests: readonly ExactRuntimeRequest[];
    readonly resolve: (values: readonly unknown[]) => void; readonly reject: (reason: Error) => void }[] = [];
  const flush = (): void => {
    const groups = waiting;
    waiting = [];
    try {
      const requests = groups.flatMap(group => group.requests);
      const replies: unknown = JSON.parse(runBatch(JSON.stringify(requests), requests.length));
      if (!Array.isArray(replies) || replies.length !== requests.length) throw new Error(mismatch);
      let offset = 0;
      for (const group of groups) {
        group.resolve(replies.slice(offset, offset + group.requests.length));
        offset += group.requests.length;
      }
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      for (const group of groups) group.reject(reason);
    }
  };
  const enqueue = (requests: readonly ExactRuntimeRequest[]): Promise<readonly unknown[]> => new Promise((resolve, reject) => {
    if (waiting.length === 0) setImmediate(flush);
    waiting.push({ requests, resolve, reject });
  });
  return {
    evaluate: async (expression, angleUnit) => (await enqueue([{ expression, angleUnit }]))[0],
    evaluateMany: inputs => inputs.length === 0 ? Promise.resolve([])
      : enqueue(inputs.map(({ expression, angleUnit }) => ({ expression, angleUnit }))),
  };
}
