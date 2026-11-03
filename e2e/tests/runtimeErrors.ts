import type { Page } from '@playwright/test';

/**
 * コンソールのエラーとページの例外を集める。最後に 0 件であることを確かめる。
 * console の listener を先に、pageerror を後に登録し、console は type が error の物だけを集める
 * (warning は集めず、除外する文字列は無い)。返す配列は以後の発生で同じ物へ追記され、
 * listener は頁が閉じるまで外さない。
 */
export function collectErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

/** Observe console errors, page errors, and unexpected dialogs for the page lifetime. */
export interface ErrorDialogWatch {
  readonly errors: string[];
  readonly dialogs: string[];
}

export function watch(page: Page): ErrorDialogWatch {
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  // 確認の窓が出たら記録して閉じる(出ないはずなので、最後に空であることを確かめる)。
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  return { errors, dialogs };
}
