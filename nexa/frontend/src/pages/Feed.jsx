import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PostCard from '../components/PostCard.jsx';
import Avatar from '../components/Avatar.jsx';
import { useAuth } from '../AuthContext.jsx';
import StoriesBar from '../components/StoriesBar.jsx';
import MediaPicker from '../components/MediaPicker.jsx';

export default function Feed({ onOpenProfile }) {
  const { user } = useAuth();
  const [tab, setTab] = useState('following');
  const [posts, setPosts] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [media, setMedia] = useState(null);       // { file, kind, edits, … } from MediaPicker
  const [showMedia, setShowMedia] = useState(false);

  const load = async (reset = true) => {
    const fetcher = tab === 'following' ? api.feedFollowing : api.feedForYou;
    const res = await fetcher(reset ? null : cursor);
    setPosts(reset ? res.posts : [...(posts || []), ...res.posts]);
    setCursor(res.nextCursor);
  };

  useEffect(() => { setPosts(null); load(true); /* eslint-disable-next-line */ }, [tab]);

  const submitPost = async (e) => {
    e.preventDefault();
    if (!caption.trim() && !media) return;
    setPosting(true);
    setError('');
    try {
      const res = media
        ? await api.uploadPost(media.file, caption.trim(), media.kind === 'video' ? media.edits : undefined)
        : await api.createPost({ caption: caption.trim() });
      setCaption('');
      setMedia(null);
      setShowMedia(false);
      if (tab === 'following') setPosts(p => [res.post, ...(p || [])]);
    } catch (err) {
      setError(err.message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div>
      <StoriesBar />
      <div className="feed-tabs">
        <button className={tab === 'following' ? 'active' : ''} onClick={() => setTab('following')}>Following</button>
        <button className={tab === 'foryou' ? 'active' : ''} onClick={() => setTab('foryou')}>For You</button>
      </div>

      <form className="glass-card composer" onSubmit={submitPost}>
        <div style={{ display: 'flex', gap: 10 }}>
          <Avatar user={user} size={38} />
          <textarea
            placeholder="What's happening?"
            value={caption}
            onChange={e => setCaption(e.target.value)}
            maxLength={2200}
          />
        </div>
        {showMedia && (
          <div style={{ marginTop: 10 }}>
            <MediaPicker value={media} onChange={setMedia} disabled={posting} />
          </div>
        )}
        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        <div className="composer-footer">
          {!showMedia && <button type="button" className="btn-ghost" onClick={() => setShowMedia(true)}>📷 Photo / video</button>}
          {showMedia && !media && <button type="button" className="btn-ghost" onClick={() => setShowMedia(false)}>Cancel media</button>}
          <button className="btn-primary" style={{ width: 'auto', padding: '9px 20px' }} disabled={posting || (!caption.trim() && !media)}>
            {posting ? (media ? 'Uploading…' : 'Posting…') : 'Post'}
          </button>
        </div>
      </form>

      {posts === null && <div className="empty-state"><span className="loading-dot" /> Loading feed…</div>}

      {posts !== null && posts.length === 0 && (
        <div className="empty-state">
          <div className="glyph">✨</div>
          {tab === 'following' ? 'Follow people to see their posts here.' : 'Nothing to show yet.'}
        </div>
      )}

      {posts?.map(p => <PostCard key={p.id} post={p} onOpenProfile={onOpenProfile} />)}

      {cursor && posts?.length > 0 && (
        <div style={{ textAlign: 'center' }}>
          <button className="btn-ghost" disabled={loadingMore} onClick={async () => {
            setLoadingMore(true);
            await load(false);
            setLoadingMore(false);
          }}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
