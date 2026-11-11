import { test } from '@playwright/test';
import { electronOcctTransportNegative } from './electronOcctTransportNegativeFlow.js';

test('W21 actual Electron OCCT HTTP rejection preserves geometry and cleanup', async ({ playwright }, info) => {
  await electronOcctTransportNegative(playwright, info);
});
