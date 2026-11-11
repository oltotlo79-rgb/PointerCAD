/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { writeDocumentBundle } from '../../packages/io/src/index.js';
import { createAssemblyDocumentBundle, EMPTY_PART_LIBRARY } from '../../packages/model/src/index.js';
import type { StandardBeamContactDefinition } from '../../packages/model/src/analysis/beamInputs.js';
import { cadJointContactFixture } from '../../packages/model/src/analysis/cadJointContact.testSupport.js';
import { chooseToolMenuItem, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

const RESULT_TIMEOUT_MS = 120_000;
const RELATIVE = 1e-9;

/** Real standard-part sources and saved CAD weld associations; no injected solver result or store. */
async function savedFixture(initial: boolean): Promise<Uint8Array> {
  const fixture = cadJointContactFixture();
  const definition: StandardBeamContactDefinition = {
    ...fixture.definition,
    contact: { ...fixture.definition.contact, loadFactors: [1, 0, -1] },
    ...(initial ? { initialStrain: { schema: 'pointercad-cad-joint-initial-strain/1' as const,
      shortenings: [{ boltId: 'mixed-shank', shorteningMm: .001,
        source: { kind: 'user-supplied' as const, reference: 'Prescribed stress-free shortening',
          condition: 'Small-strain elastic; no capacity claim' } }] } } : {}),
  };
  const document = { ...fixture.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1' as const,
    analyses: [{ kind: 'standard-members' as const, definition }] } };
  return writeDocumentBundle(createAssemblyDocumentBundle(document, EMPTY_PART_LIBRARY));
}

export async function combinedWeldStressFlow(page: Page, info: TestInfo, initial: boolean,
  app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const path = info.outputPath('combined-input.pcada');
    await writeFile(path, await savedFixture(initial));
    await openSaveFlowFile(page, path, app);
    await expect(componentRows(page)).toHaveCount(5);
    const panel = page.getByTestId('beam-panel');
    if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
    await page.getByTestId('beam-open').click();
    await expect(panel).toBeVisible();
    const members = panel.locator('input[data-beam-confirm]');
    await expect(members).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) await members.nth(index).check();
    await panel.getByTestId('beam-review').click();
    await expect(panel.getByTestId('beam-run')).toBeEnabled();
    await panel.getByTestId('beam-run').click();
    await expect(panel.getByTestId(initial ? 'beam-initial-strain-results' : 'beam-joint-results'))
      .toBeVisible({ timeout: RESULT_TIMEOUT_MS });
    const weld = panel.getByTestId('beam-weld-layer-results');
    const stress = panel.getByTestId('beam-weld-throat-stress');
    const values: number[][] = [];
    for (const [index, factor] of [1, 0, -1].entries()) {
      await weld.locator('select').first().selectOption({ value: String(index) });
      await expect(weld.locator('select').first()).toHaveValue(String(index));
      await expect(stress).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
      const corners = stress.locator('tbody tr[data-weld-stress-patch]');
      await expect(corners).toHaveCount(8);
      for (let at = 0; at < 8; at += 1) {
        await expect(corners.nth(at)).toHaveAttribute('data-load-factor', String(factor));
        await expect(corners.nth(at)).toHaveAttribute('data-corner', String(at % 4));
      }
      await expect(stress.locator('td[data-unit="mm"]')).toHaveCount(16);
      const cells = stress.locator('td[data-stress][data-unit="MPa"]');
      await expect(cells).toHaveCount(24);
      const row = await cells.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-value') ?? 'NaN')));
      expect(row.every(Number.isFinite)).toBe(true);
      values.push(row);
      // The large declared gap remains open. This verifies the premise for the elastic affine relation.
      await expect(weld.locator('tr[data-state="open"]')).toHaveCount(1);
      await expect(weld.locator('p[data-unit="J"]')).toHaveCount(2);
      await expect(panel.getByTestId(initial ? 'beam-initial-strain-bolt-results' : 'beam-joint-bolt-results')
        .locator('td[data-unit="N"]')).toHaveCount(1);
    }
    const scale = Math.max(...values.flat().map(Math.abs));
    expect(scale).toBeGreaterThan(0);
    for (let index = 0; index < 24; index += 1) {
      // Constant initial shortening adds an offset: sigma(+F)+sigma(-F)=2*sigma(0).
      expect(Math.abs(values[0][index] + values[2][index] - 2 * values[1][index])).toBeLessThanOrEqual(RELATIVE * scale);
      if (!initial) expect(Math.abs(values[1][index])).toBeLessThanOrEqual(RELATIVE * scale);
    }
    if (initial) expect(Math.max(...values[1].map(Math.abs))).toBeGreaterThan(0);
    await panel.getByTestId('beam-apply').click();
    const saved = info.outputPath('combined-saved.pcada');
    await saveFlowFile(page, saved, app);
    await openSaveFlowFile(page, saved, app);
    await expect(page.getByTestId('beam-weld-throat-stress')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await resetAssemblyFileGateway(page);
  }
}
