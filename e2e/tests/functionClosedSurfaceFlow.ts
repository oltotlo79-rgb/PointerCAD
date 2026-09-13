import { observeMathWorkers } from './mathWorkerDiagnostics.js';
import { functionPlotMessage } from './functionMessages.js';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { savePart } from './scriptsFlow.js';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

const text = functionPlotMessage;
export async function functionClosedSurfaceFlow(page: Page, info: TestInfo, app?: ElectronApplication, mode:'parametric'|'implicit'='parametric'): Promise<void> {
  const attach = await observeMathWorkers(page);
  try { await runClosedSurfaceFlow(page, info, app, mode); }
  finally { await attach(info); }
}

async function runClosedSurfaceFlow(page: Page, info: TestInfo, app: ElectronApplication | undefined, mode:'parametric'|'implicit'): Promise<void> {
  const implicit=mode==='implicit',fileName=implicit?'function-implicit-sphere.pcad':'function-sphere.pcad';
  await chooseToolMenuItem(page,'作図',text('menuTitle'));
  const dialog=page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox',{name:text('geometry'),exact:true}).selectOption('surface');
  await dialog.getByRole('combobox',{name:text('presets'),exact:true}).selectOption(implicit?'implicit-sphere':'sphere');
  for (const axis of ['X','Y','Z']) for (const endpoint of ['minimum','maximum'] as const) {
    const input=dialog.getByRole('textbox',{name:`${axis} ${text(endpoint)}`,exact:true});
    await expect(input).toHaveValue(''); if(!(implicit && axis==='Z' && endpoint==='maximum')) await input.fill(endpoint === 'minimum' ? '-2' : '2');
  }
  if(implicit){
    await expect(dialog.getByRole('textbox',{name:text('implicitEquation'),exact:true})).toHaveValue('X^2+Y^2+Z^2-1');
    await expect(dialog.getByRole('textbox',{name:`U ${text('maximum')}`,exact:true})).toHaveCount(0);
    await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
    await expect(dialog.getByRole('button',{name:text('surfaceApply'),exact:true})).toBeDisabled();
    await expect(dialog.locator('canvas')).toHaveCount(0);
    await dialog.getByRole('textbox',{name:`Z ${text('maximum')}`,exact:true}).fill('2');
  }else{
    await expect(dialog.getByRole('textbox',{name:`U ${text('maximum')}`,exact:true})).toHaveValue('360');
    await expect(dialog.getByRole('textbox',{name:`V ${text('maximum')}`,exact:true})).toHaveValue('180');
  }
  await dialog.getByRole('textbox',{name:text('surfaceTolerance'),exact:true}).fill(implicit?'0.01':'0.5');
  const confirm=dialog.getByRole('button',{name:text('surfaceApply'),exact:true});
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(confirm).toBeEnabled({timeout:90_000});
  await expect(dialog.getByText(text('closedSurface'),{exact:false})).toBeInViewport();
  await expect(dialog.locator('canvas')).toBeInViewport({ratio:1});
  await page.screenshot({path:info.outputPath(implicit?'function-implicit-sphere.png':'function-closed-sphere.png'),fullPage:true});
  const first=await beginRecompute(page); await confirm.click(); await waitForRecompute(page,first);
  const saved=await savePart(page,info,fileName,app), feature=saved.solids.find(item=>item.kind==='functionSurface');
  if (feature?.kind !== 'functionSurface') throw new Error('Sphere source not saved');
  expect(feature.definition.formula).toMatchObject(implicit?{kind:'implicit-surface',expression:{source:'X^2+Y^2+Z^2-1'}}
    : {kind:'parametric-surface',U:{max:{source:'360'}},V:{max:{source:'180'}},outputs:{X:{angleUnit:'degree'},Y:{angleUnit:'degree'},Z:{angleUnit:'degree'}}});
  await page.reload();
  if(app){
    await openTarget(app,info.outputPath(fileName));await page.getByRole('group',{name:'ファイル',exact:true}).getByRole('button',{name:'開く',exact:true}).click();
  }else{
    const chooser=page.waitForEvent('filechooser');await page.getByRole('group',{name:'ファイル',exact:true}).getByRole('button',{name:'開く',exact:true}).click();
    await(await chooser).setFiles(info.outputPath(fileName));
  }
  await waitForRecompute(page);
  await page.getByText(feature.name,{exact:true}).click(); await page.getByRole('button',{name:text('edit'),exact:true}).click();
  await dialog.getByRole('textbox',{name:`Z ${text('minimum')}`,exact:true}).fill('0');
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click(); await expect(confirm).toBeEnabled({timeout:90_000});
  await expect(dialog.getByText(text('openSurface'),{exact:false})).toBeInViewport();
  await expect(dialog.getByText(`${text('volume')}:`,{exact:false})).toHaveCount(0);
  await page.screenshot({path:info.outputPath(implicit?'function-implicit-cut-sphere.png':'function-cut-sphere.png'),fullPage:true});
  const changed=await beginRecompute(page); await confirm.click(); await waitForRecompute(page,changed);
  const cut=await savePart(page,info,'function-cut-sphere.pcad',app);
  expect(cut.solids.find(item=>item.id===feature.id)).toMatchObject({definition:{bounds:{Z:{min:{source:'0',value:0}}},formula:feature.definition.formula}});
}
