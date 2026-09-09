import { useState } from 'react';
import type { Annotation, Point2 } from '@pointercad/drawing';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { saveDrawingNote } from './noteCommands.js';

export function DrawingNotePopover({ annotation, position = [80, 200], anchor }: {
  readonly annotation?: Annotation;
  readonly position?: Point2;
  readonly anchor?: Point2;
}): React.JSX.Element {
  const [text, setText] = useState(annotation?.text ?? '');
  const [height, setHeight] = useState(String(annotation?.height ?? 3.5));
  const [x, setX] = useState(String(annotation?.position[0] ?? position[0]));
  const [y, setY] = useState(String(annotation?.position[1] ?? position[1]));
  const [leader, setLeader] = useState(annotation?.kind === 'leaderNote');
  const [end, setEnd] = useState<'arrow' | 'dot'>(annotation?.leaderEnd ?? 'arrow');
  const [targetX, setTargetX] = useState(String(annotation?.leader?.[0]?.[0] ?? position[0] - 20));
  const [targetY, setTargetY] = useState(String(annotation?.leader?.[0]?.[1] ?? position[1] - 20));
  function apply(): void {
    const fields = leader ? [height, x, y, targetX, targetY] : [height, x, y];
    if (fields.some((value) => value.trim() === '' || !Number.isFinite(Number(value)))) {
      useAppStore.getState().setDrawingMessage(t('drawing.error.noteInvalid')); return;
    }
    saveDrawingNote({ ...(annotation === undefined ? {} : { id: annotation.id }), text, heightMm: Number(height),
      position: [Number(x), Number(y)], ...(leader ? { leader: { target: [Number(targetX), Number(targetY)], end } } : {}) });
  }
  return <form className="pcad-drawing-input" aria-label={t('drawing.note.title')}
    style={anchor === undefined ? undefined : { position: 'fixed', right: 'auto',
      left: Math.max(8, Math.min(anchor[0] + 12, window.innerWidth - 280)), top: Math.max(8, Math.min(anchor[1] + 12, window.innerHeight - 430)),
      maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation();
      const state = useAppStore.getState(); state.setDrawingTool('select'); state.selectDrawingIds([]); } }}
    onSubmit={(event) => { event.preventDefault(); apply(); }}>
    <strong>{t('drawing.note.title')}</strong>
    <label>{t('drawing.note.text')}<textarea aria-label={t('drawing.note.text')} value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={10000} autoFocus={annotation === undefined} /></label>
    <label>{t('drawing.note.height')}<input value={height} onChange={(event) => setHeight(event.target.value)} inputMode="decimal" /></label>
    <label>{t('drawing.note.x')}<input value={x} onChange={(event) => setX(event.target.value)} inputMode="decimal" /></label>
    <label>{t('drawing.note.y')}<input value={y} onChange={(event) => setY(event.target.value)} inputMode="decimal" /></label>
    <label><input type="checkbox" checked={leader} onChange={(event) => setLeader(event.target.checked)} />{t('drawing.note.leader')}</label>
    {leader ? <>
      <label>{t('drawing.note.targetX')}<input value={targetX} onChange={(event) => setTargetX(event.target.value)} inputMode="decimal" /></label>
      <label>{t('drawing.note.targetY')}<input value={targetY} onChange={(event) => setTargetY(event.target.value)} inputMode="decimal" /></label>
      <label>{t('drawing.note.end')}<select aria-label={t('drawing.note.end')} value={end} onChange={(event) => setEnd(event.target.value === 'dot' ? 'dot' : 'arrow')}>
        <option value="arrow">{t('drawing.note.arrow')}</option><option value="dot">{t('drawing.note.dot')}</option>
      </select></label>
    </> : null}
    <div><button type="submit" className="pcad-button">{t('drawing.action.apply')}</button>
      <button type="button" className="pcad-button" onClick={() => { const state = useAppStore.getState(); state.setDrawingTool('select'); state.selectDrawingIds([]); }}>{t('drawing.action.close')}</button></div>
  </form>;
}
