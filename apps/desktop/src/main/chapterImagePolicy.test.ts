import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_EXCEPTIONS, NO_IMAGE_NEEDED, checkChapterImagePolicy } from '../../../../scripts/manual/chapterImagePolicy.mjs';

// w148a (2026-09-29): the public manual once had 30 of 110 chapters with zero images even though the
// release check passed (rules/06 §10.148-era gap: it only compared an already-referenced image against
// the capture registry, never asked whether a chapter needing an image had one at all). These tests are
// the machine record of the fix: today's real chapters must satisfy the policy, and a chapter with its
// only image removed must fail it.

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const chapterFolder = join(root, 'packages/help-content/docs/ja');

function readRealChapters(): { name: string; text: string }[] {
  return readdirSync(chapterFolder, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => ({ name: entry.name, text: readFileSync(join(chapterFolder, entry.name), 'utf8') }));
}

describe('scripts/manual/chapterImagePolicy.mjs', () => {
  it('passes every current chapter (110) with the recorded exemption lists, and reports the known exceptions', () => {
    const chapters = readRealChapters();
    expect(chapters.length).toBe(110);
    const result = checkChapterImagePolicy(chapters);
    expect(result.problems).toEqual([]);
    expect(result.chapters).toBe(110);
    expect(new Set(result.openExceptions.map(entry => entry.id))).toEqual(new Set(Object.keys(KNOWN_EXCEPTIONS)));
  });

  it('does not silently pass a chapter that never links an image and is absent from both exemption lists', () => {
    const chapters = [{ name: 'made-up-chapter.md', text: '# 見出し\n\n本文だけで画像への参照が無い章。' }];
    const result = checkChapterImagePolicy(chapters, { requireFullCoverage: false });
    expect(result.problems).toEqual(['画像が要る章に画像が無い: made-up-chapter（made-up-chapter.md）']);
  });

  it('fails a real, currently-illustrated chapter once its only image link is removed (regression guard)', () => {
    const illustrated = readRealChapters().find(chapter => {
      const id = chapter.name.slice(0, -3);
      if (Object.hasOwn(NO_IMAGE_NEEDED, id) || Object.hasOwn(KNOWN_EXCEPTIONS, id)) return false;
      return /!\[[^\]]*\]\([^\s)]+\)/u.test(chapter.text);
    });
    expect(illustrated).toBeDefined();
    const strippedText = illustrated!.text.replaceAll(/!\[[^\]]*\]\([^\s)]+\)\n?/gu, '');
    expect(strippedText).not.toMatch(/!\[[^\]]*\]\(/u);
    const before = checkChapterImagePolicy([illustrated!], { requireFullCoverage: false });
    expect(before.problems).toEqual([]);
    const after = checkChapterImagePolicy([{ name: illustrated!.name, text: strippedText }], { requireFullCoverage: false });
    expect(after.problems).toEqual([`画像が要る章に画像が無い: ${illustrated!.name.slice(0, -3)}（${illustrated!.name}）`]);
  });

  it('fails when an exemption list entry names a chapter that no longer exists (full-coverage mode, the generate.mjs default)', () => {
    const chapters = [{ name: 'sketch-and-functions.md', text: '![x](images/x.png)' }];
    const result = checkChapterImagePolicy(chapters);
    const staleEntries = Object.keys(NO_IMAGE_NEEDED).length + Object.keys(KNOWN_EXCEPTIONS).length;
    expect(result.problems.length).toBe(staleEntries);
    expect(result.problems.every(problem => problem.startsWith('一覧が古い（章が無くなった）:'))).toBe(true);
  });

  it('does not report stale entries for a partial chapter set when requireFullCoverage is false', () => {
    const chapters = [{ name: 'sketch-and-functions.md', text: '![x](images/x.png)' }];
    const result = checkChapterImagePolicy(chapters, { requireFullCoverage: false });
    expect(result.problems).toEqual([]);
  });

  it('reports every KNOWN_EXCEPTIONS entry with a non-empty reason, deadline and note', () => {
    for (const [id, entry] of Object.entries(KNOWN_EXCEPTIONS)) {
      expect(typeof id).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.deadline.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });
});
