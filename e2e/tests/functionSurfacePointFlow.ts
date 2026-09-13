import { functionPlotMessage, functionPointMessage } from './functionMessages.js';
import {expect,type ElectronApplication,type Page,type TestInfo} from '@playwright/test';
import {chooseToolMenuItem} from './assemblyTestSupport.js';
import {savePart} from './scriptsFlow.js';
import {reopenPart} from './reopenPart.js';
import {beginRecompute,waitForRecompute} from './recompute.js';
import {waitForFunctionPreview} from './waitForFunctionPreview.js';
import {functionDirectionFlow} from './functionDirectionFlow.js';

const text = functionPointMessage;
const plot = functionPlotMessage;
export async function functionSurfacePointFlow(page:Page,info:TestInfo,app?:ElectronApplication):Promise<void> {
  await chooseToolMenuItem(page,'作図',plot('menuTitle'));
  const dialog=page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox',{name:plot('geometry'),exact:true}).selectOption('surface');
  await dialog.getByRole('combobox',{name:plot('form'),exact:true}).selectOption('parametric');
  for(const [axis,source] of [['X','U+V'],['Y','U-V'],['Z','U*V']]){
    await dialog.getByRole('textbox',{name:`${axis} ${plot('formula')}`,exact:true}).fill(source);
  }
  for(const axis of ['X','Y','Z','U','V'])for(const endpoint of ['minimum','maximum'] as const){
    const extent=axis==='U'?2:axis==='V'?1:4;
    await dialog.getByRole('textbox',{name:`${axis} ${plot(endpoint)}`,exact:true}).fill(String(endpoint==='minimum'?-extent:extent));
  }
  await dialog.getByRole('textbox',{name:plot('surfaceTolerance'),exact:true}).fill('0.05');
  await dialog.getByRole('button',{name:plot('preview'),exact:true}).click();await waitForFunctionPreview(page,info,plot('surfaceApply'));
  const created=await beginRecompute(page);await dialog.getByRole('button',{name:plot('surfaceApply'),exact:true}).click();await waitForRecompute(page,created);
  const original=await savePart(page,info,'surface-point-parent.pcad',app),surface=original.solids.find(item=>item.kind==='functionSurface');
  if(!surface)throw new Error('Missing parametric surface');
  const tree=page.locator('.pcad-panel--left');await tree.getByRole('button',{name:surface.name,exact:true}).click();
  await page.getByRole('button',{name:text('title'),exact:true}).click();
  const parameterRange=dialog.getByRole('group',{name:text('parameter'),exact:true});
  await expect(parameterRange).toContainText('U');await expect(parameterRange).toContainText('-2 ～ 2');
  await expect(parameterRange).toContainText('V');await expect(parameterRange).toContainText('-1 ～ 1');
  for(const axis of ['X','Y'])await dialog.getByRole('textbox',{name:`${axis} ${text('coordinate')}`,exact:true}).fill('1');
  await page.keyboard.press('F1');await expect(page.locator('.pcad-help__article')).toContainText('媒介変数U・V');
  await page.keyboard.press('Escape');await expect(page.locator('.pcad-help')).toHaveCount(0);
  await dialog.getByRole('button',{name:text('search'),exact:true}).click();await expect(dialog.getByRole('radio')).toHaveCount(1);
  await expect(dialog.getByRole('radio')).toBeChecked();await expect(dialog).toContainText(`${text('parameter')}: U =`);
  await page.screenshot({path:info.outputPath('function-surface-point-uv-candidate.png'),fullPage:true});
  const committed=await beginRecompute(page);await dialog.getByRole('button',{name:text('apply'),exact:true}).click();await waitForRecompute(page,committed);
  const saved=await savePart(page,info,'surface-point.pcad',app),point=saved.sketches.flatMap(sketch=>sketch.features).find(item=>item.kind==='point');
  if(!point||point.at.mode==='absolute'||point.at.base.kind!=='functionPoint')throw new Error('Missing saved surface point');
  expect(point.at.base.choice).toMatchObject({input:{kind:'parametric-surface',lower:[-2,-1],upper:[2,1],minimum:[-4,-4,-4],maximum:[4,4,4]},location:{kind:'parametric-surface'}});
  await reopenPart(page,info,'surface-point.pcad',app);await tree.getByRole('button',{name:point.name,exact:true}).click();
  await page.getByRole('button',{name:text('edit'),exact:true}).click();
  const field=dialog.getByRole('textbox',{name:`X ${text('coordinate')}`,exact:true});await expect(field).toHaveValue('1');await field.fill('2');
  await dialog.getByRole('button',{name:text('search'),exact:true}).click();await expect(dialog.getByRole('radio')).toHaveCount(1);
  const changed=await beginRecompute(page);await dialog.getByRole('button',{name:text('update'),exact:true}).click();await waitForRecompute(page,changed);
  const edited=await savePart(page,info,'surface-point-edited.pcad',app);
  expect(edited.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===point.id)).toMatchObject({at:{base:{known:[{axis:'X',value:{source:'2'}},{axis:'Y',value:{source:'1'}}]}}});
  const undo=await beginRecompute(page);await page.getByRole('button',{name:'元に戻す',exact:true}).click();await waitForRecompute(page,undo);
  const restored=await savePart(page,info,'surface-point-undo.pcad',app);
  expect(restored.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===point.id)).toEqual(point);
  await functionDirectionFlow(page,info,point,app,'parametric-surface');
}
