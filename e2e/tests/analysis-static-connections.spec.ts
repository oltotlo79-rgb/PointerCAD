import { test } from '@playwright/test';
import { analysisStaticPersistenceFlow } from './analysisStaticPersistenceFlow.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
test('static analysis persists inputs and recomputes after reopening', async ({ page }, info) => {
  await analysisStaticPersistenceFlow(page, info);
});
