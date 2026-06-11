#!/usr/bin/env node
/*
 * stress.mjs — real-world robustness sweep for the voice-quality metrics.
 *
 * Simulates what a real mic session throws at CPP / H1–H2 / IAIF: different
 * vowels, pitches, noise floors, and input levels. Prints the VALUE SPREAD for
 * each dimension — a metric that swings with vowel or level (while phonation is
 * fixed) will confuse users; this script makes those swings visible BEFORE a
 * real-mic session does. Diagnostic (always exits 0); gates live in validate.mjs.
 *     node docs/dev/stress.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DSP = require(path.join(here, '..', 'dsp-core.js'));

const sr = 44100;
function frameAt(sig, t, N) {
  const start = Math.round(t * sr) - (N >> 1);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) { const idx = start + i; out[i] = (idx >= 0 && idx < sig.length) ? sig[idx] : 0; }
  return out;
}
// deterministic LCG noise (mic floor)
function addNoise(sig, amp, seed = 777) {
  let s = seed >>> 0;
  const out = Float32Array.from(sig);
  for (let i = 0; i < out.length; i++) { s = (1664525 * s + 1013904223) >>> 0; out[i] += amp * ((s / 4294967296) * 2 - 1); }
  return out;
}
function scale(sig, g) { const o = Float32Array.from(sig); for (let i = 0; i < o.length; i++) o[i] *= g; return o; }

const med = (a) => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
const fmt = (x, d = 2) => (x == null ? '  null' : x.toFixed(d).padStart(6));

// measure all three metrics on a clip (median over frames in the middle).
// formants (when passed) → the app-displayed corrected H1*–H2*, matching main.js.
function measure(sig, f0, formants) {
  const cpp = [], h12 = [], naq = [], rd = [];
  for (let t = 0.15; t < 0.45; t += 0.04) {
    const fr = frameAt(sig, t, 4096);
    let rms = 0; for (let i = 0; i < fr.length; i++) rms += fr[i] * fr[i];
    rms = Math.sqrt(rms / fr.length);
    if (rms < 0.006) continue;             // same gate as main.js updateVoiceQuality
    const c = DSP.cpps(fr, sr); if (c) cpp.push(c.cpp);
    const h = DSP.h1h2(fr, sr, f0, formants ? { formants } : undefined); if (h) h12.push(formants ? h.h1h2c : h.h1h2);
    const sub = fr.subarray(((fr.length - Math.round(0.04 * sr)) >> 1), ((fr.length - Math.round(0.04 * sr)) >> 1) + Math.round(0.04 * sr));
    const g = DSP.iaifGlottal(sub, sr);
    if (g && g.naq != null && g.naq > 0.02 && g.naq < 0.6) { naq.push(g.naq); if (g.rdEst) rd.push(g.rdEst); }
  }
  return { cpp: med(cpp), h12: med(h12), naq: med(naq), rd: med(rd), nVoiced: cpp.length };
}

const VOWELS = {
  'ɑ': [730, 1090, 2440, 3400, 4500],
  'i': [270, 2290, 3010, 3700, 4500],
  'u': [300, 870, 2240, 3400, 4500],
  'e': [530, 1840, 2480, 3500, 4500],
  'o': [570, 840, 2410, 3400, 4500],
};

console.log('\n\x1b[1m== 1. Vowel dependence (FIXED phonation oq=0.6, f0=150) ==\x1b[0m');
console.log('   metric should be FLAT across vowels — spread = user confusion');
{
  const rows = {};
  for (const [v, F] of Object.entries(VOWELS)) {
    const sig = DSP.synthVowel({ sr, dur: 0.6, f0: 150, formants: F, oq: 0.6 });
    rows[v] = measure(sig, 150);
  }
  console.log('  vowel |    CPP |  H1-H2 |    NAQ |   Rd≈');
  for (const [v, r] of Object.entries(rows))
    console.log(`    ${v}   | ${fmt(r.cpp)} | ${fmt(r.h12, 1)} | ${fmt(r.naq, 3)} | ${fmt(r.rd)}`);
  const spread = (key) => { const vals = Object.values(rows).map(r => r[key]).filter(x => x != null); return Math.max(...vals) - Math.min(...vals); };
  console.log(`  SPREAD: CPP ${spread('cpp').toFixed(2)} | H1-H2 ${spread('h12').toFixed(1)} dB | NAQ ${spread('naq').toFixed(3)} | Rd ${spread('rd').toFixed(2)}`);
}

console.log('\n\x1b[1m== 2. Pitch dependence (vowel ɑ, oq=0.6) ==\x1b[0m');
{
  console.log('    f0  |    CPP |  H1-H2 |    NAQ |   Rd≈');
  for (const f0 of [110, 150, 220, 330, 440]) {
    const sig = DSP.synthVowel({ sr, dur: 0.6, f0, formants: VOWELS['ɑ'], oq: 0.6 });
    const r = measure(sig, f0);
    console.log(`   ${String(f0).padStart(3)}  | ${fmt(r.cpp)} | ${fmt(r.h12, 1)} | ${fmt(r.naq, 3)} | ${fmt(r.rd)}`);
  }
}

console.log('\n\x1b[1m== 3. Noise floor (mic hiss) — vowel ɑ, f0=150, oq=0.6 ==\x1b[0m');
console.log('   CPP should fall with noise (that is the point); H1-H2/NAQ should hold');
{
  console.log('  noise |    CPP |  H1-H2 |    NAQ |   Rd≈');
  for (const n of [0, 0.002, 0.005, 0.01, 0.02, 0.05]) {
    const sig = addNoise(DSP.synthVowel({ sr, dur: 0.6, f0: 150, formants: VOWELS['ɑ'], oq: 0.6 }), n);
    const r = measure(sig, 150);
    console.log(`  ${String(n).padStart(5)} | ${fmt(r.cpp)} | ${fmt(r.h12, 1)} | ${fmt(r.naq, 3)} | ${fmt(r.rd)}`);
  }
}

console.log('\n\x1b[1m== 4. Input level (mic distance/gain) — all metrics should be level-invariant ==\x1b[0m');
{
  console.log('   gain |    CPP |  H1-H2 |    NAQ |   Rd≈ | voiced frames');
  for (const g of [1.0, 0.5, 0.25, 0.1, 0.05, 0.02]) {
    const sig = scale(DSP.synthVowel({ sr, dur: 0.6, f0: 150, formants: VOWELS['ɑ'], oq: 0.6 }), g);
    const r = measure(sig, 150);
    console.log(`  ${String(g).padStart(5)} | ${fmt(r.cpp)} | ${fmt(r.h12, 1)} | ${fmt(r.naq, 3)} | ${fmt(r.rd)} |  ${r.nVoiced}`);
  }
}

console.log('\n\x1b[1m== 5. Phonation separation under realistic noise (the actual use case) ==\x1b[0m');
console.log('   pressed(oq .4) vs flow(.6) vs breathy(.85+asp): order must survive noise 0.005');
{
  console.log('  phonation |    CPP |  H1-H2 |    NAQ |   Rd≈');
  const cases = { 'pressed ': { oq: 0.4, asp: 0 }, 'flow    ': { oq: 0.6, asp: 0.1 }, 'breathy ': { oq: 0.85, asp: 0.5 } };
  for (const [name, c] of Object.entries(cases)) {
    const sig = addNoise(DSP.synthVowel({ sr, dur: 0.6, f0: 180, formants: [600, 1000, 2500, 3400, 4500], oq: c.oq, aspiration: c.asp }), 0.005);
    const r = measure(sig, 180);
    console.log(`  ${name}  | ${fmt(r.cpp)} | ${fmt(r.h12, 1)} | ${fmt(r.naq, 3)} | ${fmt(r.rd)}`);
  }
}
console.log('');
