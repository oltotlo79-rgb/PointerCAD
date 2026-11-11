// 固定glue 81cf6d92…の asmLibraryArg（名前空間a）だけを対象とする内部診断。
const registrationNames = [
  'yh', 'Wi', 'y', 'F', 'z', 'n', 'Ki', 'ob', 'nb', 'Uf', 'fc', 'sb', 'eg', 'Me', '_i',
] as const;
// 同じ固定glueの実tableから列挙する。未知名やaccessorは呼ばず、包まない。
const nonRegistrationNames = new Set(
  [
    'dj', 'ja', 'm', 'S', 'ma', 'b', 'l', 'Ld', 'mi', 'Ka', 'Ze', 'p', 'bh', 'g', 'fi', 'li',
    'Ie', 'kh', 'xi', 'hh', 'gh', 'df', 'ih', 'Oh', 'Kh', 'mc', 'Zj', 'Sj', 'Zg', 'Wj', 'Yg', 'Vj',
    'Uj', '$g', 'Tj', 'xc', 'Pi', 'Vh', 'dh', '$h', 'te', 'ch', 'bj', 'Dh', 'ue', 'eh', 'fh', 'lj',
    'He', 'ti', 'xh', 'qi', 'a', 'jj', 'Oj', 'Ij', 'Lj', 'yj', 'Gj', 'xj', 'Dj', 'vj', 'Bj', 'O',
    'ka', 'Ma', 'Y', 'Sc', 'Ad', 'hc', '_h', 'o', 'A', 'Db', 'cc', 'Pg', 'pe', 'Ve', 'xb', 'wj',
    'we', 'Gd', 'Gf', 'w', 'la', 'Da', 'gb', 'Qg', 'gc', 'yd', 'lb', 'pj', 'V', 'uj', 'hg', 'ug',
    'oj', 'Ab', '_b', 'nj', 'Jb', 'Yb', 'og', 'qf', 't', 'Bb', 'kd', 'aj', 've', 'Wf', 'Wb', 'Td',
    'sj', 'ef', 'Va', 'tc', 'ff', 'd', 'Q', 'R', 'ia', 'jd', 'Tg', 'qg', 'qe', 'bf', 'nf', 'qb',
    'ri', 'Yh', 'vg', 'bg', 'cg', 'Qi', '_a', 'Md', 'Qa', 'xg', 'ij', 'Xe', 'ni', 'pa', 'ad', 'se',
    'Hh', 'Le', 'za', 'Hb', 'Zh', 'Ta', 'yc', 'gg', 'Rc', 'ce', 'Mj', 'ud', 'Kc', 'Eg', 'c', 'K',
    'M', 'Na', 'Pa', 'id', 'Sa', 'Kj', 'Ce', 'Lc', 'Qj', 'Ug', 'Eh', 'ra', 'Te', 'Ye', 'Ig', 'sd',
    'Aa', 'Ib', 'gd', 'Gb', 'Mi', 'I', 'We', 'jg', 'sf', 'pf', 'Uh', 'P', 'Lb', 'od', 'Xg', 'Ia',
    'tg', 'na', 'Wh', 'zd', 'pc', 'jc', 'Th', 'h', 'N', 'va', 'pb', 'Hc', 'Yc', 'Yi', 'pi', '_c',
    'Wc', 'kc', 'fj', '$i', 'Bc', 'vf', 'kb', 'Sf', 'Ae', 're', 'Ja', 'hd', 'Ei', 'vb', 'zc', 'yi',
    'wi', 'hj', 'q', 'ya', 'Oa', 'Jc', 'Vf', 'Xf', 'Ai', 'Zc', 'Xc', 'yb', 'mg', 'kg', 'ng', 'fe',
    'Vi', 'Pj', 'vc', 'Ua', 'de', 'Fi', 'x', 'ha', '$b', 'ii', 'ig', 'zf', 'qc', 'Ag', 'he', 'Fd',
    'Ji', 'r', 'uc', 'Yf', 'Rh', 'xf', 'cj', 'lg', 'Di', 'Ph', 'ej', 'Ff', 'B', 'ei', 'Sh', 'Pc',
    'Ke', 'ed', 'Eb', 'ee', 'bd', 'Oc', 'Ni', 'da', 'Gc', 'mj', 'Ne', 'Fe', 'Ee', 'Za', 'Yd', 'Df',
    'cf', 'Ef', 'Wa', 'pd', 'Gg', 'Se', 'Xi', 'Ea', 'dd', 'Cc', 'vd', 'Og', '_e', 'ne', 'Xd', 'De',
    'Rg', 'Wd', 'oc', 'If', 'Sb', 'Hf', 'Ud', 'lh', 'ph', 'jh', 'uh', 'mh', 'th', 'k', 'Tc', 'Uc',
    '$e', 'lc', 'mf', 'Hg', 'Ga', 'wb', 'wg', '$a', 'ge', 'Oi', 'Mg', 'Id', 'Lg', 'Kg', 'Rb', 'ib',
    'Ec', 'Be', 'Ic', 'Ng', 'Cb', 'Ed', '$c', 'Vb', 'Mc', 'Ya', 'cd', '_f', 'i', 'J', '_', 'Ha',
    'Xa', 'rj', 'Fb', 'Nj', 'je', 'ke', 'Oe', 'Kd', 'Jf', 'Ch', 'Pb', 'Zi', 'Dc', 'Ge', 'Gi', 'bb',
    'Rd', 'dg', 'ec', '$', 'zj', 'ji', 'cb', 'fg', 'T', 'xd', 'ub', 'Xj', 'td', 'Sd', 'C', 'tb',
    'G', 'Vg', 'ba', 'rc', 'Zb', 'La', 'Li', 'bc', 'bi', 'e', 's', 'E', 'Z', 'Ca', 'Qb', 'sa',
    'ye', 'lf', 'Ob', 'gf', 'yg', 'af', 'le', 'hf', 'Sg', 'ie', 'Bd', 'Gh', 'X', 'Ue', 'rg', 'ga',
    'Ah', 'Nd', 'Xh', 'kj', 'wc', 'zi', 'Nb', 'Yj', 'qa', 'ta', 'nd', 'gj', 'wd', 'oa', 'Qe', 'Wg',
    'Kb', 'fd', 'rb', 'Jj', 'Hj', 'f', 'D', 'aa', 'zb', 'Xb', 'Ci', 'Qh', 'Re', 'uf', 'sg', 'Pe',
    'ci', 'qj', 'mb', 'di', 'of', 'Vd', 'ai', 'Jd', 'Cd', 'zh', 'ea', 'db', 'pg', 'wa', 'Fc', 'rd',
    'Nh', 'Ej', 'Ac', 'Tf', 'j', 'L', 'xa', 'md', 'Bg', 'Cg', '$f', 'rf', 'oi', 'ag', 'ca', 'Rj',
    'ab', 'Mb', 'Ii', 'Jg', 'Kf', 'v', 'W', 'jb', 'sc', 'ac', 'ld', 'yf', 'Tb', 'zg', 'Fh', 'xe',
    'Af', 'Hd', 'Fg', 'u', 'Ra', 'Bh', 'wf', 'kf', 'Fj', 'Qd', 'Dd', 'Nc', 'Od', 'Ub', 'H', 'nc',
    'Of', 'Pf', 'tf', 'Ti', 'Ui', 'Zd', 'be', 'fa', 'Jh', 'ze', 'Ih', 'ua', 'Qc', 'Aj', 'eb', 'tj',
    'Ba', 'Hi', 'Ri', 'Si', 'ki', 'Mf', 'Fa', 'Vc', 'qd', 'Nf', 'Pd', 'fb', 'dc', 'hb', 'oe', 'Lf',
    'me', 'Je', 'Bf', 'Cf', 'ae', '$d', 'Qf', '_d', 'Bi', 'ic', 'Lh', 'Zf', 'si', 'Rf', 'ui', 'vi',
    'Mh', 'Cj', 'jf', 'Dg', 'hi', 'gi', 'vh', 'oh', 'nh', 'wh', 'rh', 'qh', 'sh', 'U', '_g', 'ah',
  ],
);
const MAX_NON_REGISTRATION_DEPTH = 256;
const MAX_CALLS = 1_000_000;

interface Row {
  readonly name: string;
  calls: number;
  exclusiveMs: number;
}

interface NonRegistrationRow {
  readonly name: string;
  calls: number;
  gapExclusiveMs: number;
}

interface Frame {
  childMs: number;
}

/** パッケージ公開口へは出さない。診断offでは入力表もclockもそのまま保持する。 */
export function createRegistrationImportProbe(
  imports: WebAssembly.Imports,
  enabled: boolean,
  observe: (phase: string) => void,
  clock: () => number = () => performance.now(),
) {
  let active = false;
  let finished = false;
  let valid = true;
  let bounded = false;
  let totalCalls = 0;
  // 既存の呼出し前後のclockだけを使う。入れ子を含む外側区間と、その間を分ける。
  let firstOuterStart: number | undefined;
  let lastOuterEnd: number | undefined;
  let lastOuterName: string | undefined;
  let outerCalls = 0;
  let betweenOuterCallsMs = 0;
  let largestGapMs = 0;
  let largestGapAfter: string | undefined;
  let largestGapBefore: string | undefined;
  const rows: Row[] = [];
  const stack: Frame[] = [];
  const nonRegistrationStack: NonRegistrationRow[] = [];
  const nonRegistrationRows: NonRegistrationRow[] = [];
  const pendingGap = new Map<NonRegistrationRow, number>();
  let nonRegistrationCalls = 0;
  let gapNonRegistrationMs = 0;
  let lastBoundary: number | undefined;
  // 登録内では既存Eに含める。次の外側登録が来るまで末尾のgapは未確定。
  const accountBoundary = (now: number): void => {
    if (lastBoundary !== undefined) {
      const elapsed = now - lastBoundary;
      if (!Number.isFinite(elapsed) || elapsed < 0) valid = false;
      else if (stack.length === 0 && lastOuterEnd !== undefined) {
        const row = nonRegistrationStack.at(-1);
        if (row !== undefined) pendingGap.set(row, (pendingGap.get(row) ?? 0) + elapsed);
      }
    }
    lastBoundary = now;
  };
  const commitGap = (): void => {
    for (const [row, elapsed] of pendingGap) {
      row.gapExclusiveMs += elapsed;
      gapNonRegistrationMs += elapsed;
      if (!Number.isFinite(row.gapExclusiveMs) || !Number.isFinite(gapNonRegistrationMs)) valid = false;
    }
    pendingGap.clear();
  };
  const readClock = (): number | undefined => {
    try {
      const now = clock();
      if (Number.isFinite(now)) { accountBoundary(now); return now; }
    } catch { /* 診断の失敗を元の呼出しへ伝えない。 */ }
    valid = false;
    return undefined;
  };
  let prepared = imports;
  if (enabled) {
    const namespace = Object.getOwnPropertyDescriptor(imports, 'a');
    const table: unknown = namespace?.value;
    if (table !== null && typeof table === 'object') {
      const descriptors = Object.getOwnPropertyDescriptors(table);
      for (const name of nonRegistrationNames) {
        const descriptor = descriptors[name];
        const original: unknown = descriptor?.value;
        if (descriptor === undefined || typeof original !== 'function') continue;
        const row: NonRegistrationRow = { name, calls: 0, gapExclusiveMs: 0 };
        nonRegistrationRows.push(row);
        descriptors[name] = {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]): unknown {
            if (!active || finished || bounded) return Reflect.apply(original, this, args);
            if (totalCalls + nonRegistrationCalls >= MAX_CALLS ||
                nonRegistrationStack.length >= MAX_NON_REGISTRATION_DEPTH) {
              bounded = true;
              return Reflect.apply(original, this, args);
            }
            nonRegistrationCalls += 1;
            row.calls += 1;
            readClock();
            nonRegistrationStack.push(row);
            try {
              return Reflect.apply(original, this, args);
            } catch (error) {
              valid = false;
              throw error;
            } finally {
              readClock();
              nonRegistrationStack.pop();
            }
          },
        };
      }
      for (const name of registrationNames) {
        const descriptor = descriptors[name];
        const original: unknown = descriptor?.value;
        if (descriptor === undefined || typeof original !== 'function') continue;
        const row: Row = { name, calls: 0, exclusiveMs: 0 };
        rows.push(row);
        descriptors[name] = {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]): unknown {
            if (!active || finished || totalCalls + nonRegistrationCalls >= MAX_CALLS) {
              if (active && !finished) bounded = true;
              return Reflect.apply(original, this, args);
            }
            totalCalls += 1;
            row.calls += 1;
            const started = readClock();
            if (stack.length === 0) commitGap();
            const frame: Frame = { childMs: 0 };
            stack.push(frame);
            try {
              return Reflect.apply(original, this, args);
            } finally {
              const ended = readClock();
              stack.pop();
              if (started !== undefined && ended !== undefined && ended >= started &&
                  Number.isFinite(ended - started) && ended - started >= frame.childMs) {
                const elapsed = ended - started;
                row.exclusiveMs += Math.max(0, elapsed - frame.childMs);
                const parent = stack.at(-1);
                if (parent !== undefined) parent.childMs += elapsed;
                else {
                  if (lastOuterEnd !== undefined) {
                    const gap = started - lastOuterEnd;
                    if (!Number.isFinite(gap) || gap < 0) valid = false;
                    else {
                      betweenOuterCallsMs += gap;
                      if (gap > largestGapMs) {
                        largestGapMs = gap;
                        largestGapAfter = lastOuterName;
                        largestGapBefore = name;
                      }
                    }
                  }
                  firstOuterStart ??= started;
                  lastOuterEnd = ended;
                  lastOuterName = name;
                  outerCalls += 1;
                }
              } else valid = false;
            }
          },
        };
      }
      if ((rows.length > 0 || nonRegistrationRows.length > 0) && namespace !== undefined) {
        const clone: WebAssembly.ModuleImports = {};
        Object.setPrototypeOf(clone, Reflect.getPrototypeOf(table));
        Object.defineProperties(clone, descriptors);
        const outerDescriptors = Object.getOwnPropertyDescriptors(imports);
        outerDescriptors['a'] = { ...namespace, value: clone };
        prepared = {};
        Object.setPrototypeOf(prepared, Reflect.getPrototypeOf(imports));
        Object.defineProperties(prepared, outerDescriptors);
      }
    }
  }
  return {
    imports: prepared,
    begin(): void { if (enabled && !finished) active = true; },
    finish(completed: boolean): void {
      if (!enabled || finished) return;
      finished = true;
      active = false;
      const spanMs = firstOuterStart !== undefined && lastOuterEnd !== undefined
        ? lastOuterEnd - firstOuterStart : undefined;
      if (spanMs !== undefined && !Number.isFinite(spanMs)) valid = false;
      if (gapNonRegistrationMs > betweenOuterCallsMs + 1e-6) valid = false;
      const largest = nonRegistrationRows.reduce<NonRegistrationRow | undefined>((best, row) =>
        row.gapExclusiveMs > (best?.gapExclusiveMs ?? 0) ? row : best, undefined);
      const complete = completed && valid && !bounded && stack.length === 0 && nonRegistrationStack.length === 0;
      const ticket = {
        completed: complete,
        valid, bounded,
        coverageComplete: rows.length === registrationNames.length,
        rows: rows.map(row => ({ ...row })),
        // callsはreceive中の実呼出し数。時間Nと最大aliasは確定した登録間Gだけ。
        nonRegistration: complete && spanMs !== undefined ? {
          calls: nonRegistrationCalls,
          gapExclusiveMs: gapNonRegistrationMs,
          largestContributor: largest === undefined ? null : {
            name: largest.name, calls: largest.calls, gapExclusiveMs: largest.gapExclusiveMs,
          },
        } : null,
        // receive全体でもCPU時間でもない。未完了・上限・不正clockは区間を確定しない。
        outerSpan: complete &&
          spanMs !== undefined ? {
            calls: outerCalls,
            spanMs,
            betweenCallsMs: betweenOuterCallsMs,
            largestGapMs,
            largestGapAfter: largestGapAfter ?? null,
            largestGapBefore: largestGapBefore ?? null,
          } : null,
      };
      try { observe(`registration-import-probe:${JSON.stringify(ticket)}`); }
      catch { /* 元の成功・例外・取消を観測先が変更しない。 */ }
    },
  };
}
