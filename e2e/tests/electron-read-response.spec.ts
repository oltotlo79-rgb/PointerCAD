import { test } from '@playwright/test';
import { readOrphanIntegrityFlow, readResponsivenessFlow } from './readResponsivenessFlow.js';
import { readLifecycleFlow } from './readLifecycleFlow.js';
import { launchDesktop } from './electronAppFlow.js';

for (const mib of [32, 128] as const) {
  test(`E04 ${mib}MiB独立ZIPの元bytesと読込返信添付の長さ/SHA`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    const page = await app.firstWindow();
    try {
    await readOrphanIntegrityFlow(page, info, mib, app);
    } finally { await app.close(); }
  });
  for (const kind of ['orphan', 'referenced'] as const) {
    test(`E04 ${mib}MiB ${kind} 読込の実処理中100入力p95<100msと保存再開`, async ({ playwright }, info) => {
      test.setTimeout(300000);
    const { app } = await launchDesktop(playwright, info);
    const page = await app.firstWindow();
    try {
      await readResponsivenessFlow(page, info, mib, kind, app);
      } finally { await app.close(); }
  });
  }
}
for (const action of ['new-request', 'switch', 'dispose'] as const) {
  test(`E04 読込中${action}は実Workerを終了し旧結果を採らない`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    const page = await app.firstWindow();
    try {
    await readLifecycleFlow(page, info, action, app);
    } finally { await app.close(); }
  });
}
