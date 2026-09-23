import { functionOdeCurveFlow, ODE_CURVE_SCENARIO_TIMEOUT_MS } from './functionOdeCurveFlow.js';
import { FUNCTION_DIRECTION_SCENARIOS } from './functionDirectionScenarios.js';
import { functionDerivativesFlow } from './functionDerivativesFlow.js';
import { functionHyperbolicFlow } from './functionHyperbolicFlow.js';
import { functionVectorCalculusFlow } from './functionVectorCalculusFlow.js';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
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

test('ADD-23 勾配とヘッセ行列の成分を実Electronで保存再開・ラプラシアンへ編集・Undo・F1まで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionVectorCalculusFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-17 双曲線関数の曲線と逆関数の曲面を実Electronで保存再開・編集Undo・F1まで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionHyperbolicFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-22 導関数の曲線と曲面を実Electronで保存再開・編集Undo・F1まで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionDerivativesFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-FUNCTION 実Electronでも関数を残した自動作図・保存・Undo・再開を通す',async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await scriptFunctionDocumentFlow(page,info,app);expect(errors).toEqual([]);
  }finally{await app.close();}
});

test('ADD-FUNCTION 実Electronで媒介曲面の点をU/VとXYZを保持して保存再開・再編集・Undoする',async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await functionSurfacePointFlow(page,info,app);expect(errors).toEqual([]);
  }finally{await app.close();}
});

for(const form of ['coordinate','parametric'] as const)test(`ADD-FUNCTION 実Electronの${form}曲線上の点を保存再開・再編集・Undoする`,async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await functionCurvePointFlow(page,info,form,app);expect(errors).toEqual([]);
  }finally{await app.close();}
});

test('ADD-FUNCTION 実Electronで座標断面線を作成再編集し、Undo・保存再開する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionSectionScenario(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-FUNCTION 実Electronの係数スライダーでドラッグ・方向キー・Undo1回・保存再開', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionCoefficientFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-FUNCTION 実Electronの座標式の関数上の点を図で選び、保存再編集とUndoを通す',async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await functionPointFlow(page,info,app,'coordinate');expect(errors).toEqual([]);
  }finally{await app.close();}
});

test('ADD-FUNCTION 実Electronの関数上の点で候補選択・保存再開・同じ点の更新を行う',async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await functionPointFlow(page,info,app);expect(errors).toEqual([]);
  }finally{await app.close();}
});

test('ADD-FUNCTION 実Electronの平面等式でXYZ・固定軸・保存再開・開閉とUndoを操作する',async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await functionImplicitCurveFlow(page,info,app);expect(errors).toEqual([]);
  }finally{await app.close();}
});

test('ADD-FUNCTION 実Electronの空間等式でXYZ指定・保存再開・閉立体と開面の切替を行う',async({playwright},info)=>{
  const {app}=await launchDesktop(playwright,info);
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await functionClosedSurfaceFlow(page,info,app,'implicit');expect(errors).toEqual([]);
  }finally{await app.close();}
});

test('ADD-FUNCTION 実Electronで球面の例から閉立体を作り、XYZで切ると開面になる', async ({playwright},info) => {
  const {app}=await launchDesktop(playwright,info);
  try {
    const page=await app.firstWindow(), errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
    await functionClosedSurfaceFlow(page,info,app); expect(errors).toEqual([]);
  } finally {await app.close();}
});

test('ADD-FUNCTION 実Electronの関数曲線・必須XYZ範囲・数学入力・保存再編集・Undo', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionPlotFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
test('ADD-FUNCTION 実Electronの関数曲面・必須XYZ範囲・保存再編集・U V・Undo', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionSurfaceFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

for (const scenario of FUNCTION_DIRECTION_SCENARIOS) {
  test(`ADD-FUNCTION 実Electronで${scenario.name}の点から接線・法線を作り、保存再開・長さ編集・作成と編集のUndoを通す`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await scenario.run(page, info, app); expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}

test('ADD-26 微分方程式の解曲線・点と法線・条件の保存再編集', async ({ playwright }, info) => {
  test.setTimeout(ODE_CURVE_SCENARIO_TIMEOUT_MS);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await functionOdeCurveFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
