import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ChevronRightIcon } from '../shell/icons.js';

/**
 * いくつかから 1 つを選ぶ、畳んだ一覧(材質プリセット・樹種。`Toolbar.tsx` の `PlaneMenu`
 * と同じ作り、`ChoiceButtons` の長い一覧の分岐と同じ見た目)。値と選択肢は文字列 1 つずつ
 * なので、`SolidChoiceSummary` を要る `ChoiceButtons` とは別に置く(数値の書式が要らない
 * ぶん単純)。開閉は見た目だけの一時状態(rules/04-設計の規律.md)。
 */
export function AppearanceMenu({
  groupLabelKey,
  value,
  options,
  onChoose,
}: {
  readonly groupLabelKey: MessageKey;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly labelKey: MessageKey }[];
  readonly onChoose: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const groupLabel = t(groupLabelKey);

  useEffect(() => {
    if (!open) {
      return undefined;
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

  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <div className="pcad-choice">
      <span className="pcad-choice__label">{groupLabel}</span>
      <div className="pcad-menu" ref={containerRef}>
        <button title={t('controlGuide.button.expand').replace('{group}', groupLabel)}
          type="button"
          className="pcad-button pcad-menu__trigger"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className="pcad-menu__count">{selected === null ? '' : t(selected.labelKey)}</span>
          <ChevronRightIcon className="pcad-menu__chevron" />
        </button>
        {open ? (
          <div className="pcad-menu__panel" role="group" aria-label={groupLabel}>
            {options.map((option) => (
              <button title={t('controlGuide.button.choose').replace('{group}', groupLabel).replace('{value}', t(option.labelKey))}
                key={option.value}
                type="button"
                role="menuitem"
                className="pcad-button pcad-menu__item"
                aria-pressed={option.value === value}
                onClick={() => {
                  onChoose(option.value);
                  setOpen(false);
                }}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
