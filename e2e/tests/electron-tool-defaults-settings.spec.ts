import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { toolDefaultsSettingsFlow } from './toolDefaultsSettingsFlow.js';
import { templateToolDefaultsFlow } from './templateToolDefaultsFlow.js';
import { drawingToolDefaultsFlow } from './drawingToolDefaultsFlow.js';
import { coordinateToolDefaultsFlow } from './coordinateToolDefaultsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

test('P12-8 実Electronで数値初期値の開始時の写し・保存・再起動を通す', async ({ playwright }, info) => {
  const launched = await launchDesktop(playwright, info);
  try {
    const page = await launched.app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await toolDefaultsSettingsFlow(page, info, launched.app); expect(errors).toEqual([]);
  } finally { await launched.app.close(); }

  const reopened = await launchDesktop(playwright, info);
  try {
    const page = await reopened.app.firstWindow(); await waitForStartupHealth(page, info);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const form = page.getByRole('form', { name: '道具の初期値', exact: true });
    await form.getByLabel('変更する入力', { exact: true }).selectOption({ label: '円の半径' });
    await expect(form.getByLabel('半径 (mm)', { exact: true })).toHaveValue('20');
  } finally { await reopened.app.close(); }
});

test('P12-8 実Electronでひな形のmm初期値とinch入力を区別し、同じ半径を保存再開する', async ({ playwright }, info) => {
  const launched = await launchDesktop(playwright, info);
  try {
    const page = await launched.app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await templateToolDefaultsFlow(page, info, launched.app); expect(errors).toEqual([]);
  } finally { await launched.app.close(); }
});

test('P12-8 実Electronで図面初期値と入力途中・既存注記・実ファイル再開・Undoを保つ', async ({ playwright }, info) => {
  const launched = await launchDesktop(playwright, info);
  try {
    const page = await launched.app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await drawingToolDefaultsFlow(page, info, launched.app); expect(errors).toEqual([]);
  } finally { await launched.app.close(); }
});

test('P12-8 実Electronで三つの座標モードの初期値・連続入力・式と実座標を保存再開する', async ({ playwright }, info) => {
  const launched = await launchDesktop(playwright, info);
  try {
    const page = await launched.app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await coordinateToolDefaultsFlow(page, info, launched.app); expect(errors).toEqual([]);
  } finally { await launched.app.close(); }
});
