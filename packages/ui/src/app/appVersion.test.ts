import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appVersionDefine } from '../../../../scripts/vite/appVersion.mjs';
import { currentAppVersion } from './appVersion.js';

const rootManifest = new URL('../../../../package.json', import.meta.url);

function rootVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(rootManifest, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('root package.json version missing');
  }
  return parsed.version;
}

describe('アプリの版(根の package.json の version だけを配る)', () => {
  it('ui の単体の設定の define と、build の define の値が、根の package.json の version と同じ', () => {
    expect(currentAppVersion()).toBe(rootVersion());
    expect(appVersionDefine()).toEqual({ __PCAD_APP_VERSION__: JSON.stringify(rootVersion()) });
  });

  it('version が無い・形の違う package.json では build を止める', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pcad-app-version-'));
    try {
      for (const [index, manifest] of [{}, { version: 3 }, { version: '1.0' }, { version: 'v1.0.3' }].entries()) {
        const file = join(folder, `package-${String(index)}.json`);
        writeFileSync(file, JSON.stringify(manifest));
        expect(() => appVersionDefine(pathToFileURL(file))).toThrow('semantic version');
      }
      const valid = join(folder, 'package-valid.json');
      writeFileSync(valid, JSON.stringify({ version: '2.3.4' }));
      expect(appVersionDefine(pathToFileURL(valid))).toEqual({ __PCAD_APP_VERSION__: '"2.3.4"' });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
