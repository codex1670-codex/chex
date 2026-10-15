import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 40;

// Section 127 (Profile Photo) + Section 128 (10-second Profile Video). Crop/zoom/rotate
// for the photo aren't implemented here — those are pure client-side canvas editing with
// no server-side dependency, left for a follow-up pass. What's real: actual file upload,
// actual client-side duration measurement (not a guess), an actual captured cover frame,
// and a real mute-on-playback preference.
export default function ProfileMediaEditor({ profile, onUpdated }) {
  const [tab, setTab] = useState('photo'); // 'photo' | 'video'

  // Photo state
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoError, setPhotoError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);

  // Video state
  const [videoFile, setVideoFile] = useState(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [coverTime, setCoverTime] = useState(0);
  const [coverDataUrl, setCoverDataUrl] = useState(null);
  const [muted, setMutedPref] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [videoBusy, setVideoBusy] = useState(false);
  const [modeError, setModeError] = useState('');
  const videoElRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);
  useEffect(() => () => { if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl); }, [videoPreviewUrl]);

  const onChoosePhoto = (f) => {
    setPhotoError('');
    if (!f) { setPhotoFile(null); setPhotoPreview(null); return; }
    if (!ALLOWED_IMAGE_TYPES.includes(f.type)) { setPhotoError('Choose a .jpg, .png, or .webp image.'); return; }
    if (f.size > MAX_PHOTO_BYTES) { setPhotoError(`Too large — photos must be under ${MAX_PHOTO_BYTES / (1024 * 1024)}MB.`); return; }
    setPhotoFile(f);
    setPhotoPreview(URL.createObjectURL(f));
  };

  const uploadPhoto = async () => {
    if (!photoFile) return;
    setPhotoBusy(true);
    setPhotoError('');
    try {
      const res = await api.uploadAvatarPhoto(photoFile);
      onUpdated(res.user);
      setPhotoFile(null); setPhotoPreview(null);
    } catch (err) {
      setPhotoError(err.message);
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    const res = await api.deleteAvatarPhoto();
    onUpdated(res.user);
  };

  const onChooseVideo = (f) => {
    setVideoError('');
    setCoverDataUrl(null);
    if (!f) { setVideoFile(null); setVideoPreviewUrl(null); return; }
    if (!ALLOWED_VIDEO_TYPES.includes(f.type)) { setVideoError('Choose an .mp4, .webm, or .mov file.'); return; }
    if (f.size > MAX_VIDEO_BYTES) { setVideoError(`Too large — under ${MAX_VIDEO_BYTES / (1024 * 1024)}MB.`); return; }
    setVideoFile(f);
    setVideoPreviewUrl(URL.createObjectURL(f));
  };

  // Real duration check — reads the browser's own metadata for the file just chosen,
  // not an assumption. This is the actual "Trim to ≤40 seconds" enforcement; the server
  // only double-checks it if ffprobe happens to be installed (see uploads.js).
  const onLoadedMetadata = () => {
    const d = videoElRef.current?.duration || 0;
    setDuration(d);
    if (d > MAX_VIDEO_SECONDS + 0.5) {
      setVideoError(`This video is ${d.toFixed(1)}s long — trim it to ${MAX_VIDEO_SECONDS} seconds or under before uploading.`);
    } else {
      setVideoError('');
    }
    const t = Math.min(1, d / 2);
    setCoverTime(t);
    if (videoElRef.current) videoElRef.current.currentTime = t;
  };

  // "Choose cover frame" — captures whatever frame the scrubber lands on, via canvas,
  // once the browser has actually finished seeking to it (onSeeked, not onChange, so we
  // don't draw a stale frame mid-seek).
  const captureCover = () => {
    const v = videoElRef.current, c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    setCoverDataUrl(c.toDataURL('image/jpeg', 0.85));
  };

  const uploadVideo = async () => {
    if (!videoFile) return;
    if (duration > MAX_VIDEO_SECONDS + 0.5) { setVideoError(`Trim the video to ${MAX_VIDEO_SECONDS} seconds or under first.`); return; }
    setVideoBusy(true);
    setVideoError('');
    try {
      let coverFile = null;
      if (coverDataUrl) {
        const blob = await (await fetch(coverDataUrl)).blob();
        coverFile = new File([blob], 'cover.jpg', { type: 'image/jpeg' });
      }
      const res = await api.uploadProfileVideo(videoFile, coverFile, muted);
      onUpdated(res.user);
      setVideoFile(null); setVideoPreviewUrl(null); setCoverDataUrl(null);
    } catch (err) {
      setVideoError(err.message);
    } finally {
      setVideoBusy(false);
    }
  };

  const removeVideo = async () => {
    const res = await api.deleteProfileVideo();
    onUpdated(res.user);
  };

  const switchMode = async (mode) => {
    setModeError('');
    try {
      const res = await api.setProfileDisplayMode(mode);
      onUpdated(res.user);
    } catch (err) {
      setModeError(err.message);
    }
  };

  return (
    <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, marginBottom: 10 }}>Profile photo &amp; video</div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-low)', textTransform: 'uppercase', letterSpacing: '0.05em', alignSelf: 'center' }}>Showing:</span>
        {['color', 'photo', 'video'].map(m => (
          <button key={m} className="btn-ghost" style={{ padding: '4px 12px', fontSize: 12, width: 'auto', background: profile.displayMode === m ? 'var(--surface-hover)' : 'transparent' }}
            onClick={() => switchMode(m)}>
            {m === 'color' ? '🎨 Color' : m === 'photo' ? '🖼 Photo' : '🎬 Video'}
          </button>
        ))}
      </div>
      {modeError && <div className="error-banner" style={{ marginBottom: 10 }}>{modeError}</div>}

      <div style={{ display: 'flex', gap: 8, margin: '14px 0 12px' }}>
        <button className="btn-ghost" style={{ padding: '5px 14px', fontSize: 12.5, background: tab === 'photo' ? 'var(--surface-hover)' : 'transparent' }} onClick={() => setTab('photo')}>Profile photo</button>
        <button className="btn-ghost" style={{ padding: '5px 14px', fontSize: 12.5, background: tab === 'video' ? 'var(--surface-hover)' : 'transparent' }} onClick={() => setTab('video')}>Profile video</button>
      </div>

      {tab === 'photo' && (
        <div>
          {profile.avatarPhotoUrl && !photoPreview && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <img src={profile.avatarPhotoUrl} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />
              <button className="btn-ghost" onClick={removePhoto}>Remove photo</button>
            </div>
          )}
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => onChoosePhoto(e.target.files?.[0] || null)} />
          {photoPreview && (
            <div style={{ marginTop: 10 }}>
              <img src={photoPreview} alt="" style={{ width: 96, height: 96, borderRadius: '50%', objectFit: 'cover' }} />
              <div style={{ marginTop: 8 }}>
                <button className="btn-primary" style={{ width: 'auto', padding: '7px 16px' }} disabled={photoBusy} onClick={uploadPhoto}>{photoBusy ? 'Uploading…' : 'Save photo'}</button>
              </div>
            </div>
          )}
          {photoError && <div className="error-banner" style={{ marginTop: 8 }}>{photoError}</div>}
        </div>
      )}

      {tab === 'video' && (
        <div>
          {profile.profileVideoUrl && !videoPreviewUrl && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <video src={profile.profileVideoUrl} poster={profile.profileVideoCoverUrl || undefined} muted={profile.profileVideoMuted} loop autoPlay playsInline
                style={{ width: 100, height: 100, borderRadius: 14, objectFit: 'cover', background: '#000' }} />
              <button className="btn-ghost" onClick={removeVideo}>Remove video</button>
            </div>
          )}
          <label style={{ fontSize: 12.5, color: 'var(--text-mid)', display: 'block', marginBottom: 6 }}>
            Camera roll, gallery, or a downloaded file — .mp4/.webm/.mov, {MAX_VIDEO_SECONDS}s max, under {MAX_VIDEO_BYTES / (1024 * 1024)}MB
          </label>
          <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={e => onChooseVideo(e.target.files?.[0] || null)} />

          {videoPreviewUrl && (
            <div style={{ marginTop: 12 }}>
              <video
                ref={videoElRef} src={videoPreviewUrl} controls
                onLoadedMetadata={onLoadedMetadata} onSeeked={captureCover}
                style={{ width: '100%', maxHeight: 260, borderRadius: 10, background: '#000' }}
              />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              {duration > 0 && (
                <div style={{ marginTop: 10 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-mid)' }}>Choose cover frame ({coverTime.toFixed(1)}s / {duration.toFixed(1)}s)</label>
                  <input type="range" min={0} max={duration} step={0.1} value={coverTime}
                    onChange={e => { const t = parseFloat(e.target.value); setCoverTime(t); if (videoElRef.current) videoElRef.current.currentTime = t; }}
                    style={{ width: '100%' }} />
                </div>
              )}
              {coverDataUrl && (
                <div style={{ marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-mid)' }}>Cover: </span>
                  <img src={coverDataUrl} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', verticalAlign: 'middle' }} />
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12.5, color: 'var(--text-mid)' }}>
                <input type="checkbox" checked={muted} onChange={e => setMutedPref(e.target.checked)} />
                Mute this video's audio when it plays on my profile
              </label>
              {videoError && <div className="error-banner" style={{ marginTop: 8 }}>{videoError}</div>}
              <div style={{ marginTop: 10 }}>
                <button className="btn-primary" style={{ width: 'auto', padding: '7px 16px' }} disabled={videoBusy || duration > MAX_VIDEO_SECONDS + 0.5} onClick={uploadVideo}>
                  {videoBusy ? 'Uploading…' : 'Save video'}
                </button>
              </div>
            </div>
          )}
          {!videoPreviewUrl && videoError && <div className="error-banner" style={{ marginTop: 8 }}>{videoError}</div>}
        </div>
      )}
    </div>
  );
}
