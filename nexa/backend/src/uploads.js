import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { spawn } from 'child_process';

// Real file uploads (photos-app "choose from gallery / camera / downloaded file" style),
// stored on local disk under backend/uploads and served back via express.static in
// index.js. This is a single-server local-disk store — fine for this vertical slice's
// dev/demo deployment, but a real production deployment would want object storage
// (S3/GCS/etc.) behind a CDN instead of writing to the app server's own disk.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const REELS_DIR = path.join(UPLOADS_ROOT, 'reels');
fs.mkdirSync(REELS_DIR, { recursive: true });

const ALLOWED_VIDEO_MIME = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
export const MAX_REEL_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — sized for short clips, not general video hosting

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, REELS_DIR),
  filename: (_req, file, cb) => {
    const ext = ALLOWED_VIDEO_MIME[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${uuid()}${ext}`);
  },
});

export const reelUpload = multer({
  storage,
  limits: { fileSize: MAX_REEL_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_VIDEO_MIME[file.mimetype]) return cb(new Error('UNSUPPORTED_VIDEO_TYPE'));
    cb(null, true);
  },
});

// Section 127/128 — profile photo + profile video uploads. Same local-disk approach as
// reels above, just separate subfolders and (for images) a smaller size cap.
const AVATARS_DIR = path.join(UPLOADS_ROOT, 'avatars');
const PROFILE_VIDEOS_DIR = path.join(UPLOADS_ROOT, 'profile-videos');
fs.mkdirSync(AVATARS_DIR, { recursive: true });
fs.mkdirSync(PROFILE_VIDEOS_DIR, { recursive: true });

const ALLOWED_IMAGE_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB — a still photo, not a video

export const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
    filename: (_req, file, cb) => cb(null, `${uuid()}${ALLOWED_IMAGE_MIME[file.mimetype] || '.jpg'}`),
  }),
  limits: { fileSize: MAX_AVATAR_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME[file.mimetype]) return cb(new Error('UNSUPPORTED_IMAGE_TYPE'));
    cb(null, true);
  },
});

export const MAX_PROFILE_VIDEO_SECONDS = 40;
export const MAX_PROFILE_VIDEO_BYTES = 150 * 1024 * 1024; // safety net only — the 40s rule is the real limit

// Accepts two files in one request: 'video' (the clip) and 'cover' (the chosen cover
// frame, captured client-side from the video and sent as a still image) — see
// POST /users/me/profile-video in routes/users.js.
export const profileVideoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, file, cb) => cb(null, file.fieldname === 'cover' ? AVATARS_DIR : PROFILE_VIDEOS_DIR),
    filename: (_req, file, cb) => {
      const table = file.fieldname === 'cover' ? ALLOWED_IMAGE_MIME : ALLOWED_VIDEO_MIME;
      cb(null, `${uuid()}${table[file.mimetype] || (file.fieldname === 'cover' ? '.jpg' : '.mp4')}`);
    },
  }),
  limits: { fileSize: MAX_PROFILE_VIDEO_BYTES, files: 2 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'cover') {
      if (!ALLOWED_IMAGE_MIME[file.mimetype]) return cb(new Error('UNSUPPORTED_IMAGE_TYPE'));
    } else if (!ALLOWED_VIDEO_MIME[file.mimetype]) {
      return cb(new Error('UNSUPPORTED_VIDEO_TYPE'));
    }
    cb(null, true);
  },
}).fields([{ name: 'video', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

// Best-effort server-side duration check for the "≤40 seconds" profile-video rule. The real
// enforcement is client-side (the browser measures the actual <video> element's
// .duration before ever uploading — see the Profile Video editor), because that's the
// only measurement guaranteed to be available everywhere. This is a defense-in-depth
// second check that only runs if `ffprobe` happens to be on the server's PATH; if it
// isn't, we skip it rather than pretend to enforce something we can't actually check —
// no fake validation, no silently-wrong "verified" claim.
export function checkVideoDurationSeconds(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    } catch {
      return resolve(null); // ffprobe not installed — can't check, don't block the upload
    }
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const seconds = parseFloat(out.trim());
      resolve(Number.isFinite(seconds) ? seconds : null);
    });
  });
}

// ---------------------------------------------------------------------------------------
// Unified media pipeline for posts, stories and reels: photos AND videos picked from the
// device (gallery, camera, or any downloaded file). Used by routes/posts.js, stories.js
// and reels.js so all three enforce the same limits and the same safety checks.
// ---------------------------------------------------------------------------------------
const MEDIA_MIME = {
  'image/jpeg': { ext: '.jpg', kind: 'image' },
  'image/png': { ext: '.png', kind: 'image' },
  'image/webp': { ext: '.webp', kind: 'image' },
  'image/gif': { ext: '.gif', kind: 'image' },
  'video/mp4': { ext: '.mp4', kind: 'video' },
  'video/webm': { ext: '.webm', kind: 'video' },
  'video/quicktime': { ext: '.mov', kind: 'video' },
};
// Downloaded files frequently arrive as application/octet-stream or with an empty type, so
// fall back to the extension; the magic-byte sniff below still decides what's really inside.
const EXT_TO_INFO = Object.fromEntries(Object.values(MEDIA_MIME).map(i => [i.ext, i]));
EXT_TO_INFO['.jpeg'] = EXT_TO_INFO['.jpg'];
const mediaInfoFor = (file) => MEDIA_MIME[file.mimetype] || EXT_TO_INFO[path.extname(file.originalname || '').toLowerCase()] || null;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Posts and stories accept videos of any size (no byte cap). Reels keep a 50MB cap.
export const MAX_VIDEO_BYTES = null;
export const MAX_REEL_VIDEO_BYTES = 50 * 1024 * 1024;
// Stories have no playback-length cap either (null = unlimited).
export const MAX_STORY_VIDEO_SECONDS = null;

// The browser-supplied Content-Type is attacker-controlled, so we also read the file's
// real header bytes and only accept it if they match a media format we serve.
export function sniffMediaKind(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    const ascii = (a, b) => buf.toString('latin1', a, b);
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image';
    if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image';
    if (ascii(0, 3) === 'GIF') return 'image';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image';
    if (ascii(4, 8) === 'ftyp') return 'video'; // mp4 / mov
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video'; // webm/mkv
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Express middleware factory. `subdir` is the folder under /uploads, `allow` is the set of
 * accepted kinds (['image','video'] or ['video']). On success sets
 *   req.media = { url, kind, filePath, bytes }
 * and leaves any other multipart text fields (caption, edits, audience…) on req.body.
 */
export function mediaMiddleware(subdir, allow = ['image', 'video'], { maxVideoBytes = MAX_VIDEO_BYTES } = {}) {
  const dir = path.join(UPLOADS_ROOT, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const uploader = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => cb(null, `${uuid()}${mediaInfoFor(file)?.ext || '.bin'}`),
    }),
    // No byte limit when maxVideoBytes is null (posts/stories). Photos are still capped at
    // MAX_IMAGE_BYTES by the post-upload check below.
    limits: { files: 1, ...(maxVideoBytes ? { fileSize: maxVideoBytes } : {}) },
    fileFilter: (_req, file, cb) => {
      const info = mediaInfoFor(file);
      if (!info || !allow.includes(info.kind)) return cb(new Error('UNSUPPORTED_MEDIA_TYPE'));
      cb(null, true);
    },
  }).single('media');

  const fail = (res, code, message) => res.status(400).json({ error: { code, message } });
  const allowedLabel = allow.length === 2 ? 'a photo (.jpg/.png/.webp/.gif) or video (.mp4/.webm/.mov)' : 'a video (.mp4/.webm/.mov)';

  return (req, res, next) => uploader(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 'FILE_TOO_LARGE', `Videos must be under ${Math.round(maxVideoBytes / (1024 * 1024))}MB.`);
      if (err.message === 'UNSUPPORTED_MEDIA_TYPE') return fail(res, 'UNSUPPORTED_MEDIA_TYPE', `Upload ${allowedLabel}.`);
      return fail(res, 'UPLOAD_FAILED', 'Upload failed. Please try again.');
    }
    if (!req.file) return fail(res, 'NO_FILE', 'Choose a file to upload.');
    const claimed = mediaInfoFor(req.file).kind;
    const real = sniffMediaKind(req.file.path);
    if (real !== claimed) {
      fs.unlink(req.file.path, () => {});
      return fail(res, 'INVALID_MEDIA', "That file doesn't look like a real photo or video.");
    }
    if (claimed === 'image' && req.file.size > MAX_IMAGE_BYTES) {
      fs.unlink(req.file.path, () => {});
      return fail(res, 'FILE_TOO_LARGE', `Photos must be under ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`);
    }
    req.media = { url: `/uploads/${subdir}/${req.file.filename}`, kind: claimed, filePath: req.file.path, bytes: req.file.size };
    next();
  });
}

// Delete a previously uploaded local file (used when media is replaced). Only ever touches
// paths inside UPLOADS_ROOT — external URLs and anything that resolves outside are ignored.
export function removeLocalUpload(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const full = path.resolve(UPLOADS_ROOT, url.slice('/uploads/'.length));
  if (!full.startsWith(UPLOADS_ROOT + path.sep)) return;
  fs.unlink(full, () => {});
}

// ---------------------------------------------------------------------------------------
// Non-destructive video edit settings. Videos are not re-encoded (this server has no
// transcode pipeline) — instead the creator's edits are stored as a small JSON document and
// applied at playback time by every viewer: trim window, playback speed, mute, a CSS
// colour filter, and text overlays. That also means a video can be re-edited any time after
// posting without losing the original. Everything is clamped/whitelisted here, so the client
// only ever receives numbers and plain strings it renders as text — never markup or CSS.
// ---------------------------------------------------------------------------------------
const clamp = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function sanitizeEdits(input) {
  if (input === undefined || input === null || input === '') return null;
  let e = input;
  if (typeof e === 'string') {
    try { e = JSON.parse(e); } catch { return null; }
  }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;

  const f = e.filter && typeof e.filter === 'object' ? e.filter : {};
  const out = {
    filter: {
      brightness: clamp(f.brightness, 0.3, 2, 1),
      contrast: clamp(f.contrast, 0.3, 2, 1),
      saturate: clamp(f.saturate, 0, 3, 1),
      grayscale: clamp(f.grayscale, 0, 1, 0),
      sepia: clamp(f.sepia, 0, 1, 0),
      blur: clamp(f.blur, 0, 10, 0),
      hue: clamp(f.hue, -180, 180, 0),
    },
    trimStart: clamp(e.trimStart, 0, 3600, 0),
    trimEnd: null,
    speed: clamp(e.speed, 0.25, 4, 1),
    muted: !!e.muted,
    overlays: [],
  };
  if (e.trimEnd !== null && e.trimEnd !== undefined) {
    const end = clamp(e.trimEnd, 0, 3600, null);
    if (end !== null && end >= out.trimStart + 0.5) out.trimEnd = end;
  }
  if (Array.isArray(e.overlays)) {
    for (const o of e.overlays.slice(0, 10)) {
      const text = typeof o?.text === 'string' ? o.text.trim().slice(0, 80) : '';
      if (!text) continue;
      out.overlays.push({
        text,
        x: clamp(o.x, 0, 100, 50),
        y: clamp(o.y, 0, 100, 50),
        size: clamp(o.size, 10, 80, 28),
        color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#ffffff',
        bg: !!o.bg,
      });
    }
  }
  return out;
}

export const editsToJson = (input) => {
  const clean = sanitizeEdits(input);
  return clean ? JSON.stringify(clean) : null;
};
export const parseEdits = (json) => {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
};

// Length of the segment viewers will actually see, in seconds: (trimEnd - trimStart) / speed.
// Returns null when the end isn't known (no trimEnd set and no probed duration).
export function playedSeconds(edits, fullDuration) {
  const start = edits?.trimStart || 0;
  const end = edits?.trimEnd ?? fullDuration;
  if (end === null || end === undefined) return null;
  return Math.max(0, end - start) / (edits?.speed || 1);
}
