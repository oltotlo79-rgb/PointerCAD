import { expect, test } from '@playwright/test';
import { functionPlotFlow } from './functionPlotFlow.js';
import { functionSurfaceFlow } from './functionSurfaceFlow.js';
import { functionClosedSurfaceFlow } from './functionClosedSurfaceFlow.js';
import { functionImplicitCurveFlow } from './functionImplicitCurveFlow.js';
import { functionPointFlow } from './functionPointFlow.js';
import { functionCurvePointFlow } from './functionCurvePointFlow.js';
import { functionSurfacePointFlow } from './functionSurfacePointFlow.js';
import { functionCoefficientFlow } from './functionCoefficientFlow.js';
import { functionSectionScenario } from './functionSectionFlow.js';
import {scriptFunctionDocumentFlow} from './scriptFunctionDocumentFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('ADD-FUNCTION 関数を含む文書で自動作図し、保存・Undo・再開でも原式を保持する',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{for(const name of ['showOpenFilePicker','showSaveFilePicker'])Object.defineProperty(globalThis,name,{configurable:true,value:undefined});});
  await page.goto('/');await scriptFunctionDocumentFlow(page,info);expect(errors).toEqual([]);
});

test('ADD-FUNCTION 媒介曲面の2座標から点を作り、U/VとXYZを区別して保存再開・再編集・Undoする',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{for(const name of ['showOpenFilePicker','showSaveFilePicker'])Object.defineProperty(globalThis,name,{configurable:true,value:undefined});});
  await page.goto('/');await functionSurfacePointFlow(page,info);expect(errors).toEqual([]);
});

for(const form of ['coordinate','parametric'] as const)test(`ADD-FUNCTION ${form}曲線上の点を指定・選択し、保存再開・再編集・Undoする`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{for(const name of ['showOpenFilePicker','showSaveFilePicker'])Object.defineProperty(globalThis,name,{configurable:true,value:undefined});});
  await page.goto('/');await functionCurvePointFlow(page,info,form);expect(errors).toEqual([]);
});

test('ADD-FUNCTION 座標断面線の範囲拒否・Y座標の作成再編集・Undo・保存再開', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await functionSectionScenario(page, info); expect(errors).toEqual([]);
});

test('ADD-FUNCTION 係数スライダーの実ドラッグ・方向キー・Undo1回・保存再開', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await functionCoefficientFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-FUNCTION 座標式の関数上の点を図で選び、保存再開・座標変更・Undoを通す',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{for(const name of ['showOpenFilePicker','showSaveFilePicker'])Object.defineProperty(globalThis,name,{configurable:true,value:undefined});});
  await page.goto('/');await functionPointFlow(page,info,undefined,'coordinate');expect(errors).toEqual([]);
});

test('ADD-FUNCTION 関数上の点をXYZから選び、保存再開・指定座標変更で同じ点を更新する',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{for(const name of ['showOpenFilePicker','showSaveFilePicker'])Object.defineProperty(globalThis,name,{configurable:true,value:undefined});});
  await page.goto('/');await functionPointFlow(page,info);expect(errors).toEqual([]);
});
test('ADD-FUNCTION 平面等式の全XYZ・固定軸・数学入力・保存再開・開閉とUndoを操作する',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    for(const name of ['showOpenFilePicker','showSaveFilePicker']) Object.defineProperty(globalThis,name,{configurable:true,value:undefined});
  });
  await page.goto('/');await functionImplicitCurveFlow(page,info);expect(errors).toEqual([]);
});
test('ADD-FUNCTION 空間等式でもXYZを必須にし、保存再開と範囲変更で閉立体から開面へ変える',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    for(const name of ['showOpenFilePicker','showSaveFilePicker']) Object.defineProperty(globalThis,name,{configurable:true,value:undefined});
  });
  await page.goto('/');await functionClosedSurfaceFlow(page,info,undefined,'implicit');expect(errors).toEqual([]);
});
test('ADD-FUNCTION 球面の例でもXYZを必須にし、閉立体と切断後の開面を区別する', async ({page},info) => {
  const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    for(const name of ['showOpenFilePicker','showSaveFilePicker']) Object.defineProperty(globalThis,name,{configurable:true,value:undefined});
  });
  await page.goto('/'); await functionClosedSurfaceFlow(page,info); expect(errors).toEqual([]);
});
test('ADD-FUNCTION 関数曲線の必須XYZ範囲・確認・数学入力・保存再編集・Undo', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await functionPlotFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-FUNCTION 関数曲面の必須XYZ範囲・実形状確認・保存再編集・U V・Undo', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await functionSurfaceFlow(page, info); expect(errors).toEqual([]);
});
