import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { InputCapturePad } from './InputCapturePad.js';
import { DEFAULT_VIEW_CONTROLS, type ViewAction } from './viewControlSettings.js';

/* 設計 §6.2・B-08h: 取り込みの枠。マウスとキーは枠の中で取り込み、タッチの指の操作は枠の外の選択肢から足す。 */
const render = (action: ViewAction): string => renderToStaticMarkup(<InputCapturePad action={action} actionLabel={t(`settings.camera.${action}`)}
  labelOf={owner => owner} value={DEFAULT_VIEW_CONTROLS} onPlace={() => {}} onCancel={() => {}} />);

describe('取り込みの枠のタッチの指の操作', () => {
  it('その操作に使える指の操作だけを、説明つきのボタンで枠の外に出す', () => {
    const pan = render('pan');
    expect(pan).toContain(`role="group" aria-label="${t('settings.camera.capture.touch')}"`);
    expect(pan).toContain(`>${t('settings.camera.touch.oneFinger')}</button>`);
    expect(pan).toContain(`>${t('settings.camera.touch.twoFinger')}</button>`);
    expect(pan).not.toContain(`>${t('settings.camera.touch.pinch')}</button>`);
    expect(pan).toContain(`title="${t('settings.camera.capture.touchGuide').replace('{input}', t('settings.camera.touch.twoFinger'))}"`);
    const zoom = render('zoom');
    expect(zoom).toContain(`>${t('settings.camera.touch.pinch')}</button>`);
    expect(zoom).not.toContain(`>${t('settings.camera.touch.oneFinger')}</button>`);
    // 枠(取り込みの場所)の中には置かない(枠の中の左クリックは取り込みに使う)。
    const zone = /<div class="pcad-camera-settings__capture-zone"[\s\S]*?<\/div>/u.exec(pan)?.[0] ?? '';
    expect(zone).not.toContain(t('settings.camera.touch.twoFinger'));
    expect(pan).not.toContain('role="alert"');
  });
});
