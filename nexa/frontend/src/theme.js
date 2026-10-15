// Real theme persistence — spec #180 ("turn on dark mode" / settings-level theme control).
// NEXA previously had exactly one (dark) theme with no toggle. This adds a genuine second
// theme (light) plus a toggle, wired into Settings and into Codex's `set_theme` action.
import { applyColors, resetColors } from './colors.js';
const KEY = 'nexa.theme';

export function getStoredTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

// resetCustom=true is used when the person explicitly taps Dark/Light (Settings or Codex):
// their saved custom colours are cleared so the whole app switches to that mode at once.
// At startup it is false, so a saved colour scheme survives reloads.
export function applyTheme(theme, resetCustom = false) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable — theme just won't persist */ }
  if (resetCustom) resetColors(); else applyColors(); // saved colours stay on reload; explicit Dark/Light clears them
  return t;
}
