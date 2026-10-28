import { test } from '@playwright/test';
import { directEditOperationsFlow } from './directEditOperationsFlow.js';

for (const tool of ['holeTranslate', 'faceRotate'] as const) {
  test(`EX-18 ${tool}: actual selection, input, refusal, cancel, edit, Undo/Redo and save/reopen`, async ({ page }, info) => {
    await directEditOperationsFlow(page, info, '/', tool);
  });
}
