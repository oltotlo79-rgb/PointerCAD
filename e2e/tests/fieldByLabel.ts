import type { Locator, Page } from '@playwright/test';
import { uiMessagePattern } from './uiMessages.js';

interface FieldSelectors {
  fieldSelector?: string;
  controlSelector?: string;
}

function fieldByPattern(page: Page, scope: Page | Locator, pattern: RegExp,
  { fieldSelector = '.pcad-field', controlSelector }: FieldSelectors = {}): Locator {
  const field = scope.locator(fieldSelector).filter({
    has: page.locator('.pcad-field__label', { hasText: pattern }),
  });
  return controlSelector === undefined ? field : field.locator(controlSelector);
}

export function fieldByLabel(page: Page, scope: Page | Locator, label: string, selectors?: FieldSelectors): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return fieldByPattern(page, scope, new RegExp(`^${escaped}$`, 'u'), selectors);
}

export function fieldByMessageKey(page: Page, scope: Page | Locator, catalog: string, key: string,
  selectors?: FieldSelectors): Locator {
  return fieldByPattern(page, scope, uiMessagePattern(catalog, key), selectors);
}
