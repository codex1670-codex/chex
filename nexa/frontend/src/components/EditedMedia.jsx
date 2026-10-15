import { useEffect, useRef, useState } from 'react';
import { filterCss, mergeFilter } from '../editSettings.js';

// Renders a photo or video with its non-destructive edit settings applied: colour filter,
// text overlays, and — for video — trim window, playback speed and mute. Used everywhere
// media is shown (feed, stories, reels, editors) so a video looks identical to every viewer.
//
// Props:
//   src, type ('image'|'video'), edits
//   videoRef        optional ref to the <video> element (reels use it for autoplay)
//   muted           extra mute on top of edits.muted (e.g. the reel's tap-to-unmute)
//   onEnded         called when a non-looping video reaches the end of its trim window
//   onDuration      called with the full file duration once metadata loads
//   onProgress      called with 0..1 progress through the trim window
//   onOverlayMove   if set, text overlays become draggable (editor mode): (index, x, y)
//   onOverlayClick  (index) editor mode selection
export default function EditedMedia({
  src, type, edits, className, style, videoRef, muted = false, autoPlay = false, loop = true,
  controls = false, onEnded, onDuration, onProgress, onOverlayMove, onOverlayClick, onClick, onError, fit = 'cover', mediaMaxHeight, smartFit = false,
}) {
  const localRef = useRef(null);
  const vref = videoRef || localRef;
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const overlayBoxRef = useRef(null);
  const e = edits || {};
  const start = e.trimStart || 0;
  const end = e.trimEnd || null;
  const speed = e.speed || 1;

  // --- Fit any video/photo (any length, width, height, orientation) into its frame ---
  // 'contain' never crops or stretches. We track the frame size + the media's natural size so
  //  (a) text overlays sit on the picture itself, not on the letterbox bars, and
  //  (b) the bars are filled with a soft blurred copy of the picture instead of dead black.
  const isReelFit = fit === 'reel';
  const contain = (fit === 'contain' || isReelFit) && smartFit; // blurred backdrop + letterbox-aware overlays: Reels only
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const bgRef = useRef(null);
  useEffect(() => {
    if (!contain || !wrapRef.current) return;
    const el = wrapRef.current;
    const update = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [contain, src]);
  useEffect(() => { setNatural({ w: 0, h: 0 }); }, [src]);

  // Blurred backdrop for videos: paint the current frame into a tiny canvas (cheap), CSS blurs it.
  useEffect(() => {
    if (!contain || type !== 'video') return;
    const v = vref.current; const c = bgRef.current;
    if (!v || !c) return;
    const ctx = c.getContext('2d');
    let raf = 0; let last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 120 || v.readyState < 2) return;
      last = t;
      try { ctx.drawImage(v, 0, 0, c.width, c.height); } catch { /* ignore */ }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [contain, type, src, vref]);

  // Reels: anything close to 9:16 (or taller) fills the stage; wider video (16:9, 4:3, square)
  // is fitted whole inside it so nothing is cropped. Unknown size yet => contain.
  const ratio = natural.w && natural.h ? natural.w / natural.h : 0;
  const reelFills = isReelFit && ratio > 0 && ratio <= 0.62;
  const effFit = isReelFit ? (reelFills ? 'cover' : 'contain') : fit;

  // Where the picture really sits inside the frame (letterbox-aware).
  let box = null;
  if (contain && frame.w && frame.h && natural.w && natural.h) {
    const k = Math.min(frame.w / natural.w, frame.h / natural.h);
    const w = natural.w * k; const h = natural.h * k;
    // A cropped (cover) picture fills the whole frame, so overlays use the full frame.
    box = reelFills ? { left: 0, top: 0, width: frame.w, height: frame.h } : { left: (frame.w - w) / 2, top: (frame.h - h) / 2, width: w, height: h };
  }

  // Keep the element's speed in sync (also re-applied after each load).
  useEffect(() => { if (vref.current) vref.current.playbackRate = speed; }, [speed, src, vref]);

  // Apply the trim window: start inside it, and when playback passes the end either loop
  // back to the start or report "ended" (stories advance on that).
  const onLoadedMetadata = (ev) => {
    const v = ev.currentTarget;
    v.playbackRate = speed;
    if (start > 0 && v.currentTime < start) v.currentTime = start;
    if (v.videoWidth) setNatural({ w: v.videoWidth, h: v.videoHeight });
    onDuration?.(v.duration);
  };
  const onTimeUpdate = (ev) => {
    const v = ev.currentTarget;
    const stop = end ?? v.duration;
    if (onProgress && stop > start) onProgress(Math.min(1, Math.max(0, (v.currentTime - start) / (stop - start))));
    if (end && v.currentTime >= end) {
      if (loop) { v.currentTime = start; v.play?.().catch(() => {}); }
      else { v.pause(); onEnded?.(); }
    }
  };
  const onVideoEnded = (ev) => {
    if (loop) { ev.currentTarget.currentTime = start; ev.currentTarget.play().catch(() => {}); }
    else onEnded?.();
  };

  const startDrag = (i, ev) => {
    if (!onOverlayMove) return;
    ev.preventDefault(); ev.stopPropagation();
    dragRef.current = i;
    onOverlayClick?.(i);
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  };
  const moveDrag = (ev) => {
    if (dragRef.current === null || !wrapRef.current) return;
    const r = (overlayBoxRef.current || wrapRef.current).getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100));
    const y = Math.min(100, Math.max(0, ((ev.clientY - r.top) / r.height) * 100));
    onOverlayMove(dragRef.current, Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  };

  // With mediaMaxHeight the media keeps its natural proportions (feed posts) instead of filling a fixed frame.
  const mediaStyle = { width: '100%', height: mediaMaxHeight ? 'auto' : '100%', maxHeight: mediaMaxHeight, objectFit: effFit, display: 'block', position: contain ? 'relative' : undefined, zIndex: contain ? 1 : undefined, maxWidth: '100%', filter: filterCss(mergeFilter(e.filter)) };
  const filt = filterCss(mergeFilter(e.filter));

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ position: 'relative', overflow: 'hidden', containerType: 'inline-size', ...style }}
      onClick={onClick}
      onPointerMove={onOverlayMove ? moveDrag : undefined}
      onPointerUp={onOverlayMove ? () => { dragRef.current = null; } : undefined}
    >
      {contain && type === 'video' && (
        <canvas ref={bgRef} width={48} height={48} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#000', filter: `blur(18px) brightness(0.6) ${filt}`, transform: 'scale(1.3)' }} />
      )}
      {contain && type !== 'video' && (
        <img src={src} alt="" aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: `blur(18px) brightness(0.6) ${filt}`, transform: 'scale(1.3)' }} />
      )}
      {type === 'video' ? (
        <video
          ref={vref} src={src} style={mediaStyle} playsInline controls={controls} autoPlay={autoPlay}
          muted={muted || !!e.muted} loop={false}
          onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onTimeUpdate} onEnded={onVideoEnded} onError={onError}
        />
      ) : (
        <img src={src} alt="" style={mediaStyle} onError={onError}
          onLoad={(ev) => setNatural({ w: ev.currentTarget.naturalWidth, h: ev.currentTarget.naturalHeight })} />
      )}
      {(e.overlays || []).length > 0 && (
        <div
          ref={overlayBoxRef}
          style={{
            position: 'absolute', zIndex: 2, containerType: 'inline-size', pointerEvents: 'none',
            ...(box ? box : { inset: 0 }),
          }}
        >
          {(e.overlays || []).map((o, i) => (
            <div
              key={i}
              onPointerDown={(ev) => startDrag(i, ev)}
              style={{
                position: 'absolute', left: `${o.x}%`, top: `${o.y}%`, transform: 'translate(-50%, -50%)',
                // size is defined against a 360px-wide frame; cqw keeps it proportional at any size.
                fontSize: `${o.size / 3.6}cqw`, color: o.color, fontWeight: 700, lineHeight: 1.15, textAlign: 'center',
                maxWidth: '90%', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                textShadow: o.bg ? 'none' : '0 1px 4px rgba(0,0,0,0.6)',
                background: o.bg ? 'rgba(0,0,0,0.55)' : 'transparent', padding: o.bg ? '0.15em 0.4em' : 0, borderRadius: '0.3em',
                cursor: onOverlayMove ? 'grab' : 'inherit', touchAction: onOverlayMove ? 'none' : 'auto',
                pointerEvents: onOverlayMove ? 'auto' : 'none', userSelect: 'none',
              }}
            >{o.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
