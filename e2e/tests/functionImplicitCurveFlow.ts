import { functionPlotMessage } from './functionMessages.js';
import {expect,type ElectronApplication,type Page,type TestInfo} from '@playwright/test';
import {chooseToolMenuItem} from './assemblyTestSupport.js';
import {openTarget} from './electronAppFlow.js';
import {savePart} from './scriptsFlow.js';
import {beginRecompute,waitForRecompute} from './recompute.js';
import {uiMessage} from './uiMessages.js';
import {observeMathWorkers} from './mathWorkerDiagnostics.js';

const text = functionPlotMessage;
export async function functionImplicitCurveFlow(page:Page,info:TestInfo,app?:ElectronApplication):Promise<void>{
  const attach = await observeMathWorkers(page);
  try { await runFunctionImplicitCurveFlow(page,info,app); }
  finally { await attach(info); }
}
async function runFunctionImplicitCurveFlow(page:Page,info:TestInfo,app?:ElectronApplication):Promise<void>{
  await chooseToolMenuItem(page,'作図',text('menuTitle'));const dialog=page.locator('.pcad-function-dialog');
  await expect(dialog).toBeVisible();await dialog.getByRole('combobox',{name:text('presets'),exact:true}).selectOption('implicit-circle');
  await expect(dialog.getByRole('combobox',{name:text('fixedAxis'),exact:true})).toHaveValue('Z');
  for(const axis of ['X','Y','Z']) for(const endpoint of ['minimum','maximum'] as const){
    const field=dialog.getByRole('textbox',{name:`${axis} ${text(endpoint)}`,exact:true});await expect(field).toHaveValue('');
    if(axis!=='Z' || endpoint!=='maximum') await field.fill(endpoint==='minimum'?'-2':'2');
  }
  await dialog.getByRole('textbox',{name:text('tolerance'),exact:true}).fill('0.05');
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeDisabled();await expect(dialog.locator('canvas')).toHaveCount(0);
  await dialog.getByRole('textbox',{name:`Z ${text('maximum')}`,exact:true}).fill('2');
  await dialog.getByRole('textbox',{name:`Z ${text('fixedCoordinate')}`,exact:true}).fill('3');
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('範囲');await expect(dialog.locator('canvas')).toHaveCount(0);
  await dialog.getByRole('textbox',{name:`Z ${text('fixedCoordinate')}`,exact:true}).fill('0.5');
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeEnabled({timeout:60_000});
  await expect(dialog.getByRole('status')).toContainText(`${text('closedCurveCount')}: 1`);
  await expect(dialog.locator('canvas')).toBeInViewport({ratio:1});await page.screenshot({path:info.outputPath('function-implicit-circle.png'),fullPage:true});
  const created=await beginRecompute(page);await dialog.getByRole('button',{name:text('apply'),exact:true}).click();await waitForRecompute(page,created);
  const original=await savePart(page,info,'function-implicit-circle.pcad',app);
  const feature=original.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.kind==='functionCurve');
  if(feature?.kind!=='functionCurve') throw new Error('Missing saved implicit curve');
  expect(feature.definition.formula).toMatchObject({kind:'implicit-curve',fixedAxis:'Z',fixedCoordinate:{value:0.5},expression:{source:'X^2+Y^2-1'}});
  await page.reload();
  if(app!==undefined){
    await openTarget(app,info.outputPath('function-implicit-circle.pcad'));
    await page.getByRole('group',{name:'ファイル',exact:true}).getByRole('button',{name:'開く',exact:true}).click();
  }else{
    const chooser=page.waitForEvent('filechooser');await page.getByRole('group',{name:'ファイル',exact:true}).getByRole('button',{name:'開く',exact:true}).click();
    await(await chooser).setFiles(info.outputPath('function-implicit-circle.pcad'));
  }
  await waitForRecompute(page);await page.getByText(feature.name,{exact:true}).click();await page.getByRole('button',{name:text('edit'),exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:text('implicitCurveEquation'),exact:true})).toHaveValue('X^2+Y^2-1');
  await expect(dialog.getByRole('textbox',{name:`Z ${text('fixedCoordinate')}`,exact:true})).toHaveValue('0.5');
  await dialog.getByRole('combobox',{name:text('fixedAxis'),exact:true}).selectOption('X');
  await dialog.getByRole('button',{name:`${text('implicitCurveEquation')}: ${uiMessage('math','math.open')}`,exact:true}).click();
  const math=page.locator('.pcad-math-dialog');await math.locator('textarea').fill('Y^2+Z^2-1');
  await expect(math.getByRole('button',{name:'この式を使う',exact:true})).toBeEnabled();await math.getByRole('button',{name:'この式を使う',exact:true}).click();
  await expect(math).toHaveCount(0);await dialog.getByRole('textbox',{name:`Z ${text('maximum')}`,exact:true}).fill('0');
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeEnabled({timeout:60_000});
  await expect(dialog.getByRole('status')).toContainText(`${text('closedCurveCount')}: 0`);
  await expect(dialog.locator('canvas')).toBeInViewport({ratio:1});await page.screenshot({path:info.outputPath('function-implicit-open-arc.png'),fullPage:true});
  const changed=await beginRecompute(page);await dialog.getByRole('button',{name:text('apply'),exact:true}).click();await waitForRecompute(page,changed);
  const saved=await savePart(page,info,'function-implicit-open-arc.pcad',app);
  expect(saved.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===feature.id)).toMatchObject({definition:{
    formula:{kind:'implicit-curve',fixedAxis:'X',fixedCoordinate:{value:0.5},expression:{source:'Y^2+Z^2-1'}},bounds:{Z:{max:{value:0}}}}});
  const undo=await beginRecompute(page);await page.locator('canvas.pcad-viewport__canvas').focus();await page.keyboard.press('Control+z');await waitForRecompute(page,undo);
  expect((await savePart(page,info,'function-implicit-curve-undone.pcad',app)).sketches).toEqual(original.sketches);
}
