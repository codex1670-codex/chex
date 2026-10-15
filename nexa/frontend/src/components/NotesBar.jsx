import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import { useAuth } from '../AuthContext.jsx';

const MOOD_ICON = { none: '', happy: '😊', chilling: '😌', busy: '⏳', celebrating: '🎉', thinking: '💭' };
const MOOD_LABEL = { none: 'No mood', happy: 'Happy', chilling: 'Chilling', busy: 'Busy', celebrating: 'Celebrating', thinking: 'Thinking' };
const AUDIENCE_LABEL = { everyone: '🌐 Everyone', followers: '👥 Followers', close_friends: '💚 Close friends', no_one: '🔒 Only me' };

export default function NotesBar({ onOpenMessage }) {
  const { user } = useAuth();
  const [notes, setNotes] = useState(null);
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState('💭');
  const [mood, setMood] = useState('none');
  const [audience, setAudience] = useState('followers');
  const [moods, setMoods] = useState(Object.keys(MOOD_ICON));
  const [songs, setSongs] = useState([]);
  const [songId, setSongId] = useState('');
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [songTab, setSongTab] = useState('tamil');
  const [songQuery, setSongQuery] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [status, setStatus] = useState('');
  const audioRef = useRef(null);

  const load = () => api.notesFeed().then(res => setNotes(res.notes));
  useEffect(() => { load(); }, []);
  // Section 131/136 — mood + audience come from the same allowlisted registry the backend
  // validates against, so the picker never offers a value the server would reject.
  useEffect(() => { api.noteMoods().then(res => res.moods && setMoods(res.moods)).catch(() => {}); }, []);
  // The 150-track "Spotify" catalog notes can attach a song from (50 Tamil + 100
  // English trending picks) — see backend/src/songs.js.
  useEffect(() => { api.noteSongs().then(res => res.songs && setSongs(res.songs)).catch(() => {}); }, []);

  // Autoplay the attached song the moment a note is opened, and stop it the moment the
  // note is closed or swapped for a different one — never more than one note's song
  // playing at once, and never playing on its own without the person opening the note.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (expanded?.song) {
      el.load();
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [expanded]);

  const myNote = notes?.find(n => n.author.id === user.id);
  const others = notes?.filter(n => n.author.id !== user.id) || [];
  const shownSongs = songs.filter(s => s.language === songTab && (
    !songQuery.trim() || s.title.toLowerCase().includes(songQuery.trim().toLowerCase()) || s.artist.toLowerCase().includes(songQuery.trim().toLowerCase())
  ));

  const openComposer = () => {
    if (myNote) {
      setText(myNote.text || '');
      setEmoji(myNote.emoji || '💭');
      setMood(myNote.mood || 'none');
      setAudience(myNote.audience || 'followers');
      setSongId(myNote.song?.id || '');
    } else {
      setMood('none');
      setAudience('followers');
      setSongId('');
    }
    setShowSongPicker(false);
    setComposing(true);
  };

  const submitNote = async (e) => {
    e.preventDefault();
    if (!text.trim() && !emoji && !songId) return;
    const payload = { text: text.trim(), emoji, mood: mood === 'none' ? null : mood, audience, songId: songId || null };
    if (myNote) {
      await api.editNote(payload);
    } else {
      await api.createNote(payload);
    }
    setText('');
    setComposing(false);
    load();
  };

  const toggleLike = async (note) => {
    if (note.likedByMe) await api.unlikeNote(note.id); else await api.likeNote(note.id);
    load();
  };

  const sendReply = async (note) => {
    if (!replyText.trim()) return;
    const res = await api.replyNote(note.id, replyText.trim());
    setStatus(res.status === 'sent' ? 'Reply sent!' : res.message);
    setReplyText('');
  };

  if (notes === null) return null;

  return (
    <>
      <div className="notes-row">
        <div className="note-card" onClick={openComposer}>
          <div className="note-avatar-ring" style={{ background: myNote ? 'linear-gradient(135deg, var(--violet), var(--pink))' : 'rgba(255,255,255,0.1)' }}>
            <Avatar user={user} size={52} />
            {myNote?.song && <span className="note-song-badge" title={`${myNote.song.title} — ${myNote.song.artist}`}>🎵</span>}
          </div>
          <div className="label">{myNote ? [MOOD_ICON[myNote.mood], myNote.emoji, myNote.text].filter(Boolean).join(' ') || myNote.song?.title : 'Your note'}</div>
        </div>
        {others.map(n => (
          <div className="note-card" key={n.id} onClick={() => { setExpanded(n); setStatus(''); }}>
            <div className="note-avatar-ring">
              <Avatar user={n.author} size={52} />
              {n.song && <span className="note-song-badge" title={`${n.song.title} — ${n.song.artist}`}>🎵</span>}
            </div>
            <div className="label">{[MOOD_ICON[n.mood], n.emoji, n.text].filter(Boolean).join(' ') || n.song?.title}</div>
          </div>
        ))}
      </div>

      {composing && (
        <div className="glass-card" style={{ padding: 16, marginBottom: 16 }}>
          <form onSubmit={submitNote}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {['💭', '🎧', '☕', '😴', '🔥', '📚'].map(e => (
                <button key={e} type="button" onClick={() => setEmoji(e)}
                  style={{ fontSize: 20, background: emoji === e ? 'var(--surface-hover)' : 'transparent', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '4px 8px', cursor: 'pointer' }}>
                  {e}
                </button>
              ))}
            </div>
            <input
              placeholder="Share a thought (max 60 chars)…" value={text} maxLength={60}
              onChange={e => setText(e.target.value)}
              style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '9px 12px', color: 'var(--text-hi)', outline: 'none', fontSize: 13.5, marginBottom: 10 }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-low)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mood</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {moods.map(m => (
                <button key={m} type="button" onClick={() => setMood(m)}
                  style={{ fontSize: 12, background: mood === m ? 'var(--surface-hover)' : 'transparent', border: '1px solid var(--border-soft)', borderRadius: 999, padding: '5px 12px', cursor: 'pointer', color: 'var(--text-hi)' }}>
                  {MOOD_ICON[m] ? `${MOOD_ICON[m]} ` : ''}{MOOD_LABEL[m] || m}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--text-low)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Music</div>
              {songId && (
                <button type="button" className="btn-ghost" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => setSongId('')}>Remove</button>
              )}
            </div>
            <button type="button" className="btn-ghost" style={{ marginBottom: 8, fontSize: 12.5, padding: '6px 12px' }}
              onClick={() => setShowSongPicker(s => !s)}>
              {songId ? `🎵 ${songs.find(s => s.id === songId)?.title || 'Song selected'}` : '🎵 Add a song (Tamil & English trending)'}
            </button>
            {showSongPicker && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  {[['tamil', 'Tamil (50)'], ['english', 'English (100)']].map(([tab, label]) => (
                    <button key={tab} type="button" className="btn-ghost"
                      style={{ fontSize: 11.5, padding: '4px 10px', background: songTab === tab ? 'var(--surface-hover)' : 'transparent' }}
                      onClick={() => setSongTab(tab)}>
                      {label}
                    </button>
                  ))}
                </div>
                <input placeholder="Search songs or artists…" value={songQuery} onChange={e => setSongQuery(e.target.value)}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '7px 10px', color: 'var(--text-hi)', outline: 'none', fontSize: 12.5, marginBottom: 6 }} />
                <div className="note-song-picker">
                  {shownSongs.map(s => (
                    <div key={s.id} className={`song-row${songId === s.id ? ' selected' : ''}`}
                      onClick={() => { setSongId(s.id === songId ? '' : s.id); setShowSongPicker(false); }}>
                      <span className="meta">{s.title}<span className="artist">{s.artist}</span></span>
                      {songId === s.id && <span>✓</span>}
                    </div>
                  ))}
                  {shownSongs.length === 0 && <div style={{ padding: 10, fontSize: 12, color: 'var(--text-low)' }}>No matches.</div>}
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-low)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Who can see this</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {Object.keys(AUDIENCE_LABEL).map(a => (
                <button key={a} type="button" onClick={() => setAudience(a)}
                  style={{ fontSize: 12, background: audience === a ? 'var(--surface-hover)' : 'transparent', border: '1px solid var(--border-soft)', borderRadius: 999, padding: '5px 12px', cursor: 'pointer', color: 'var(--text-hi)' }}>
                  {AUDIENCE_LABEL[a]}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" style={{ width: 'auto', padding: '8px 18px' }} type="submit">{myNote ? 'Save changes' : 'Share note'}</button>
              {myNote && <button type="button" className="btn-ghost" onClick={async () => { await api.deleteMyNote(); setComposing(false); load(); }}>Remove note</button>}
              <button type="button" className="btn-ghost" onClick={() => setComposing(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {expanded && (
        <div className="glass-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <Avatar user={expanded.author} size={36} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{expanded.author.displayName}</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-mid)' }}>{expanded.emoji} {expanded.text}</div>
              {expanded.mood && expanded.mood !== 'none' && (
                <div style={{ fontSize: 11.5, color: 'var(--text-low)' }}>{MOOD_ICON[expanded.mood]} Feeling {MOOD_LABEL[expanded.mood]?.toLowerCase()}</div>
              )}
            </div>
            <button className="btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setExpanded(null)}>Close</button>
          </div>
          {expanded.song && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12.5, color: 'var(--text-mid)' }}>
              🎵 Now playing: <strong style={{ color: 'var(--text-hi)' }}>{expanded.song.title}</strong> — {expanded.song.artist}
              {/* Autoplays on open (see the effect above) and stops the moment the note is closed. */}
              <audio ref={audioRef} src={expanded.song.previewUrl} loop />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button className="btn-ghost" onClick={() => toggleLike(expanded)}>{expanded.likedByMe ? '♥ Liked' : '♡ Like'} ({expanded.likeCount})</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder={`Reply to ${expanded.author.displayName}…`} value={replyText} onChange={e => setReplyText(e.target.value)}
              style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 999, padding: '9px 14px', color: 'var(--text-hi)', outline: 'none', fontSize: 13.5 }} />
            <button className="send-btn" onClick={() => sendReply(expanded)}>➤</button>
          </div>
          {status && <div className="request-banner" style={{ marginTop: 10 }}>{status}</div>}
          <button className="btn-ghost" style={{ marginTop: 10 }} onClick={() => onOpenMessage?.(expanded.author.username)}>Open conversation</button>
        </div>
      )}
    </>
  );
}
