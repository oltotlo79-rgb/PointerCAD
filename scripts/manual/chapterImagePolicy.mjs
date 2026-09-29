/**
 * Which manual chapters (packages/help-content/docs/ja/*.md) must show at least one current-version
 * image, and which are deliberately exempt.
 *
 * Background (w148a, 2026-09-29): the public manual had 30 of 110 chapters with zero images even
 * though the capture scripts existed; the release check (scripts/release/releaseReadiness.mjs, the
 * four NFR-MA-6 conditions) only compares an image already referenced by a chapter against the
 * capture registry ("is the referenced image today's version?"). It never asked "does this chapter
 * that needs an image have one at all?", so the gap passed. This module is the machine record of
 * that decision, one chapter at a time, and `checkChapterImages.mjs` enforces it.
 *
 * Two kinds of exemption:
 * - NO_IMAGE_NEEDED: the chapter does not walk through screen operation (a license text, a reference
 *   table, an installer step outside PointerCAD's own screen). No image is ever required here.
 * - KNOWN_EXCEPTIONS: the chapter does describe screen operation and normally needs an image, but a
 *   recorded, still-open reason keeps it from having one today. Each entry names the reason and who
 *   decided it; `checkChapterImages.mjs` still passes these chapters, but reports them separately so
 *   the exception stays visible instead of quietly looking like "no image needed".
 *
 * A chapter absent from both lists must have at least one `![...](images/...)` link, or the check
 * fails. A chapter present in either list that no longer exists among the current *.md files also
 * fails (stale entry), so the lists cannot silently drift from the real chapter set.
 */

const deepFreeze = value => {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

/** Chapters that never walk through the application's own screen, so no capture applies. */
export const NO_IMAGE_NEEDED = deepFreeze({
  'component-licenses': '使っている部品の許諾原文の一覧。画面の操作を説明しない（原文の同梱先の表だけ）。',
  'font-licenses': '字体・解析ライブラリの許諾原文の一覧。画面の操作を説明しない。',
  'math-symbols': '構造化した数式で使える記号・演算の一覧表。個々の操作手順ではなく記号の対応表であり、'
    + '各行から誘導する math-input.md 側で入力操作の画像を示す。',
  'desktop-install': 'Windows・Linuxのインストーラー／ポータブル版の導入・更新・削除の手順。'
    + 'PointerCAD自身の画面ではなくOS標準のインストーラー・ファイルマネージャーの操作であり、'
    + 'OSごとに複数の外部画面を保守し続けることになるため対象外とする。',
});

/**
 * Chapters that do describe PointerCAD's own screen and normally need an image, but currently have
 * none for a recorded reason. Still passes the guard (does not fail the release check), but is
 * reported as an open exception every time. `deadline` is a short plain-language note, not a hard date
 * when none is decided yet; `note` records who/when decided the deferral.
 */
export const KNOWN_EXCEPTIONS = deepFreeze({
  'mass-properties': {
    reason: '質量特性の表示に製品側の不具合があり、正しい画面を撮影できるまで見送っている（利用者へ報告済みの既知の不具合）。',
    deadline: '製品側の不具合の修正後、次の撮影の機会に解消する（公開前に再検討する）。',
    note: '指示書 w148a（2026-09-29）で期限付きの既知の例外として記録。',
  },
  'web-version': {
    reason: 'Web版は後日公開のため、確実に撮影できる手順がまだ無い（公開先が決まっていない）。',
    deadline: 'Web版の公開前の撮り直しで再検討する。',
    note: 'docs/報告記録.md 2026-09-28 08:38「見送り（確実な手順が無い）」に記録済み。',
  },
  'startup-checks': {
    reason: '「3D表示が出ない」状態を確実に再現する手順がまだ無い（障害の注入が必要で、通常の撮影台本と揃わない）。',
    deadline: '公開前の撮り直しで再検討する。',
    note: 'docs/報告記録.md 2026-09-28 08:38「見送り（確実な手順が無い）」に記録済み。',
  },
  'offline-use': {
    reason: '通信の状態（取得の進み具合・完了表示）に依存する画面で、確実に同じ状態を再現する撮影手順がまだ無い。',
    deadline: '公開前の撮り直しで再検討する。',
    note: '指示書 w148a（2026-09-29）で startup-checks・web-version と同種の理由により記録。',
  },
});

export function isExemptChapter(id) {
  return Object.hasOwn(NO_IMAGE_NEEDED, id) || Object.hasOwn(KNOWN_EXCEPTIONS, id);
}

const IMAGE_LINK = /!\[[^\]]*\]\(([^\s)]+)\)/gu;

/**
 * Check one set of chapters (as scripts/manual/captureRegistry.mjs's readCaptureFolder returns them:
 * `{ name, text }` with `name` like `pattern.md`). Returns problems (a chapter needing an image has
 * none) and the still-open exceptions.
 *
 * `requireFullCoverage: true` (the default; generate.mjs and the tests that read every real chapter use
 * it) also fails when an exemption list entry names a chapter id absent from `chapters` — a stale entry
 * the exemption lists must not silently keep once a chapter is renamed or removed. Callers that
 * deliberately pass a partial or synthetic chapter set (unit tests exercising one made-up chapter) must
 * pass `requireFullCoverage: false`, or every real exemption not present in their small input would be
 * reported as "stale" even though nothing changed.
 */
export function checkChapterImagePolicy(chapters, { requireFullCoverage = true } = {}) {
  const problems = [];
  const seen = new Set();
  const openExceptions = [];
  for (const { name, text } of chapters) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -'.md'.length);
    seen.add(id);
    const count = [...text.matchAll(IMAGE_LINK)].length;
    if (Object.hasOwn(NO_IMAGE_NEEDED, id)) {
      continue; // Never required, regardless of the current count.
    }
    if (Object.hasOwn(KNOWN_EXCEPTIONS, id)) {
      openExceptions.push({ id, images: count, ...KNOWN_EXCEPTIONS[id] });
      continue; // Passes today; reported so the exception stays visible.
    }
    if (count === 0) problems.push(`画像が要る章に画像が無い: ${id}（${name}）`);
  }
  if (requireFullCoverage) {
    for (const id of Object.keys(NO_IMAGE_NEEDED)) {
      if (!seen.has(id)) problems.push(`一覧が古い（章が無くなった）: NO_IMAGE_NEEDED の ${id}`);
    }
    for (const id of Object.keys(KNOWN_EXCEPTIONS)) {
      if (!seen.has(id)) problems.push(`一覧が古い（章が無くなった）: KNOWN_EXCEPTIONS の ${id}`);
    }
  }
  return { problems, openExceptions, chapters: seen.size };
}
