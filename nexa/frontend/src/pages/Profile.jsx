import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';
import PostCard from '../components/PostCard.jsx';
import ProfileMediaEditor from '../components/ProfileMediaEditor.jsx';
import ProfileStudio from '../components/ProfileStudio.jsx';
import { useAuth } from '../AuthContext.jsx';
import { updateCodexContext } from '../codexContext.js';

export default function Profile({ username, initialView, onConsumeInitialView, onOpenMessage, onOpenSettings }) {
  const { user: me, setUser } = useAuth();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [status, setStatus] = useState('');
  // 'none' | 'posts' | 'reels' — which saved view (if any) is showing.
  const [savedView, setSavedView] = useState('none');
  const [savedPosts, setSavedPosts] = useState(null);
  const [savedReels, setSavedReels] = useState(null);
  // Section 130 — Reels History (own profile only): watched / liked / saved / created.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState('watched');
  const [history, setHistory] = useState(null);
  // Section 127/128 — Profile Photo & Profile Video editor.
  const [mediaEditorOpen, setMediaEditorOpen] = useState(false);
  // Profile Studio: which sheet to pop open on arrival ('video' when Codex says "open profile studio").
  const [studioSheet, setStudioSheet] = useState(null);
  // Section 190 — Nickname: private label the viewer sets for this profile (never shown
  // on your own profile). Also usable when talking to Codex, e.g. "message bro".
  const [nicknameEditing, setNicknameEditing] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameBusy, setNicknameBusy] = useState(false);
  const [nicknameError, setNicknameError] = useState('');

  useEffect(() => {
    setProfile(null);
    setError('');
    setMenuOpen(false);
    setSavedView('none');
    api.getUser(username).then(res => setProfile(res.user)).catch(err => setError(err.message));
    // Real current-screen context for Codex: lets "message him" / "follow her" resolve
    // to whichever profile is actually open, without the user repeating the username.
    updateCodexContext({ screen: 'profile', profileUsername: username });
  }, [username]);

  // Deep-link support: Codex's `navigate` action (and the nav rail) can send us straight
  // into "saved posts" or "saved reels" via initialView, e.g. from "open my saved reels".
  useEffect(() => {
    if (!initialView || !profile?.isSelf) return;
    if (initialView === 'saved-posts') openSaved('posts');
    if (initialView === 'saved-reels') openSaved('reels');
    if (initialView === 'reels-history') openHistory();
    if (initialView === 'profile-studio') setStudioSheet('video');
    onConsumeInitialView?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialView, profile]);

  const toggleFollow = async () => {
    setBusy(true);
    try {
      const res = profile.isFollowing ? await api.unfollow(username) : await api.follow(username);
      setProfile(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doAction = async (action) => {
    setMenuOpen(false);
    try {
      if (action === 'mute') { await api.mute(username); setMuted(true); setStatus(`Muted @${username}.`); }
      if (action === 'unmute') { await api.unmute(username); setMuted(false); setStatus(`Unmuted @${username}.`); }
      if (action === 'restrict') { await api.restrict(username); setRestricted(true); setStatus(`Restricted @${username}.`); }
      if (action === 'unrestrict') { await api.unrestrict(username); setRestricted(false); setStatus(`Unrestricted @${username}.`); }
      if (action === 'block') { await api.block(username); setStatus(`Blocked @${username}.`); }
      if (action === 'report') { await api.report('user', profile.id, 'Reported from profile'); setStatus('Reported — thanks for letting us know.'); }
    } catch (err) {
      setStatus(err.message);
    }
  };

  const openSaved = async (kind) => {
    setHistoryOpen(false);
    setSavedView(v => (v === kind ? 'none' : kind));
    if (kind === 'posts' && !savedPosts) setSavedPosts((await api.savedPosts()).posts);
    if (kind === 'reels' && !savedReels) setSavedReels((await api.savedReels()).reels);
  };

  const openHistory = async () => {
    setSavedView('none');
    setHistoryOpen(o => !o);
    if (!history) setHistory(await api.reelsHistory());
  };

  // Keeps the profile view and the global auth user (used app-wide for "my own" avatar
  // elsewhere) in sync after any photo/video/display-mode change.
  const onMediaUpdated = (updatedUser) => {
    setProfile(updatedUser);
    if (updatedUser.isSelf) setUser(u => ({ ...u, ...updatedUser }));
  };

  const openNicknameEditor = () => {
    setNicknameError('');
    setNicknameDraft(profile.nickname || '');
    setNicknameEditing(true);
  };

  const saveNickname = async () => {
    const trimmed = nicknameDraft.trim();
    if (!trimmed) { setNicknameError('Enter a nickname first.'); return; }
    setNicknameBusy(true);
    setNicknameError('');
    try {
      const res = await api.setNickname(username, trimmed);
      setProfile(res.user);
      setNicknameEditing(false);
    } catch (err) {
      setNicknameError(err.message);
    } finally {
      setNicknameBusy(false);
    }
  };

  const clearNickname = async () => {
    setNicknameBusy(true);
    try {
      const res = await api.removeNickname(username);
      setProfile(res.user);
      setNicknameEditing(false);
    } catch (err) {
      setNicknameError(err.message);
    } finally {
      setNicknameBusy(false);
    }
  };

  if (error) return <div className="empty-state">{error}</div>;
  if (!profile) return <div className="empty-state"><span className="loading-dot" /> Loading profile…</div>;

  return (
    <div>
      <ProfileStudio
        profile={profile}
        isSelf={profile.isSelf}
        onUpdated={onMediaUpdated}
        openSheet={studioSheet}
        onSheetConsumed={() => setStudioSheet(null)}
        onOpenSettings={onOpenSettings}
      >
          {!profile.isSelf && (
            <div style={{ marginTop: 6 }}>
              {nicknameEditing ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    autoFocus
                    value={nicknameDraft}
                    onChange={e => setNicknameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveNickname(); if (e.key === 'Escape') setNicknameEditing(false); }}
                    maxLength={40}
                    placeholder="e.g. Bro, Boss, Bestie…"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '5px 10px', color: 'var(--text-hi)', outline: 'none', fontSize: 13, width: 160 }}
                  />
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={nicknameBusy} onClick={saveNickname}>Save</button>
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setNicknameEditing(false)}>Cancel</button>
                  {nicknameError && <div style={{ color: 'var(--pink-ink)', fontSize: 12, width: '100%' }}>{nicknameError}</div>}
                </div>
              ) : profile.nickname ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-mid)' }}>Nickname: <b style={{ color: 'var(--text-hi)' }}>{profile.nickname}</b></span>
                  <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={openNicknameEditor}>Edit</button>
                  <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} disabled={nicknameBusy} onClick={clearNickname}>Remove</button>
                </div>
              ) : (
                <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 11.5 }} onClick={openNicknameEditor}>🏷️ Add nickname</button>
              )}
            </div>
          )}

        {!profile.isSelf && (
          <div style={{ display: 'flex', gap: 8, position: 'relative', justifyContent: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn-ghost" style={{ background: profile.isFollowing ? 'transparent' : 'var(--violet)', borderColor: profile.isFollowing ? undefined : 'var(--violet)' }} disabled={busy} onClick={toggleFollow}>
              {profile.isFollowing ? 'Following' : 'Follow'}
            </button>
            <button className="btn-ghost" onClick={() => onOpenMessage(profile.username)}>Message</button>
            <button className="btn-ghost" onClick={() => setMenuOpen(o => !o)}>•••</button>
            {menuOpen && (
              <div className="glass-card" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, padding: 8, zIndex: 10, minWidth: 160 }}>
                <button className="nav-link" onClick={() => doAction(muted ? 'unmute' : 'mute')}>{muted ? 'Unmute' : 'Mute'}</button>
                <button className="nav-link" onClick={() => doAction(restricted ? 'unrestrict' : 'restrict')}>{restricted ? 'Unrestrict' : 'Restrict'}</button>
                <button className="nav-link" style={{ color: 'var(--pink-ink)' }} onClick={() => doAction('block')}>Block</button>
                <button className="nav-link" onClick={() => doAction('report')}>Report</button>
              </div>
            )}
          </div>
        )}
      </ProfileStudio>

      {status && <div className="request-banner" style={{ marginBottom: 16 }}>{status}</div>}

      {profile.isSelf && (
        <div style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={() => setMediaEditorOpen(o => !o)}>{mediaEditorOpen ? 'Hide trim & cover tools' : '✂️ Trim & cover tools'}</button>
          <button className="btn-ghost" onClick={() => openSaved('posts')}>{savedView === 'posts' ? 'Hide saved posts' : '🔖 Saved posts'}</button>
          <button className="btn-ghost" onClick={() => openSaved('reels')}>{savedView === 'reels' ? 'Hide saved reels' : '🎬 Saved reels'}</button>
          <button className="btn-ghost" onClick={openHistory}>{historyOpen ? 'Hide reels history' : '📜 Reels history'}</button>
        </div>
      )}

      {mediaEditorOpen && <ProfileMediaEditor profile={profile} onUpdated={onMediaUpdated} />}

      {savedView === 'posts' && (
        <div>
          {savedPosts === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {savedPosts?.length === 0 && <div className="empty-state">Nothing saved yet.</div>}
          {savedPosts?.map(p => <PostCard key={p.id} post={p} />)}
        </div>
      )}

      {savedView === 'reels' && (
        <div>
          {savedReels === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {savedReels?.length === 0 && <div className="empty-state">No saved reels yet.</div>}
          {savedReels?.map(r => (
            <div key={r.id} className="glass-card" style={{ padding: 14, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
              <video src={r.videoUrl} style={{ width: 90, height: 120, objectFit: 'cover', borderRadius: 10, background: '#000' }} muted />
              <div style={{ fontSize: 13.5 }}>{r.caption || <span style={{ color: 'var(--text-low)' }}>No caption</span>}</div>
            </div>
          ))}
        </div>
      )}

      {savedView === 'none' && !historyOpen && (
        <div className="empty-state" style={{ color: 'var(--text-low)' }}>
          Post grid isn't part of this vertical slice — see the Home feed for @{profile.username}'s posts.
        </div>
      )}

      {historyOpen && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {[['watched', '👁 Watched'], ['liked', '♥ Liked'], ['saved', '🔖 Saved'], ['created', '🎬 Posted']].map(([key, label]) => (
              <button key={key} className="btn-ghost"
                style={{ padding: '5px 14px', fontSize: 12.5, background: historyTab === key ? 'var(--surface-hover)' : 'transparent' }}
                onClick={() => setHistoryTab(key)}>
                {label}
              </button>
            ))}
          </div>
          {history === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {history && history[historyTab]?.length === 0 && <div className="empty-state">Nothing here yet.</div>}
          {history && history[historyTab]?.map(r => (
            <div key={r.id} className="glass-card" style={{ padding: 14, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
              <video src={r.videoUrl} style={{ width: 90, height: 120, objectFit: 'cover', borderRadius: 10, background: '#000' }} muted />
              <div>
                <div style={{ fontSize: 13.5 }}>{r.caption || <span style={{ color: 'var(--text-low)' }}>No caption</span>}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-low)', marginTop: 4 }}>
                  {historyTab === 'watched' ? 'Watched' : historyTab === 'liked' ? 'Liked' : historyTab === 'saved' ? 'Saved' : 'Posted'} {new Date(r.interactionAt).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
