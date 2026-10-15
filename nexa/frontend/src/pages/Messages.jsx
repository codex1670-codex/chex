import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';
import { useAuth } from '../AuthContext.jsx';
import { connectSocket } from '../socket.js';
import NotesBar from '../components/NotesBar.jsx';
import { requestStartCall } from '../callBus.js';
import { updateCodexContext } from '../codexContext.js';

function otherParticipant(convo, myId) {
  return convo.participants.find(p => p.id !== myId) || convo.participants[0];
}

function MessageBubble({ message, mine, onChanged }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [reactions, setReactions] = useState(message.reactions || []);

  const react = async (emoji) => {
    const res = await api.reactMessage(message.id, emoji);
    setReactions(res.reactions);
    setOpen(false);
  };
  const saveEdit = async () => {
    const res = await api.editMessage(message.id, draft.trim());
    onChanged({ content: res.message.content, editedAt: res.message.editedAt });
    setEditing(false);
  };
  const remove = async () => {
    await api.deleteMessage(message.id);
    onChanged(null);
  };
  const togglePin = async () => {
    await (message.pinned ? api.unpinMessage(message.id) : api.pinMessage(message.id));
    onChanged({ pinned: !message.pinned });
    setOpen(false);
  };

  return (
    <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '70%' }}>
      {editing ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={draft} onChange={e => setDraft(e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '6px 10px', color: 'var(--text-hi)', fontSize: 13.5 }} />
          <button className="btn-ghost" style={{ padding: '4px 8px' }} onClick={saveEdit}>Save</button>
        </div>
      ) : (
        <div className={`bubble ${mine ? 'mine' : 'theirs'}`} onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', position: 'relative' }}>
          {message.content}
          {message.editedAt && <span style={{ fontSize: 10, opacity: 1, marginLeft: 6 }}>(edited)</span>}
          {message.pinned && <span style={{ fontSize: 10, opacity: 0.8, marginLeft: 6 }}>📌</span>}
        </div>
      )}
      {reactions.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 2, textAlign: mine ? 'right' : 'left' }}>{reactions.map(r => r.emoji).join(' ')}</div>
      )}
      {open && !editing && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
          {['❤️', '😂', '👍', '😮'].map(e => (
            <button key={e} className="btn-ghost" style={{ padding: '2px 6px', fontSize: 12 }} onClick={() => react(e)}>{e}</button>
          ))}
          <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={togglePin}>{message.pinned ? 'Unpin' : 'Pin'}</button>
          {mine && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { setEditing(true); setOpen(false); }}>Edit</button>}
          {mine && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--pink-ink)' }} onClick={remove}>Delete</button>}
        </div>
      )}
    </div>
  );
}

export default function Messages({ startWithUsername, onConsumeStart }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState(null);
  const [requests, setRequests] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [pendingToUsername, setPendingToUsername] = useState(null); // no conversation yet, composing first message
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const scrollRef = useRef(null);

  const loadConversations = async () => {
    const res = await api.conversations();
    setConversations(res.conversations);
  };
  const loadRequests = async () => {
    const res = await api.requests();
    setRequests(res.requests);
  };

  useEffect(() => { loadConversations(); loadRequests(); }, []);

  useEffect(() => {
    if (startWithUsername) {
      const existing = conversations?.find(c => otherParticipant(c, user.id).username === startWithUsername);
      if (existing) {
        setActiveId(existing.id);
        setPendingToUsername(null);
      } else {
        setPendingToUsername(startWithUsername);
        setActiveId(null);
      }
      onConsumeStart?.();
    }
    // eslint-disable-next-line
  }, [startWithUsername, conversations]);

  useEffect(() => {
    const socket = connectSocket();
    const onNew = (msg) => {
      if (msg.conversationId === activeId) {
        setMessages(m => [...m, msg]);
      }
      loadConversations();
    };
    const onAccepted = () => { loadConversations(); };
    socket.on('message:new', onNew);
    socket.on('message_request:accepted', onAccepted);
    return () => {
      socket.off('message:new', onNew);
      socket.off('message_request:accepted', onAccepted);
    };
    // eslint-disable-next-line
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    api.conversationMessages(activeId).then(res => setMessages(res.messages));
  }, [activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      api.searchUsers(searchQuery.trim()).then(res => setSearchResults(res.users)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const openConversation = (id) => {
    setActiveId(id);
    setPendingToUsername(null);
    setStatus('');
  };

  const startNewChat = (username) => {
    setPendingToUsername(username);
    setActiveId(null);
    setMessages([]);
    setSearchQuery('');
    setSearchResults([]);
    setStatus('');
  };

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const body = activeId ? { conversationId: activeId, text: text.trim() } : { toUsername: pendingToUsername, text: text.trim() };
    setText('');
    try {
      const res = await api.sendMessage(body);
      if (res.status === 'sent') {
        setMessages(m => [...m, res.message]);
        loadConversations();
      } else if (res.status === 'message_request') {
        setStatus(res.message);
      }
    } catch (err) {
      setStatus(err.message);
    }
  };

  const respondRequest = async (id, action) => {
    if (action === 'accept') {
      const res = await api.acceptRequest(id);
      await loadRequests();
      await loadConversations();
      setActiveId(res.conversation.id);
    } else if (action === 'delete') {
      await api.deleteRequest(id);
      await loadRequests();
    } else if (action === 'block') {
      await api.blockRequest(id);
      await loadRequests();
    } else if (action === 'report') {
      await api.reportRequest(id);
      await loadRequests();
    }
  };

  const activeConvo = conversations?.find(c => c.id === activeId);
  const chatPartner = activeConvo ? otherParticipant(activeConvo, user.id) : (pendingToUsername ? { username: pendingToUsername, displayName: pendingToUsername } : null);

  useEffect(() => {
    // Real current-screen context for Codex: "send him this" / "call them" while a
    // conversation is open resolves to whoever is actually on screen.
    updateCodexContext({ screen: 'messages', activeConversationId: activeId || null, activeConversationUsername: chatPartner?.username || null });
  }, [activeId, chatPartner?.username]);

  return (
    <div>
      <NotesBar onOpenMessage={(u) => startNewChat(u)} />
      <div className="messages-layout">
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14 }}>
          <input
            placeholder="Search people to message…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '9px 12px', color: 'var(--text-hi)', outline: 'none', fontSize: 13.5 }}
          />
          {searchResults.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {searchResults.map(u => (
                <div key={u.id} className="convo-item" onClick={() => startNewChat(u.username)}>
                  <Avatar user={u} size={32} />
                  <div className="last">{u.displayName} · @{u.username}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {requests?.length > 0 && (
          <div style={{ padding: '0 14px 10px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Message requests</div>
            {requests.map(r => (
              <div key={r.id} style={{ marginBottom: 8 }}>
                <div className="request-list-item glass-card">
                  <Avatar user={r.sender} size={32} />
                  <div className="txt">
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.sender.displayName}</div>
                    <div className="snippet">{r.firstText}</div>
                  </div>
                </div>
                <div className="request-actions">
                  <button className="accept" onClick={() => respondRequest(r.id, 'accept')}>Accept</button>
                  <button onClick={() => respondRequest(r.id, 'delete')}>Delete</button>
                  <button className="danger" onClick={() => respondRequest(r.id, 'block')}>Block</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="convo-list" style={{ flex: 1 }}>
          {conversations === null && <div style={{ padding: 14, color: 'var(--text-low)', fontSize: 13 }}>Loading…</div>}
          {conversations?.length === 0 && <div style={{ padding: 14, color: 'var(--text-low)', fontSize: 13 }}>No conversations yet. Search someone to start chatting.</div>}
          {conversations?.map(c => {
            const other = otherParticipant(c, user.id);
            return (
              <div key={c.id} className={`convo-item ${activeId === c.id ? 'active' : ''}`} onClick={() => openConversation(c.id)}>
                <Avatar user={other} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{other.displayName}</div>
                  <div className="last">{c.lastMessage?.content || 'Say hello 👋'}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="glass-card chat-panel">
        {!chatPartner && (
          <div className="empty-state" style={{ margin: 'auto' }}>
            <div className="glyph">💬</div>
            Select a conversation or search someone to start chatting.
          </div>
        )}
        {chatPartner && (
          <>
            <div className="chat-header">
              <Avatar user={chatPartner} size={36} />
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>{chatPartner.displayName || chatPartner.username}</div>
              {activeId && (
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="btn-ghost" style={{ padding: '6px 10px' }} onClick={() => requestStartCall(activeId, 'voice')}>📞</button>
                  <button className="btn-ghost" style={{ padding: '6px 10px' }} onClick={() => requestStartCall(activeId, 'video')}>🎥</button>
                </div>
              )}
            </div>
            {pendingToUsername && (
              <div className="request-banner">
                You haven't chatted with @{pendingToUsername} yet. Your first message will be sent as a message request until they accept it.
              </div>
            )}
            <div className="chat-messages" ref={scrollRef}>
              {messages.map(m => (
                <MessageBubble key={m.id} message={m} mine={m.senderId === user.id} onChanged={(updated) => {
                  setMessages(list => updated === null ? list.filter(x => x.id !== m.id) : list.map(x => x.id === m.id ? { ...x, ...updated } : x));
                }} />
              ))}
              {messages.length === 0 && !pendingToUsername && (
                <div style={{ margin: 'auto', color: 'var(--text-low)', fontSize: 13 }}>No messages yet — say hello.</div>
              )}
            </div>
            {status && <div className="request-banner" style={{ margin: '0 14px 10px' }}>{status}</div>}
            <form className="chat-input-row" onSubmit={send}>
              <input placeholder="Message…" value={text} onChange={e => setText(e.target.value)} />
              <button className="send-btn" type="submit">➤</button>
            </form>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
