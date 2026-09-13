import {expect,type Page,type TestInfo} from '@playwright/test';

/** A visible rejection is a terminal result, not a reason to wait out the whole CAD deadline. */
export async function waitForFunctionPreview(page:Page,info:TestInfo,buttonText:string):Promise<void>{
  const handle=await page.waitForFunction(label=>{
    const dialog=document.querySelector('dialog.pcad-function-dialog[open]');if(!dialog)return null;
    const failure=dialog.querySelector('[role="alert"]')?.textContent?.trim();
    if(failure)return {status:'failed',message:failure};
    const button=Array.from(dialog.querySelectorAll('button')).find(item=>item.textContent?.trim()===label);
    return button&&!button.disabled?{status:'ready'}:null;
  },buttonText,{timeout:90_000});
  const outcome=await handle.jsonValue();await handle.dispose();
  if(outcome?.status==='failed')await page.screenshot({path:info.outputPath('function-preview-failure.png'),fullPage:true});
  expect(outcome).toEqual({status:'ready'});
}
