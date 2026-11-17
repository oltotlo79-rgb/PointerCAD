import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { E2E_BOTH_PROJECTS, E2E_DESKTOP_PROJECTS, E2E_WEB_PROJECTS, e2eBuildTargets, e2eWebServer } from '../../../scripts/lib/e2eWebServer.mjs';

/*
 * 画面検査の組み立て(playwright の config.webServer)を、流す project に要る側だけに絞る(2026-11-16、統括の決定 案 (b))。
 * 夜の RUN 20261116-225521 は --project=electron --no-deps なのに、使わない web の build と preview まで流し、
 * その段で上限 180 秒に達した。絞るのは、--project=名前 が全部、知っている project と完全に一致し、--no-deps がある時だけ。
 * 外部検査(check.ps1 -CIStage E2E -E2EShard k/6)と手元の全体検査の命令の形では、今までどおり両方を組み立てる。
 */
const CONFIG = '--config';
const diag = (...rest: string[]) => ['node', 'playwright/cli.js', 'test', CONFIG, 'e2e/playwright.config.ts', ...rest];

describe('流す project に要る組み立て', () => {
  it.each([
    [['--project=electron', '--no-deps'], 'desktop'],
    [['--project=startup-electron', '--project=electron', '--no-deps'], 'desktop'],
    [['--project=functional', '--no-deps'], 'web'],
    [['--project=firefox', '--no-deps'], 'web'],
    [['--project=viewport-performance', '--project=startup-firefox', '--no-deps'], 'web'],
  ] as const)('%j → %s(使う側だけを毎回組み立てる)', (args, expected) => {
    expect(e2eBuildTargets(diag('a.spec.ts', ...args, '--output=out'))).toBe(expected);
  });

  it.each([
    [['--project=functional', '--project=electron', '--no-deps'], '混ざる'],
    [['--project=elec*', '--no-deps'], 'glob'],
    [['--project=chromium', '--no-deps'], '知らない名前'],
    [['--project=', '--no-deps'], '空の名前'],
    [['--project', 'electron', '--no-deps'], '空白で区切った形(読まない)'],
    [['--project=electron'], '--no-deps 無し(依存の viewport-performance は web)'],
    [['--project=response-performance', '--no-deps'], '応答の検査は chromium・firefox・electron を 1 つの project で流す'],
    [['--project=response-performance', '--project=electron', '--no-deps'], '応答の検査と Electron'],
    [['--no-deps'], '--project 無し'],
    [[], '指定なし'],
  ] as const)('%j(%s)→ 両方', (args, reason) => {
    expect(e2eBuildTargets(diag(...args)), reason).toBe('both');
  });

  it('外部検査と手元の全体検査の命令の形では両方を組み立てる(scripts/check.ps1 の $e2eArgs)', () => {
    // CI: pnpm run test:e2e --shard=k/6(--project なし)。
    for (const shard of ['1/6', '6/6']) expect(e2eBuildTargets(diag(`--shard=${shard}`))).toBe('both');
    // 手元の全体検査(-Full): --project なし。
    expect(e2eBuildTargets(diag())).toBe('both');
    // 手元の軽い検査(変えた操作あり): 起動の 2 つと functional・electron を混ぜる(--no-deps の診断でも同じ)。
    const light = ['--project=startup-firefox', '--project=startup-electron', '--project=functional', '--project=electron',
      '--project=response-performance', 'e2e/tests/smoke.spec.ts', 'e2e/tests/firefox-graphics.spec.ts', 'e2e/tests/electron-startup.spec.ts'];
    expect(e2eBuildTargets(diag(...light))).toBe('both');
    expect(e2eBuildTargets(diag(...light, '--no-deps'))).toBe('both');
    // 手元の軽い検査(変えた操作なし): 性能・起動の 3 つを混ぜる。
    const startup = ['--project=viewport-performance', '--project=startup-firefox', '--project=startup-electron'];
    expect(e2eBuildTargets(diag(...startup))).toBe('both');
    expect(e2eBuildTargets(diag(...startup, '--no-deps'))).toBe('both');
  });

  it('知っている project の名前は e2e/playwright.config.ts の project と過不足なく一致する(増えたら分類を求める)', () => {
    const config = readFileSync(new URL('../../../e2e/playwright.config.ts', import.meta.url), 'utf8');
    const names = [...config.matchAll(/^\s*name: '([\w-]+)'/gmu)].map(match => match[1]).sort();
    expect([...E2E_DESKTOP_PROJECTS, ...E2E_WEB_PROJECTS, ...E2E_BOTH_PROJECTS].sort()).toEqual(names);
  });
});

describe('webServer の命令', () => {
  const ready = 'C:/repo/scripts/lib/e2eBuildReady.mjs';
  it('両方: 今までと同じ命令(desktop の build → web の build → preview)と url', () => {
    expect(e2eWebServer('both', 4173, ready)).toEqual({
      command: 'pnpm --filter @pointercad/desktop run build && pnpm --filter @pointercad/web run build && '
        + 'pnpm --filter @pointercad/web run preview --port 4173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
    });
  });
  it('web だけ: web の build と preview だけで、desktop を組み立てない', () => {
    const server = e2eWebServer('web', 4173, ready);
    expect(server).toEqual({
      command: 'pnpm --filter @pointercad/web run build && pnpm --filter @pointercad/web run preview --port 4173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
    });
  });
  it('desktop だけ: desktop の build の後に済んだ印を出し、web と preview を流さない(url を持たない)', () => {
    const server = e2eWebServer('desktop', 4173, ready);
    expect(server.command).toBe(`pnpm --filter @pointercad/desktop run build && node "${ready}"`);
    expect(server.command).not.toContain('@pointercad/web');
    expect(server.url).toBeUndefined();
    expect(server.wait?.stdout.test('PCAD_E2E_DESKTOP_BUILD_READY\n')).toBe(true);
    // vite の組み立ての出力では済んだと見なさない。
    expect(server.wait?.stdout.test('built in 12.3s')).toBe(false);
  });
});
