import { functionPlotMessage } from './functionMessages.js';
import {expect,type ElectronApplication,type Page,type TestInfo} from '@playwright/test';
import {chooseToolMenuItem} from './assemblyTestSupport.js';
import {savePart,writeDraft,successfulRun} from './scriptsFlow.js';
import {beginRecompute,waitForRecompute} from './recompute.js';
import {reopenPart} from './reopenPart.js';
import {captureManualDetail} from './captureManualDetail.js';

export async function scriptFunctionDocumentFlow(page:Page,info:TestInfo,app?:ElectronApplication):Promise<void>{
  const label = functionPlotMessage,dialog=page.locator('.pcad-function-dialog');
  await chooseToolMenuItem(page,'作図',label('menuTitle'));
  await dialog.getByRole('textbox',{name:`Y ${label('formula')}`,exact:true}).fill('X');
  await dialog.getByRole('textbox',{name:`Z ${label('formula')}`,exact:true}).fill('0');
  for(const axis of ['X','Y','Z'])for(const end of ['minimum','maximum'] as const){
    await dialog.getByRole('textbox',{name:`${axis} ${label(end)}`,exact:true}).fill(end==='minimum'?'-2':'2');
  }
  await dialog.getByRole('button',{name:label('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:label('apply'),exact:true})).toBeEnabled();
  const creating=await beginRecompute(page);await dialog.getByRole('button',{name:label('apply'),exact:true}).click();await waitForRecompute(page,creating);
  const before=await savePart(page,info,'script-function-before.pcad',app);
  expect(before.sketches.flatMap(sketch=>sketch.features).filter(feature=>feature.kind==='functionCurve')).toHaveLength(1);
  await chooseToolMenuItem(page,'自動作図','自動作図');
  await writeDraft(page,'関数と箱をまとめて作る',`cad.parameters.set('係数','2','none');
const sketch=cad.sketch.create('自動関数');
const bounds={X:['-2','2'],Y:['-2','2'],Z:['-2','2']};
cad.function.curve(sketch,{bounds,tolerance:'0.01',formula:{kind:'coordinate-curve',independent:'X',outputs:{Y:'coef("係数")*X',Z:'0'}}});
cad.function.surface({bounds,tolerance:'0.01',formula:{kind:'coordinate-surface',output:'Z',expression:'0'}});
cad.solid.box({x:'1',y:'1',z:'1'});`);await successfulRun(page);
  const added=await savePart(page,info,'script-function-added.pcad',app);
  expect(added.sketches.slice(0,before.sketches.length)).toEqual(before.sketches);
  expect(added.sketches.flatMap(sketch=>sketch.features).filter(feature=>feature.kind==='functionCurve')).toHaveLength(2);
  expect(added.solids).toHaveLength(before.solids.length+2);
  expect(added.solids.find(feature=>feature.kind==='functionSurface')).toMatchObject({definition:{formula:{kind:'coordinate-surface',expression:{source:'0',angleUnit:'degree'}}}});
  expect(added.parameters).toEqual(expect.arrayContaining([expect.objectContaining({name:'係数',value:expect.objectContaining({value:2})})]));
  await captureManualDetail(page,info,{name:'script-functions-created',dialog:page.getByRole('region',{name:'自動作図',exact:true}),
    fixture:added,script:new URL('./scriptFunctionDocumentFlow.ts',import.meta.url)});
  const undo=await beginRecompute(page);await page.getByRole('button',{name:'元に戻す',exact:true}).click();await waitForRecompute(page,undo);
  const restored=await savePart(page,info,'script-function-undo.pcad',app);
  expect(restored.sketches).toEqual(before.sketches);expect(restored.solids).toEqual(before.solids);
  await reopenPart(page,info,'script-function-added.pcad',app);
  const reopened=await savePart(page,info,'script-function-reopened.pcad',app);
  expect(reopened.sketches).toEqual(added.sketches);expect(reopened.solids).toEqual(added.solids);
}
