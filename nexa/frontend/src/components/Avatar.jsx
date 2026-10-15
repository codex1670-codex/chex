import { useState } from 'react';
import FullscreenMediaViewer from './FullscreenMediaViewer.jsx';

// Renders a user's identity everywhere in the app: a plain color+initial circle by
// default, or — whenever that user has switched their profile to show a photo or a
// video — the same photo/video shown on their own Profile page. Pass the whole
// author/user object as `user` (it carries displayMode, avatarPhotoUrl,
// profileVideoUrl, etc.) so every place a user's identity appears (posts, comments,
// notifications, messages, game rooms, stories, notes, search, ...) stays in sync the
// moment they change their profile media — no per-call-site plumbing needed.
//
// Pass `fullscreenOnClick` to make a real photo/video open in a fullscreen viewer when
// clicked (used on the Profile page's own header avatar). Clicks are stopped from
// bubbling so this never fights with a surrounding row's own onClick (e.g. "open this
// story" / "open this profile").
export default function Avatar({ name, color = '#7C5CFF', size = 40, photoUrl = null, user = null, fullscreenOnClick = false }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const displayName = name ?? user?.displayName;
  const initial = (displayName || '?').trim().charAt(0).toUpperCase();
  const avatarColor = user?.avatarColor ?? color;
  const mode = user?.displayMode || (photoUrl ? 'photo' : 'color');

  const isVideo = mode === 'video' && !!user?.profileVideoUrl;
  const resolvedPhotoUrl = mode === 'photo' ? (user?.avatarPhotoUrl || photoUrl) : (photoUrl && !user ? photoUrl : null);
  const hasMedia = isVideo || !!resolvedPhotoUrl;
  const clickable = fullscreenOnClick && hasMedia;

  const openViewer = (e) => {
    if (!clickable) return;
    e.stopPropagation();
    setViewerOpen(true);
  };

  const viewer = viewerOpen && (
    <FullscreenMediaViewer
      mediaType={isVideo ? 'video' : 'photo'}
      url={isVideo ? user.profileVideoUrl : resolvedPhotoUrl}
      posterUrl={isVideo ? user.profileVideoCoverUrl : undefined}
      name={displayName}
      onClose={() => setViewerOpen(false)}
    />
  );

  if (isVideo) {
    return (
      <>
        <video
          src={user.profileVideoUrl}
          poster={user.profileVideoCoverUrl || undefined}
          muted={user.profileVideoMuted !== false}
          loop
          autoPlay
          playsInline
          className={`avatar${clickable ? ' avatar-clickable' : ''}`}
          style={{ width: size, height: size, objectFit: 'cover', background: avatarColor }}
          onClick={openViewer}
        />
        {viewer}
      </>
    );
  }

  if (resolvedPhotoUrl) {
    return (
      <>
        <img
          src={resolvedPhotoUrl}
          alt={displayName || 'avatar'}
          className={`avatar${clickable ? ' avatar-clickable' : ''}`}
          style={{ width: size, height: size, objectFit: 'cover', background: avatarColor }}
          onClick={openViewer}
        />
        {viewer}
      </>
    );
  }

  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: avatarColor, fontSize: size * 0.42 }}
    >
      {initial}
    </div>
  );
}
