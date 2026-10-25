import { expect, type JSHandle, type Locator, type Page } from '@playwright/test';

/*
 * 衝撃の結果が出た後の、範囲の表示・入力の編集による結果の無効化・公開の「取消し」(task175。task174 の後継で、
 * impactFlow.ts の impactLifecycleFlow の実計算 2 回目の直後に呼ぶ)。製品の実際の道筋だけを使う:
 *   - 欄の編集は editBeam → editBeamSession(beamSession.ts 219-232)で、invalidateBeamSession が結果と確かめを消し、
 *     動いている計算は beamRunner.cancel で止める(beamSlice.ts 45-51)。
 *   - 「取消し」は計算中だけ押せる(BeamPanel.tsx 147)。cancelBeam(beamSlice.ts 81-86)が AbortController を止め
 *     (attachBeamAnalysis.ts 46-50)、FemClient は要求ごとの worker を終わらせて 'cancelled' で閉じる(fem client.ts の
 *     execute。r216 の client.ts 6bc59e1b でも同じ道筋かは統括の合成で確かめる)。遅れて来る返事は current()
 *     (attachBeamAnalysis.ts 51-56、93)で捨てられる。
 * 取消しを押す時: 「計算」を押す前に、公開の「取消し」ボタンの disabled の変化を MutationObserver で見張り、押せるように
 * なった変化の通知の中で、そのボタンを同期で押す。
 *   1. 「計算」の click の中で runBeam → runner.run が status 'running' を同期で store に入れ(attachBeamAnalysis.ts 68)、
 *      その後に worker を作って要求を送る(83)。
 *   2. store の変化は React 19.2.8 の useSyncExternalStore の同期の更新で、click の処理の終わり(同期か microtask)に DOM へ
 *      反映され、「取消し」の disabled が外れる。MutationObserver の通知はその直後の microtask で届く。
 *   3. worker の返事(phase も結果も)は message の task で、今の task と microtask が全て終わるまで届かない。
 *   2 の「別の task へ延ばさない」は React の仕組みからの推論で、押した時の状態が 'running' であることを確かめて守る。
 *   待ち時間・再試行・時間上限の延長、製品の試験用の一時停止は使わない。見張りは最後に必ず外す。
 */
function beamPanel(page: Page): Locator {
  return page.getByTestId('beam-panel');
}

/** impactFlow.ts の historyInput と同じ欄(BeamImpactDefinitions.tsx の data-beam-impact-field)。 */
function outputEveryInput(page: Page): Locator {
  return beamPanel(page).locator('[data-beam-impact-field="impact:outputEvery"] input.pcad-field__input');
}

interface ArmedCancel {
  readonly fired: Promise<string>;
  readonly disconnect: () => void;
}
/**
 * 「取消し」が押せるようになった瞬間に押す見張りを付ける。押した時の data-status(押せるようになった描画の状態)を返す。
 * 付けた時に「取消し」が無い、または既に押せる場合は前提の誤りとして断る。
 */
async function armCancelOnEnable(page: Page): Promise<JSHandle<ArmedCancel>> {
  return page.evaluateHandle(() => {
    const panel = document.querySelector('[data-testid="beam-panel"]');
    const button = panel?.querySelector('[data-testid="beam-cancel"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('beam-cancel is missing before Run');
    if (!button.disabled) throw new Error('beam-cancel must be disabled before Run');
    let disconnect = (): void => undefined;
    const fired = new Promise<string>(resolve => {
      const observer = new MutationObserver(() => {
        if (button.disabled || !button.isConnected) return;
        observer.disconnect();
        const status = panel?.querySelector('[data-testid="beam-status"]')?.getAttribute('data-status') ?? '';
        button.click();
        resolve(status);
      });
      observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
      disconnect = () => { observer.disconnect(); };
    });
    // Returned inside an object so that evaluateHandle does not wait for the promise.
    return { fired, disconnect: () => { disconnect(); } };
  });
}

export async function impactCancelAndInvalidationFlow(page: Page): Promise<void> {
  const panel = beamPanel(page), status = panel.getByTestId('beam-status');
  const results = panel.getByTestId('beam-impact-results');
  // 前提: impactLifecycleFlow の実計算 2 回目の結果が出ている。
  await expect(results).toBeVisible();
  await expect(status).toHaveAttribute('data-status', 'complete');
  // 範囲(task175): 方法の範囲と、強さを確かめていないことは、数より前に常に示す。この片持ちは 0.5 mm 先の面に当たって
  // 弾性で戻るだけなので、節点の回転は 0 より大きく、線形化の目安 0.1 rad よりずっと小さい(先端の振れ δ に対して根元からの
  // 回転はおよそ 1.5 δ / L、L = 2000 mm)。目安を超えた印は出ないが、それは強さの合格ではない(強さの注記は残る)。
  await expect(results.getByTestId('beam-impact-applicability')).toBeVisible();
  await expect(results.getByTestId('beam-impact-strength-not-assessed')).toBeVisible();
  await expect(results.getByTestId('beam-impact-linearization-warning')).toHaveCount(0);
  const rotation = Number((await results.locator('[data-beam-impact-value="maximum-rotation"]').textContent() ?? 'NaN')
    .replaceAll(',', ''));
  expect(rotation).toBeGreaterThan(0);
  expect(rotation).toBeLessThan(0.1);

  // 6) 入力を 1 つ直す(出力の間隔 2 → 4。歩数 200 以下の正しい値)と、前の結果は消え、確かめるまで計算も適用もできない。
  await outputEveryInput(page).fill('4');
  await outputEveryInput(page).blur();
  await expect(results).toHaveCount(0);
  await expect(status).toHaveAttribute('data-status', 'editing');
  await expect(panel.getByTestId('beam-run')).toBeDisabled();
  await expect(panel.getByTestId('beam-apply')).toBeDisabled();
  await expect(outputEveryInput(page)).toHaveValue('4');

  // 7) 確かめて、「取消し」の見張りを付けてから計算を押す。計算中になった描画の直後に取消しが押され、状態は取消しになり、
  //    結果は出ず、入力は残る。
  await panel.getByTestId('beam-review').click();
  await expect(panel.getByTestId('beam-run')).toBeEnabled();
  await expect(panel.getByTestId('beam-cancel')).toBeDisabled();
  const armed = await armCancelOnEnable(page);
  try {
    await panel.getByTestId('beam-run').click();
    // 押した時の描画は計算中だった(計算が終わった後の描画では「取消し」は押せない)。
    expect(await armed.evaluate(handle => handle.fired)).toBe('running');
  } finally {
    await armed.evaluate(handle => { handle.disconnect(); });
    await armed.dispose();
  }
  await expect(status).toHaveAttribute('data-status', 'cancelled');
  await expect(panel.getByTestId('beam-cancel')).toBeDisabled();
  await expect(results).toHaveCount(0);
  await expect(outputEveryInput(page)).toHaveValue('4');
  // 確かめは残るので、取消しの後はすぐ計算し直せる(取消しは確かめを消さない。beamSlice.ts 84-85)。
  await expect(panel.getByTestId('beam-run')).toBeEnabled();
  await expect(status).toHaveAttribute('data-status', 'cancelled');
}
