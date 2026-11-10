import { expect, type Frame, type Page, type TestInfo } from '@playwright/test';

const diagnostics=new WeakMap<Page,{errors:string[];consoleMessages:string[]}>();
/** Install before navigation; caught renderer errors are console/context events, not pageerror. */
export async function installStartupDiagnostics(page:Page):Promise<void> {
  if(diagnostics.has(page))return;
  const record={errors:[] as string[],consoleMessages:[] as string[]};diagnostics.set(page,record);
  page.on('pageerror',error=>{if(record.errors.length<30)record.errors.push(error.message.slice(0,2000));});
  page.on('console',message=>{if(['warning','error'].includes(message.type())&&record.consoleMessages.length<30)
    record.consoleMessages.push(message.text().slice(0,2000));});
  await page.addInitScript(()=>{
    const errors:string[]=[];Reflect.set(globalThis,'pcadStartupContextErrors',errors);
    // Read-only evidence of the product's existing one-time initial-module retry
    // (shell/startupRecovery.ts). Retain entry evidence after the product clears its key.
    let retryAddress: string | null = null;
    try { retryAddress = sessionStorage.getItem('pointercad.startup-retry.v1'); }
    catch { /* Denied optional storage supplies no permission to recover an evaluation. */ }
    Reflect.set(globalThis, 'pcadStartupRetryAddressAtEntry', retryAddress);
    const observed=new WeakSet<HTMLCanvasElement>();
    HTMLCanvasElement.prototype.getContext=new Proxy(HTMLCanvasElement.prototype.getContext,{
      apply(target,receiver,args){
        if(!(receiver instanceof HTMLCanvasElement)||!String(args[0]).startsWith('webgl'))return Reflect.apply(target,receiver,args);
        if(!observed.has(receiver)){
          observed.add(receiver);receiver.addEventListener('webglcontextcreationerror',event=>{
            if(errors.length<30)errors.push(String((event as WebGLContextEvent).statusMessage).slice(0,2000));
          });
        }
        return Reflect.apply(target,receiver,args);
      },
    });
  });
}

/**
 * The startup screen keeps the app inert until the lazy 3D view and the cube are ready.
 * Shared by waitForStartupHealth and launchDesktop, so both wait for the same condition.
 */
async function expectStartupReady(page: Page, errors: readonly string[]): Promise<void> {
  const initialUrl = page.url();
  const deadline = Date.now() + 15_000;
  let mainNavigations = 0;
  let unexpectedNavigation = false;
  let recoveredInitialLoad = false;
  const onNavigation = (frame: Frame): void => {
    if (frame !== page.mainFrame()) return;
    mainNavigations++;
    if (frame.url() !== initialUrl) unexpectedNavigation = true;
  };
  page.on('framenavigated', onNavigation);
  try {
    await expect.poll(async () => {
      if (errors.length > 0) return errors.join('\n');
      if (unexpectedNavigation || mainNavigations > 1) throw new Error('Unexpected navigation during initial startup');
      try {
        return await page.evaluate(() => {
          const refusal = document.querySelector('.pcad-viewport [role="alert"]');
          if (refusal !== null) return refusal.textContent;
          const stats = window.pcadViewportRenderStats?.();
          const canvas = document.querySelector('canvas.pcad-viewport__canvas');
          return canvas !== null && stats !== undefined && stats.completedRenders > 0
            && document.querySelector('canvas.pcad-viewcube') !== null ? 'ready' : 'waiting';
        });
      } catch (error: unknown) {
        // A destroyed context alone is not permission to ignore a failure. Only the
        // product's same-address, first-load retry with persisted entry evidence qualifies.
        if (!(error instanceof Error)
          || !/^(?:page\.evaluate: )?Execution context was destroyed, most likely because of a navigation$/u.test(error.message)
          || page.isClosed() || page.url() !== initialUrl || unexpectedNavigation
          || mainNavigations > 1 || recoveredInitialLoad || Date.now() >= deadline) throw error;
        const entry = await page.waitForFunction(address => location.href === address
          && Reflect.get(globalThis, 'pcadStartupRetryAddressAtEntry') === address,
        initialUrl, { timeout: Math.max(1, deadline - Date.now()) });
        await entry.dispose();
        if (page.url() !== initialUrl || unexpectedNavigation || mainNavigations !== 1) throw error;
        recoveredInitialLoad = true;
        return 'waiting';
      }
    }, { message: '3D表示とビューキューブが起動すること', timeout: 15_000 }).toBe('ready');
    await expect(page.locator('[data-startup-shell]'), '起動画面の終了後に操作する').toHaveCount(0);
  } finally { page.off('framenavigated', onNavigation); }
}

/** Wait until the startup screen has finished, without the extra health checks and menu gesture. */
export async function waitForStartupReady(page: Page): Promise<void> {
  const errors: string[] = [];
  const onError = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', onError);
  try { await expectStartupReady(page, errors); }
  finally { page.off('pageerror', onError); }
}

/** Observe the lazy 3D mount as well as the earlier toolbar; fail at its real error. */
export async function waitForStartupHealth(page: Page, info: TestInfo): Promise<void> {
  const errors: string[] = [];
  const onError = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', onError);
  try {
    await expectStartupReady(page, errors);
    const startup = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      paint: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, ms: entry.startTime })),
      stages: performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('pcad:startup:'))
        .map(entry => ({ name: entry.name, ms: entry.startTime })),
    }));
    console.log(`[起動時間] ${JSON.stringify({ project: info.project.name, ...startup })}`);
    await info.attach('startup-timing', { body: JSON.stringify(startup), contentType: 'application/json' });
    const graphics = await page.locator('canvas.pcad-viewport__canvas').evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('3D canvas missing');
      const gl = canvas.getContext('webgl2');
      if (gl === null || gl.isContextLost()) throw new Error('WebGL2 is unavailable');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        version: gl.getParameter(gl.VERSION), width: canvas.width, height: canvas.height };
    });
    console.log(`[描画環境] ${JSON.stringify({ project: info.project.name, ...graphics })}`);
    if(info.project.name.includes('firefox')&&process.platform==='win32'){
      expect(String(graphics.renderer),'Windows Firefoxは実際のWARPでWebGL2を描画する').toMatch(/Microsoft Basic Render Driver/iu);
    }
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/u }).first().click();
    await expect(page.locator('.pcad-toolbar .pcad-menu__panel[aria-label="作る"]')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    page.off('pageerror', onError);
    const captured=diagnostics.get(page);
    const contextErrors:unknown=await page.evaluate(()=>Reflect.get(globalThis,'pcadStartupContextErrors')).catch(()=>undefined);
    const detail={project:info.project.name,errors:[...(captured?.errors??[]),...errors],consoleMessages:captured?.consoleMessages??[],contextErrors};
    console.log(`[起動診断] ${JSON.stringify(detail)}`);
    await info.attach('startup-errors', { body: JSON.stringify(detail), contentType: 'application/json' });
  }
}
