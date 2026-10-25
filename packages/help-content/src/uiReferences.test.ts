import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveHelpUiReferences } from './uiReferences.js';
import { HELP_TOPICS } from './topics.js';

describe('説明と画面で同じ操作名を使う', () => {
  it('点をつなぐ実章とキー説明は実操作名を解決し、目録の章名を保つ', () => {
    const labels: unknown = JSON.parse(readFileSync(new URL('../../ui/src/i18n/ja/commands.json', import.meta.url), 'utf8'));
    if (typeof labels !== 'object' || labels === null) throw new Error('Invalid actual command labels');
    const connect: unknown = Reflect.get(labels, 'command.sketch.connectPoints');
    const face: unknown = Reflect.get(labels, 'command.sketch.faceFromPoints');
    if (typeof connect !== 'string' || typeof face !== 'string') throw new Error('Missing actual point command labels');
    for (const id of ['sketch-tools', 'shortcuts', 'canvas']) {
      const topic = HELP_TOPICS.find(item => item.id === id);
      if (topic === undefined) throw new Error(`Missing actual topic: ${id}`);
      const body = readFileSync(new URL(`../${topic.path}`, import.meta.url), 'utf8');
      expect(body.split(/\r?\n/u)[0].trim()).toBe(`# ${topic.title}`);
      if (id !== 'canvas') {
        const references = body.match(/\{\{ui:command\.sketch\.(?:connectPoints|faceFromPoints)\}\}/gu);
        expect(references).not.toBeNull();
        for (const reference of references ?? []) {
          expect(resolveHelpUiReferences(reference, { 'command.sketch.connectPoints': connect, 'command.sketch.faceFromPoints': face }))
            .toBe(reference.includes('connectPoints') ? connect : face);
        }
      } else {
        expect(body).toContain('画像を取り消しで戻す例');
        expect(body).toContain('削除した画像を保存しない例');
        expect(body).toContain('「表示」を切るだけの場合は、画像を残して保存します');
      }
    }
  });
  it('本文の複数の参照を実際の文言から解決する', () => {
    expect(resolveHelpUiReferences('「{{ui:point.search}}」の後で「{{ui:point.apply}}」。',
      { 'point.search': '候補を探す', 'point.apply': '選んだ点を作成' })).toBe('「候補を探す」の後で「選んだ点を作成」。');
  });

  it('名前変更や欠落を曖昧な代替表示にせず拒否する', () => {
    for (const source of ['{{ui:missing}}', '{{ui:constructor}}', '{{ui:point.search', '{{ui: }}']) {
      expect(() => resolveHelpUiReferences(source, {})).toThrow(/help UI reference/u);
    }
    expect(() => resolveHelpUiReferences('{{ui:point.search}}', { 'point.search': '' })).toThrow('Invalid help UI label');
  });

  it('操作名の記号をMarkdownのリンクや見出しへ読み替えない', () => {
    expect(resolveHelpUiReferences('{{ui:label}}', { label: '[開く](https://example.com) *太字*' }))
      .toBe('\\[開く\\]\\(https://example\\.com\\) \\*太字\\*');
    expect(() => resolveHelpUiReferences('{{ui:label}}', { label: '次へ\n# 新しい節' })).toThrow('Invalid help UI label');
  });
});
