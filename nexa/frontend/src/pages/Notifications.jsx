import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';

const VERB = {
  like: 'liked your post', comment: 'commented on your post', follow: 'started following you',
  message_request: 'sent you a message request', message: 'sent you a message',
  note_reply: 'replied to your note', reel_like: 'liked your reel', reel_comment: 'commented on your reel',
  game_invite: 'invited you to a game', mention: 'mentioned you', missed_call: 'tried to call you',
  story_view: 'viewed your story',
};

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function Notifications({ onOpenProfile }) {
  const [items, setItems] = useState(null);

  const load = async () => {
    const res = await api.notifications();
    setItems(res.notifications);
    if (res.unreadCount > 0) await api.markAllNotificationsRead();
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <h2 className="page-title">Notifications</h2>
      {items === null && <div className="empty-state"><span className="loading-dot" /> Loading…</div>}
      {items?.length === 0 && <div className="empty-state"><div className="glyph">🔔</div>Nothing yet.</div>}
      {items?.map(n => (
        <div key={n.id} className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, marginBottom: 8, cursor: 'pointer', opacity: n.read ? 0.7 : 1 }}
          onClick={() => onOpenProfile?.(n.actor.username)}>
          <Avatar user={n.actor} size={38} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5 }}><b>{n.actor.displayName}</b> {VERB[n.type] || n.type}</div>
            <div style={{ fontSize: 12, color: 'var(--text-low)' }}>{timeAgo(n.createdAt)}</div>
          </div>
          {!n.read && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--pink)' }} />}
        </div>
      ))}
    </div>
  );
}
