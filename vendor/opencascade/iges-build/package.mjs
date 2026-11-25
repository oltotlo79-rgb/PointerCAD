import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const here = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(here, '../../..');
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
const base = pins.baseline;
const rawNames = ['opencascade.closed.js', 'opencascade.closed.wasm', 'opencascade.closed.d.ts'];
const finalNames = ['opencascade.full.js', 'opencascade.full.wasm', 'opencascade.full.d.ts'];
const hash = (data) => createHash('sha256').update(data).digest('hex');
const facts = (data) => ({ bytes: data.length, sha256: hash(data) });

function pinned(path, expected) {
  const data = readFileSync(path);
  assert.deepEqual(facts(data), expected, path);
  return data;
}

function functionSpans(text) {
  const marks = [...text.matchAll(/function ([A-Za-z_$][\w$]*)\(/gu)];
  return marks.map((mark, index) => ({
    name: mark[1], start: mark.index, end: marks[index + 1]?.index ?? text.length,
    get text() { return text.slice(this.start, this.end); },
  }));
}

function cspChanges() {
  const vendorPatch = readFileSync(join(root, 'vendor/opencascade/patches/opencascade.js@2.0.0-beta.b5ff984.patch'));
  assert.equal(hash(vendorPatch), base.patch);
  const [diff, from, to, header, ...hunk] = vendorPatch.toString('utf8').split('\n');
  if (hunk.at(-1) === '') hunk.pop();
  assert.deepEqual([diff, from, to], [
    'diff --git a/dist/opencascade.full.js b/dist/opencascade.full.js',
    '--- a/dist/opencascade.full.js',
    '+++ b/dist/opencascade.full.js',
  ]);
  const counts = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(header);
  assert.ok(counts);
  assert.ok(hunk.every((line) => line === '' || [' ', '+', '-'].includes(line[0])));
  const oldLines = hunk.filter((line) => line[0] !== '+');
  const newLines = hunk.filter((line) => line[0] !== '-');
  assert.equal(oldLines.length, Number(counts[2]));
  assert.equal(newLines.length, Number(counts[4]));
  const [before, after] = [oldLines, newLines].map((lines) => lines.map((line) => line.slice(1)).join('\n'));
  const [oldSpans, newSpans] = [before, after].map(functionSpans);
  assert.deepEqual(oldSpans.map((part) => part.name), newSpans.map((part) => part.name));
  assert.equal(before.slice(0, oldSpans[0].start), after.slice(0, newSpans[0].start));
  const changes = oldSpans.map((part, i) => ({ name: part.name, before: part.text, after: newSpans[i].text }))
    .filter((part) => part.before !== part.after);
  assert.deepEqual(changes.map((part) => ({
    name: part.name, oldSha256: hash(part.before), newSha256: hash(part.after),
  })), base.cspReplacements);
  return changes;
}

function cspApply(glue, changes, backwards = false) {
  let patched = glue;
  for (const change of changes) {
    const spans = functionSpans(patched).filter((span) => span.name === change.name);
    assert.equal(spans.length, 1, change.name);
    const span = spans[0];
    assert.equal(span.text, backwards ? change.after : change.before, change.name);
    patched = patched.slice(0, span.start) + (backwards ? change.before : change.after) + patched.slice(span.end);
  }
  return patched;
}

function dynamicSites(glue) {
  const spans = functionSpans(glue);
  const sites = {};
  for (const match of glue.matchAll(/new Function\(|new_\(Function\b|\beval\(/gu)) {
    const name = spans.findLast((span) => span.start <= match.index)?.name ?? '<top>';
    const key = name + ':' + match[0];
    sites[key] = (sites[key] ?? 0) + 1;
  }
  return sites;
}

function onlyOnce(text, marker, replacement = '') {
  assert.equal(text.split(marker).length, 2, marker.slice(0, 120));
  return text.replace(marker, replacement);
}

function declarations(raw, installed) {
  const anchor = 'type Standard_Size = number;\n\n';
  const aliasMatch = /^\/\/ [^\n]*OCCT typedef aliases[^\n]*\ntype Graphic3d_ZLayerId = Standard_Integer;\ntype IntTools_CArray1OfReal = TColStd_Array1OfReal;\ntype Poly_MeshPurpose = number;\ntype XCAFDoc_PartId = TCollection_AsciiString;\n\n/mu.exec(installed);
  assert.ok(aliasMatch && installed.includes(anchor + aliasMatch[0]));
  const legacy = onlyOnce(installed, aliasMatch[0]);
  assert.equal(hash(legacy), base.rawDeclarationSha256);
  let remaining = raw;
  const names = [];
  for (const input of pins.bindings.filter((item) => item.input.endsWith('.d.ts.json'))) {
    const metadata = JSON.parse(pinned(join(here, 'bindings', input.input), input.source));
    remaining = onlyOnce(remaining, metadata['.d.ts']);
    for (const name of metadata.exports) {
      names.push(name);
      remaining = onlyOnce(remaining, '  ' + name + ': typeof ' + name + ';\n');
    }
  }
  assert.deepEqual(names, pins.exports);
  assert.equal(remaining, legacy, 'Generated declarations changed outside the four registered bindings');
  function counts(text) {
    const list = text.split('export type OpenCascadeInstance = {FS: typeof FS} & {\n')[1]?.split('\n};')[0];
    assert.ok(list);
    return [[...text.matchAll(/^[ \t]*export declare class /gmu)].length, list.split('\n').filter(Boolean).length];
  }
  assert.deepEqual(counts(legacy), [base.classes[0], base.instanceEntries[0]]);
  assert.deepEqual(counts(raw), [base.classes[1], base.instanceEntries[1]]);
  return onlyOnce(raw, anchor, anchor + aliasMatch[0]);
}

function transport(wasm, opts) {
  const compressed = gzipSync(wasm, opts);
  const expanded = gunzipSync(compressed);
  assert.ok(expanded.equals(wasm));
  return { gzip: facts(compressed), decoded: facts(expanded) };
}

function main(raw, destination) {
  const claimed = JSON.parse(readFileSync(join(raw, 'build-outputs.json'), 'utf8'));
  assert.deepEqual(Object.keys(claimed), rawNames);
  const outputs = rawNames.map((name) => pinned(join(raw, name), claimed[name]));
  const [glue, wasm, dts] = outputs;
  assert.equal(wasm.subarray(0, 8).toString('hex'), '0061736d01000000');
  assert.notEqual(hash(wasm), base.files['dist/opencascade.full.wasm'].sha256);
  assert.ok(wasm.length <= 64 * 1024 ** 2, 'Decoded browser WASM exceeds 64 MiB');
  const rawGlue = glue.toString('utf8');
  assert.ok(rawGlue.trimEnd().endsWith('export default Module;'));
  assert.match(rawGlue, /\bwasmBinaryFile="opencascade\.closed\.wasm"/u);
  const baselinePackage = JSON.parse(pinned(join(root, base.vendor, 'package.json'), base.package));
  assert.equal(baselinePackage.version, '2.0.0-beta.b5ff984');
  for (const [name, pin] of Object.entries(base.files)) pinned(join(root, base.vendor, name), pin);
  const [installed, installedDts] = [finalNames[0], finalNames[2]]
    .map((name) => readFileSync(join(root, base.vendor, 'dist', name), 'utf8'));
  const changes = cspChanges();
  const original = cspApply(installed, changes, true);
  assert.equal(hash(original), base.rawGlueSha256);
  assert.equal(cspApply(original, changes), installed);
  const closed = cspApply(rawGlue, changes);
  assert.deepEqual(dynamicSites(closed), base.dynamicSites);
  const final = [Buffer.from(closed), wasm, Buffer.from(declarations(dts.toString('utf8'), installedDts))];
  const web = transport(wasm, { level: 9 });
  const desktop = transport(wasm);
  assert.ok(web.gzip.bytes <= 25 * 1024 ** 2, 'Web gzip exceeds 25 MiB');
  const report = {
    raw: claimed,
    vendor: Object.fromEntries(finalNames.map((name, index) => [name, facts(final[index])])),
    wasmTransport: { web, desktop, node: process.version, zlib: process.versions.zlib },
    csp: { replacements: base.cspReplacements, dynamicSites: dynamicSites(closed) },
    expectedNewExports: pins.exports,
  };
  mkdirSync(destination);
  finalNames.forEach((name, index) => writeFileSync(join(destination, name), final[index], { flag: 'wx' }));
  writeFileSync(join(destination, 'materialization.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv.length !== 4) throw new Error('Usage: node package.mjs <raw-directory> <new-vendor-directory>');
main(resolve(process.argv[2]), resolve(process.argv[3]));
