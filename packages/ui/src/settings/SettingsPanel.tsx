import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';
import { useEffect, useRef, useState } from 'react';

import { t, type MessageKey } from '../i18n/t.js';
import { AutoSaveIntervalForm } from './AutoSaveIntervalForm.js';
import { GearIcon } from '../shell/icons.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  nearestUiScaleStep,
  nextThemeIndex,
  THEME_IDS,
  UI_SCALE_STEPS,
  type ThemeId,
} from './settings.js';
import { settingsCloseRequest, submitSettingsDrafts } from './settingsDrafts.js';
import { ToolDefaultsForm } from './ToolDefaultsForm.js';
import { ShortcutSettingsForm } from './ShortcutSettingsForm.js';
import { openTutorial } from '../tutorial/tutorialActions.js';
import { OfflineSettings } from './OfflineSettings.js';
import './settingsPanel.css';

/**
 * 設定。
 *
 * 対応要件: FR-908(表示テーマ 5 種)、FR-909(拡大率 90〜150%)。どちらも
 * **再起動なしに即時反映**で、選んだ内容は端末に残る(`settings.ts` が `localStorage` へ)。
 *
 * 作り: ツールバーの歯車 1 つと、その場に開く一覧。吸着の種別(`Toolbar.tsx` の
 * `SnapKindsMenu`)と同じ `.pcad-menu` の作りで、モーダルにしない(NFR-UX-2)ので
 * 開いている間も背後の作図と視点操作はそのまま効く。**固定の区画は増やさない**
 * (要件§7.1、rules/04-設計の規律.md)。
 *
 * 中身は畳める見出し(表示・操作の割り当て・自動保存・道具の初期値・その他)に分ける(UI/UX の点検の指摘 7)。
 * 視点の操作とキーの割り当ては「操作の割り当て」の 1 つの見出しの下に置く(後の操作の割り当ての窓が、
 * この見出しの中身を差し替える)。最初は全て開いている。
 *
 * 適用していない変更(下書き)がある間は、外を押す・Esc・歯車・チュートリアルで閉じない。閉じる代わりに
 * 窓の中で[適用して閉じる][捨てて閉じる][続ける]を出す(下書きを黙って捨てない。`settingsDrafts.ts`)。
 *
 * 開いているかどうかは見た目だけの一時状態なのでここでだけ持ち、テーマと拡大率の正本は
 * ストア(`displaySettings`)に置く(rules/04-設計の規律.md)。
 */

/** テーマの名前。5 種すべてを網羅していることを型で保つ。 */
const THEME_LABEL_KEYS: Readonly<Record<ThemeId, MessageKey>> = {
  dark: 'settings.theme.dark',
  light: 'settings.theme.light',
  darkModern: 'settings.theme.darkModern',
  lightModern: 'settings.theme.lightModern',
  modern: 'settings.theme.modern',
};

/** 拡大率の札(「100%」)。言葉に依らない書き方なので、ここで組み立てる。 */
const PERCENT_SIGN = '%';

function scaleLabel(step: number): string {
  return `${String(step)}${PERCENT_SIGN}`;
}

/**
 * テーマ 1 種ぶんの見本。**画面の縮図**(上の帯=ツールバー、左の柱=区画、残り=3D 表示)を
 * そのテーマの色で描く。縮図には `data-theme` を付けてあり、`appShell.css` の
 * `[data-theme="…"]` がこの中だけで効く(色を JS 側へ写し取らないので、CSS を直せば
 * 見本もそのまま変わる)。絵の意味は下の名前が担うので、読み上げの対象にしない。
 */
function ThemePreview({ theme }: { readonly theme: ThemeId }): React.JSX.Element {
  return (
    <span className="pcad-theme-card__preview" data-theme={theme} aria-hidden="true">
      <span className="pcad-theme-card__bar">
        <span className="pcad-theme-card__dot" />
        <span className="pcad-theme-card__dot pcad-theme-card__dot--muted" />
        <span className="pcad-theme-card__dot pcad-theme-card__dot--muted" />
      </span>
      <span className="pcad-theme-card__body">
        <span className="pcad-theme-card__side" />
        <span className="pcad-theme-card__view">
          <span className="pcad-theme-card__line" />
          <span className="pcad-theme-card__line pcad-theme-card__line--accent" />
        </span>
      </span>
    </span>
  );
}

/** テーマを差し替える(拡大率はそのまま)。 */
function selectTheme(theme: ThemeId): void {
  const store = useAppStore.getState();
  store.setDisplaySettings({ ...store.displaySettings, theme });
}

/** 拡大率を差し替える(テーマはそのまま)。 */
function selectScale(uiScale: number): void {
  const store = useAppStore.getState();
  store.setDisplaySettings({ ...store.displaySettings, uiScale });
}

/** 畳める見出し 1 つ。見出しを押すと中身を畳む・開く(details の既定の動き。Enter・Space でも同じ)。 */
function SettingsSection({ titleKey, children }: { readonly titleKey: MessageKey; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <details className="pcad-settings__section" open>
      <summary className="pcad-settings__section-title">{t(titleKey)}</summary>
      <div className="pcad-settings__section-body">{children}</div>
    </details>
  );
}

/** テーマと拡大率(「表示」の見出しの中身)。 */
function DisplaySettingsGroups(): React.JSX.Element {
  const displaySettings = useAppStore((state) => state.displaySettings);
  /** 見本カードの押し場所。矢印キーで焦点を移すために覚えておく。 */
  const cardsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const currentTheme = displaySettings.theme;
  const currentStep = nearestUiScaleStep(displaySettings.uiScale);
  return (
    <>
      <div className="pcad-settings__group">
        <span className="pcad-settings__label" title={t('settings.theme.tooltip')}>
          {t('settings.theme.label')}
        </span>
        {/*
          選択肢が並ぶ操作なので radiogroup にする。Tab で中へ入り、矢印で移りながら
          選び、Enter / Space はボタンそのものの働きで決まる(NFR-UX-7)。
        */}
        <div
          className="pcad-settings__themes"
          role="radiogroup"
          aria-label={t('settings.theme.label')}
          onKeyDown={(event) => {
            const index = nextThemeIndex(THEME_IDS.indexOf(currentTheme), event.key);
            if (index === null) {
              return;
            }
            // 矢印での上下は画面送りに使われるので、こちらで受け取ったら渡さない。
            event.preventDefault();
            selectTheme(THEME_IDS[index]);
            cardsRef.current[index]?.focus();
          }}
        >
          {THEME_IDS.map((theme, index) => (
            <button
              key={theme}
              type="button"
              className="pcad-theme-card"
              ref={(element) => {
                cardsRef.current[index] = element;
              }}
              role="radio"
              aria-checked={theme === currentTheme}
              // 選んでいるものだけが Tab の行き先になる(一覧の中の移動は矢印)。
              tabIndex={theme === currentTheme ? 0 : -1}
              title={t(THEME_LABEL_KEYS[theme])}
              onClick={() => {
                selectTheme(theme);
              }}
            >
              <ThemePreview theme={theme} />
              <span className="pcad-theme-card__name">{t(THEME_LABEL_KEYS[theme])}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pcad-settings__group">
        <span className="pcad-settings__label" title={t('settings.scale.tooltip')}>
          {t('settings.scale.label')}
        </span>
        <div
          className="pcad-segmented pcad-settings__scale"
          role="group"
          aria-label={t('settings.scale.label')}
        >
          {UI_SCALE_STEPS.map((step) => (
            <button title={t('controlGuide.button.uiScale')}
              key={step}
              type="button"
              className="pcad-button"
              aria-pressed={step === currentStep}
              onClick={() => {
                selectScale(step);
              }}
            >
              {scaleLabel(step)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** 下書きがある時の確かめ。窓の中に出し、モーダルにしない(NFR-UX-3)。 */
function DraftPrompt({ failed, onApply, onDiscard, onContinue }: {
  readonly failed: boolean;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  const firstRef = useRef<HTMLButtonElement>(null);
  // 確かめが出たら、キーボードの人がすぐ選べるよう最初の選択へ焦点を移す。
  useEffect(() => { firstRef.current?.focus(); }, []);
  return (
    <div className="pcad-settings__draft" role="group" aria-label={t('toolbar.settings.draft.message')}>
      <p role="status">{t('toolbar.settings.draft.message')}</p>
      {failed ? <p role="alert">{t('toolbar.settings.draft.applyFailed')}</p> : null}
      <div className="pcad-settings__draft-actions">
        <button ref={firstRef} type="button" className="pcad-button" title={t('toolbar.settings.draft.applyCloseGuide')}
          onClick={onApply}>{t('toolbar.settings.draft.applyClose')}</button>
        <button type="button" className="pcad-button" title={t('toolbar.settings.draft.discardCloseGuide')}
          onClick={onDiscard}>{t('toolbar.settings.draft.discardClose')}</button>
        <button type="button" className="pcad-button" title={t('toolbar.settings.draft.continueGuide')}
          onClick={onContinue}>{t('toolbar.settings.draft.continue')}</button>
      </div>
    </div>
  );
}

export function SettingsPanel(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /** 閉じる求めに下書きがあった時の確かめ(適用できなかった時は 'failed')。 */
  const [closing, setClosing] = useState<'confirm' | 'failed' | null>(null);
  /** 「適用して閉じる」で各 form を送った回数。送った後の描画で、下書きが残ったかを確かめる。 */
  const [applyRequest, setApplyRequest] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** 確かめの後に続ける操作(チュートリアルを始めるなど)。 */
  const afterCloseRef = useRef<(() => void) | null>(null);

  const finishClose = (): void => {
    const after = afterCloseRef.current;
    afterCloseRef.current = null;
    setClosing(null);
    setOpen(false);
    after?.();
  };
  const requestClose = (after: (() => void) | null = null): void => {
    afterCloseRef.current = after;
    if (settingsCloseRequest(panelRef.current) === 'confirm') { setClosing('confirm'); return; }
    finishClose();
  };
  // Both read only refs and state setters; keep the latest closures in refs for the listener and the apply check.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const finishCloseRef = useRef(finishClose);
  finishCloseRef.current = finishClose;

  useEffect(() => {
    if (!open) {
      return;
    }
    // 外を押したら閉じる(下書きがあれば窓の中で確かめる)。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        requestCloseRef.current();
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // 各 form の送信が描画へ反映された後に、下書きが残っていれば閉じずに理由を出す。
  useEffect(() => {
    if (applyRequest === 0) return;
    if (settingsCloseRequest(panelRef.current) === 'confirm') setClosing('failed');
    else finishCloseRef.current();
  }, [applyRequest]);

  return (
    <div
      className="pcad-menu pcad-menu--settings"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          // 確かめが出ている時の Esc は「続ける」(取消)。それ以外は閉じる求め。
          if (closing !== null) setClosing(null);
          else requestClose();
        }
      }}
    >
      <button
        type="button"
        className="pcad-button pcad-button--icon"
        title={t('toolbar.settings.openTooltip')}
        aria-label={t('toolbar.settings.open')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          if (open) requestClose();
          else setOpen(true);
        }}
      >
        <GearIcon />
      </button>
      {open ? (
        <div
          className="pcad-menu__panel pcad-settings"
          role="group"
          aria-label={t('settings.title')}
          ref={panelRef}
        >
          <span className="pcad-settings__title">{t('settings.title')}</span>
          {closing === null ? null : <DraftPrompt failed={closing === 'failed'}
            onApply={() => {
              const panel = panelRef.current;
              if (panel !== null) submitSettingsDrafts({ querySelectorAll: (selectors) => panel.querySelectorAll<HTMLFormElement>(selectors) });
              setApplyRequest((count) => count + 1);
            }}
            onDiscard={finishClose} onContinue={() => { afterCloseRef.current = null; setClosing(null); }} />}
          <SettingsSection titleKey="toolbar.settings.section.display"><DisplaySettingsGroups /></SettingsSection>
          <SettingsSection titleKey="toolbar.settings.section.controls">
            <CameraControlSettingsForm />
            <ShortcutSettingsForm />
          </SettingsSection>
          <SettingsSection titleKey="toolbar.settings.section.autoSave"><AutoSaveIntervalForm /></SettingsSection>
          <SettingsSection titleKey="toolbar.settings.section.toolDefaults"><ToolDefaultsForm /></SettingsSection>
          <SettingsSection titleKey="toolbar.settings.section.other">
            <button type="button" className="pcad-button" data-help-topic="tutorial" title={t('tutorial.startHint')}
              onClick={() => { requestClose(openTutorial); }}>{t('tutorial.start')}</button>
            <OfflineSettings />
          </SettingsSection>
          <p className="pcad-settings__hint">{t('settings.hint')}</p>
        </div>
      ) : null}
    </div>
  );
}
