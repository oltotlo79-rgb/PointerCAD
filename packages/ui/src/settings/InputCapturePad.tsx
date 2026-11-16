import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { viewTriggerOwner } from './inputBindingsDraft.js';
import { captureViewInput, captureViewKey, captureViewTouch, viewTriggerLabel, type CapturedViewInput } from './inputCapture.js';
import {
  VIEW_TOUCH_GESTURE_ACTIONS, VIEW_TOUCH_GESTURES, type ViewAction, type ViewControlSettings, type ViewTrigger,
} from './viewControlSettings.js';

/** 取り込んだ入力の入れ方: 空いていればそのまま、ほかの操作に使われていれば入れ替えるか、あちらを外す。 */
export type CapturePlacement = 'place' | 'swap' | 'take';

/**
 * 取り込みの枠(設計 §6.2)。枠の中でマウスのボタンを押す・ホイールを回すと、その入力を見せ、ほかの操作に使われていれば
 * 相手の名前と「入れ替える」「あちらを外して使う」を出す。ボタンは枠の外に置く(ボタンを押す左クリックを取り込まない)。
 * 中ボタンの自動スクロール・右ボタンのメニュー・ホイールの画面送りは、枠の中では止める。Esc でやめる。
 */
export function InputCapturePad({ action, actionLabel, labelOf, value, onPlace, onCancel }: {
  readonly action: ViewAction;
  readonly actionLabel: string;
  /** 操作の名前(相手の表示)。 */
  readonly labelOf: (action: ViewAction) => string;
  readonly value: ViewControlSettings;
  readonly onPlace: (placement: CapturePlacement, trigger: ViewTrigger) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [captured, setCaptured] = useState<CapturedViewInput | null>(null);
  /** 押したキーの組がこの操作に使えなかった(B-08)。 */
  const [keyRefused, setKeyRefused] = useState(false);
  /** 選んだ指の操作を、この操作のタッチの割当が上限(2 つ)なので足せなかった(B-08h)。 */
  const [touchRefused, setTouchRefused] = useState(false);
  const choose = (next: CapturedViewInput | null): void => { setCaptured(next); setKeyRefused(false); setTouchRefused(false); };
  const zoneRef = useRef<HTMLDivElement>(null);
  useEffect(() => { zoneRef.current?.focus(); }, []);
  // React のホイールの受け口は画面送りを止められない(passive)ので、枠にだけ直接つなぐ。
  useEffect(() => {
    const zone = zoneRef.current;
    if (zone === null) return;
    const onWheel = (event: WheelEvent): void => { event.preventDefault(); event.stopPropagation(); setCaptured(captureViewInput(event)); setKeyRefused(false); setTouchRefused(false); };
    zone.addEventListener('wheel', onWheel, { passive: false });
    return () => { zone.removeEventListener('wheel', onWheel); };
  }, []);
  const trigger = captured?.status === 'captured' ? captured.trigger : null;
  const owner = trigger === null ? null : viewTriggerOwner(value, trigger, action);
  return <div className="pcad-camera-settings__capture">
    <div className="pcad-camera-settings__capture-zone" role="group" aria-label={t('settings.camera.capture.pad')} tabIndex={0} ref={zoneRef}
      title={t('settings.camera.capture.body').replace('{action}', actionLabel)}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); choose(captureViewInput(event.nativeEvent)); }}
      onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
      onContextMenu={event => { event.preventDefault(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
        const key = captureViewKey(event.nativeEvent, action);
        if (key.status === 'ignored') return;
        event.preventDefault(); event.stopPropagation();
        choose(key.status === 'captured' ? key : null); setKeyRefused(key.status === 'refused');
      }}>
      <strong>{t('settings.camera.capture.title')}</strong>
      <p>{t('settings.camera.capture.body').replace('{action}', actionLabel)}</p>
      {captured?.status === 'refused' ? <p role="alert">{t('settings.camera.capture.leftNeedsAlt')}</p> : null}
      {keyRefused ? <p role="alert">{t('settings.camera.capture.keyNotForAction').replace('{action}', actionLabel)}</p> : null}
      {touchRefused ? <p role="alert">{t('settings.camera.capture.touchFull').replace('{action}', actionLabel)}</p> : null}
      {trigger === null ? null : <p role="status">{t('settings.camera.capture.current').replace('{input}', viewTriggerLabel(trigger))}{' '}
        {owner === null ? t('settings.camera.capture.free') : t('settings.camera.capture.used').replace('{action}', labelOf(owner))}</p>}
    </div>
    {/* タッチの指の操作(B-08h)。枠の中の左クリックは取り込みに使うので、選択肢は枠の外に置く。触れる画面が無くても選べる。 */}
    <div className="pcad-camera-settings__actions" role="group" aria-label={t('settings.camera.capture.touch')}>
      {VIEW_TOUCH_GESTURES.filter(gesture => VIEW_TOUCH_GESTURE_ACTIONS[gesture].includes(action)).map(gesture => {
        const label = viewTriggerLabel({ kind: 'touch', gesture, alt: false, shift: false, ctrl: false, meta: false });
        return <button key={gesture} type="button" className="pcad-button" title={t('settings.camera.capture.touchGuide').replace('{input}', label)}
          onClick={() => {
            const result = captureViewTouch(value, action, gesture);
            choose(result.status === 'captured' ? result : null);
            setTouchRefused(result.status === 'refused');
          }}>{label}</button>;
      })}
    </div>
    <div className="pcad-camera-settings__actions">
      {trigger !== null && owner === null ? <button type="button" className="pcad-button" title={t('settings.camera.capture.useGuide')}
        onClick={() => { onPlace('place', trigger); }}>{t('settings.camera.capture.use')}</button> : null}
      {trigger !== null && owner !== null ? <>
        <button type="button" className="pcad-button" title={t('settings.camera.capture.swapGuide')}
          onClick={() => { onPlace('swap', trigger); }}>{t('settings.camera.capture.swap')}</button>
        <button type="button" className="pcad-button" title={t('settings.camera.capture.takeGuide')}
          onClick={() => { onPlace('take', trigger); }}>{t('settings.camera.capture.take')}</button>
      </> : null}
      <button type="button" className="pcad-button" title={t('settings.camera.capture.cancelGuide')} onClick={onCancel}>
        {t('settings.camera.capture.cancel')}</button>
    </div>
  </div>;
}
