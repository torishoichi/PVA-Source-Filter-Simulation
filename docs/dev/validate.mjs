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
console.log('');
if (failures === 0) { console.log('\x1b[32m\x1b[1mALL GATES PASSED\x1b[0m\n'); process.exit(0); }
else { console.log(`\x1b[31m\x1b[1m${failures} GATE(S) FAILED\x1b[0m\n`); process.exit(1); }
