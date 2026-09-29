import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_UNUSED_CAPTURE_NAMES, checkUnusedCaptureNames } from '../../../../scripts/manual/unusedCaptureNames.mjs';

// w148a (2026-09-29): report-only guard for scripted captures (`captureManualDetail(` in
// e2e/tests/*Flow.ts) whose name no chapter image references. Decision recorded in
// scripts/manual/unusedCaptureNames.mjs: report, do not fail the release check.

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const flowDir = join(root, 'e2e/tests');
const chapterDir = join(root, 'packages/help-content/docs/ja');

function readFlowSources(): { path: string; text: string }[] {
  return readdirSync(flowDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('Flow.ts'))
    .map(entry => ({ path: entry.name, text: readFileSync(join(flowDir, entry.name), 'utf8') }));
}
function readChapters(): { name: string; text: string }[] {
  return readdirSync(chapterDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => ({ name: entry.name, text: readFileSync(join(chapterDir, entry.name), 'utf8') }));
}

describe('scripts/manual/unusedCaptureNames.mjs', () => {
  it('separates today\'s orphaned capture names into the recorded known list and newly found ones', () => {
    const result = checkUnusedCaptureNames(readFlowSources(), readChapters());
    expect(result.flowFiles).toBeGreaterThan(0);
    // Every recorded known name must still actually be orphaned; a fixed one must be removed, not left stale.
    expect(result.staleKnownEntries).toEqual([]);
    expect(new Set(result.known.map(entry => entry.name))).toEqual(new Set(Object.keys(KNOWN_UNUSED_CAPTURE_NAMES)));
    expect(result.unused.length).toBe(result.known.length + result.newlyFound.length);
    for (const entry of result.known) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it('finds an orphan when a capture name is used only by a made-up flow and no chapter links it', () => {
    const flow = { path: 'madeUpFlow.ts', text: "await captureManualDetail(page, info, { name: 'made-up-orphan-capture', dialog });" };
    const chapters = [{ name: 'x.md', text: '本文だけの章、画像は無い。' }];
    const result = checkUnusedCaptureNames([flow], chapters);
    expect(result.unused).toEqual(['made-up-orphan-capture']);
    expect(result.newlyFound).toEqual(['made-up-orphan-capture']);
  });

  it('does not flag a capture name a chapter actually references', () => {
    const flow = { path: 'madeUpFlow.ts', text: "await captureManualDetail(page, info, { name: 'adopted-capture', dialog });" };
    const chapters = [{ name: 'x.md', text: '![説明](images/adopted-capture-detail.png)' }];
    const result = checkUnusedCaptureNames([flow], chapters);
    expect(result.unused).toEqual([]);
  });

  it('counts a dynamic (non-literal) capture name as an unresolved call rather than silently dropping it', () => {
    const flow = { path: 'dynamicFlow.ts', text: 'await captureManualDetail(page, info, { name: `cam-${format}-handoff`, dialog });' };
    const result = checkUnusedCaptureNames([flow], []);
    expect(result.unresolvedCalls).toEqual([{ path: 'dynamicFlow.ts', calls: 1, literalNames: 0 }]);
  });
});
