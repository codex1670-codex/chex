import { useRef, useState, useEffect } from 'react';
import Avatar from './Avatar.jsx';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { updateCodexContext } from '../codexContext.js';
import EditedMedia from './EditedMedia.jsx';
import PhotoEditor from './PhotoEditor.jsx';
import VideoEditor from './VideoEditor.jsx';
import { fileKind, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../editSettings.js';

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function CommentRow({ comment, postId, postAuthorId, onChanged, onReply, depth = 0 }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const isMine = comment.author.id === user.id;
  const isPostAuthor = postAuthorId === user.id;

  const saveEdit = async () => {
    const res = await api.editComment(postId, comment.id, draft.trim());
    onChanged({ ...res.comment });
    setEditing(false);
  };
  const remove = async () => {
    await api.deleteComment(postId, comment.id);
    onChanged(null);
  };
  const toggleHide = async () => {
    const res = comment.hidden ? await api.unhideComment(postId, comment.id) : await api.hideComment(postId, comment.id);
    onChanged({ ...comment, hidden: res.hidden });
  };
  const report = async () => {
    await api.report('comment', comment.id, 'Reported from post');
    setOpen(false);
  };

  if (comment.hidden && !isMine && !isPostAuthor) return null;

  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div className="comment-row" onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', opacity: comment.hidden ? 0.5 : 1 }}>
        <span className="b">{comment.author.displayName}</span>
        {editing ? (
          <span onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 6, flex: 1 }}>
            <input value={draft} onChange={e => setDraft(e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '3px 8px', color: 'var(--text-hi)', fontSize: 13 }} />
            <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={saveEdit}>Save</button>
          </span>
        ) : (
          <span>{comment.text}{comment.editedAt && <span style={{ fontSize: 10, opacity: 1 }}> (edited)</span>}{comment.hidden && <span style={{ fontSize: 10, opacity: 1 }}> (hidden)</span>}</span>
        )}
      </div>
      {open && !editing && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, marginLeft: 4 }} onClick={e => e.stopPropagation()}>
          <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => onReply(comment)}>Reply</button>
          {isMine && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEditing(true)}>Edit</button>}
          {(isMine || isPostAuthor) && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--pink-ink)' }} onClick={remove}>Delete</button>}
          {isPostAuthor && !isMine && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={toggleHide}>{comment.hidden ? 'Unhide' : 'Hide'}</button>}
          {!isMine && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={report}>Report</button>}
        </div>
      )}
    </div>
  );
}

export default function PostCard({ post, onOpenProfile }) {
  const { user } = useAuth();
  const [p, setP] = useState(post);
  const containerRef = useRef(null);

  // Real "current post" tracking for Codex: whichever card is majority-visible becomes
  // what "this post" / "send this" resolves to — mirrors the same pattern used for Reels.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].intersectionRatio >= 0.6) {
          updateCodexContext({
            screen: 'feed',
            currentPost: { id: p.id, caption: p.caption, authorUsername: p.author.username },
          });
        }
      },
      { threshold: [0.6] }
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line
  }, [p.id]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || p.mediaType !== 'video') return undefined;
    const obs = new IntersectionObserver(([e]) => { if (!e.isIntersecting) videoRef.current?.pause(); }, { threshold: 0.2 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [p.mediaType, p.id]);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reportStatus, setReportStatus] = useState('');
  const [editingPost, setEditingPost] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(post.caption);
  const [mediaEditor, setMediaEditor] = useState(false);   // photo/video editor modal open
  const [mediaError, setMediaError] = useState('');
  const [mediaBusy, setMediaBusy] = useState(false);
  const videoRef = useRef(null);
  const replaceInputRef = useRef(null);

  const isMine = p.author.id === user.id;

  const toggleLike = async () => {
    if (busy) return;
    setBusy(true);
    const wasLiked = p.likedByMe;
    setP({ ...p, likedByMe: !wasLiked, likeCount: p.likeCount + (wasLiked ? -1 : 1) }); // optimistic
    try {
      const res = wasLiked ? await api.unlike(p.id) : await api.like(p.id);
      setP(res.post);
    } catch {
      setP(p); // revert on failure — never claim a like that didn't actually happen
    } finally {
      setBusy(false);
    }
  };

  const openComments = async () => {
    setShowComments(s => !s);
    if (!comments) {
      const res = await api.getComments(p.id);
      setComments(res.comments);
    }
  };

  const submitComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    const res = await api.addComment(p.id, commentText.trim(), replyTo?.id);
    setComments(c => [...(c || []), res.comment]);
    setCommentText('');
    setReplyTo(null);
    setP({ ...p, commentCount: p.commentCount + 1 });
  };

  const updateComment = (id, updated) => {
    setComments(list => updated === null ? list.filter(c => c.id !== id) : list.map(c => c.id === id ? updated : c));
    if (updated === null) setP(prev => ({ ...prev, commentCount: Math.max(0, prev.commentCount - 1) }));
  };

  const toggleSave = async () => {
    const wasSaved = p.savedByMe;
    setP({ ...p, savedByMe: !wasSaved });
    try {
      wasSaved ? await api.unsavePost(p.id) : await api.savePost(p.id);
    } catch {
      setP(p);
    }
  };

  const reportPost = async () => {
    try {
      await api.report('post', p.id, 'Reported from feed');
      setReportStatus('Reported — thanks for letting us know.');
    } catch (err) {
      setReportStatus(err.message);
    }
  };

  // Only files we host can be re-edited as pixels: an external image URL would taint the
  // canvas (browsers block exporting it), so those can only be replaced with an upload.
  const canEditPixels = p.mediaType === 'image' && p.mediaUrl?.startsWith('/uploads/');
  const canEditMedia = p.mediaType === 'video' || canEditPixels;

  const saveMediaFile = async (file) => {
    setMediaBusy(true); setMediaError('');
    try { setP((await api.replacePostMedia(p.id, file)).post); setMediaEditor(false); }
    catch (err) { setMediaError(err.message); }
    finally { setMediaBusy(false); }
  };
  const saveVideoEdits = async (edits) => {
    setMediaBusy(true); setMediaError('');
    try { setP((await api.editPost(p.id, undefined, edits)).post); setMediaEditor(false); }
    catch (err) { setMediaError(err.message); }
    finally { setMediaBusy(false); }
  };
  const onReplacePicked = (file) => {
    if (!file) return;
    const kind = fileKind(file);
    if (!kind) return setMediaError('Choose a photo (.jpg/.png/.webp/.gif) or a video (.mp4/.webm/.mov).');
    if (file.size > (kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) return setMediaError('That file is too large.');
    saveMediaFile(file);
  };

  const saveEditedPost = async () => {
    const res = await api.editPost(p.id, captionDraft.trim());
    setP(res.post);
    setEditingPost(false);
  };

  // Top-level comments first, then their replies grouped underneath.
  const topLevel = (comments || []).filter(c => !c.parentCommentId);
  const repliesOf = (id) => (comments || []).filter(c => c.parentCommentId === id);

  return (
    <div className="glass-card post-card" ref={containerRef}>
      <div className="post-header" onClick={() => onOpenProfile?.(p.author.username)} style={{ cursor: 'pointer' }}>
        <Avatar user={p.author} size={38} />
        <div>
          <div className="name">{p.author.displayName}</div>
          <div className="time">@{p.author.username} · {timeAgo(p.createdAt)}{p.editedAt && ' · edited'}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          {isMine && <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setEditingPost(e => !e)}>Edit</button>}
          <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={toggleSave}>{p.savedByMe ? '🔖 Saved' : '🔖 Save'}</button>
          {!isMine && <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={reportPost}>Report</button>}
        </div>
      </div>
      {reportStatus && <div className="request-banner" style={{ marginBottom: 10 }}>{reportStatus}</div>}

      {editingPost ? (
        <div style={{ marginBottom: 12 }}>
          <textarea value={captionDraft} onChange={e => setCaptionDraft(e.target.value)} maxLength={2200}
            style={{ width: '100%', minHeight: 60, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, color: 'var(--text-hi)', outline: 'none', fontSize: 14 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn-primary" style={{ width: 'auto', padding: '7px 16px' }} onClick={saveEditedPost}>Save</button>
            <button className="btn-ghost" onClick={() => { setEditingPost(false); setCaptionDraft(p.caption); }}>Cancel</button>
          </div>
          {p.mediaUrl && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {canEditMedia && <button className="btn-ghost" disabled={mediaBusy} onClick={() => setMediaEditor(true)}>✏️ Edit {p.mediaType === 'video' ? 'video' : 'photo'}</button>}
              <button className="btn-ghost" disabled={mediaBusy} onClick={() => replaceInputRef.current?.click()}>Replace file</button>
              <input ref={replaceInputRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov"
                onChange={e => { onReplacePicked(e.target.files?.[0]); e.target.value = ''; }} />
              {mediaBusy && <span style={{ fontSize: 12, color: 'var(--text-mid)' }}>Saving…</span>}
            </div>
          )}
          {mediaError && <div className="error-banner" style={{ marginTop: 8 }}>{mediaError}</div>}
        </div>
      ) : (
        p.caption && <p className="post-caption">{p.caption}</p>
      )}

      {p.mediaUrl && (
        <EditedMedia
          src={p.mediaUrl} type={p.mediaType} edits={p.edits} videoRef={videoRef} controls={p.mediaType === 'video'}
          fit="contain" mediaMaxHeight={560}
          style={{ margin: '0 -4px 12px', borderRadius: 12, background: '#000' }}
        />
      )}

      {mediaEditor && p.mediaType === 'image' && (
        <PhotoEditor src={p.mediaUrl} onCancel={() => setMediaEditor(false)} onDone={saveMediaFile} />
      )}
      {mediaEditor && p.mediaType === 'video' && (
        <VideoEditor src={p.mediaUrl} initialEdits={p.edits} onCancel={() => setMediaEditor(false)} onDone={saveVideoEdits} />
      )}

      <div className="post-actions">
        <button className={p.likedByMe ? 'liked' : ''} onClick={toggleLike}>
          {p.likedByMe ? '♥' : '♡'} {p.likeCount}
        </button>
        <button onClick={openComments}>💬 {p.commentCount}</button>
      </div>
      {showComments && (
        <div className="comments-block">
          {topLevel.map(c => (
            <div key={c.id}>
              <CommentRow comment={c} postId={p.id} postAuthorId={p.author.id} onChanged={(u) => updateComment(c.id, u)} onReply={setReplyTo} />
              {repliesOf(c.id).map(r => (
                <CommentRow key={r.id} comment={r} postId={p.id} postAuthorId={p.author.id} onChanged={(u) => updateComment(r.id, u)} onReply={setReplyTo} depth={1} />
              ))}
            </div>
          ))}
          {comments && topLevel.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-low)' }}>No comments yet.</div>
          )}
          {replyTo && (
            <div style={{ fontSize: 12, color: 'var(--text-mid)', marginBottom: 6 }}>
              Replying to {replyTo.author.displayName} · <button className="btn-ghost" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => setReplyTo(null)}>cancel</button>
            </div>
          )}
          <form className="comment-input-row" onSubmit={submitComment}>
            <input
              placeholder={replyTo ? `Reply to ${replyTo.author.displayName}…` : 'Add a comment…'}
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
            />
          </form>
        </div>
      )}
    </div>
  );
}
