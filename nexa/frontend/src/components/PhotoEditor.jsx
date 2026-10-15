import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_FILTER, FILTER_PRESETS, SLIDERS, filterCss, mergeFilter } from '../editSettings.js';

const COLORS = ['#ffffff', '#000000', '#ff5c93', '#7c5cff', '#26e0c9', '#ffd84d', '#ff6b35'];
const ASPECTS = [['Free', null], ['Original', 'orig'], ['1:1', 1], ['4:5', 4 / 5], ['9:16', 9 / 16], ['16:9', 16 / 9]];
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const HAS_CTX_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

// Safari < 18 has no ctx.filter, so fall back to a manual pixel pass for the filters that
// are simple per-pixel maths. (Hue and blur are skipped there — they need the real thing.)
function pixelFilter(ctx, w, h, f) {
  const d = ctx.getImageData(0, 0, w, h);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    let r = p[i], g = p[i + 1], b = p[i + 2];
    r *= f.brightness; g *= f.brightness; b *= f.brightness;
    r = (r - 128) * f.contrast + 128; g = (g - 128) * f.contrast + 128; b = (b - 128) * f.contrast + 128;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * f.saturate; g = lum + (g - lum) * f.saturate; b = lum + (b - lum) * f.saturate;
    if (f.grayscale) { r += (lum - r) * f.grayscale; g += (lum - g) * f.grayscale; b += (lum - b) * f.grayscale; }
    if (f.sepia) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * f.sepia; g += (sg - g) * f.sepia; b += (sb - b) * f.sepia;
    }
    p[i] = Math.max(0, Math.min(255, r)); p[i + 1] = Math.max(0, Math.min(255, g)); p[i + 2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(d, 0, 0);
}

// Renders the current edit state to a fresh canvas. Pipeline: rotate/flip → colour filter →
// (optionally) crop → text & drawings. Text/drawing coordinates are normalised (0..1) against
// the CROPPED frame, which is why changing the crop/rotation clears them (see the editor).
function renderEdit(img, s, { maxDim, applyCrop }) {
  const swap = s.rot % 2 === 1;
  const rw = swap ? img.naturalHeight : img.naturalWidth;
  const rh = swap ? img.naturalWidth : img.naturalHeight;
  const k = Math.min(1, maxDim / Math.max(rw, rh));
  const bw = Math.max(1, Math.round(rw * k)), bh = Math.max(1, Math.round(rh * k));

  const base = document.createElement('canvas');
  base.width = bw; base.height = bh;
  const bctx = base.getContext('2d');
  const f = mergeFilter(s.filter);
  const css = filterCss(f);
  if (css !== 'none' && HAS_CTX_FILTER) bctx.filter = css;
  bctx.save();
  bctx.translate(bw / 2, bh / 2);
  bctx.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1); // flips happen in the VISIBLE frame…
  bctx.rotate((s.rot * Math.PI) / 2);              // …because rotate is applied to the point first
  bctx.drawImage(img, (-img.naturalWidth * k) / 2, (-img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
  bctx.restore();
  bctx.filter = 'none';
  if (css !== 'none' && !HAS_CTX_FILTER) pixelFilter(bctx, bw, bh, f);

  if (!applyCrop) return base;

  const c = s.crop;
  const ow = Math.max(1, Math.round(c.w * bw)), oh = Math.max(1, Math.round(c.h * bh));
  const out = document.createElement('canvas');
  out.width = ow; out.height = oh;
  const ctx = out.getContext('2d');
  ctx.drawImage(base, Math.round(c.x * bw), Math.round(c.y * bh), ow, oh, 0, 0, ow, oh);

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const st of s.strokes) {
    if (!st.points.length) continue;
    ctx.strokeStyle = st.color; ctx.fillStyle = st.color; ctx.lineWidth = st.size * ow;
    ctx.beginPath();
    st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * ow, y * oh) : ctx.moveTo(x * ow, y * oh)));
    if (st.points.length === 1) { ctx.arc(st.points[0][0] * ow, st.points[0][1] * oh, (st.size * ow) / 2, 0, Math.PI * 2); ctx.fill(); }
    else ctx.stroke();
  }
  for (const t of s.texts) {
    const px = Math.max(8, t.size * ow);
    ctx.font = `700 ${px}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = t.text.split('\n');
    lines.forEach((line, i) => {
      const x = t.x * ow, y = t.y * oh + (i - (lines.length - 1) / 2) * px * 1.15;
      if (t.bg) {
        const w = ctx.measureText(line).width;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x - w / 2 - px * 0.3, y - px * 0.6, w + px * 0.6, px * 1.2);
      } else { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = px * 0.12; }
      ctx.fillStyle = t.color;
      ctx.fillText(line, x, y);
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    });
  }
  return out;
}

// Photo editor — crop, rotate, flip, filters, text and drawing. Edits are baked into a new
// JPEG (what Instagram-style editors do), returned to `onDone(file)`. Animated GIFs lose
// their animation if edited, since the canvas only renders one frame.
export default function PhotoEditor({ src, title = 'Edit photo', onCancel, onDone }) {
  const [img, setImg] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState('crop');
  const [s, setS] = useState({ rot: 0, flipH: false, flipV: false, crop: FULL, filter: { ...DEFAULT_FILTER }, texts: [], strokes: [] });
  const [aspect, setAspect] = useState(null); // null = free, number = w/h pixel ratio
  const [selText, setSelText] = useState(null);
  const [brush, setBrush] = useState({ color: '#ff5c93', size: 0.012 });
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const baseDims = useRef({ bw: 1, bh: 1 });

  useEffect(() => {
    const im = new Image();
    im.onload = () => setImg(im);
    im.onerror = () => setLoadErr("Couldn't open this image for editing.");
    im.src = src;
  }, [src]);

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const inCrop = tab === 'crop';

  // Live preview. In the crop tab we show the whole rotated image (so the crop box has
  // something to sit on); in every other tab we show the cropped result.
  useEffect(() => {
    if (!img || !canvasRef.current) return;
    const out = renderEdit(img, s, { maxDim: 900, applyCrop: !inCrop });
    const cv = canvasRef.current;
    cv.width = out.width; cv.height = out.height;
    cv.getContext('2d').drawImage(out, 0, 0);
    if (inCrop) baseDims.current = { bw: out.width, bh: out.height };
  }, [img, s, inCrop]);

  const hasAnnotations = s.texts.length > 0 || s.strokes.length > 0;
  // Geometry changes would leave text/drawings pointing at the wrong spot, so confirm + clear.
  const geometryChange = (patch) => {
    if (hasAnnotations && !window.confirm('Changing the crop or rotation will clear your text and drawings. Continue?')) return;
    setS(prev => ({ ...prev, texts: [], strokes: [], ...patch }));
    setSelText(null);
  };

  // Rotating/flipping carries the crop box with the image instead of discarding it.
  const rotateRect = (c, dir) => (dir > 0 ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w });
  const rotate = (dir) => {
    geometryChange({ rot: (s.rot + dir + 4) % 4, crop: rotateRect(s.crop, dir) });
    setAspect(a => (a ? 1 / a : null)); // w/h swaps with the image
  };
  const flip = (axis) => geometryChange({
    [axis]: !s[axis],
    crop: axis === 'flipH' ? { ...s.crop, x: 1 - (s.crop.x + s.crop.w) } : { ...s.crop, y: 1 - (s.crop.y + s.crop.h) },
  });

  const dims = () => {
    const swap = s.rot % 2 === 1;
    const rw = swap ? img.naturalHeight : img.naturalWidth, rh = swap ? img.naturalWidth : img.naturalHeight;
    return { rw, rh };
  };
  const chooseAspect = (a) => {
    if (!img) return;
    const { rw, rh } = dims();
    const ar = a === 'orig' ? rw / rh : a;
    setAspect(ar);
    if (!ar) return;
    let w, h;
    if (ar >= rw / rh) { w = 1; h = rw / ar / rh; } else { h = 1; w = (ar * rh) / rw; }
    geometryChange({ crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } });
  };

  // ---- crop box dragging (normalised against the full rotated image) ----
  const pointNorm = (ev) => {
    const r = wrapRef.current.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
  };
  const startCrop = (mode, ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (hasAnnotations && !window.confirm('Changing the crop will clear your text and drawings. Continue?')) return;
    if (hasAnnotations) setS(p => ({ ...p, texts: [], strokes: [] }));
    const [px, py] = pointNorm(ev);
    dragRef.current = { kind: 'crop', mode, start: [px, py], orig: s.crop };
    wrapRef.current.setPointerCapture?.(ev.pointerId);
  };
  const MIN = 0.05;
  const moveCrop = (ev) => {
    const d = dragRef.current;
    const [px, py] = pointNorm(ev);
    const o = d.orig;
    if (d.mode === 'move') {
      const x = Math.min(1 - o.w, Math.max(0, o.x + px - d.start[0])), y = Math.min(1 - o.h, Math.max(0, o.y + py - d.start[1]));
      return setS(p => ({ ...p, crop: { ...o, x, y } }));
    }
    const left = d.mode.includes('w'), top = d.mode.includes('n');
    const ax = left ? o.x + o.w : o.x, ay = top ? o.y + o.h : o.y; // anchored (opposite) corner
    let w = Math.max(MIN, Math.abs(px - ax)), h = Math.max(MIN, Math.abs(py - ay));
    const maxW = left ? ax : 1 - ax, maxH = top ? ay : 1 - ay;
    if (aspect) {
      const { bw, bh } = baseDims.current;
      h = (w * bw) / (aspect * bh);
      if (h > maxH) { h = maxH; w = (h * aspect * bh) / bw; }
      if (w > maxW) { w = maxW; h = (w * bw) / (aspect * bh); }
    } else { w = Math.min(w, maxW); h = Math.min(h, maxH); }
    setS(p => ({ ...p, crop: { x: left ? ax - w : ax, y: top ? ay - h : ay, w, h } }));
  };

  // ---- text + draw pointer handling (normalised against the cropped preview) ----
  const onCanvasDown = (ev) => {
    if (inCrop || !img) return;
    const [x, y] = pointNorm(ev);
    if (tab === 'draw') {
      ev.preventDefault();
      wrapRef.current.setPointerCapture?.(ev.pointerId);
      dragRef.current = { kind: 'draw' };
      setS(p => ({ ...p, strokes: [...p.strokes, { color: brush.color, size: brush.size, points: [[x, y]] }] }));
    } else if (tab === 'text' && s.texts.length) {
      let best = -1, bd = 0.18;
      s.texts.forEach((t, i) => { const dd = Math.hypot(t.x - x, t.y - y); if (dd < bd) { bd = dd; best = i; } });
      if (best >= 0) {
        ev.preventDefault();
        setSelText(best);
        wrapRef.current.setPointerCapture?.(ev.pointerId);
        dragRef.current = { kind: 'text', i: best };
      }
    }
  };
  const onMove = (ev) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'crop') return moveCrop(ev);
    const [x, y] = pointNorm(ev);
    if (d.kind === 'draw') setS(p => { const st = p.strokes.slice(); const last = { ...st[st.length - 1] }; last.points = [...last.points, [x, y]]; st[st.length - 1] = last; return { ...p, strokes: st }; });
    if (d.kind === 'text') setS(p => ({ ...p, texts: p.texts.map((t, i) => (i === d.i ? { ...t, x, y } : t)) }));
  };

  const addText = () => {
    setS(p => ({ ...p, texts: [...p.texts, { text: 'Your text', x: 0.5, y: 0.5, size: 0.08, color: '#ffffff', bg: false }].slice(0, 10) }));
    setSelText(s.texts.length);
  };
  const patchText = (i, p) => setS(prev => ({ ...prev, texts: prev.texts.map((t, j) => (j === i ? { ...t, ...p } : t)) }));

  const finish = useCallback(async () => {
    if (!img) return;
    setBusy(true);
    try {
      const out = renderEdit(img, s, { maxDim: 2048, applyCrop: true });
      const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.9));
      if (!blob) throw new Error('Export failed');
      onDone(new File([blob], 'edited.jpg', { type: 'image/jpeg' }));
    } catch {
      setLoadErr("Couldn't export the edited photo. Try a smaller image.");
      setBusy(false);
    }
  }, [img, s, onDone]);

  const reset = () => { setS({ rot: 0, flipH: false, flipV: false, crop: FULL, filter: { ...DEFAULT_FILTER }, texts: [], strokes: [] }); setAspect(null); setSelText(null); };
  const c = s.crop;
  const tabs = [['crop', '✂️ Crop'], ['filters', '🎨 Filters'], ['text', '🔤 Text'], ['draw', '✏️ Draw']];

  // Portal to <body>: cards use backdrop-filter, which would otherwise make this
  // `position: fixed` overlay relative to the card instead of the viewport.
  return createPortal(
    <div className="me-overlay" role="dialog" aria-label={title}>
      <div className="me-modal">
        <div className="me-head">
          <strong>{title}</strong>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn-ghost" onClick={reset}>Reset</button>
          <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-primary" style={{ width: 'auto', padding: '8px 18px' }} disabled={!img || busy} onClick={finish}>{busy ? 'Saving…' : 'Done'}</button>
        </div>
        <div className="me-body">
          <div className="me-preview">
            {loadErr && <div className="error-banner">{loadErr}</div>}
            {!img && !loadErr && <div className="me-hint">Loading photo…</div>}
            <div
              ref={wrapRef}
              style={{ position: 'relative', display: img ? 'block' : 'none', margin: '0 auto', width: 'fit-content', maxWidth: '100%', touchAction: 'none', cursor: tab === 'draw' ? 'crosshair' : 'default' }}
              onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}
            >
              <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '100%', maxHeight: '58vh', borderRadius: 8, background: '#000' }} />
              {inCrop && img && (
                <div className="me-crop" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}
                  onPointerDown={(ev) => startCrop('move', ev)}>
                  {['nw', 'ne', 'sw', 'se'].map(m => <span key={m} className={`me-handle ${m}`} onPointerDown={(ev) => startCrop(m, ev)} />)}
                </div>
              )}
            </div>
            <div className="me-hint">
              {tab === 'crop' && 'Drag the box to move it, drag a corner to resize.'}
              {tab === 'text' && 'Drag text on the photo to place it.'}
              {tab === 'draw' && 'Draw directly on the photo.'}
            </div>
          </div>

          <div className="me-panel">
            <div className="me-tabs">{tabs.map(([k, l]) => <button type="button" key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

            {tab === 'crop' && (
              <div>
                <div className="me-chips">
                  {ASPECTS.map(([label, a]) => <button type="button" key={label} onClick={() => chooseAspect(a)}>{label}</button>)}
                </div>
                <div className="me-chips">
                  <button type="button" onClick={() => rotate(-1)}>⟲ Rotate left</button>
                  <button type="button" onClick={() => rotate(1)}>⟳ Rotate right</button>
                  <button type="button" onClick={() => flip('flipH')}>⇋ Flip horizontal</button>
                  <button type="button" onClick={() => flip('flipV')}>⇅ Flip vertical</button>
                </div>
              </div>
            )}

            {tab === 'filters' && (
              <div>
                <div className="me-chips">{FILTER_PRESETS.map(p => <button type="button" key={p.name} onClick={() => setS(prev => ({ ...prev, filter: mergeFilter(p.filter) }))}>{p.name}</button>)}</div>
                {SLIDERS.map(sl => (
                  <div key={sl.key}>
                    <div className="me-row"><span>{sl.label}</span><span>{s.filter[sl.key].toFixed(2)}</span></div>
                    <input type="range" min={sl.min} max={sl.max} step={sl.step} value={s.filter[sl.key]}
                      onChange={e => setS(prev => ({ ...prev, filter: { ...prev.filter, [sl.key]: parseFloat(e.target.value) } }))} />
                  </div>
                ))}
                {!HAS_CTX_FILTER && <div className="me-hint">This browser doesn't support hue or blur when saving — they'll be skipped.</div>}
              </div>
            )}

            {tab === 'text' && (
              <div>
                <button type="button" className="btn-ghost" onClick={addText} disabled={s.texts.length >= 10}>+ Add text</button>
                {s.texts.map((t, i) => (
                  <div key={i} className={`me-text-item${selText === i ? ' sel' : ''}`} onClick={() => setSelText(i)}>
                    <input value={t.text} maxLength={80} onChange={e => patchText(i, { text: e.target.value })} />
                    {selText === i && (
                      <>
                        <div className="me-row"><span>Size</span></div>
                        <input type="range" min={0.03} max={0.2} step={0.005} value={t.size} onChange={e => patchText(i, { size: parseFloat(e.target.value) })} />
                        <div className="me-chips">{COLORS.map(col => <button type="button" key={col} className={t.color === col ? 'active' : ''} style={{ background: col, width: 26, height: 26, padding: 0 }} onClick={() => patchText(i, { color: col })} aria-label={col} />)}</div>
                        <label className="me-check"><input type="checkbox" checked={t.bg} onChange={e => patchText(i, { bg: e.target.checked })} /> Background box</label>
                        <button type="button" className="btn-ghost" style={{ color: 'var(--pink-ink)' }} onClick={() => { setS(p => ({ ...p, texts: p.texts.filter((_, j) => j !== i) })); setSelText(null); }}>Remove</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === 'draw' && (
              <div>
                <div className="me-chips">{COLORS.map(col => <button type="button" key={col} className={brush.color === col ? 'active' : ''} style={{ background: col, width: 26, height: 26, padding: 0 }} onClick={() => setBrush(b => ({ ...b, color: col }))} aria-label={col} />)}</div>
                <div className="me-row"><span>Brush size</span></div>
                <input type="range" min={0.004} max={0.04} step={0.002} value={brush.size} onChange={e => setBrush(b => ({ ...b, size: parseFloat(e.target.value) }))} />
                <div className="me-chips">
                  <button type="button" onClick={() => setS(p => ({ ...p, strokes: p.strokes.slice(0, -1) }))} disabled={!s.strokes.length}>↶ Undo</button>
                  <button type="button" onClick={() => setS(p => ({ ...p, strokes: [] }))} disabled={!s.strokes.length}>Clear</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
