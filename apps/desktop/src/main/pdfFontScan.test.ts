import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scanPdf } from '../../../../scripts/manual/pdf_font_scan.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scriptPath = join(root, 'scripts/manual/pdf_font_scan.mjs');

interface ExecFileError {
  readonly status: number | null;
  readonly stdout?: string;
}

/** Run the CLI and return its exit status and stdout, whether it succeeds (exit 0) or throws (nonzero exit). */
function runCli(dir: string): { readonly status: number | null; readonly output: string } {
  try {
    return { status: 0, output: execFileSync('node', [scriptPath, dir], { encoding: 'utf8' }) };
  } catch (error) {
    const failure = error as ExecFileError;
    return { status: failure.status, output: failure.stdout ?? '' };
  }
}

/**
 * A minimal, hand-written PDF: one page whose content stream shows one string through font /F1.
 * scanPdf() finds objects by scanning "N 0 obj" / "endobj" textually (no xref table is parsed), so the
 * exact byte offsets below do not need to match a cross-reference table - only the object numbers used
 * by the `/…N 0 R` references have to agree.
 */
function handWrittenPdf(fontDict: string, toUnicodeCMap: string | undefined): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    fontDict,
    streamObject('BT /F1 12 Tf (A) Tj ET'),
  ];
  if (toUnicodeCMap !== undefined) objects.push(streamObject(toUnicodeCMap));
  let text = '%PDF-1.4\n';
  objects.forEach((body, index) => { text += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  text += '%%EOF';
  return Buffer.from(text, 'latin1');
}

function streamObject(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
}

const asciiAToA = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <0041>\nendbfchar\nendcmap\nend\nend';

describe('説明書PDFの非同梱字体の検査(scripts/manual/pdf_font_scan.mjs、依存追加なしのNode版)', () => {
  const tempDirs: string[] = [];
  afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const makeTempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'pcad-pdf-font-scan-')); tempDirs.push(dir); return dir; };

  it('PASS: 同梱の字体(Type3)だけで描いた文字は非同梱ゼロになる', () => {
    const pdf = handWrittenPdf('<< /Type /Font /Subtype /Type3 /ToUnicode 6 0 R >>', asciiAToA);
    const { pages, offenders } = scanPdf(pdf, (char) => char === 'A');
    expect(pages).toBe(1);
    expect(offenders.size).toBe(0);
  });

  it('FAIL: 名前付きの字体(OSの字体)へ落ちた文字を非同梱として検出する', () => {
    const pdf = handWrittenPdf('<< /Type /Font /Subtype /TrueType /BaseFont /Arial /ToUnicode 6 0 R >>', asciiAToA);
    const { pages, offenders } = scanPdf(pdf, () => true);
    expect(pages).toBe(1);
    expect(offenders.size).toBe(1);
    expect([...offenders.keys()]).toEqual(['Arial（同梱でない名前付きの字体）']);
    expect([...offenders.values()][0]?.chars).toEqual(new Set(['A']));
  });

  it('PDF無し: フォルダーにPDFが1つも無ければ終了コード2で拒否する(CLI全体)', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'not-a-pdf.txt'), 'no pdf here', 'utf8');
    const { status } = runCli(dir);
    expect(status).toBe(2);
  });

  it('CLI全体: 手書きのPASS用PDFを既定の同梱字体(NotoSansJP・説明書の字体)に対して流すとexit=0', () => {
    const dir = makeTempDir();
    // NotoSansJP・Noto Sans・Noto Sans Mathのいずれも 'A' を含むため、既定の同梱字体でPASSする。
    writeFileSync(join(dir, 'volume.pdf'), handWrittenPdf('<< /Type /Font /Subtype /Type3 /ToUnicode 6 0 R >>', asciiAToA));
    const { status, output } = runCli(dir);
    expect(status).toBe(0);
    expect(output).toContain('PASS');
  });

  it('CLI全体: 名前付きの字体だけのPDFはexit=1(job失敗)で拒否する', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'volume.pdf'), handWrittenPdf('<< /Type /Font /Subtype /TrueType /BaseFont /Arial /ToUnicode 6 0 R >>', asciiAToA));
    const { status, output } = runCli(dir);
    expect(status).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('Arial');
  });
});
