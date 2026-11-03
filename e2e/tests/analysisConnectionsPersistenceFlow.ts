/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { expectFemQuiet, trackFemWorkers, type AssetHold } from './analysisResultBindingFlow.js';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { KERNEL_TIMEOUT_MS, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import {
  authorWeldSpan, confirmWeldSpanMembers, openWeldSpanPanel, reviewWeldSpanInput, runWeldSpan, savedWeldSpanInputs, weldSpanField,
  weldSpanFixture, weldSpanPanel, weldSpanRows,
} from './weldSpanAuthorFlow.js';

/*
 * Joint analysis (CAD weld span layer) on the real FEM Worker path: only the links the existing flows do not cover.
 * Reused unchanged from weldSpanAuthorFlow.ts: the span-span fixture (existing public model/io route, only members,
 * supports and loads prefilled), the control-by-control authoring of the weld span row, and run(), which reviews,
 * runs and checks the independent oracles (nodal force and moment equilibrium, work = -2U, load reversal [1, 0, -1],
 * zero load, relative 1e-9). Save/reopen equality of the original input and the post-reopen recompute stay in that
 * flow (Chrome and Electron); this flow repeats save, reopen and recompute only for the changed condition below.
 * Added here, in every environment:
 *   1. complete input: after every required control is filled and reviewed, the panel shows no alert and no block;
 *   2. stop: the product's cancel button during a run that provably cannot finish (one real FEM asset request held
 *      with the accepted asset hold; the real response is passed through afterwards, never mocked) closes the worker
 *      and leaves 0 results;
 *   3. condition change: editing Young's modulus after a complete result removes the result and the review at once,
 *      every worker is closed, and the re-run with the new value satisfies the same independent oracles;
 *   4. the changed value is what is saved; after reopening no result exists, and the recompute starts a new real
 *      FEM worker that closes again.
 */

const FEM_ASSET = /\/fem\/assets\/[^/]+$/u;
const CHANGED_YOUNG_MPA = 2000;

function status(page: Page): Locator { return weldSpanPanel(page).getByTestId('beam-status'); }

async function expectNoSpanResult(page: Page): Promise<void> {
  await expect(page.getByTestId('beam-weld-span-results')).toHaveCount(0);
  await expect(page.getByTestId('beam-weld-span-stress')).toHaveCount(0);
}

/** All required controls are filled: no incomplete-input notice remains and review raises no error. */
async function expectCompleteReview(page: Page): Promise<void> {
  const panel = weldSpanPanel(page);
  await reviewWeldSpanInput(page);
  await expect(status(page)).toHaveAttribute('data-status', 'editing');
  await expect(panel.getByRole('alert')).toHaveCount(0);
}

/** Existing run() and its oracles, then the complete result carries no review or model alert either. */
async function runComplete(page: Page, beadCount: number): Promise<void> {
  await runWeldSpan(page, beadCount);
  await expect(status(page)).toHaveAttribute('data-status', 'complete');
  await expect(weldSpanPanel(page).getByRole('alert')).toHaveCount(0);
}

export async function analysisConnectionsPersistenceFlow(page: Page, info: TestInfo,
  installHold: () => Promise<AssetHold>, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], observations: string[] = [];
  const pageError = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', pageError);
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const workers = trackFemWorkers(page);
  try {
    const f = await weldSpanFixture('span-span'), input = info.outputPath('connections-input.pcada');
    await writeFile(input, f.bytes);
    await openSaveFlowFile(page, input, app);
    await expect(componentRows(page)).toHaveCount(f.componentCount);
    await openWeldSpanPanel(page); await confirmWeldSpanMembers(page); await authorWeldSpan(page, 'span-span', f.beads);
    await expectCompleteReview(page);
    // No joint run has started yet; every earlier FEM worker (if any) has closed.
    const base = workers.started();
    expect(workers.closed()).toBe(base);

    // 2) Stop during a run that cannot finish while its first real FEM asset request is held.
    const hold = await installHold();
    try {
      await weldSpanPanel(page).getByTestId('beam-run').click();
      await expect.poll(() => hold.held(), { timeout: KERNEL_TIMEOUT_MS,
        message: 'the hold must keep the joint run FEM worker asset request' }).toMatch(FEM_ASSET);
      // Exactly the one worker of this run exists and is alive while its asset request is held.
      await expect.poll(() => workers.started(), { timeout: KERNEL_TIMEOUT_MS }).toBe(base + 1);
      expect(workers.closed()).toBe(base);
      await expect(status(page)).toHaveAttribute('data-status', 'running');
      await expectNoSpanResult(page);
      await expect(weldSpanPanel(page).getByTestId('beam-cancel')).toBeEnabled();
      await weldSpanPanel(page).getByTestId('beam-cancel').click();
      await expect(status(page)).toHaveAttribute('data-status', 'cancelled');
      await expectFemQuiet(workers);
      expect(await hold.holding()).toBe(true);
      await expectNoSpanResult(page);
      observations.push(`held-joint-fem-asset ${await hold.release()}`);
    } finally {
      await hold.dispose();
    }
    // The held request was let through after the stop: nothing new started and no result appeared.
    expect(workers.started()).toBe(base + 1);
    await expect(status(page)).toHaveAttribute('data-status', 'cancelled');
    await expectNoSpanResult(page);

    // A real run of the current input after the stop satisfies the existing independent oracles.
    await runComplete(page, f.beads.length);
    expect(workers.started()).toBeGreaterThan(base + 1);
    await expectFemQuiet(workers);

    // 3) Condition change after a complete result: result and review are discarded at once and stay discarded.
    await weldSpanField(page, 'youngMPa').fill(String(CHANGED_YOUNG_MPA));
    await expectNoSpanResult(page);
    await expect(status(page)).toHaveAttribute('data-status', 'editing');
    await expect(weldSpanPanel(page).getByTestId('beam-run')).toBeDisabled();
    await expectFemQuiet(workers);
    await expectNoSpanResult(page);
    await expectCompleteReview(page);
    // Save the reviewed changed input; its new result is checked after reopening, without a duplicate solve.
    const beforeChangedSave = workers.started();
    await expectNoSpanResult(page);

    // 4) The changed condition (typed above, not a solver value) is the saved input.
    await weldSpanPanel(page).getByTestId('beam-apply').click();
    await waitForSettledRecompute(page);
    await expectNoSpanResult(page);
    expect(workers.started()).toBe(beforeChangedSave);
    const saved = info.outputPath('connections-changed.pcada');
    await saveFlowFile(page, saved, app);
    const inputs = await savedWeldSpanInputs(saved);
    expect(inputs.welds.map(w => w.beadComponentId)).toEqual(f.beads);
    for (const weld of inputs.welds) expect(weld.youngMPa).toBe(CHANGED_YOUNG_MPA);

    await openSaveFlowFile(page, saved, app);
    await expectNoSpanResult(page);
    await openWeldSpanPanel(page);
    await expect(weldSpanRows(page)).toHaveCount(f.beads.length);
    await expect(weldSpanField(page, 'youngMPa')).toHaveValue(String(CHANGED_YOUNG_MPA));
    await expectNoSpanResult(page);
    await expect(weldSpanPanel(page).getByTestId('beam-run')).toBeDisabled();
    await expectFemQuiet(workers);
    await confirmWeldSpanMembers(page);
    await expectCompleteReview(page);
    const beforeReopenRun = workers.started();
    await runComplete(page, f.beads.length);
    expect(workers.started()).toBeGreaterThan(beforeReopenRun);
    // One cancelled run plus two complete solves: an accidental duplicate solve must fail this check.
    expect(workers.started()).toBe(base + 3);
    await expectFemQuiet(workers);
    expect(errors).toEqual([]);
  } finally {
    try {
      await info.attach('connections-observations', { contentType: 'application/json',
        body: JSON.stringify({ observations, errors, started: workers.started(), closed: workers.closed() }, null, 2) });
    } finally {
      await resetAssemblyFileGateway(page);
      page.off('pageerror', pageError);
    }
  }
}
