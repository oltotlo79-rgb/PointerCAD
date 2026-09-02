import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t } from './t.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 日本語(ひらがな・カタカナ・漢字・全角記号)と判定するコードポイント範囲。
 * ESLint の no-irregular-whitespace が全角スペース(U+3000)などの
 * 空白類文字リテラルを検査対象にするため、正規表現の文字クラスではなく
 * 数値のコードポイント範囲として持つ。
 */
const JAPANESE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // 区切り記号・句読点
  [0x3040, 0x309f], // ひらがな
  [0x30a0, 0x30ff], // カタカナ
  [0x4e00, 0x9fff], // 漢字
  [0xff00, 0xffef], // 全角英数・記号
];

function containsJapanese(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (JAPANESE_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
      return true;
    }
  }
  return false;
}

function listFiles(directory: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(fullPath, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(fullPath);
    }
  }
  return found;
}

/** 注釈は日本語で書いてよいので、判定の前に取り除く。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('UI 文字列リソース(NFR-MA-5)', () => {
  it('キーが 1 件以上あり、すべて空でない文字列を返す', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(0);
    for (const key of MESSAGE_KEYS) {
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });

  it('区画の見出しとステータスバーの案内が定義されている(FR-905)', () => {
    expect(t('featureTree.title')).toBe('モデルブラウザ');
    expect(t('propertyPanel.title')).toBe('プロパティ');
    expect(t('statusBar.unit')).toBe('単位: mm');
  });

  it('ビューキューブの 6 面の表記が揃っている(FR-103)', () => {
    expect([
      t('viewCube.front'),
      t('viewCube.back'),
      t('viewCube.right'),
      t('viewCube.left'),
      t('viewCube.top'),
      t('viewCube.bottom'),
    ]).toEqual(['前', '後', '右', '左', '上', '下']);
  });

  it('コンポーネント(.tsx)へ日本語を直書きしていない', () => {
    const offenders: string[] = [];
    for (const file of listFiles(sourceRoot, '.tsx')) {
      if (containsJapanese(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(file);
      }
    }
    expect(offenders, 'ja.json へ移してください').toEqual([]);
  });
});
