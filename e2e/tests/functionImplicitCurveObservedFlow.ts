/// <reference lib="dom" />
import { functionPlotMessage } from './functionMessages.js';
import {log} from 'node:console';
import {expect,type ElectronApplication,type Locator,type Page,type TestInfo} from '@playwright/test';
import {chooseToolMenuItem} from './assemblyTestSupport.js';
import {openTarget} from './electronAppFlow.js';
import {savePart} from './scriptsFlow.js';
import {beginRecompute,waitForRecompute} from './recompute.js';
import {uiMessage} from './uiMessages.js';
import {observeMathWorkers} from './mathWorkerDiagnostics.js';
import {waitForStartupReady} from './startupHealth.js';
import type { FunctionPlotCommitArm } from '@pointercad/ui/testing/function-plot-commit';

const text = functionPlotMessage;

async function confirmImplicitCurve(page: Page, dialog: Locator, info: TestInfo, label: string): Promise<string> {
  const confirm = dialog.getByRole('button', { name: text('apply'), exact: true });
  await expect(confirm).toBeEnabled();
  const observation = await confirm.evaluateHandle(node => {
    const view = node.ownerDocument.defaultView;
    if (view === null || !(node instanceof view.HTMLButtonElement)) return () => null;
    let read: Parameters<FunctionPlotCommitArm['accept']>[0] | undefined;
    node.closest('dialog')?.dispatchEvent(new view.CustomEvent<FunctionPlotCommitArm>('pcad:test-curve-commit', {
      detail: { button: node, accept: collect => { read = collect; } },
    }));
    return (finish: boolean) => read?.(finish) ?? null;
  });
  try {
    const armed = await observation.evaluate(read => read(false));
    expect(armed?.points[0], 'curve confirmation observation').toMatchObject({ phase: 'armed' });
    const token = await beginRecompute(page);
    await confirm.click();
    await expect(dialog, 'the real confirmation dismisses the plot dialog').toHaveCount(0);
    const report = await observation.evaluate(read => read(false));
    const target = report?.points.find(point => point.phase === 'target');
    const published = report?.points.find(point => point.phase === 'published');
    const featureId = target?.featureId;
    expect(report?.points.find(point => point.phase === 'click')).toMatchObject({ onButton: true });
    if (featureId === undefined) throw new Error('The curve confirmation did not enter the product commit');
    expect(published, 'the confirmed curve is published as one undoable edit').toMatchObject({ featureId, undoDepth: 1 });
    await waitForRecompute(page, token);
    const settled = await observation.evaluate(read => read(false));
    const requested = settled?.points.find(point => point.phase === 'requested');
    const completed = settled?.points.find(point => point.phase === 'completed');
    expect(requested?.requested, 'the confirmed curve requests a new generation').toBeGreaterThan(token.requestedGeneration);
    expect(completed, 'that generation completes successfully').toMatchObject({ completed: requested?.requested, outcome: 'success' });
    return featureId;
  } catch (error) {
    const report = await observation.evaluate(read => read(false)).catch(() => null);
    const body = JSON.stringify(report ?? { end: 'observation-unavailable', points: [] });
    log(`[${label}] ${body}`);
    await info.attach(label, { body, contentType: 'application/json' }).catch(() => undefined);
    throw error;
  } finally {
    await observation.evaluate(read => read(true)).catch(() => null);
    await observation.dispose().catch(() => undefined);
  }
}
export async function functionImplicitCurveObservedFlow(page:Page,info:TestInfo,app?:ElectronApplication):Promise<void>{
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
  await expect(dialog.locator('canvas')).toBeInViewport({ratio:1});
  const createdId=await confirmImplicitCurve(page,dialog,info,'implicit-curve-create');
  const original=await savePart(page,info,'function-implicit-circle.pcad',app);
  const feature=original.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===createdId);
  if(feature?.kind!=='functionCurve') throw new Error('Missing saved implicit curve');
  expect(feature.definition.formula).toMatchObject({kind:'implicit-curve',fixedAxis:'Z',fixedCoordinate:{value:0.5},expression:{source:'X^2+Y^2-1'}});
  await page.reload();
  await waitForStartupReady(page);
  await waitForRecompute(page);
  const openButton=page.getByRole('group',{name:'ファイル',exact:true}).getByRole('button',{name:'開く',exact:true});
  if(app!==undefined) await openTarget(app,info.outputPath('function-implicit-circle.pcad'));
  const reopened=await beginRecompute(page);
  if(app!==undefined){
    await openButton.click();
  }else{
    const chooser=page.waitForEvent('filechooser');await openButton.click();
    await(await chooser).setFiles(info.outputPath('function-implicit-circle.pcad'));
  }
  await waitForRecompute(page,reopened);await page.getByText(feature.name,{exact:true}).click();await page.getByRole('button',{name:text('edit'),exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:'F =',exact:true})).toHaveValue('X^2+Y^2-1');
  await expect(dialog.getByRole('textbox',{name:`Z ${text('fixedCoordinate')}`,exact:true})).toHaveValue('0.5');
  await dialog.getByRole('combobox',{name:text('fixedAxis'),exact:true}).selectOption('X');
  await dialog.getByRole('button',{name:`F: ${uiMessage('math','math.open')}`,exact:true}).click();
  const math=page.locator('.pcad-math-dialog');await math.locator('textarea').fill('Y^2+Z^2-1');
  await expect(math.getByRole('button',{name:'この式を使う',exact:true})).toBeEnabled();await math.getByRole('button',{name:'この式を使う',exact:true}).click();
  await expect(math).toHaveCount(0);await dialog.getByRole('textbox',{name:`Z ${text('maximum')}`,exact:true}).fill('0');
  await dialog.getByRole('button',{name:text('preview'),exact:true}).click();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeEnabled({timeout:60_000});
  await expect(dialog.getByRole('status')).toContainText(`${text('closedCurveCount')}: 0`);
  await expect(dialog.locator('canvas')).toBeInViewport({ratio:1});
  expect(await confirmImplicitCurve(page,dialog,info,'implicit-curve-edit')).toBe(feature.id);
  const saved=await savePart(page,info,'function-implicit-open-arc.pcad',app);
  expect(saved.sketches.flatMap(sketch=>sketch.features).find(item=>item.id===feature.id)).toMatchObject({definition:{
    formula:{kind:'implicit-curve',fixedAxis:'X',fixedCoordinate:{value:0.5},expression:{source:'Y^2+Z^2-1'}},bounds:{Z:{max:{value:0}}}}});
  const undo=await beginRecompute(page);await page.locator('canvas.pcad-viewport__canvas').focus();await page.keyboard.press('Control+z');await waitForRecompute(page,undo);
  expect((await savePart(page,info,'function-implicit-curve-undone.pcad',app)).sketches).toEqual(original.sketches);
}
