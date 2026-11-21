/**
 * 生成物(手で直さない): 資料 2 の長物(断面の外形の幅と高さ・単位質量・切り売りの範囲がそろうフレーム)のうち、40 回目の独立の読み 2 本で
 * 一致した欄の行の表。担当の道具 make_b2_long_rows.py が書いた(照らす側の読みの文字は fixture `pipeLongPartOracle.fixture.json`)。
 * 製造元の名前・型番・品名は書かない(呼びは種類の一般の語と断面の外形)。色だけ違う型番は 1 行にまとめた。
 */
import type { LongPartRecord } from '../longPartFamily.js';

export const PIPE_LONG_PART_RECORDS: readonly LongPartRecord[] = [
  { key: 'b2-long-attachment-9x62', size: '取付けの形材 9×62（外形を包む形・アルミ）', page: 60, kind: '取付けの形材', material: 'aluminum',
    width: 9, height: 62, unitMassKgPerM: 0.84, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-fin-24x35', size: '羽つきのフレーム 24×35（外形を包む形・アルミ）', page: 286, kind: '羽つきのフレーム', material: 'aluminum',
    width: 24, height: 35, unitMassKgPerM: 0.4, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-fin-30.5x50', size: '羽つきのフレーム 30.5×50（外形を包む形・アルミ）', page: 59, kind: '羽つきのフレーム', material: 'aluminum',
    width: 30.5, height: 50, unitMassKgPerM: 0.65, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-fin-33x50', size: '羽つきのフレーム 33×50（外形を包む形・アルミ）', page: 59, kind: '羽つきのフレーム', material: 'aluminum',
    width: 33, height: 50, unitMassKgPerM: 0.63, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-leg-28x43', size: '脚つきのフレーム 28×43（外形を包む形・アルミ）', page: 61, kind: '脚つきのフレーム', material: 'aluminum',
    width: 28, height: 43, unitMassKgPerM: 0.61, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-rack-beam-43x43-0.86', size: '棚の梁の形材 43×43・0.86 kg/m（外形を包む形・アルミ）', page: 322, kind: '棚の梁の形材', material: 'aluminum',
    width: 43, height: 43, unitMassKgPerM: 0.86, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-rack-beam-43x43-0.97', size: '棚の梁の形材 43×43・0.97 kg/m（外形を包む形・アルミ）', page: 322, kind: '棚の梁の形材', material: 'aluminum',
    width: 43, height: 43, unitMassKgPerM: 0.97, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-rail-12.5x35', size: '取付けレールの形材 12.5×35（外形を包む形・アルミ）', page: 60, kind: '取付けレールの形材', material: 'aluminum',
    width: 12.5, height: 35, unitMassKgPerM: 0.25, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-rail-frame-35.5x35', size: '取付けレールつきのフレーム 35.5×35（外形を包む形・アルミ）', page: 60, kind: '取付けレールつきのフレーム', material: 'aluminum',
    width: 35.5, height: 35, unitMassKgPerM: 0.53, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-roller-guide-40x98', size: 'ローラーのガイドのフレーム 40×98（外形を包む形・アルミ）', page: 126, kind: 'ローラーのガイドのフレーム', material: 'aluminum',
    width: 40, height: 98, unitMassKgPerM: 1.86, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-roller-slider-15x63', size: 'ローラーのスライダのフレーム 15×63（外形を包む形・アルミ）', page: 303, kind: 'ローラーのスライダのフレーム', material: 'aluminum',
    width: 15, height: 63, unitMassKgPerM: 0.99, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-slot-arm-28x52', size: '溝つきの張り出しのフレーム 28×52（外形を包む形・アルミ）', page: 61, kind: '溝つきの張り出しのフレーム', material: 'aluminum',
    width: 28, height: 52, unitMassKgPerM: 0.69, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
  { key: 'b2-long-triple-119x119', size: '3 本つなぎのフレーム 119×119（外形を包む形・アルミ）', page: 285, kind: '3 本つなぎのフレーム', material: 'aluminum',
    width: 119, height: 119, unitMassKgPerM: 1.26, maxLength: 4000, simplified: ['断面の外形を包む形で、輪・羽・溝・中空などの断面の形は作っていない'] },
];
