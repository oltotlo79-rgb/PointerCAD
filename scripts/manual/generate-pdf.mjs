/** Prepared for scripts/manual: render the same HTML volumes with selectable text and tagged structure. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { argv, env } from 'node:process';
import { log } from 'node:console';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createManualPrintLinkResolver } from './print-links.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = argv.slice(2);
assert.equal(args.length, 2, 'Specify the HTML manual and a new PDF output name');
for (const name of args) assert.match(name, /^[a-z0-9][a-z0-9-]*$/u, 'Output names must stay within dist');
assert.notEqual(args[0], args[1], 'Source and output must differ');
const dist = resolve(root, 'dist'), source = resolve(dist, args[0]), destination = resolve(dist, args[1]);
for (const folder of [dist, source]) assert(!(await lstat(folder)).isSymbolicLink(), 'Manual folders must not be links');
const sourceRoot = await realpath(source);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(resolve(sourceRoot, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.format, 'pointercad-manual/1');
assert(Array.isArray(manifest.volumes) && manifest.volumes.length > 0);
assert(Array.isArray(manifest.chapters) && manifest.chapters.length > 0);
assert(manifest.outputs && typeof manifest.outputs === 'object');
const inside = async name => {
  assert(typeof name === 'string' && name !== '' && !isAbsolute(name) && !name.includes('\\') && !name.includes('\0'));
  const candidate = await realpath(resolve(sourceRoot, name)), local = relative(sourceRoot, candidate);
  assert(local !== '' && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), 'Manual input escapes its folder');
  return candidate;
};
const verify = async () => {
  assert.equal(hash(await readFile(resolve(sourceRoot, 'manifest.json'))), hash(manifestBytes), 'Manual manifest changed');
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    assert.equal(hash(await readFile(await inside(name))), expected, 'Manual output changed: ' + name);
  }
};
const ids = new Set();
for (const volume of manifest.volumes) {
  assert.match(volume.id, /^[a-z][a-z0-9-]*$/u); assert(!ids.has(volume.id)); ids.add(volume.id);
  assert.equal(typeof volume.title, 'string'); assert(volume.title.length > 0);
  assert(manifest.outputs['volumes/' + volume.id + '.html'], 'Missing HTML volume');
}
await verify();
await mkdir(destination); // Earlier outputs, including failures, are never overwritten.
assert(manifest.outputs['fonts/LICENSES.txt'], 'Missing bundled font notice');
await writeFile(resolve(destination, 'LICENSES.txt'), await readFile(await inside('fonts/LICENSES.txt')), { flag: 'wx' });
const temporary = resolve(destination, 'browser-temporary');
await mkdir(temporary);
// Playwright's own temporary profile/artifact files also remain inside this project.
env.TMP = temporary; env.TEMP = temporary; env.TMPDIR = temporary;
const result = {
  format: 'pointercad-manual-pdf/1', releaseCertified: false, visualCertified: false, portableLinksVerified: false,
  manualBuildId: manifest.buildId, manualManifestSha256: hash(manifestBytes),
  fontNoticeSha256: manifest.outputs['fonts/LICENSES.txt'],
  generatorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  printLinksSha256: hash(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), 'print-links.mjs'))),
  startedAt: new Date().toISOString(), completed: false, volumes: [],
};
let browser;
try {
  browser = await chromium.launch(); result.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const failures = [];
  await context.route(/^https?:\/\//u, route => { failures.push('Unexpected external request: ' + route.request().url()); return route.abort(); });
  const page = await context.newPage(); page.setDefaultTimeout(45_000);
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(request.url()));
  await page.emulateMedia({ media: 'print' });
  for (const volume of manifest.volumes) {
    const html = 'volumes/' + volume.id + '.html', name = volume.id + '.pdf';
    log(JSON.stringify({ volume: volume.id, phase: 'loading' }));
    await page.goto(pathToFileURL(await inside(html)).href, { waitUntil: 'load' });
    await page.evaluate(() => { for (const image of globalThis.document.images) image.loading = 'eager'; });
    await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded'
      && [...globalThis.document.images].every(image => image.complete && image.naturalWidth > 0));
    const content = await page.evaluate(() => {
      const { document } = globalThis;
      return { title: document.title, language: document.documentElement.lang,
      font: [...document.fonts].some(face => face.family.replace(/^["']|["']$/gu, '') === 'PointerCAD Manual' && face.status === 'loaded')
        && document.fonts.check('16px "PointerCAD Manual"', '座標と関数'),
      chapters: [...document.querySelectorAll('article')].map(article => article.id),
      imageCount: document.images.length, characters: document.body.innerText.length,
      links: [...document.querySelectorAll('a[href]')].map(link => link.getAttribute('href')),
      };
    });
    assert.equal(content.language, 'ja'); assert(content.font); assert(content.characters > 0);
    assert.deepEqual(content.chapters, volume.topics.map(id => 'chapter-' + id), 'Missing printed chapter: ' + volume.id);
    const resolveLink = createManualPrintLinkResolver(manifest, volume.id);
    const links = content.links.map(href => ({ original: href, resolved: resolveLink(href) }));
    await page.evaluate(({ links, volumes, chapters, current }) => {
      const { document, HTMLAnchorElement } = globalThis;
      const main = document.querySelector('main'), title = document.querySelector('header nav')?.getAttribute('aria-label');
      if (!main || !title || document.getElementById('manual-all-volumes')) throw new Error('Missing manual print structure');
      const appendix = document.createElement('section'); appendix.id = 'manual-all-volumes';
      // Reuse the catalog and existing translated index label. No duplicate chapter text.
      const heading = document.createElement('h1'); heading.textContent = title; appendix.append(heading);
      for (const volume of volumes) {
        const heading = document.createElement('h2'); heading.textContent = volume.title; appendix.append(heading);
        const list = document.createElement('ol');
        for (const chapter of chapters.filter(chapter => chapter.volumeId === volume.id)) {
          const item = document.createElement('li'), label = document.createElement(volume.id === current ? 'a' : 'span');
          label.textContent = chapter.title;
          if (label instanceof HTMLAnchorElement) label.href = '#chapter-' + chapter.id;
          item.append(label); list.append(item);
        }
        appendix.append(list);
      }
      const originals = [...document.querySelectorAll('a[href]')];
      if (originals.length !== links.length) throw new Error('Manual links changed before printing');
      for (const [index, link] of originals.entries()) {
        const { original, resolved } = links[index];
        if (link.getAttribute('href') !== original) throw new Error('Manual reference changed before printing');
        if (resolved.kind === 'reference') {
          const text = document.createElement('span');
          text.append(...link.childNodes, document.createTextNode(resolved.text)); link.replaceWith(text);
        } else link.setAttribute('href', resolved.href);
      }
      main.append(appendix);
      for (const link of document.querySelectorAll('a[href^="#"]')) {
        if (!document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)))) throw new Error('Missing print anchor');
      }
    }, { links, volumes: manifest.volumes, chapters: manifest.chapters, current: volume.id });
    assert.equal(failures.length, 0, failures.join('\n'));
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true, outline: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8pt;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    await writeFile(resolve(destination, name), pdf, { flag: 'wx' });
    const record = { id: volume.id, title: volume.title, name, bytes: pdf.length, sha256: hash(pdf), source: html, content,
      references: links, printedIndexChapters: manifest.chapters.length };
    result.volumes.push(record);
    assert(pdf.length <= 26_214_400, 'PDF exceeds the planned single-asset limit: ' + name);
    log(JSON.stringify({ volume: volume.id, phase: 'printed', bytes: pdf.length }));
  }
  await verify(); assert.equal(result.volumes.length, manifest.volumes.length);
  result.completed = true;
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error); throw error;
} finally {
  try { await browser?.close(); }
  finally {
    result.finishedAt = new Date().toISOString();
    await writeFile(resolve(destination, 'pdf-manifest.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  }
}
log(JSON.stringify({ destination, completed: result.completed, releaseCertified: false }));
