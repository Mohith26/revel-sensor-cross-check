import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../core/crosscheck.js';

const C = X.runCampaign(0.05, 'pac');

test('simulator is deterministic and hits the nominal operating point', () => {
  const a = X.simulateRun({ seed: 1234 }), b = X.simulateRun({ seed: 1234 });
  assert.deepEqual(Array.from(a.ch.PT_FM_21.slice(0, 500)), Array.from(b.ch.PT_FM_21.slice(0, 500)));
  const i = Math.round((a.events.mainstage + 1.5) / X.DT);
  assert.ok(Math.abs(a.ch.PT_CC_31[i] - 250) < 20, 'chamber ~250 psi');
  assert.ok(Math.abs(a.ch.LC_TH_41[i] - 500) < 45, 'thrust ~500 lbf');
  assert.ok(a.ch.PT_FM_21[i] > a.ch.PT_CC_31[i] + 30, 'fuel injector dP positive');
  assert.equal(a.abort, null, 'nominal run does not abort');
});

test('relations fit the physics (R^2 and coefficient signs)', () => {
  const R = Object.fromEntries(C.model.rels.map(r => [r.id, r]));
  assert.ok(R.fuel_feed.beta[1] > 0.85 && R.fuel_feed.beta[1] < 1.05);
  assert.ok(R.fuel_injector.beta[1] > 0.7, 'manifold tracks chamber');
  assert.ok(R.thrust.beta[1] > 1.8 && R.thrust.beta[1] < 2.2, 'Cf*At ~ 2 lbf/psi');
  for (const r of C.model.rels) assert.ok(r.r2 > 0.5, r.id + ' r2');
});

test('sensitivity matrix: a sensor bias moves exactly the relations that contain it', () => {
  const run = X.simulateRun({ seed: 4321 });
  const base = X.residuals(C.model.rels, run);
  const biased = { ...run, ch: { ...run.ch, PT_FM_21: Float64Array.from(run.ch.PT_FM_21, v => v + 10) } };
  const shifted = X.residuals(C.model.rels, biased);
  const i = base.mask.indexOf(1) + 50;
  const j = X.CH_IDS.indexOf('PT_FM_21');
  C.model.rels.forEach((r, e) => {
    const d = shifted.r[e][i] - base.r[e][i];
    assert.ok(Math.abs(d - 10 * C.model.G[e][j]) < 1e-9, r.id);
  });
});

test('conformal quantile and p-values', () => {
  const s = Array.from({ length: 19 }, (_, i) => i + 1);
  assert.equal(X.conformalQuantile(s, 0.1), 18);
  assert.equal(X.conformalQuantile(s, 0.01), Infinity);
  assert.equal(X.conformalPValue(s, 19), 2 / 20);
  assert.equal(X.conformalPValue(s, 100), 1 / 20);
});

test('beta upper bound matches closed form for k = n', () => {
  const n = 70, b = X.betaUpperBound(n, n, 0.1);
  assert.ok(Math.abs(b - (1 - Math.pow(0.1, 1 / n))) < 1e-6);
});

test('persistence semantics: sustained level equals RevelCode persistence(u > q, N) or persistence(u < -q, N)', () => {
  const u = new Float64Array(60).fill(0), mask = new Uint8Array(60).fill(1);
  for (let i = 10; i < 35; i++) u[i] = 3 + (i % 2) * 0.5; // 25 cycles above 3
  const s = X.sustainedSeries(u, mask, 20);
  assert.equal(X.maxFinite(s), 3);
  const fire = q => { let c = 0; for (let i = 0; i < 60; i++) { c = u[i] > q ? c + 1 : 0; if (c >= 20) return true; } return false; };
  assert.equal(fire(2.99), true); assert.equal(fire(3.0), false);
});

test('marginal guarantee: average false-alert rate over calibration draws is <= alpha', () => {
  const model = C.model; let tot = 0; const R = 12;
  for (let r = 0; r < R; r++) {
    const cal = X.calibrate(model, Array.from({ length: 40 }, (_, i) => X.simulateRun({ seed: 90000 + r * 100 + i })), 0.1, { mode: 'marginal' });
    tot += X.heldOutCheck(model, cal, 120, 70000 + r * 1000).conformalRate;
  }
  assert.ok(tot / R <= 0.1 + 0.03, 'avg ' + tot / R);
});

test('PAC mode: held-out false-alert rate under the 90% bound', () => {
  const h = X.heldOutCheck(C.model, C.cal, 300);
  assert.ok(C.cal.feasible);
  assert.ok(h.conformalRate <= C.cal.bound90, h.conformalRate + ' vs ' + C.cal.bound90);
});

test('nominal recent runs stay quiet; faults are detected and isolated correctly', () => {
  const byName = Object.fromEntries(C.recent.map(r => [r.name, X.analyzeRun(C.model, C.cal, r)]));
  for (const r of C.recent) if (!r.fault) assert.equal(byName[r.name].detected, false, r.name);
  const fm = byName.hot_fire_0332;
  assert.equal(fm.iso.groups[0].best.key, 'sensor:PT_FM_21');
  assert.ok(fm.iso.groups[0].likelihood > 0.95);
  const run = C.recent.find(r => r.name === 'hot_fire_0332');
  assert.equal(run.abort.alert, 'Fuel_manifold_low_pres');
  assert.ok(fm.detectT < run.abort.t - 1.0, 'cross-check fires >1 s before the redline abort');
  // virtual sensor tracks the true manifold pressure inside its interval most of the time
  let inside = 0, tot = 0;
  for (let i = 0; i < run.n; i++) if (Number.isFinite(fm.virtual.values[i])) { tot++; if (Math.abs(fm.virtual.values[i] - run.truth.PT_FM_21[i]) <= fm.virtual.halfWidth + 1.0) inside++; }
  assert.ok(inside / tot > 0.85, 'virtual coverage ' + inside / tot);
  assert.equal(byName.hot_fire_0327.iso.groups[0].best.key, 'component:fuel_injector');
  const lc = byName.hot_fire_0324.iso.groups[0];
  assert.ok(lc.ambiguous && lc.members.some(m => m.key === 'sensor:LC_TH_41'));
});

test('ambiguity groups follow the P&ID structure', () => {
  const groups = X.ambiguityGroups(C.model).map(g => g.map(h => h.key).sort().join('|'));
  assert.ok(groups.includes(['component:ox_injector', 'sensor:PT_OM_22'].sort().join('|')));
  assert.ok(groups.includes('sensor:PT_FM_21'), 'fuel manifold PT is isolable thanks to the venturi-exit PT');
});

test('generated RevelCode has one loop + alert per relation with calibrated thresholds', () => {
  const code = X.revelCode(C.model, C.cal);
  assert.equal((code.match(/^alert xc_/gm) || []).length, X.RELATIONS.length);
  assert.ok(code.includes(`persistence(|xc.fuel_injector| > ${C.cal.thresholds[3].toFixed(2)}, 20)`));
});
