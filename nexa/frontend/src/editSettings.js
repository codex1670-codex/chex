// Shared helpers for media editing. Keep the numeric ranges in sync with sanitizeEdits()
// in backend/src/uploads.js (the server clamps everything again before storing).

export const DEFAULT_FILTER = { brightness: 1, contrast: 1, saturate: 1, grayscale: 0, sepia: 0, blur: 0, hue: 0 };

export const defaultEdits = () => ({
  filter: { ...DEFAULT_FILTER }, trimStart: 0, trimEnd: null, speed: 1, muted: false, overlays: [],
});

// One-tap looks, shown in both the photo and video editors.
export const FILTER_PRESETS = [
  { name: 'Original', filter: {} },
  { name: 'Vivid', filter: { saturate: 1.5, contrast: 1.1 } },
  { name: 'Warm', filter: { sepia: 0.3, saturate: 1.2, brightness: 1.05 } },
  { name: 'Cool', filter: { hue: -15, saturate: 1.1, brightness: 1.03 } },
  { name: 'Mono', filter: { grayscale: 1, contrast: 1.1 } },
  { name: 'Vintage', filter: { sepia: 0.6, contrast: 0.9, brightness: 1.05 } },
  { name: 'Fade', filter: { contrast: 0.85, brightness: 1.1, saturate: 0.8 } },
  { name: 'Drama', filter: { contrast: 1.4, saturate: 0.9, brightness: 0.95 } },
];

export const SLIDERS = [
  { key: 'brightness', label: 'Brightness', min: 0.3, max: 2, step: 0.01, def: 1 },
  { key: 'contrast', label: 'Contrast', min: 0.3, max: 2, step: 0.01, def: 1 },
  { key: 'saturate', label: 'Saturation', min: 0, max: 3, step: 0.01, def: 1 },
  { key: 'sepia', label: 'Sepia', min: 0, max: 1, step: 0.01, def: 0 },
  { key: 'grayscale', label: 'Black & white', min: 0, max: 1, step: 0.01, def: 0 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, def: 0 },
  { key: 'blur', label: 'Blur', min: 0, max: 10, step: 0.1, def: 0 },
];

export const mergeFilter = (f) => ({ ...DEFAULT_FILTER, ...(f || {}) });

// CSS `filter` string — built only from numbers, so it's safe to put in a style attribute.
export function filterCss(filter) {
  const f = mergeFilter(filter);
  const parts = [];
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturate !== 1) parts.push(`saturate(${f.saturate})`);
  if (f.sepia) parts.push(`sepia(${f.sepia})`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale})`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.blur) parts.push(`blur(${f.blur}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// Seconds a viewer actually sees: trim window divided by speed.
export function playedSeconds(edits, duration) {
  const start = edits?.trimStart || 0;
  const end = edits?.trimEnd ?? duration;
  if (!end && end !== 0) return null;
  return Math.max(0, end - start) / (edits?.speed || 1);
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Posts and stories: any video size (Infinity = no cap). Reels keep 50MB.
export const MAX_VIDEO_BYTES = Infinity;
export const MAX_REEL_BYTES = 50 * 1024 * 1024;
export const MAX_STORY_SECONDS = null; // no story length cap

const EXT_KIND = { jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', mp4: 'video', webm: 'video', mov: 'video' };
// Downloaded files often have an empty/generic MIME type, so fall back to the extension.
export function fileKind(file) {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (VIDEO_TYPES.includes(file.type)) return 'video';
  return EXT_KIND[(file.name.split('.').pop() || '').toLowerCase()] || null;
}
