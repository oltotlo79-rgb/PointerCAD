import { functionPlotMessage, functionPointMessage } from './functionMessages.js';
import {expect,type ElectronApplication,type Page,type TestInfo} from '@playwright/test';
import {chooseToolMenuItem} from './assemblyTestSupport.js';
import {savePart} from './scriptsFlow.js';
import {reopenPart} from './reopenPart.js';
import {beginRecompute,waitForRecompute} from './recompute.js';
import {waitForFunctionPreview} from './waitForFunctionPreview.js';
import {observeFunctionRecompute,attachFunctionRecomputeDiagnostics} from './functionRecomputeDiagnostics.js';
import {functionDirectionFlow} from './functionDirectionFlow.js';

const text = functionPointMessage;
const plot = functionPlotMessage;
export async function functionPointFlow(page:Page,info:TestInfo,app?:ElectronApplication,form:'implicit'|'coordinate'='implicit'):Promise<void> {
  await observeFunctionRecompute(page);
  try { await runFunctionPointFlow(page,info,app,form); }
  finally {
    if(!page.isClosed()) try { await attachFunctionRecomputeDiagnostics(page,info); }
    catch(error) { console.warn('関数再計算の診断を添付できませんでした',error); }
  }
}

async function runFunctionPointFlow(page:Page,info:TestInfo,app:ElectronApplication|undefined,form:'implicit'|'coordinate'):Promise<void> {
  await chooseToolMenuItem(page,'作図',plot('menuTitle'));
  const dialog=page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox',{name:plot('geometry'),exact:true}).selectOption('surface');
  if(form==='implicit')await dialog.getByRole('combobox',{name:plot('presets'),exact:true}).selectOption('implicit-sphere');
  else{
    await dialog.getByRole('combobox',{name:plot('form'),exact:true}).selectOption('coordinate');
    await dialog.getByRole('combobox',{name:plot('dependent'),exact:true}).selectOption('Z');
    await dialog.getByRole('textbox',{name:`Z ${plot('formula')}`,exact:true}).fill('X^2+Y^2');
  }
  for(const axis of ['X','Y','Z']) for(const endpoint of ['minimum','maximum'] as const) {
    await dialog.getByRole('textbox',{name:`${axis} ${plot(endpoint)}`,exact:true}).fill(endpoint==='minimum'?'-2':'2');
  }
  await dialog.getByRole('textbox',{name:plot('surfaceTolerance'),exact:true}).fill('0.01');
  await dialog.getByRole('button',{name:plot('preview'),exact:true}).click();
  const apply=dialog.getByRole('button',{name:plot('surfaceApply'),exact:true});await waitForFunctionPreview(page,info,plot('surfaceApply'));
  const created=await beginRecompute(page);await apply.click();await waitForRecompute(page,created);
  const sphere=await savePart(page,info,'point-sphere.pcad',app),parent=sphere.solids.find(item=>item.kind==='functionSurface');
  if(!parent)throw new Error('Expected function surface');
  await page.getByText(parent.name,{exact:true}).click();await page.getByRole('button',{name:text('title'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeDisabled();
  await dialog.getByRole('textbox',{name:`X ${text('coordinate')}`,exact:true}).fill('0');
  await dialog.getByRole('textbox',{name:`Y ${text('coordinate')}`,exact:true}).fill('0');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('関数上に座標を指定して点を作る');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-help')).toHaveCount(0);
  await expect(dialog.getByRole('textbox',{name:`Y ${text('coordinate')}`,exact:true})).toHaveValue('0');
  await dialog.getByRole('button',{name:text('search'),exact:true}).click();
  const count=form==='implicit'?2:1,index=count-1,height=form==='implicit'?1:0;
  await expect(dialog.getByRole('radio')).toHaveCount(count);
  if(count===1) {
    await expect(dialog.getByRole('radio')).toBeChecked();await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeEnabled();
  } else await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeDisabled();
  const positiveMarker=dialog.getByRole('button',{name:`${text('candidate')} ${count}: X=0, Y=0, Z=${height}`,exact:true});
  await expect(positiveMarker).toBeVisible();await positiveMarker.click();
  await expect(dialog.getByRole('radio').nth(index)).toBeChecked();await expect(positiveMarker).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:info.outputPath('function-point-candidates.png'),fullPage:true});
  const first=await beginRecompute(page);await dialog.getByRole('button',{name:text('apply'),exact:true}).click();await waitForRecompute(page,first);
  const saved=await savePart(page,info,'function-point.pcad',app),point=saved.sketches.flatMap(sketch=>sketch.features).find(item=>item.kind==='point');
  if(point?.kind!=='point'||point.at.mode==='absolute'||point.at.base.kind!=='functionPoint')throw new Error('Function point definition not saved');
  expect(point.at.base.choice.location).toMatchObject({kind:'implicit',axis:'Z',interval:{lower:height,upper:height}});
  await reopenPart(page,info,'function-point.pcad',app);await page.getByText(point.name,{exact:true}).click();
  await page.getByRole('button',{name:text('edit'),exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:`X ${text('coordinate')}`,exact:true})).toHaveValue('0');
  await dialog.getByRole('textbox',{name:`X ${text('coordinate')}`,exact:true}).fill('0.6');
  await dialog.getByRole('button',{name:text('search'),exact:true}).click();await expect(dialog.getByRole('radio')).toHaveCount(count);
  await dialog.getByRole('radio').nth(index).check();
  const edited=await beginRecompute(page);await dialog.getByRole('button',{name:text('update'),exact:true}).click();await waitForRecompute(page,edited);
  const changed=await savePart(page,info,'function-point-edited.pcad',app),points=changed.sketches.flatMap(sketch=>sketch.features).filter(item=>item.kind==='point');
  expect(points).toHaveLength(1);expect(points[0].id).toBe(point.id);
  expect(points[0]).toMatchObject({at:{base:{known:[{axis:'X',value:{source:'0.6'}},{axis:'Y',value:{source:'0'}}]}}});
  const undo=await beginRecompute(page);await page.getByRole('button',{name:'元に戻す',exact:true}).click();await waitForRecompute(page,undo);
  const restored=await savePart(page,info,'function-point-undo.pcad',app);
  expect(restored.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===point.id))
    .toMatchObject({at:{base:{known:[{axis:'X',value:{source:'0'}},{axis:'Y',value:{source:'0'}}]}}});
  await page.getByText(point.name,{exact:true}).click();await page.screenshot({path:info.outputPath('function-point-properties.png'),fullPage:true});
  await functionDirectionFlow(page,info,point,app,'implicit-surface');
}
