import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { componentRows } from './boltedJointTestSupport.js';
import { cantileverWithFrictionInputs, checkResults, checkSettings, openPanel, savedDefinition } from './frictionFlow.js';
import { armCancelOnEnable, observeOwnedFemWorkers } from './impactCancelFlow.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';

export async function frictionCancelFlow(page: Page, pathFor: (name: string) => string, app?: ElectronApplication): Promise<void> {
  const workers = observeOwnedFemWorkers(page);
  try {
    await expect.poll(workers.live).toBe(0);
    const fixture = await cantileverWithFrictionInputs(), path = pathFor('friction-cancel-input.pcada');
    await writeFile(path, fixture.bytes);
    expect(await savedDefinition(path)).toEqual(fixture.definition);
    await openSaveFlowFile(page, path, app);
    await expect(componentRows(page)).toHaveCount(1);
    await openPanel(page); await checkSettings(page);
    const panel = page.getByTestId('beam-panel');
    await panel.locator('input[data-beam-confirm]').check();
    await panel.getByTestId('beam-review').click();
    await expect(panel.getByTestId('beam-run')).toBeEnabled();
    // Use the existing real button transition on both hosts; do not intercept
    // the desktop app: protocol or replace the Worker, responses, or result.
    const armed = await armCancelOnEnable(page);
    try {
      await panel.getByTestId('beam-run').click();
      expect(await armed.evaluate(handle => handle.fired)).toBe('running');
    } finally {
      await armed.evaluate(handle => { handle.disconnect(); });
      await armed.dispose();
    }
    await expect(panel.getByTestId('beam-status')).toHaveAttribute('data-status', 'cancelled');
    await expect.poll(workers.live).toBe(0);
    await expect(panel.getByTestId('beam-cancel')).toBeDisabled();
    await expect(panel.getByTestId('beam-friction-results')).toHaveCount(0);
    await expect(panel.locator('[data-friction-field="friction:coefficient:tip-plane"] input.pcad-field__input')).toBeEditable();
    // Cancel preserves reviewed inputs; applying inputs does not save a result.
    await expect(panel.getByTestId('beam-apply')).toBeEnabled();
    await panel.getByTestId('beam-review').click();
    await expect(panel.getByTestId('beam-run')).toBeEnabled();
    const beforeRestart = workers.started();
    await panel.getByTestId('beam-run').click();
    await checkResults(page);
    await expect(panel.getByTestId('beam-status')).toHaveAttribute('data-status', 'complete');
    await expect.poll(workers.live).toBe(0);
    expect(workers.started()).toBe(beforeRestart + 1);
  } finally {
    workers.disconnect();
  }
}
