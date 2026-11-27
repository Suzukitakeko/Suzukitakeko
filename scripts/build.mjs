#!/usr/bin/env node
// Renders every plate of this profile README. No dependencies.
//
//   node scripts/build.mjs
//
// The hero and the footer are deterministic. Fig. 2 and the "Patches
// upstream" list in README.md are recomputed from the account's public stars
// and pull requests, so a scheduled workflow can keep them current. Files are
// only rewritten when their content changes, and when GitHub cannot be
// reached whatever is already committed is left untouched.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
const LOGIN = process.env.PROFILE_LOGIN || 'Suzukitakeko';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// ───────────────────────── palette ─────────────────────────
// Taken from the avatar: beret red, sweater cream, skirt teal, satchel tan.
const THEMES = {
  dark: {
    bg: '#0B1416', bg2: '#12211F', ink: '#F2E9D8', mute: '#93A7A2', dim: '#5B7070',
    red: '#E5565F', teal: '#5DB5A6', tan: '#D9AB73', rule: 0.12, dot: 0.13, glow: 0.3,
  },
  light: {
    bg: '#F8F2E4', bg2: '#EFE5D0', ink: '#1C2A2B', mute: '#566865', dim: '#98A29A',
    red: '#C2343F', teal: '#2A776C', tan: '#AE7A3C', rule: 0.16, dot: 0.16, glow: 0.16,
  },
};

const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif";

// ───────────────────────── helpers ─────────────────────────
const f = (x) => { const s = (+x).toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const sq = (x, y, s) => `M${f(x)} ${f(y)}h${f(s)}v${f(s)}h-${f(s)}z`;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ordered dithering: the 4x4 Bayer matrix decides which way each cell rounds.
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const bayer = (c, r) => (BAYER[r & 3][c & 3] + 0.5) / 16;
const quantize = (v, c, r, levels = 4) => clamp(Math.floor(v * (levels - 1) + bayer(c, r)), 0, levels - 1);
const LEVEL_OPACITY = [0, 0.3, 0.62, 1];

function frame(T, W, H, body, title, extraDefs = '', extraCss = '') {
  const m = 20, l = 9; // crop marks
  const marks = [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]
    .map(([x, y, sx, sy]) => `M${x + sx * l} ${y}H${x}V${y + sy * l}`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${T.bg}"/><stop offset="1" stop-color="${T.bg2}"/></linearGradient>
${extraDefs}
</defs>
<style>
text{font-family:${MONO};font-size:15px;letter-spacing:.09em;fill:${T.mute}}
.i{fill:${T.ink}}.d{fill:${T.dim}}.r{fill:${T.red}}.t{fill:${T.teal}}.n{fill:${T.tan}}
.s{font-family:${SERIF};font-style:italic;letter-spacing:.01em}
${extraCss}
</style>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="22" fill="url(#bg)" stroke="${T.ink}" stroke-opacity="${T.rule}"/>
<path d="${marks}" fill="none" stroke="${T.ink}" stroke-opacity="${T.rule * 2.2}" stroke-width="1"/>
${body}
</svg>
`;
}

// ───────────────────────── the scene ─────────────────────────
// One picture is used everywhere: a sun going down into the sea. Each cell
// gets a colour and a value in [0,1]; what happens to that value afterwards
// (kept as is, or rounded to four levels) is the whole point of the page.
function sunset(c, r, o) {
  const dx = c + 0.5 - o.sunC, dy = r + 0.5 - o.sunR, d = Math.hypot(dx, dy);
  if (r < o.horizon) {
    const red = d <= o.rad
      ? 1 - 0.5 * clamp((dy + o.rad) / o.rad) ** 1.7            // bright crown, deeper toward the water
      : 0.52 * Math.exp(-(d - o.rad) / (o.rad * 0.2));
    const haze = 0.44 * Math.exp(-(o.haze - r) / (o.rad * 0.24)) * Math.exp(-((dx / (o.rad * 1.7)) ** 2));
    const v = Math.max(red, haze);
    return { c: 'red', v: v < 0.04 ? 0 : v };
  }
  const row = r - o.horizon, depth = row / (o.rows - o.horizon);
  const sway = Math.sin(row * 2.1 + 0.6) * o.rad * 0.1;       // the reflection is a broken, wavering column
  const width = o.rad * (0.36 + 0.17 * Math.sin(row * 1.3 + 2));
  const glint = clamp(1 - Math.abs(dx + sway) / width) ** 0.7;
  const red = glint * (1 - 0.5 * depth) * (row % 2 === 0 ? 1 : 0.5);
  const teal = clamp(0.3 + 0.6 * depth + 0.1 * Math.sin(c * 0.37 + r * 1.3)) * (1 - 0.9 * glint);
  return red >= teal ? { c: 'red', v: red } : { c: 'teal', v: teal };
}

// ───────────────────────── 5x7 lettering ─────────────────────────
const GLYPHS = {
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
};
function lettering(word) {
  const cells = []; let x = 0;
  for (const ch of word) {
    const g = GLYPHS[ch];
    g.forEach((row, r) => [...row].forEach((px, c) => { if (px === '#') cells.push([x + c, r]); }));
    x += g[0].length + 1;
  }
  return { cells, width: x - 1 };
}

// ───────────────────────── plate 00 · hero ─────────────────────────
function hero(T) {
  const W = 1200, C = 94, R = 34, P = 12, X0 = (W - C * P) / 2, Y0 = 56, H = Y0 + R * P + 60;
  const word = lettering('SUZUKITAKEKO');
  const c0 = Math.floor((C - word.width) / 2), r0 = 14;
  const band = { top: r0 - 1, bottom: r0 + 7 };                 // the wordmark sits on the horizon
  const o = { sunC: 0.69 * C, sunR: r0 + 1.2, rad: 11.6, horizon: band.bottom + 1, haze: band.top, rows: R };

  const rand = rng(20261127);
  const smooth = new Map(), dither = new Map();
  const push = (m, k, d) => m.set(k, (m.get(k) || '') + d);
  const S = 9, O = (P - S) / 2;
  let stars = '', twinkle = '';
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (r >= band.top && r <= band.bottom) continue;
    const { c: col, v: raw } = sunset(c, r, o);
    const v = clamp(raw), x = X0 + c * P + O, y = Y0 + r * P + O;
    const far = Math.hypot(c - o.sunC, r - o.sunR) > o.rad + 5;
    if (r < band.top - 1 && far && v < 0.08 && rand() < 0.02) {
      const b = (0.3 + rand() * 0.6).toFixed(2), d = sq(x + 2, y + 2, S - 4);
      if (rand() < 0.4) twinkle += `<path class="tw" fill="${T.ink}" style="animation-delay:-${(rand() * 6).toFixed(1)}s;animation-duration:${(3 + rand() * 4).toFixed(1)}s" d="${d}"/>`;
      else stars += `<path opacity="${b}" d="${d}"/>`;
      continue;
    }
    if (col === 'red' && r >= o.horizon && v > 0.3 && rand() < 0.2) {
      twinkle += `<path class="tw" fill="${rand() < 0.45 ? T.ink : T.red}" style="animation-delay:-${(rand() * 5).toFixed(1)}s;animation-duration:${(2.4 + rand() * 3).toFixed(1)}s" d="${sq(x, y, S)}"/>`;
      continue;
    }
    if (v >= 0.035) push(smooth, col + '|' + v.toFixed(2), sq(x, y, S));
    const q = quantize(v, c, r);
    if (q > 0) push(dither, col + '|' + q, sq(x, y, S));
  }
  const paint = (m, op) => [...m].map(([k, d]) => {
    const [col, a] = k.split('|');
    return `<path fill="${T[col]}" opacity="${op(a)}" d="${d}"/>`;
  }).join('\n');

  const NS = 10.8, NO = (P - NS) / 2;
  const nameD = word.cells.map(([c, r]) => sq(X0 + (c + c0) * P + NO, Y0 + (r + r0) * P + NO, NS)).join('');

  // timeline: full precision → sweep → 2-bit (held) → sweep → full precision
  const DUR = 22, a = 0.06, b = 0.2, c = 0.72, d = 0.86;
  const kt = `0;${a};${b};${c};${d};1`;
  const ease = '0 0 1 1;.6 0 .3 1;0 0 1 1;.6 0 .3 1;0 0 1 1';
  const anim = (attr, values) => `<animate attributeName="${attr}" dur="${DUR}s" repeatCount="indefinite" calcMode="spline" keyTimes="${kt}" keySplines="${ease}" values="${values}"/>`;
  const m1 = (a + b) / 2, m2 = (c + d) / 2;
  const flip = (on) => `<animate attributeName="opacity" dur="${DUR}s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;${m1};${m2};1" values="${on ? '1;0;1;1' : '0;1;0;0'}"/>`;
  const e = 0.012, gridBottom = Y0 + R * P;
  const sunX = X0 + o.sunC * P, sunY = Y0 + o.sunR * P;

  const defs = `<pattern id="dots" width="${P}" height="${P}" patternUnits="userSpaceOnUse" x="${X0}" y="${Y0}"><rect x="${P / 2 - 1}" y="${P / 2 - 1}" width="2" height="2" fill="${T.ink}" opacity="${T.dot}"/></pattern>
<clipPath id="grid"><rect x="${X0}" y="${Y0}" width="${C * P}" height="${R * P}"/></clipPath>
<clipPath id="ca"><rect y="0" height="${H}" x="0" width="${W}">${anim('x', `0;0;${W};0;0;0`)}${anim('width', `${W};${W};0;0;${W};${W}`)}</rect></clipPath>
<clipPath id="cb"><rect y="0" height="${H}" x="0" width="0">${anim('x', `0;0;0;0;${W};0`)}${anim('width', `0;0;${W};${W};0;0`)}</rect></clipPath>
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${f(sunX)}" cy="${f(sunY)}" r="${f(o.rad * P * 2.5)}"><stop offset="0" stop-color="${T.red}" stop-opacity="${T.glow}"/><stop offset=".45" stop-color="${T.red}" stop-opacity="${T.glow * 0.42}"/><stop offset="1" stop-color="${T.red}" stop-opacity="0"/></radialGradient>
<linearGradient id="trail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${T.ink}" stop-opacity="0"/><stop offset="1" stop-color="${T.ink}" stop-opacity=".14"/></linearGradient>`;
  const css = `@keyframes tw{0%,100%{opacity:.12}50%{opacity:.95}}
.tw{animation:tw 4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.tw{animation:none;opacity:.6}}`;

  const body = `<g clip-path="url(#grid)"><rect x="${X0}" y="${Y0}" width="${C * P}" height="${R * P}" fill="url(#glow)"/></g>
<rect x="${X0}" y="${Y0}" width="${C * P}" height="${R * P}" fill="url(#dots)"/>
<g fill="${T.ink}">${stars}</g>
<g clip-path="url(#ca)">
${paint(smooth, (v) => v)}
</g>
<g clip-path="url(#cb)">
${paint(dither, (q) => LEVEL_OPACITY[q])}
</g>
${twinkle}
<path fill="${T.ink}" d="${nameD}"/>
<g opacity="0"><animate attributeName="opacity" dur="${DUR}s" repeatCount="indefinite" keyTimes="0;${a};${a + e};${b - e};${b};${c};${c + e};${d - e};${d};1" values="0;0;1;1;0;0;1;1;0;0"/>
<g><animateTransform attributeName="transform" type="translate" dur="${DUR}s" repeatCount="indefinite" calcMode="spline" keyTimes="${kt}" keySplines="${ease}" values="0 0;0 0;${W} 0;0 0;${W} 0;${W} 0"/>
<rect x="-80" y="${Y0}" width="80" height="${R * P}" fill="url(#trail)"/>
<rect x="-1" y="${Y0 - 9}" width="1.6" height="${R * P + 18}" fill="${T.ink}"/>
</g></g>
<text x="40" y="37">PLATE 00 <tspan class="d">·</tspan> <tspan class="i">SELF-PORTRAIT, COMPRESSED</tspan></text>
<text x="${W - 40}" y="37" text-anchor="end">31.23°N 121.47°E <tspan class="d">·</tspan> SHANGHAI</text>
<text x="40" y="${gridBottom + 35}" class="s i" style="font-size:23px">Fewer tokens, fewer bits, same meaning.</text>
<text x="${W - 40}" y="${gridBottom + 33}" text-anchor="end">FULL PRECISION${flip(true)}</text>
<text x="${W - 40}" y="${gridBottom + 33}" text-anchor="end" opacity="0"><tspan class="r">■</tspan> 2-BIT <tspan class="d">·</tspan> 4 LEVELS${flip(false)}</text>`;
  return frame(T, W, H, body, 'Suzukitakeko — a sun setting into the sea behind the name, drawn on a grid of cells and repeatedly quantized from full precision down to two bits. Fewer tokens, fewer bits, same meaning.', defs, css);
}

// ───────────────────────── fig. 1 · triptych ─────────────────────────
function triptych(T, meta) {
  const W = 1200, H = 446;
  const top = 92, size = 240, bottom = top + size;
  let body = '', css = '';

  // ── A · fewer tokens: a 24x24 grid of patches (576 visual tokens), pruned by saliency
  const AX = 48, G = 24, P = size / G, S = P - 1.6, O = 0.8;
  const rand = rng(576);
  const view = { sunC: 14.5, sunR: 9.2, rad: 6.4, horizon: 16, haze: 16, rows: G };
  const toks = [];
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
    const { c: col, v } = sunset(c, r, view);
    const q = Math.max(1, quantize(clamp(v), c, r));
    const score = (col === 'red' ? 1.1 : 0.4) * v + rand() ** 3 * 0.55;
    toks.push({ c, r, col, q, score });
  }
  toks.sort((p, q2) => q2.score - p.score);
  const KEEP = [576, 192, 128, 64];
  const bands = [[0, 64], [64, 128], [128, 192], [192, 576]];
  const bandSvg = bands.map(([lo, hi], bi) => {
    const groups = new Map();
    for (const t of toks.slice(lo, hi)) {
      const k = t.col + '|' + t.q;
      groups.set(k, (groups.get(k) || '') + sq(AX + t.c * P + O, top + t.r * P + O, S));
    }
    const paths = [...groups].map(([k, d]) => { const [col, q] = k.split('|'); return `<path fill="${T[col]}" opacity="${LEVEL_OPACITY[q]}" d="${d}"/>`; }).join('');
    return `<g class="b${bi}">${paths}</g>`;
  }).join('\n');
  // 16s loop, four states of 4s; band k disappears when the budget drops below it
  css += `
@keyframes b3{0%,20%{opacity:1}25%,95%{opacity:0}100%{opacity:1}}
@keyframes b2{0%,45%{opacity:1}50%,95%{opacity:0}100%{opacity:1}}
@keyframes b1{0%,70%{opacity:1}75%,95%{opacity:0}100%{opacity:1}}
.b3{animation:b3 16s infinite}.b2{animation:b2 16s infinite}.b1{animation:b1 16s infinite}
@keyframes k0{0%,21%{opacity:1}24%,97%{opacity:0}100%{opacity:1}}
@keyframes k1{0%,22%{opacity:0}25%,46%{opacity:1}49%,100%{opacity:0}}
@keyframes k2{0%,47%{opacity:0}50%,71%{opacity:1}74%,100%{opacity:0}}
@keyframes k3{0%,72%{opacity:0}75%,96%{opacity:1}99%,100%{opacity:0}}
.k1,.k2,.k3{opacity:0}
.k0{animation:k0 16s infinite}.k1{animation:k1 16s infinite}.k2{animation:k2 16s infinite}.k3{animation:k3 16s infinite}
@media (prefers-reduced-motion:reduce){.b1,.b2,.b3,.k0,.k1,.k2,.k3{animation:none}}`;
  const readA = KEEP.map((k, i) => `<text class="k${i}" x="${AX}" y="${bottom + 36}"><tspan class="${i ? 'r' : 'i'}">${k}</tspan><tspan class="d"> / </tspan>576 TOKENS<tspan class="d"> · </tspan>${Math.round(k / 5.76)}%</text>`).join('\n');
  body += `<text x="${AX}" y="58"><tspan class="r">A</tspan> <tspan class="d">·</tspan> <tspan class="i">FEWER TOKENS</tspan></text>
<rect x="${AX}" y="${top}" width="${size}" height="${size}" fill="url(#dotsA)"/>
${bandSvg}
${readA}
<text x="${AX}" y="${bottom + 62}" class="d">prune by saliency</text>`;

  // ── B · fewer bits: a signal and its round-to-nearest staircase, 4 → 3 → 2 → 1 bits
  const BX = 340, BW = 372, N = 93, step = BW / N, mid = top + size / 2, amp = size / 2 - 8;
  const raw = (x) => 0.6 * Math.sin(2 * Math.PI * x + 0.3) + 0.3 * Math.sin(4 * Math.PI * x + 1.4) + 0.12 * Math.sin(10 * Math.PI * x + 0.4);
  const xs = Array.from({ length: N + 1 }, (_, i) => i / N);
  const peak = Math.max(...xs.map((x) => Math.abs(raw(x)))) / 0.97;
  const sig = xs.map((x) => raw(x) / peak);
  const Y = (v) => mid - v * amp;
  const q = (v, bits) => { const L = 2 ** bits, D = 2 / L; return clamp((Math.floor((v + 1) / D) + 0.5) * D - 1, -1 + D / 2, 1 - D / 2); };
  const BITS = [4, 3, 2, 1];
  const stair = (bits) => {
    let d = `M${f(BX)} ${f(Y(q(sig[0], bits)))}`;
    for (let i = 0; i < N; i++) d += `V${f(Y(q((sig[i] + sig[i + 1]) / 2, bits)))}H${f(BX + (i + 1) * step)}`;
    return d;
  };
  const back = sig.map((v, i) => `L${f(BX + i * step)} ${f(Y(v))}`).reverse().join('');
  const curve = 'M' + sig.map((v, i) => `${f(BX + i * step)} ${f(Y(v))}`).join('L');
  const sqnr = (bits) => {
    let s = 0, n = 0;
    for (let i = 0; i < N; i++) { const v = (sig[i] + sig[i + 1]) / 2; s += v * v; n += (v - q(v, bits)) ** 2; }
    return 10 * Math.log10(s / n);
  };
  const DB = 16, kt = '0;.2;.25;.45;.5;.7;.75;.95;1';
  const seq = (fn) => { const v = BITS.map(fn); return [v[0], v[0], v[1], v[1], v[2], v[2], v[3], v[3], v[0]].join(';'); };
  const sp = Array(8).fill('.5 0 .2 1').join(';');
  const morph = (fn) => `<animate attributeName="d" dur="${DB}s" repeatCount="indefinite" calcMode="spline" keyTimes="${kt}" keySplines="${sp}" values="${seq(fn)}"/>`;
  const show = (i) => `<animate attributeName="opacity" dur="${DB}s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;.225;.475;.725;.975;1" values="${[0, 1, 2, 3, 0, 0].map((s) => (s === i ? 1 : 0)).join(';')}"/>`;
  const levels = BITS.map((bits, i) => {
    const L = 2 ** bits, D = 2 / L;
    const d = Array.from({ length: L }, (_, k) => `M${BX} ${f(Y(-1 + D / 2 + k * D))}h${BW}`).join('');
    return `<path d="${d}" fill="none" stroke="${T.ink}" stroke-opacity="${T.rule * 1.5}" stroke-width="1" stroke-dasharray="1 5" opacity="${i ? 0 : 1}">${show(i)}</path>`;
  }).join('\n');
  const readB = BITS.map((bits, i) => `<text x="${BX}" y="${bottom + 36}" opacity="${i ? 0 : 1}"><tspan class="${bits === 2 ? 'r' : 'i'}">${bits}</tspan> ${bits === 1 ? 'BIT' : 'BITS'}<tspan class="d"> · </tspan>${2 ** bits} LEVELS<tspan class="d"> · </tspan>SQNR ${sqnr(bits).toFixed(1)} dB${show(i)}</text>`).join('\n');
  body += `<path d="M${BX - 26} 30V${H - 30}M${BX + BW + 26} 30V${H - 30}" stroke="${T.ink}" stroke-opacity="${T.rule}" fill="none"/>
<text x="${BX}" y="58"><tspan class="r">B</tspan> <tspan class="d">·</tspan> <tspan class="i">FEWER BITS</tspan></text>
${levels}
<path d="${stair(4)}${back}Z" fill="${T.tan}" opacity=".3">${morph((bits) => stair(bits) + back + 'Z')}</path>
<path d="${curve}" fill="none" stroke="${T.ink}" stroke-width="1.4" stroke-opacity=".75"/>
<path d="${stair(4)}" fill="none" stroke="${T.red}" stroke-width="2.4" stroke-linejoin="round">${morph(stair)}</path>
${readB}
<text x="${BX}" y="${bottom + 62}" class="d">round to the nearest level</text>`;

  // ── C · same meaning: a model card
  const CX = 764, VX = CX + 118;
  const rows = [
    ['name', [LOGIN]],
    ['base', ['Shanghai · UTC+8']],
    ['context', [`${meta.stars} starred repos`]],
    ['research', ['Efficient AI']],
    ['scope', ['training & inference', 'of foundation models']],
    ['attends to', ['token pruning · KV cache', 'quantization · fast inference']],
    ['objective', ['min tokens, bits', 's.t. meaning ≈ const']],
    ['license', ['curiosity']],
  ];
  let y = top + 14, card = '';
  for (const [k, lines] of rows) {
    card += `<text x="${CX}" y="${y}" class="d">${esc(k)}</text>`;
    for (const ln of lines) { card += `<text x="${VX}" y="${y}" class="i" style="letter-spacing:.02em">${esc(ln)}</text>`; y += 24; }
    y += 8;
  }
  body += `<text x="${CX}" y="58"><tspan class="r">C</tspan> <tspan class="d">·</tspan> <tspan class="i">SAME MEANING</tspan></text>
<text x="${W - 48}" y="58" text-anchor="end" class="d">CARD v${meta.version}</text>
${card}`;

  const defs = `<pattern id="dotsA" width="${P}" height="${P}" patternUnits="userSpaceOnUse" x="${AX}" y="${top}"><rect x="${P / 2 - 1}" y="${P / 2 - 1}" width="2" height="2" fill="${T.ink}" opacity="${T.dot * 1.4}"/></pattern>`;
  return frame(T, W, H, body, `Figure 1. Three panels. A: an image of 576 visual tokens pruned to 192, 128 and 64. B: a signal rounded to 4, 3, 2 and 1 bits. C: a model card — ${LOGIN}, Shanghai; research: Efficient AI, the training and inference of foundation models; attends to token pruning, KV cache, quantization and fast inference.`, defs, css);
}

// ───────────────────────── fig. 2 · attention over stars ─────────────────────────
const BUCKETS = [
  ['quantization & low-bit', /quanti[sz]|low-bit|\b[1248]-?bit\b|binar|\bptq\b|\bqat\b|bitnet|ternar/],
  ['diffusion language models', /dllm|diffusion[- ](l|language|large|vision-language)|llada|discrete diffusion|masked diffusion|lavida|mmada/],
  ['KV cache & fast inference', /kv\b|kv[-_ ]|cache|caching|speculative|inference|accelerat|vllm|serving|latency|\bfast|faster|sparse attention/],
  ['token pruning & compression', /prun|token|compress|spars|distill|compact|lightweight|trim|merg|\bdrop/],
  ['VLA & world models', /\bvla\b|vision-language-action|robot|embodied|world[- ]model|manipulation/],
  ['video & multimodal LLMs', /video|multi-?modal|\bvlm|\bmllm|\blvlm|\blmm|vision-language|omni|audio|streaming|spatial|\b3d\b|egocentric|visual|image|emotion/],
  ['research craft', /paper|rebuttal|writing|figure|academic|thesis|latex|humaniz|draw\.?io|diagram|presentation|arxiv|\bacl\b/],
  ['agents & harnesses', /agent|skill|claude|codex|harness|\bmcp\b|\brl\b|reinforcement|self-improv|auto-?research/],
];
const REST = 'everything else';

function classify(stars) {
  const counts = new Map(BUCKETS.map(([label]) => [label, 0]));
  counts.set(REST, 0);
  for (const s of stars) {
    const text = `${s.name} ${s.description} ${s.topics.join(' ')}`.toLowerCase();
    const hit = BUCKETS.find(([, re]) => re.test(text));
    const label = hit ? hit[0] : REST;
    counts.set(label, counts.get(label) + 1);
  }
  const rows = [...counts].filter(([label, n]) => label !== REST && n > 0).sort((p, q) => q[1] - p[1]);
  rows.push([REST, counts.get(REST)]);
  return rows;
}

function monthly(stars, months = 24, now = new Date()) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ key: d.toISOString().slice(0, 7), n: 0 });
  }
  const idx = new Map(out.map((m, i) => [m.key, i]));
  for (const s of stars) { const i = idx.get((s.starredAt || '').slice(0, 7)); if (i !== undefined) out[i].n++; }
  return out;
}

function attention(T, data) {
  const rows = classify(data.stars), total = data.stars.length || 1;
  const W = 1200, RH = 31, top = 104, H = top + rows.length * RH + 64;
  const P = 13, S = 10, LX = 318, BX = 338, MAXC = 30;
  const max = Math.max(...rows.map(([, n]) => n));
  let body = '';
  rows.forEach(([label, n], i) => {
    const y = top + i * RH, rest = label === REST, col = rest ? T.dim : i === 0 ? T.red : T.teal;
    const exact = (n / max) * MAXC, full = Math.floor(exact), part = Math.round((exact - full) * 3);
    let solid = '';
    for (let k = 0; k < full; k++) solid += sq(BX + k * P, y - S + 1, S);
    const tail = part > 0 ? `<path fill="${col}" opacity="${LEVEL_OPACITY[part]}" d="${sq(BX + full * P, y - S + 1, S)}"/>` : '';
    const end = BX + (full + (part > 0 ? 1 : 0)) * P;
    body += `<text x="${LX}" y="${y}" text-anchor="end" class="${rest ? 'd' : 'i'}" style="letter-spacing:.02em">${esc(label)}</text>
<path fill="${col}" opacity="${rest ? 0.7 : 1}" d="${solid}"/>${tail}
<text x="${end + 8}" y="${y}" class="${rest ? 'd' : i === 0 ? 'r' : ''}">${(n / total).toFixed(2).replace(/^0/, '')}<tspan class="d"> · ${n}</tspan></text>\n`;
  });

  // right: stars per month, as a column chart on the same cell grid
  const months = monthly(data.stars, 24, data.now), HX = 896, HP = 10.7, HS = 8, MAXR = 10;
  const base = top + (rows.length - 1) * RH + 1, mmax = Math.max(1, ...months.map((m) => m.n));
  let cols = '', peak = months[0], peakI = 0;
  months.forEach((m, i) => { if (m.n > peak.n) { peak = m; peakI = i; } });
  months.forEach((m, i) => {
    const fill = i === peakI ? T.red : T.tan, last = i === months.length - 1;
    if (last) cols += '<g class="now">';
    const exact = (m.n / mmax) * MAXR, full = Math.floor(exact), part = Math.round((exact - full) * 3);
    for (let k = 0; k < full; k++) cols += `<path fill="${fill}" d="${sq(HX + i * HP, base - HS - k * HP, HS)}"/>`;
    if (part > 0) cols += `<path fill="${fill}" opacity="${LEVEL_OPACITY[part]}" d="${sq(HX + i * HP, base - HS - full * HP, HS)}"/>`;
    else if (full === 0) cols += `<path fill="${T.ink}" opacity="${T.dot * 2}" d="${sq(HX + i * HP + HS / 2 - 1, base - HS / 2 - 1, 2)}"/>`;
    if (last) cols += '</g>';
  });
  const hw = 24 * HP - (HP - HS);
  body += `${cols}
<text x="${HX}" y="${top - 4}" class="d">STARS / MONTH</text>
<text x="${HX + hw}" y="${top - 4}" text-anchor="end">PEAK <tspan class="r">${peak.n}</tspan></text>
<path d="M${HX} ${base + 7.5}h${f(hw)}" stroke="${T.ink}" stroke-opacity="${T.rule * 1.6}"/>
<text x="${HX}" y="${base + 26}" class="d" style="font-size:13px">${months[0].key}</text>
<text x="${HX + hw}" y="${base + 26}" text-anchor="end" class="d" style="font-size:13px">${months[months.length - 1].key}</text>`;

  body += `<text x="48" y="58"><tspan class="i">FIG. 2</tspan> <tspan class="d">·</tspan> <tspan class="i">ATTENTION, AVERAGED OVER</tspan> <tspan class="r">${total}</tspan> <tspan class="i">STARS</tspan></text>
<text x="${W - 48}" y="58" text-anchor="end" class="d">softmax not included</text>
<path d="M48 76H${W - 48}" stroke="${T.ink}" stroke-opacity="${T.rule}"/>
<text x="48" y="${H - 30}" class="d">computed from public stars</text>
<text x="${W - 48}" y="${H - 30}" text-anchor="end" class="d">updated ${data.date}</text>`;
  const css = `@keyframes now{0%,100%{opacity:1}50%{opacity:.35}}
.now{animation:now 2.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.now{animation:none}}`;
  const summary = rows.map(([label, n]) => `${label} ${(n / total * 100).toFixed(0)}%`).join(', ');
  return frame(T, W, H, body, `Figure 2. Where ${total} starred repositories go, by topic: ${summary}.`, '', css);
}

// ───────────────────────── footer ─────────────────────────
function footer(T) {
  const W = 1200, H = 104, P = 14, S = 10.4, C = 80, X0 = (W - C * P) / 2, Y0 = 26;
  const groups = new Map();
  for (let r = 0; r < 2; r++) for (let c = 0; c < C; c++) {
    const u = c / (C - 1);
    const col = u < 0.5 ? 'teal' : 'red';
    const v = Math.abs(u - 0.5) * 2;            // dense at the edges, empty in the middle
    const q = quantize(clamp(v * 1.08), c, r);
    if (!q) continue;
    const k = col + '|' + q;
    groups.set(k, (groups.get(k) || '') + sq(X0 + c * P + 1.8, Y0 + r * P + 1.8, S));
  }
  const paths = [...groups].map(([k, d]) => { const [col, q] = k.split('|'); return `<path fill="${T[col]}" opacity="${LEVEL_OPACITY[q]}" d="${d}"/>`; }).join('\n');
  const body = `${paths}
<text x="${W / 2}" y="${Y0 + 2 * P + 30}" text-anchor="middle">EOF <tspan class="d">·</tspan> <tspan class="i">THANK YOU FOR YOUR ATTENTION</tspan> <tspan class="d">·</tspan> RENDERED AT 2 BITS</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="End of file. Thank you for your attention.">
<title>End of file. Thank you for your attention.</title>
<style>text{font-family:${MONO};font-size:15px;letter-spacing:.14em;fill:${T.mute}}.i{fill:${T.ink}}.d{fill:${T.dim}}</style>
${body}
</svg>
`;
}

// ───────────────────────── data ─────────────────────────
async function fetchStars() {
  if (process.env.STARS_CACHE) {
    return JSON.parse(readFileSync(process.env.STARS_CACHE, 'utf8'))
      .map((s) => ({ name: s.n, description: s.d || '', topics: s.t || [], starredAt: s.at }));
  }
  const headers = { Accept: 'application/vnd.github.star+json', 'User-Agent': 'profile-readme', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(`https://api.github.com/users/${LOGIN}/starred?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status} on page ${page}`);
    const batch = await res.json();
    for (const s of batch) {
      const repo = s.repo || s;
      all.push({ name: repo.full_name, description: repo.description || '', topics: repo.topics || [], starredAt: s.starred_at || '' });
    }
    if (batch.length < 100) break;
  }
  return all;
}

async function fetchPatches() {
  if (process.env.STARS_CACHE && !process.env.PATCHES_LIVE) return null;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'profile-readme', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const q = encodeURIComponent(`author:${LOGIN} type:pr is:public -user:${LOGIN}`);
  const res = await fetch(`https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=20`, { headers });
  if (!res.ok) throw new Error(`GitHub search ${res.status}`);
  const { items = [] } = await res.json();
  return items
    .map((it) => ({
      repo: it.repository_url.split('/repos/')[1],
      number: it.number,
      url: it.html_url,
      title: it.title,
      state: it.pull_request && it.pull_request.merged_at ? 'merged' : it.state,
    }))
    .filter((p) => p.state === 'merged' || p.state === 'open')
    .slice(0, 6);
}

// Pull-request titles are other people's bytes by the time they come back
// from the API; keep them from being read as markup.
const md = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 140)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_[\]|~])/g, '\\$1');

function patchReadme(patches) {
  const file = join(ROOT, 'README.md');
  if (!patches || !patches.length || !existsSync(file)) return;
  const src = readFileSync(file, 'utf8');
  const open = '<!-- patches:start -->', close = '<!-- patches:end -->';
  const a = src.indexOf(open), b = src.indexOf(close);
  if (a < 0 || b < a) return;
  const list = patches.map((p) => `- \`${p.state}\` [${p.repo}#${p.number}](${p.url}) — ${md(p.title)}`).join('\n');
  const next = src.slice(0, a + open.length) + '\n' + list + '\n' + src.slice(b);
  if (next !== src) { writeFileSync(file, next); console.log('wrote README.md'); }
}

const write = (name, svg) => {
  const file = join(OUT, name);
  if (existsSync(file) && readFileSync(file, 'utf8') === svg) return false;
  writeFileSync(file, svg);
  console.log('wrote', name, `${(svg.length / 1024).toFixed(1)} kB`);
  return true;
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const now = process.env.BUILD_DATE ? new Date(process.env.BUILD_DATE) : new Date();
  const today = now.toISOString().slice(0, 10);
  const version = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  let stars = null, patches = null;
  try { stars = await fetchStars(); } catch (err) { console.warn('::warning::stars unavailable, keeping the existing plates —', err.message); }
  try { patches = await fetchPatches(); } catch (err) { console.warn('::warning::pull requests unavailable, keeping the existing list —', err.message); }

  for (const [name, T] of Object.entries(THEMES)) {
    write(`hero-${name}.svg`, hero(T));
    write(`footer-${name}.svg`, footer(T));
    if (!stars || !stars.length) continue;
    write(`triptych-${name}.svg`, triptych(T, { stars: stars.length, version }));
    // keep the old date unless the figure itself moved, so a quiet day makes no commit
    const file = join(OUT, `attention-${name}.svg`);
    const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const stamp = (old.match(/>updated (\d{4}-\d{2}-\d{2})</) || [])[1];
    if (stamp && attention(T, { stars, now, date: stamp }) === old) continue;
    write(`attention-${name}.svg`, attention(T, { stars, now, date: today }));
  }
  patchReadme(patches);
}

main().catch((err) => { console.warn('::warning::render failed —', err && err.stack || err); });
