# Sensor Cross-Check for Revel (concept demo)

**Live demo:** https://mohith26.github.io/revel-sensor-cross-check/

A working concept for a new tab on a Revel run: **is that redline the engine, or the transducer?**

On a hot fire, a single bad pressure transducer can trip a redline and end the test, or (worse) read normal while the hardware drifts. Test engineers already hand-write pairwise checks for this in RevelCode (for example `persistence(|PT_X701_readout| - |PT_H139_readout| > 0.0, 3)` for manifold back-flow). Cross-Check generalizes that idea:

1. **Relations come from the P&ID.** Every component between two sensed points (feed line, main fuel valve, injector, combustion, thrust takeout) gives one physical relation between the transducers around it. Seven relations for this bi-prop stand.
2. **Each relation is fit on nominal runs** (OLS on physically motivated linear terms) and becomes a residual channel.
3. **Alert limits are calibrated, not guessed.** Limits use RevelCode `persistence()` semantics (residual beyond ±q for 20 consecutive cycles) and are set by split conformal prediction over whole runs, so the chance that *any* cross-check alert fires on a new nominal run is bounded: on average (marginal mode) or with 90% confidence over the calibration draw (default, via the Beta distribution of conformal coverage).
4. **Isolation.** When relations fire, a generalized likelihood ratio over whitened window-mean residuals ranks single-fault hypotheses: one sensor biased, or one component changed. Hypotheses whose fault directions are parallel are reported together as an ambiguity group, which doubles as instrumentation advice (where an extra PT would split them).
5. **Virtual reading.** For an isolated sensor, the remaining relations give an estimate of what it should read, with a conformal 90% interval.
6. **Export.** The fitted relations and limits are emitted as plain RevelCode `loop` + `alert` blocks, so the check runs deterministically on the box with no model in the loop.

## What the demo shows (seeded synthetic campaign)

The simulator is a pressure-fed LOX/RP-1 500 lbf thruster with cavitating venturis (tank 350 psi, venturi 340, manifold 300, chamber 250 psi, thrust 500 lbf, MR 2.6), with run-to-run setpoints, hardware tolerances, transducer zero shifts, regulator ripple and combustion roughness. 50 nominal runs fit the relations, 70 calibrate the limits, and 12 recent runs are analyzed:

| Run | What was injected | Existing redlines | Cross-check |
|---|---|---|---|
| hot_fire_0332 | PT_FM_21 transducer drifts at 22 psi/s | `Fuel_manifold_low_pres` aborts at t+3.48 s | fires at t+1.52 s, isolates **PT_FM_21** (>99.9% relative likelihood); virtual manifold pressure stays near 297-301 psi |
| hot_fire_0327 | fuel injector restriction (+22% ΔP coefficient) | nothing fires | **hardware change: fuel injector**; transducers mutually consistent |
| hot_fire_0324 | load cell zero shift +26 lbf | nothing fires | **LC_TH_41 or thrust takeout** (ambiguity group: one relation covers both) |
| 9 others | nominal | nothing | nominal |

All numbers on the page are computed in the browser from the seeded simulator (`core/crosscheck.js`); nothing is hard-coded. `node scripts/generate.mjs` writes `data/hot_fire_0332.csv` and `data/summary.json` for inspection.

## Tests

```
node --test test/crosscheck.test.mjs
```

11 tests: simulator determinism and operating point; relation fits and coefficient signs; the sensitivity matrix equals the true residual response to a sensor bias; conformal quantile / p-value edge cases; Beta upper bound closed form; persistence semantics match RevelCode `persistence(u > q, N) or persistence(u < -q, N)`; average false-alert rate over 12 calibration draws stays at or below alpha; PAC-mode held-out rate under its 90% bound; nominal runs stay quiet and the three faults are detected and isolated correctly (including the virtual sensor covering the true manifold pressure); ambiguity groups follow the P&ID; generated RevelCode has one loop and alert per relation.

## Honest limitations

- **Synthetic data.** The stand, physics and faults are simulated. Real stands add transients, valve timing, thermal drift and sensor dropouts that the seven linear relations here do not model; relations would need to be state-gated beyond MAINSTAGE and possibly nonlinear.
- **Exchangeability.** The guarantee assumes calibration runs and the new run are exchangeable. A hardware change between campaigns (new injector, re-plumbed line) breaks that; the baseline should be re-fit per configuration, and a drift check on the run scores would be the next step.
- **Single-fault isolation.** The GLR ranks one-fault hypotheses. Two simultaneous faults can be misattributed; the "unexplained residual" p-value is the warning sign.
- **Relations are hand-declared from the P&ID here.** In the product they would be derived from the dashboard JSON topology and the hardware config; I have not seen that schema.
- **RevelCode syntax** is inferred from public screenshots (`alert`, `severity`, `arm`, `trigger = persistence(...)`, `loop`, channel writes). The generated file is a draft to review, not code I could compile.
- **Advisory only.** Cross-check does not suppress redlines. It tells the operator which reading to trust and why.

## Novelty note

I could not find this in Revel's public material (product pages, RevelCode page, newsroom posts through Oct 27, 2026). The closest shipped feature in the space is Sift's *Families* and *Family Rules* (statistical envelopes around time-aligned baseline runs, e.g. ±3σ of the family mean). That compares each channel against its own history; it does not use the P&ID to relate channels to each other, isolate a bad transducer from a hardware change, or give calibrated run-level false-alert guarantees. Analytical redundancy and structured residuals are classic fault-detection ideas (e.g. NASA's SSME sensor-validation work, Gertler's structured residuals); the new part is deriving them from the P&ID a team already draws, calibrating them with conformal prediction, and compiling them to deterministic control-language alerts.

---
Unofficial concept demo by Mohith Gajjela. Not affiliated with Revel. Synthetic data. UI fonts: Inter (stand-in for Revel's Untitled Sans) and JetBrains Mono.
