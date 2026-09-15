import { expect, type Locator } from '@playwright/test';

/** Read actual native controls without changing focus, values, selection or document state. */
export async function assertRenderedControlDescriptions(region: Locator): Promise<void> {
  await expect(region).toBeVisible();
  const result = await region.evaluate(container => {
    const controls = Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      'input, select, textarea, button')).filter(control => control.getClientRects().length > 0
        && getComputedStyle(control).visibility !== 'hidden' && !(control instanceof HTMLInputElement && control.type === 'hidden'));
    return { count: controls.length, missing: controls.flatMap(control => {
      const ownTitle = control.getAttribute('title');
      const description = (ownTitle ?? (control instanceof HTMLButtonElement ? null : control.closest('label')?.getAttribute('title')) ?? '').trim();
      const labelledBy = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/u)
        .map(id => control.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
      const label = control.getAttribute('aria-label')?.trim() || labelledBy
        || (control instanceof HTMLButtonElement ? control.textContent?.trim() : Array.from(control.labels ?? []).map(item => item.textContent ?? '').join(' ').trim()) || '';
      return description !== '' && label !== '' ? [] : [{ tag: control.tagName, id: control.id,
        name: label.slice(0, 120), missing: description === '' ? 'description' : 'name' }];
    }) };
  });
  expect(result.count, 'The actual form must contain controls').toBeGreaterThan(0);
  expect(result.missing, 'Every displayed native control needs a name and a nonempty description').toEqual([]);
}
