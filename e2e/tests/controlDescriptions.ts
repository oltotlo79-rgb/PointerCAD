import { expect, type Locator } from '@playwright/test';

export interface RenderedControlDescription {
  readonly tag: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
export interface RenderedControlDescriptionCheck {
  readonly count: number;
  readonly controls: readonly RenderedControlDescription[];
  readonly missing: readonly (RenderedControlDescription & { readonly missing: string })[];
}

/** Read actual native controls without changing focus, values, selection or document state. */
export async function assertRenderedControlDescriptions(region: Locator): Promise<RenderedControlDescriptionCheck> {
  await expect(region).toBeVisible();
  const result = await region.evaluate(container => {
    const controls = Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      'input, select, textarea, button')).filter(control => control.getClientRects().length > 0
        && getComputedStyle(control).visibility !== 'hidden' && !(control instanceof HTMLInputElement && control.type === 'hidden'));
    const descriptions = controls.map(control => {
      const ownTitle = control.getAttribute('title');
      const description = (ownTitle ?? (control instanceof HTMLButtonElement ? null : control.closest('label')?.getAttribute('title')) ?? '').trim();
      const labelledBy = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/u)
        .map(id => control.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
      const label = labelledBy || control.getAttribute('aria-label')?.trim()
        || (control instanceof HTMLButtonElement ? control.textContent?.trim() : Array.from(control.labels ?? []).map(item => item.textContent ?? '').join(' ').trim())
        // Native controls may take their accessible name from their own title.
        // Never use an unrelated ancestor's title to fill a missing name.
        || ownTitle?.trim() || '';
      return { tag: control.tagName, id: control.id, name: label, description };
    });
    return { count: descriptions.length, controls: descriptions, missing: descriptions.flatMap(control =>
      control.description !== '' && control.name !== '' ? [] : [{ ...control,
        missing: control.description === '' ? 'description' : 'name' }]) };
  });
  expect(result.count, 'The actual form must contain controls').toBeGreaterThan(0);
  expect(result.missing, 'Every displayed native control needs a name and a nonempty description').toEqual([]);
  return result;
}
