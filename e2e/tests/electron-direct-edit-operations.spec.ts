import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { directEditOperationsFlow } from './directEditOperationsFlow.js';

for (const tool of ['holeTranslate', 'faceRotate'] as const) {
  test(`EX-18 Electron ${tool}: selection, input, refusal, cancel, edit, Undo/Redo and save/reopen`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await directEditOperationsFlow(await app.firstWindow(), info, 'app://pointercad/index.html', tool); }
    finally { await app.close(); }
  });
}
