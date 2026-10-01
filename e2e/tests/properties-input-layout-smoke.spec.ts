import { expect, test, type Locator } from '@playwright/test';
import { propertySection } from './measurementCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

async function expectStackedFields(section: Locator, count: number): Promise<void> {
  const fields = section.locator('.pcad-section__fields > .pcad-field');
  await expect(fields).toHaveCount(count);
  for (const field of await fields.all()) {
    await field.scrollIntoViewIfNeeded();
    const geometry = await field.evaluate(element => {
      const label = element.querySelector('label');
      const input = element.querySelector('input');
      const parent = element.closest('.pcad-section');
      const note = parent?.querySelector('.pcad-panel__note');
      if (!(label instanceof HTMLLabelElement) || !(input instanceof HTMLInputElement) || !parent || !note) {
        throw new Error('Missing real field, label or section note');
      }
      const text = document.createRange();
      text.selectNodeContents(label);
      const labelBox = label.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      const sectionBox = parent.getBoundingClientRect();
      const message = element.querySelector('.pcad-field__message');
      const unit = element.querySelector('.pcad-field__unit');
      return {
        associated: label.control === input,
        lines: text.getClientRects().length,
        labelLeft: labelBox.left, labelBottom: labelBox.bottom,
        textLeft: textBox.left, textRight: textBox.right,
        inputLeft: inputBox.left, inputRight: inputBox.right, inputTop: inputBox.top, inputBottom: inputBox.bottom,
        insetLeft: noteBox.left + parseFloat(getComputedStyle(note).paddingLeft),
        insetRight: sectionBox.right - parseFloat(getComputedStyle(note).paddingRight),
        messageLeft: message?.getBoundingClientRect().left, messageTop: message?.getBoundingClientRect().top,
        unitLeft: unit?.getBoundingClientRect().left, unitRight: unit?.getBoundingClientRect().right,
      };
    });
    expect(geometry.associated).toBe(true);
    expect(geometry.lines).toBe(1);
    expect(Math.abs(geometry.labelLeft - geometry.insetLeft)).toBeLessThanOrEqual(1);
    expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.insetLeft - 1);
    expect(geometry.textRight).toBeLessThanOrEqual(geometry.insetRight + 1);
    expect(geometry.labelBottom).toBeLessThanOrEqual(geometry.inputTop);
    expect(Math.abs(geometry.inputLeft - geometry.insetLeft)).toBeLessThanOrEqual(1);
    expect(geometry.inputRight).toBeLessThanOrEqual(geometry.insetRight + 1);
    if (geometry.unitLeft !== undefined && geometry.unitRight !== undefined) {
      expect(geometry.unitLeft).toBeGreaterThanOrEqual(geometry.inputRight);
      expect(geometry.unitRight).toBeLessThanOrEqual(geometry.insetRight + 1);
    }
    if (geometry.messageTop !== undefined && geometry.messageLeft !== undefined) {
      expect(geometry.messageTop).toBeGreaterThanOrEqual(geometry.inputBottom);
      expect(Math.abs(geometry.messageLeft - geometry.inputLeft)).toBeLessThanOrEqual(1);
    }
  }
}

for (const viewport of [{ width: 1479, height: 812 }, { width: 1024, height: 768 }]) {
  test(`右の欄の名前・点検基準の札と入力を余白内へそろえる: ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await waitForStartupHealth(page, info);
    const sets = propertySection(page, uiMessage('propertyPanel', 'propertyPanel.sectionSelectionSets'));
    await expectStackedFields(sets, 1);
    const name = sets.getByRole('textbox', { name: uiMessage('propertyPanel', 'propertyPanel.selectionSetName'), exact: true });
    await sets.locator('label').click();
    await expect(name).toBeFocused();
    await name.fill('外側');
    await expect(name).toHaveValue('外側');
    await sets.screenshot({ path: info.outputPath('selection-set-layout.png') });

    const print = propertySection(page, uiMessage('propertyPanel', 'propertyPanel.sectionPrintCheck'));
    await expectStackedFields(print, 2);
    await print.screenshot({ path: info.outputPath('print-check-layout.png') });
    const thickness = print.getByLabel(uiMessage('propertyPanel', 'propertyPanel.printCheckThicknessInput'), { exact: true });
    await thickness.fill('0');
    await expect(thickness).toHaveAttribute('aria-invalid', 'true');
    await expect(print).toContainText(uiMessage('propertyPanel', 'propertyPanel.printCheckThicknessPositive'));
    await expectStackedFields(print, 2);
    await thickness.fill('0.8');
    await expect(thickness).toHaveAttribute('aria-invalid', 'false');
  });
}
