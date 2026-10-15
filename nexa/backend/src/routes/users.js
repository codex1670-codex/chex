import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { nicknameForProfile, setNicknameForProfile, deleteNicknamesForProfile } from '../nicknames.js';
import db from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { v4 as uuid } from 'uuid';
import { generateText } from '../localAI.js';
import { avatarUpload, profileVideoUpload, checkVideoDurationSeconds, MAX_AVATAR_UPLOAD_BYTES, MAX_PROFILE_VIDEO_BYTES, MAX_PROFILE_VIDEO_SECONDS, UPLOADS_ROOT } from '../uploads.js';

const router = Router();

function isBlocked(a, b) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .get(a, b, b, a);
}

function nicknameFor(viewerId, targetId) {
  if (!viewerId || viewerId === targetId) return null;
  return nicknameForProfile(viewerId, targetId);
}

// Profile Studio settings are stored as JSON text; always return a sanitized object so a
// corrupt row can never break a profile page.
const STUDIO_BG_KINDS = ['theme', 'grad', 'color', 'clip', 'profile'];
function sanitizeStudio(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const bg = s.bg && typeof s.bg === 'object' ? s.bg : {};
  const kind = STUDIO_BG_KINDS.includes(bg.kind) ? bg.kind : 'theme';
  let value = null;
  if (kind === 'grad') value = int(bg.value, 0, 6, 0);
  if (kind === 'clip') value = int(bg.value, 1, 19, 1);
  if (kind === 'color') value = typeof bg.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(bg.value) ? bg.value : '#6a4cff';
  return { theme: int(s.theme, 0, 7, 0), bg: { kind, value }, dim: int(s.dim, 0, 90, 35), blur: int(s.blur, 0, 24, 0) };
}
function parseStudio(text) {
  try { return sanitizeStudio(text ? JSON.parse(text) : null); } catch { return sanitizeStudio(null); }
}

function profileFor(user, viewerId) {
  const followerCount = db.prepare('SELECT COUNT(*) c FROM follows WHERE followed_id = ?').get(user.id).c;
  const followingCount = db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(user.id).c;
  const postCount = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id = ? AND deleted_at IS NULL').get(user.id).c;
  const isFollowing = viewerId ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?').get(viewerId, user.id) : false;
  const isSelf = viewerId === user.id;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio,
    avatarColor: user.avatar_color,
    avatarPhotoUrl: user.avatar_photo_url,
    profileVideoUrl: user.profile_video_url,
    profileVideoCoverUrl: user.profile_video_cover_url,
    profileVideoMuted: !!user.profile_video_muted,
    displayMode: user.profile_display_mode,
    studio: parseStudio(user.profile_studio),
    followerCount, followingCount, postCount,
    isFollowing, isSelf,
    // Section 190 — Nickname: a private label only the viewer sees, never returned when
    // viewing your own profile (isSelf) since it wouldn't mean anything there.
    nickname: nicknameFor(viewerId, user.id),
  };
}

router.get('/:username', optionalAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user || user.account_status !== 'active') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  if (req.userId && isBlocked(req.userId, user.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  res.json({ user: profileFor(user, req.userId) });
});

router.patch('/me', requireAuth, (req, res) => {
  const { displayName, bio } = req.body || {};
  const fields = [];
  const values = [];
  if (typeof displayName === 'string' && displayName.trim()) { fields.push('display_name = ?'); values.push(displayName.trim().slice(0, 60)); }
  if (typeof bio === 'string') { fields.push('bio = ?'); values.push(bio.slice(0, 300)); }
  if (!fields.length) return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Nothing to update.' } });
  values.push(req.userId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: profileFor(user, req.userId) });
});

// Profile Studio look (theme, background, dim, blur). Saved on the server so everyone who
// opens this profile sees it. Photo/video themselves go through the existing upload routes.
router.patch('/me/studio', requireAuth, (req, res) => {
  const studio = sanitizeStudio(req.body);
  db.prepare('UPDATE users SET profile_studio = ? WHERE id = ?').run(JSON.stringify(studio), req.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: profileFor(user, req.userId) });
});

// Codex bio actions: Write / Improve / Professional / Shorter / Translate.
// Runs on the built-in local engine (localAI.js) — no API key, no external service.
// Never auto-saves; the user reviews the suggestion and saves via PATCH /users/me themselves.
router.post('/me/bio/ai', requireAuth, async (req, res) => {
  const { action, currentBio, targetLanguage } = req.body || {};
  const valid = ['write', 'improve', 'professional', 'shorter', 'translate'];
  if (!valid.includes(action)) {
    return res.status(400).json({ error: { code: 'INVALID_ACTION', message: `action must be one of: ${valid.join(', ')}` } });
  }
  const bio = typeof currentBio === 'string' ? currentBio.slice(0, 300) : '';
  if (action !== 'write' && !bio.trim()) {
    return res.status(400).json({ error: { code: 'EMPTY_BIO', message: 'Write a bio first, then I can help improve it.' } });
  }
  const result = await generateText({ action, bio, targetLanguage });
  if (!result.ok) return res.status(500).json({ error: { code: 'AI_ERROR', message: 'Could not generate a suggestion. Please try again.' } });
  res.json({ suggestion: result.text.replace(/^["']|["']$/g, '').slice(0, 300) });
});

// Section 127 — Profile Photo. Deliberately scoped to upload/remove only: crop, zoom,
// rotate, and reposition are pure client-side canvas editing (no server work needed) and
// aren't implemented in this pass, so the composer sends the already-final image as-is.
function deleteFileQuietly(url) {
  if (!url) return;
  const abs = path.join(UPLOADS_ROOT, url.replace(/^\/uploads\//, ''));
  fs.unlink(abs, () => {}); // best-effort — a missing file is not an error worth surfacing
}

router.post('/me/avatar-photo', requireAuth, (req, res) => {
  avatarUpload.single('photo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: { code: 'FILE_TOO_LARGE', message: `Photos must be under ${Math.round(MAX_AVATAR_UPLOAD_BYTES / (1024 * 1024))}MB.` } });
      }
      if (err.message === 'UNSUPPORTED_IMAGE_TYPE') {
        return res.status(400).json({ error: { code: 'UNSUPPORTED_IMAGE_TYPE', message: 'Upload a .jpg, .png, or .webp image.' } });
      }
      return res.status(400).json({ error: { code: 'UPLOAD_FAILED', message: 'Upload failed. Please try again.' } });
    }
    if (!req.file) return res.status(400).json({ error: { code: 'NO_FILE', message: 'Choose a photo to upload.' } });
    const prior = db.prepare('SELECT avatar_photo_url FROM users WHERE id = ?').get(req.userId);
    const url = `/uploads/avatars/${req.file.filename}`;
    db.prepare("UPDATE users SET avatar_photo_url = ?, profile_display_mode = 'photo' WHERE id = ?").run(url, req.userId);
    deleteFileQuietly(prior?.avatar_photo_url);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    res.status(201).json({ user: profileFor(user, req.userId) });
  });
});

router.delete('/me/avatar-photo', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  deleteFileQuietly(user.avatar_photo_url);
  const nextMode = user.profile_display_mode === 'photo' ? 'color' : user.profile_display_mode;
  db.prepare("UPDATE users SET avatar_photo_url = NULL, profile_display_mode = ? WHERE id = ?").run(nextMode, req.userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: profileFor(updated, req.userId) });
});

// Section 128 — Profile Video. The ≤40s rule is enforced client-side (the browser
// measures the real <video> element's .duration before ever uploading — see the Profile
// Video editor), with a best-effort server-side ffprobe re-check when that binary
// happens to be available (see checkVideoDurationSeconds); this build has no transcode
// pipeline, so there's no separate async "processing" stage — the upload request itself
// is the only real work, and the video is 'ready' the moment that request succeeds.
router.post('/me/profile-video', requireAuth, (req, res) => {
  profileVideoUpload(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: { code: 'FILE_TOO_LARGE', message: `Profile videos must be under ${Math.round(MAX_PROFILE_VIDEO_BYTES / (1024 * 1024))}MB.` } });
      }
      if (err.message === 'UNSUPPORTED_VIDEO_TYPE') {
        return res.status(400).json({ error: { code: 'UNSUPPORTED_VIDEO_TYPE', message: 'Upload an .mp4, .webm, or .mov video file.' } });
      }
      if (err.message === 'UNSUPPORTED_IMAGE_TYPE') {
        return res.status(400).json({ error: { code: 'UNSUPPORTED_IMAGE_TYPE', message: 'The cover frame must be a .jpg, .png, or .webp image.' } });
      }
      return res.status(400).json({ error: { code: 'UPLOAD_FAILED', message: 'Upload failed. Please try again.' } });
    }
    const videoFile = req.files?.video?.[0];
    const coverFile = req.files?.cover?.[0];
    if (!videoFile) return res.status(400).json({ error: { code: 'NO_FILE', message: 'Choose a video to upload.' } });

    const measured = await checkVideoDurationSeconds(videoFile.path);
    if (measured !== null && measured > MAX_PROFILE_VIDEO_SECONDS + 0.5) { // small grace margin for encoder rounding
      fs.unlink(videoFile.path, () => {});
      if (coverFile) fs.unlink(coverFile.path, () => {});
      return res.status(400).json({ error: { code: 'VIDEO_TOO_LONG', message: `That video is about ${measured.toFixed(1)}s — profile videos must be ${MAX_PROFILE_VIDEO_SECONDS} seconds or under. Trim it and try again.` } });
    }

    const prior = db.prepare('SELECT profile_video_url, profile_video_cover_url FROM users WHERE id = ?').get(req.userId);
    const videoUrl = `/uploads/profile-videos/${videoFile.filename}`;
    const coverUrl = coverFile ? `/uploads/avatars/${coverFile.filename}` : null;
    const muted = req.body?.muted === 'true' || req.body?.muted === '1';
    db.prepare(`
      UPDATE users SET profile_video_url = ?, profile_video_cover_url = ?, profile_video_muted = ?, profile_display_mode = 'video' WHERE id = ?
    `).run(videoUrl, coverUrl, muted ? 1 : 0, req.userId);
    deleteFileQuietly(prior?.profile_video_url);
    deleteFileQuietly(prior?.profile_video_cover_url);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    res.status(201).json({ user: profileFor(user, req.userId) });
  });
});

router.delete('/me/profile-video', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  deleteFileQuietly(user.profile_video_url);
  deleteFileQuietly(user.profile_video_cover_url);
  const nextMode = user.profile_display_mode === 'video' ? (user.avatar_photo_url ? 'photo' : 'color') : user.profile_display_mode;
  db.prepare(`
    UPDATE users SET profile_video_url = NULL, profile_video_cover_url = NULL, profile_video_muted = 0, profile_display_mode = ? WHERE id = ?
  `).run(nextMode, req.userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: profileFor(updated, req.userId) });
});

// Section 128 — "Allow the user to switch between them" (static photo vs. profile
// video). Only ever allowed onto a mode that's actually backed by real uploaded media —
// this is what keeps "switch to video" from silently becoming a broken, empty state.
router.patch('/me/display-mode', requireAuth, (req, res) => {
  const { mode } = req.body || {};
  if (!['color', 'photo', 'video'].includes(mode)) {
    return res.status(400).json({ error: { code: 'INVALID_MODE', message: "mode must be 'color', 'photo', or 'video'." } });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (mode === 'photo' && !user.avatar_photo_url) {
    return res.status(400).json({ error: { code: 'NO_PHOTO', message: 'Upload a profile photo first.' } });
  }
  if (mode === 'video' && !user.profile_video_url) {
    return res.status(400).json({ error: { code: 'NO_VIDEO', message: 'Upload a profile video first.' } });
  }
  db.prepare('UPDATE users SET profile_display_mode = ? WHERE id = ?').run(mode, req.userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: profileFor(updated, req.userId) });
});

// Section 190 — Nickname: set/remove a private label for someone else's profile. Only
// the owner (req.userId) can ever see or change their own nicknames for other people —
// there is no way to read someone else's nickname list, and setting one never notifies
// or is visible to the target user.
router.put('/:username/nickname', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (target.id === req.userId) return res.status(400).json({ error: { code: 'INVALID_ACTION', message: "You can't set a nickname for yourself." } });
  if (isBlocked(req.userId, target.id)) return res.status(403).json({ error: { code: 'BLOCKED', message: 'Unable to set a nickname for this user.' } });

  try {
    setNicknameForProfile(req.userId, target, req.body?.nickname);
  } catch (e) {
    return res.status(e.code === 'NICKNAME_TAKEN' ? 409 : 400).json({ error: { code: e.code || 'INVALID_INPUT', message: e.message } });
  }

  res.json({ user: profileFor(target, req.userId) });
});

router.delete('/:username/nickname', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  deleteNicknamesForProfile(req.userId, target.id);
  res.json({ user: profileFor(target, req.userId) });
});

router.post('/:username/follow', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (target.id === req.userId) return res.status(400).json({ error: { code: 'INVALID_ACTION', message: "You can't follow yourself." } });
  if (isBlocked(req.userId, target.id)) return res.status(403).json({ error: { code: 'BLOCKED', message: 'Unable to follow this user.' } });

  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)').run(req.userId, target.id);
  db.prepare('INSERT INTO notifications (id, recipient_id, actor_id, type) VALUES (?, ?, ?, ?)')
    .run(uuid(), target.id, req.userId, 'follow');
  req.app.get('io')?.to(`user:${target.id}`).emit('notification:new', { type: 'follow' });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  res.json({ user: profileFor(updated, req.userId) });
});

router.delete('/:username/follow', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?').run(req.userId, target.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  res.json({ user: profileFor(updated, req.userId) });
});

router.get('/:username/followers', optionalAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  const list = db.prepare(`
    SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.followed_id = ? ORDER BY f.created_at DESC LIMIT 50
  `).all(target.id);
  res.json({ users: list.map(u => profileFor(u, req.userId)) });
});

router.get('/:username/following', optionalAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  const list = db.prepare(`
    SELECT u.* FROM follows f JOIN users u ON u.id = f.followed_id
    WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 50
  `).all(target.id);
  res.json({ users: list.map(u => profileFor(u, req.userId)) });
});

router.get('/', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  const list = db.prepare(`
    SELECT * FROM users WHERE account_status = 'active' AND (username LIKE ? OR display_name LIKE ?)
    AND id != ? LIMIT 10
  `).all(`%${q}%`, `%${q}%`, req.userId);
  res.json({ users: list.map(u => profileFor(u, req.userId)) });
});

router.get('/me/close-friends', requireAuth, (req, res) => {
  const list = db.prepare(`
    SELECT u.* FROM close_friends cf JOIN users u ON u.id = cf.friend_id
    WHERE cf.owner_id = ? ORDER BY cf.created_at DESC
  `).all(req.userId);
  res.json({ users: list.map(u => profileFor(u, req.userId)) });
});

router.post('/:username/close-friend', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (target.id === req.userId) return res.status(400).json({ error: { code: 'INVALID_ACTION', message: "You can't add yourself." } });
  db.prepare('INSERT OR IGNORE INTO close_friends (owner_id, friend_id) VALUES (?, ?)').run(req.userId, target.id);
  res.json({ ok: true });
});

router.delete('/:username/close-friend', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  db.prepare('DELETE FROM close_friends WHERE owner_id = ? AND friend_id = ?').run(req.userId, target.id);
  res.json({ ok: true });
});

router.post('/:username/restrict', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (target.id === req.userId) return res.status(400).json({ error: { code: 'INVALID_ACTION', message: "You can't restrict yourself." } });
  db.prepare('INSERT OR IGNORE INTO restricts (owner_id, restricted_id) VALUES (?, ?)').run(req.userId, target.id);
  res.json({ ok: true, restricted: true });
});

router.delete('/:username/restrict', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  db.prepare('DELETE FROM restricts WHERE owner_id = ? AND restricted_id = ?').run(req.userId, target.id);
  res.json({ ok: true, restricted: false });
});

router.post('/:username/block', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (target.id === req.userId) return res.status(400).json({ error: { code: 'INVALID_ACTION', message: "You can't block yourself." } });
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.userId, target.id);
  db.prepare('DELETE FROM follows WHERE (follower_id = ? AND followed_id = ?) OR (follower_id = ? AND followed_id = ?)')
    .run(req.userId, target.id, target.id, req.userId);
  res.json({ ok: true, blocked: true });
});

router.delete('/:username/block', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.userId, target.id);
  res.json({ ok: true, blocked: false });
});

function isRestricted(ownerId, restrictedId) {
  return !!db.prepare('SELECT 1 FROM restricts WHERE owner_id = ? AND restricted_id = ?').get(ownerId, restrictedId);
}

router.post('/:username/mute', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (target.id === req.userId) return res.status(400).json({ error: { code: 'INVALID_ACTION', message: "You can't mute yourself." } });
  db.prepare('INSERT OR IGNORE INTO mutes (muter_id, muted_id) VALUES (?, ?)').run(req.userId, target.id);
  res.json({ ok: true, muted: true });
});

router.delete('/:username/mute', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  db.prepare('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?').run(req.userId, target.id);
  res.json({ ok: true, muted: false });
});

function isMuted(muterId, mutedId) {
  return !!db.prepare('SELECT 1 FROM mutes WHERE muter_id = ? AND muted_id = ?').get(muterId, mutedId);
}

export { profileFor, isBlocked, isRestricted, isMuted };
export default router;
