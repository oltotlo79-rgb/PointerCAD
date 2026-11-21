import { DocumentDiffDialog } from '../../diff/DocumentDiffDialog.js';
import { ExamplesDialog } from '../../examples/ExamplesDialog.js';
import { useAppStore } from '../../store/useAppStore.js';

type PartFileDialog = 'comparison' | 'examples';

function closer(panel: PartFileDialog): () => void {
  return () => useAppStore.getState().setUtilityPanelOpen(panel, false);
}

/**
 * 部品の時だけ出す、「ファイル」の一覧から開く窓(2 つの保存ファイルの比較と作例の一覧)。
 * 開閉はストアの補助画面の欄 1 つで持つので、同時に 2 つは開かない。
 */
export function PartFileDialogs(): React.JSX.Element | null {
  const panel = useAppStore(state => state.utilityPanel);
  if (panel === 'comparison') return <DocumentDiffDialog onClose={closer('comparison')} />;
  if (panel === 'examples') return <ExamplesDialog onClose={closer('examples')} />;
  return null;
}
