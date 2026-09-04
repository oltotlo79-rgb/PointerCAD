import { useEffect, useRef, useState } from 'react';

import { t, type MessageKey } from '../i18n/t.js';
import { GearIcon } from '../shell/icons.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  nearestUiScaleStep,
  nextThemeIndex,
  THEME_IDS,
  UI_SCALE_STEPS,
  type ThemeId,
} from './settings.js';

/**
 * 表示設定(計画書 docs/plans/P4-スケッチ拡張.md タスク2、§0.a-0.3、§2.2)。
 *
 * 対応要件: FR-908(表示テーマ 5 種)、FR-909(拡大率 90〜150%)。どちらも
 * **再起動なしに即時反映**で、選んだ内容は端末に残る(`settings.ts` が `localStorage` へ)。
 *
 * 作り: ツールバーの歯車 1 つと、その場に開く一覧。吸着の種別(`Toolbar.tsx` の
 * `SnapKindsMenu`)と同じ `.pcad-menu` の作りで、モーダルにしない(NFR-UX-2)ので
 * 開いている間も背後の作図と視点操作はそのまま効く。**固定の区画は増やさない**
 * (要件§7.1、rules/04-設計の規律.md)。
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

export function SettingsPanel(): React.JSX.Element {
  const displaySettings = useAppStore((state) => state.displaySettings);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 見本カードの押し場所。矢印キーで焦点を移すために覚えておく。 */
  const cardsRef = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const currentTheme = displaySettings.theme;
  const currentStep = nearestUiScaleStep(displaySettings.uiScale);

  return (
    <div
      className="pcad-menu pcad-menu--settings"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
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
          setOpen(!open);
        }}
      >
        <GearIcon />
      </button>
      {open ? (
        <div
          className="pcad-menu__panel pcad-settings"
          role="group"
          aria-label={t('settings.title')}
        >
          <span className="pcad-settings__title">{t('settings.title')}</span>

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
                <button
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

          <p className="pcad-settings__hint">{t('settings.hint')}</p>
        </div>
      ) : null}
    </div>
  );
}
