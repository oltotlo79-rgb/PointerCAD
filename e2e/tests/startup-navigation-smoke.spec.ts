import { expect, test, type Page } from '@playwright/test';

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
