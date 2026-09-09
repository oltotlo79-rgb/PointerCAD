import { describe, expect, it } from 'vitest';
import { hatchStyle } from './hatchStyle.js';

describe('部品ごとのハッチング', () => {
  it('0番は45度・3mm', () => expect(hatchStyle(0)).toEqual({ angleRad: Math.PI / 4, pitchMm: 3 }));
  it('1番は135度・3mm', () => expect(hatchStyle(1)).toEqual({ angleRad: 3 * Math.PI / 4, pitchMm: 3 }));
  it('2番は45度・3.75mm', () => expect(hatchStyle(2)).toEqual({ angleRad: Math.PI / 4, pitchMm: 3.75 }));
  it('負の番号は0番として扱う', () => expect(hatchStyle(-1)).toEqual(hatchStyle(0)));
});
