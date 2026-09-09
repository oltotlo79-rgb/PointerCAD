import { describe, expect, it } from 'vitest';

import { ja } from '../i18n/ja.js';
import { DRAWING_PROPERTY_KEYS, DRAWING_TOOL_GROUPS, DRAWING_TREE_KEYS } from './DrawingWorkspace.js';

const refusalMessages = [
  'もとにする部品を選んでください。',
  'この部品はこの用紙に入りません。用紙を大きくしてください。',
  'この縮尺では用紙からはみ出します。',
  'この形からは図を作れませんでした。',
  '図にできる立体がありません。',
  'この位置では切り口ができません。切断線を動かしてください。',
  'この円は図の外にあります。図の上に置いてください。',
  'この寸法のもとになった形が見つかりません。',
  'この組み合わせでは寸法を記入できません。',
  '平行な 2 本の間には角度を記入できません。距離を使ってください。',
  '寸法の数値は形から自動で決まります。',
  '上の許容差は下の許容差より大きくしてください。',
  'このはめあい記号は用意されていません。',
  'この図面はアセンブリを参照していません。',
  'この番号の部品が見つかりません。',
  '字体を読み込めませんでした。文字は表示されません。',
  'この大きさでは画像にできません。解像度を下げてください。',
  'PDF を作れませんでした。',
  '一部の要素は DXF に出せないため省きました(N 件)。',
  'もとのファイルが見つかりません。取り込んだ形で開いています。',
  'もとの部品が更新されています。取り込み直しますか。',
  'このレイヤーには N 個の要素があります。消すと要素も消えます。',
  '印刷する図面がありません。',
] as const;

describe('図面画面の5区画に入る内容', () => {
  it('木は5つの束を持つ', () => expect(DRAWING_TREE_KEYS).toHaveLength(5));
  it('ツールバーは図面の13道具を持つ', () => {
    expect(DRAWING_TOOL_GROUPS.flatMap((group) => group.tools)).toHaveLength(13);
  });
  it('プロパティは6つの節を持つ', () => expect(DRAWING_PROPERTY_KEYS).toHaveLength(6));
  it.each(refusalMessages)('断り文言を正本へ収録する: %s', (message) => {
    expect(Object.values(ja)).toContain(message);
  });
  it('表が入らない断りも収録する', () => {
    expect(ja['drawing.error.tableOverflow']).toBe('この表は用紙に入りません。列を減らすか用紙を大きくしてください。');
  });
});
