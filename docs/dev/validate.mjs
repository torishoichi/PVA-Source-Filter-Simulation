#!/usr/bin/env node
/*
 * validate.mjs — accuracy regression harness for dsp-core.js.
 *
 * Synthesizes source-filter vowels with KNOWN f0 and formants, then measures the
 * error of the production DSP routines. No browser, no audio device. Run:
 *     node docs/dev/validate.mjs
 * Exit code 0 if all gates pass, 1 otherwise (CI-friendly).
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DSP = require(path.join(here, '..', 'dsp-core.js'));

let failures = 0;
const pass = (s) => console.log('  \x1b[32m✓\x1b[0m ' + s);
const fail = (s) => { console.log('  \x1b[31m✗ ' + s + '\x1b[0m'); failures++; };
const hz = (x) => (x == null ? 'null' : x.toFixed(1) + 'Hz');
const cents = (a, b) => 1200 * Math.log2(a / b);

// Frame extractor centered at time t (sec) of length N from a signal.
function frameAt(sig, sr, tSec, N) {
  const start = Math.round(tSec * sr) - (N >> 1);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) { const idx = start + i; out[i] = (idx >= 0 && idx < sig.length) ? sig[idx] : 0; }
  return out;
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m1. YIN pitch accuracy (steady tones, 44.1 kHz)\x1b[0m');
{
  const sr = 44100;
  const cases = [82.41, 110, 146.83, 220, 329.63, 440, 660, 880];
  let worst = 0;
  // Neutral formants kept clear of 2×f0 for the tested notes — this isolates the
  // core detector. The formant-on-harmonic octave trap is exercised in test 2,
  // where the contour's multi-candidate + Viterbi stage is responsible for it.
  for (const f0 of cases) {
    const sig = DSP.synthVowel({ sr, dur: 0.4, f0, formants: [520, 1700, 2600, 3400, 4500] });
    const frame = frameAt(sig, sr, 0.2, 2048);
    const { hz: est } = DSP.yin(frame, sr);
    const err = est > 0 ? Math.abs(cents(est, f0)) : 9999;
    worst = Math.max(worst, err);
    const line = `f0=${f0.toFixed(1)}Hz → ${hz(est)}  (${err.toFixed(1)}¢)`;
    err < 15 ? pass(line) : fail(line);
  }
  console.log(`  worst-case error: ${worst.toFixed(1)}¢ (gate: <15¢)`);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m1b. refinePeriod — seeded narrow-band period refinement (H1 meter path)\x1b[0m');
{
  // The H1 meter reads f0 to ~0.1-0.3 Hz. refinePeriod replaces the full-range
  // YIN there, seeded by the pitch tracker, so it must hit the same precision on
  // both a 48 kHz context and the 16 kHz one AirPods/HFP can force.
  let worst = 0;
  for (const sr of [48000, 16000]) {
    const N = 4096;
    for (const f0 of [110, 220, 330, 440, 660, 880]) {
      const sig = DSP.synthVowel({ sr, dur: 0.5, f0, formants: [700, 1220, 2600, 3400, 4500] });
      const frame = frameAt(sig, sr, 0.25, N);
      // seed is deliberately off by +3% — the live tracker is never exact
      const r = DSP.refinePeriod(frame, sr, f0 * 1.03);
      const err = r ? Math.abs(r.hz - f0) : 9999;
      worst = Math.max(worst, err);
      const line = `${sr / 1000}kHz f0=${f0}Hz → ${r ? hz(r.hz) : 'null'}  (${err.toFixed(3)} Hz)`;
      err < 0.3 ? pass(line) : fail(line);
    }
  }
  console.log(`  worst-case error: ${worst.toFixed(3)} Hz (gate: <0.3 Hz)`);
  // Degenerate inputs must return null rather than throw / lie.
  const silent = new Float64Array(4096);
  const guards = [
    ['silent frame', DSP.refinePeriod(silent, 48000, 220)],
    ['no seed', DSP.refinePeriod(silent, 48000, 0)],
    ['seed below window resolution', DSP.refinePeriod(new Float64Array(64), 48000, 50)],
  ];
  for (const [label, r] of guards) (r === null) ? pass(`${label} → null`) : fail(`${label} → ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m2. Offline pitch contour (Viterbi) — octave-error robustness\x1b[0m');
{
  const sr = 44100;
  // Two notes prone to octave traps: G3 with a formant on H2, plus aspiration.
  const checkContour = (f0, F, asp, label) => {
    const sig = DSP.synthVowel({ sr, dur: 1.0, f0, formants: F, aspiration: asp });
    const contour = DSP.pitchContour(Float32Array.from(sig), sr);
    let bad = 0, tot = 0;
    for (const fr of contour) {
      if (fr.t < 0.15 || fr.t > 0.85 || fr.hz == null) continue;
      tot++; if (Math.abs(cents(fr.hz, f0)) > 50) bad++;
    }
    const rate = tot ? (100 * (tot - bad) / tot) : 0;
    const line = `${label}: ${rate.toFixed(0)}% frames within ±50¢ (${tot} voiced)`;
    rate >= 95 ? pass(line) : fail(line);
  };
  checkContour(196, [400, 800, 2600, 3400, 4500], 0.4, 'G3 held + 0.4 aspiration');
  checkContour(330, [700, 1220, 2600, 3400, 4500], 0.2, 'E4 with F1 on H2 (octave trap)');
  // Guard against over-collapse: a clean tone whose 2× period is NOT a real dip
  // must stay on f0, not drop an octave.
  checkContour(262, [600, 1500, 2600, 3400, 4500], 0.0, 'C4 clean (no over-collapse)');
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m3. Offline formant accuracy — male & female vowels\x1b[0m');
{
  const sr = 44100;
  // Hillenbrand-ish reference formants
  const vowels = {
    'ɑ (male, f0=120)':  { f0: 120, F: [730, 1090, 2440, 3400, 4500] },
    'i (male, f0=120)':  { f0: 120, F: [270, 2290, 3010, 3700, 4500] },
    'u (male, f0=120)':  { f0: 120, F: [300,  870, 2240, 3400, 4500] },
    'ɛ (fem,  f0=220)':  { f0: 220, F: [600, 2350, 2900, 3600, 4700] },
    'ɑ (fem,  f0=260)':  { f0: 260, F: [850, 1220, 2810, 3600, 4700] },
    // High-pitch gates — covered by the f0-adaptive LPC order (lpcOrderForF0):
    // at fixed order 13 these were err 186/194 (ɑ@340) and err 4/71 (i@300).
    'ɑ (fem,  f0=340)':  { f0: 340, F: [850, 1220, 2810, 3600, 4700] },
    'i (fem,  f0=300)':  { f0: 300, F: [310, 2790, 3310, 3900, 4950] },
  };
  for (const [name, v] of Object.entries(vowels)) {
    const sig = DSP.synthVowel({ sr, dur: 0.6, f0: v.f0, formants: v.F });
    const mono = Float32Array.from(sig);
    const track = DSP.offlineFormants(mono, sr);
    // median of middle frames
    const mid = track.frames.slice(Math.floor(track.frames.length * 0.3), Math.floor(track.frames.length * 0.7));
    const med = (key) => { const a = mid.map(f => f && f[key]).filter(x => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
    const e1 = med('f1'), e2 = med('f2');
    const err1 = e1 ? Math.abs(e1 - v.F[0]) : 9999;
    const err2 = e2 ? Math.abs(e2 - v.F[1]) : 9999;
    // F1 gate scales a little with f0 (sparser harmonics at high f0)
    const g1 = v.f0 >= 220 ? 90 : 60;
    const g2 = v.f0 >= 220 ? 180 : 120;
    const line = `${name}: F1 ${hz(e1)} (err ${err1.toFixed(0)}, gate ${g1}) | F2 ${hz(e2)} (err ${err2.toFixed(0)}, gate ${g2})`;
    (err1 < g1 && err2 < g2) ? pass(line) : fail(line);
  }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m4. CPP & H1–H2 — ordinal validity (pressed vs breathy)\x1b[0m');
{
  const sr = 44100, f0 = 180, F = [600, 1000, 2500, 3400, 4500];
  const pressed = DSP.synthVowel({ sr, dur: 0.5, f0, formants: F, oq: 0.4, aspiration: 0.0 });
  const breathy = DSP.synthVowel({ sr, dur: 0.5, f0, formants: F, oq: 0.85, aspiration: 0.5 });
  const frP = frameAt(pressed, sr, 0.25, 4096), frB = frameAt(breathy, sr, 0.25, 4096);
  const cppP = DSP.cpps(frP, sr).cpp, cppB = DSP.cpps(frB, sr).cpp;
  const hP = DSP.h1h2(frP, sr, f0).h1h2, hB = DSP.h1h2(frB, sr, f0).h1h2;
  let line = `CPP: pressed ${cppP.toFixed(2)} > breathy ${cppB.toFixed(2)}`;
  cppP > cppB ? pass(line) : fail(line);
  line = `H1–H2: breathy ${hB.toFixed(1)}dB > pressed ${hP.toFixed(1)}dB`;
  hB > hP ? pass(line) : fail(line);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m4b. H1*–H2* formant correction — vowel-independence\x1b[0m');
{
  const sr = 44100, f0 = 150;
  const vowels = { 'ɑ': [730, 1090, 2440, 3400, 4500], 'i': [270, 2290, 3010, 3700, 4500], 'u': [300, 870, 2240, 3400, 4500], 'e': [530, 1840, 2480, 3500, 4500], 'o': [570, 840, 2410, 3400, 4500] };
  const med = (a) => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
  const raw = [], cor = [];
  for (const F of Object.values(vowels)) {
    const sig = DSP.synthVowel({ sr, dur: 0.6, f0, formants: F, oq: 0.6 });
    const rr = [], cc = [];
    for (let t = 0.15; t < 0.45; t += 0.04) { const h = DSP.h1h2(frameAt(sig, sr, t, 4096), sr, f0, { formants: F }); if (h) { rr.push(h.h1h2); cc.push(h.h1h2c); } }
    raw.push(med(rr)); cor.push(med(cc));
  }
  const sRaw = Math.max(...raw) - Math.min(...raw), sCor = Math.max(...cor) - Math.min(...cor);
  const line = `vowel spread: raw H1–H2 ${sRaw.toFixed(1)} dB → corrected H1*–H2* ${sCor.toFixed(1)} dB`;
  (sCor < sRaw * 0.4 && sCor < 4) ? pass(line) : fail(line);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m5. IAIF glottal source — NAQ tracks open quotient\x1b[0m');
{
  const sr = 44100, f0 = 130, F = [650, 1080, 2500, 3400, 4500];
  // Low OQ (adducted/pressed) should give a LOWER NAQ than high OQ (breathy).
  const adduct = DSP.synthVowel({ sr, dur: 0.5, f0, formants: F, oq: 0.45 });
  const abduct = DSP.synthVowel({ sr, dur: 0.5, f0, formants: F, oq: 0.85 });
  const naq = (sig) => {
    const vals = [];
    for (let t = 0.15; t < 0.4; t += 0.03) {
      const fr = frameAt(sig, sr, t, Math.round(sr * 0.04));
      const r = DSP.iaifGlottal(fr, sr);
      if (r && r.naq != null && isFinite(r.naq) && r.naq > 0 && r.naq < 1) vals.push(r.naq);
    }
    vals.sort((a, b) => a - b);
    return vals.length ? vals[vals.length >> 1] : null;
  };
  const nA = naq(adduct), nB = naq(abduct);
  const line = `NAQ: adducted ${nA == null ? 'null' : nA.toFixed(3)} < breathy ${nB == null ? 'null' : nB.toFixed(3)}`;
  (nA != null && nB != null && nB > nA) ? pass(line) : fail(line);

  // NAQ must be available for ALL vowels incl. close /i/,/u/ (the order-1 LPC
  // pre-whitening used to abort on their low F1 → null source readout).
  const vw = { 'ɑ': [730, 1090, 2440, 3400, 4500], 'i': [270, 2290, 3010, 3700, 4500], 'u': [300, 870, 2240, 3400, 4500], 'e': [530, 1840, 2480, 3500, 4500], 'o': [570, 840, 2410, 3400, 4500] };
  const missing = [];
  for (const [v, F] of Object.entries(vw)) {
    if (naq(DSP.synthVowel({ sr, dur: 0.5, f0: 150, formants: F, oq: 0.6 })) == null) missing.push(v);
  }
  const l2 = missing.length ? `NAQ null for: ${missing.join(',')}` : 'NAQ available for all 5 vowels (ɑ i u e o)';
  missing.length === 0 ? pass(l2) : fail(l2);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m6. Vibrato-probe: refines when harmonics cover F1, bails out otherwise\x1b[0m');
{
  const sr = 44100;
  const runProbe = (f0, F, vibExtent) => {
    const sig = DSP.synthVowel({ sr, dur: 1.2, f0, formants: F, vibratoExtent: vibExtent, vibratoRate: 5.5 });
    const N = 1024, hop = Math.round(sr * 0.01);
    const nF = Math.floor((sig.length - N) / hop);
    const getFrame = (i) => frameAt(sig, sr, (i * hop + (N >> 1)) / sr, N);
    const f0s = [];
    for (let i = 0; i < nF; i++) { const { hz: e } = DSP.yin(getFrame(i), sr, { fMax: 1100 }); f0s.push(e > 0 ? e : null); }
    return DSP.vibratoProbeFormants(getFrame, f0s, sr, nF, { fCeil: 3500 });
  };
  // (a) Mid f0 where harmonics densely cover F1 → probe should resolve F1 well.
  {
    const f0 = 240, F = [650, 1100, 2600, 3400, 4500]; // H2≈480,H3≈720 straddle F1
    const probe = runProbe(f0, F, 80);
    const err = (probe && probe.f1) ? Math.abs(probe.f1 - F[0]) : 9999;
    const line = `f0=240 /coverage=${probe.coverage} maxGap=${probe.maxGapHz.toFixed(0)}Hz → F1 ${hz(probe.f1)} (true ${F[0]}, err ${err.toFixed(0)})`;
    (probe.coverage && err < 160) ? pass(line) : fail(line);
  }
  // (b) High f0 soprano: harmonics too sparse → MUST report coverage:false so the
  // caller keeps its LPC estimate (the probe never makes things worse).
  {
    const f0 = 540, F = [800, 1150, 2800, 3500, 4700];
    const probe = runProbe(f0, F, 50);
    const line = `f0=540 /coverage=${probe.coverage} maxGap=${probe.maxGapHz.toFixed(0)}Hz → honest bail-out`;
    (probe.coverage === false) ? pass(line) : fail(line);
  }
  // (c) "Never worse" contract over a vibrato note: the probe must EITHER improve on
  // plain LPC F1 OR bail (null) so the caller keeps LPC. It must never return a
  // non-null F1 that is WORSE than LPC. (Here LPC is already excellent, so bailing
  // out is the correct, safe outcome — the app's hard gate keeps the LPC value.)
  {
    const f0 = 300, F = [620, 1100, 2600, 3400, 4500];
    const sig = DSP.synthVowel({ sr, dur: 1.4, f0, formants: F, vibratoExtent: 90, vibratoRate: 5.5 });
    const track = DSP.offlineFormants(Float32Array.from(sig), sr);
    const mid = track.frames.slice(Math.floor(track.frames.length * 0.3), Math.floor(track.frames.length * 0.7));
    const lpcF1 = (() => { const a = mid.map(f => f && f.f1).filter(x => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; })();
    const probe = runProbe(f0, F, 90);
    const eL = lpcF1 ? Math.abs(lpcF1 - F[0]) : 9999;
    const bail = !probe || probe.f1 == null;
    const eP = bail ? Infinity : Math.abs(probe.f1 - F[0]);
    const line = `f0=300 vibrato: LPC ${hz(lpcF1)} (err ${eL.toFixed(0)}) | probe ${bail ? 'bail→keep LPC' : hz(probe.f1) + ' (err ' + eP.toFixed(0) + ')'}`;
    (bail || eP <= eL + 30) ? pass(line) : fail(line);
  }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m7. Live octave-continuity snap (vibrato/leaps untouched, glitch fixed)\x1b[0m');
{
  const med = 220;
  // transient octave-up glitch → snapped back
  let r = DSP.octaveSnap(440, med);
  (Math.abs(r - 220) < 1) ? pass(`440 with median 220 → ${r.toFixed(0)} (snapped down)`) : fail(`440 → ${r}`);
  // transient octave-down glitch → snapped up
  r = DSP.octaveSnap(110, med);
  (Math.abs(r - 220) < 1) ? pass(`110 with median 220 → ${r.toFixed(0)} (snapped up)`) : fail(`110 → ${r}`);
  // vibrato deviation (±120¢) → untouched
  const vib = 220 * Math.pow(2, 120 / 1200);
  r = DSP.octaveSnap(vib, med);
  (Math.abs(r - vib) < 1) ? pass(`vibrato ${vib.toFixed(1)} (+120¢) → untouched`) : fail(`vibrato → ${r}`);
  // real legato leap of a perfect 4th (+500¢, under the 550¢ gate) → untouched
  const p4 = 220 * Math.pow(2, 500 / 1200);
  r = DSP.octaveSnap(p4, med);
  (Math.abs(r - p4) < 1) ? pass(`P4 leap ${p4.toFixed(1)} (+500¢) → untouched`) : fail(`P4 → ${r}`);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m8. Key shift (WSOLA) — pitch moves by the interval, duration preserved\x1b[0m');
{
  const sr = 44100, f0 = 220, F = [600, 1500, 2600, 3400, 4500];
  const sig = DSP.synthVowel({ sr, dur: 0.6, f0, formants: F });
  for (const semis of [3, -4]) {
    const out = DSP.pitchShift([Float32Array.from(sig)], sr, semis)[0];
    const expect = f0 * Math.pow(2, semis / 12);
    const { hz: got } = DSP.yin(frameAt(out, sr, 0.3, 4096), sr);
    const cents = got > 0 ? 1200 * Math.log2(got / expect) : 9999;
    const lenErr = Math.abs(out.length - sig.length) / sig.length;
    const line = `${semis > 0 ? '+' : ''}${semis} st: f0 ${got.toFixed(1)}Hz (expect ${expect.toFixed(1)}, ${cents.toFixed(0)}¢) | len drift ${(lenErr * 100).toFixed(1)}%`;
    (Math.abs(cents) < 40 && lenErr < 0.02) ? pass(line) : fail(line);
  }
  // 0 semitones must be a true no-op (bit-identical copy)
  const same = DSP.pitchShift([Float32Array.from(sig)], sr, 0)[0];
  let maxd = 0;
  for (let i = 0; i < sig.length; i++) maxd = Math.max(maxd, Math.abs(same[i] - sig[i]));
  (maxd === 0) ? pass('0 st: bit-identical passthrough') : fail(`0 st: max diff ${maxd}`);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m9. envelopeBeat — pitch-free unison-beat (うねり) from the amplitude envelope\x1b[0m');
{
  const sr = 44100;
  const twoTones = (fA, fB, dur, ampB = 1) => {
    const n = Math.round(sr * dur);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = 0.4 * Math.sin(2 * Math.PI * fA * t) + 0.4 * ampB * Math.sin(2 * Math.PI * fB * t);
    }
    return x;
  };
  const fmt = (r) => r.beatHz != null
    ? `${r.beatHz.toFixed(2)}Hz depth ${r.depth.toFixed(2)} str ${r.strength.toFixed(2)}` : 'none';

  // A: 220 + 222.5 Hz equal amplitude, 3 s → beat ≈ 2.5 Hz, deep modulation
  let r = DSP.envelopeBeat(twoTones(220, 222.5, 3), sr);
  let ok = r.beatHz != null && Math.abs(r.beatHz - 2.5) < 0.3 && r.depth > 0.3 && r.strength > 0.6;
  ok ? pass(`220+222.5Hz 3s: ${fmt(r)} (expect ~2.5Hz)`) : fail(`220+222.5Hz 3s: ${fmt(r)} (expect ~2.5Hz)`);

  // B: single steady tone → flat envelope, no beat
  r = DSP.envelopeBeat(twoTones(220, 220, 3, 0), sr);
  ok = r.beatHz == null;
  ok ? pass(`220Hz solo: ${fmt(r)} (no false beat)`) : fail(`220Hz solo: ${fmt(r)} (no false beat)`);

  // C: realistic — voice (small 5¢ wobble) 1.8 Hz sharp of a steady tone
  {
    const dur = 3, n = Math.round(sr * dur);
    const voice = DSP.synthVowel({ sr, dur, f0: 221.8, formants: [700, 1220, 2600, 3400, 4500], vibratoExtent: 5, vibratoRate: 5.5 });
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * voice[i] + 0.25 * Math.sin(2 * Math.PI * 220 * (i / sr));
    r = DSP.envelopeBeat(x, sr);
    ok = r.beatHz != null && Math.abs(r.beatHz - 1.8) < 0.6;
    ok ? pass(`voice 221.8Hz (±5¢ vib) + tone 220Hz: ${fmt(r)} (expect ~1.8Hz)`) : fail(`voice 221.8Hz + tone 220Hz: ${fmt(r)} (expect ~1.8Hz)`);
  }

  // D: in-tune — voice ON the reference (Δ 0.2 Hz ≈ 1.6¢): vibrato leaves some
  // envelope modulation, but its autocorrelation is partial (r ≈ 0.6) while a
  // true beat reads ≈ 1.0 — the 0.7 display threshold must separate the two.
  // Tested at both a modest (±5¢) and a wide (±15¢) vibrato extent.
  for (const ext of [5, 15]) {
    const dur = 3, n = Math.round(sr * dur);
    const voice = DSP.synthVowel({ sr, dur, f0: 220.2, formants: [700, 1220, 2600, 3400, 4500], vibratoExtent: ext, vibratoRate: 5.5 });
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * voice[i] + 0.25 * Math.sin(2 * Math.PI * 220 * (i / sr));
    r = DSP.envelopeBeat(x, sr);
    const falseBeat = r.beatHz != null && r.beatHz > 0.6 && r.strength >= 0.7 && r.depth >= 0.05;
    !falseBeat ? pass(`voice 220.2Hz (±${ext}¢ vib) + tone 220Hz (in tune): ${fmt(r)} (no confident false beat)`) : fail(`in tune ±${ext}¢: ${fmt(r)} (false beat)`);
  }

  // E: slow beat in the fine-tuning region — 0.7 Hz needs the 4 s window
  r = DSP.envelopeBeat(twoTones(220, 220.7, 4), sr);
  ok = r.beatHz != null && Math.abs(r.beatHz - 0.7) < 0.2;
  ok ? pass(`220+220.7Hz 4s: ${fmt(r)} (expect ~0.7Hz)`) : fail(`220+220.7Hz 4s: ${fmt(r)} (expect ~0.7Hz)`);

  // F: fade-out on a single tone (crescendo/decrescendo is NOT a beat)
  {
    const n = Math.round(sr * 3);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (1 - 0.7 * i / n) * 0.5 * Math.sin(2 * Math.PI * 220 * (i / sr));
    r = DSP.envelopeBeat(x, sr);
    const falseBeat = r.beatHz != null && r.strength >= 0.4;
    !falseBeat ? pass(`220Hz fading: ${fmt(r)} (fade ≠ beat)`) : fail(`220Hz fading: ${fmt(r)} (fade read as beat)`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m10. Vibrato analysis — rate (Hz) & extent (¢) measurement accuracy\x1b[0m');
{
  // Deterministic LCG so every run tests the identical signal.
  const makeRand = (seed) => {
    let s = seed >>> 0;
    return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
  };

  // Synthesize a pitch-sample series the way the app sees one: nominal frame
  // clock + timestamp jitter + dropouts, f0 = median · 2^(cents/1200) with
  // vibrato + drift. This tests the ESTIMATOR in isolation (no audio, no YIN).
  const makeSamples = (o) => {
    const rand = makeRand(o.seed != null ? o.seed : 777);
    const fps = o.fps || 60, dur = o.dur || 2.2, f0 = o.f0 || 220;
    const jit = o.jitterMs != null ? o.jitterMs : 6;
    const drop = o.dropout != null ? o.dropout : 0.12;
    const noise = o.noiseCents || 0;
    const drift = o.drift || ((t) => 0);
    const phi = o.phase || 0.7;
    const out = [];
    for (let k = 0; k * (1 / fps) <= dur; k++) {
      const t = k / fps + (rand() * 2 - 1) * jit / 1000;
      if (rand() < drop) { out.push({ t, hz: null, clarity: 0 }); continue; }
      const c = drift(t) + o.extent * Math.sin(2 * Math.PI * o.rate * t + phi)
        + (noise ? (rand() * 2 - 1) * noise : 0);
      out.push({ t, hz: f0 * Math.pow(2, c / 1200), clarity: 0.9 });
    }
    return out;
  };

  const checkVib = (label, r, trueRate, trueExtent, rateTol, extTol) => {
    if (!r) { fail(`${label}: analyzeVibrato returned null`); return; }
    const eR = Math.abs(r.rate - trueRate);
    const eE = Math.abs(r.extent - trueExtent);
    const line = `${label}: rate ${r.rate.toFixed(3)}Hz (err ${(eR * 1000).toFixed(0)}mHz), ` +
      `extent ${r.extent.toFixed(2)}¢ (err ${eE.toFixed(2)}¢, ${r.nCycles} cyc)`;
    (eR <= rateTol && eE <= extTol) ? pass(line) : fail(line);
  };

  // (a) clean estimator sweep — rAF-like clock (60fps, ±6ms jitter, 12% dropouts)
  //     + portamento/messa-di-voce drift. Gates: rate ±0.01 Hz, extent ±0.5¢ or 1%.
  const drift1 = (t) => 40 * t + 15 * t * t;
  let seed = 101;
  for (const R of [4.5, 5.5, 6.5, 7.5]) {
    for (const E of [20, 50, 100]) {
      const r = DSP.analyzeVibrato(makeSamples({ rate: R, extent: E, drift: drift1, seed: seed++ }));
      checkVib(`60fps jitter R=${R} E=${E}`, r, R, E, 0.01, Math.max(0.5, 0.01 * E));
    }
  }

  // (b) playback-grade input — uniform 200 fps, no dropouts (the contour path)
  for (const [R, E] of [[5.0, 30], [6.0, 80]]) {
    const r = DSP.analyzeVibrato(makeSamples({ rate: R, extent: E, fps: 200, jitterMs: 0, dropout: 0, drift: drift1, seed: seed++ }));
    checkVib(`200fps uniform R=${R} E=${E}`, r, R, E, 0.01, Math.max(0.6, 0.01 * E));
  }

  // (c) measurement noise ±3¢ on every sample — looser gates
  {
    const r = DSP.analyzeVibrato(makeSamples({ rate: 5.5, extent: 50, noiseCents: 3, drift: drift1, seed: 55 }));
    checkVib('noisy ±3¢ R=5.5 E=50', r, 5.5, 50, 0.05, 2.5);
  }

  // (d) straight tone must NOT read as vibrato
  {
    const r = DSP.analyzeVibrato(makeSamples({ rate: 5.5, extent: 0, noiseCents: 1.5, seed: 66 }));
    const ext = r ? r.extent : 0;
    const line = `straight tone: extent ${ext.toFixed(2)}¢ (gate <3¢)`;
    ext < 3 ? pass(line) : fail(line);
  }

  // (e) END-TO-END: synthVowel → pitchContour (46 ms YIN windows) → analyzeVibrato.
  //     The f0 window low-passes the modulation; f0WindowSec must undo it (this is
  //     also the calibration anchor for VIB_SINC_K_EFF in dsp-core).
  //     Gates: rate ±0.02 Hz, extent within max(1¢, 1.5%).
  const sr = 44100;
  const F0_WIN_SEC = 512 / 11025; // pitchContour: N=512 on the ~11.025 kHz decimated signal
  for (const [R, E] of [[5.0, 30], [5.5, 80], [6.5, 100]]) {
    const sig = DSP.synthVowel({ sr, dur: 3.0, f0: 220, formants: [700, 1220, 2600, 3400, 4500], vibratoExtent: E, vibratoRate: R });
    const contour = DSP.pitchContour(Float32Array.from(sig), sr);
    const samples = contour.filter(s => s.t >= 0.15 && s.t <= 2.85);
    const r = DSP.analyzeVibrato(samples, { f0WindowSec: F0_WIN_SEC });
    checkVib(`e2e synth R=${R} E=${E}`, r, R, E, 0.02, Math.max(1.0, 0.015 * E));
  }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m11. ASTC (Howell 2016) — absolute tone-color scale & spectral bundles\x1b[0m');
{
  const fmtB = (b) => `${b.label}${b.weakBridge ? '(wb)' : ''} ×${b.complexity} c=${b.centroid.toFixed(1)}Hz`;
  const fmtAll = (bs) => bs.map(fmtB).join(' · ');

  // (a) Figure 15 scale — note names → Hz, band edges = geometric mean of neighbours
  {
    const scale = [[440, 'u'], [659.3, 'o'], [880, 'ɔ'], [830.6, 'ɔ'], [1319, 'ɑ'],
                   [1760, 'a'], [2637, 'æ'], [4186, 'i'], [8000, 'iB']];
    const wrong = scale.filter(([f, k]) => (DSP.astcOf(f) || {}).key !== k)
                       .map(([f, k]) => `${f}→${(DSP.astcOf(f) || {}).key}≠${k}`);
    const line = `scale: ${scale.map(([f, k]) => `${f}→${k}`).join(', ')}`;
    wrong.length === 0 ? pass(line) : fail(`${line}  [${wrong.join(' ')}]`);

    const edgeOk = DSP.astcOf(538.6).key === 'o' && DSP.astcOf(538.5).key === 'u' &&
                   DSP.astcIndex(440) === 0 && DSP.astcIndex(8000) === 7;
    const guardOk = DSP.astcOf(0) === null && DSP.astcOf(-5) === null &&
                    DSP.astcOf(NaN) === null && DSP.astcIndex(0) === -1;
    (edgeOk && guardOk) ? pass('band edges inclusive-low, and 0 / negative / NaN → null')
                        : fail(`edges ${edgeOk} guards ${guardOk}`);
  }

  // (b) Figure 17 — one bundle of H2,H3,H4 over f0=220; the percept follows the
  //     amplitude-weighted centroid as the balance inside the bundle shifts.
  {
    const tri = (d2, d3, d4) => DSP.spectralBundles(
      [{ n: 2, freq: 440, db: d2 }, { n: 3, freq: 660, db: d3 }, { n: 4, freq: 880, db: d4 }],
      { f0: 220 });

    let bs = tri(0, 0, 0);
    let ok = bs.length === 1 && bs[0].label === '<o' && bs[0].complexity === 3 &&
             !bs[0].weakBridge && Math.abs(bs[0].centroid - 660) < 0.5;
    ok ? pass(`equal H2/H3/H4 → ${fmtAll(bs)} (expect <o, centroid 660)`)
       : fail(`equal H2/H3/H4 → ${fmtAll(bs)} (expect <o, centroid 660)`);

    // H2 louder → the colour darkens toward ~u. NOTE: with the specified linear
    // amplitude weighting (a = 10^(dB/20)) a +12 dB boost lands at 550.3 Hz — a
    // 110 Hz move toward ~u but still 12 Hz inside ~o (the ~u/~o edge is 538.6
    // Hz; crossing it needs ≥ +13.4 dB). Both steps are gated.
    bs = tri(12, 0, 0);
    ok = bs.length === 1 && bs[0].complexity === 3 && !bs[0].weakBridge &&
         bs[0].centroid < 600 && Math.abs(bs[0].centroid - 550.3) < 1;
    ok ? pass(`H2 +12 dB → ${fmtAll(bs)} (centroid falls 660→550 toward ~u)`)
       : fail(`H2 +12 dB → ${fmtAll(bs)} (expect centroid ≈550 Hz)`);

    bs = tri(18, 0, 0);
    ok = bs.length === 1 && bs[0].label === '<u' && bs[0].complexity === 3 && !bs[0].weakBridge;
    ok ? pass(`H2 +18 dB → ${fmtAll(bs)} (expect <u)`) : fail(`H2 +18 dB → ${fmtAll(bs)} (expect <u)`);

    bs = tri(0, 0, 12);
    ok = bs.length === 1 && bs[0].label === '<ɔ' && bs[0].complexity === 3 && !bs[0].weakBridge;
    ok ? pass(`H4 +12 dB → ${fmtAll(bs)} (expect <ɔ)`) : fail(`H4 +12 dB → ${fmtAll(bs)} (expect <ɔ)`);
  }

  // (c) Weak tone-color bridging — the centroid's band holds no actual harmonic
  {
    let bs = DSP.spectralBundles([{ n: 1, freq: 440, db: 0 }, { n: 2, freq: 880, db: 0 }], { f0: 440 });
    let ok = bs.length === 1 && bs[0].label === '<o' && bs[0].weakBridge === true &&
             Math.abs(bs[0].centroid - 660) < 0.5;
    ok ? pass(`A4: H1+H2 equal → ${fmtAll(bs)} (expect <o weak-bridged)`)
       : fail(`A4: H1+H2 equal → ${fmtAll(bs)} (expect <o(wb))`);

    // A♭5: H2 is 30 dB down — a lone non-H1 harmonic never forms its own bundle,
    // so it merges back and the pair reads as the ASTC of H1.
    bs = DSP.spectralBundles([{ n: 1, freq: 830.6, db: 0 }, { n: 2, freq: 1661.2, db: -30 }], { f0: 830.6 });
    ok = bs.length === 1 && bs[0].label === '<ɔ' && bs[0].weakBridge === false && bs[0].complexity === 2;
    ok ? pass(`A♭5: H1 0dB + H2 −30dB → ${fmtAll(bs)} (expect <ɔ, not weak-bridged)`)
       : fail(`A♭5: H1 0dB + H2 −30dB → ${fmtAll(bs)} (expect <ɔ)`);
  }

  // (d) Trough splitting — two peaks over f0=110 separated by a −20 dB valley at H9
  {
    const prof = { 1: -18, 2: -14, 3: -10, 4: -6, 5: 0, 6: 2, 7: 0, 8: -10, 9: -20,
                   10: -6, 11: -2, 12: -6, 13: -16, 14: -24 };
    const hs = Object.keys(prof).map((n) => ({ n: +n, freq: 110 * +n, db: prof[n] }));
    const bs = DSP.spectralBundles(hs, { f0: 110 });
    const k1 = bs[0] && bs[0].astc ? bs[0].astc.key : '?';
    const k2 = bs[1] && bs[1].astc ? bs[1].astc.key : '?';
    const ok = bs.length >= 2 && (k1 === 'o' || k1 === 'ɔ') && (k2 === 'ɑ' || k2 === 'a');
    const line = `f0=110 two-hump (H5–H7 / H10–H12, H9 −20 dB): ${bs.length} bundles → ${fmtAll(bs)}`;
    ok ? pass(line) : fail(line + '  (expect ≥2, first o|ɔ, second ɑ|a)');
  }

  // (e) End-to-end: synthesized vowel → FFT → harmonic dB → bundles
  {
    const sr = 44100, f0 = 110, N = 8192;
    const sig = DSP.synthVowel({ sr, dur: 0.5, f0, formants: [700, 1220, 2600, 3400, 4500] });
    const w = DSP.hann(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const start = Math.round(0.25 * sr) - (N >> 1);
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      re[i] = (idx >= 0 && idx < sig.length ? sig[idx] : 0) * w[i];
    }
    DSP.fftRadix2(re, im);
    const bins = N >> 1, binHz = sr / N;
    const harmonics = [];
    for (let n = 1; n * f0 <= 6000; n++) {
      const lo = Math.max(0, Math.ceil((n * f0 * 0.9) / binHz));
      const hi = Math.min(bins - 1, Math.floor((n * f0 * 1.1) / binHz));
      let best = -Infinity, bf = n * f0;
      for (let i = lo; i <= hi; i++) {
        const db = 20 * Math.log10(Math.hypot(re[i], im[i]) + 1e-12);
        if (db > best) { best = db; bf = i * binHz; }
      }
      if (isFinite(best)) harmonics.push({ n, freq: bf, db: best });
    }
    const bs = DSP.spectralBundles(harmonics, { f0 });
    // The loudest bundle is the F1 peak (F1 = 700 Hz → H6/H7 region). NOTE: the
    // literal FIRST bundle here is H1–H3 (~200 Hz, <u) — the true-fundamental
    // bundle, which the 3 dB trough rule correctly separates from the F1 hump.
    let loud = bs[0];
    for (const b of bs) if (b.peakDb > loud.peakDb) loud = b;
    const ok = bs.length >= 2 && loud.centroid > 500 && loud.centroid < 1000 &&
               (loud.label === '<o' || loud.label === '<ɔ') &&
               bs[0].isFundamental === true;
    const line = `synthVowel f0=110 F1=700 → ${bs.length} bundles: ${fmtAll(bs)} | F1 bundle ${loud.label} c=${loud.centroid.toFixed(0)}Hz`;
    ok ? pass(line) : fail(line + '  (expect ≥2 bundles, F1 bundle <o|<ɔ in 500–1000 Hz)');
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) { console.log('\x1b[32m\x1b[1mALL GATES PASSED\x1b[0m\n'); process.exit(0); }
else { console.log(`\x1b[31m\x1b[1m${failures} GATE(S) FAILED\x1b[0m\n`); process.exit(1); }
