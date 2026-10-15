import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import EditedMedia from './EditedMedia.jsx';
import { defaultEdits, FILTER_PRESETS, SLIDERS, mergeFilter, playedSeconds } from '../editSettings.js';

const COLORS = ['#ffffff', '#000000', '#ff5c93', '#7c5cff', '#26e0c9', '#ffd84d', '#ff6b35'];
const SPEEDS = [0.5, 0.75, 1, 1.5, 2];
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;

// Non-destructive video editor: nothing is re-encoded. The result is a small settings
// object (trim, speed, mute, filter, text overlays) saved next to the original file and
// applied identically for every viewer — so it can also be re-opened and changed after
// posting. `maxPlaySeconds` (e.g. 30 for stories) is enforced here by clamping the trim.
export default function VideoEditor({ src, initialEdits, maxPlaySeconds, title = 'Edit video', onCancel, onDone }) {
  const [edits, setEdits] = useState(() => ({ ...defaultEdits(), ...(initialEdits || {}), filter: mergeFilter(initialEdits?.filter) }));
  const [duration, setDuration] = useState(0);
  const [tab, setTab] = useState('trim');
  const [sel, setSel] = useState(null); // selected overlay index
  const [note, setNote] = useState('');
  const videoRef = useRef(null);

  const patch = (p) => setEdits(e => ({ ...e, ...p }));
  const patchFilter = (p) => setEdits(e => ({ ...e, filter: { ...e.filter, ...p } }));

  // Re-fit the trim window so playback length never exceeds the limit. `speed` matters:
  // at 2x, 60s of source plays in 30s.
  const clampToLimit = (e, dur) => {
    if (!maxPlaySeconds || !dur) return e;
    const end = e.trimEnd ?? dur;
    const maxSource = maxPlaySeconds * e.speed;
    if (end - e.trimStart > maxSource + 0.01) {
      setNote(`Limited to ${maxPlaySeconds}s of playback — end point moved.`);
      return { ...e, trimEnd: Math.min(dur, e.trimStart + maxSource) };
    }
    return e;
  };

  const onDuration = (d) => {
    if (!Number.isFinite(d)) return;
    setDuration(d);
    setEdits(e => clampToLimit(e, d));
  };

  const setStart = (v) => setEdits(e => {
    const end = e.trimEnd ?? duration;
    const start = Math.min(v, end - 0.5);
    if (videoRef.current) videoRef.current.currentTime = start;
    return clampToLimit({ ...e, trimStart: Math.max(0, start) }, duration);
  });
  const setEnd = (v) => setEdits(e => {
    const end = Math.max(v, e.trimStart + 0.5);
    if (videoRef.current) videoRef.current.currentTime = Math.max(e.trimStart, end - 0.3);
    const next = { ...e, trimEnd: end >= duration - 0.05 ? null : end };
    // if the limit is exceeded, pull the START forward instead so the user's chosen end sticks
    if (maxPlaySeconds && end - e.trimStart > maxPlaySeconds * e.speed + 0.01) {
      setNote(`Limited to ${maxPlaySeconds}s of playback — start point moved.`);
      return { ...next, trimStart: Math.max(0, end - maxPlaySeconds * e.speed) };
    }
    return next;
  });
  const setSpeed = (s) => setEdits(e => clampToLimit({ ...e, speed: s }, duration));

  const addText = () => {
    setEdits(e => ({ ...e, overlays: [...e.overlays, { text: 'Your text', x: 50, y: 50, size: 32, color: '#ffffff', bg: false }].slice(0, 10) }));
    setSel(edits.overlays.length);
    setTab('text');
  };
  const patchOverlay = (i, p) => setEdits(e => ({ ...e, overlays: e.overlays.map((o, j) => (j === i ? { ...o, ...p } : o)) }));
  const removeOverlay = (i) => { setEdits(e => ({ ...e, overlays: e.overlays.filter((_, j) => j !== i) })); setSel(null); };

  const length = playedSeconds(edits, duration);
  const effEnd = edits.trimEnd ?? duration;
  const reset = () => { setEdits(clampToLimit(defaultEdits(), duration)); setSel(null); setNote(''); };

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const tabs = [['trim', '✂️ Trim'], ['speed', '⚡ Speed & sound'], ['filters', '🎨 Filters'], ['text', '🔤 Text']];

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
          <button type="button" className="btn-primary" style={{ width: 'auto', padding: '8px 18px' }} onClick={() => onDone(edits)}>Done</button>
        </div>

        <div className="me-body">
          <div className="me-preview">
            <EditedMedia
              src={src} type="video" edits={edits} videoRef={videoRef} controls autoPlay muted fit="contain"
              style={{ width: '100%', aspectRatio: '9 / 16', maxHeight: '58vh', background: '#000', borderRadius: 12, margin: '0 auto' }}
              onDuration={onDuration}
              onOverlayMove={(i, x, y) => patchOverlay(i, { x, y })} onOverlayClick={setSel}
            />
            <div className="me-hint">Drag text on the preview to place it. Preview plays muted — sound follows your Mute setting for viewers.</div>
          </div>

          <div className="me-panel">
            <div className="me-tabs">
              {tabs.map(([k, label]) => (
                <button type="button" key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>

            {tab === 'trim' && (
              <div>
                <div className="me-row"><span>Start</span><span>{fmt(edits.trimStart)}</span></div>
                <input type="range" min={0} max={Math.max(duration, 0.5)} step={0.1} value={edits.trimStart} disabled={!duration}
                  onChange={e => setStart(parseFloat(e.target.value))} />
                <div className="me-row"><span>End</span><span>{fmt(effEnd || 0)}</span></div>
                <input type="range" min={0} max={Math.max(duration, 0.5)} step={0.1} value={effEnd || 0} disabled={!duration}
                  onChange={e => setEnd(parseFloat(e.target.value))} />
                <div className="me-row" style={{ marginTop: 10 }}>
                  <span>Plays for</span>
                  <strong style={{ color: maxPlaySeconds && length > maxPlaySeconds ? 'var(--pink)' : 'inherit' }}>
                    {length === null ? '…' : `${length.toFixed(1)}s`}{maxPlaySeconds ? ` / max ${maxPlaySeconds}s` : ''}
                  </strong>
                </div>
                {note && <div className="me-hint" style={{ color: 'var(--teal-ink)' }}>{note}</div>}
              </div>
            )}

            {tab === 'speed' && (
              <div>
                <div className="me-row"><span>Playback speed</span></div>
                <div className="me-chips">
                  {SPEEDS.map(s => <button type="button" key={s} className={edits.speed === s ? 'active' : ''} onClick={() => setSpeed(s)}>{s}x</button>)}
                </div>
                <label className="me-check">
                  <input type="checkbox" checked={edits.muted} onChange={e => patch({ muted: e.target.checked })} />
                  Mute original sound for viewers
                </label>
              </div>
            )}

            {tab === 'filters' && (
              <div>
                <div className="me-chips">
                  {FILTER_PRESETS.map(p => (
                    <button type="button" key={p.name} onClick={() => patch({ filter: mergeFilter(p.filter) })}>{p.name}</button>
                  ))}
                </div>
                {SLIDERS.map(s => (
                  <div key={s.key}>
                    <div className="me-row"><span>{s.label}</span><span>{edits.filter[s.key].toFixed(2)}</span></div>
                    <input type="range" min={s.min} max={s.max} step={s.step} value={edits.filter[s.key]} onChange={e => patchFilter({ [s.key]: parseFloat(e.target.value) })} />
                  </div>
                ))}
              </div>
            )}

            {tab === 'text' && (
              <div>
                <button type="button" className="btn-ghost" onClick={addText} disabled={edits.overlays.length >= 10}>+ Add text</button>
                {edits.overlays.map((o, i) => (
                  <div key={i} className={`me-text-item${sel === i ? ' sel' : ''}`} onClick={() => setSel(i)}>
                    <input value={o.text} maxLength={80} onChange={e => patchOverlay(i, { text: e.target.value })} />
                    {sel === i && (
                      <>
                        <div className="me-row"><span>Size</span><span>{o.size}</span></div>
                        <input type="range" min={14} max={80} step={1} value={o.size} onChange={e => patchOverlay(i, { size: parseInt(e.target.value, 10) })} />
                        <div className="me-chips">
                          {COLORS.map(c => <button type="button" key={c} className={o.color === c ? 'active' : ''} style={{ background: c, width: 26, height: 26, padding: 0 }} onClick={() => patchOverlay(i, { color: c })} aria-label={c} />)}
                        </div>
                        <label className="me-check"><input type="checkbox" checked={o.bg} onChange={e => patchOverlay(i, { bg: e.target.checked })} /> Background box</label>
                        <button type="button" className="btn-ghost" style={{ color: 'var(--pink-ink)' }} onClick={() => removeOverlay(i)}>Remove</button>
                      </>
                    )}
                  </div>
                ))}
                {edits.overlays.length === 0 && <div className="me-hint">No text yet.</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
