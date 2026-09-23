import Decimal from 'decimal.js';
import { zetaValue } from './zetaNumeric.js';
import { zetaDerivatives } from './zetaDerivatives.js';
import { ellipticValue, type EllipticKind } from './ellipticNumeric.js';
import { airyValues, type AiryKind } from './airyNumeric.js';
import { integerBesselDecimal } from './besselIntegerNumeric.js';
import { lambertWBounds } from './lambertWNumeric.js';
import { secondBesselDecimal } from './besselSecondKindNumeric.js';
import type { BesselKind } from './besselFunctions.js';
import { testDistributionDecimal } from './testDistributionsNumeric.js';
import { binomialQuantile } from './binomialProbability.js';
import { poissonQuantile } from './poissonQuantile.js';
/** Small deterministic scalar backend. Symbolic operations stay intact for SymPy. */
import { MathInputProblem } from './mathInputContract.js';
import type { EngineMathJson } from './encodeMathJson.js';
import type { MathBackendBox } from './numericMathBoundary.js';
import { numberJson, rationalJson, jsonRational, jsonDecimal, decimalOperation } from './nativeMathNumber.js';
import { exactIntegerOperation, exactTrigonometry, exactPiProduct, piRatio } from './nativeMathExact.js';
import { complexOperation, complexParts } from './nativeMathComplex.js';
import { gammaBetaDistributionDecimal } from './gammaBetaDistributionNumeric.js';
import { normalDistributionDecimal } from './normalDistributionNumeric.js';
import { errorFunctionDecimal } from './errorFunctionNumeric.js';
import { complexErrorFunctionValue } from './complexErrorFunctionNumeric.js';
import { gammaFunctionDecimal } from './gammaFunctionNumeric.js';
import { betaFunctionDecimal } from './betaFunctionNumeric.js';
import { polygammaDecimal } from './polygammaNumeric.js';
import { polynomialIntegral } from './nativeMathPolynomialIntegral.js';

const N = numberJson;
const ELLIPTIC_HEADS: ReadonlyMap<string, EllipticKind> = new Map([['EllipticK','K'],['EllipticE','E'],['EllipticF','F'],['EllipticEinc','Einc'],['EllipticPi','Pi'],['EllipticPiinc','Piinc']]);
const AIRY_HEADS: ReadonlyMap<string, readonly [AiryKind, boolean]> = new Map([['AiryAi',['Ai',false]], ['AiryBi',['Bi',false]], ['AiryAiPrime',['Ai',true]], ['AiryBiPrime',['Bi',true]]]);
const BESSEL_HEADS: ReadonlyMap<string, BesselKind> = new Map([['BesselJ','J'],['BesselY','Y'],['BesselI','I'],['BesselK','K']]);
const TEST_DISTRIBUTION_HEADS: ReadonlyMap<string, string> = new Map([['ChiSquarePdf', 'chi-square-pdf'], ['ChiSquareCdf', 'chi-square-cdf'], ['ChiSquareQuantile', 'chi-square-quantile'], ['TPdf', 't-pdf'], ['TCdf', 't-cdf'], ['TQuantile', 't-quantile'], ['FPdf', 'f-pdf'], ['FCdf', 'f-cdf'], ['FQuantile', 'f-quantile']]);
const GAMMA_BETA_HEADS: ReadonlyMap<string, string> = new Map([['GammaPdf', 'gamma-pdf'], ['GammaCdf', 'gamma-cdf'], ['GammaQuantile', 'gamma-quantile'], ['BetaPdf', 'beta-pdf'], ['BetaCdf', 'beta-cdf'], ['BetaQuantile', 'beta-quantile']]);
const NORMAL_HEADS: ReadonlyMap<string, string> = new Map([['NormalPdf', 'normal-pdf'], ['NormalCdf', 'normal-cdf'], ['NormalQuantile', 'normal-quantile']]);
const TRUTH = (value: boolean): EngineMathJson => value ? 'True' : 'False';
const BINDERS = new Set(['Function', 'Integrate', 'Limit', 'D', 'ForAll', 'Exists']);
function booleanOperation(head: string, args: readonly EngineMathJson[]): EngineMathJson | null {
  if (head === 'Not' && (args[0] === 'True' || args[0] === 'False')) return TRUTH(args[0] === 'False');
  if (head === 'And' || head === 'Or' || head === 'Implies' || head === 'Equivalent') {
    if (!args.every(value => value === 'True' || value === 'False')) return null;
    const truths = args.map(value => value === 'True');
    return TRUTH(head === 'And' ? truths.every(Boolean) : head === 'Or' ? truths.some(Boolean)
      : head === 'Implies' ? !truths[0] || truths[1] : truths.every(value => value === truths[0]));
  }
  if (head === 'Element' && args[1] === 'Integers') {
    const value = jsonRational(args[0]); return value === null ? null : TRUTH(value.denominator === 1n);
  }
  if (!['Equal', 'NotEqual', 'Less', 'LessEqual', 'Greater', 'GreaterEqual'].includes(head)) return null;
  const rationals = args.map(jsonRational);
  if (rationals.some(value => value === null)) return null;
  for (let i = 0; i < rationals.length - 1; i++) {
    for (let j = i + 1; j < (head === 'NotEqual' ? rationals.length : i + 2); j++) {
      const a = rationals[i], b = rationals[j]; if (a === null || b === null) return null;
      const difference = a.numerator * b.denominator - b.numerator * a.denominator;
      if (!(head === 'Equal' ? difference === 0n : head === 'NotEqual' ? difference !== 0n : head === 'Less' ? difference < 0n
        : head === 'LessEqual' ? difference <= 0n : head === 'Greater' ? difference > 0n : difference >= 0n)) return 'False';
    }
  }
  return 'True';
}

export function createNativeMathBox(source: EngineMathJson, check: () => void, distributionAllowance?: (kind?:'elliptic') => void): MathBackendBox {
  function evaluate(input: EngineMathJson, numeric: boolean): EngineMathJson {
    let remaining = 100_000;
    function visit(value: EngineMathJson, scope: ReadonlyMap<string, EngineMathJson>, depth: number): EngineMathJson {
      if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '数式の計算範囲を超えています。');
      if ((remaining & 127) === 0) check();
      if (typeof value === 'string') {
        const bound = scope.get(value); if (bound !== undefined) return bound;
        const decimal = numeric ? jsonDecimal(value) : null;
        return decimal === null ? value : N(decimal.toString());
      }
      if ('num' in value) return value;
      const head = value[0], raw = value.slice(1);
      if (head === 'Lb' || head === 'Lg') return visit(['Log', raw[0], N(head === 'Lb' ? 2 : 10)], scope, depth + 1);
      if (head === 'Integrate') {
        const integrated = polynomialIntegral(value);
        if (integrated !== null) return visit(integrated, scope, depth + 1);
      }
      if (BINDERS.has(head)) return value;
      if (head === 'Sum' || head === 'Product') return discrete(value, scope, depth);
      if (head === 'Which') {
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const condition = visit(raw[i], scope, depth + 1);
          if (condition === 'True') return visit(raw[i + 1], scope, depth + 1);
          if (condition !== 'False') return value;
        }
        throw new MathInputProblem('domain', '値が定義される条件がありません。');
      }
      const testDistribution = TEST_DISTRIBUTION_HEADS.get(head);
      if (numeric && (head === 'BinomialQuantile' || head === 'PoissonQuantile')) {
        const parameters = raw.map(jsonRational);
        if (parameters.every(parameter => parameter !== null)) {
          return N((head === 'BinomialQuantile' ? binomialQuantile : poissonQuantile)(parameters, check));
        }
        throw new MathInputProblem('unsupported', '分位点の条件を整数・小数・分数に確定できません。');
      }
      if (numeric && testDistribution !== undefined) {
        distributionAllowance?.();
        const parameters = raw.map(jsonRational);
        if (parameters.every(parameter => parameter !== null)) return N(testDistributionDecimal(testDistribution, parameters, check));
        throw new MathInputProblem('unsupported', '分布の条件を整数・小数・分数に確定できません。');
      }
      const gammaBeta = GAMMA_BETA_HEADS.get(head);
      if (numeric && gammaBeta !== undefined) {
        distributionAllowance?.();
        const parameters = raw.map(jsonRational);
        if (parameters.every(parameter => parameter !== null)) return N(gammaBetaDistributionDecimal(gammaBeta, parameters, check));
        throw new MathInputProblem('unsupported', '分布の条件を整数・小数・分数に確定できません。');
      }
      const normal = NORMAL_HEADS.get(head);
      if (numeric && normal !== undefined) {
        const parameters = raw.map(jsonRational);
        if (parameters.every(parameter => parameter !== null)) return N(normalDistributionDecimal(normal, parameters, check));
        throw new MathInputProblem('unsupported', '正規分布の条件を整数・小数・分数に確定できません。');
      }
      const args = raw.map(child => visit(child, scope, depth + 1));
      if(numeric&&(head==='Zeta'||head==='ZetaDerivative')) {
        distributionAllowance?.();
        const index=head==='Zeta'?0:1,argument=jsonRational(raw[index])??jsonRational(args[index]);
        if(argument===null)throw new MathInputProblem('unsupported','ゼータ関数の引数を有限の実数へ確定できません。');
        if(head==='ZetaDerivative') {
          const order=jsonRational(raw[0])??jsonRational(args[0]);
          if(order===null||order.denominator!==1n||order.numerator<0n||order.numerator>17n) {
            throw new MathInputProblem('budget','ゼータ関数の微分の次数を0から17までの整数で指定してください。');
          }
          return N(zetaDerivatives(argument,Number(order.numerator),check)[Number(order.numerator)].decimal);
        }
        return N(zetaValue(argument,check).decimal);
      }
      const elliptic = ELLIPTIC_HEADS.get(head);
      if (numeric && elliptic !== undefined) {
        distributionAllowance?.('elliptic');
        const amplitudeIndex = elliptic === 'F' || elliptic === 'Einc' ? 0 : elliptic === 'Piinc' ? 1 : -1;
        const ratio = amplitudeIndex < 0 ? null : piRatio(raw[amplitudeIndex]);
        // Keep exact rational conditions and exact multiples of pi before numerical evaluation.
        const parameters = raw.map((child,index) => index === amplitudeIndex && ratio !== null ? ratio : jsonRational(child));
        if (!parameters.every(parameter => parameter !== null)) {
          throw new MathInputProblem('unsupported','楕円積分の条件を整数・小数・分数（振幅はπの倍数も可）に確定してください。');
        }
        return N(ellipticValue(elliptic, parameters, check, ratio !== null).decimal);
      }
      const airy = AIRY_HEADS.get(head);
      if (numeric && airy !== undefined) {
        const argument = jsonRational(raw[0]) ?? jsonRational(args[0]);
        if (argument === null) throw new MathInputProblem('unsupported', 'Airy関数の引数を有限の実数へ確定できません。');
        const result = airyValues(airy[0], argument, check);
        return N((airy[1] ? result.first : result.value).decimal);
      }
      if (numeric && head === 'LambertW') {
        distributionAllowance?.();
        const branch = jsonRational(raw[0]) ?? jsonRational(args[0]);
        const argument = jsonRational(raw[1]) ?? jsonRational(args[1]);
        if (branch === null || branch.denominator !== 1n || branch.numerator !== 0n && branch.numerator !== -1n) {
          throw new MathInputProblem('unsupported', '実数のLambert Wの枝は0または-1で指定してください。');
        }
        if (argument === null) throw new MathInputProblem('unsupported', 'Lambert Wの引数を有限の実数へ確定できません。');
        // Match the other scalar functions without rounding the certified digits again.
        return N(new Decimal(lambertWBounds(branch.numerator === 0n ? 0 : -1, argument, check).decimal).toString());
      }
      const bessel = BESSEL_HEADS.get(head);
      if (numeric && bessel !== undefined) {
        distributionAllowance?.();
        const order = jsonRational(raw[0]) ?? jsonRational(args[0]);
        const argument = jsonRational(raw[1]) ?? jsonRational(args[1]);
        if (order === null || order.denominator !== 1n || order.numerator < -128n || order.numerator > 128n) {
          throw new MathInputProblem('unsupported', 'Bessel関数の次数を-128から128までの整数で確定してください。');
        }
        if (argument === null) throw new MathInputProblem('unsupported', 'Bessel関数の引数を有限の実数へ確定できません。');
        return N(bessel === 'J' || bessel === 'I' ? integerBesselDecimal(bessel, Number(order.numerator), argument, check)
          : secondBesselDecimal(bessel, Number(order.numerator), argument, check));
      }
      if (numeric && head === 'Beta') {
        distributionAllowance?.();
        const a = jsonRational(raw[0]) ?? jsonRational(args[0]), b = jsonRational(raw[1]) ?? jsonRational(args[1]);
        if (a === null || b === null) throw new MathInputProblem('unsupported', 'Beta関数の引数を有限の実数へ確定できません。');
        return N(betaFunctionDecimal(a, b, check));
      }
      if (numeric && (head === 'Gamma' || head === 'Polygamma')) {
        distributionAllowance?.();
        const argumentIndex = head === 'Gamma' ? 0 : 1;
        const argument = jsonRational(raw[argumentIndex]) ?? jsonRational(args[argumentIndex]);
        if (argument === null) throw new MathInputProblem('unsupported', 'Gamma関数の引数を有限の実数へ確定できません。');
        if (head === 'Gamma') return N(gammaFunctionDecimal(argument, check));
        const order = jsonRational(raw[0]) ?? jsonRational(args[0]);
        if (order === null || order.denominator !== 1n || order.numerator < 0n || order.numerator > 17n) {
          throw new MathInputProblem('domain', 'Gamma関数の微分の次数は0から17までの整数で指定してください。');
        }
        return N(polygammaDecimal(Number(order.numerator), argument, check));
      }
      if (numeric && (head === 'Erf' || head === 'Erfc')) {
        distributionAllowance?.();
        const argument = jsonRational(raw[0]) ?? jsonRational(args[0]);
        if (argument !== null) return N(errorFunctionDecimal(head === 'Erf' ? 'erf' : 'erfc', argument, check));
        const original = complexParts(raw[0]), evaluated = complexParts(args[0]);
        const real = original === null ? null : jsonRational(original[0]);
        const imaginary = original === null ? null : jsonRational(original[1]);
        const a = real ?? (evaluated === null ? null : jsonRational(evaluated[0]));
        const b = imaginary ?? (evaluated === null ? null : jsonRational(evaluated[1]));
        if (a !== null && b !== null) {
          if (b.numerator === 0n) return N(errorFunctionDecimal(head === 'Erf' ? 'erf' : 'erfc', a, check));
          const result = complexErrorFunctionValue(head === 'Erf' ? 'erf' : 'erfc', a, b, check);
          return ['Complex', N(result.real.decimal), N(result.imaginary.decimal)];
        }
        throw new MathInputProblem('unsupported', '誤差関数の引数を有限の数へ確定できません。');
      }
      const rebuilt: EngineMathJson = [head, ...args];
      const piProduct = !numeric && (head === 'Multiply' || head === 'Divide') ? exactPiProduct(rebuilt) : null;
      if (piProduct !== null) return piProduct;
      const truth = booleanOperation(head, args); if (truth !== null) return truth;
      const complex = complexOperation(head, args, numeric, child => visit(child, scope, depth + 1));
      if (complex !== null) return visit(complex, scope, depth + 1);
      const rational = jsonRational(rebuilt);
      if (rational !== null) return numeric ? N(jsonDecimal(rationalJson(rational))?.toString() ?? '') : rationalJson(rational);
      const integer = exactIntegerOperation(head, args); if (integer !== null) return numeric ? visit(integer, scope, depth + 1) : integer;
      const trigonometric = exactTrigonometry(head, args); if (trigonometric !== null) return visit(trigonometric, scope, depth + 1);
      if (numeric) {
        const result = decimalOperation(head, args);
        // A real-only operation cannot guess a principal complex branch. SymPy handles it.
        if (result !== null && result !== 'NaN') return result;
      }
      return rebuilt;
    }
    function discrete(value: EngineMathJson[], scope: ReadonlyMap<string, EngineMathJson>, depth: number): EngineMathJson {
      const head = value[0], [body, range, ...rest] = value.slice(1);
      if (!Array.isArray(range) || range[0] !== 'Tuple' || typeof range[1] !== 'string'
        || range.length < 4 || range.length > 5 || typeof head !== 'string') return value as [string, ...EngineMathJson[]];
      const lower = jsonRational(visit(range[2], scope, depth + 1)), upper = jsonRational(visit(range[3], scope, depth + 1));
      const step = jsonRational(visit(range[4] ?? N(1), scope, depth + 1));
      if (lower === null || upper === null || step === null || lower.denominator !== 1n || upper.denominator !== 1n || step.denominator !== 1n || step.numerator === 0n) {
        return value as [string, ...EngineMathJson[]];
      }
      const count = (upper.numerator - lower.numerator) / step.numerator + 1n;
      if (count > 1000n) return value as [string, ...EngineMathJson[]];
      let result: EngineMathJson = N(head === 'Sum' ? 0 : 1), index = lower.numerator;
      for (let i = 0n; i < count && (step.numerator > 0n ? index <= upper.numerator : index >= upper.numerator); i++, index += step.numerator) {
        const nested = new Map(scope); nested.set(range[1], N(index));
        const term = visit(rest.length === 0 ? body : [head, body, ...rest], nested, depth + 1);
        result = visit([head === 'Sum' ? 'Add' : 'Multiply', result, term], scope, depth + 1);
      }
      return result;
    }
    check(); return visit(input, new Map(), 0);
  }
  return {
    json: source,
    evaluate: () => createNativeMathBox(evaluate(source, false), check, distributionAllowance),
    N: () => createNativeMathBox(evaluate(source, true), check, distributionAllowance),
  };
}
