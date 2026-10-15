// App colour scheme: background (two-colour gradient), letter colour, box colour.
// Everything in the app reads the CSS variables set here, so one change recolours the
// whole app. Saved per device; with nothing saved, the Dark / Light mode defaults apply.
const KEY = 'nexa.colors';

export const MODE_DEFAULTS = {
  dark:  { bgA: '#0a0812', bgB: '#2a1f5c', angle: 135, text: '#ffffff', box: '#1a1530' },
  light: { bgA: '#4cc9f0', bgB: '#e0f4ff', angle: 135, text: '#07162b', box: '#ffffff' },
};

export const PRESETS = [
  { name: 'Ocean day',  bgA: '#4cc9f0', bgB: '#e0f4ff', angle: 135, text: '#07162b', box: '#ffffff' },
  { name: 'Midnight',   bgA: '#0a0812', bgB: '#2a1f5c', angle: 135, text: '#ffffff', box: '#1a1530' },
  { name: 'Sunset',     bgA: '#ff9966', bgB: '#ff5e62', angle: 135, text: '#1a0a05', box: '#fff4ec' },
  { name: 'Mint',       bgA: '#d4fc79', bgB: '#96e6a1', angle: 135, text: '#06240f', box: '#ffffff' },
  { name: 'Royal',      bgA: '#1e3a8a', bgB: '#7c3aed', angle: 135, text: '#ffffff', box: '#141b4d' },
  { name: 'Mono',       bgA: '#f2f2f2', bgB: '#cfcfcf', angle: 160, text: '#000000', box: '#ffffff' },
  { name: 'Black gold', bgA: '#111111', bgB: '#333333', angle: 160, text: '#ffe600', box: '#000000' },
  { name: 'Rose',       bgA: '#ffd1dc', bgB: '#ff8fab', angle: 135, text: '#2b0010', box: '#fff0f4' },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
// mix(a, b, t): t=0 -> a, t=1 -> b
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };

const lum = (h) => {
  const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

// Worst-case contrast of the letter colour against the places letters appear.
export const worstContrast = (c) => Math.min(contrast(c.text, c.box), contrast(c.text, c.bgA), contrast(c.text, c.bgB));

// Pick black or white letters, whichever reads best on this box + background.
export function autoText(c) {
  const dark = { ...c, text: '#000000' }, light = { ...c, text: '#ffffff' };
  return worstContrast(dark) >= worstContrast(light) ? '#000000' : '#ffffff';
}

const clean = (c, base) => {
  const o = { ...base };
  if (c && typeof c === 'object') {
    for (const k of ['bgA', 'bgB', 'text', 'box']) if (HEX.test(c[k])) o[k] = c[k].toLowerCase();
    if (Number.isFinite(c.angle)) o.angle = Math.max(0, Math.min(360, Math.round(c.angle)));
  }
  return o;
};

// Nudge an accent colour toward the letter colour until it reads clearly on the box colour.
function ink(accent, c, min = 4.5) {
  let col = accent;
  for (let t = 0; t <= 1.0001 && contrast(col, c.box) < min; t += 0.05) col = mix(accent, c.text, t);
  return col;
}

const mode = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

export function getCustomColors() {
  try { const raw = localStorage.getItem(KEY); return raw ? clean(JSON.parse(raw), MODE_DEFAULTS[mode()]) : null; } catch { return null; }
}
export const getActiveColors = () => getCustomColors() || MODE_DEFAULTS[mode()];

export function applyColors() {
  const c = getActiveColors();
  const s = document.documentElement.style;
  const set = (k, v) => s.setProperty(k, v);
  set('--app-bg-grad', `linear-gradient(${c.angle}deg, ${c.bgA}, ${c.bgB})`);
  set('--bg-void', c.bgA);
  set('--bg-deep', c.box);
  set('--surface', c.box);
  set('--surface-hover', mix(c.box, c.text, 0.12));
  set('--border-soft', mix(c.box, c.text, 0.6));
  set('--text-hi', c.text);
  set('--text-mid', mix(c.text, c.box, 0.15));
  set('--text-low', mix(c.text, c.box, 0.32));
  // Accent colours used for TEXT (red delete buttons, teal notes, liked hearts, active tabs).
  set('--pink-ink', ink('#ff5c93', c));
  set('--teal-ink', ink('#26e0c9', c));
  set('--violet-ink', ink('#9b7dff', c));
  return c;
}

export function saveColors(c) {
  const v = clean(c, MODE_DEFAULTS[mode()]);
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* not persisted */ }
  return applyColors();
}
export function resetColors() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return applyColors();
}
