import { HELP_TOPICS, resolveHelpUiReferences } from '@pointercad/help-content';
import { describe, expect, it } from 'vitest';
import commands from '../i18n/ja/commands.json';
import { HELP_RAW_MARKDOWN } from './helpContent.js';

describe('説明と画面で同じ操作名を使う', () => {
  it('点をつなぐ実章とキー説明は実操作名を解決し、目録の章名を保つ', async () => {
    const labels: unknown = commands;
    if (typeof labels !== 'object' || labels === null) throw new Error('Invalid actual command labels');
    const connect: unknown = Reflect.get(labels, 'command.sketch.connectPoints');
    const face: unknown = Reflect.get(labels, 'command.sketch.faceFromPoints');
    if (typeof connect !== 'string' || typeof face !== 'string') throw new Error('Missing actual point command labels');
    for (const id of ['sketch-tools', 'shortcuts', 'canvas']) {
      const topic = HELP_TOPICS.find(item => item.id === id);
      if (topic === undefined) throw new Error(`Missing actual topic: ${id}`);
      const loader = HELP_RAW_MARKDOWN[`../../../help-content/${topic.path}`];
      if (loader === undefined) throw new Error(`Help document is missing: ${topic.path}`);
      const body = await loader();
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
});
