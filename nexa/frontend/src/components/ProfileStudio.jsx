import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

// Profile Studio — ported from the standalone Profile_studio.html.
//
// What is different from the standalone file: nothing here lives in localStorage or in
// object URLs. Every change goes to the server, so every viewer of the profile sees it:
//   • photo / video   -> existing upload routes (users/me/avatar-photo, users/me/profile-video)
//   • name / bio      -> PATCH users/me
//   • theme/bg/dim/blur -> PATCH users/me/studio (stored with the profile, returned to everyone)
// The 19 preset clips are static files in /public/studio. Picking one uploads it as the
// user's real profile video, so it behaves exactly like a clip they uploaded themselves.

export const PRESET_COUNT = 19;
const clipUrl = (i) => `/studio/clip-${i}.mp4`;
const thumbUrl = (i) => `/studio/thumb-${i}.jpg`;

const THEMES = [
  ['Dusk', '#14121f', '#1f1b30', '#f3efff', '#a39bc4', '#ff7ab8', '#1a0f18'],
  ['Chalk', '#e4e9ef', '#ffffff', '#14202b', '#5b6b7a', '#2f6bff', '#ffffff'],
  ['Lagoon', '#04282b', '#0a3d40', '#e4fffb', '#84c7c0', '#2ee6c5', '#032421'],
  ['Ember', '#1d0c08', '#2e1510', '#ffece4', '#d0a090', '#ff6a2b', '#1d0c08'],
  ['Orchid', '#2a0f3a', '#3d1a52', '#fbeaff', '#c7a0d8', '#e26bff', '#2a0f3a'],
  ['Moss', '#101a10', '#1b2a1a', '#eaf5df', '#9ab58f', '#b6e04a', '#101a10'],
  ['Citrus', '#ffefb8', '#fffdf2', '#2b2200', '#7a6a2a', '#e8a100', '#2b2200'],
  ['Graphite', '#1c1d20', '#2a2c31', '#f2f3f5', '#9a9ea8', '#ffffff', '#1c1d20'],
];
const GRADS = [
  'linear-gradient(135deg,#ff7ab8,#6a4cff)', 'linear-gradient(135deg,#2ee6c5,#0b4f8a)',
  'linear-gradient(135deg,#ffb347,#ff3d6e)', 'linear-gradient(135deg,#b6e04a,#0f5132)',
  'linear-gradient(160deg,#1c1d20,#4b4f5c)', 'linear-gradient(135deg,#fff1b8,#ff9d6c)',
  'linear-gradient(135deg,#e26bff,#2a0f3a)',
];

const DEFAULT_STUDIO = { theme: 0, bg: { kind: 'theme', value: null }, dim: 35, blur: 0 };
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 40;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

// Reads the real duration from the browser before anything is uploaded.
function measureVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); resolve(d); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    v.src = url;
  });
}

// First frame of an uploaded clip, used as its cover/poster.
function captureCover(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const done = (blob) => { URL.revokeObjectURL(url); resolve(blob); };
    v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob(b => done(b), 'image/jpeg', 0.85);
      } catch { done(null); }
    };
    v.onerror = () => done(null);
    v.src = url;
  });
}

function Media({ kind, src, poster, muted = true, className }) {
  if (kind === 'video') {
    return <video className={className} src={src} poster={poster || undefined} muted={muted} loop autoPlay playsInline />;
  }
  return <img className={className} src={src} alt="" />;
}

export default function ProfileStudio({ profile, isSelf, onUpdated, openSheet, onSheetConsumed, onOpenSettings, children }) {
  const [studio, setStudio] = useState(profile.studio || DEFAULT_STUDIO);
  const [sheet, setSheet] = useState(null); // null | 'video' | 'look'
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef(null);
  const saveTimer = useRef(null);
  const nameRef = useRef(null);
  const bioRef = useRef(null);

  // Another user's look (or a refresh after saving) always wins over local state.
  useEffect(() => { setStudio(profile.studio || DEFAULT_STUDIO); }, [profile.id, profile.studio]);

  // Deep link: "open profile studio" opens straight to the video chooser.
  useEffect(() => {
    if (!openSheet || !isSelf) return;
    setSheet(openSheet);
    onSheetConsumed?.();
  }, [openSheet, isSelf, onSheetConsumed]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setSheet(null); };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); clearTimeout(toastTimer.current); clearTimeout(saveTimer.current); };
  }, []);

  const say = (m) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  };

  // ---- look (theme / background / dim / blur): debounced save ----
  const changeLook = (patch) => {
    const next = { ...studio, ...patch };
    setStudio(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await api.setStudio(next);
        onUpdated(res.user);
      } catch (err) { say(err.message || 'Could not save your look.'); }
    }, 450);
  };

  // ---- photo / video ----
  const run = async (fn, okMsg) => {
    setBusy(true);
    try { const res = await fn(); onUpdated(res.user); say(okMsg); setSheet(null); }
    catch (err) { say(err.message || 'Something went wrong.'); }
    finally { setBusy(false); }
  };

  const uploadFile = async (file) => {
    if (!file) return;
    if (PHOTO_TYPES.includes(file.type)) {
      if (file.size > MAX_PHOTO_BYTES) return say('Photos must be under 8MB.');
      return run(() => api.uploadAvatarPhoto(file), 'Profile photo updated');
    }
    if (VIDEO_TYPES.includes(file.type)) {
      if (file.size > MAX_VIDEO_BYTES) return say(`Videos must be under ${MAX_VIDEO_BYTES / (1024 * 1024)}MB.`);
      const d = await measureVideo(file);
      if (d !== null && d > MAX_VIDEO_SECONDS + 0.5) return say(`That video is ${d.toFixed(1)}s. Trim it to ${MAX_VIDEO_SECONDS}s or less.`);
      const cover = await captureCover(file);
      const coverFile = cover ? new File([cover], 'cover.jpg', { type: 'image/jpeg' }) : null;
      return run(() => api.uploadProfileVideo(file, coverFile, true), 'Profile video updated');
    }
    say('Choose a .jpg/.png/.webp photo or an .mp4/.webm/.mov video.');
  };

  const pickPreset = (i) => run(async () => {
    const [vb, tb] = await Promise.all([fetch(clipUrl(i)).then(r => r.blob()), fetch(thumbUrl(i)).then(r => r.blob())]);
    const video = new File([vb], `studio-clip-${i}.mp4`, { type: 'video/mp4' });
    const cover = new File([tb], 'cover.jpg', { type: 'image/jpeg' });
    return api.uploadProfileVideo(video, cover, true);
  }, 'Profile video updated');

  const useColorOnly = () => run(() => api.setProfileDisplayMode('color'), 'Showing your color avatar');
  const switchMode = (mode) => run(() => api.setProfileDisplayMode(mode), mode === 'photo' ? 'Showing your photo' : 'Showing your video');

  // ---- name / bio (inline) ----
  const saveName = async () => {
    const el = nameRef.current; if (!el) return;
    const v = el.textContent.trim();
    if (!v) { el.textContent = profile.displayName; return; }
    if (v === profile.displayName) return;
    try { const res = await api.updateMe({ displayName: v }); onUpdated(res.user); say('Name saved'); }
    catch (err) { el.textContent = profile.displayName; say(err.message); }
  };
  const saveBio = async () => {
    const el = bioRef.current; if (!el) return;
    const v = el.textContent.trim();
    if (v === (profile.bio || '')) return;
    try { const res = await api.updateMe({ bio: v }); onUpdated(res.user); say('Bio saved'); }
    catch (err) { el.textContent = profile.bio || ''; say(err.message); }
  };

  // ---- derived visuals ----
  const t = THEMES[studio.theme] || THEMES[0];
  const vars = {
    '--ps-bg': t[1], '--ps-panel': t[2], '--ps-ink': t[3], '--ps-mute': t[4], '--ps-ac': t[5], '--ps-acink': t[6],
    '--ps-dim': studio.dim / 100, '--ps-blur': `${studio.blur}px`,
  };
  const hasVideo = profile.displayMode === 'video' && profile.profileVideoUrl;
  const hasPhoto = profile.displayMode === 'photo' && profile.avatarPhotoUrl;

  const bgLayer = useMemo(() => {
    const { kind, value } = studio.bg;
    if (kind === 'grad') return { style: { background: GRADS[value] || GRADS[0] } };
    if (kind === 'color') return { style: { background: value } };
    if (kind === 'clip') return { media: { kind: 'video', src: clipUrl(value) } };
    if (kind === 'profile') {
      if (profile.profileVideoUrl) return { media: { kind: 'video', src: profile.profileVideoUrl, poster: profile.profileVideoCoverUrl } };
      if (profile.avatarPhotoUrl) return { media: { kind: 'image', src: profile.avatarPhotoUrl } };
    }
    return { style: {} };
  }, [studio.bg, profile.profileVideoUrl, profile.profileVideoCoverUrl, profile.avatarPhotoUrl]);

  const initial = (profile.displayName || '?').trim().charAt(0).toUpperCase();
  const avatarInner = hasVideo
    ? <Media kind="video" src={profile.profileVideoUrl} poster={profile.profileVideoCoverUrl} muted={profile.profileVideoMuted !== false} />
    : hasPhoto ? <Media kind="image" src={profile.avatarPhotoUrl} />
    : <span style={{ color: 'var(--ps-ac)' }}>{initial}</span>;

  const bgSel = (k, v) => studio.bg.kind === k && (v === undefined || studio.bg.value === v);

  return (
    <div className="ps-root" style={vars}>
      <div className="ps-hero">
        <div className="ps-bg" style={bgLayer.style}>
          {bgLayer.media && <Media className="ps-bgm" {...bgLayer.media} />}
          <div className="ps-bgdim" />
        </div>

        {isSelf && (
          <div className="ps-top">
            <button className="ps-pill" onClick={() => setSheet('look')}>Customize</button>
            <button className="ps-pill" onClick={onOpenSettings}>⚙ Settings</button>
          </div>
        )}

        <div className="ps-card">
          {isSelf ? (
            <button className="ps-av" onClick={() => setSheet('video')} aria-label="Change profile photo or video">
              <div className="ps-avbox">{avatarInner}</div><span className="ps-badge">Edit</span>
            </button>
          ) : (
            <div className="ps-av ps-static"><div className="ps-avbox">{avatarInner}</div></div>
          )}

          <h1 ref={nameRef} className="ps-name" contentEditable={isSelf} suppressContentEditableWarning spellCheck={false}
            onBlur={saveName} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}>
            {profile.displayName}
          </h1>
          <div className="ps-handle">@{profile.username}</div>
          <p ref={bioRef} className="ps-bio" contentEditable={isSelf} suppressContentEditableWarning spellCheck={false}
            data-empty={isSelf && !profile.bio ? 'Tap here to write a short bio.' : undefined} onBlur={saveBio}>
            {profile.bio}
          </p>

          <div className="ps-stats">
            <span><b>{profile.postCount}</b> posts</span>
            <span><b>{profile.followerCount}</b> followers</span>
            <span><b>{profile.followingCount}</b> following</span>
          </div>

          {isSelf && (
            <div className="ps-row">
              <button className="ps-btn" onClick={() => setSheet('video')}>Profile video</button>
              <button className="ps-btn ghost" onClick={() => setSheet('look')}>Theme and background</button>
            </div>
          )}
          {children}
        </div>
      </div>

      {sheet && (
        <div className="ps-sh" onClick={e => { if (e.target === e.currentTarget) setSheet(null); }}>
          <div className="ps-sp" role="dialog" aria-label={sheet === 'video' ? 'Profile video' : 'Customize'}>
            <div className="ps-hd">
              <h2>{sheet === 'video' ? 'Profile photo & video' : 'Customize'}</h2>
              <button className="ps-x" onClick={() => setSheet(null)} aria-label="Close">✕</button>
            </div>

            {sheet === 'video' && (
              <>
                {(profile.avatarPhotoUrl || profile.profileVideoUrl) && (
                  <div className="ps-row" style={{ justifyContent: 'flex-start', marginBottom: 6 }}>
                    <span className="ps-mini">Showing:</span>
                    <button className={`ps-chip${profile.displayMode === 'color' ? ' sel' : ''}`} disabled={busy} onClick={useColorOnly}>Color</button>
                    {profile.avatarPhotoUrl && <button className={`ps-chip${profile.displayMode === 'photo' ? ' sel' : ''}`} disabled={busy} onClick={() => switchMode('photo')}>Photo</button>}
                    {profile.profileVideoUrl && <button className={`ps-chip${profile.displayMode === 'video' ? ' sel' : ''}`} disabled={busy} onClick={() => switchMode('video')}>Video</button>}
                  </div>
                )}
                <div className="ps-grid">
                  <label className="ps-t add">
                    <span>＋<br />Add photo or video</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" disabled={busy}
                      onChange={e => { uploadFile(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                  <button className={`ps-t${profile.displayMode === 'color' ? ' sel' : ''}`} disabled={busy} onClick={useColorOnly}>No video</button>
                  {profile.avatarPhotoUrl && (
                    <button className={`ps-t${profile.displayMode === 'photo' ? ' sel' : ''}`} disabled={busy} onClick={() => switchMode('photo')} aria-label="Your photo">
                      <img src={profile.avatarPhotoUrl} alt="" />
                    </button>
                  )}
                  {Array.from({ length: PRESET_COUNT }, (_, k) => k + 1).map(i => (
                    <button key={i} className="ps-t" disabled={busy} onClick={() => pickPreset(i)} aria-label={`Clip ${i}`}>
                      <img src={thumbUrl(i)} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
                <p className="ps-mini" style={{ marginTop: 12 }}>
                  Photos: jpg/png/webp under 8MB. Videos: mp4/webm/mov, {MAX_VIDEO_SECONDS}s max, under {MAX_VIDEO_BYTES / (1024 * 1024)}MB.
                  {busy ? ' Saving…' : ' Saved for everyone as soon as you pick.'}
                </p>
                {profile.profileVideoUrl && <div className="ps-row" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                  <button className="ps-btn ghost" disabled={busy} onClick={() => run(() => api.deleteProfileVideo(), 'Profile video removed')}>Remove my video</button>
                  {profile.avatarPhotoUrl && <button className="ps-btn ghost" disabled={busy} onClick={() => run(() => api.deleteAvatarPhoto(), 'Profile photo removed')}>Remove my photo</button>}
                </div>}
              </>
            )}

            {sheet === 'look' && (
              <>
                <h3>Theme</h3>
                <div className="ps-sw">
                  {THEMES.map((th, i) => (
                    <button key={th[0]} className={`ps-dot${studio.theme === i ? ' sel' : ''}`} title={th[0]} aria-label={`${th[0]} theme`}
                      style={{ '--a': th[2], '--b': th[5] }} onClick={() => changeLook({ theme: i })} />
                  ))}
                </div>
                <h3>Background color</h3>
                <div className="ps-sw">
                  <button className={`ps-g${bgSel('theme') ? ' sel' : ''}`} style={{ '--g': 'var(--ps-bg)' }} aria-label="Match theme" onClick={() => changeLook({ bg: { kind: 'theme', value: null } })} />
                  {GRADS.map((g, i) => (
                    <button key={i} className={`ps-g${bgSel('grad', i) ? ' sel' : ''}`} style={{ '--g': g }} aria-label={`Gradient ${i + 1}`} onClick={() => changeLook({ bg: { kind: 'grad', value: i } })} />
                  ))}
                  <input type="color" className="ps-color" aria-label="Pick any color" value={studio.bg.kind === 'color' ? studio.bg.value : '#6a4cff'}
                    onChange={e => changeLook({ bg: { kind: 'color', value: e.target.value } })} />
                </div>
                <h3>Background video</h3>
                <div className="ps-grid">
                  {Array.from({ length: PRESET_COUNT }, (_, k) => k + 1).map(i => (
                    <button key={i} className={`ps-t${bgSel('clip', i) ? ' sel' : ''}`} aria-label={`Background clip ${i}`} onClick={() => changeLook({ bg: { kind: 'clip', value: i } })}>
                      <img src={thumbUrl(i)} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
                <div className="ps-row" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
                  <button className="ps-btn ghost" onClick={() => {
                    if (!profile.profileVideoUrl && !profile.avatarPhotoUrl) return say('Add a profile photo or video first');
                    changeLook({ bg: { kind: 'profile', value: null } });
                  }}>Use profile video as background</button>
                </div>
                <h3>Adjust</h3>
                <label className="ps-sl">Dim<input type="range" min="0" max="90" value={studio.dim} onChange={e => changeLook({ dim: +e.target.value })} /></label>
                <label className="ps-sl">Blur<input type="range" min="0" max="24" value={studio.blur} onChange={e => changeLook({ blur: +e.target.value })} /></label>
              </>
            )}
          </div>
        </div>
      )}
      <div className={`ps-toast${toast ? ' on' : ''}`} role="status">{toast}</div>
    </div>
  );
}
