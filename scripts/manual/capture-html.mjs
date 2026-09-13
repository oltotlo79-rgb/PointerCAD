/** Capture the generated reader in real browsers. This does not certify application screenshots or release readiness. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { argv } from 'node:process';
import { log } from 'node:console';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { chromium, firefox } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = argv.slice(2);
assert.equal(args.length, 2, 'Specify the existing manual output name and a new capture output name');
for (const name of args) assert.match(name, /^[a-z0-9][a-z0-9-]*$/u, 'Output names must stay within dist');
assert.notEqual(args[0], args[1], 'Source and capture output must differ');
const dist = resolve(root, 'dist'), source = resolve(dist, args[0]), destination = resolve(dist, args[1]);
for (const path of [dist, source]) assert(!(await lstat(path)).isSymbolicLink(), 'Manual folders must not be links');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(resolve(source, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.format, 'pointercad-manual/1');
assert(Array.isArray(manifest.chapters) && manifest.chapters.length > 0);
assert(Array.isArray(manifest.volumes) && manifest.volumes.length > 0);
assert(manifest.outputs && typeof manifest.outputs === 'object');
const htmlNames = Object.keys(manifest.outputs).filter(name => name.endsWith('.html'));
assert.equal(htmlNames.length, manifest.chapters.length + manifest.volumes.length + 1);
const inside = name => {
  assert(typeof name === 'string' && !isAbsolute(name) && !name.includes('\\') && !name.includes('\0'), 'Invalid output name');
  const path = resolve(source, name), local = relative(source, path);
  assert(local && !isAbsolute(local) && !local.startsWith(`..${sep}`) && local !== '..', 'Output escapes manual folder');
  return path;
};
const verifySources = async () => {
  assert.equal(sha256(await readFile(resolve(source, 'manifest.json'))), sha256(manifestBytes), 'Manual manifest changed');
  for (const [name, hash] of Object.entries(manifest.outputs)) {
    assert.equal(sha256(await readFile(inside(name))), hash, `Manual output changed: ${name}`);
  }
};
await verifySources();
await mkdir(destination); // Never overwrite earlier evidence, including a failed attempt.
const result = { format: 'pointercad-manual-html-capture/1', releaseCertified: false, applicationImagesCertified: false,
  captureScriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  manualBuildId: manifest.buildId, manualManifestSha256: sha256(manifestBytes), startedAt: new Date().toISOString(),
  browsers: [], completed: false };
let completed = false;
try {
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch();
    const record = { name, version: browser.version(), checkedPages: [], searches: [], images: [], errors: [] };
    result.browsers.push(record);
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', error => record.errors.push({ type: 'page', message: error.message }));
      page.on('console', message => { if (message.type() === 'error') record.errors.push({ type: 'console', message: message.text() }); });
      page.on('requestfailed', request => record.errors.push({ type: 'request', url: request.url(), message: request.failure()?.errorText }));
      // Local manuals must not rely on a server, extension or insecure browser launch flags.
      page.on('request', request => {
        if (!['file:', 'data:'].includes(new URL(request.url()).protocol)) record.errors.push({ type: 'network', url: request.url() });
      });
      const open = async file => {
        record.currentPage = file;
        log(JSON.stringify({ browser: name, page: file, phase: 'opening' }));
        await page.goto(pathToFileURL(inside(file)).href, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded', undefined, { timeout: 15_000 });
        // The shared reader deliberately lazy-loads images. Exercise real scrolling instead of
        // waiting without a deadline for offscreen images that the browser has not requested.
        const imageCount = await page.locator('img').count();
        for (let index = 0; index < imageCount; index += 1) {
          await page.locator('img').nth(index).scrollIntoViewIfNeeded();
          await page.waitForFunction(index => {
            const image = globalThis.document.images[index];
            return image?.complete && image.naturalWidth > 0;
          }, index, { timeout: 15_000 });
        }
        await page.evaluate(() => globalThis.scrollTo(0, 0));
        const actual = await page.evaluate(() => {
          const { document, getComputedStyle } = globalThis;
          return {
          title: document.title, language: document.documentElement.lang,
          headings: Array.from(document.querySelectorAll('h1'), node => node.textContent),
          loadedFont: document.fonts.check('16px "PointerCAD Manual"', '座標と関数の説明'),
          fontFamily: getComputedStyle(document.body).fontFamily,
          images: Array.from(document.images, image => ({ src: image.getAttribute('src'), width: image.naturalWidth })),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        assert.equal(actual.language, 'ja', file);
        assert(actual.title.length > 0 && actual.headings.length > 0, `Missing reader content: ${file}`);
        assert(actual.loadedFont && actual.fontFamily.includes('PointerCAD Manual'), `Font is not ready: ${file}`);
        assert(actual.images.every(image => image.width > 0), `Broken image: ${file}`);
        assert(actual.overflow <= 1, `Page extends outside the reader viewport: ${file}`);
        assert.equal(record.errors.length, 0, JSON.stringify(record.errors));
        log(JSON.stringify({ browser: name, page: file, phase: 'ready', images: actual.images.length }));
        return actual;
      };
      const capture = async label => {
        const filename = `${name}-${label}.png`;
        const image = await page.screenshot({ path: resolve(destination, filename), animations: 'disabled' });
        record.images.push({ filename, sha256: sha256(image), url: page.url(), viewport: page.viewportSize() });
      };
      await open('index.html');
      const query = page.locator('#manual-query'), hits = page.locator('#manual-search-results a');
      const status = page.locator('#manual-search-status');
      for (const text of ['フランジ', '座標 式', 'ラジアン', '干渉']) {
        await query.fill(text);
        await hits.first().waitFor({ state: 'visible' });
        assert((await status.textContent())?.trim(), 'Search status is empty');
        record.searches.push({ query: text, chapters: await hits.evaluateAll(nodes => nodes.map(node => ({ title: node.textContent, href: node.getAttribute('href') }))) });
      }
      await capture('search');
      const firstHref = await hits.first().getAttribute('href');
      await query.press('Tab');
      assert.equal(await page.locator(':focus').getAttribute('href'), firstHref, 'Tab does not reach the first result');
      await page.keyboard.press('Enter');
      await page.waitForURL(pathToFileURL(inside(firstHref)).href);
      await page.locator('header a[href="../index.html"]').first().click();
      await page.waitForURL(pathToFileURL(inside('index.html')).href);
      await query.fill('該当無し_837f94f6');
      assert.equal(await hits.count(), 0, 'Unknown query unexpectedly matches a chapter');
      assert((await status.textContent())?.trim(), 'No-results explanation is missing');
      await query.press('Escape');
      assert.equal(await query.inputValue(), ''); assert.equal(await status.textContent(), '');
      for (const file of htmlNames) {
        const actual = await open(file);
        record.checkedPages.push({ file, headings: actual.headings, images: actual.images.length });
        if (file.startsWith('volumes/')) await capture(file.slice(8, -5));
      }
      await open('index.html');
      await page.setViewportSize({ width: 390, height: 844 });
      await open('index.html');
      await query.fill('関数'); await hits.first().waitFor({ state: 'visible' }); await capture('narrow-search');
      assert.equal(record.errors.length, 0, JSON.stringify(record.errors));
    } finally { await browser.close(); }
  }
  await verifySources();
  completed = true;
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  result.completed = completed;
  result.finishedAt = new Date().toISOString();
  await writeFile(resolve(destination, 'capture-result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
}
log(JSON.stringify({ destination, completed, manualBuildId: manifest.buildId, releaseCertified: false }));
