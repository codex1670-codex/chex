import { useEffect } from 'react';

// Fullscreen lightbox for a profile photo or profile video. Opened by clicking an
// Avatar that has `fullscreenOnClick` set and real media behind it (see Avatar.jsx).
// Closes on backdrop click, the × button, or Escape.
export default function FullscreenMediaViewer({ mediaType, url, posterUrl, name, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="media-viewer-overlay" onClick={onClose}>
      <button className="media-viewer-close" onClick={onClose} aria-label="Close">✕</button>
      <div className="media-viewer-content" onClick={e => e.stopPropagation()}>
        {mediaType === 'video' ? (
          <video
            src={url}
            poster={posterUrl || undefined}
            controls
            autoPlay
            loop
            playsInline
            className="media-viewer-media"
          />
        ) : (
          <img src={url} alt={name || 'Profile photo'} className="media-viewer-media" />
        )}
      </div>
    </div>
  );
}
