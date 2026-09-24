import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
