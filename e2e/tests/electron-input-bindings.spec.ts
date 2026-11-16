import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import {
  assignedViewKeysRestoredFlow, assignViewKeysFlow, exerciseViewKeysFlow, inputBindingsCaptureFlow, inputBindingsWideTextFlow, restoreKeysFlow,
} from './inputBindingsFlow.js';

test('B-07 実Electronで操作の割り当ての窓: 取り込みの枠で左を断り、平行移動へホイールを移す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await inputBindingsCaptureFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('B-07 実Electronで操作の割り当ての窓: キーを変えて使い、終了・再起動の後も表に残る', async ({ playwright }, info) => {
  const errors: string[] = [];
  const first = await launchDesktop(playwright, info);
  try {
    const page = await first.app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await assignViewKeysFlow(page);
  } finally { await first.app.close(); }
  // launchDesktop keys userData by this exact TestInfo/retry, so this is a real same-profile restart.
  const second = await launchDesktop(playwright, info);
  try {
    const page = await second.app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await assignedViewKeysRestoredFlow(page);
    await exerciseViewKeysFlow(page, info, second.app);
    await restoreKeysFlow(page);
    expect(errors).toEqual([]);
  } finally { await second.app.close(); }
});

test('B-07 実Electronで操作の割り当ての窓: 字を広げても窓は画面に収まり、操作が窓の中へ届く', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await inputBindingsWideTextFlow(page); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
