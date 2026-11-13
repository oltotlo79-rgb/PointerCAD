import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopFileHash, sourceFileHash } from '../../../../scripts/release/desktopFileInventory.mjs';
import { checkDedicatedPerformanceEvidence, loadDedicatedPerformanceEvidence } from '../../../../scripts/release/dedicatedPerformanceEvidence.mjs';

// The release build inputs (scripts/vite/webBuildSources.mjs) read every CRLF as LF (sourceFileHash), so the dedicated
// evidence must read the current files the same way: a Windows checkout (core.autocrlf=true) writes CRLF, and some
// inputs are stored in Git with CRLF (attribute -text, e.g. docs/standards/licenses/decimal.js-10.6.0.txt), so their
// bytes hold CRLF in every checkout. The comparison itself stays exact: a file whose content differs is still refused.

const LOCK = 'pnpm-lock.yaml';
const CHECKOUT_CRLF = 'apps/web/src/product.ts';
const STORED_CRLF = 'docs/standards/licenses/sample-licence.txt';
const DESKTOP_LF = 'apps/desktop/src/main/product.ts';
const BINARY = 'packages/sample/glyphs.bin';
const contents: Record<string, Uint8Array> = {
  [LOCK]: Buffer.from("lockfileVersion: '9.0'\n"),
  [CHECKOUT_CRLF]: Buffer.from('export const width = 1;\r\nexport const height = 2;\r\n'),
  [STORED_CRLF]: Buffer.from('Licence text as published\r\nSecond line\r\nlast line without CR\n'),
  [DESKTOP_LF]: Buffer.from('export const depth = 3;\n'),
  // A NUL byte marks binary content, which is hashed unchanged even though it holds CR LF.
  [BINARY]: Uint8Array.from([0x00, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]),
};
const webNames = [LOCK, CHECKOUT_CRLF, STORED_CRLF, BINARY];
const desktopNames = [LOCK, DESKTOP_LF, STORED_CRLF, BINARY];

const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(root: string, name: string, bytes: Uint8Array): void {
  const target = join(root, ...name.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

/** A checkout holding the inputs, a QA input manifest written with the release build hashes, and its path/digest index. */
async function evidenceCheckout(): Promise<{ root: string; indexSha256: string;
  sourceInputs: { web: Record<string, string>; desktop: Record<string, string> } }> {
  const root = await realpath(mkdtempSync(join(resolve(tmpdir()), 'pointercad-evidence-line-ends-')));
  temporaryRoots.push(root);
  for (const [name, bytes] of Object.entries(contents)) write(root, name, bytes);
  const releaseHash = (name: string): string => sourceFileHash(readFileSync(join(root, ...name.split('/'))));
  const sourceInputs = {
    web: Object.fromEntries(webNames.map(name => [name, releaseHash(name)])),
    desktop: Object.fromEntries(desktopNames.map(name => [name, releaseHash(name)])),
  };
  const manifestBytes = Buffer.from(JSON.stringify({ schema_version: 1, checkout: root,
    files: Object.keys(contents).sort().map(path => ({ path, copy_sha256: releaseHash(path) })) }, null, 2));
  write(root, 'evidence/manifest.json', manifestBytes);
  const indexBytes = Buffer.from(JSON.stringify({ manifest: 'manifest',
    records: { manifest: { path: 'evidence/manifest.json', sha256: desktopFileHash(manifestBytes) } } }, null, 2));
  write(root, 'evidence/index.json', indexBytes);
  return { root, indexSha256: desktopFileHash(indexBytes), sourceInputs };
}

describe('専用の測定の証拠の今の入力は、組立ての入力と同じく CRLF を LF と読む', () => {
  it('作業ツリーの CRLF・Git の中の CRLF・バイナリーの CR LF でも、今の値が組立ての入力と一致し、照合は次の段へ進む', async () => {
    const { root, indexSha256, sourceInputs } = await evidenceCheckout();
    // The fixture really exercises the difference: raw bytes and the release build hash differ for both CRLF forms.
    for (const name of [CHECKOUT_CRLF, STORED_CRLF]) expect(desktopFileHash(contents[name])).not.toBe(sourceInputs.web[name]);
    expect(sourceInputs.web[BINARY]).toBe(desktopFileHash(contents[BINARY]));
    const evidence = await loadDedicatedPerformanceEvidence(root, 'evidence/index.json', indexSha256, sourceInputs);
    for (const inputs of [sourceInputs.web, sourceInputs.desktop]) {
      for (const [name, hash] of Object.entries(inputs)) expect(evidence.currentInputs[name]).toBe(hash);
    }
    // Source identity passes; the cells are what is missing (the next qualification), not the line ends.
    expect(checkDedicatedPerformanceEvidence('w21-dedicated', evidence, sourceInputs))
      .toEqual({ status: 'pending', summary: 'W21 requires all three hosts and original thirty pairs' });
    expect(checkDedicatedPerformanceEvidence('w22-dedicated', evidence, sourceInputs))
      .toEqual({ status: 'pending', summary: 'W22 requires all twelve normal/slow pairs' });
  });

  it.each([
    ['作業ツリーの CRLF のファイル', CHECKOUT_CRLF, 'export const width = 9;\r\nexport const height = 2;\r\n'],
    ['Git の中の CRLF のファイル', STORED_CRLF, 'Licence text as published\r\nSecond line changed\r\nlast line without CR\n'],
    ['LF のファイル', DESKTOP_LF, 'export const depth = 4;\n'],
  ])('%s の中身が実際に違えば、今までどおり Release build/Source identity differs で落ちる', async (_label, name, changed) => {
    const { root, indexSha256, sourceInputs } = await evidenceCheckout();
    write(root, name, Buffer.from(changed));
    const evidence = await loadDedicatedPerformanceEvidence(root, 'evidence/index.json', indexSha256, sourceInputs);
    for (const kind of ['w21-dedicated', 'w22-dedicated']) {
      expect(checkDedicatedPerformanceEvidence(kind, evidence, sourceInputs)).toEqual({ status: 'fail',
        summary: 'Dedicated raw evidence refused', problems: [`Release build/Source identity differs: ${name}`] });
    }
  });

  it('CR を消しただけでは同じにならない変更(CR だけの行末)は、別の中身として落ちる', async () => {
    const { root, indexSha256, sourceInputs } = await evidenceCheckout();
    // A lone CR is not a CRLF line end; reading CRLF as LF must not hide it.
    write(root, CHECKOUT_CRLF, Buffer.from('export const width = 1;\rexport const height = 2;\r\n'));
    const evidence = await loadDedicatedPerformanceEvidence(root, 'evidence/index.json', indexSha256, sourceInputs);
    expect(checkDedicatedPerformanceEvidence('w21-dedicated', evidence, sourceInputs)).toEqual({ status: 'fail',
      summary: 'Dedicated raw evidence refused', problems: [`Release build/Source identity differs: ${CHECKOUT_CRLF}`] });
  });
});
