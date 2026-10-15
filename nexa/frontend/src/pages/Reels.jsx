import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';
import { useAuth } from '../AuthContext.jsx';
import { updateCodexContext } from '../codexContext.js';
import EditedMedia from '../components/EditedMedia.jsx';
import MediaPicker from '../components/MediaPicker.jsx';
import VideoEditor from '../components/VideoEditor.jsx';
import { fileKind, MAX_REEL_BYTES as MAX_VIDEO_BYTES } from '../editSettings.js';


// Reel format: 1080x1920 (9:16 vertical), min 720px, 30 FPS, cover 420x654 (1:1.55).
export const REEL_SPEC = { width: 1080, height: 1920, minRes: 720, minFps: 30, coverW: 420, coverH: 654 };

// Reads a picked video's real size, estimates its frame rate and renders a 420x654 cover frame.
// Portrait video fills the cover; landscape (16:9) is fitted whole over a blurred copy of itself
// so a horizontal clip becomes a phone-and-desktop-friendly vertical cover without cropping.
function analyseVideo(file, atSeconds = 0) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const out = { width: 0, height: 0, fps: null, cover: null };
    const finish = () => { URL.revokeObjectURL(url); resolve(out); };
    const timeout = setTimeout(finish, 8000);
    const done = () => { clearTimeout(timeout); finish(); };
    v.onerror = done;
    v.onloadedmetadata = () => {
      out.width = v.videoWidth; out.height = v.videoHeight;
      v.currentTime = Math.min(Math.max(0, atSeconds), Math.max(0, (v.duration || 1) - 0.1));
    };
    v.onseeked = async () => {
      try {
        const { coverW: cw, coverH: ch } = REEL_SPEC;
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const g = c.getContext('2d');
        const vw = v.videoWidth, vh = v.videoHeight;
        if (vw / vh <= 0.62) {
          const k = Math.max(cw / vw, ch / vh);
          g.drawImage(v, (cw - vw * k) / 2, (ch - vh * k) / 2, vw * k, vh * k);
        } else {
          const kb = Math.max(cw / vw, ch / vh);
          g.filter = 'blur(14px) brightness(0.6)';
          g.drawImage(v, (cw - vw * kb) / 2, (ch - vh * kb) / 2, vw * kb, vh * kb);
          g.filter = 'none';
          const k = Math.min(cw / vw, ch / vh);
          g.drawImage(v, (cw - vw * k) / 2, (ch - vh * k) / 2, vw * k, vh * k);
        }
        out.cover = c.toDataURL('image/jpeg', 0.85);
      } catch { /* cover is optional */ }
      // Frame-rate estimate: count presented frames over ~0.6s of playback (where supported).
      if (typeof v.requestVideoFrameCallback === 'function') {
        try {
          await v.play();
          let first = null; let n = 0;
          await new Promise((r) => {
            const step = (_now, meta) => {
              if (first === null) first = meta.mediaTime;
              else n += 1;
              if (meta.mediaTime - first >= 0.6 || n > 120) return r();
              v.requestVideoFrameCallback(step);
            };
            v.requestVideoFrameCallback(step);
            setTimeout(r, 2500);
          });
          const span = v.currentTime - first;
          if (n > 3 && span > 0.2) out.fps = Math.round(n / span);
          v.pause();
        } catch { /* autoplay blocked — skip fps */ }
      }
      done();
    };
  });
}

// One full-screen, full-height slide in the vertical reels feed — video fills the
// screen, everything else (author, caption, actions, comments) floats over it, TikTok/
// Reels-style. Scrolling the parent `.reels-viewport` snaps one slide at a time
// (scroll-snap-type: y mandatory), so a swipe/scroll down always lands on the next reel.
function ReelCard({ reel, onDeleted, muted, onToggleMute, onSoundBlocked }) {
  const { user } = useAuth();
  const [r, setR] = useState(reel);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [videoFailed, setVideoFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(reel.caption);
  const [showMuteHint, setShowMuteHint] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [videoEditor, setVideoEditor] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [mediaBusy, setMediaBusy] = useState(false);
  const replaceRef = useRef(null);
  const isMine = r.author.id === user.id;
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const viewRecordedRef = useRef(false);
  const muteHintTimer = useRef(null);

  // Real "current reel" tracking for Codex: whichever card is majority-visible in the
  // viewport becomes the one "this reel" resolves to — no fake/assumed state. The same
  // visibility signal also drives autoplay: play while a slide is the one on screen,
  // pause it the moment it's swiped away, so only one reel is ever making noise.
  useEffect(() => {
    viewRecordedRef.current = false;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const ratio = entries[0].intersectionRatio;
        if (ratio >= 0.6) {
          updateCodexContext({
            screen: 'reels',
            currentReel: { id: r.id, caption: r.caption, authorUsername: r.author.username },
          });
          // Sound is on by default for every reel. If the browser refuses to autoplay with
          // sound, fall back to muted playback and tell the parent so the next tap/keypress
          // anywhere unmutes ALL reels at once.
          const v = videoRef.current;
          if (v) {
            v.play().catch(() => {
              if (!v.muted) onSoundBlocked?.();
              v.muted = true;
              v.play().catch(() => {});
            });
          }
          // Section 130 — Recently Watched: recorded once per mount of this card, the
          // first time it's actually majority-visible, not on every intersection tick.
          if (!viewRecordedRef.current) {
            viewRecordedRef.current = true;
            api.recordReelView(r.id).catch(() => {});
          }
        } else {
          videoRef.current?.pause();
        }
      },
      { threshold: [0, 0.6] }
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line
  }, [r.id]);

  useEffect(() => () => { if (muteHintTimer.current) clearTimeout(muteHintTimer.current); }, []);

  const toggleMute = () => {
    onToggleMute();
    setShowMuteHint(true);
    if (muteHintTimer.current) clearTimeout(muteHintTimer.current);
    muteHintTimer.current = setTimeout(() => setShowMuteHint(false), 500);
  };

  const toggleLike = async () => {
    const wasLiked = r.likedByMe;
    setR({ ...r, likedByMe: !wasLiked, likeCount: r.likeCount + (wasLiked ? -1 : 1) });
    try {
      const res = wasLiked ? await api.unlikeReel(r.id) : await api.likeReel(r.id);
      setR(res.reel);
    } catch { setR(r); }
  };

  const toggleSave = async () => {
    const wasSaved = r.savedByMe;
    setR({ ...r, savedByMe: !wasSaved });
    try { wasSaved ? await api.unsaveReel(r.id) : await api.saveReel(r.id); } catch { setR(r); }
  };

  const saveEdit = async () => {
    const res = await api.editReel(r.id, captionDraft.trim());
    setR(res.reel);
    setEditing(false);
  };

  // Video edits (trim/speed/filter/mute/text) are saved as settings; "Replace" uploads a new file.
  const saveVideoEdits = async (edits) => {
    setMediaBusy(true); setMediaError('');
    try { setR((await api.editReel(r.id, undefined, edits)).reel); setVideoEditor(false); setVideoFailed(false); }
    catch (err) { setMediaError(err.message); } finally { setMediaBusy(false); }
  };
  const replaceVideo = async (file) => {
    if (!file) return;
    if (fileKind(file) !== 'video') return setMediaError('Choose an .mp4, .webm, or .mov video.');
    if (file.size > MAX_VIDEO_BYTES) return setMediaError(`That file is too large — videos must be under ${MAX_VIDEO_BYTES / 1048576}MB.`);
    setMediaBusy(true); setMediaError('');
    try { setR((await api.replaceReelMedia(r.id, file)).reel); setVideoFailed(false); }
    catch (err) { setMediaError(err.message); } finally { setMediaBusy(false); }
  };

  const deleteReel = async () => {
    await api.deleteReel(r.id);
    onDeleted?.(r.id);
  };

  const openComments = async () => {
    setShowComments(s => !s);
    if (!comments) setComments((await api.reelComments(r.id)).comments);
  };

  const submitComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    const res = await api.addReelComment(r.id, commentText.trim());
    setComments(c => [...(c || []), res.comment]);
    setCommentText('');
    setR({ ...r, commentCount: r.commentCount + 1 });
  };

  return (
    <div className={`reel-slide${showMuteHint ? ' show-mute-hint' : ''}`} ref={containerRef}>
     <div className="reel-stage">
      {!videoFailed ? (
        <EditedMedia
          src={r.videoUrl} type="video" edits={r.edits} videoRef={videoRef} muted={muted} fit="reel" smartFit
          className="reel-video" onClick={toggleMute} onError={() => setVideoFailed(true)}
        />
      ) : (
        <div className="reel-slide-state" style={{ padding: 30, textAlign: 'center', fontSize: 13 }}>
          Couldn't load this video URL — it may not be a directly playable file.
        </div>
      )}
      <div className="reel-mute-hint">{muted ? '🔇' : '🔊'}</div>
      <button type="button" className="reel-mute-btn" aria-label={muted ? 'Unmute all reels' : 'Mute all reels'}
        onClick={(e) => { e.stopPropagation(); toggleMute(); }}>
        {muted ? '🔇' : '🔊'}
      </button>

      <div className="reel-overlay-top">
        <Avatar user={r.author} size={38} />
        <div style={{ minWidth: 0 }}>
          <div className="name">{r.author.displayName}</div>
          <div className="handle">@{r.author.username}{r.editedAt && ' · edited'}</div>
        </div>
        <div className="spacer" />
        {isMine && !confirmingDelete && (
          <>
            <button className="btn-ghost" onClick={() => setEditing(e => !e)}>✏️ Edit</button>
            <button className="btn-ghost danger" style={{ color: '#ff8a8a' }} onClick={() => setConfirmingDelete(true)}>🗑 Delete</button>
          </>
        )}
        {isMine && confirmingDelete && (
          <>
            <span style={{ fontSize: 12, color: '#fff' }}>Delete this reel?</span>
            <button className="btn-ghost danger" style={{ color: '#ff8a8a' }} onClick={deleteReel}>Yes, delete</button>
            <button className="btn-ghost" onClick={() => setConfirmingDelete(false)}>Cancel</button>
          </>
        )}
      </div>

      <div className="reel-overlay-bottom">
        {editing ? (
          <div>
            <input value={captionDraft} onChange={e => setCaptionDraft(e.target.value)} maxLength={2200}
              style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, padding: '9px 12px', color: '#fff', outline: 'none', fontSize: 14 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn-primary" style={{ width: 'auto', padding: '7px 16px' }} onClick={saveEdit}>Save</button>
              <button className="btn-ghost" style={{ color: '#fff' }} onClick={() => { setEditing(false); setCaptionDraft(r.caption); }}>Cancel</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn-ghost" style={{ color: '#fff' }} disabled={mediaBusy} onClick={() => setVideoEditor(true)}>✏️ Edit video</button>
              <button className="btn-ghost" style={{ color: '#fff' }} disabled={mediaBusy} onClick={() => replaceRef.current?.click()}>Replace video</button>
              <input ref={replaceRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" onChange={e => { replaceVideo(e.target.files?.[0]); e.target.value = ''; }} />
              {mediaBusy && <span style={{ fontSize: 12, color: '#fff' }}>Saving…</span>}
            </div>
            {mediaError && <div className="error-banner" style={{ marginTop: 8 }}>{mediaError}</div>}
          </div>
        ) : (
          r.caption && <p className="reel-caption">{r.caption}</p>
        )}
      </div>

      <div className="reel-side-actions">
        <button className={r.likedByMe ? 'liked' : ''} onClick={toggleLike}>
          <span>{r.likedByMe ? '♥' : '♡'}</span><span className="count">{r.likeCount}</span>
        </button>
        <button onClick={openComments}>
          <span>💬</span><span className="count">{r.commentCount}</span>
        </button>
        <button onClick={toggleSave}>
          <span>{r.savedByMe ? '🔖' : '🏷️'}</span>
        </button>
      </div>

      {videoEditor && (
        <VideoEditor src={r.videoUrl} initialEdits={r.edits} onCancel={() => setVideoEditor(false)} onDone={saveVideoEdits} />
      )}

      {showComments && (
        <div className="reel-comments-sheet" onClick={e => e.stopPropagation()}>
          <button className="close-btn" onClick={() => setShowComments(false)}>✕ Close</button>
          <div className="comments-scroll">
            {(comments || []).map(c => (
              <div className="comment-row" key={c.id}><span className="b">{c.author.displayName}</span><span>{c.text}</span></div>
            ))}
            {comments?.length === 0 && <div style={{ color: 'var(--text-low)', fontSize: 13 }}>No comments yet.</div>}
          </div>
          <form className="comment-input-row" onSubmit={submitComment}>
            <input placeholder="Add a comment…" value={commentText} onChange={e => setCommentText(e.target.value)} />
          </form>
        </div>
      )}
     </div>
    </div>
  );
}

export default function Reels() {
  const [reels, setReels] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composing, setComposing] = useState(false);
  const [mode, setMode] = useState('upload'); // 'upload' | 'url'
  const [videoUrl, setVideoUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState(null); // MediaPicker value: { file, edits, … }
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(null); // { width, height, fps, cover }
  const sentinelRef = useRef(null);

  // One mute setting shared by every reel (remembered across visits). Audio is ON by default.
  const [mutedPref, setMutedPref] = useState(() => {
    try { return localStorage.getItem('reelsMuted') === '1'; } catch { return false; }
  });
  // True when the browser blocked autoplay-with-sound; reels play silently until the first gesture.
  const [soundBlocked, setSoundBlocked] = useState(false);
  const muted = mutedPref || soundBlocked;
  const toggleMute = () => {
    if (soundBlocked) { setSoundBlocked(false); return; }   // the user wants sound: unlock it
    setMutedPref(m => {
      const next = !m;
      try { localStorage.setItem('reelsMuted', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  useEffect(() => {
    if (!soundBlocked) return undefined;
    const unlock = () => setSoundBlocked(false);
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, [soundBlocked]);

  const load = async () => {
    const res = await api.reelsFeed();
    setReels(res.reels);
    setCursor(res.nextCursor);
  };
  useEffect(() => { load(); }, []);

  // Auto-load the next page as the last reel comes into view, so swiping/scrolling down
  // keeps going instead of dead-ending on a "Load more" button mid-swipe.
  useEffect(() => {
    if (!reels || !cursor || composing) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loadingMore) {
        setLoadingMore(true);
        api.reelsFeed(cursor).then(res => {
          setReels(rs => [...rs, ...res.reels]);
          setCursor(res.nextCursor);
        }).finally(() => setLoadingMore(false));
      }
    }, { threshold: 0.4 });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line
  }, [reels, cursor, composing]);

  // Inspect each newly picked video: real resolution, frame rate and a 420x654 cover.
  const pickedFile = media?.file;
  const trimStart = media?.edits?.trimStart || 0;
  useEffect(() => {
    if (!pickedFile) { setInfo(null); return undefined; }
    let alive = true;
    analyseVideo(pickedFile, trimStart).then(i => { if (alive) setInfo(i); });
    return () => { alive = false; };
  }, [pickedFile, trimStart]);

  const resetComposer = () => {
    setInfo(null);
    setVideoUrl(''); setCaption(''); setMedia(null); setError(''); setComposing(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'upload') {
        if (!media) { setError('Choose a video from your device first.'); return; }
        setUploading(true);
        const res = await api.uploadReel(media.file, caption.trim(), media.edits);
        setReels(r => [res.reel, ...(r || [])]);
      } else {
        const res = await api.createReel({ videoUrl: videoUrl.trim(), caption: caption.trim() });
        setReels(r => [res.reel, ...(r || [])]);
      }
      resetComposer();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="reels-page">
      <div className="reels-topbar">
        <h2 className="page-title" style={{ margin: 0 }}>Reels</h2>
        <button className="btn-ghost" onClick={() => (composing ? resetComposer() : setComposing(true))}>{composing ? 'Cancel' : '+ New reel'}</button>
      </div>

      {composing && (
        <form className="glass-card composer" style={{ margin: '0 20px 20px' }} onSubmit={submit}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button type="button" className="btn-ghost"
              style={{ padding: '5px 14px', fontSize: 12.5, background: mode === 'upload' ? 'var(--surface-hover)' : 'transparent' }}
              onClick={() => setMode('upload')}>
              📁 Upload from device
            </button>
            <button type="button" className="btn-ghost"
              style={{ padding: '5px 14px', fontSize: 12.5, background: mode === 'url' ? 'var(--surface-hover)' : 'transparent' }}
              onClick={() => setMode('url')}>
              🔗 Paste a URL
            </button>
          </div>

          {mode === 'upload' ? (
            <div style={{ marginBottom: 8 }}>
              <p className="reel-spec-note">
                Reels play in vertical 9:16 (1080 × 1920). Horizontal 16:9 videos are fitted automatically for phone and desktop — nothing is cropped or stretched.
                Best: 720 px or larger, 30 FPS or higher.
              </p>
              <MediaPicker value={media} onChange={setMedia} allow={['video']} maxVideoBytes={MAX_VIDEO_BYTES} disabled={uploading} />
              {info && (
                <div style={{ display: 'flex', gap: 12, marginTop: 10, alignItems: 'flex-start' }}>
                  {info.cover && <img className="reel-cover-preview" src={info.cover} alt="Reel cover preview" />}
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-mid)' }}>
                    <div><b>Cover</b> {REEL_SPEC.coverW} × {REEL_SPEC.coverH} px (1 : 1.55)</div>
                    {info.width > 0 && (
                      <div>
                        <b>Video</b> {info.width} × {info.height}
                        {info.width > info.height ? ' · horizontal — fitted into 9:16' : ' · vertical'}
                      </div>
                    )}
                    {info.fps && <div><b>Frame rate</b> ~{info.fps} FPS</div>}
                    {info.width > 0 && Math.min(info.width, info.height) < REEL_SPEC.minRes && (
                      <div style={{ color: 'var(--pink-ink)' }}>⚠ Under {REEL_SPEC.minRes}px — it may look soft on large screens.</div>
                    )}
                    {info.fps && info.fps < REEL_SPEC.minFps - 2 && (
                      <div style={{ color: 'var(--pink-ink)' }}>⚠ Under {REEL_SPEC.minFps} FPS — motion may look choppy.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Video URL (must be a direct .mp4/.webm/.mov link to an already-hosted file)</label>
              <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://…/clip.mp4" />
            </div>
          )}

          <div className="field" style={{ marginBottom: 8 }}>
            <label>Caption</label>
            <input value={caption} onChange={e => setCaption(e.target.value)} placeholder="Say something about it…" />
          </div>
          {error && <div className="error-banner">{error}</div>}
          <button className="btn-primary" style={{ width: 'auto', padding: '9px 20px' }} type="submit" disabled={uploading}>
            {uploading ? 'Uploading…' : 'Post reel'}
          </button>
        </form>
      )}

      {!composing && (
        <div className="reels-viewport">
          {reels === null && <div className="reel-slide"><div className="reel-slide-state"><span className="loading-dot" /> Loading reels…</div></div>}
          {reels?.length === 0 && <div className="reel-slide"><div className="reel-slide-state"><div className="glyph" style={{ fontSize: 34, marginBottom: 10 }}>🎬</div>No reels yet — be the first to post one.</div></div>}
          {reels?.map(r => (
            <ReelCard key={r.id} reel={r} muted={muted} onToggleMute={toggleMute} onSoundBlocked={() => setSoundBlocked(true)} onDeleted={(id) => setReels(rs => rs.filter(x => x.id !== id))} />
          ))}
          {cursor && reels?.length > 0 && (
            <div className="reel-slide" ref={sentinelRef}>
              <div className="reel-slide-state"><span className="loading-dot" /> Loading more…</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
