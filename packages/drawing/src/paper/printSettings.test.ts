import { describe, expect, it } from 'vitest';
import { PAPER_SIZES } from './paperSize.js';
import { drawingPrintOptions, readDrawingPrintOptions } from './printSettings.js';

describe('印刷IPCへ渡す用紙設定', () => {
  it.each(PAPER_SIZES)('$idを同じ実寸で往復する', (paper) => {
    const options = drawingPrintOptions(paper.id, 2);
    expect(options).toMatchObject({ widthMm: paper.width, heightMm: paper.height, pageSize: paper.series,
      landscape: paper.orientation === 'landscape', copies: 2 });
    expect(readDrawingPrintOptions(options)).toEqual(options);
  });
  it.each([null, true, [], {}, { kind: 'drawing' }])('不足した入力%jを拒否する', (value) => { expect(readDrawingPrintOptions(value)).toBeNull(); });
  it('向きと寸法が食い違う設定を拒否する', () => {
    expect(readDrawingPrintOptions({ ...drawingPrintOptions('A3-landscape'), landscape: false })).toBeNull();
    expect(readDrawingPrintOptions({ ...drawingPrintOptions('A3-landscape'), widthMm: 297 })).toBeNull();
  });
  it.each([0, -1, 1.5, 1000, Infinity, NaN])('不正な部数%sを受け口でも拒否する', (copies) => {
    expect(readDrawingPrintOptions({ ...drawingPrintOptions('A4-portrait'), copies })).toBeNull();
  });
  it('任意のプリンター名や無確認印刷を透過しない', () => {
    const base = drawingPrintOptions('A4-portrait');
    const result = readDrawingPrintOptions({ ...base, silent: true, deviceName: 'unexpected', pageSize: 'A4' });
    expect(result).toEqual(base); expect(result).not.toHaveProperty('silent'); expect(result).not.toHaveProperty('deviceName');
  });
});
