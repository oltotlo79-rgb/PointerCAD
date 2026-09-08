import {
  BOM_COLUMN_IDS,
  BOM_SORT_KEYS,
  buildBom,
  type BomBody,
  type BomColumnId,
  type BomSortKey,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { bomTableRows } from './bomTableRows.js';

const EMPTY_PART_KEYS: ReadonlyMap<string, string> = new Map();
const EMPTY_BODIES: ReadonlyMap<string, readonly BomBody[]> = new Map();

const COLUMN_LABEL_KEYS: Readonly<Record<BomColumnId, MessageKey>> = {
  number: 'assembly.bom.column.number',
  name: 'assembly.bom.column.name',
  quantity: 'assembly.bom.column.quantity',
  material: 'assembly.bom.column.material',
  mass: 'assembly.bom.column.mass',
};

const SORT_LABEL_KEYS: Readonly<Record<BomSortKey, MessageKey>> = {
  number: 'assembly.bom.sort.number',
  name: 'assembly.bom.sort.name',
  quantity: 'assembly.bom.sort.quantity',
  mass: 'assembly.bom.sort.mass',
};

const MATERIAL_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  steel: 'material.steel',
  stainless: 'material.stainless',
  aluminum: 'material.aluminum',
  brass: 'material.brass',
  copper: 'material.copper',
  titanium: 'material.titanium',
  abs: 'material.abs',
  pc: 'material.pc',
  nylon: 'material.nylon',
  acrylic: 'material.acrylic',
  pla: 'material.pla',
  glass: 'material.glass',
  rubber: 'material.rubber',
  'wood-hinoki': 'material.wood-hinoki',
  'wood-sugi': 'material.wood-sugi',
  'wood-oak': 'material.wood-oak',
  'wood-walnut': 'material.wood-walnut',
  'wood-teak': 'material.wood-teak',
  'wood-maple': 'material.wood-maple',
};

function isBomSortKey(value: string): value is BomSortKey {
  return BOM_SORT_KEYS.some((key) => key === value);
}

function materialLabel(materialId: string, fallback: string): string {
  const key = MATERIAL_LABEL_KEYS[materialId];
  return key === undefined ? fallback : t(key);
}

/** 右の既存プロパティ区画へ置く部品表。設定変更は通常のUndo 1段として確定する。 */
export function BomTable(): React.JSX.Element {
  const document = useAppStore((state) => state.assembly);
  const view = useAppStore((state) => state.assemblyView);
  const selection = useAppStore((state) => state.selection);

  if (document === null) return <></>;
  const currentView = view?.sourceDocument === document ? view : null;
  const rows = buildBom(document, {
    partKeys: currentView?.resolved.partKeys ?? EMPTY_PART_KEYS,
    bodies: currentView?.bodies ?? EMPTY_BODIES,
  }, document.bom);
  const tableRows = bomTableRows(rows, selection, materialLabel);

  const applySettings = (next: typeof document.bom): void => {
    useAppStore.getState().applyAssembly({ ...document, bom: next });
  };

  return (
    <section className="pcad-section pcad-bom">
      <h3 className="pcad-section__title">{t('assembly.bom.title')}</h3>
      <div className="pcad-bom__settings">
        <label className="pcad-bom__sort">
          <span>{t('assembly.bom.sort')}</span>
          <select
            value={document.bom.sortBy}
            aria-label={t('assembly.bom.sort')}
            onChange={(event) => {
              if (isBomSortKey(event.target.value)) {
                applySettings({ ...document.bom, sortBy: event.target.value });
              }
            }}
          >
            {BOM_SORT_KEYS.map((sortKey) => (
              <option key={sortKey} value={sortKey}>{t(SORT_LABEL_KEYS[sortKey])}</option>
            ))}
          </select>
        </label>
        <fieldset className="pcad-bom__columns">
          <legend>{t('assembly.bom.columns')}</legend>
          {BOM_COLUMN_IDS.map((column) => (
            <label key={column}>
              <input
                type="checkbox"
                checked={document.bom.columns.includes(column)}
                onChange={(event) => {
                  const columns = BOM_COLUMN_IDS.filter((candidate) =>
                    candidate === column ? event.target.checked : document.bom.columns.includes(candidate));
                  applySettings({ ...document.bom, columns });
                }}
              />
              <span>{t(COLUMN_LABEL_KEYS[column])}</span>
            </label>
          ))}
        </fieldset>
        <label className="pcad-bom__expand">
          <input
            type="checkbox"
            checked={document.bom.expandSubAssemblies}
            onChange={(event) => {
              applySettings({ ...document.bom, expandSubAssemblies: event.target.checked });
            }}
          />
          <span>{t('assembly.bom.expandSubAssemblies')}</span>
        </label>
      </div>

      {tableRows.length === 0 ? (
        <p className="pcad-bom__empty">{t('assembly.bom.empty')}</p>
      ) : document.bom.columns.length === 0 ? (
        <p className="pcad-bom__empty">{t('assembly.bom.noColumns')}</p>
      ) : (
        <div className="pcad-bom__scroll">
          <table className="pcad-bom__table">
            <thead>
              <tr>
                {document.bom.columns.map((column) => (
                  <th key={column} scope="col">{t(COLUMN_LABEL_KEYS[column])}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr
                  key={row.key}
                  className={row.active ? 'pcad-bom__row pcad-bom__row--active' : 'pcad-bom__row'}
                  aria-selected={row.active}
                  tabIndex={0}
                  onClick={() => {
                    useAppStore.getState().setSelection(row.componentIds);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      useAppStore.getState().setSelection(row.componentIds);
                    }
                  }}
                >
                  {document.bom.columns.map((column) => (
                    <td key={column}>{row.cells[column]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
