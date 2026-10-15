// Private profile nicknames (Codex spec §3, §4, §11, §13).
//
// A nickname is a label the OWNER saves for another profile ("Rahul -> Bestie"). It is
// private (only the owner can read it), case-insensitive, unique per owner, invisible to
// the target, and never a replacement for username/display name.
//
// Codex never uses a nickname as a database target. Every nickname is first resolved to a
// target_profile_id here, and the caller then runs the normal permission checks and the
// existing NEXA action against that real profile id.
import { v4 as uuid } from 'uuid';
import db from './db.js';

export const NICKNAME_MAX = 40;

// Case-insensitive, whitespace-insensitive, Unicode-normalised key. This is what the
// UNIQUE(owner_user_id, normalized_nickname) constraint is enforced on.
export function normalizeNickname(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/^@+/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

// Looser key used only for *matching spoken/typed variants* ("Bestiee", "best ie", "Béstie").
// It is never stored, and a loose match is only used when it points at exactly one profile.
export function looseKey(input) {
  return normalizeNickname(input)
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/(.)\1+/gu, '$1');
}

function isBlocked(a, b) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a);
}

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function publicRow(r) {
  return { id: r.id, nickname: r.nickname, targetUsername: r.username, targetDisplayName: r.display_name, updatedAt: r.updated_at };
}

// ---- LIST_PROFILE_NICKNAMES ------------------------------------------------------------
export function listProfileNicknames(ownerId) {
  return db.prepare(`
    SELECT pn.*, u.username, u.display_name FROM profile_nicknames pn
    JOIN users u ON u.id = pn.target_profile_id
    WHERE pn.owner_user_id = ? ORDER BY pn.normalized_nickname
  `).all(ownerId).map(publicRow);
}

export function nicknameForProfile(ownerId, targetId) {
  if (!ownerId || ownerId === targetId) return null;
  const row = db.prepare('SELECT nickname FROM profile_nicknames WHERE owner_user_id = ? AND target_profile_id = ? ORDER BY updated_at DESC LIMIT 1').get(ownerId, targetId);
  return row?.nickname || null;
}

function validate(ownerId, target, nickname) {
  if (!target) throw err('NOT_FOUND', 'User not found.');
  if (target.id === ownerId) throw err('INVALID_ACTION', "You can't set a nickname for yourself.");
  if (isBlocked(ownerId, target.id)) throw err('BLOCKED', 'Unable to set a nickname for this user.');
  const clean = String(nickname ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, NICKNAME_MAX);
  if (!clean) throw err('INVALID_INPUT', 'Enter a nickname first.');
  return { clean, key: normalizeNickname(clean) };
}

// ---- SAVE_PROFILE_NICKNAME -------------------------------------------------------------
export function saveProfileNickname(ownerId, target, nickname) {
  const { clean, key } = validate(ownerId, target, nickname);
  const taken = db.prepare('SELECT pn.*, u.username FROM profile_nicknames pn JOIN users u ON u.id = pn.target_profile_id WHERE pn.owner_user_id = ? AND pn.normalized_nickname = ?').get(ownerId, key);
  if (taken) {
    if (taken.target_profile_id === target.id) return { status: 'unchanged', nickname: taken.nickname };
    throw err('NICKNAME_TAKEN', `You already use "${taken.nickname}" for @${taken.username}. Pick a different nickname, or change that one first.`);
  }
  db.prepare('INSERT INTO profile_nicknames (id, owner_user_id, nickname, normalized_nickname, target_profile_id) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), ownerId, clean, key, target.id);
  return { status: 'saved', nickname: clean };
}

// Replace-style save used by the profile page UI: one visible label per person.
export function setNicknameForProfile(ownerId, target, nickname) {
  const { clean, key } = validate(ownerId, target, nickname);
  const clash = db.prepare('SELECT target_profile_id, nickname FROM profile_nicknames WHERE owner_user_id = ? AND normalized_nickname = ?').get(ownerId, key);
  if (clash && clash.target_profile_id !== target.id) throw err('NICKNAME_TAKEN', `You already use "${clash.nickname}" for someone else.`);
  const existing = db.prepare('SELECT id FROM profile_nicknames WHERE owner_user_id = ? AND target_profile_id = ? ORDER BY updated_at DESC LIMIT 1').get(ownerId, target.id);
  if (existing) {
    db.prepare("UPDATE profile_nicknames SET nickname = ?, normalized_nickname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(clean, key, existing.id);
  } else {
    db.prepare('INSERT INTO profile_nicknames (id, owner_user_id, nickname, normalized_nickname, target_profile_id) VALUES (?, ?, ?, ?, ?)').run(uuid(), ownerId, clean, key, target.id);
  }
  return { status: 'saved', nickname: clean };
}

// ---- UPDATE_PROFILE_NICKNAME (rename one of the owner's existing nicknames) -------------
export function updateProfileNickname(ownerId, oldNickname, newNickname) {
  const found = resolveProfileNickname(ownerId, oldNickname);
  if (found.status === 'none') throw err('NOT_FOUND', `I couldn't find a profile saved as ${oldNickname}.`);
  if (found.status === 'ambiguous') throw err('AMBIGUOUS', `Which ${oldNickname} do you mean?`, { candidates: found.candidates });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(found.profile.id);
  const { clean, key } = validate(ownerId, target, newNickname);
  const clash = db.prepare('SELECT id, target_profile_id, nickname FROM profile_nicknames WHERE owner_user_id = ? AND normalized_nickname = ?').get(ownerId, key);
  if (clash && clash.id !== found.rowId) throw err('NICKNAME_TAKEN', `You already use "${clash.nickname}" for someone else.`);
  db.prepare("UPDATE profile_nicknames SET nickname = ?, normalized_nickname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(clean, key, found.rowId);
  return { status: 'updated', nickname: clean, profile: found.profile };
}

// ---- DELETE_PROFILE_NICKNAME -----------------------------------------------------------
export function deleteProfileNickname(ownerId, nickname) {
  const found = resolveProfileNickname(ownerId, nickname);
  if (found.status === 'none') throw err('NOT_FOUND', `I couldn't find a profile saved as ${nickname}.`);
  if (found.status === 'ambiguous') throw err('AMBIGUOUS', `Which ${nickname} do you mean?`, { candidates: found.candidates });
  db.prepare('DELETE FROM profile_nicknames WHERE id = ? AND owner_user_id = ?').run(found.rowId, ownerId);
  return { status: 'deleted', nickname: found.nickname, profile: found.profile };
}

export function deleteNicknamesForProfile(ownerId, targetId) {
  db.prepare('DELETE FROM profile_nicknames WHERE owner_user_id = ? AND target_profile_id = ?').run(ownerId, targetId);
}

// ---- RESOLVE_PROFILE_NICKNAME ----------------------------------------------------------
// nickname -> profile id. Three tiers, and a tier only "wins" when it points at exactly
// one profile. Never guesses: 0 -> 'none', 2+ different profiles -> 'ambiguous'.
//   1. exact normalised match          ("bestie" == "Bestie")
//   2. loose match                     ("bestiee", "best ie", "Béstie")
//   3. prefix match, min 3 characters  ("best" -> "Bestie")
export function resolveProfileNickname(ownerId, text) {
  const key = normalizeNickname(text);
  if (!ownerId || !key) return { status: 'none' };
  const rows = db.prepare(`
    SELECT pn.id AS row_id, pn.nickname, pn.normalized_nickname, u.id, u.username, u.display_name
    FROM profile_nicknames pn JOIN users u ON u.id = pn.target_profile_id
    WHERE pn.owner_user_id = ?
  `).all(ownerId);

  const tiers = [
    rows.filter(r => r.normalized_nickname === key),
    rows.filter(r => looseKey(r.nickname) === looseKey(key) && looseKey(key)),
    key.length >= 3 ? rows.filter(r => r.normalized_nickname.startsWith(key)) : [],
  ];
  for (const hits of tiers) {
    if (!hits.length) continue;
    const distinct = [...new Map(hits.map(h => [h.id, h])).values()];
    if (distinct.length === 1) {
      const h = distinct[0];
      return { status: 'found', rowId: h.row_id, nickname: h.nickname, profile: { id: h.id, username: h.username, displayName: h.display_name } };
    }
    return { status: 'ambiguous', candidates: distinct.map(h => ({ username: h.username, displayName: h.display_name, nickname: h.nickname })) };
  }
  return { status: 'none' };
}

// Helper for resolvers that just need a user row.
export function userRowForNickname(ownerId, text) {
  const r = resolveProfileNickname(ownerId, text);
  if (r.status !== 'found') return r;
  return { status: 'found', user: db.prepare('SELECT * FROM users WHERE id = ?').get(r.profile.id), nickname: r.nickname };
}
