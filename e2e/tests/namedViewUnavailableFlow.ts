import { expect, type Page, type Route, type TestInfo } from '@playwright/test';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import { boxPartFile, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { installSaveCapture } from './usabilityKeyboardFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForStartupReady } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

export type NamedViewMode = 'part' | 'assembly';
const viewportModule = /\/assets\/ViewportCanvas-[\w-]+\.js(?:\?.*)?$/u;
const baselineViewName = 'R20 camera refusal baseline';

async function selectBaselineView(page: Page): Promise<string> {
  const menu = page.locator('.pcad-named-views');
  const choice = menu.getByRole('combobox', { name: uiMessage('view', 'view.named.choose'), exact: true });
  await expect(choice.getByRole('option', { name: baselineViewName, exact: true })).toHaveCount(1);
  await choice.selectOption({ label: baselineViewName });
  const selected = await choice.evaluate(select => {
    if (!(select instanceof HTMLSelectElement)) throw new Error('Actual named-view select missing');
    const option = select.selectedOptions[0];
    return option === undefined ? null : { value: option.value, label: option.textContent };
  });
  if (selected === null || selected.value === '' || selected.label !== baselineViewName) {
    throw new Error('Actual baseline named-view label/value mismatch');
  }
  await expect(choice).toHaveValue(selected.value);
  await expect(menu.locator('input')).toHaveValue(baselineViewName);
  return selected.value;
}

async function openSaved(page: Page, kind: NamedViewMode, bytes: Uint8Array): Promise<void> {
  await installSaveCapture(page, [{ name: kind === 'part' ? 'camera.pcad' : 'camera.pcada', bytes }]);
  const token = await beginRecompute(page);
  await page.locator('.pcad-toolbar [data-command-id="file.open"]').click();
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', kind);
}

/** Actual toolbar save; works when the failed viewport has no canvas. */
async function saveBundle(page: Page, kind: NamedViewMode) {
  await page.evaluate(() => { window.pcadCompositionSavedBytes = null; });
  await page.locator('.pcad-toolbar [data-command-id="file.save"]').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => Array.isArray(window.pcadCompositionSavedBytes), undefined, { timeout: 15_000 });
  const values = await page.evaluate(() => window.pcadCompositionSavedBytes);
  if (values == null) throw new Error('Actual toolbar save did not provide bytes');
  const bytes = Uint8Array.from(values);
  const read = await readDocumentBundle(bytes, kind);
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return { bytes, bundle: read.bundle };
}

const history = (page: Page) => page.locator('.pcad-toolbar [data-command-id="history.undo"], .pcad-toolbar [data-command-id="history.redo"]')
  .evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-command-id'),
    disabled: element.getAttribute('aria-disabled') ?? element.hasAttribute('disabled').toString() })));

export async function namedViewUnavailableFlow(page: Page, info: TestInfo, kind: NamedViewMode): Promise<void> {
  await openSaved(page, kind, kind === 'part' ? boxPartFile() : await twoBoxAssemblyFile());
  const healthyMenu = page.locator('.pcad-named-views');
  await healthyMenu.locator('summary').click();
  await healthyMenu.getByRole('textbox', { name: uiMessage('view', 'view.named.name'), exact: true }).fill(baselineViewName);
  const saveView = healthyMenu.locator('[data-command-id="toolbar.namedView.save"]');
  await expect(saveView).toHaveAttribute('aria-disabled', 'false');
  await saveView.click();
  const baselineViewId = await selectBaselineView(page);
  await expect(page.locator('.pcad-toolbar [data-command-id="history.undo"]')).toBeEnabled();
  await expect(page.locator('.pcad-toolbar [data-command-id="history.undo"]')).not.toHaveAttribute('aria-disabled', 'true');
  const healthyBefore = await saveBundle(page, kind);
  expect(healthyBefore.bundle.document.namedViews.filter(view => view.id === baselineViewId && view.name === baselineViewName)).toHaveLength(1);
  await healthyMenu.locator('summary').click();
  const failedRequests: string[] = [];
  // Bounded actual network failure, not a pending request, controller mock or CSP change.
  const failModule = async (route: Route): Promise<void> => {
    failedRequests.push(route.request().url());
    await route.abort('failed');
  };
  await page.route(viewportModule, failModule);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.pcad-viewport [role="alert"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-startup-shell]')).toHaveCount(0, { timeout: 15_000 });
    expect(await page.locator('#root').evaluate(root => root instanceof HTMLElement && root.inert)).toBe(false);
    expect(failedRequests.length).toBeGreaterThan(0);
    await expect(page.locator('canvas.pcad-viewport__canvas')).toHaveCount(0);
    await openSaved(page, kind, healthyBefore.bytes);
    expect((await saveBundle(page, kind)).bundle).toEqual(healthyBefore.bundle);

    const menu = page.locator('.pcad-named-views');
    await menu.locator('summary').click();
    const choice = menu.getByRole('combobox', { name: uiMessage('view', 'view.named.choose'), exact: true });
    const value = await selectBaselineView(page);
    expect(value).toBe(baselineViewId);
    const name = menu.locator('input');
    const nameBefore = await name.inputValue();
    const optionsBefore = await choice.locator('option').allTextContents();
    const messagesBefore = await menu.getByRole('status').allTextContents();
    const historyBefore = await history(page);
    const quad = menu.locator('[data-command-id="toolbar.namedView.quad"]');
    const quadBefore = await quad.getAttribute('aria-pressed');
    const proof: { action: string; reason: string; activations: string[] }[] = [];
    for (const action of ['quad', 'save', 'restore'] as const) {
      const control = menu.locator('[data-command-id="toolbar.namedView.' + action + '"]');
      await expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(await control.evaluate(element => element.hasAttribute('disabled'))).toBe(false);
      await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
      const hint = page.locator('.pcad-keyboard-control-hint');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText(uiMessage('view', 'view.named.unavailable'));
      await expect(hint).toContainText((await control.getAttribute('title')) ?? 'missing concrete camera reason');
      const reason = await hint.innerText();
      for (const activation of ['Enter', 'Space', 'pointer'] as const) {
        if (activation === 'pointer') {
          const bounds = await control.boundingBox();
          if (bounds === null) throw new Error('Actual unavailable control has no pointer target');
          await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        } else await control.press(activation);
        expect((await saveBundle(page, kind)).bundle).toEqual(healthyBefore.bundle);
        expect(await history(page)).toEqual(historyBefore);
        await expect(choice).toHaveValue(value);
        await expect(name).toHaveValue(nameBefore);
        expect(await choice.locator('option').allTextContents()).toEqual(optionsBefore);
        expect(await menu.getByRole('status').allTextContents()).toEqual(messagesBefore);
        await expect(quad).toHaveAttribute('aria-pressed', quadBefore ?? 'missing quad state');
        await expect(control).toHaveAttribute('aria-disabled', 'true');
      }
      proof.push({ action, reason, activations: ['Enter', 'Space', 'pointer'] });
    }
    await info.attach('r20-real-camera-unavailable-' + kind, { contentType: 'application/json', body: JSON.stringify({
      environment: info.project.name, kind, failedRequests, rootInert: false, canvasAbsent: true, proof,
      documentAndAttachmentsUnchanged: true, historyUnchanged: true, stateInjection: false, osImeCertified: false,
    }) });
  } finally { await page.unroute(viewportModule, failModule); }

  // A rejected React.lazy promise is recovered through ordinary reload, not a fake retry state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForStartupReady(page);
  await openSaved(page, kind, healthyBefore.bytes);
  expect((await saveBundle(page, kind)).bundle).toEqual(healthyBefore.bundle);
  const menu = page.locator('.pcad-named-views');
  await menu.locator('summary').click();
  expect(await selectBaselineView(page)).toBe(baselineViewId);
  for (const action of ['quad', 'save', 'restore']) {
    await expect(menu.locator('[data-command-id="toolbar.namedView.' + action + '"]')).toHaveAttribute('aria-disabled', 'false');
  }
  await info.attach('r20-real-camera-recovered-' + kind, { contentType: 'application/json', body: JSON.stringify({
    environment: info.project.name, kind, ordinaryReload: true, realViewportAndCubeReady: true,
    sameSavedDocumentReopened: true, osImeCertified: false,
  }) });
}
