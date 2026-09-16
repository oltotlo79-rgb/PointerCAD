import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { mathInputFlow } from './mathInputFlow.js';
import { mathTensorFlow } from './mathTensorFlow.js';
import { mathIntegerFlow } from './mathIntegerFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';
import { mathEigenspaceFlow } from './mathEigenspaceFlow.js';
import { mathSvdFlow } from './mathSvdFlow.js';
import { mathExactRuntimeFlow } from './mathExactRuntimeFlow.js';
import { mathExactLinearFlow } from './mathExactLinearFlow.js';

test('追加計算部で平方根の連立式・基底・解なし・非一意と保存再編集を実Electronで通す', async ({ playwright }, info) => {
  test.setTimeout(360_000);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await mathExactLinearFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('採用済みの追加計算部で厳密な階数・度とラジアン・交換・保存再編集を実Electronで通す', async ({ playwright }, info) => {
  test.setTimeout(360_000);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await mathExactRuntimeFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-17 数学入力の実Electron・係数追従・改名・Undo・保存再編集', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('[数学入力の画面例外]', error.message); });
    await mathInputFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-20 連立一次式とQR分解の分野検索・成分指定・保存・F1を実Electronで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await mathLinearFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-19 テンソルの添字指定・XYZ座標・保存再編集・Undo・F1を実Electronで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await mathTensorFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-21 整数条件を係数と座標に使い、保存再編集・Undo・F1を実Electronで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await mathIntegerFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

for (const { name, flow } of [
  { name: '固有空間', flow: mathEigenspaceFlow },
  { name: '特異値分解', flow: mathSvdFlow },
]) {
  test(`ADD-20 ${name}の成分選択・保存再編集・Undo・F1を実Electronの独立した文書で通す`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = [];
      page.on('pageerror', error => { errors.push(error.message); });
      await page.setViewportSize({ width: 1440, height: 900 });
      await flow(page, info, app);
      expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}
