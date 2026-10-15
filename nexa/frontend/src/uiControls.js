// Screen reader + hands for Codex.
//
// scanControls() reads the live DOM and returns a compact map of everything the user could press
// or type into right now (buttons, links, tabs, inputs, switches, and clickable cards/rows), plus
// section headings for "scroll to ..." commands. The map is sent to the server with each command
// so Codex can pick a control by meaning, in any language. pressControl()/typeInto()/scrollPage()
// then operate the real element, exactly as a tap would.
//
// Nothing here is per-button: add a button to any page and Codex can already see it.
// Field VALUES are never read or sent — only labels — and password boxes are never touched.

const SKIP = '.codex-panel, .codex-fab, [data-codex-ignore]';
const NATIVE = 'button, a[href], input, textarea, select, summary, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [role="switch"], [role="checkbox"], [role="option"]';
const HEADINGS = 'h1, h2, h3, h4, legend, [role="heading"], .page-title';
// Whole class tokens only: "post-actions" is a button row, not the post.
const CARD_TOKENS = new Set(['glass-card', 'reel-slide', 'convo-item', 'comment-row', 'note-card', 'request-list-item', 'request-banner', 'bubble', 'post-card', 'story-card', 'card']);
const isCard = (a) => a.tagName === 'ARTICLE' || a.tagName === 'LI' || (a.classList && [...a.classList].some(c => CARD_TOKENS.has(c)));

const ids = new WeakMap();      // element -> stable id (kept across scans while the element lives)
const registry = new Map();     // id -> element (rebuilt each scan)
let nextId = 1;

const clean = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hasLayout() {
  return typeof document !== 'undefined' && document.body.getClientRects().length > 0;
}

function visibleEl(el, layout) {
  if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (layout) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
  } else {
    // no layout engine (tests): a display:none ancestor still hides the element
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).display === 'none') return false;
  }
  return true;
}

function labelText(el) {
  const tag = el.tagName.toLowerCase();
  const parts = [];
  if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) parts.push(el.value);
  else if (tag === 'input' || tag === 'textarea') {
    parts.push(el.getAttribute('aria-label'), el.labels?.[0]?.textContent, el.placeholder, el.title, el.name);
  } else if (tag === 'select') {
    parts.push(el.getAttribute('aria-label'), el.labels?.[0]?.textContent, el.title, el.name);
  } else {
    parts.push(el.innerText || el.textContent);
    parts.push(el.getAttribute('aria-label'), el.title, el.querySelector('img[alt]')?.alt);
  }
  const seen = new Set();
  return clean(parts.filter(Boolean).map(p => clean(p, 60)).filter(p => p && !seen.has(p) && seen.add(p)).join(' '));
}

function kindOf(el) {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  if (tag === 'input') {
    if (el.type === 'file') return 'file';
    if (['checkbox', 'radio'].includes(el.type)) return 'checkbox';
    if (['button', 'submit', 'reset'].includes(el.type)) return 'button';
    return 'input';
  }
  if (tag === 'textarea') return 'input';
  if (tag === 'select') return 'select';
  if (role === 'tab') return 'tab';
  if (role === 'switch' || role === 'checkbox') return 'checkbox';
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'button' || role === 'button' || role === 'menuitem' || tag === 'summary') return 'button';
  return 'click';
}

const cardCtx = new Map();
function contextText(el, ownLabel) {
  let a = el.parentElement;
  for (let i = 0; a && i < 7 && a !== document.body; i++, a = a.parentElement) {
    if (isCard(a)) {
      if (!cardCtx.has(a)) {
        const lines = (a.innerText ?? a.textContent ?? '').split('\n').map(l => clean(l, 40)).filter(Boolean);
        cardCtx.set(a, clean(lines.slice(0, 2).join(' · '), 70));
      }
      const t = cardCtx.get(a);
      return t && t !== ownLabel ? t : '';
    }
  }
  return '';
}

const modalCache = new Map();
function inDialog(el, layout) {
  if (el.closest('[role="dialog"], [aria-modal="true"]')) return true;
  if (!layout) return false;
  for (let a = el; a && a !== document.body; a = a.parentElement) {
    if (!modalCache.has(a)) {
      const cs = getComputedStyle(a);
      let big = false;
      if (cs.position === 'fixed') {
        const r = a.getBoundingClientRect();
        big = r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.4;
      }
      modalCache.set(a, big);
    }
    if (modalCache.get(a)) return true;
  }
  return false;
}

function pointerRoot(el) {
  // cursor is inherited, so the clickable element is the topmost one where "pointer" begins
  const cs = getComputedStyle(el);
  if (cs.cursor !== 'pointer') return false;
  const p = el.parentElement;
  return !p || getComputedStyle(p).cursor !== 'pointer';
}

export function scanControls({ limit = 350 } = {}) {
  cardCtx.clear(); modalCache.clear(); registry.clear();
  const layout = hasLayout();
  const vw = innerWidth || 1, vh = innerHeight || 1;
  const out = [];   // [{ el, item }] — sorted into true document order below, so "second like" means the second one on the page
  const seen = new Set();

  const add = (el, kind) => {
    if (seen.has(el) || el.closest(SKIP) || !visibleEl(el, layout)) return;
    seen.add(el);
    if (!ids.has(el)) ids.set(el, nextId++);
    const id = ids.get(el);
    const label = kind === 'heading' ? clean(el.textContent, 60) : labelText(el);
    if (!label && kind !== 'input' && kind !== 'select' && kind !== 'file') return;
    let vis = true, d = 0.5;
    if (layout) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      vis = cx >= 0 && cx <= vw && cy >= 0 && cy <= vh;
      d = Math.min(1, Math.hypot((cx - vw / 2) / vw, (cy - vh / 2) / vh) * 1.6);
    }
    registry.set(String(id), el);
    out.push({ el, item: {
      id,
      kind,
      type: el.tagName === 'INPUT' ? el.type : undefined,
      label,
      ctx: kind === 'heading' ? '' : contextText(el, label),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      vis,
      d: Math.round(d * 100) / 100,
      modal: kind === 'heading' ? false : inDialog(el, layout),
      checked: kind === 'checkbox' ? !!el.checked : undefined,
    } });
  };

  document.querySelectorAll(NATIVE).forEach(el => add(el, kindOf(el)));
  // Hidden <input type=file> is invisible, but its visible trigger button is found above.
  document.querySelectorAll('div, span, li, img, p, h3, h4, section, article').forEach(el => {
    if (seen.has(el) || el.closest('button, a[href], [role="button"], input, select, textarea')) return;
    if (el.querySelector('button, a[href], input, select, textarea')) return;   // wrapper, not the control itself
    if (pointerRoot(el)) add(el, 'click');
  });
  document.querySelectorAll(HEADINGS).forEach(el => add(el, 'heading'));

  const docOrder = (a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  out.sort(docOrder);
  if (out.length <= limit) return out.map(o => o.item);
  // Over the cap: keep dialog + on-screen controls first.
  const keep = [...out].sort((a, b) => (b.item.modal - a.item.modal) || (b.item.vis - a.item.vis) || (a.item.d - b.item.d)).slice(0, limit);
  return keep.sort(docOrder).map(o => o.item);
}

// ───────────────────────────── actions ─────────────────────────────

function pulse(el) {
  el.classList.add('codex-pulse');
  setTimeout(() => el.classList.remove('codex-pulse'), 1100);
}

async function bringIntoView(el) {
  const r = el.getBoundingClientRect();
  const inView = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  if (!inView && r.width + r.height > 0) {
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    await sleep(450);
  }
}

function elementFor(id) {
  const el = registry.get(String(id));
  return el && el.isConnected ? el : null;
}

export async function pressControl(id) {
  const el = elementFor(id);
  if (!el) return { ok: false, error: 'That control is no longer on screen.' };
  if (el.disabled) return { ok: false, error: 'That button is disabled right now.' };
  await bringIntoView(el);
  pulse(el);
  await sleep(320); // let the person see what is about to be pressed
  if (!el.isConnected) return { ok: false, error: 'The screen changed before I could press it.' };
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)) { el.focus(); return { ok: true }; }
  el.click();
  return { ok: true };
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);   // bypass React's value tracker
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function typeInto(id, text, submit = false) {
  const el = elementFor(id);
  if (!el) return { ok: false, error: 'That text box is no longer on screen.' };
  if (el.type === 'password' || el.type === 'file') return { ok: false, error: "I don't type into that kind of field." };
  if (el.disabled || el.readOnly) return { ok: false, error: 'That box is read-only right now.' };
  await bringIntoView(el);
  pulse(el);
  el.focus();
  if (el.tagName === 'SELECT') {
    const want = String(text).trim().toLowerCase();
    const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want) || [...el.options].find(o => o.text.toLowerCase().includes(want) || o.value.toLowerCase() === want);
    if (!opt) return { ok: false, error: `That list has no option like “${text}”.` };
    setNativeValue(el, opt.value);
    return { ok: true };
  }
  setNativeValue(el, text);
  if (submit) {
    await sleep(120);
    const form = el.closest('form');
    if (form) form.requestSubmit();
    else for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  return { ok: true };
}

function scroller() {
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  for (; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
  }
  return document.scrollingElement || document.documentElement;
}

export async function scrollPage(direction) {
  const el = scroller();
  const h = el === document.scrollingElement || el === document.documentElement ? innerHeight : el.clientHeight;
  const to = { down: el.scrollTop + h * 0.8, up: el.scrollTop - h * 0.8, next: el.scrollTop + h, previous: el.scrollTop - h, top: 0, bottom: el.scrollHeight }[direction];
  if (to === undefined) return { ok: false, error: 'Unknown scroll direction.' };
  const before = el.scrollTop;
  el.scrollTo({ top: Math.max(0, to), behavior: 'smooth' });
  await sleep(500);
  const moved = Math.abs(el.scrollTop - before) > 1;
  return moved ? { ok: true } : { ok: false, error: direction === 'top' || direction === 'up' || direction === 'previous' ? "You're already at the top." : "You're already at the bottom." };
}

export async function scrollToControl(id) {
  const el = elementFor(id);
  if (!el) return { ok: false, error: 'That section is no longer on screen.' };
  el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  pulse(el);
  await sleep(500);
  return { ok: true };
}

// Wait until the page stops changing (route switch, data load, dialog animation).
export function settle({ quiet = 300, max = 2500 } = {}) {
  return new Promise(resolve => {
    let timer = setTimeout(done, quiet);
    const cap = setTimeout(done, max);
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); }
  });
}
