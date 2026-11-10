// Writes data/hot_fire_0332.csv and data/summary.json from the seeded simulator so the data can be inspected
// outside the browser. The page itself regenerates the same runs from the same seeds.
import { writeFileSync, mkdirSync } from 'node:fs';
import * as X from '../core/crosscheck.js';
const C = X.runCampaign(0.05, 'pac');
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const run = C.recent.find(r => r.name === 'hot_fire_0332');
const rows = ['t_s,state,' + X.CH_IDS.join(',')];
for (let i = 0; i < run.n; i++) rows.push([run.t[i].toFixed(2), X.STATES[run.state[i]], ...X.CH_IDS.map(c => run.ch[c][i].toFixed(3))].join(','));
writeFileSync(new URL('../data/hot_fire_0332.csv', import.meta.url), rows.join('\n') + '\n');
const summary = {
  relations: C.model.rels.map((r, e) => ({ id: r.id, target: r.target, features: r.features, beta: r.beta.map(b => +b.toFixed(5)), r2: +r.r2.toFixed(4), scale: +C.model.scale[e].toFixed(4), limit: +C.cal.thresholds[e].toFixed(3) })),
  calibration: { runs: C.cal.nCal, mode: C.cal.mode, alpha: C.cal.alpha, k: C.cal.k, Q: +C.cal.Q.toFixed(4), bound90: +C.cal.bound90.toFixed(4) },
  recent: C.recent.map(r => { const a = X.analyzeRun(C.model, C.cal, r); return { run: r.name, fault: r.fault, abort: r.abort && { alert: r.abort.alert, t_after_mainstage: +(r.abort.t - r.events.mainstage).toFixed(2) }, detected: a.detected, detect_t_after_mainstage: a.detected ? +(a.detectT - r.events.mainstage).toFixed(2) : null, isolated: a.detected ? a.iso.groups[0].members.map(m => m.key) : null, score: +a.S.toFixed(3), p: +a.pRun.toFixed(4) }; }),
  heldOut: X.heldOutCheck(C.model, C.cal, 400),
};
writeFileSync(new URL('../data/summary.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.calibration), JSON.stringify(summary.heldOut));
for (const r of summary.recent) if (r.detected || r.abort) console.log(r.run, r.isolated, r.detect_t_after_mainstage, r.abort);
