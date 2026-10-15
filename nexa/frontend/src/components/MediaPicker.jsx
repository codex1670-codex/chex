import { useEffect, useRef, useState } from 'react';
import EditedMedia from './EditedMedia.jsx';
import PhotoEditor from './PhotoEditor.jsx';
import VideoEditor from './VideoEditor.jsx';
import { defaultEdits, fileKind, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, playedSeconds } from '../editSettings.js';

// Pick a photo/video from the device and optionally edit it before posting. Covers all the
// ways a file reaches a browser:
//   • "Choose file"  — gallery / camera roll / any downloaded file (native file picker)
//   • "Camera"       — opens the camera directly on phones (capture attribute)
//   • drag & drop    — drop a downloaded file straight onto the box on desktop
//
// Controlled via `value` = { file, kind, edits, originalFile, duration } | null.
//   allow            ['image','video'] or ['video']
//   maxPlaySeconds   cap on playback length for videos (stories = 30). The editor clamps the
//                    trim to it, and a longer video is auto-trimmed so it's valid immediately.
export default function MediaPicker({ value, onChange, allow = ['image', 'video'], maxPlaySeconds, maxVideoBytes = MAX_VIDEO_BYTES, disabled }) {
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState(null);
  const fileRef = useRef(null);
  const camRef = useRef(null);

  // One object URL per current file; revoked when replaced/unmounted.
  useEffect(() => {
    if (!value?.file) { setUrl(null); return undefined; }
    const u = URL.createObjectURL(value.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value?.file]);

  const accept = allow.includes('image')
    ? 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov'
    : 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov';
  const acceptCam = allow.includes('image') ? 'image/*,video/*' : 'video/*';

  const choose = (file) => {
    setError('');
    if (!file) return;
    const kind = fileKind(file);
    if (!kind || !allow.includes(kind)) {
      setError(allow.includes('image') ? 'Choose a photo (.jpg/.png/.webp/.gif) or a video (.mp4/.webm/.mov).' : 'Choose a video (.mp4/.webm/.mov).');
      return;
    }
    if (kind === 'image' && file.size > MAX_IMAGE_BYTES) { setError(`That photo is too large — photos must be under ${MAX_IMAGE_BYTES / 1048576}MB.`); return; }
    if (kind === 'video' && file.size > maxVideoBytes) { setError(`That video is too large — videos must be under ${Math.round(maxVideoBytes / 1048576)}MB.`); return; }
    onChange({ file, originalFile: file, kind, edits: kind === 'video' ? defaultEdits() : null, duration: 0 });
  };

  // Learn the real duration from the browser, and auto-trim anything over the limit so the
  // person never hits a server rejection for an over-long clip.
  const onDuration = (d) => {
    if (!value || value.kind !== 'video' || !Number.isFinite(d)) return;
    let edits = value.edits;
    if (maxPlaySeconds && playedSeconds(edits, d) > maxPlaySeconds + 0.01) {
      edits = { ...edits, trimEnd: Math.min(d, (edits.trimStart || 0) + maxPlaySeconds * (edits.speed || 1)) };
      setError(`This video is ${d.toFixed(0)}s — it's been trimmed to the first ${maxPlaySeconds}s. Use Edit to pick a different part.`);
    }
    onChange({ ...value, duration: d, edits });
  };

  const onDrop = (ev) => {
    ev.preventDefault(); setDragOver(false);
    if (!disabled) choose(ev.dataTransfer.files?.[0]);
  };

  const clear = () => { setError(''); onChange(null); if (fileRef.current) fileRef.current.value = ''; if (camRef.current) camRef.current.value = ''; };

  if (!value?.file) {
    return (
      <div
        className={`me-drop${dragOver ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
      >
        <div style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 10 }}>
          {allow.includes('image') ? 'Add a photo or video' : 'Add a video'} — from your gallery, camera, or a downloaded file. You can also drag a file here.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn-ghost" disabled={disabled} onClick={() => fileRef.current?.click()}>📁 Choose file</button>
          <button type="button" className="btn-ghost" disabled={disabled} onClick={() => camRef.current?.click()}>📷 Camera</button>
        </div>
        <input ref={fileRef} type="file" accept={accept} hidden onChange={e => choose(e.target.files?.[0])} />
        <input ref={camRef} type="file" accept={acceptCam} capture="environment" hidden onChange={e => choose(e.target.files?.[0])} />
        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    );
  }

  const isVideo = value.kind === 'video';
  const edited = isVideo ? JSON.stringify(value.edits) !== JSON.stringify(defaultEdits()) : value.file !== value.originalFile;

  return (
    <div className="me-picked">
      {url && (
        <EditedMedia
          src={url} type={value.kind} edits={value.edits} controls={isVideo} muted fit="contain" onDuration={onDuration}
          style={{ width: '100%', maxHeight: 320, background: '#000', borderRadius: 12 }}
        />
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn-ghost" disabled={disabled} onClick={() => setEditing(true)}>✏️ Edit {isVideo ? 'video' : 'photo'}</button>
        {!isVideo && edited && <button type="button" className="btn-ghost" disabled={disabled} onClick={() => onChange({ ...value, file: value.originalFile })}>↺ Undo edits</button>}
        {isVideo && edited && <button type="button" className="btn-ghost" disabled={disabled} onClick={() => onChange({ ...value, edits: defaultEdits() })}>↺ Undo edits</button>}
        <button type="button" className="btn-ghost" disabled={disabled} onClick={() => fileRef.current?.click()}>Replace</button>
        <button type="button" className="btn-ghost" style={{ color: 'var(--pink-ink)' }} disabled={disabled} onClick={clear}>Remove</button>
        {edited && <span style={{ fontSize: 12, color: 'var(--teal-ink)' }}>Edited ✓</span>}
        <input ref={fileRef} type="file" accept={accept} hidden onChange={e => choose(e.target.files?.[0])} />
      </div>
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}

      {editing && !isVideo && (
        <PhotoEditor src={url} onCancel={() => setEditing(false)} onDone={(file) => { onChange({ ...value, file }); setEditing(false); }} />
      )}
      {editing && isVideo && (
        <VideoEditor src={url} initialEdits={value.edits} maxPlaySeconds={maxPlaySeconds} onCancel={() => setEditing(false)}
          onDone={(edits) => { onChange({ ...value, edits }); setEditing(false); setError(''); }} />
      )}
    </div>
  );
}
