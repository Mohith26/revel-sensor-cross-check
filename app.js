import * as X from './core/crosscheck.js';

// ------------------------------------------------------------------ data (seeded simulator, computed in the page)
const train = X.CAMPAIGN.trainSeeds.map((s, i) => X.simulateRun({ seed: s, name: `hot_fire_${String(201 + i).padStart(4, '0')}` }));
const calRuns = X.CAMPAIGN.calSeeds.map((s, i) => X.simulateRun({ seed: s, name: `hot_fire_${String(251 + i).padStart(4, '0')}` }));
const recent = X.CAMPAIGN.recent.map(r => X.simulateRun(r));
const model = X.buildModel(train);
const E = model.rels.length;
const injDP = model.opMean.PT_FM_21 - model.opMean.PT_CC_31;

const S = { alpha: 0.05, mode: 'pac', run: recent.length - 1, cursor: null, zoom: 'ms', hyp: null };
let cal, analyses, held;
const heldCache = {};

function recompute() {
  cal = X.calibrate(model, calRuns, S.alpha, { mode: S.mode });
  analyses = recent.map(r => X.analyzeRun(model, cal, r));
  const key = S.alpha + S.mode;
  held = heldCache[key] ||= X.heldOutCheck(model, cal, 400);
}

// ------------------------------------------------------------------ helpers
const $ = id => document.getElementById(id);
const fx = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '—';
const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
const pct = (v, d = 1) => (100 * v).toFixed(d) + '%';
const chMeta = id => X.CHANNELS.find(c => c.id === id);
const relById = id => model.rels.find(r => r.id === id);
const run = () => recent[S.run];
const an = () => analyses[S.run];
const rel = t => t - run().events.mainstage; // time after MAINSTAGE entry
const stateName = i => X.STATES[run().state[i]];
function recordedAt(k) { const m = 9 * 60 + 12 + k * 37; const h = Math.floor(m / 60), mm = m % 60; return `11/09/2026, ${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')}:${String((k * 17) % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }

function verdict(a) {
  if (!a.detected) return { kind: 'nominal', text: 'NOMINAL', short: 'OK', cls: 'g' };
  const g = a.iso.groups[0];
  if (g.ambiguous) return { kind: 'ambiguous', text: g.members.map(m => m.kind === 'sensor' ? m.ch : m.label.toUpperCase()).join(' OR '), short: g.members.find(m => m.kind === 'sensor')?.ch.split('_')[0] + '?', cls: 'a', g };
  if (g.best.kind === 'sensor') return { kind: 'sensor', text: 'SENSOR FAULT · ' + g.best.ch, short: 'SENSOR', cls: 'r', g };
  return { kind: 'component', text: 'HARDWARE CHANGE · ' + g.best.label.toUpperCase(), short: 'HW', cls: 'a', g };
}

// ------------------------------------------------------------------ sidebar
function renderSidebar() {
  $('runList').innerHTML = recent.map((r, k) => {
    const a = analyses[k], v = verdict(a);
    const tag = r.abort ? `<span class="tag r">ABORT</span>` : v.kind === 'nominal' ? '' : `<span class="tag ${v.cls}">${v.short}</span>`;
    return `<div class="side-item ${k === S.run ? 'sel' : ''}" data-k="${k}"><span>${r.name}</span>${tag}</div>`;
  }).reverse().join('');
  $('runList').querySelectorAll('.side-item').forEach(el => el.onclick = () => selectRun(+el.dataset.k));
  $('baselineItem').innerHTML = `<span>${train[0].name.slice(-4)}–${train[train.length - 1].name.slice(-4)}</span><span class="tag">fit · ${train.length}</span>`;
  $('calItem').innerHTML = `<span>${calRuns[0].name.slice(-4)}–${calRuns[calRuns.length - 1].name.slice(-4)}</span><span class="tag">calibrate · ${calRuns.length}</span>`;
}

function selectRun(k) {
  S.run = k; S.hyp = null;
  if (history.replaceState) history.replaceState(null, '', '#' + recent[k].name + (S.alpha !== 0.05 ? '&alpha=' + S.alpha : '') + (S.mode !== 'pac' ? '&mode=' + S.mode : ''));
  const a = analyses[k], r = recent[k];
  S.cursor = a.detected ? Math.min(r.n - 1, a.detectIdx + 25) : Math.round((r.events.mainstage + 1.5) / X.DT);
  render();
}

// ------------------------------------------------------------------ readouts
function renderReadouts() {
  const r = run(), a = an(), v = verdict(a), i = S.cursor;
  const tiles = [];
  if (r.abort) {
    const red = X.REDLINES.find(x => x.id === r.abort.alert);
    const expr = red.diff ? `|${red.diff[0]}| - |${red.diff[1]}| ${red.op} ${red.value.toFixed(1)}` : `|${red.ch}| ${red.op} ${red.value.toFixed(1)}`;
    tiles.push(`<div class="ro"><div class="lb">alert.${r.abort.alert}</div><div class="vl"><span class="badge red">ABORT</span>t+${rel(r.abort.t).toFixed(2)} <small>s</small></div><div class="sub">persistence(${expr}, ${red.n})</div></div>`);
  } else {
    tiles.push(`<div class="ro"><div class="lb">alert.redlines</div><div class="vl"><span class="badge gray">NONE FIRED</span></div><div class="sub">${X.REDLINES.length} hand-written redlines armed in MAINSTAGE</div></div>`);
  }
  if (a.detected) {
    const lead = r.abort ? `${(r.abort.t - a.detectT).toFixed(2)} s before abort` : 'no redline fired this run';
    tiles.push(`<div class="ro"><div class="lb">cross_check.verdict</div><div class="vl"><span class="badge ${v.kind === 'sensor' ? 'red' : 'amber'}">${v.kind === 'sensor' ? 'SENSOR' : v.kind === 'component' ? 'HARDWARE' : 'AMBIGUOUS'}</span>${v.kind === 'sensor' ? v.g.best.ch : v.kind === 'component' ? v.g.best.label : v.g.members.map(m => m.kind === 'sensor' ? m.ch : 'thrust takeout').join(' / ')}</div><div class="sub">fired t+${rel(a.detectT).toFixed(2)} s · ${lead}</div></div>`);
  } else if (!cal.feasible) {
    tiles.push(`<div class="ro"><div class="lb">cross_check.verdict</div><div class="vl"><span class="badge gray">DISARMED</span>budget too tight</div><div class="sub">needs ≥ ${cal.nNeeded} calibration runs for ${pct(S.alpha, 0)}</div></div>`);
  } else {
    tiles.push(`<div class="ro"><div class="lb">cross_check.verdict</div><div class="vl"><span class="badge green">NOMINAL</span>${X.RELATIONS.length}/${X.RELATIONS.length} relations</div><div class="sub">peak ${fx(a.S, 2)}σ vs limit ${fx(cal.Q, 2)}σ · p = ${fx(a.pRun, 2)}</div></div>`);
  }
  if (a.virtual) {
    const vv = a.virtual.values[i], meas = r.ch[a.virtual.ch][i];
    const val = Number.isFinite(vv) ? `${vv.toFixed(1)} <small>psi ± ${a.virtual.halfWidth.toFixed(1)}</small>` : `<small>armed in MAINSTAGE only</small>`;
    tiles.push(`<div class="ro"><div class="lb">${a.virtual.ch} · cross-check estimate</div><div class="vl">${val}</div><div class="sub">transducer ${meas.toFixed(1)} psi · t+${rel(r.t[i]).toFixed(2)} s</div></div>`);
  } else if (a.detected) {
    const g = a.iso.groups[0], b = g.best;
    const unit = b.kind === 'sensor' ? chMeta(b.ch).unit : chMeta(relById(b.rel).target).unit;
    const extra = b.key === 'component:fuel_injector' ? ` · ${sgn(100 * b.bias / injDP, 0)}% of injector ΔP` : '';
    tiles.push(`<div class="ro"><div class="lb">estimated_shift · ${b.kind === 'sensor' ? b.ch : b.rel}</div><div class="vl">${sgn(b.bias, 1)} <small>${unit}</small></div><div class="sub">GLR estimate over isolation window${extra}</div></div>`);
  } else {
    tiles.push(`<div class="ro"><div class="lb">run.score</div><div class="vl">${fx(a.S, 2)} <small>σ sustained</small></div><div class="sub">largest 200 ms excursion across ${E} relations</div></div>`);
  }
  if (a.detected) {
    const quiet = a.fires.filter(f => f.firstIdx === null).length;
    tiles.push(`<div class="ro"><div class="lb">engine.consistency</div><div class="vl">${quiet} / ${E} <small>relations quiet</small></div><div class="sub">unexplained p = ${fx(a.pExplained, 2)}</div></div>`);
  } else {
    tiles.push(`<div class="ro"><div class="lb">engine.consistency</div><div class="vl">${E} / ${E} <small>relations quiet</small></div><div class="sub">run score p = ${fx(a.pRun, 2)} vs ${cal.nCal} nominal runs</div></div>`);
  }
  const bound = S.mode === 'pac' ? cal.bound90 : cal.expected;
  tiles.push(`<div class="ro"><div class="lb">false_alert.bound</div><div class="vl">${cal.feasible ? '≤ ' + pct(bound) : 'n/a'} <small>${S.mode === 'pac' ? '90% conf.' : 'average'}</small></div><div class="sub">${cal.feasible ? `limit ${fx(cal.Q, 2)}σ · ${cal.nCal} cal. runs` : `needs ≥ ${cal.nNeeded} cal. runs`}</div></div>`);
  $('readouts').innerHTML = tiles.join('');
}

// ------------------------------------------------------------------ P&ID
const PID = {
  taps: {
    PT_FV_11: { x: 282, y: 140, box: [228, 66] }, PT_FVX_13: { x: 392, y: 140, box: [344, 66] }, PT_FM_21: { x: 520, y: 140, box: [466, 66] },
    PT_OV_12: { x: 282, y: 262, box: [228, 300] }, PT_OM_22: { x: 520, y: 262, box: [466, 300] },
    PT_CC_31: { x: 640, y: 160, box: [620, 66] }, LC_TH_41: { x: 631, y: 242, box: [620, 300] },
    PT_FT_01: { x: 150, y: 100, box: [22, 30] }, PT_OT_02: { x: 150, y: 302, box: [22, 304] },
  },
  chips: {
    fuel_feed: [214, 166], ox_feed: [214, 236], fuel_mfv: [372, 166], fuel_injector: [458, 190],
    ox_injector: [458, 222], combustion: [290, 201], thrust: [662, 262],
  },
  BOXW: 112, BOXH: 38,
};
function valve(x, y, open, name, below) {
  return `<g><circle cx="${x}" cy="${y}" r="13" fill="none" stroke="${open ? '#06d84a' : '#3a3a3a'}" stroke-width="2.4"/><circle cx="${x}" cy="${y}" r="9.5" fill="#0d0d0d" stroke="#e8e8e8" stroke-width="1.6"/><line x1="${x - 9}" y1="${y}" x2="${x + 9}" y2="${y}" stroke="#e8e8e8" stroke-width="2.6"/><text x="${x}" y="${below ? y + 26 : y - 18}" text-anchor="middle" font-size="9.5" fill="#7a7a7a">${name}</text></g>`;
}
function venturi(x, y) { return `<path d="M${x - 9} ${y - 10} Q${x - 2} ${y} ${x - 9} ${y + 10} M${x + 9} ${y - 10} Q${x + 2} ${y} ${x + 9} ${y + 10}" fill="none" stroke="#e8e8e8" stroke-width="1.6"/>`; }

function renderPID() {
  const r = run(), a = an(), i = S.cursor;
  const st = r.state[i], open = st >= 2 && st <= 3;
  const fuel = '#2b52ff', ox = '#e0313d', n2 = '#19b84a';
  const susp = a.virtual ? a.virtual.ch : (a.detected && a.iso.groups[0].best.kind === 'sensor' ? a.iso.groups[0].best.ch : null);
  const fired = new Set(a.fires.filter(f => f.firstIdx !== null && f.firstIdx <= i).map(f => f.rel));
  let s = '';
  // N2 pressurant
  s += `<rect x="30" y="152" width="40" height="76" rx="12" fill="#121212" stroke="#cfcfcf" stroke-width="1.4"/><text x="50" y="244" text-anchor="middle" font-size="9.5" fill="#7a7a7a">N2</text>`;
  s += `<path d="M70 190 H96" stroke="${n2}" stroke-width="1.6"/><path d="M96 182 l10 8 l-10 8 z M116 182 l-10 8 l10 8 z" fill="none" stroke="#e8e8e8" stroke-width="1.4"/><text x="106" y="175" text-anchor="middle" font-size="9.5" fill="#7a7a7a">REG</text>`;
  s += `<path d="M116 190 H128 M128 100 V302 M128 100 H150 M128 302 H150" stroke="${n2}" stroke-width="1.6" fill="none"/>`;
  // tanks
  s += `<rect x="150" y="78" width="50" height="96" rx="25" fill="#101010" stroke="#e8e8e8" stroke-width="1.4"/><path d="M151 120 H199 V149 a24 24 0 0 1 -48 0 Z" fill="${fuel}"/><text x="175" y="188" text-anchor="middle" font-size="9.5" fill="#7a7a7a">FUEL</text>`;
  s += `<rect x="150" y="228" width="50" height="96" rx="25" fill="#101010" stroke="#e8e8e8" stroke-width="1.4"/><path d="M151 266 H199 V299 a24 24 0 0 1 -48 0 Z" fill="${ox}"/><text x="175" y="338" text-anchor="middle" font-size="9.5" fill="#7a7a7a">OX</text>`;
  // feed lines
  s += `<path d="M200 140 H590 V176 H606" stroke="${fuel}" stroke-width="1.6" fill="none"/>`;
  s += `<path d="M200 262 H590 V210 H606" stroke="${ox}" stroke-width="1.6" fill="none"/>`;
  s += valve(236, 140, open, 'FV02') + venturi(334, 140) + valve(450, 140, open, 'FV06');
  s += valve(236, 262, open, 'FV03', true) + venturi(334, 262) + valve(450, 262, open, 'FV07', true);
  // engine
  const glow = r.ch.PT_CC_31[i] > 60;
  s += `<rect x="606" y="160" width="50" height="66" fill="#121212" stroke="#e8e8e8" stroke-width="1.4"/>`;
  s += `<path d="M656 174 L690 182 Q735 162 772 146 V240 Q735 224 690 204 L656 212 Z" fill="${glow ? '#1a1410' : '#121212'}" stroke="#e8e8e8" stroke-width="1.4"/>`;
  if (glow) s += `<path d="M772 152 Q790 193 772 234" fill="none" stroke="#e8743b" stroke-width="1.2" opacity=".7"/>`;
  s += `<rect x="623" y="234" width="16" height="12" fill="#0d0d0d" stroke="#cfcfcf" stroke-width="1.2"/>`;
  // relation chips
  for (const [id, [cx, cy]] of Object.entries(PID.chips)) {
    const e = model.rels.findIndex(x => x.id === id);
    a.susSigned ||= model.rels.map((R, k) => X.sustainedSigned(Float64Array.from(a.r[k], x => x / model.scale[k]), a.mask));
    const u = a.susSigned[e][i];
    const isF = fired.has(id), now = Number.isFinite(u);
    const label = `${relById(id).name.toLowerCase()} ${now ? (u >= 0 ? '+' : '') + u.toFixed(1) + 'σ' : '—'}`;
    const w = 14 + label.length * 6.05;
    s += `<g><rect x="${cx}" y="${cy - 9}" width="${w}" height="18" fill="${isF ? '#3a0e12' : '#111'}" stroke="${isF ? '#f7222f' : '#2f2f2f'}"/><circle cx="${cx + 7}" cy="${cy}" r="2.6" fill="${isF ? '#f7222f' : now ? '#06d84a' : '#4a4a4a'}"/><text x="${cx + 13}" y="${cy + 3.5}" font-size="10" fill="${isF ? '#ff8a90' : '#b8b8b8'}">${label}</text></g>`;
  }
  // taps and readouts
  for (const [id, p] of Object.entries(PID.taps)) {
    const [bx, by] = p.box, W = PID.BOXW, H = PID.BOXH, m = chMeta(id);
    const above = by < p.y;
    const ly = above ? by + H : by;
    const lx = Math.max(bx + 8, Math.min(bx + W - 8, p.x));
    s += `<path d="M${p.x} ${p.y} V${(p.y + ly) / 2} H${lx} V${ly}" stroke="#7a7a7a" stroke-width="1" fill="none"/><circle cx="${p.x}" cy="${p.y}" r="3" fill="#e8e8e8"/>`;
    const bad = id === susp;
    s += `<rect x="${bx}" y="${by}" width="${W}" height="${H}" fill="#101010" stroke="${bad ? '#f7222f' : '#2c2c2c'}" stroke-width="${bad ? 1.4 : 1}"/>`;
    s += `<text x="${bx + 7}" y="${by + 14}" font-size="10" fill="#bdbdbd">${m.label}</text>`;
    s += `<text x="${bx + 7}" y="${by + 31}" font-size="14" fill="#fff">${r.ch[id][i].toFixed(1)}<tspan font-size="9.5" fill="#8c8c8c" dx="4">${m.unit}</tspan></text>`;
    if (bad && a.virtual && Number.isFinite(a.virtual.values[i])) {
      const yy = above ? by - 7 : by + H + 13;
      s += `<text x="${bx + W}" y="${yy}" text-anchor="end" font-size="10" fill="#5ff08f">XC ${a.virtual.values[i].toFixed(1)} ± ${a.virtual.halfWidth.toFixed(1)}</text>`;
    }
  }
  s += `<text x="788" y="364" text-anchor="end" font-size="9.5" fill="#5a5a5a">${stateName(i)} · t+${rel(r.t[i]).toFixed(2)} s</text>`;
  $('pid').innerHTML = s;
  $('pid').classList.add('pid');
  $('pidLegend').textContent = `${E} relations · ${fired.size} fired`;
}

// ------------------------------------------------------------------ scrubber
function renderScrub() {
  const r = run(), a = an(), T = r.t[r.n - 1];
  const ev = r.events, segs = [['PRESS', 0, ev.ignition], ['IGN', ev.ignition, ev.ramp], ['RAMP', ev.ramp, ev.mainstage], ['MAINSTAGE', ev.mainstage, ev.shutdown], ['SHUTDOWN', ev.shutdown, ev.shutdown + 0.5], ['SAFE', ev.shutdown + 0.5, T]];
  $('scrubStates').innerHTML = segs.map(([n, a0, a1]) => `<div class="${n === 'MAINSTAGE' ? 'ms' : ''}" style="width:${100 * (a1 - a0) / T}%">${n}</div>`).join('');
  const mk = [];
  if (a.detected) mk.push(`<div class="mk" style="left:${100 * a.detectT / T}%;background:#06d84a"><span style="color:#5ff08f">XC</span></div>`);
  if (r.abort) mk.push(`<div class="mk" style="left:${100 * r.abort.t / T}%;background:#f7222f"><span style="color:#ff6a72">ABORT</span></div>`);
  $('scrubMarks').innerHTML = mk.join('');
  $('scrubCursor').style.left = `${100 * r.t[S.cursor] / T}%`;
  $('scrubTime').textContent = `t+${rel(r.t[S.cursor]) >= 0 ? '' : ''}${rel(r.t[S.cursor]).toFixed(2)} s`;
}
function setCursorFromX(el, clientX) {
  const b = el.getBoundingClientRect(), f = Math.max(0, Math.min(1, (clientX - b.left) / b.width));
  S.cursor = Math.round(f * (run().n - 1));
  renderDynamic();
}

// ------------------------------------------------------------------ isolation panel
function renderIso() {
  const r = run(), a = an();
  if (!a.detected) {
    const e = a.fires.reduce((m, f, k) => f.peak > a.fires[m].peak ? k : m, 0);
    $('isoWindow').textContent = 'no window';
    $('iso').innerHTML = `<table class="tbl"><tr><th>Hypothesis</th><th class="r">Estimate</th><th>Relative likelihood</th></tr><tr><td class="dim">nominal</td><td class="r dim">—</td><td><span class="bar"><i style="width:100%"></i></span>100%</td></tr></table>
      <div class="why">No relation held beyond its limit for ${X.PERSIST} cycles. Closest was <b>${relById(a.fires[e].rel).name.toLowerCase()}</b> at ${fx(a.fires[e].peak, 2)}σ sustained against a limit of ${fx(cal.Q, 2)}σ. Run score p = ${fx(a.pRun, 2)} against ${cal.nCal} nominal calibration runs.</div>`;
    return;
  }
  const w = a.window;
  $('isoWindow').textContent = `window t+${rel(w.start).toFixed(2)}–${(rel(w.start) + w.len * X.DT).toFixed(2)} s`;
  const rows = a.iso.groups.slice(0, 6).map((g, k) => {
    const b = g.best, names = g.members.map(m => m.kind === 'sensor' ? m.ch : m.label).join(' / ');
    const type = g.ambiguous ? 'AMBIGUOUS' : b.kind === 'sensor' ? 'SENSOR' : 'COMPONENT';
    const unit = b.kind === 'sensor' ? chMeta(b.ch).unit : chMeta(relById(b.rel).target).unit;
    return `<tr class="${k === 0 ? 'top' : ''}"><td>${names} <span class="ty-tag">${type}</span></td><td class="r">${sgn(b.bias, 1)} ${unit}</td><td class="lk"><span class="bar"><i style="width:${Math.max(0.5, 100 * g.likelihood)}%"></i></span>${g.likelihood > 0.999 ? '>99.9%' : g.likelihood < 0.001 ? '<0.1%' : pct(g.likelihood, 1)}</td></tr>`;
  });
  const v = verdict(a);
  let vbox = '';
  if (a.virtual) {
    const k = a.detectIdx;
    vbox = `<div class="vbox"><div><div class="lb">${a.virtual.ch} at XC</div><div class="vl">${r.ch[a.virtual.ch][k].toFixed(1)} <small>psi</small></div></div><div><div class="lb">cross-check estimate</div><div class="vl" style="color:#5ff08f">${a.virtual.values[k].toFixed(1)} <small>± ${a.virtual.halfWidth.toFixed(1)} psi</small></div></div><div><div class="lb">${r.abort ? 'transducer / XC at abort' : 'at end of mainstage'}</div><div class="vl">${r.abort ? `${r.ch[a.virtual.ch][r.abort.i].toFixed(1)} <small>/</small> <span style="color:#5ff08f">${fx(a.virtual.values[r.abort.i - 1], 1)}</span>` : '—'}</div></div></div>`;
  }
  $('iso').innerHTML = `<table class="tbl"><tr><th>Hypothesis</th><th class="r">Bias in window</th><th>Relative likelihood</th></tr>${rows.join('')}</table>
    <div class="why"><b>${v.kind === 'sensor' ? 'Trust the engine, not the transducer.' : v.kind === 'component' ? 'The transducers agree; the hardware changed.' : 'Two explanations fit equally.'}</b> ${X.explain(model, a)} Residual left after the top hypothesis: p = ${fx(a.pExplained, 2)} vs nominal windows (before: ${fx(a.pNominalWindow, 3)}).</div>${vbox}`;
}

// ------------------------------------------------------------------ plots (Revel plot style, hand-drawn SVG)
const COLORS = ['#2b6cff', '#e0313d', '#8b5cf6', '#06c94a', '#e7b24a', '#3fc6d8', '#d36ad8'];
function xRange() {
  const r = run(), a = an(), ev = r.events;
  if (S.zoom === 'run') return [0, r.t[r.n - 1]];
  if (S.zoom === 'det' && a.detected) return [a.detectT - 1.0, Math.min(ev.shutdown + 0.2, a.detectT + 2.4)];
  return [ev.mainstage + 0.1, ev.shutdown + 0.15];
}
function plotFrame(el, title, unit) {
  const zb = (z, l) => `<button class="tbtn ${S.zoom === z ? 'on' : ''}" data-z="${z}">${l}</button>`;
  el.innerHTML = `<div class="ptool"><button class="tbtn icon"><svg viewBox="0 0 12 12" width="10" height="10"><rect x="2.5" y="2" width="2.2" height="8" fill="currentColor"/><rect x="7.3" y="2" width="2.2" height="8" fill="currentColor"/></svg></button><button class="tbtn on">Lin</button><button class="tbtn">Log</button><span class="sp"></span>${zb('run', 'Run')}${zb('ms', 'Mainstage')}${an().detected ? zb('det', 'Detect') : ''}<span class="ttl">${title} <small>[${unit}]</small></span></div><svg class="plot-svg"></svg>`;
  el.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { S.zoom = b.dataset.z; renderPlots(); });
  return el.querySelector('svg.plot-svg');
}
function drawPlot(svg, series, opts) {
  const W = svg.parentElement.clientWidth, H = 214, padL = 8, padR = 48, padT = 8, padB = 20;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
  const r = run(), [x0, x1] = xRange();
  const i0 = Math.max(0, Math.floor(x0 / X.DT)), i1 = Math.min(r.n - 1, Math.ceil(x1 / X.DT));
  let lo = Infinity, hi = -Infinity;
  const mask = an().mask, useMask = S.zoom !== 'run' && mask.slice(i0, i1 + 1).some(Boolean);
  for (const s of series) for (let i = i0; i <= i1; i++) { const v = s.v[i]; if ((!useMask || mask[i]) && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (opts.include) for (const v of opts.include) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const padY = (hi - lo) * 0.08 || 1; lo -= padY; hi += padY;
  const X_ = t => padL + (t - x0) / (x1 - x0) * (W - padL - padR), Y_ = v => padT + (hi - v) / (hi - lo) * (H - padT - padB);
  let g = '';
  const step = niceStep((hi - lo) / 5);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += `<line x1="${padL}" x2="${W - padR}" y1="${Y_(v)}" y2="${Y_(v)}" stroke="#1a1a1a"/><text x="${W - padR + 6}" y="${Y_(v) + 3.5}" font-size="10.5" fill="#6b6b6b" font-family="JetBrains Mono">${Math.abs(step) < 1 ? v.toFixed(1) : v.toFixed(0)}</text>`;
  const ts = niceStep((x1 - x0) / 7);
  for (let t = Math.ceil(x0 / ts) * ts; t <= x1; t += ts) g += `<line y1="${padT}" y2="${H - padB}" x1="${X_(t)}" x2="${X_(t)}" stroke="#151515"/><text x="${X_(t)}" y="${H - 6}" font-size="10" fill="#555" text-anchor="middle" font-family="JetBrains Mono">${(t - r.events.mainstage).toFixed(1)}</text>`;
  for (const b of opts.bands || []) {
    let up = '', dn = '';
    for (let i = i0; i <= i1; i++) if (Number.isFinite(b.lo[i])) { up += `${up ? 'L' : 'M'}${X_(r.t[i]).toFixed(1)} ${Y_(b.hi[i]).toFixed(1)} `; }
    for (let i = i1; i >= i0; i--) if (Number.isFinite(b.lo[i])) dn += `L${X_(r.t[i]).toFixed(1)} ${Y_(b.lo[i]).toFixed(1)} `;
    if (up) g += `<path d="${up}${dn}Z" fill="${b.color}" opacity=".16"/>`;
  }
  for (const h of opts.hlines || []) g += `<line x1="${padL}" x2="${W - padR}" y1="${Y_(h.v)}" y2="${Y_(h.v)}" stroke="${h.color}" stroke-dasharray="4 4" stroke-width="1"/>`;
  for (const s of series) {
    let d = '', pen = false;
    for (let i = i0; i <= i1; i++) { const v = s.v[i]; if (!Number.isFinite(v)) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X_(r.t[i]).toFixed(1)} ${Y_(v).toFixed(1)}`; pen = true; }
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.4}" ${s.dash ? 'stroke-dasharray="3 3"' : ''}/>`;
  }
  for (const m of opts.marks || []) if (m.t >= x0 && m.t <= x1) g += `<line x1="${X_(m.t)}" x2="${X_(m.t)}" y1="${padT}" y2="${H - padB}" stroke="${m.color}" stroke-width="1" stroke-dasharray="2 3"/><text x="${X_(m.t) > W - padR - 50 ? X_(m.t) - 4 : X_(m.t) + 4}" y="${padT + 10}" text-anchor="${X_(m.t) > W - padR - 50 ? 'end' : 'start'}" font-size="10" fill="${m.color}" font-family="JetBrains Mono">${m.label}</text>`;
  const ct = r.t[S.cursor];
  if (ct >= x0 && ct <= x1) g += `<line x1="${X_(ct)}" x2="${X_(ct)}" y1="${padT}" y2="${H - padB}" stroke="#d8d8d8" stroke-width="1"/>`;
  // legend (top-left, like Revel plots)
  const lg = series.filter(s => s.legend !== false);
  const lw = 176, lh = 6 + lg.length * 16;
  g += `<rect x="${padL + 2}" y="${padT + 2}" width="${lw}" height="${lh}" fill="#0a0a0a" opacity=".86"/>`;
  lg.forEach((s, k) => { const y = padT + 16 + k * 16, v = s.v[S.cursor]; g += `<rect x="${padL + 8}" y="${y - 8}" width="9" height="9" fill="${s.color}" opacity=".85"/><text x="${padL + 23}" y="${y}" font-size="11" fill="#8a8a8a" font-family="JetBrains Mono">${s.name}</text><text x="${padL + lw - 6}" y="${y}" font-size="11" fill="#cfcfcf" text-anchor="end" font-family="JetBrains Mono">${Number.isFinite(v) ? v.toFixed(s.dp ?? 1) : '—'}</text>`; });
  svg.innerHTML = g;
  svg.onclick = ev => { const b = svg.getBoundingClientRect(); const t = x0 + ((ev.clientX - b.left) * W / b.width - padL) / (W - padL - padR) * (x1 - x0); S.cursor = Math.max(0, Math.min(r.n - 1, Math.round(t / X.DT))); renderDynamic(); };
}
function smooth(v, k) { const o = new Float64Array(v.length).fill(NaN); let s = 0, n = 0; for (let i = 0; i < v.length; i++) { if (Number.isFinite(v[i])) { s += v[i]; n++; } if (i >= k && Number.isFinite(v[i - k])) { s -= v[i - k]; n--; } o[i] = n && Number.isFinite(v[i]) ? s / n : NaN; } return o; }
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }

function renderPlots() {
  const r = run(), a = an();
  const marks = [];
  if (a.detected) marks.push({ t: a.detectT, color: '#5ff08f', label: 'XC' });
  if (r.abort) marks.push({ t: r.abort.t, color: '#ff6a72', label: 'ABORT' });
  // plot A: the channel under suspicion vs its cross-check estimate
  let chId, est, hw, title;
  if (a.virtual) { chId = a.virtual.ch; est = a.virtual.values; hw = a.virtual.halfWidth; title = `${chId} vs cross-check`; }
  else {
    const relId = a.detected ? (a.iso.groups[0].best.rel || model.rels[X.CH_IDS.indexOf(a.iso.groups[0].best.ch)]?.id || 'thrust') : 'fuel_injector';
    const e = model.rels.findIndex(x => x.id === (a.detected && a.iso.groups[0].best.kind === 'sensor' ? model.rels.find(R => R.target === a.iso.groups[0].best.ch)?.id : relId));
    const R = model.rels[e < 0 ? 3 : e], ee = model.rels.indexOf(R);
    chId = R.target; hw = cal.thresholds[ee];
    est = smooth(Float64Array.from(r.ch[chId], (v, i) => v - a.r[ee][i]), 10);
    title = `${chId} vs ${R.id} relation`;
  }
  const m = chMeta(chId);
  const svgA = plotFrame($('plotA'), title, m.unit.toUpperCase());
  const lo = Float64Array.from(est, v => v - hw), hi = Float64Array.from(est, v => v + hw);
  const red = X.REDLINES.find(x => x.ch === chId && x.op === '<');
  drawPlot(svgA, [
    { name: chId, v: a.virtual ? r.ch[chId] : smooth(r.ch[chId], 10), color: '#8b5cf6' },
    { name: a.virtual ? 'cross_check' : 'relation', v: est, color: '#06c94a', w: 1.6 },
  ], { bands: a.virtual ? [{ lo, hi, color: '#06c94a' }] : [], hlines: red ? [{ v: red.value, color: '#b3202a' }] : [], marks, include: red && r.abort ? [red.value] : [] });
  // plot B: normalized residuals and the calibrated limit
  const svgB = plotFrame($('plotB'), 'Sustained residual · 200 ms', 'σ');
  a.susSigned ||= model.rels.map((R, k) => X.sustainedSigned(Float64Array.from(a.r[k], x => x / model.scale[k]), a.mask));
  const ser = model.rels.map((R, e) => ({ name: R.id, v: a.susSigned[e], color: COLORS[e], w: 1.4, dp: 2 }));
  drawPlot(svgB, ser, { hlines: Number.isFinite(cal.Q) ? [{ v: cal.Q, color: '#7a7a7a' }, { v: -cal.Q, color: '#7a7a7a' }] : [], marks, include: Number.isFinite(cal.Q) ? [cal.Q, -cal.Q] : [] });
}

// ------------------------------------------------------------------ relations table
function renderRelations() {
  const a = an();
  $('relMeta').textContent = `fit ${model.nTrain} runs · limits ${cal.nCal} runs`;
  const rows = model.rels.map((R, e) => {
    const f = a.fires[e], unit = chMeta(R.target).unit;
    const st = f.firstIdx !== null ? `<span class="badge red">FIRING</span>` : `<span class="badge gray">OK</span>`;
    return `<tr><td>${R.id}</td><td class="dim sm">${[R.target, ...R.features].join(' ')}</td><td class="r">${R.r2.toFixed(3)}</td><td class="r">±${fx(cal.thresholds[e], 2)}<span class="ty-tag">${unit}</span></td><td class="r">${fx(f.peak, 2)}σ</td><td>${st}</td></tr>`;
  });
  $('relTable').innerHTML = `<tr><th>Relation</th><th>Sensors</th><th class="r">R²</th><th class="r">Limit</th><th class="r">Peak</th><th>Status</th></tr>${rows.join('')}`;
}

// ------------------------------------------------------------------ RevelCode
function highlight(line) {
  if (/^\s*#/.test(line)) return `<span class="cm">${line}</span>`;
  return line
    .replace(/\|([A-Za-z0-9_.]+)\|/g, '<span class="ch">|$1|</span>')
    .replace(/\b(loop|alert)\b(\s+)([a-z_]+)/g, '<span class="k">$1</span>$2<span class="nm">$3</span>')
    .replace(/\b(severity|arm|trigger)\b/g, '<span class="nm">$1</span>')
    .replace(/\bSeverity\b/g, '<span class="ty">Severity</span>')
    .replace(/\b(or|and|not)\b/g, '<span class="k">$1</span>')
    .replace(/(^|[\s(,-])(\d+\.\d+|\d+)(?=[\s,)])/g, '$1<span class="num">$2</span>');
}
function renderCode() {
  const code = X.revelCode(model, cal);
  $('code').innerHTML = code.split('\n').map((l, k) => `<span class="ln">${k + 1}</span>${highlight(l)}`).join('\n');
  $('codeNote').textContent = 'generated draft · review before deploying';
  $('copyBtn').onclick = () => navigator.clipboard?.writeText(code).then(() => { $('copyBtn').textContent = 'Copied'; setTimeout(() => $('copyBtn').textContent = 'Copy', 1200); });
  $('exportBtn').onclick = () => { const b = new Blob([code], { type: 'text/plain' }); const u = URL.createObjectURL(b); const l = document.createElement('a'); l.href = u; l.download = 'cross_check.rvl'; l.click(); URL.revokeObjectURL(u); };
}

// ------------------------------------------------------------------ calibration + instrumentation
function renderCalib() {
  const mdb = X.minDetectableBias(model, cal);
  const naiveCal = { thresholds: model.scale.map(s => 4 * s) };
  const mdbNaive = X.minDetectableBias(model, naiveCal);
  const bound = S.mode === 'pac' ? cal.bound90 : cal.expected;
  $('calib').innerHTML = `<div class="kv">
    <div><div class="lb">baseline fit</div><div class="vl">${model.nTrain} <small>runs</small></div></div>
    <div><div class="lb">calibration</div><div class="vl">${cal.nCal} <small>runs · k = ${Math.min(cal.k, cal.nCal)}</small></div></div>
    <div><div class="lb">limit (all relations)</div><div class="vl">${fx(cal.Q, 2)} <small>σ for ${X.PERSIST} cycles</small></div></div>
    <div><div class="lb">guaranteed bound</div><div class="vl">${cal.feasible ? '≤ ' + pct(bound) : 'n/a'} <small>${S.mode === 'pac' ? '90% conf.' : 'average'}</small></div></div>
    <div><div class="lb">held-out nominal runs</div><div class="vl">${Math.round(held.conformalRate * held.nRuns)} / ${held.nRuns} <small>fired (${pct(held.conformalRate)})</small></div></div>
    <div><div class="lb">PT_FM_21 detectable bias</div><div class="vl">${fx(mdb.PT_FM_21.bias, 1)} <small>psi · naive 4σ: ${fx(mdbNaive.PT_FM_21.bias, 1)}</small></div></div>
  </div>
  <div class="note">${cal.feasible ? `Each run is scored by its largest sustained excursion across all ${E} relations, in units of that relation's spread. The limit is the ${ordinal(Math.min(cal.k, cal.nCal))} smallest score among ${cal.nCal} nominal calibration runs, so a new nominal run fires any cross-check alert with probability ${S.mode === 'pac' ? `at most <b>${pct(bound)}</b>, with 90% confidence over the calibration draw` : `<b>${pct(bound)}</b> on average over calibration draws`}. On ${held.nRuns} fresh simulated nominal runs it fired ${pct(held.conformalRate)}. A hand-set 4σ  persistence limit fired ${pct(held.naiveRate)} but needs a ${fx(mdbNaive.PT_FM_21.bias / mdb.PT_FM_21.bias, 1)}× larger fuel-manifold bias to notice.` : `A ${pct(S.alpha, 0)} budget with a ${S.mode === 'pac' ? '90%-confidence' : 'finite-sample'} guarantee needs at least <b>${cal.nNeeded}</b> nominal calibration runs; this campaign has ${cal.nCal}. Raise the budget or record more nominal runs.`}</div>${calStrip()}`;
}
function calStrip() {
  const W = 640, H = 92, pl = 10, pr = 46, top = 14;
  const all = [...cal.scores, held.naiveK, Number.isFinite(cal.Q) ? cal.Q : 0];
  const recentS = analyses.map(a => a.S);
  const xmax = Math.max(...all, 5) * 1.08;
  const X_ = v => pl + Math.min(v, xmax) / xmax * (W - pl - pr);
  let g = `<line x1="${pl}" x2="${W - pr}" y1="${H - 22}" y2="${H - 22}" stroke="#262626"/>`;
  for (let v = 0; v <= xmax; v += 1) g += `<line x1="${X_(v)}" x2="${X_(v)}" y1="${top}" y2="${H - 22}" stroke="#161616"/><text x="${X_(v)}" y="${H - 8}" font-size="10" fill="#5a5a5a" text-anchor="middle" font-family="JetBrains Mono">${v}</text>`;
  const rnd = X.mulberry32(11);
  cal.scores.forEach(v => { g += `<circle cx="${X_(v)}" cy="${top + 10 + rnd() * 36}" r="2.6" fill="#8a8a8a" opacity=".85"/>`; });
  recentS.forEach((v, k) => { const over = v > xmax; g += `<circle cx="${over ? W - pr + 8 : X_(v)}" cy="${top + 4}" r="3.2" fill="${analyses[k].detected ? '#f7222f' : '#06c94a'}"/>`; });
  if (Number.isFinite(cal.Q)) g += `<line x1="${X_(cal.Q)}" x2="${X_(cal.Q)}" y1="${top - 6}" y2="${H - 22}" stroke="#e8e8e8" stroke-dasharray="3 3"/><text x="${X_(cal.Q) + 4}" y="${top + 2}" font-size="10" fill="#e8e8e8" font-family="JetBrains Mono">limit ${cal.Q.toFixed(2)}σ</text>`;
  g += `<line x1="${X_(held.naiveK)}" x2="${X_(held.naiveK)}" y1="${top - 6}" y2="${H - 22}" stroke="#7a5a2a" stroke-dasharray="3 3"/><text x="${X_(held.naiveK) + 4}" y="${H - 26}" font-size="10" fill="#b08040" font-family="JetBrains Mono">naive 4σ</text>`;
  g += `<text x="${W - pr + 4}" y="${top + 30}" font-size="10" fill="#5a5a5a" font-family="JetBrains Mono">σ</text>`;
  return `<div class="strip"><div class="strip-lg"><span><i style="background:#8a8a8a"></i>${cal.nCal} calibration runs</span><span><i style="background:#06c94a"></i>recent nominal</span><span><i style="background:#f7222f"></i>recent flagged (off-scale →)</span></div><svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg></div>`;
}
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

const ADVICE = {
  PT_OM_22: 'A PT at the OX venturi exit would split them, as PT_FVX_13 does on the fuel side.',
  LC_TH_41: 'A second load cell, or a chamber-pressure-to-thrust check on a calibration stand, would split them.',
  PT_FT_01: 'Only matters if the feed line itself is suspect; a second ullage PT would split them.',
  PT_OT_02: 'Only matters if the feed line itself is suspect; a second ullage PT would split them.',
  PT_FVX_13: 'A valve position indicator on FV06 would separate a slow valve from a bad transducer.',
};
function renderInstr() {
  const mdb = X.minDetectableBias(model, cal);
  const rows = X.CH_IDS.map((c, j) => {
    const h = model.hyps.find(x => x.key === 'sensor:' + c);
    const mates = model.hyps.filter(x => x.group === h.group && x !== h);
    const nrel = model.G.filter(row => Math.abs(row[j]) > 0.05).length;
    return `<tr><td>${c}</td><td class="r">${nrel}</td><td class="r">${fx(mdb[c].bias, 1)} ${chMeta(c).unit}</td><td>${mates.length ? `<span class="badge amber">SHARED</span> <span style="color:#9a9a9a">${mates.map(m => m.label).join(', ')}</span>` : `<span class="badge green">ISOLABLE</span>`}</td></tr>`;
  });
  const amb = X.ambiguityGroups(model).filter(g => g.length > 1);
  $('instr').innerHTML = `<table class="tbl"><tr><th>Sensor</th><th class="r">Relations</th><th class="r">Detectable bias</th><th>Fault signature</th></tr>${rows.join('')}</table>
    <div class="note">${amb.length} fault pairs share a signature because a single relation covers them. ${amb.filter(g => ['PT_OM_22', 'LC_TH_41'].includes(g.find(h => h.kind === 'sensor')?.ch)).map(g => { const sname = g.find(h => h.kind === 'sensor').ch; return `<b>${sname}</b>: ${ADVICE[sname]}`; }).join(' ')}</div>`;
}

// ------------------------------------------------------------------ campaign table
function renderCampaign() {
  const rows = recent.map((r, k) => {
    const a = analyses[k], v = verdict(a);
    const badge = v.kind === 'nominal' ? `<span class="badge green">NOMINAL</span>` : v.kind === 'sensor' ? `<span class="badge red">SENSOR</span>` : `<span class="badge amber">${v.kind === 'component' ? 'HARDWARE' : 'AMBIGUOUS'}</span>`;
    const iso = a.detected ? a.iso.groups[0].members.map(m => m.kind === 'sensor' ? m.ch : m.label).join(' / ') : '—';
    return `<tr class="click ${k === S.run ? 'sel' : ''}" data-k="${k}"><td>${r.name}</td><td class="dim">${recordedAt(k)}</td><td class="r">${(r.events.shutdown - r.events.mainstage).toFixed(2)} s</td><td>${r.abort ? `<span class="badge red">ABORT</span> <span style="color:#9a9a9a">${r.abort.alert}</span>` : '<span class="dim" style="color:#6a6a6a">none</span>'}</td><td>${badge}</td><td>${iso}</td><td class="r">${fx(a.S, 2)}σ</td><td class="r">${fx(a.pRun, 3)}</td><td class="r">${a.detected ? 't+' + rel(a.detectT).toFixed(2) + ' s' : '—'}</td></tr>`;
  }).reverse();
  $('campaign').innerHTML = `<tr><th>Run</th><th>Recorded</th><th class="r">Mainstage</th><th>Redline</th><th>Cross-check</th><th>Isolated to</th><th class="r">Score</th><th class="r">p</th><th class="r">Detected</th></tr>${rows.join('')}`;
  $('campaign').querySelectorAll('tr.click').forEach(tr => tr.onclick = () => { selectRun(+tr.dataset.k); window.scrollTo({ top: 0, behavior: 'smooth' }); });
}

// ------------------------------------------------------------------ render
function renderDynamic() { renderReadouts(); renderPID(); renderScrub(); renderPlots(); }
function render() {
  const r = run();
  $('runTitle').textContent = r.name;
  document.title = `${r.name} · Cross-check · Revel`;
  $('recorded').textContent = `RECORDED: ${recordedAt(S.run)}`;
  const nRed = recent.filter(x => x.abort).length;
  $('alertCount').textContent = r.abort ? '1' : '0';
  renderSidebar(); renderIso(); renderRelations(); renderCode(); renderCalib(); renderInstr(); renderCampaign(); renderDynamic();
}

// controls
document.querySelectorAll('#alphaSeg button').forEach(b => b.onclick = () => { S.alpha = +b.dataset.a; document.querySelectorAll('#alphaSeg button').forEach(x => x.classList.toggle('on', x === b)); recompute(); selectRun(S.run); });
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => { S.mode = b.dataset.m; document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b)); recompute(); selectRun(S.run); });
const track = $('scrub'); let drag = false;
track.addEventListener('mousedown', e => { drag = true; setCursorFromX(track, e.clientX); });
window.addEventListener('mousemove', e => { if (drag) setCursorFromX(track, e.clientX); });
window.addEventListener('mouseup', () => { drag = false; });
let timer = null;
$('playBtn').onclick = () => {
  if (timer) { clearInterval(timer); timer = null; return; }
  timer = setInterval(() => { S.cursor = (S.cursor + 3) % run().n; renderDynamic(); }, 30);
};
window.addEventListener('resize', () => renderPlots());

// deep links: #hot_fire_0327, #hot_fire_0324&alpha=0.1&mode=marginal
const hp = new URLSearchParams(location.hash.slice(1).replace(/^([^=&]+)(&|$)/, 'run=$1$2'));
if (hp.get('alpha')) { S.alpha = +hp.get('alpha'); document.querySelectorAll('#alphaSeg button').forEach(x => x.classList.toggle('on', +x.dataset.a === S.alpha)); }
if (hp.get('mode')) { S.mode = hp.get('mode'); document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x.dataset.m === S.mode)); }
const hk = recent.findIndex(r => r.name === hp.get('run'));
recompute();
selectRun(hk >= 0 ? hk : S.run);
