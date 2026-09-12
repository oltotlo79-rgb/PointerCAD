import { expect, type Page, type TestInfo } from '@playwright/test';

/** Observe the lazy 3D mount as well as the earlier toolbar; fail at its real error. */
export async function waitForStartupHealth(page: Page, info: TestInfo): Promise<void> {
  const errors: string[] = [];
  const onError = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', onError);
  try {
    await expect.poll(async () => {
      if (errors.length > 0) return errors.join('\n');
      return page.evaluate(() => {
        const refusal = document.querySelector('.pcad-viewport [role="alert"]');
        if (refusal !== null) return refusal.textContent;
        const stats = window.pcadViewportRenderStats?.();
        const canvas = document.querySelector('canvas.pcad-viewport__canvas');
        return canvas !== null && stats !== undefined && stats.completedRenders > 0
          && document.querySelector('canvas.pcad-viewcube') !== null ? 'ready' : 'waiting';
      });
    }, { message: '3D表示とビューキューブが起動すること', timeout: 15_000 }).toBe('ready');
    const graphics = await page.locator('canvas.pcad-viewport__canvas').evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('3D canvas missing');
      const gl = canvas.getContext('webgl2');
      if (gl === null || gl.isContextLost()) throw new Error('WebGL2 is unavailable');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        version: gl.getParameter(gl.VERSION), width: canvas.width, height: canvas.height };
    });
    console.log(`[描画環境] ${JSON.stringify({ project: info.project.name, ...graphics })}`);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/u }).first().click();
    await expect(page.locator('.pcad-toolbar .pcad-menu__panel[aria-label="作る"]')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    page.off('pageerror', onError);
    console.log(`[起動診断] ${JSON.stringify({ project: info.project.name, errors })}`);
    await info.attach('startup-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
  }
}
