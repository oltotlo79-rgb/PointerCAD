/**
 * ファイルの読み書きの口のうち、ブラウザに触らない部分の検査
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク23 手順7)。
 *
 * ここで確かめるのは「候補名の付け方」と「File System Access API があるかの判定」の 2 つだけ。
 * ファイル選択の窓・ダウンロード・書き込みは本物のブラウザでしか動かないので、
 * 通しの確認は E2E(タスク27)と統括の目視に任せる。
 * 本物の `globalThis` へ欄を差し込むと他の検査へ漏れるので、判定には偽の相手を渡す。
 */

import { describe, expect, it } from 'vitest';

import {
  createBrowserFileGateway,
  hasFileSystemAccess,
  PCAD_EXTENSION,
  withPcadExtension,
} from './fileGateway.js';

describe('保存の候補名(.pcad の補完)', () => {
  it('拡張子が無ければ .pcad を足す', () => {
    expect(withPcadExtension('部品1')).toBe('部品1.pcad');
  });

  it('すでに .pcad で終わっていれば足さない', () => {
    expect(withPcadExtension('部品1.pcad')).toBe('部品1.pcad');
  });

  it('大文字の .PCAD も同じ拡張子として扱う(二重に付けない)', () => {
    expect(withPcadExtension('部品1.PCAD')).toBe('部品1.PCAD');
  });

  it('別の拡張子は残したまま .pcad を足す(取り違えを防ぐ)', () => {
    expect(withPcadExtension('メモ.txt')).toBe('メモ.txt.pcad');
  });

  it('前後の空白は落とす', () => {
    expect(withPcadExtension('  部品1  ')).toBe('部品1.pcad');
  });

  it('拡張子の綴りは 1 箇所で決まっている', () => {
    expect(PCAD_EXTENSION).toBe('.pcad');
    expect(withPcadExtension('a').endsWith(PCAD_EXTENSION)).toBe(true);
  });
});

describe('File System Access API の判定', () => {
  it('2 つとも揃っていれば使える', () => {
    const scope = {
      showOpenFilePicker: () => Promise.resolve([]),
      showSaveFilePicker: () => Promise.resolve({}),
    };
    expect(hasFileSystemAccess(scope)).toBe(true);
  });

  it('欄が無ければ使えない', () => {
    expect(hasFileSystemAccess({})).toBe(false);
  });

  it('片方だけでは使えない(環境ごとに振る舞いが変わらないようにする)', () => {
    expect(hasFileSystemAccess({ showOpenFilePicker: () => Promise.resolve([]) })).toBe(false);
    expect(hasFileSystemAccess({ showSaveFilePicker: () => Promise.resolve({}) })).toBe(false);
  });

  it('欄はあっても関数でなければ使えない', () => {
    expect(hasFileSystemAccess({ showOpenFilePicker: 1, showSaveFilePicker: 'yes' })).toBe(false);
  });

  it('Node のように何も持たない環境(この検査自身)では使えないと答える', () => {
    expect(hasFileSystemAccess()).toBe(false);
  });
});

describe('ブラウザ用の口', () => {
  it('作った直後は保存先を覚えていない(はじめの保存は必ず場所を聞く)', () => {
    expect(createBrowserFileGateway().hasSaveTarget()).toBe(false);
  });

  it('作り直すと別の口になる(保存先を引きずらない)', () => {
    expect(createBrowserFileGateway()).not.toBe(createBrowserFileGateway());
  });
});
