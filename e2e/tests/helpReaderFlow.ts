/// <reference lib="dom" />
import { expect, type ElectronApplication, type Page, type Request, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { HELP_TOPICS } from '../../packages/help-content/src/topics.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

/** Open the actual chapter catalog while a real numeric edit remains underneath. */
export async function helpReaderFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const original = await savePart(page, info, 'help-original.pcad', app);
  const errors: string[] = [], external: string[] = [];
  const onError = (error: Error) => { errors.push(error.message); };
  const origin = new URL(page.url()).origin;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== origin) external.push(request.url());
  };
  page.on('pageerror', onError); page.on('request', onRequest);
  try {
    await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
    const input = page.locator('.pcad-popover input.pcad-field__input').first();
    await input.fill('12/2'); await input.press('F1');
    const help = page.locator('.pcad-help'), article = help.locator('.pcad-help__article');
    const contents = help.getByRole('navigation', { name: uiMessage('help', 'help.contents'), exact: true });
    const topics = contents.locator('button.pcad-help__topic');
    await expect(topics).toHaveCount(HELP_TOPICS.length);
    let imageCount = 0;
    for (const topic of HELP_TOPICS) {
      await contents.getByRole('button', { name: topic.title, exact: true }).click();
      await expect(article).toHaveAttribute('data-help-topic', topic.id);
      await expect(article).toHaveAttribute('aria-busy', 'false');
      await expect(article.getByRole('alert')).toHaveCount(0);
      await expect(article.locator('h1')).toHaveCount(1);
      expect((await article.innerText()).trim().length, topic.id).toBeGreaterThan(20);
      await expect(article.locator('script, iframe, object, embed, [onclick], [onerror]')).toHaveCount(0);
      const images = article.locator('img.pcad-help__image');
      const source = await readFile(new URL('../../packages/help-content/' + topic.path, import.meta.url), 'utf8');
      const expectedImages = [...source.matchAll(/!\[[^\]]*\]\([^\s)]+\)/gu)].length;
      await expect(images, topic.id).toHaveCount(expectedImages);
      for (let index = 0; index < await images.count(); index += 1) {
        const image = images.nth(index);
        await image.scrollIntoViewIfNeeded();
        await expect(image, topic.id).toHaveJSProperty('complete', true);
        expect(await image.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth > 0
          && element.naturalHeight > 0), topic.id).toBe(true);
        imageCount += 1;
      }
    }
    const search = help.getByRole('searchbox', { name: uiMessage('help', 'help.search'), exact: true });
    for (const [query, topicId] of [['XYZ 曲面', 'function-surface'], ['フランジ', 'sheet-metal-flange'], ['幾何公差', 'gdt']] as const) {
      const topic = HELP_TOPICS.find(item => item.id === topicId);
      if (topic === undefined) throw new Error('Required search topic missing: ' + topicId);
      await search.fill(query);
      await expect.poll(async () => (await topics.allTextContents()).slice(0, 5)).toContain(topic.title);
    }
    for (const query of ['!!!', '存在しない検索語'.repeat(100)]) {
      await search.fill(query);
      await expect(contents.getByText(uiMessage('help', 'help.noResults'), { exact: true })).toBeVisible();
      await expect(search).toBeEditable();
    }
    await search.fill(''); await expect(topics).toHaveCount(HELP_TOPICS.length);
    await help.getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
    await expect(input).toHaveValue('12/2'); await input.press('Escape');
    expect(await savePart(page, info, 'help-after-reading.pcad', app)).toEqual(original);
    expect(errors).toEqual([]); expect(external).toEqual([]);
    await info.attach('help-reader-coverage', { body: JSON.stringify({ topicIds: HELP_TOPICS.map(topic => topic.id),
      imageCount, numericInputPreserved: true, savedDocumentPreserved: true, externalRequests: external }), contentType: 'application/json' });
  } finally { page.off('pageerror', onError); page.off('request', onRequest); }
}
