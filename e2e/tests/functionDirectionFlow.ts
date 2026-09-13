import {expect,type ElectronApplication,type Page,type TestInfo} from '@playwright/test';
import {savePart} from './scriptsFlow.js';
import {reopenPart} from './reopenPart.js';
import {beginRecompute,waitForRecompute} from './recompute.js';
import {functionDirectionMessage as text} from './functionDirectionMessages.js';
import {captureManualDetail} from './captureManualDetail.js';
import {chooseToolMenuItem} from './assemblyTestSupport.js';
/** Continue from a real function point; no injected editor state or manufactured geometry. */
export async function functionDirectionFlow(page:Page,info:TestInfo,point:{readonly id:string;readonly name:string},app?:ElectronApplication,
  geometry:'curve'|'parametric-surface'|'implicit-surface'='curve'):Promise<void>{
  const original=await savePart(page,info,'function-direction-before.pcad',app);
  const editedKind=geometry==='parametric-surface'?'tangent-u':geometry==='curve'?'tangent':'normal';
  const tree=page.locator('.pcad-panel--left'),dialog=page.locator('.pcad-function-dialog');
  await tree.getByRole('button',{name:point.name,exact:true}).click();
  await page.getByRole('button',{name:text('title'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeDisabled();
  if(geometry==='parametric-surface'){
    await expect(dialog.getByRole('radio',{name:text('tangent-u'),exact:true})).toBeVisible();
    await expect(dialog.getByRole('radio',{name:text('tangent-v'),exact:true})).toBeVisible();
    await expect(dialog.getByRole('radio',{name:text('tangent'),exact:true})).toHaveCount(0);
  } else if(geometry==='implicit-surface') {
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await expect(dialog.getByRole('radio',{name:text('normal'),exact:true})).toBeVisible();
  }
  await dialog.getByRole('radio',{name:text('normal'),exact:true}).check();
  await dialog.getByRole('textbox',{name:text('length'),exact:true}).fill('2*5');
  await dialog.getByRole('checkbox',{name:text('reverse'),exact:true}).check();
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeEnabled();
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect(dialog.locator('canvas')).toHaveAttribute('aria-label',text('result'));
  await page.keyboard.press('F1');await expect(page.locator('.pcad-help__article')).toContainText('点から接線・法線を作る');
  await page.keyboard.press('Escape');await expect(page.locator('.pcad-help')).toHaveCount(0);
  await captureManualDetail(page,info,{name:`function-direction-${geometry}-preview`,dialog,fixture:original,script:new URL(import.meta.url)});
  const generation=await beginRecompute(page);await dialog.getByRole('button',{name:text('apply'),exact:true}).click();await waitForRecompute(page,generation);
  const created=await savePart(page,info,'function-direction-created.pcad',app);
  const line=created.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.kind==='line'&&feature.to.mode==='relative'
    &&feature.to.base.kind==='functionPoint'&&feature.to.base.direction?.sourcePointId===point.id);
  if(!line||line.kind!=='line')throw new Error('Missing saved direction');
  await measureDirection(page, line.name, 10);
  expect(line).toMatchObject({from:{base:{kind:'point',pointId:point.id}},to:{base:{direction:{kind:'normal',reverse:true,length:{source:'2*5',value:10}}}}});
  const undone=await beginRecompute(page);await page.getByRole('button',{name:'元に戻す',exact:true}).click();await waitForRecompute(page,undone);
  const without=await savePart(page,info,'function-direction-undo-create.pcad',app);
  expect(without.sketches.flatMap(sketch=>sketch.features).some(feature=>feature.id===line.id)).toBe(false);
  await expect(tree.getByRole('button',{name:point.name,exact:true})).toBeVisible();
  await reopenPart(page,info,'function-direction-created.pcad',app);
  await tree.getByRole('button',{name:line.name,exact:true}).click();await page.getByRole('button',{name:text('edit'),exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:text('length'),exact:true})).toHaveValue('2*5');
  await expect(dialog.getByRole('checkbox',{name:text('reverse'),exact:true})).toBeChecked();
  await dialog.getByRole('radio',{name:text(editedKind),exact:true}).check();
  await dialog.getByRole('textbox',{name:text('length'),exact:true}).fill('6');
  await dialog.getByRole('checkbox',{name:text('reverse'),exact:true}).uncheck();
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('update'),exact:true})).toBeEnabled();
  await captureManualDetail(page,info,{name:`function-direction-${geometry}-edit`,dialog,fixture:created,script:new URL(import.meta.url)});
  const editing=await beginRecompute(page);await dialog.getByRole('button',{name:text('update'),exact:true}).click();await waitForRecompute(page,editing);
  const changed=await savePart(page,info,'function-direction-edited.pcad',app);
  expect(changed.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.id===line.id)).toMatchObject({id:line.id,to:{base:{direction:{kind:editedKind,reverse:false,length:{value:6}}}}});
  await measureDirection(page, line.name, 6);
  const undo=await beginRecompute(page);await page.getByRole('button',{name:'元に戻す',exact:true}).click();await waitForRecompute(page,undo);
  await measureDirection(page, line.name, 10);
  const restored=await savePart(page,info,'function-direction-undo-edit.pcad',app);
  expect(restored.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.id===line.id)).toEqual(line);
  await page.screenshot({ path: info.outputPath('function-direction-measure.png'), fullPage: true });
}

/** Exercise the ordinary tool and current resolved length, including after Undo. */
async function measureDirection(page: Page, name: string, length: number): Promise<void> {
  await page.locator('.pcad-panel--left').getByRole('button', { name, exact: true }).click();
  await chooseToolMenuItem(page, '見た目', '測る');
  const result = page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^結果$/u }).locator('xpath=following-sibling::dd[1]');
  await expect(result).toContainText(String(length));
  const value = Number((await result.textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
  expect(value).toBeCloseTo(length, 6);
}
