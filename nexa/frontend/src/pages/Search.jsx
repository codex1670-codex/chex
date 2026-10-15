import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';
import PostCard from '../components/PostCard.jsx';

export default function Search({ onOpenProfile, initialQuery, onConsumeQuery }) {
  const [q, setQ] = useState(initialQuery || '');
  const [results, setResults] = useState(null);
  const [activeTag, setActiveTag] = useState(null);
  const [tagPosts, setTagPosts] = useState(null);

  useEffect(() => {
    if (initialQuery) { setQ(initialQuery); onConsumeQuery?.(); }
    // eslint-disable-next-line
  }, [initialQuery]);

  useEffect(() => {
    if (!q.trim()) { setResults(null); setActiveTag(null); return; }
    const t = setTimeout(() => {
      api.search(q.trim()).then(setResults).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const openTag = async (tag) => {
    setActiveTag(tag);
    const res = await api.hashtagPosts(tag);
    setTagPosts(res.posts);
  };

  return (
    <div>
      <h2 className="page-title">Search</h2>
      <input
        placeholder="Search people or #hashtags…" value={q} onChange={e => setQ(e.target.value)}
        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 12, padding: '12px 16px', color: 'var(--text-hi)', outline: 'none', fontSize: 15, marginBottom: 18 }}
      />

      {activeTag ? (
        <div>
          <button className="btn-ghost" style={{ marginBottom: 14 }} onClick={() => { setActiveTag(null); setTagPosts(null); }}>← Back to search</button>
          <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: 12 }}>#{activeTag}</h3>
          {tagPosts === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {tagPosts?.length === 0 && <div className="empty-state">No posts with this hashtag yet.</div>}
          {tagPosts?.map(p => <PostCard key={p.id} post={p} onOpenProfile={onOpenProfile} />)}
        </div>
      ) : (
        <>
          {results?.users?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>People</div>
              {results.users.map(u => (
                <div key={u.id} className="glass-card convo-item" style={{ padding: 12, marginBottom: 6 }} onClick={() => onOpenProfile(u.username)}>
                  <Avatar user={u} size={38} />
                  <div className="last">{u.displayName} · @{u.username}</div>
                </div>
              ))}
            </div>
          )}
          {results?.hashtags?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Hashtags</div>
              {results.hashtags.map(h => (
                <div key={h.tag} className="glass-card convo-item" style={{ padding: 12, marginBottom: 6 }} onClick={() => openTag(h.tag)}>
                  <div className="last">#{h.tag} · {h.postCount} post{h.postCount === 1 ? '' : 's'}</div>
                </div>
              ))}
            </div>
          )}
          {results && results.users.length === 0 && results.hashtags.length === 0 && (
            <div className="empty-state">No matches for "{q}".</div>
          )}
          {!results && !q && <div className="empty-state" style={{ color: 'var(--text-low)' }}>Search for people or tap a #hashtag to explore.</div>}
        </>
      )}
    </div>
  );
}
