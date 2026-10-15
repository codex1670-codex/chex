import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import * as OTPAuth from 'otpauth';
import db from '../db.js';
import { ACCESS_SECRET, REFRESH_SECRET, ACCESS_TTL, REFRESH_TTL_DAYS, requireAuth } from '../middleware/auth.js';

const router = Router();

const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AVATAR_COLORS = ['#7C5CFF', '#FF5C93', '#26E0C9', '#FFB84D', '#5CA8FF', '#B45CFF'];

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarColor: row.avatar_color,
    avatarPhotoUrl: row.avatar_photo_url,
    profileVideoUrl: row.profile_video_url,
    profileVideoCoverUrl: row.profile_video_cover_url,
    profileVideoMuted: !!row.profile_video_muted,
    displayMode: row.profile_display_mode,
    createdAt: row.created_at,
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueTokens(userId) {
  const accessToken = jwt.sign({ sub: userId }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`
  ).run(uuid(), userId, hashToken(refreshToken), expiresAt);
  return { accessToken, refreshToken };
}

router.post('/signup', (req, res) => {
  const { username, email, password, displayName } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: { code: 'INVALID_USERNAME', message: 'Username must be 3-20 characters: lowercase letters, numbers, "." or "_".' } });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Enter a valid email address.' } });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' } });
  }
  const name = (displayName && String(displayName).trim()) || username;

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: { code: 'ALREADY_EXISTS', message: 'That username or email is already in use.' } });
  }

  const id = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, avatar_color) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, username, email.toLowerCase(), passwordHash, name, avatarColor);

  const tokens = issueTokens(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ user: publicUser(user), ...tokens });
});

router.post('/login', (req, res) => {
  const { identifier, password, totpCode } = req.body || {};
  if (typeof identifier !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Enter your username/email and password.' } });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier.toLowerCase());
  const genericError = { error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect username/email or password.' } };
  if (!user) return res.status(401).json(genericError);
  if (user.account_status !== 'active') {
    return res.status(403).json({ error: { code: 'ACCOUNT_UNAVAILABLE', message: 'This account is not available.' } });
  }
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json(genericError);

  if (user.totp_enabled) {
    if (!totpCode) {
      return res.status(200).json({ requires2FA: true, message: 'Enter your 6-digit authenticator code.' });
    }
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6, period: 30 });
    const delta = totp.validate({ token: String(totpCode).trim(), window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: { code: 'INVALID_2FA', message: 'That code is incorrect or expired.' } });
    }
  }

  const tokens = issueTokens(user.id);
  res.json({ user: publicUser(user), ...tokens });
});

router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Missing refresh token.' } });
  }
  const tokenHash = hashToken(refreshToken);
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash);
  if (!row || row.revoked || new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Session expired. Please log in again.' } });
  }
  // rotate: revoke old, issue new
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
  const tokens = issueTokens(row.user_id);
  res.json(tokens);
});

router.post('/logout', requireAuth, (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken === 'string') {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND user_id = ?')
      .run(hashToken(refreshToken), req.userId);
  } else {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(req.userId);
  }
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  res.json({ user: publicUser(user) });
});

// ---- 2FA (TOTP) ----

router.post('/2fa/setup', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({ issuer: 'NEXA', label: user.username, secret, digits: 6, period: 30 });
  // Stored only once /enable confirms the user's authenticator actually has it —
  // until then it's held in the (unauthenticated-by-itself) response, not activated.
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, req.userId);
  res.json({ secret: secret.base32, otpauthUrl: totp.toString() });
});

router.post('/2fa/enable', requireAuth, (req, res) => {
  const { totpCode } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user.totp_secret) return res.status(400).json({ error: { code: 'NO_SETUP', message: 'Call /2fa/setup first.' } });
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6, period: 30 });
  if (totp.validate({ token: String(totpCode || '').trim(), window: 1 }) === null) {
    return res.status(401).json({ error: { code: 'INVALID_2FA', message: 'That code is incorrect or expired.' } });
  }
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.userId);
  res.json({ ok: true, enabled: true });
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  const { password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect password.' } });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.userId);
  res.json({ ok: true, enabled: false });
});

// ---- Account deactivation / deletion ----

router.post('/deactivate', requireAuth, (req, res) => {
  db.prepare("UPDATE users SET account_status = 'deactivated' WHERE id = ?").run(req.userId);
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(req.userId);
  res.json({ ok: true, status: 'deactivated' });
});

router.post('/reactivate', (req, res) => {
  const { identifier, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, String(identifier || '').toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect username/email or password.' } });
  }
  if (user.account_status !== 'deactivated') {
    return res.status(409).json({ error: { code: 'NOT_DEACTIVATED', message: 'This account is not deactivated.' } });
  }
  db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(user.id);
  db.prepare("UPDATE account_deletions SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(user.id);
  const tokens = issueTokens(user.id);
  res.json({ user: publicUser({ ...user, account_status: 'active' }), ...tokens });
});

const DELETION_GRACE_DAYS = 14;

router.post('/delete-request', requireAuth, (req, res) => {
  const { password, reason } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect password.' } });
  }
  const existing = db.prepare("SELECT * FROM account_deletions WHERE user_id = ? AND status = 'pending'").get(req.userId);
  if (existing) return res.json({ deletion: existing });

  const id = uuid();
  const scheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO account_deletions (id, user_id, reason, scheduled_at) VALUES (?, ?, ?, ?)')
    .run(id, req.userId, typeof reason === 'string' ? reason.slice(0, 500) : null, scheduledAt);
  db.prepare("UPDATE users SET account_status = 'deactivated' WHERE id = ?").run(req.userId);
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(req.userId);
  const deletion = db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(id);
  res.json({ deletion, message: `Your account will be permanently deleted on ${scheduledAt.slice(0, 10)} unless you use "reactivate" with your credentials before then to cancel.` });
});

router.post('/delete-cancel', requireAuth, (req, res) => {
  db.prepare("UPDATE account_deletions SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(req.userId);
  db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(req.userId);
  res.json({ ok: true });
});

export { publicUser };
export default router;
