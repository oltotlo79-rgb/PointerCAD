import { describe, expect, it } from 'vitest';
import { adjacentHelpTopics, initialHelpHistory, stepHelpHistory, visitHelp } from './navigation.js';

describe('ヘルプと説明書の閲覧位置', () => {
  it('別章と同じ章のアンカーを往復し、それぞれの読んだ位置を保つ', () => {
    const first = initialHelpHistory('a');
    const second = visitHelp(first, { topicId: 'b', anchor: 'section', scrollTop: 0 }, 125);
    const third = visitHelp(second, { topicId: 'b', anchor: 'next', scrollTop: 0 }, 400);
    const back = stepHelpHistory(third, -1, 700);
    expect(back.visits[back.index]).toEqual({ topicId: 'b', anchor: 'section', scrollTop: 400 });
    const start = stepHelpHistory(back, -1, 450);
    expect(start.visits[start.index]).toEqual({ topicId: 'a', anchor: '', scrollTop: 125 });
    const forward = stepHelpHistory(start, 1, 150);
    expect(forward.visits[forward.index]).toEqual({ topicId: 'b', anchor: 'section', scrollTop: 450 });
    expect(first).toEqual(initialHelpHistory('a'));
  });
  it('戻って別章へ進むと古い進み先を破棄し、履歴を100件までに保つ', () => {
    let history = visitHelp(initialHelpHistory('a'), { topicId: 'b', anchor: '', scrollTop: 0 }, 0);
    history = visitHelp(stepHelpHistory(history, -1, 0), { topicId: 'c', anchor: '', scrollTop: 0 }, 0);
    expect(history.visits.map(visit => visit.topicId)).toEqual(['a', 'c']);
    expect(stepHelpHistory(history, 1, 0)).toBe(history);
    for (let index = 0; index < 120; index += 1) history = visitHelp(history, { topicId: String(index), anchor: '', scrollTop: 0 }, 0);
    expect(history.visits).toHaveLength(100); expect(history.index).toBe(99);
    expect(history.visits[0].topicId).toBe('20');
  });
  it('同じ位置を連打しても履歴を増やさず、不明な章を先頭へ誤接続しない', () => {
    const history = initialHelpHistory('a');
    expect(visitHelp(history, history.visits[0], 30)).toBe(history);
    expect(stepHelpHistory(history, -1, 0)).toBe(history);
    const topics = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(adjacentHelpTopics(topics, 'a')).toEqual({ previous: undefined, next: topics[1] });
    expect(adjacentHelpTopics(topics, 'b')).toEqual({ previous: topics[0], next: topics[2] });
    expect(adjacentHelpTopics(topics, 'c')).toEqual({ previous: topics[1], next: undefined });
    expect(adjacentHelpTopics(topics, 'missing')).toEqual({ previous: undefined, next: undefined });
  });
});
