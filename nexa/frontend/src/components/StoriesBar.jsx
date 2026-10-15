import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { useAuth } from '../AuthContext.jsx';
import StoryViewer from './StoryViewer.jsx';
import MediaPicker from './MediaPicker.jsx';
import { MAX_STORY_SECONDS } from '../editSettings.js';

export default function StoriesBar() {
  const { user } = useAuth();
  const [groups, setGroups] = useState(null);
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState('');
  const [audience, setAudience] = useState('everyone');
  const [viewingGroup, setViewingGroup] = useState(null);
  const [kind, setKind] = useState('text');   // 'text' | 'media'
  const [media, setMedia] = useState(null);
  const [mediaCaption, setMediaCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.storiesFeed().then(res => setGroups(res.groups));
  useEffect(() => { load(); }, []);

  const reset = () => { setText(''); setMedia(null); setMediaCaption(''); setError(''); setKind('text'); setComposing(false); };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (kind === 'media') {
      if (!media) { setError('Choose a photo or video first.'); return; }
      setBusy(true);
      try {
        await api.uploadStory(media.file, { caption: mediaCaption.trim(), audience }, media.kind === 'video' ? media.edits : undefined);
        reset(); load();
      } catch (err) { setError(err.message); } finally { setBusy(false); }
      return;
    }
    if (!text.trim()) return;
    await api.createStory({ mediaType: 'text', content: text.trim(), audience, background: '#7C5CFF' });
    reset(); load();
  };

  if (groups === null) return null;
  const myGroup = groups.find(g => g.author.id === user.id);

  return (
    <>
      <div className="notes-row">
        <div className="note-card" onClick={() => setComposing(true)}>
          <div className="note-avatar-ring" style={{ background: myGroup ? 'linear-gradient(135deg, var(--violet), var(--pink))' : 'rgba(255,255,255,0.1)' }}>
            <Avatar user={user} size={52} />
          </div>
          <div className="label">{myGroup ? 'Your story' : 'Add story'}</div>
        </div>
        {groups.filter(g => g.author.id !== user.id).map(g => (
          <div className="note-card" key={g.author.id} onClick={() => setViewingGroup(g)}>
            <div className="note-avatar-ring">
              <Avatar user={g.author} size={52} />
            </div>
            <div className="label">{g.author.displayName}</div>
          </div>
        ))}
        {myGroup && (
          <div className="note-card" onClick={() => setViewingGroup(myGroup)}>
            <div className="note-avatar-ring"><Avatar user={user} size={52} /></div>
            <div className="label">View yours</div>
          </div>
        )}
      </div>

      {composing && (
        <form className="glass-card" style={{ padding: 16, marginBottom: 16 }} onSubmit={submit}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {[['text', 'Aa Text'], ['media', '📷 Photo / video']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                style={{ padding: '6px 14px', borderRadius: 999, fontSize: 12.5, border: '1px solid var(--border-soft)', background: kind === k ? 'var(--surface-hover)' : 'transparent', color: 'var(--text-hi)', cursor: 'pointer' }}>
                {label}
              </button>
            ))}
          </div>
          {kind === 'text' ? (
            <textarea
              placeholder="What's your story?" value={text} maxLength={200}
              onChange={e => setText(e.target.value)}
              style={{ width: '100%', minHeight: 60, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, color: 'var(--text-hi)', outline: 'none', fontSize: 14, marginBottom: 10, resize: 'vertical' }}
            />
          ) : (
            <div style={{ marginBottom: 10 }}>
              <MediaPicker value={media} onChange={setMedia} maxPlaySeconds={MAX_STORY_SECONDS} disabled={busy} />
              {media && (
                <input value={mediaCaption} maxLength={200} onChange={e => setMediaCaption(e.target.value)} placeholder="Add a caption (optional)"
                  style={{ width: '100%', marginTop: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, color: 'var(--text-hi)', outline: 'none', fontSize: 14 }} />
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {['everyone', 'followers', 'close_friends'].map(a => (
              <button key={a} type="button" onClick={() => setAudience(a)}
                style={{ padding: '6px 12px', borderRadius: 999, fontSize: 12.5, border: '1px solid var(--border-soft)', background: audience === a ? 'var(--violet)' : 'transparent', color: audience === a ? 'white' : 'var(--text-mid)', cursor: 'pointer' }}>
                {a.replace('_', ' ')}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" style={{ width: 'auto', padding: '8px 18px' }} type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Share to story'}</button>
            <button type="button" className="btn-ghost" onClick={reset} disabled={busy}>Cancel</button>
          </div>
          {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        </form>
      )}

      {viewingGroup && (
        <StoryViewer group={viewingGroup} isMine={viewingGroup.author.id === user.id} onClose={() => { setViewingGroup(null); load(); }} />
      )}
    </>
  );
}
