// Sensor Cross-Check: P&ID-derived analytical redundancy for test-stand telemetry.
//
// 1. Relations come from the P&ID: every component between two (or more) sensed points
//    gives one physical relation (feed line, venturi-to-valve line, injector, combustion, thrust takeout).
// 2. Each relation is fit on nominal runs (OLS on physically motivated linear features) and gives a
//    residual channel r_e(t).
// 3. Alert thresholds use RevelCode's persistence() semantics (|r| beyond q for N consecutive cycles)
//    and are calibrated with split conformal prediction over whole runs, so the probability that ANY
//    cross-check alert fires on a new nominal run is <= alpha (finite sample, runs exchangeable).
// 4. When residuals fire, a generalized likelihood ratio over whitened residuals ranks single-fault
//    hypotheses (one sensor biased, or one component changed). Hypotheses whose fault directions are
//    parallel form ambiguity groups that the instrumentation cannot separate.
// 5. The isolated sensor gets a virtual reading from the remaining relations, with a conformal interval.
//
// Pure ES module, no dependencies. Works in the browser and under `node --test`.

export const DT = 0.01;            // 100 Hz control loop for this stand
export const PERSIST = 20;         // persistence window in cycles (200 ms)
export const ARM_SETTLE = 0.30;    // seconds after MAINSTAGE entry before relations arm
export const ISO_WINDOW = 30;      // cycles averaged for isolation

export const STATES = ['PRESS', 'IGNITION', 'RAMP', 'MAINSTAGE', 'SHUTDOWN', 'SAFE'];

export const CHANNELS = [
  { id: 'PT_FT_01', label: 'Fuel Tank', unit: 'psi' },
  { id: 'PT_OT_02', label: 'OX Tank', unit: 'psi' },
  { id: 'PT_FV_11', label: 'Fuel Venturi', unit: 'psi' },
  { id: 'PT_OV_12', label: 'OX Venturi', unit: 'psi' },
  { id: 'PT_FVX_13', label: 'Fuel Venturi Exit', unit: 'psi' },
  { id: 'PT_FM_21', label: 'Fuel Manifold', unit: 'psi' },
  { id: 'PT_OM_22', label: 'OX Manifold', unit: 'psi' },
  { id: 'PT_CC_31', label: 'Chamber Pressure', unit: 'psi' },
  { id: 'LC_TH_41', label: 'Engine Thrust', unit: 'lbf' },
];
export const CH_IDS = CHANNELS.map(c => c.id);

// Relations derived from the P&ID. `target` is regressed on `features` (linear, with intercept).
// `component` is the hardware between the sensed points: a change in it shifts only this relation.
export const RELATIONS = [
  { id: 'fuel_feed', name: 'Fuel feed line', component: 'Fuel feed line', target: 'PT_FV_11', features: ['PT_FT_01'] },
  { id: 'ox_feed', name: 'OX feed line', component: 'OX feed line', target: 'PT_OV_12', features: ['PT_OT_02'] },
  { id: 'fuel_mfv', name: 'Main fuel valve', component: 'FV06 + line', target: 'PT_FVX_13', features: ['PT_FM_21', 'PT_FV_11'] },
  { id: 'fuel_injector', name: 'Fuel injector', component: 'Fuel injector', target: 'PT_FM_21', features: ['PT_CC_31', 'PT_FV_11'] },
  { id: 'ox_injector', name: 'OX injector', component: 'OX injector', target: 'PT_OM_22', features: ['PT_CC_31', 'PT_OV_12'] },
  { id: 'combustion', name: 'Combustion (c*)', component: 'Combustion (c*)', target: 'PT_CC_31', features: ['PT_FV_11', 'PT_OV_12'] },
  { id: 'thrust', name: 'Thrust takeout', component: 'Thrust takeout', target: 'LC_TH_41', features: ['PT_CC_31'] },
];

// Hand-written redlines a customer would already have (RevelCode alerts). Evaluated in the simulator.
export const REDLINES = [
  { id: 'Fuel_manifold_low_pres', ch: 'PT_FM_21', op: '<', value: 250.0, n: 3 },
  { id: 'Fuel_manifold_high_pres', ch: 'PT_FM_21', op: '>', value: 345.0, n: 3 },
  { id: 'MCC_low_pres', ch: 'PT_CC_31', op: '<', value: 200.0, n: 3 },
  { id: 'MCC_Back_Flow', diff: ['PT_CC_31', 'PT_FM_21'], op: '>', value: 0.0, n: 3 },
];

// ---------------------------------------------------------------- random numbers
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussFactory(rand) {
  let spare = null;
  return function () {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = rand();
    v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// ---------------------------------------------------------------- simulator
// Pressure-fed LOX/RP-1 500 lbf thruster on a test stand with cavitating venturis.
// Nominal: fuel tank 350, fuel venturi 340, venturi exit 306, fuel manifold 300, chamber 250,
// ox tank 380, ox venturi 370, ox manifold 320 psi; thrust 500 lbf; MR 2.6.
const NOM = {
  mf0: 0.556, mo0: 1.444,
  Kvf: 0.556 / Math.sqrt(340), Kvo: 1.444 / Math.sqrt(370),
  Lf: 10, Lo: 10,                     // feed line loss at nominal flow (psi)
  Kc: 125,                            // psi per lb/s at eta = 1
  kif: 50 / (0.556 * 0.556),          // fuel injector dP coefficient
  kio: 70 / (1.444 * 1.444),          // ox injector dP coefficient
  kl: 6 / (0.556 * 0.556),            // venturi exit -> manifold (main fuel valve + line)
  Kt: 2.06, Famb: 15,
};

export function smoothstep(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }

/**
 * Simulate one hot fire. opts: { seed, name, mainstage (s), fault, redlines (default true) }
 * fault: { type: 'sensor_drift'|'sensor_shift'|'injector_fuel'|'combustion', ch, t0 (s after mainstage entry), rate, size, factor }
 */
export function simulateRun(opts) {
  const seed = opts.seed >>> 0;
  const rand = mulberry32(seed);
  const g = gaussFactory(rand);
  const U = (a, b) => a + (b - a) * rand();

  // run-to-run variation (setpoints, hardware tolerances, transducer zero shifts)
  const pft = U(334, 366), pot = U(362, 398);
  const droopF = U(1.5, 3.5), droopO = U(1.5, 3.5);
  const Kvf = NOM.Kvf * (1 + 0.004 * g()), Kvo = NOM.Kvo * (1 + 0.004 * g());
  const Lf = NOM.Lf * (1 + 0.03 * g()), Lo = NOM.Lo * (1 + 0.03 * g());
  let kif = NOM.kif * (1 + 0.012 * g());
  const kio = NOM.kio * (1 + 0.012 * g());
  const kl = NOM.kl * (1 + 0.02 * g());
  let eta = 1 + 0.006 * g();
  const Kt = NOM.Kt * (1 + 0.003 * g());
  const kif0 = kif, eta0 = eta;
  const zero = {}, gain = {}, sig = {};
  for (const c of CH_IDS) {
    zero[c] = c === 'LC_TH_41' ? 1.5 * g() : 0.5 * g();
    gain[c] = 1 + 0.0015 * g();
    sig[c] = c === 'LC_TH_41' ? 1.8 : c === 'PT_CC_31' ? 0.7 : 0.55;
  }
  const ripF = { a: U(0.4, 0.9), f: U(1.2, 2.2), p: U(0, 6.28) };
  const ripO = { a: U(0.4, 0.9), f: U(1.2, 2.2), p: U(0, 6.28) };

  const jit = () => 0.02 * g();
  const tIgn = 1.0 + jit(), tRamp = 1.25 + jit(), tMain = 1.75 + jit();
  const D = opts.mainstage ?? U(3.6, 4.4);
  let tShut = tMain + D;
  const tEnd = tShut + 1.0;
  const n = Math.round(tEnd / DT);

  const fault = opts.fault || null;
  const useRedlines = opts.redlines !== false;

  const t = new Float64Array(n), state = new Uint8Array(n);
  const ch = {}; for (const c of CH_IDS) ch[c] = new Float64Array(n);
  const truth = {}; for (const c of CH_IDS) truth[c] = new Float64Array(n);

  let pcLag = 0, rough = 0, fmLag = 0, omLag = 0;
  let abort = null;
  const redCount = {}; for (const r of REDLINES) redCount[r.id] = 0;

  for (let i = 0; i < n; i++) {
    const ti = i * DT; t[i] = ti;
    let st;
    if (ti < tIgn) st = 0; else if (ti < tRamp) st = 1; else if (ti < tMain) st = 2; else if (ti < tShut) st = 3; else if (ti < tShut + 0.5) st = 4; else st = 5;
    state[i] = st;

    // tanks: pressurize to setpoint during PRESS, droop while flowing, regulator ripple
    const pressFrac = 1 - Math.exp(-ti / 0.18);
    const flowT = Math.max(0, Math.min(ti, tShut) - tMain);
    const PFT = pft * pressFrac - droopF * flowT + ripF.a * Math.sin(2 * Math.PI * ripF.f * ti + ripF.p) * pressFrac;
    const POT = pot * pressFrac - droopO * flowT + ripO.a * Math.sin(2 * Math.PI * ripO.f * ti + ripO.p) * pressFrac;

    // valve opening fraction
    let s;
    if (ti < tRamp) s = 0; else if (ti < tMain) s = smoothstep((ti - tRamp) / (tMain - tRamp)); else if (ti < tShut) s = 1; else s = 1 - smoothstep((ti - tShut) / 0.3);

    // process faults
    if (fault && fault.type === 'injector_fuel') {
      const tf = tMain + fault.t0;
      const k = smoothstep((ti - tf) / 0.05);
      kif = kif0 * (1 + (fault.factor - 1) * k);
    }
    if (fault && fault.type === 'combustion') {
      const tf = tMain + fault.t0;
      eta = eta0 * (1 - fault.size * smoothstep((ti - tf) / 0.05));
    }

    // cavitating venturi flows (fixed point on feed line loss)
    let PFV = PFT, POV = POT, mf = 0, mo = 0;
    for (let k = 0; k < 3; k++) {
      mf = s * Kvf * Math.sqrt(Math.max(PFV, 0));
      mo = s * Kvo * Math.sqrt(Math.max(POV, 0));
      PFV = PFT - Lf * (mf / NOM.mf0) ** 2;
      POV = POT - Lo * (mo / NOM.mo0) ** 2;
    }
    const MR = mf > 0.02 ? mo / mf : 2.6;
    const etaMR = eta * (1 - 0.12 * (MR - 2.6) ** 2);
    let pcSS = NOM.Kc * etaMR * (mf + mo);
    if (st === 1) pcSS = Math.max(pcSS, 12);
    pcLag += (pcSS - pcLag) * (DT / 0.02);
    rough = 0.6 * rough + 0.8 * g() * (pcLag > 50 ? 1 : 0.1);
    const PC = Math.max(0, pcLag + rough);
    const fmSS = s > 0 ? PC + kif * mf * mf : 0;
    const omSS = s > 0 ? PC + kio * mo * mo : 0;
    fmLag += (fmSS - fmLag) * (DT / 0.015);
    omLag += (omSS - omLag) * (DT / 0.015);
    const PFM = fmLag, POM = omLag;
    const PFVX = (1 - s) * PFV + s * (PFM + kl * mf * mf);
    const F = PC > 40 ? Kt * PC - NOM.Famb : Kt * PC * (1 - NOM.Famb / (Kt * 40));

    const tv = { PT_FT_01: PFT, PT_OT_02: POT, PT_FV_11: PFV, PT_OV_12: POV, PT_FVX_13: PFVX, PT_FM_21: PFM, PT_OM_22: POM, PT_CC_31: PC, LC_TH_41: F };
    for (const c of CH_IDS) {
      truth[c][i] = tv[c];
      let m = tv[c] * gain[c] + zero[c] + sig[c] * g();
      if (fault && fault.ch === c && ti >= tMain + fault.t0) {
        const dtf = ti - (tMain + fault.t0);
        if (fault.type === 'sensor_drift') m += -fault.rate * dtf + 0.5 * sig[c] * g();
        if (fault.type === 'sensor_shift') m += fault.size * smoothstep(dtf / 0.08);
      }
      ch[c][i] = m;
    }

    // existing redlines (armed in MAINSTAGE): abort -> SHUTDOWN
    if (useRedlines && st === 3 && !abort && ti >= tMain + ARM_SETTLE) {
      for (const r of REDLINES) {
        const v = r.diff ? ch[r.diff[0]][i] - ch[r.diff[1]][i] : ch[r.ch][i];
        const hit = r.op === '<' ? v < r.value : v > r.value;
        redCount[r.id] = hit ? redCount[r.id] + 1 : 0;
        if (redCount[r.id] >= r.n) { abort = { alert: r.id, t: ti, i }; tShut = ti + DT; break; }
      }
    }
  }
  return {
    name: opts.name || `run_${seed}`, seed, n, t, state, ch, truth,
    events: { ignition: tIgn, ramp: tRamp, mainstage: tMain, shutdown: tShut, end: tEnd },
    setpoints: { fuelTank: pft, oxTank: pot }, abort, fault,
  };
}
// ---------------------------------------------------------------- linear algebra helpers
export function solveSPD(A, b) {
  // Cholesky solve, A is k x k (array of arrays)
  const L = cholesky(A);
  const k = b.length, y = new Array(k).fill(0), x = new Array(k).fill(0);
  for (let i = 0; i < k; i++) { let s = b[i]; for (let j = 0; j < i; j++) s -= L[i][j] * y[j]; y[i] = s / L[i][i]; }
  for (let i = k - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < k; j++) s -= L[j][i] * x[j]; x[i] = s / L[i][i]; }
  return x;
}
export function cholesky(A) {
  const k = A.length, L = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j]; for (let m = 0; m < j; m++) s -= L[i][m] * L[j][m];
    if (i === j) { if (s <= 1e-12) s = 1e-12; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return L;
}
export function forwardSub(L, b) {
  const k = b.length, y = new Array(k).fill(0);
  for (let i = 0; i < k; i++) { let s = b[i]; for (let j = 0; j < i; j++) s -= L[i][j] * y[j]; y[i] = s / L[i][i]; }
  return y;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// ---------------------------------------------------------------- arming and residuals
export function armedMask(run) {
  const m = new Uint8Array(run.n);
  const t0 = run.events.mainstage + ARM_SETTLE, t1 = run.events.shutdown;
  for (let i = 0; i < run.n; i++) m[i] = run.state[i] === 3 && run.t[i] >= t0 && run.t[i] < t1 ? 1 : 0;
  return m;
}

export function fitRelations(runs) {
  const rels = [];
  for (const R of RELATIONS) {
    const k = R.features.length + 1;
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
    let ny = 0, sy = 0, syy = 0;
    for (const run of runs) {
      const m = armedMask(run);
      for (let i = 0; i < run.n; i++) if (m[i]) {
        const x = [1, ...R.features.map(f => run.ch[f][i])], y = run.ch[R.target][i];
        for (let a = 0; a < k; a++) { Xty[a] += x[a] * y; for (let b = 0; b < k; b++) XtX[a][b] += x[a] * x[b]; }
        ny++; sy += y; syy += y * y;
      }
    }
    for (let a = 1; a < k; a++) XtX[a][a] *= 1 + 1e-9;
    const beta = solveSPD(XtX, Xty);
    rels.push({ ...R, beta, ny, ymean: sy / ny, yvar: syy / ny - (sy / ny) ** 2 });
  }
  return rels;
}

export function residuals(rels, run) {
  const m = armedMask(run);
  const r = rels.map(() => new Float64Array(run.n).fill(NaN));
  rels.forEach((R, e) => {
    for (let i = 0; i < run.n; i++) if (m[i]) {
      let p = R.beta[0]; R.features.forEach((f, j) => { p += R.beta[j + 1] * run.ch[f][i]; });
      r[e][i] = run.ch[R.target][i] - p;
    }
  });
  return { r, mask: m };
}

function robustScale(arr) {
  const v = Float64Array.from(arr).sort();
  const med = v[Math.floor(v.length / 2)];
  const dev = Float64Array.from(v, x => Math.abs(x - med)).sort();
  return 1.4826 * dev[Math.floor(dev.length / 2)];
}
function covariance(rows) {
  const k = rows[0].length, mu = new Array(k).fill(0);
  for (const r of rows) for (let a = 0; a < k; a++) mu[a] += r[a] / rows.length;
  const C = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of rows) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) C[a][b] += (r[a] - mu[a]) * (r[b] - mu[b]) / (rows.length - 1);
  return C;
}

// ---------------------------------------------------------------- persistence statistic
// Largest q such that u > q for N consecutive armed cycles, or u < -q for N consecutive armed cycles.
// alert fires at threshold Q exactly when sustained > Q (RevelCode: persistence(u > Q, N) or persistence(u < -Q, N)).
export function sustainedSeries(u, mask, N = PERSIST) {
  const out = new Float64Array(u.length).fill(NaN);
  let run = 0;
  for (let i = 0; i < u.length; i++) {
    if (!mask[i] || !Number.isFinite(u[i])) { run = 0; continue; }
    run++;
    if (run >= N) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i - N + 1; j <= i; j++) { if (u[j] < lo) lo = u[j]; if (u[j] > hi) hi = u[j]; }
      out[i] = Math.max(lo, -hi);
    }
  }
  return out;
}
// Signed version for display: lo if the whole window is positive, hi if the whole window is negative, else 0.
export function sustainedSigned(u, mask, N = PERSIST) {
  const out = new Float64Array(u.length).fill(NaN);
  let run = 0;
  for (let i = 0; i < u.length; i++) {
    if (!mask[i] || !Number.isFinite(u[i])) { run = 0; continue; }
    run++;
    if (run >= N) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i - N + 1; j <= i; j++) { if (u[j] < lo) lo = u[j]; if (u[j] > hi) hi = u[j]; }
      out[i] = lo > 0 ? lo : hi < 0 ? hi : 0;
    }
  }
  return out;
}
export function maxFinite(a) { let m = -Infinity; for (const v of a) if (Number.isFinite(v) && v > m) m = v; return m; }

export function conformalQuantile(scores, alpha) {
  const s = [...scores].sort((a, b) => a - b), n = s.length;
  const k = Math.ceil((n + 1) * (1 - alpha));
  return k > n ? Infinity : s[k - 1];
}
// P(Binomial(n, p) >= a)
function binomTail(n, p, a) {
  let s = 0, term = Math.pow(1 - p, n);
  for (let k = 0; k <= n; k++) { if (k >= a) s += term; term = term * (n - k) / (k + 1) * p / (1 - p); }
  return s;
}
// With threshold = k-th smallest of n calibration scores, the realized false-alert rate is
// Beta(n + 1 - k, k). Return its upper (1 - delta) quantile: a calibration-conditional bound.
export function betaUpperBound(n, k, delta = 0.1) {
  if (k > n) return 0;
  const a = n + 1 - k, b = k;
  let lo = 0, hi = 1;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const cdf = binomTail(a + b - 1, mid, a); // P(Beta(a,b) <= mid)
    if (cdf < 1 - delta) lo = mid; else hi = mid;
  }
  return hi;
}
export function conformalPValue(scores, x) {
  let c = 0; for (const s of scores) if (s >= x) c++;
  return (1 + c) / (scores.length + 1);
}

// ---------------------------------------------------------------- model
export function buildModel(trainRuns) {
  const rels = fitRelations(trainRuns);
  const E = rels.length;
  const pooled = rels.map(() => []), rows = [], wrows = [];
  const opMean = Object.fromEntries(CH_IDS.map(c => [c, 0])); let opN = 0;
  for (const run of trainRuns) {
    const { r, mask } = residuals(rels, run);
    const idx = []; for (let i = 0; i < run.n; i++) if (mask[i]) idx.push(i);
    for (const i of idx) {
      const v = r.map(x => x[i]); rows.push(v); v.forEach((x, e) => pooled[e].push(x));
      for (const c of CH_IDS) opMean[c] += run.ch[c][i]; opN++;
    }
    for (let s = 0; s + ISO_WINDOW <= idx.length; s += ISO_WINDOW) {
      const w = new Array(E).fill(0);
      for (let j = s; j < s + ISO_WINDOW; j++) for (let e = 0; e < E; e++) w[e] += r[e][idx[j]] / ISO_WINDOW;
      wrows.push(w);
    }
  }
  for (const c of CH_IDS) opMean[c] /= opN;
  const scale = pooled.map(robustScale);
  const Sigma = covariance(rows), SigmaW = covariance(wrows);
  const LW = cholesky(SigmaW), LS = cholesky(Sigma);
  rels.forEach((R, e) => { R.r2 = 1 - Sigma[e][e] / R.yvar; });
  const G = sensitivity(rels);
  const hyps = hypotheses(rels, G, LW);
  return { rels, scale, Sigma, SigmaW, LW, LS, G, hyps, opMean, nTrain: trainRuns.length, trainNames: trainRuns.map(r => r.name) };
}

// G[e][c] = d r_e / d s_c (linear relations -> exact)
export function sensitivity(rels) {
  return rels.map(R => CH_IDS.map(c => {
    let d = c === R.target ? 1 : 0;
    R.features.forEach((f, j) => { if (f === c) d -= R.beta[j + 1]; });
    return d;
  }));
}

// single-fault hypotheses and their whitened directions; parallel directions -> ambiguity group
export function hypotheses(rels, G, LW) {
  const E = rels.length, list = [];
  CH_IDS.forEach((c, j) => {
    const g = G.map(row => row[j]);
    if (g.every(x => Math.abs(x) < 1e-9)) return;
    list.push({ key: 'sensor:' + c, kind: 'sensor', ch: c, label: c, g });
  });
  rels.forEach((R, e) => {
    const g = new Array(E).fill(0); g[e] = 1;
    list.push({ key: 'component:' + R.id, kind: 'component', rel: R.id, label: R.component, g });
  });
  for (const h of list) { h.d = forwardSub(LW, h.g); h.dd = dot(h.d, h.d); }
  let gid = 0;
  for (const h of list) {
    if (h.group !== undefined) continue;
    h.group = gid;
    for (const o of list) if (o.group === undefined) {
      const cos = Math.abs(dot(h.d, o.d)) / Math.sqrt(h.dd * o.dd);
      if (cos > 0.995) o.group = gid;
    }
    gid++;
  }
  return list;
}

export function ambiguityGroups(model) {
  const groups = {};
  for (const h of model.hyps) (groups[h.group] ||= []).push(h);
  return Object.values(groups);
}

// GLR isolation on a window-mean residual vector rbar
export function isolate(model, rbar) {
  const z = forwardSub(model.LW, rbar), zz = dot(z, z);
  const res = model.hyps.map(h => {
    const proj = dot(h.d, z), b = proj / h.dd;
    return { ...h, bias: b, J: zz - proj * proj / h.dd };
  });
  // collapse ambiguity groups (identical J up to numerics) keeping members
  const byGroup = {};
  for (const h of res) (byGroup[h.group] ||= []).push(h);
  const groups = Object.values(byGroup).map(m => {
    m.sort((a, b) => a.J - b.J);
    return { members: m, J: m[0].J, best: m[0], ambiguous: m.length > 1 };
  }).sort((a, b) => a.J - b.J);
  const J0 = groups[0].J;
  let tot = 0; for (const g of groups) { g.w = Math.exp(-(g.J - J0) / 2); tot += g.w; }
  for (const g of groups) g.likelihood = g.w / tot;
  return { z, J_nominal: zz, groups };
}

// ---------------------------------------------------------------- calibration
export function runScore(model, run) {
  const { r, mask } = residuals(model.rels, run);
  let S = -Infinity, arg = -1;
  const sus = r.map((re, e) => {
    const u = Float64Array.from(re, x => x / model.scale[e]);
    const s = sustainedSeries(u, mask);
    const m = maxFinite(s); if (m > S) { S = m; arg = e; }
    return s;
  });
  return { S, arg, r, mask, sus };
}

function windowMean(r, idx, start) {
  const E = r.length, w = new Array(E).fill(0);
  const s = Math.max(0, Math.min(start, idx.length - ISO_WINDOW));
  const len = Math.min(ISO_WINDOW, idx.length);
  for (let j = s; j < s + len; j++) for (let e = 0; e < E; e++) w[e] += r[e][idx[j]] / len;
  return w;
}

export function calibrate(model, calRuns, alpha = 0.05, opts = {}) {
  const seed = opts.seed ?? 7, mode = opts.mode ?? 'pac', delta = opts.delta ?? 0.1;
  const rand = mulberry32(seed);
  const scores = [], isoBest = [], isoNom = [], virt = Object.fromEntries(CH_IDS.map(c => [c, []]));
  for (const run of calRuns) {
    const sc = runScore(model, run);
    scores.push(sc.S);
    const idx = []; for (let i = 0; i < run.n; i++) if (sc.mask[i]) idx.push(i);
    const w = windowMean(sc.r, idx, Math.floor(rand() * (idx.length - ISO_WINDOW)));
    const iso = isolate(model, w);
    isoBest.push(iso.groups[0].J); isoNom.push(iso.J_nominal);
    // virtual-sensor error (smoothed, as displayed) at one random armed cycle per run (exchangeable across runs)
    const i = idx[Math.floor(rand() * idx.length)];
    for (const c of CH_IDS) {
      const h = model.hyps.find(x => x.key === 'sensor:' + c); if (!h) continue;
      const vb = virtualBias(model, h, sc.r, idx, run.n);
      virt[c].push(Math.abs(vb[i]));
    }
  }
  const n = scores.length, sorted = [...scores].sort((a, b) => a - b);
  let k = Math.ceil((n + 1) * (1 - alpha));
  if (mode === 'pac') {
    // smallest k whose realized false-alert rate is <= alpha with probability >= 1 - delta
    k = n;
    for (let kk = Math.ceil((n + 1) * (1 - alpha)); kk <= n; kk++) if (betaUpperBound(n, kk, delta) <= alpha) { k = kk; break; }
  }
  const Q = k > n ? Infinity : sorted[k - 1];
  const thresholds = model.scale.map(s => Q * s);
  const virtQ = Object.fromEntries(Object.entries(virt).map(([c, v]) => [c, v.length ? conformalQuantile(v, 0.10) : NaN]));
  const bound90 = betaUpperBound(n, k, delta);
  const feasible = mode === 'pac' ? bound90 <= alpha + 1e-12 : k <= n;
  let nNeeded = n;
  if (!feasible) { nNeeded = mode === 'pac' ? Math.ceil(Math.log(delta) / Math.log(1 - alpha)) : Math.ceil(1 / alpha - 1); }
  const expected = (n + 1 - k) / (n + 1);
  return { alpha, mode, delta, expected, feasible, nNeeded, Q, k, thresholds, scores, isoBest, isoNom, virtQ, bound90, nCal: n, calNames: calRuns.map(r => r.name) };
}

export const VIRT_SMOOTH = 20; // cycles averaged for the virtual reading (200 ms)
export function virtualBias(model, h, r, idx, n) {
  const raw = idx.map(i => perSampleBias(model, h, r.map(x => x[i])));
  const out = new Float64Array(n).fill(NaN);
  for (let k = 0; k < idx.length; k++) {
    let s = 0, m = 0; for (let j = Math.max(0, k - VIRT_SMOOTH + 1); j <= k; j++) { s += raw[j]; m++; }
    out[idx[k]] = s / m;
  }
  return out;
}
export function perSampleBias(model, h, rvec) {
  const z = forwardSub(model.LS, rvec), d = forwardSub(model.LS, h.g);
  return dot(d, z) / dot(d, d);
}

// minimum sustained bias on each sensor that fires at least one relation
export function minDetectableBias(model, cal) {
  return Object.fromEntries(CH_IDS.map((c, j) => {
    let best = Infinity, via = null;
    model.G.forEach((row, e) => { const s = Math.abs(row[j]); if (s > 1e-6) { const b = cal.thresholds[e] / s; if (b < best) { best = b; via = model.rels[e].id; } } });
    return [c, { bias: best, via }];
  }));
}

// ---------------------------------------------------------------- analysis of one run
export function analyzeRun(model, cal, run) {
  const sc = runScore(model, run);
  const E = model.rels.length;
  const fires = model.rels.map((R, e) => {
    let first = null;
    for (let i = 0; i < run.n; i++) if (sc.sus[e][i] > cal.Q) { first = i; break; }
    return { rel: R.id, firstIdx: first, firstT: first === null ? null : run.t[first], peak: maxFinite(sc.sus[e]) };
  });
  const firing = fires.filter(f => f.firstIdx !== null);
  const pRun = conformalPValue(cal.scores, sc.S);
  const out = { run: run.name, S: sc.S, pRun, fires, r: sc.r, sus: sc.sus, mask: sc.mask, detected: firing.length > 0 };
  if (!firing.length) return out;
  const tIdx = Math.min(...firing.map(f => f.firstIdx));
  out.detectIdx = tIdx; out.detectT = run.t[tIdx];
  const idx = []; for (let i = 0; i < run.n; i++) if (sc.mask[i]) idx.push(i);
  const pos = idx.indexOf(tIdx);
  const start = Math.max(0, pos);  // window opens once persistence has confirmed the shift
  const rbar = windowMean(sc.r, idx, start);
  out.window = { start: run.t[idx[Math.max(0, Math.min(start, idx.length - ISO_WINDOW))]], len: ISO_WINDOW };
  out.rbar = rbar;
  const iso = isolate(model, rbar);
  out.iso = iso;
  out.pNominalWindow = conformalPValue(cal.isoNom, iso.J_nominal);
  out.pExplained = conformalPValue(cal.isoBest, iso.groups[0].J);
  const top = iso.groups[0];
  if (top.best.kind === 'sensor' && !top.ambiguous) {
    const h = top.best, c = h.ch;
    const sm = virtualBias(model, h, sc.r, idx, run.n);
    const virtual = new Float64Array(run.n).fill(NaN);
    for (const i of idx) virtual[i] = run.ch[c][i] - sm[i];
    out.virtual = { ch: c, values: virtual, halfWidth: cal.virtQ[c] };
  }
  return out;
}

// plain-language reason built from the fired / quiet relations
export function explain(model, analysis) {
  if (!analysis.detected) return 'All relations stayed inside their calibrated limits.';
  const top = analysis.iso.groups[0];
  const fired = analysis.fires.filter(f => f.firstIdx !== null).map(f => f.rel);
  const relName = id => model.rels.find(r => r.id === id).name.toLowerCase();
  if (top.best.kind === 'sensor' && !top.ambiguous) {
    const j = CH_IDS.indexOf(top.best.ch);
    const involved = model.rels.filter((R, e) => Math.abs(model.G[e][j]) > 0.05).map(R => R.id);
    const quiet = model.rels.filter(R => !involved.includes(R.id)).map(R => R.id);
    return `${top.best.ch} is the only single fault that explains the ${involved.map(relName).join(' and ')} relations shifting together, by one bias, while the other ${quiet.length} relations stay quiet.`;
  }
  if (top.ambiguous) return `The residual pattern matches ${top.members.map(m => m.label).join(' or ')}; this P&ID has no sensor that separates them.`;
  return `Only the ${relName(top.best.rel)} relation moved (${fired.map(relName).join(', ')}); every sensor on it still agrees with its other relations, so the hardware changed, not a transducer.`;
}

// ---------------------------------------------------------------- RevelCode generation
export function revelCode(model, cal, opts = {}) {
  const f = (x, d = 4) => (x >= 0 ? '' : '-') + Math.abs(x).toFixed(d);
  const lines = [];
  lines.push(`# Sensor Cross-Check: generated from ${model.nTrain} nominal runs, thresholds from ${cal.nCal}`);
  lines.push(`# P(any cross-check alert on a nominal run) <= ${(cal.alpha * 100).toFixed(0)}%  (split conformal, persistence ${PERSIST} cycles)`);
  lines.push('');
  for (let e = 0; e < model.rels.length; e++) {
    const R = model.rels[e];
    const terms = R.features.map((ft, j) => `${f(R.beta[j + 1])} * |${ft}|`).join(' + ').replace(/\+ -/g, '- ');
    lines.push(`loop xc_${R.id}:`);
    lines.push(`    |xc.${R.id}| = |${R.target}| - (${f(R.beta[0], 3)} + ${terms})`);
    lines.push('');
    lines.push(`alert xc_${R.id}:`);
    lines.push(`    severity = Severity.warning`);
    lines.push(`    arm = |mainstage|`);
    lines.push(`    trigger = persistence(|xc.${R.id}| > ${cal.thresholds[e].toFixed(2)}, ${PERSIST}) or persistence(|xc.${R.id}| < -${cal.thresholds[e].toFixed(2)}, ${PERSIST})`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- campaign
export const CAMPAIGN = {
  trainSeeds: Array.from({ length: 50 }, (_, i) => 1000 + i),
  calSeeds: Array.from({ length: 70 }, (_, i) => 2000 + i),
  recent: [
    { name: 'hot_fire_0321', seed: 3021 },
    { name: 'hot_fire_0322', seed: 3022 },
    { name: 'hot_fire_0323', seed: 3023 },
    { name: 'hot_fire_0324', seed: 3024, fault: { type: 'sensor_shift', ch: 'LC_TH_41', t0: 1.6, size: 26 } },
    { name: 'hot_fire_0325', seed: 3025 },
    { name: 'hot_fire_0326', seed: 3026 },
    { name: 'hot_fire_0327', seed: 3027, fault: { type: 'injector_fuel', t0: 1.4, factor: 1.22 } },
    { name: 'hot_fire_0328', seed: 3028 },
    { name: 'hot_fire_0329', seed: 3029 },
    { name: 'hot_fire_0330', seed: 3030 },
    { name: 'hot_fire_0331', seed: 3031 },
    { name: 'hot_fire_0332', seed: 3032, mainstage: 4.4, fault: { type: 'sensor_drift', ch: 'PT_FM_21', t0: 1.2, rate: 22 } },
  ],
};

export function runCampaign(alpha = 0.05, mode = 'pac') {
  const train = CAMPAIGN.trainSeeds.map((s, i) => simulateRun({ seed: s, name: `hot_fire_${String(201 + i).padStart(4, '0')}` }));
  const calR = CAMPAIGN.calSeeds.map((s, i) => simulateRun({ seed: s, name: `hot_fire_${String(251 + i).padStart(4, '0')}` }));
  const model = buildModel(train);
  const cal = calibrate(model, calR, alpha, { mode });
  const recent = CAMPAIGN.recent.map(r => simulateRun(r));
  return { train, calR, model, cal, recent };
}

// false-alert rate on fresh simulated nominal runs: conformal thresholds vs a naive k-sigma rule
export function heldOutCheck(model, cal, nRuns = 400, seed0 = 50000, naiveK = 4) {
  let conf = 0, naive = 0;
  for (let k = 0; k < nRuns; k++) {
    const run = simulateRun({ seed: seed0 + k, name: 'ho' });
    const sc = runScore(model, run);
    if (sc.S > cal.Q) conf++;
    if (sc.S > naiveK) naive++;
  }
  return { nRuns, conformalRate: conf / nRuns, naiveRate: naive / nRuns, naiveK };
}
