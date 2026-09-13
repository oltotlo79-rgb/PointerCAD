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
export async function functionCurvePointFlow(page:Page,info:TestInfo,form:'coordinate'|'parametric',app?:ElectronApplication):Promise<void> {
  await chooseToolMenuItem(page,'作図',plot('menuTitle'));
  const dialog=page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox',{name:plot('form'),exact:true}).selectOption(form);
  if(form==='coordinate')await dialog.getByRole('combobox',{name:plot('independent'),exact:true}).selectOption('Y');
  for(const [axis,source] of form==='coordinate'?[['X','Y^2'],['Z','0']]:[['X','T^2'],['Y','T'],['Z','0']]) {
    await dialog.getByRole('textbox',{name:`${axis} ${plot('formula')}`,exact:true}).fill(source);
  }
  for(const axis of ['X','Y','Z'])for(const endpoint of ['minimum','maximum'] as const) {
    await dialog.getByRole('textbox',{name:`${axis} ${plot(endpoint)}`,exact:true}).fill(endpoint==='minimum'?'-4':'4');
  }
  if(form==='parametric')for(const endpoint of ['minimum','maximum'] as const) {
    await dialog.getByRole('textbox',{name:`T ${plot(endpoint)}`,exact:true}).fill(endpoint==='minimum'?'-2':'2');
  }
  await dialog.getByRole('button',{name:plot('preview'),exact:true}).click();await waitForFunctionPreview(page,info,plot('apply'));
  const created=await beginRecompute(page);await dialog.getByRole('button',{name:plot('apply'),exact:true}).click();await waitForRecompute(page,created);
  const parentDocument=await savePart(page,info,`curve-point-${form}-parent.pcad`,app);
  const parent=parentDocument.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.kind==='functionCurve');
  if(!parent)throw new Error('Missing function curve');
  const tree=page.locator('.pcad-panel--left');
  await tree.getByRole('button',{name:parent.name,exact:true}).click();await page.getByRole('button',{name:text('title'),exact:true}).click();
  const axis=form==='coordinate'?'Y':'X',count=form==='coordinate'?1:2;
  await expect(dialog.getByRole('textbox',{name:`${axis} ${text('coordinate')}`,exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeDisabled();
  await dialog.getByRole('textbox',{name:`${axis} ${text('coordinate')}`,exact:true}).fill('1');
  await page.keyboard.press('F1');await expect(page.locator('.pcad-help__article')).toContainText('媒介変数Tの曲線');
  await page.keyboard.press('Escape');await expect(page.locator('.pcad-help')).toHaveCount(0);
  await dialog.getByRole('button',{name:text('search'),exact:true}).click();await expect(dialog.getByRole('radio')).toHaveCount(count);
  if(form==='coordinate')await expect(dialog.getByRole('radio')).toBeChecked();
  else {
    await expect(dialog.getByRole('button',{name:text('apply'),exact:true})).toBeDisabled();
    await expect(dialog).toContainText(`${text('parameter')}: T =`);await dialog.getByRole('radio').last().check();
    // The marker comes from the solved original equation. Read the actual canvas below it:
    // drawing the cubic's control polygon would leave both points floating away from the curve.
    await expect.poll(async()=>dialog.locator('.pcad-function-point-preview').evaluate(element=>{
      const canvas=element.querySelector('canvas');if(!canvas)return [];
      const context=canvas.getContext('2d');if(!context)return [];
      const box=canvas.getBoundingClientRect();
      return Array.from(element.querySelectorAll('.pcad-function-point-marker')).map(marker=>{
        const position=marker.getBoundingClientRect();
        const x=Math.round(((position.left+position.right)/2-box.left)*canvas.width/box.width);
        const y=Math.round(((position.top+position.bottom)/2-box.top)*canvas.height/box.height);
        const pixels=context.getImageData(x-3,y-3,7,7).data;
        let alpha=0;for(let i=3;i<pixels.length;i+=4)alpha=Math.max(alpha,pixels[i]);
        return alpha>=80;
      });
    }),{message:'原式から求めた両候補の位置を、確認画面の実曲線が通ること'}).toEqual([true,true]);
  }
  await page.screenshot({path:info.outputPath(`curve-point-${form}-candidates.png`),fullPage:true});
  const first=await beginRecompute(page);await dialog.getByRole('button',{name:text('apply'),exact:true}).click();await waitForRecompute(page,first);
  const file=`curve-point-${form}.pcad`,saved=await savePart(page,info,file,app);
  const point=saved.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.kind==='point');
  if(!point||point.at.mode==='absolute'||point.at.base.kind!=='functionPoint')throw new Error('Missing saved function point');
  expect(point.at.base.choice).toMatchObject({input:{kind:'curve',minimum:[-4,-4,-4],maximum:[4,4,4]},
    location:{kind:'curve',independent:form==='coordinate'?'Y':'T',interval:{lower:1,upper:1},direct:form==='coordinate'}});
  await reopenPart(page,info,file,app);await tree.getByRole('button',{name:point.name,exact:true}).click();
  await page.getByRole('button',{name:text('edit'),exact:true}).click();
  const field=dialog.getByRole('textbox',{name:`${axis} ${text('coordinate')}`,exact:true});await expect(field).toHaveValue('1');
  await field.fill(form==='coordinate'?'2':'4');await dialog.getByRole('button',{name:text('search'),exact:true}).click();
  await expect(dialog.getByRole('radio')).toHaveCount(count);await dialog.getByRole('radio').last().check();
  const edited=await beginRecompute(page);await dialog.getByRole('button',{name:text('update'),exact:true}).click();await waitForRecompute(page,edited);
  const changed=await savePart(page,info,`curve-point-${form}-changed.pcad`,app);
  expect(changed.sketches.flatMap(sketch=>sketch.features).filter(feature=>feature.kind==='point')).toMatchObject([
    {id:point.id,at:{base:{known:[{axis,value:{source:form==='coordinate'?'2':'4'}}],choice:{location:{interval:{lower:2,upper:2}}}}}},
  ]);
  const undo=await beginRecompute(page);await page.getByRole('button',{name:'元に戻す',exact:true}).click();await waitForRecompute(page,undo);
  const restored=await savePart(page,info,`curve-point-${form}-undo.pcad`,app);
  expect(restored.sketches.flatMap(sketch=>sketch.features).find(feature=>feature.id===point.id)).toEqual(point);
  await functionDirectionFlow(page,info,point,app);
}
