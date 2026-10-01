import { expect, test, type Page } from '@playwright/test';
import { waitForStartupHealth } from './startupHealth.js';

// Firefox cancels the old page's pending module fetches as soon as a navigation starts. The
// startup retry (apps/web/src/startupRecovery.ts) must not take that for a load failure and
// replace the reload or the other address the person asked for (NS_BINDING_ABORTED on CI).
// The name ends in "smoke.spec.ts" so that the Firefox project runs it as well as Chromium.
const RETRY_KEY = 'pointercad.startup-retry.v1';
const MAIN_CHUNK = /\/assets\/main-[\w-]+\.js$/u;

interface Observed {
  readonly navigations: string[];
  readonly startupErrors: string[];
}

function observe(page: Page): Observed {
  const observed: Observed = { navigations: [], startupErrors: [] };
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) observed.navigations.push(request.url());
  });
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('PointerCAD startup failed')) observed.startupErrors.push(message.text());
  });
  page.on('pageerror', error => { observed.startupErrors.push(error.message); });
  return observed;
}

/** Hold only the first request for the application body until the next navigation starts. */
async function holdFirstMainChunk(page: Page, observed: Observed): Promise<{ readonly requested: Promise<void>; readonly held: () => number }> {
  let held = 0;
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route(MAIN_CHUNK, async route => {
    held += 1;
    if (held === 1) {
      const before = observed.navigations.length;
      requested();
      await expect.poll(() => observed.navigations.length, { timeout: 30_000 }).toBeGreaterThan(before);
    }
    // Firefox has already cancelled the held request at this point; Chromium still wants it.
    await route.continue().catch(() => undefined);
  });
  return { requested: started, held: () => held };
}

async function expectEditorStarted(page: Page): Promise<void> {
  await expect(page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }))
    .toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-startup-shell]')).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), RETRY_KEY)).toBeNull();
}

test('起動の読込み中に読み直しても、起動の再試行が読み直しを置き換えない', async ({ page }) => {
  const observed = observe(page);
  const hold = await holdFirstMainChunk(page, observed);
  await page.goto('/', { waitUntil: 'commit' });
  await hold.requested;
  const before = observed.navigations.length;
  await page.reload();
  await expectEditorStarted(page);
  expect(hold.held()).toBeGreaterThanOrEqual(2);
  expect(observed.navigations.slice(before)).toHaveLength(1);
  expect(observed.startupErrors).toEqual([]);
});

test('起動の読込み中に別の画面へ移っても、元の画面へ引き戻さない', async ({ page }) => {
  const observed = observe(page);
  const hold = await holdFirstMainChunk(page, observed);
  await page.goto('/', { waitUntil: 'commit' });
  await hold.requested;
  const before = observed.navigations.length;
  await page.goto('/?startup-navigation=other');
  await expectEditorStarted(page);
  expect(new URL(page.url()).search).toBe('?startup-navigation=other');
  expect(observed.navigations.slice(before).map(url => new URL(url).search)).toEqual(['?startup-navigation=other']);
  expect(observed.startupErrors).toEqual([]);
});

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`JSなしでも起動画面を先に描き、8秒後に読み直す入口を表示する: ${reducedMotion}`, async ({ browser }, info) => {
    const baseURL = info.project.use.baseURL;
    if (typeof baseURL !== 'string') throw new Error('Startup test base URL is missing');
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false, reducedMotion });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('[data-startup-shell]')).toBeVisible();
      await expect(page.locator('.pcad-startup__mark')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'PointerCAD', exact: true })).toBeVisible();
      await expect(page.getByRole('status')).toHaveText('画面を準備しています。');
      const recovery = page.locator('.pcad-startup__recovery');
      const retry = recovery.locator('a');
      await expect(recovery).toBeHidden();
      await expect(retry).toHaveAttribute('href', '');
      await page.keyboard.press('Tab');
      await expect(retry).not.toBeFocused();
      await page.screenshot({ path: info.outputPath('startup-without-js-waiting.png') });
      // Wait for the real CSS delay; script execution is disabled in this context.
      await expect(page.getByRole('link', { name: '画面を読み込み直す', exact: true })).toBeVisible({ timeout: 12_000 });
      const animation = await recovery.evaluate(element => {
        const current = element.getAnimations()[0];
        return { time: Number(current?.currentTime), delay: Number(current?.effect?.getTiming().delay) };
      });
      expect(animation.delay).toBe(8000);
      expect(animation.time).toBeGreaterThanOrEqual(8000);
      await expect(page.locator('[data-startup-failure]')).toBeHidden();
      await page.getByRole('heading', { name: 'PointerCAD', exact: true }).click();
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      await page.screenshot({ path: info.outputPath('startup-without-js.png') });
    } finally { await context.close(); }
  });
}

test('本体の読込みを待つ間も起動画面を描き、減らす設定を守って実描画後に消す', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release = (): void => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(MAIN_CHUNK, async route => { await held; await route.continue(); });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-startup-shell]')).toBeVisible();
    await expect(page.locator('.pcad-shell')).toHaveCount(0);
    await expect(page.locator('.pcad-startup__recovery')).toBeHidden();
    expect(await page.locator('.pcad-startup__track').evaluate(element =>
      getComputedStyle(element, '::after').animationName)).toBe('none');
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(22, 24, 29)');
    await page.screenshot({ path: info.outputPath('startup-waiting.png') });
  } finally { release(); }
  await expectEditorStarted(page);
  await waitForStartupHealth(page, info);
  expect(await page.locator('#root').evaluate(element => element instanceof HTMLElement && element.inert)).toBe(false);
  const stages = await page.evaluate(() => ['bootstrap', 'load-start', 'modules-ready', 'view-ready', 'splash-hidden']
    .map(stage => performance.getEntriesByName(`pcad:startup:${stage}`)[0]?.startTime ?? -1));
  stages.forEach(value => { expect(value).toBeGreaterThanOrEqual(0); });
  expect(stages).toEqual([...stages].sort((a, b) => a - b));
});
