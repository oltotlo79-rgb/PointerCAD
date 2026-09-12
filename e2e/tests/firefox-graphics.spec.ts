import {test,expect} from '@playwright/test';
import {FIREFOX_GRAPHICS_PREFS} from '../firefoxLaunch.js';
import {installStartupDiagnostics,waitForStartupHealth} from './startupHealth.js';

test('Firefoxの描画利用制限を実ブラウザーで再現し、検査設定でWebGL2と実画面を開始する',async({playwright,baseURL},info)=>{
  if(baseURL===undefined)throw new Error('Missing application URL');
  // Mozilla's CreateAndInitGL forbids all drivers with this pair unless explicitly enabled.
  // This exercises the real browser failure; no getContext result or renderer is faked.
  const blocked={'webgl.forbid-hardware':true,'webgl.forbid-software':true,'webgl.force-enabled':false};
  const denied=await playwright.firefox.launch({firefoxUserPrefs:{...FIREFOX_GRAPHICS_PREFS,...blocked}});
  try{
    const page=await denied.newPage();await installStartupDiagnostics(page);await page.goto(baseURL);
    await expect(page.getByRole('button',{name:'3D 表示を再試行',exact:true})).toBeVisible();
    const reasons:unknown=await page.evaluate(()=>Reflect.get(globalThis,'pcadStartupContextErrors'));
    expect(JSON.stringify(reasons)).toMatch(/forbidden|restricts|block/iu);
    console.log(`[Firefox描画拒否の再現] ${JSON.stringify(reasons)}`);
  }finally{await denied.close();}
  const enabled=await playwright.firefox.launch({firefoxUserPrefs:{...blocked,...FIREFOX_GRAPHICS_PREFS,
    ...(process.platform==='win32'?{}:{'webgl.force-enabled':true})}});
  try{
    const page=await enabled.newPage();await installStartupDiagnostics(page);await page.goto(baseURL);
    await waitForStartupHealth(page,info);
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  }finally{await enabled.close();}
});
