import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFileHash } from '../../../../scripts/release/desktopFileInventory.mjs';
import { captureWebBuildSources } from '../../../../scripts/vite/webBuildSources.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface FontRecord {
  readonly name: string;
  readonly style: string;
  readonly version: string;
  readonly file: string;
  readonly license: string;
  readonly notice: string;
  readonly sha256: string;
}
interface NoticeRecord {
  readonly file: string;
  readonly sha256: string;
}
interface FontNotices {
  readonly format: string;
  readonly fonts: readonly FontRecord[];
  readonly notices: readonly NoticeRecord[];
}

function readFontNotices(): FontNotices {
  return JSON.parse(readFileSync(join(root, 'docs/standards/licenses/font-notices.json'), 'utf8')) as FontNotices;
}

/**
 * Verify the recorded name/version/license/hash for each screen font, and for its notice file,
 * against the bytes `read` actually returns for Web's and Desktop's copy; throws on any drift
 * from the previously-approved version, or if Web and Desktop disagree. Pure with respect to
 * `read` so tampering can be simulated without touching the real, committed font/notice files -
 * this is the check P13-6's report said was missing (no hash pinned for a previously-reviewed
 * version, unlike the runtime/math/script-runtime notices).
 */
function verifyFontNotices(notices: FontNotices, read: (relativePath: string) => Uint8Array): void {
  if (notices.format !== 'pointercad-font-notices/1' || notices.fonts.length === 0) throw new Error('Font notices are incomplete');
  const checkPair = (relativeName: string, expectedSha256: string, label: string) => {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('Invalid font notice hash: ' + label);
    const web = Buffer.from(read(`apps/web/public/fonts/${relativeName}`));
    const desktop = Buffer.from(read(`apps/desktop/resources/fonts/${relativeName}`));
    if (!web.equals(desktop)) throw new Error('Web and desktop font asset differs: ' + label);
    if (sha256(web) !== expectedSha256) throw new Error('Screen font changed: ' + label);
  };
  for (const font of notices.fonts) checkPair(font.file, font.sha256, font.file);
  for (const notice of notices.notices) checkPair(notice.file, notice.sha256, notice.file);
}

describe('画面・図面用フォント(Noto Sans JP)の版と許諾原文のhashを固定する(P13-6b)', () => {
  const notices = readFontNotices();

  it('記録した名前・版・許諾が想定どおりで、実バイトがWeb/Desktopで一致し記録済みhashとも一致する', () => {
    expect(notices.fonts).toHaveLength(1);
    expect(notices.fonts[0]).toMatchObject({
      name: 'Noto Sans JP', style: 'Regular', version: 'Sans2.004', file: 'NotoSansJP-Regular.otf', license: 'OFL-1.1', notice: 'LICENSES.txt',
    });
    expect(notices.notices).toHaveLength(1);
    expect(() => verifyFontNotices(notices, (relativePath) => readFileSync(join(root, relativePath)))).not.toThrow();
  });

  it('同梱のライセンス原文がSPDXのOFL-1.1標準条文(ofl-1.1.txt)と一致する', () => {
    const bundled = readFileSync(join(root, 'apps/web/public/fonts/LICENSES.txt'), 'utf8');
    const reference = readFileSync(join(root, 'docs/standards/licenses/ofl-1.1.txt'), 'utf8');
    const body = (text: string) => text
      .slice(text.indexOf('SIL OPEN FONT LICENSE'), text.indexOf('OTHER DEALINGS IN THE FONT SOFTWARE.') + 'OTHER DEALINGS IN THE FONT SOFTWARE.'.length)
      .replace(/\s+/gu, ' ').trim();
    expect(body(bundled)).toBe(body(reference));
  });

  it('記録と異なる版のバイト列へ変わったら拒否する', () => {
    const tampered = new TextEncoder().encode('tampered font bytes');
    expect(() => verifyFontNotices(notices, (relativePath) => (relativePath.endsWith(notices.fonts[0].file) ? tampered : readFileSync(join(root, relativePath)))))
      .toThrow('Screen font changed');
  });

  it('WebとDesktopで内容が食い違ったら拒否する', () => {
    const targetFile = notices.fonts[0].file;
    let seenWeb = false;
    expect(() => verifyFontNotices(notices, (relativePath) => {
      const bytes = readFileSync(join(root, relativePath));
      if (!relativePath.endsWith(targetFile)) return bytes;
      if (!seenWeb) { seenWeb = true; return bytes; }
      const altered = Buffer.from(bytes);
      altered[0] ^= 1;
      return altered;
    })).toThrow('Web and desktop font asset differs');
  });

  it('壊れたhash形式や空の一覧を拒否する', () => {
    expect(() => verifyFontNotices({ ...notices, fonts: [] }, () => new Uint8Array())).toThrow('incomplete');
    expect(() => verifyFontNotices({ ...notices, fonts: [{ ...notices.fonts[0], sha256: 'zz' }] }, () => new Uint8Array())).toThrow('Invalid font notice hash');
  });
});

interface ManualFontRecord extends FontRecord {
  readonly source: string;
}
interface ManualNoticeRecord extends NoticeRecord {
  readonly source: string;
}
interface ManualFontNotices {
  readonly format: string;
  readonly fonts: readonly ManualFontRecord[];
  readonly notices: readonly ManualNoticeRecord[];
}

const MANUAL_FONT_FOLDER = 'scripts/manual/fonts';

function readManualFontNotices(): ManualFontNotices {
  return JSON.parse(readFileSync(join(root, MANUAL_FONT_FOLDER, 'font-notices.json'), 'utf8')) as ManualFontNotices;
}

/**
 * Verify the fonts used only by the manual (embedded by scripts/manual/generate.mjs) and their original OFL texts
 * against the recorded hashes. sourceFileHash keeps a font's bytes as they are and reads a notice the same from the
 * CRLF (Windows) and the LF (distribution CI) checkout, like the manual generator records its inputs.
 */
function verifyManualFontNotices(notices: ManualFontNotices, read: (relativePath: string) => Uint8Array): void {
  if (notices.format !== 'pointercad-font-notices/1' || notices.fonts.length === 0) throw new Error('Manual font notices are incomplete');
  const noticeFiles = new Set(notices.notices.map((notice) => notice.file));
  const check = (file: string, expectedSha256: string) => {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('Invalid manual font hash: ' + file);
    if (sourceFileHash(read(`${MANUAL_FONT_FOLDER}/${file}`)) !== expectedSha256) throw new Error('Manual font changed: ' + file);
  };
  for (const font of notices.fonts) {
    if (!noticeFiles.has(font.notice)) throw new Error('Manual font notice is missing: ' + font.file);
    check(font.file, font.sha256);
  }
  for (const notice of notices.notices) check(notice.file, notice.sha256);
}

const oflBody = (text: string) => text
  .slice(text.indexOf('SIL OPEN FONT LICENSE'), text.indexOf('OTHER DEALINGS IN THE FONT SOFTWARE.') + 'OTHER DEALINGS IN THE FONT SOFTWARE.'.length)
  .replace(/\s+/gu, ' ').trim();

describe('説明書だけで使う字体(Noto Sans・Noto Sans Math)の版と許諾原文のhashを固定する', () => {
  const notices = readManualFontNotices();
  const readReal = (relativePath: string) => readFileSync(join(root, relativePath));

  it('記録した名前・版・許諾・取得元が想定どおりで、実バイトが記録済みhashと一致する', () => {
    expect(notices.fonts.map((font) => ({ name: font.name, style: font.style, version: font.version, file: font.file, license: font.license, notice: font.notice })))
      .toEqual([
        { name: 'Noto Sans', style: 'Regular', version: '2.015', file: 'NotoSans-Regular.otf', license: 'OFL-1.1', notice: 'OFL-NotoSans.txt' },
        { name: 'Noto Sans Math', style: 'Regular', version: '3.000', file: 'NotoSansMath-Regular.otf', license: 'OFL-1.1', notice: 'OFL-NotoSansMath.txt' },
      ]);
    expect(notices.notices.map((notice) => notice.file)).toEqual(['OFL-NotoSans.txt', 'OFL-NotoSansMath.txt']);
    // Every source is pinned to one commit of the official Noto repositories, not to a moving branch.
    for (const record of [...notices.fonts, ...notices.notices]) {
      expect(record.source).toMatch(/^https:\/\/github\.com\/notofonts\/[a-z.-]+\/raw\/[a-f0-9]{40}\//u);
    }
    expect(() => verifyManualFontNotices(notices, readReal)).not.toThrow();
  });

  it('同梱した原文がSPDXのOFL-1.1標準条文と一致し、Reserved Font Nameを宣言していない', () => {
    const reference = oflBody(readFileSync(join(root, 'docs/standards/licenses/ofl-1.1.txt'), 'utf8'));
    for (const notice of notices.notices) {
      const text = readFileSync(join(root, MANUAL_FONT_FOLDER, notice.file), 'utf8');
      expect(oflBody(text)).toBe(reference);
      const header = text.slice(0, text.indexOf('SIL OPEN FONT LICENSE'));
      expect(header).toMatch(/^Copyright 2022 The Noto Project Authors \(https:\/\/github\.com\/notofonts\/[a-z-]+\)/u);
      expect(header).not.toMatch(/Reserved Font Name/iu);
    }
  });

  it('記録と異なる字体・欠けた原文を拒否し、原文の改行の違い(CRLF)だけは同じ内容として扱う', () => {
    const tampered = new TextEncoder().encode('tampered font bytes');
    expect(() => verifyManualFontNotices(notices, (relativePath) => (relativePath.endsWith(notices.fonts[1].file) ? tampered : readReal(relativePath))))
      .toThrow('Manual font changed');
    expect(() => verifyManualFontNotices({ ...notices, notices: notices.notices.slice(1) }, readReal)).toThrow('Manual font notice is missing');
    expect(() => verifyManualFontNotices({ ...notices, fonts: [] }, readReal)).toThrow('incomplete');
    const lf = String.fromCharCode(10), crlf = String.fromCharCode(13, 10);
    const withCrlf = (relativePath: string) => (relativePath.endsWith('.txt')
      ? Buffer.from(readFileSync(join(root, relativePath), 'utf8').replaceAll(crlf, lf).replaceAll(lf, crlf), 'utf8')
      : readReal(relativePath));
    expect(() => verifyManualFontNotices(notices, withCrlf)).not.toThrow();
  });

  it('manual.cssが記録した字体を読み、本文とcode・preの字体の列でNoto Sans JPの次に使う', () => {
    const css = readFileSync(join(root, 'scripts/manual/manual.css'), 'utf8');
    const families = ['PointerCAD Manual Latin', 'PointerCAD Manual Math'];
    for (const [index, font] of notices.fonts.entries()) {
      expect(css).toContain(`@font-face { font-family: "${families[index]}"; src: url("fonts/${font.file}") format("opentype");`);
    }
    expect(css).toContain(':root { color-scheme: light; font-family: "PointerCAD Manual", "PointerCAD Manual Latin", "PointerCAD Manual Math", "Yu Gothic", "Meiryo", sans-serif;');
    expect(css).toContain('code, pre { font-family: "PointerCAD Manual", "PointerCAD Manual Latin", "PointerCAD Manual Math", monospace; }');
  });

  it('アプリの入力(撮影の版の識別子の元)に入らない場所に置き、アプリの字体の置き場所へ写していない', async () => {
    const inputs = Object.keys(await captureWebBuildSources(root));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter((path) => path.startsWith('scripts/manual/'))).toEqual([]);
    for (const font of notices.fonts) {
      expect(existsSync(join(root, 'apps/web/public/fonts', font.file))).toBe(false);
      expect(existsSync(join(root, 'apps/desktop/resources/fonts', font.file))).toBe(false);
    }
  });
});
