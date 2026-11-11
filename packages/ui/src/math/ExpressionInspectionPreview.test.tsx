import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExpressionInspectionPreview } from './ExpressionInspectionPreview.js';
import { inspectInputExpression } from './expressionInspectionContext.js';
import { MathEditorSurface, type MathEditorViewController } from './MathEditorSurface.js';
import { mathEditorLabels } from './mathEditorLabels.js';

describe('\u5f0f\u306e\u8aad\u307f\u53d6\u308a\u8868\u793a', () => {
  it('\u53cd\u5fa9\u3059\u308b\u65e5\u672c\u8a9e\u53c2\u7167\u306e\u4f4d\u7f6e\u3068\u5143\u5024\u3092\u5168\u4ef6\u51fa\u3057\u3001\u672a\u8a08\u7b97\u306e\u5f71\u97ff\u90e8\u54c1\u6570\u3092\u65ad\u5b9a\u3057\u306a\u3044', () => {
    const context = inspectInputExpression('\u677f\u539a+\u677f\u539a', { variables: new Map([['\u677f\u539a', 3]]) }, null);
    const markup = renderToStaticMarkup(createElement(ExpressionInspectionPreview, {
      id: 'inspect', context, unitLabel: 'mm', parameterUnits: new Map([['\u677f\u539a', 'mm' as const]]),
      usageCounts: new Map([['\u677f\u539a', 2]]),
    }));
    expect(markup).toContain('\u677f\u539a</code> (1\u6587\u5b57\u76ee)\uff1a3 mm');
    expect(markup).toContain('\u677f\u539a</code> (4\u6587\u5b57\u76ee)\uff1a3 mm');
    expect(markup).toContain('\u5f62\u30fb\u6570\u5f0f\u3067\u306e\u4f7f\u7528\u7b87\u6240: 2');
    expect(markup).toContain('\u5f71\u97ff\u3059\u308b\u30d5\u30a3\u30fc\u30c1\u30e3\u30fc\u6570: \u672a\u78ba\u8a8d');
    const counted = renderToStaticMarkup(createElement(ExpressionInspectionPreview, {
      id: 'inspect', context, unitLabel: 'mm', affectedPartCount: 0,
    }));
    expect(counted).toContain('\u5f71\u97ff\u3059\u308b\u30d5\u30a3\u30fc\u30c1\u30e3\u30fc\u6570: 0');
  });

  it('\u5143source\u306e\u672b\u5c3e\u306b\u3042\u308b\u69cb\u6587\u30a8\u30e9\u30fc\u3092\u898b\u3048\u308b\u5370\u3068\u7406\u7531\u4f4d\u7f6e\u3067\u793a\u3059', () => {
    const context = inspectInputExpression('1+', {}, { code: 'unexpectedEnd', message: '\u672b\u5c3e', position: 2 });
    const markup = renderToStaticMarkup(createElement(ExpressionInspectionPreview, { id: 'inspect', context, unitLabel: '\u00b0' }));
    expect(markup).toContain('\u5165\u529b\u4e2d\u306e\u8aa4\u308a\u306e\u4f4d\u7f6e: 3\u6587\u5b57\u76ee');
    expect(markup).toContain('1+<mark');
    expect(markup).toContain('\u2502</mark>');
  });

  it('\u6570\u5b66\u753b\u9762\u306f\u5e73\u6587\u3060\u3051\u5143\u4f4d\u7f6e\u3092\u6848\u5185\u3057\u3001\u69cb\u9020\u5165\u529b\u306eatom\u756a\u53f7\u3092\u6587\u5b57\u4f4d\u7f6e\u3078\u6d41\u7528\u3057\u306a\u3044', () => {
    const context = inspectInputExpression('\u677f\u539a*2', { variables: new Map([['\u677f\u539a', 3]]) }, null);
    const textInput = { identity: { documentId: 'part', documentVersion: 1, editorId: 'editor', inputRevision: 2 },
      source: '\u677f\u539a*2', notation: 'text' as const, angleUnit: 'degree' as const };
    const controller: MathEditorViewController = {
      current: () => textInput, isCurrent: () => true, sourceChanged: () => {}, apply: () => {}, cancel: () => {},
      sourceLimit: () => {}, moveOut: () => {}, bindInsertion: () => () => {}, insert: () => {},
      requestNotation: () => {}, changeAngleUnit: () => {},
    };
    const base = { controller, createField: () => { throw new Error('\u9759\u7684\u63cf\u753b\u3067\u306f\u69cb\u9020\u6b04\u3092\u4f5c\u3089\u306a\u3044'); },
      labels: mathEditorLabels(), groups: [], palette: [], query: '', onQuery: () => {},
      resultMessage: '= 6', resultDetail: '', hasError: false, busy: false, canApply: true,
      canChangeNotation: true, readOnly: false, onHelp: () => {}, maximumSourceLength: 1000,
      inspection: context };
    const plain = renderToStaticMarkup(createElement(MathEditorSurface, { ...base, input: textInput }));
    expect(plain).toContain('\u677f\u539a</code> (1\u6587\u5b57\u76ee)\uff1a3');
    expect(plain).toContain('aria-describedby=');
    const structured = renderToStaticMarkup(createElement(MathEditorSurface, {
      ...base, input: { ...textInput, notation: 'latex' },
    }));
    expect(structured).not.toContain('\u5165\u529b\u4e2d\u306e\u5f0f\u306e\u60c5\u5831');
  });
});
