import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import EditedMedia from './EditedMedia.jsx';
import PhotoEditor from './PhotoEditor.jsx';
import VideoEditor from './VideoEditor.jsx';
import { fileKind, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_STORY_SECONDS } from '../editSettings.js';

const DURATION_MS = 5000; // text + photo stories; videos run for their own (trimmed) length

// Owner-only editor shown over the viewer: caption/text, audience, and for media stories the
// photo/video editors or a replacement file. Saves go straight to the API.
function StoryEditor({ story, onSaved, onCancel }) {
  const isText = story.mediaType === 'text';
  const [caption, setCaption] = useState(isText ? story.content : story.caption || '');
  const [audience, setAudience] = useState(story.audience);
  const [editor, setEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const canEditPixels = story.mediaType === 'image' && story.content.startsWith('/uploads/');

  const run = async (fn) => {
    setBusy(true); setError('');
    try { onSaved((await fn()).story); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const pickReplacement = (file) => {
    if (!file) return;
    const kind = fileKind(file);
    if (!kind) return setError('Choose a photo or video file.');
    if (file.size > (kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) return setError('That file is too large.');
    run(() => api.replaceStoryMedia(story.id, file));
  };

  return (
    <div className="me-overlay" style={{ zIndex: 120 }}>
      <div className="me-modal" style={{ maxWidth: 420 }}>
        <div className="me-head"><strong>Edit story</strong><span style={{ flex: 1 }} /><button className="btn-ghost" onClick={onCancel}>Close</button></div>
        <div style={{ padding: 16 }}>
          <div className="field">
            <label>{isText ? 'Text' : 'Caption'}</label>
            <input value={caption} maxLength={200} onChange={e => setCaption(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {['everyone', 'followers', 'close_friends'].map(a => (
              <button key={a} type="button" onClick={() => setAudience(a)}
                style={{ padding: '6px 12px', borderRadius: 999, fontSize: 12.5, border: '1px solid var(--border-soft)', background: audience === a ? 'var(--violet)' : 'transparent', color: audience === a ? 'white' : 'var(--text-mid)', cursor: 'pointer' }}>
                {a.replace('_', ' ')}
              </button>
            ))}
          </div>
          {!isText && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {(story.mediaType === 'video' || canEditPixels) && <button className="btn-ghost" disabled={busy} onClick={() => setEditor(true)}>✏️ Edit {story.mediaType === 'video' ? 'video' : 'photo'}</button>}
              <button className="btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>Replace file</button>
              <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov"
                onChange={e => { pickReplacement(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          )}
          {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
          <button className="btn-primary" disabled={busy || (isText && !caption.trim())}
            onClick={() => run(() => api.editStory(story.id, { caption, audience }))}>{busy ? 'Saving…' : 'Save changes'}</button>
          <div className="me-hint" style={{ marginTop: 8 }}>Editing doesn't restart the 24-hour timer.</div>
        </div>
      </div>
      {editor && story.mediaType === 'image' && (
        <PhotoEditor src={story.content} onCancel={() => setEditor(false)}
          onDone={(file) => { setEditor(false); run(() => api.replaceStoryMedia(story.id, file)); }} />
      )}
      {editor && story.mediaType === 'video' && (
        <VideoEditor src={story.content} initialEdits={story.edits} maxPlaySeconds={MAX_STORY_SECONDS} onCancel={() => setEditor(false)}
          onDone={(edits) => { setEditor(false); run(() => api.editStory(story.id, { edits })); }} />
      )}
    </div>
  );
}

export default function StoryViewer({ group, isMine, onClose }) {
  const [stories, setStories] = useState(group.stories);
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [viewers, setViewers] = useState(null);
  const [editing, setEditing] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const timerRef = useRef(null);
  const videoRef = useRef(null);
  const story = stories[index];
  const isVideo = story.mediaType === 'video' && !mediaFailed;

  const goNext = () => {
    if (index < stories.length - 1) setIndex(i => i + 1);
    else onClose();
  };
  const goPrev = () => { if (index > 0) setIndex(i => i - 1); };

  // Per-story reset: record the view and clear any earlier load failure.
  useEffect(() => {
    api.getStory(story.id); // records the view server-side
    setViewers(null);
    setMediaFailed(false);
  }, [story.id]);

  // Timer-driven stories (text/photo, or a video that failed to load). Playable video stories
  // drive their own progress from playback instead, so no timer runs for them.
  useEffect(() => {
    setProgress(0);
    if (isVideo || editing) return undefined;
    const start = Date.now();
    timerRef.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - start) / DURATION_MS) * 100);
      setProgress(pct);
      if (pct >= 100) { clearInterval(timerRef.current); goNext(); }
    }, 50);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line
  }, [index, story.id, story.mediaType, isVideo, editing]);

  // Start video with sound (opening a story was a user gesture); if the browser still blocks
  // it, fall back to muted rather than showing a frozen frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!isVideo || !v || editing) { v?.pause(); return; }
    v.currentTime = story.edits?.trimStart || 0;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  }, [story.id, story.content, isVideo, editing]); // eslint-disable-line

  const loadViewers = async () => setViewers((await api.storyViewers(story.id)).viewers);
  const remove = async () => { await api.deleteStory(story.id); onClose(); };

  const onSaved = (updated) => {
    setStories(list => list.map(s => (s.id === updated.id ? { ...s, ...updated } : s)));
    setEditing(false);
  };

  const bg = story.mediaType === 'text' ? (story.background || '#7C5CFF') : '#000';
  const mediaProps = { src: story.content, edits: story.edits, fit: 'contain', onError: () => setMediaFailed(true), style: { position: 'absolute', inset: 0 } };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,10,0.92)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 340, maxWidth: '92vw', height: 560, maxHeight: '85vh', borderRadius: 20, overflow: 'hidden', position: 'relative', background: bg, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 4, padding: '10px 12px', zIndex: 2 }}>
          {stories.map((s, i) => (
            <div key={s.id} style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.3)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${i < index ? 100 : i === index ? progress : 0}%`, background: 'white', transition: 'width 0.1s linear' }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px 10px', color: 'white', zIndex: 2 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>{group.author.displayName}</div>
          <div style={{ fontSize: 12, opacity: 1 }}>{new Date(story.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'white', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: story.mediaType === 'text' ? 24 : 0, position: 'relative' }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (e.clientX - rect.left < rect.width / 2) goPrev(); else goNext();
          }}
        >
          {story.mediaType === 'text' && (
            <div style={{ color: 'white', fontSize: 22, fontWeight: 600, textAlign: 'center', lineHeight: 1.4, fontFamily: 'var(--font-display)' }}>{story.content}</div>
          )}
          {story.mediaType === 'image' && !mediaFailed && <EditedMedia {...mediaProps} type="image" />}
          {isVideo && (
            <EditedMedia {...mediaProps} type="video" videoRef={videoRef} loop={false}
              onProgress={(f) => setProgress(f * 100)} onEnded={goNext} />
          )}
          {story.mediaType !== 'text' && mediaFailed && (
            <div style={{ color: 'white', fontSize: 13, textAlign: 'center', padding: 24 }}>Couldn't load this {story.mediaType}.</div>
          )}
          {story.mediaType !== 'text' && story.caption && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 14, padding: '0 16px', textAlign: 'center', color: 'white', fontSize: 15, fontWeight: 600, textShadow: '0 1px 4px rgba(0,0,0,0.8)', pointerEvents: 'none' }}>
              <span style={{ background: 'rgba(0,0,0,0.45)', borderRadius: 8, padding: '4px 10px', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }}>{story.caption}</span>
            </div>
          )}
        </div>

        <div style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.35)', zIndex: 2 }}>
          <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.8)' }}>{story.viewCount} view{story.viewCount === 1 ? '' : 's'}</div>
          {isMine && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={(e) => { e.stopPropagation(); setEditing(true); }}>Edit</button>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={(e) => { e.stopPropagation(); loadViewers(); }}>Viewers</button>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--pink-ink)' }} onClick={(e) => { e.stopPropagation(); remove(); }}>Delete</button>
            </div>
          )}
        </div>

        {viewers && (
          <div style={{ position: 'absolute', bottom: 50, left: 0, right: 0, maxHeight: 160, overflowY: 'auto', background: 'rgba(10,8,18,0.95)', padding: 10, zIndex: 3 }}>
            {viewers.length === 0 && <div style={{ color: 'var(--text-low)', fontSize: 12.5 }}>No views yet.</div>}
            {viewers.map(v => (
              <div key={v.id} style={{ color: 'white', fontSize: 13, padding: '4px 0' }}>{v.displayName} · @{v.username}</div>
            ))}
          </div>
        )}
      </div>
      {editing && <StoryEditor story={story} onSaved={onSaved} onCancel={() => setEditing(false)} />}
    </div>
  );
}
