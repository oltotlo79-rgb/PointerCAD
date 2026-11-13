import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// The production wait executes unchanged; only the browser and Playwright assertion adapter are fake.
const pollState = vi.hoisted(() => ({ timeouts: [] as number[], outcomes: [] as unknown[] }));
vi.mock('@playwright/test', async () => {
  const assertions = await import('vitest');
  const assertion = (value: unknown, message?: string) => Object.assign(assertions.expect(value, message), {
    toBeVisible: () => Promise.resolve(),
  });
  return { expect: Object.assign(assertion, {
    poll: (read: () => Promise<unknown>, options: { timeout: number }) => {
      pollState.timeouts.push(options.timeout);
      return { not: { toBe: async (waiting: unknown): Promise<void> => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const outcome = await read();
          pollState.outcomes.push(outcome);
          if (outcome !== waiting) return;
        }
        throw new Error('Fake polling exhausted the finite supplied observations');
      } } };
    },
  }) };
});

vi.mock('../../../e2e/tests/electronAppFlow.js', () => ({ openTarget: () => Promise.resolve() }));

interface WaitModule {
  waitForRecompute(page: unknown, token: { requestedGeneration: number; startedAtMs: number }, kind?: 'kernel' | 'exact-math'): Promise<void>;
  waitForRecomputeOutcome(page: unknown, token: { requestedGeneration: number; startedAtMs: number }, outcome: 'success' | 'failed' | 'cancelled', kind?: 'kernel' | 'exact-math'): Promise<void>;
}
interface WaitObservation {
  requestedGeneration: number;
  completedGeneration: number;
  pendingWaiters: number;
  lastOutcome: 'success' | 'failed';
  isComputing: boolean;
}
type DiagnosticReaders = 'absent' | 'readable' | 'failing' | 'hanging';
const assemblyDiagnostic = { status: 'idle', events: [{ gate: 'fake-gate' }], dropped: 0, observerFailures: 0 };
const meshDiagnostic = { host: { epoch: 3, changes: [{ change: 'fake-change' }], dropped: 0, failures: 0 }, validations: [], dropped: 0, failures: 0 };
const statusDiagnostic = 'エラー: 立体を作れませんでした: カーネル(OCCT)を読み込めませんでした: TypeError: fetch failed';
const runtimeRecord = (seq: number, phase: string) => ({ seq, phase, dispatchId: 'mesh-1-1-2', partId: 'part:current', generation: 9 });
const runtimeDiagnostic = { status: 'observed', reason: null,
  main: { records: [runtimeRecord(1, 'dispatch'), runtimeRecord(2, 'reply-rejected')] },
  worker: { records: [runtimeRecord(1, 'occt-load-throw')] } };
// The real browser callbacks run against a fake window. Only pcadRecomputeStats is a recompute-state
// observation; the Assembly/Mesh/status/runtime-phase readers are post-failure diagnostics and are counted separately.
function observedPage(observations: readonly WaitObservation[], diagnostics: DiagnosticReaders = 'absent') {
  let reads = 0;
  const diagnosticReads: string[] = [];
  const diagnostic = (name: string, value: unknown) => () => {
    diagnosticReads.push(name);
    if (diagnostics === 'failing') throw new Error(`${name} diagnostic read failed`);
    return value;
  };
  const pcadRecomputeStats = () => {
    const stats = observations[reads];
    reads += 1;
    if (stats === undefined) throw new Error('Unexpected observation after the terminal result');
    return stats;
  };
  const readers = diagnostics === 'absent' ? {} : {
    pcadAssemblyRecomputeGates: diagnostic('assembly', assemblyDiagnostic),
    pcadMeshLedgerDiagnostics: diagnostic('mesh', meshDiagnostic),
    pcadRuntimePhases: diagnostic('runtime', diagnostics === 'hanging' ? new Promise(() => undefined) : Promise.resolve(runtimeDiagnostic)),
  };
  // The progress snapshot only looks the status line up; the failure diagnostic reads its text.
  const statusLine = { get textContent(): unknown { return diagnostic('status', statusDiagnostic)(); } };
  vi.stubGlobal('window', { pcadRecomputeStats, ...readers });
  vi.stubGlobal('document', { querySelector: (selector: string) =>
    diagnostics !== 'absent' && selector === '.pcad-statusbar__text' ? statusLine : null });
  return {
    reads: () => reads,
    diagnosticReads: () => [...diagnosticReads],
    evaluate: <T, A>(callback: (arg?: A) => T, arg?: A): Promise<T> => Promise.resolve().then(() => callback(arg)),
  };
}

// importActual loads the actual E2E module through Vite, without adding it to this package's TS rootDir.
const waits = await vi.importActual<WaitModule>('../../../e2e/tests/recompute.ts');
const reopening = await vi.importActual<{ reopenPart(page: unknown, info: unknown, filename: string): Promise<void> }>('../../../e2e/tests/reopenPart.ts');
const math = await vi.importActual<{ EXACT_MATH_ENGINE_LIMITS: { readonly totalMs: number } }>('../../expression/src/math/publicClient.js');
const release = await vi.importActual<{ RECOMPUTE_TIMEOUT_MS: number }>('./releasePerformance.js');

describe('実待機関数の有限上限と終端の挙動', () => {
  const done: WaitObservation = { requestedGeneration: 9, completedGeneration: 9, pendingWaiters: 0, lastOutcome: 'success', isComputing: false };
  const token = () => ({ requestedGeneration: 8, startedAtMs: Date.now() });
  beforeEach(() => { pollState.timeouts.length = 0; pollState.outcomes.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('通常の待機はkernel正本の上限を使う', async () => {
    await waits.waitForRecompute(observedPage([done]), token());
    expect(pollState.timeouts).toEqual([release.RECOMPUTE_TIMEOUT_MS]);
  });
  it('任意の文書を開く共通入口が既定で数学正本を選び、新しい世代を待つ', async () => {
    const chosen: string[] = [];
    const values: unknown[] = [
      { ...done, requestedGeneration: 8, completedGeneration: 8 },
      { stats: { ...done, pendingWaiters: 1 }, progress: '' },
      { stats: done, progress: '' },
    ];
    const open = { click: () => Promise.resolve() };
    const page = {
      waitForFunction: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      getByRole: () => ({ getByRole: () => open }),
      waitForEvent: () => Promise.resolve({ setFiles: (path: string) => { chosen.push(path); return Promise.resolve(); } }),
      evaluate: () => {
        const value = values.shift();
        if (value === undefined) throw new Error('Unexpected read after reopening completed');
        return Promise.resolve(value);
      },
    };
    const filename = 'arbitrary-formula-document.pcad';
    await reopening.reopenPart(page, { outputPath: (name: string) => `/fake/${name}` }, filename);
    expect(chosen).toEqual([`/fake/${filename}`]);
    expect(pollState.timeouts).toEqual([math.EXACT_MATH_ENGINE_LIMITS.totalMs]);
    expect(pollState.outcomes).toEqual(['waiting', 'success']);
    expect(values).toEqual([]);
  });
  it('数学区分は実クライアント正本の上限を使う', async () => {
    await waits.waitForRecompute(observedPage([done]), token(), 'exact-math');
    expect(pollState.timeouts).toEqual([math.EXACT_MATH_ENGINE_LIMITS.totalMs]);
  });
  it('前世代・未完の最新世代・pendingありを成功とせず最新完了まで待つ', async () => {
    const page = observedPage([
      { ...done, requestedGeneration: 8, completedGeneration: 8 },
      { ...done, completedGeneration: 8 },
      { ...done, pendingWaiters: 1 },
      done,
    ]);
    await waits.waitForRecompute(page, token(), 'exact-math');
    expect(pollState.outcomes).toEqual(['waiting', 'waiting', 'waiting', 'success']);
    expect(page.reads()).toBe(4);
  });
  it('最新世代の失敗はpendingが残っていても次の観測を待たず通知する', async () => {
    const expectedDiagnostics: Record<Exclude<DiagnosticReaders, 'hanging'>, string> = {
      absent: '{"status":"unavailable"}\nMesh ledger: {"status":"unavailable"}\n帯の文: 帯なし\nカーネルの段: {"status":"unavailable"}',
      readable: `${JSON.stringify(assemblyDiagnostic)}\nMesh ledger: ${JSON.stringify(meshDiagnostic)}\n帯の文: ${statusDiagnostic}\n` +
        'カーネルの段: {"status":"observed","reason":null,"main":["dispatch:g9:mesh-1-1-2","reply-rejected:g9:mesh-1-1-2"],' +
        '"worker":["occt-load-throw:g9:mesh-1-1-2"],"occtLoadThrows":1}',
      failing: 'assembly diagnostic read failed\nMesh ledger: mesh diagnostic read failed\n' +
        '帯の文: status diagnostic read failed\nカーネルの段: runtime diagnostic read failed',
    };
    const notices: string[] = [];
    for (const diagnostics of ['absent', 'readable', 'failing'] as const) {
      pollState.timeouts.length = 0;
      pollState.outcomes.length = 0;
      const page = observedPage([{ ...done, lastOutcome: 'failed', pendingWaiters: 1 }, done], diagnostics);
      const error: unknown = await waits.waitForRecompute(page, token(), 'exact-math').then(() => null, (reason: unknown) => reason);
      const cause = error instanceof Error ? error.cause : null;
      if (!(error instanceof Error) || !(cause instanceof Error)) throw new Error(`${diagnostics}: missing terminal notice with its original error`);
      // Terminal failed is observed once in one finite poll; the following success is never read.
      expect(page.reads(), diagnostics).toBe(1);
      expect(pollState.outcomes, diagnostics).toEqual(['failed']);
      expect(pollState.timeouts, diagnostics).toEqual([math.EXACT_MATH_ENGINE_LIMITS.totalMs]);
      // Diagnostics run after the terminal observation, separately from it, once per reader.
      expect(page.diagnosticReads(), diagnostics).toEqual(diagnostics === 'absent' ? [] : ['assembly', 'mesh', 'status', 'runtime']);
      const [notice = '', diagnosticText = ''] = error.message.split('\nAssembly recompute gates: ');
      expect(cause.message, diagnostics).toContain('最新世代の結末が期待と異なる場合は上限まで待たず知らせる');
      expect(notice.endsWith(`\n${cause.message}`), diagnostics).toBe(true);
      expect(diagnosticText, diagnostics).toBe(expectedDiagnostics[diagnostics]);
      notices.push(notice.replace(/ロード\/待機時間=\d+ms/, 'ロード/待機時間=<ms>'));
    }
    expect(notices[0]).toMatch(/^再計算待ち失敗: 期待=success, ロード\/待機時間=<ms>, 操作前requestedGeneration=8, 最後のrequestedGeneration=9, completedGeneration=9, lastOutcome=failed, 最後の進捗=進捗表示なし\n/);
    expect(new Set(notices).size).toBe(1);
  });
  it('カーネルの段の読み取りが返らなくても、有限の上限で打ち切って失敗の文を出す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const page = observedPage([{ ...done, lastOutcome: 'failed' }], 'hanging');
      const pending = waits.waitForRecompute(page, token()).then(() => null, (reason: unknown) => reason);
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await pending;
      if (!(error instanceof Error)) throw new Error('missing terminal notice');
      expect(error.message.endsWith(`\n帯の文: ${statusDiagnostic}\nカーネルの段: {"status":"timeout","limitMs":5000}`)).toBe(true);
      expect(page.diagnosticReads()).toEqual(['assembly', 'mesh', 'status', 'runtime']);
    } finally { vi.useRealTimers(); }
  });
  it('明示的な失敗期待も実Outcome関数で直ちに完了する', async () => {
    const page = observedPage([{ ...done, lastOutcome: 'failed' }]);
    await waits.waitForRecomputeOutcome(page, token(), 'failed', 'exact-math');
    expect(pollState.outcomes).toEqual(['failed']);
    expect(pollState.timeouts).toEqual([math.EXACT_MATH_ENGINE_LIMITS.totalMs]);
    expect(page.reads()).toBe(1);
  });
});
