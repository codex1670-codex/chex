import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.NEXA_DB_PATH || path.join(__dirname, '..', 'nexa.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS above is a no-op against a notes table that already existed
// before the song-attachment feature — this backfills those columns on an existing db
// file so upgrading doesn't require deleting nexa.db. Safe to run every boot: each ALTER
// is skipped once the column is present.
const noteColumns = db.prepare("PRAGMA table_info(notes)").all().map(c => c.name);
for (const [col, def] of [
  ['song_id', 'TEXT'], ['song_title', 'TEXT'], ['song_artist', 'TEXT'], ['song_url', 'TEXT'],
]) {
  if (!noteColumns.includes(col)) db.exec(`ALTER TABLE notes ADD COLUMN ${col} ${def}`);
}

// Migration 1: older databases were created with a codex_actions CHECK that only allowed
// four statuses, but the Codex route also audits pending_confirmation / pending_preview /
// pending_disambiguation — on those databases the INSERT would violate the CHECK. SQLite
// can't alter a CHECK in place, so rebuild the table once (rows preserved).
const codexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_actions'").get()?.sql || '';
if (codexSql && !codexSql.includes('pending_preview')) {
  db.exec(`
    BEGIN;
    ALTER TABLE codex_actions RENAME TO codex_actions_old;
    CREATE TABLE codex_actions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      input_text    TEXT NOT NULL,
      action_name   TEXT,
      action_input  TEXT,
      status        TEXT NOT NULL CHECK (status IN ('executed','failed','no_match','ai_unavailable','pending_confirmation','pending_disambiguation','pending_preview','needs_clarification')),
      result_summary TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO codex_actions SELECT id, user_id, input_text, action_name, action_input, status, result_summary, created_at FROM codex_actions_old;
    DROP TABLE codex_actions_old;
    CREATE INDEX IF NOT EXISTS idx_codex_actions_user_time ON codex_actions(user_id, created_at);
    COMMIT;
  `);
}

// Migration 2: copy nicknames saved in the legacy `nicknames` table into the spec's
// `profile_nicknames` table (INSERT OR IGNORE, so this is safe to run on every boot).
db.exec(`
  INSERT OR IGNORE INTO profile_nicknames (id, owner_user_id, nickname, normalized_nickname, target_profile_id, created_at, updated_at)
  SELECT lower(hex(randomblob(16))), owner_id, nickname, lower(trim(nickname)), target_id, created_at, updated_at FROM nicknames
`);

// Migration 3 (media upload + editing): add the new columns to databases created before
// posts/stories/reels supported device uploads and non-destructive edit settings.
const addColumnIfMissing = (table, col, def) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addColumnIfMissing('posts', 'media_type', "TEXT CHECK (media_type IN ('image','video'))");
addColumnIfMissing('posts', 'edits', 'TEXT');
addColumnIfMissing('reels', 'edits', 'TEXT');
// Profile Studio: theme / background / dim / blur chosen in the studio, stored as JSON so
// every viewer of a profile sees the same look.
addColumnIfMissing('users', 'profile_studio', 'TEXT');

// Migration 4: stories.media_type used to be CHECK IN ('text','image'); video stories need
// 'video'. SQLite can't alter a CHECK, so rebuild the table once. foreign_keys must be OFF
// for the rebuild — otherwise DROP TABLE would cascade-delete every row in story_views.
const storiesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stories'").get()?.sql || '';
if (storiesSql && !storiesSql.includes("'video'")) {
  const old = db.prepare('PRAGMA table_info(stories)').all().map(c => c.name);
  const keep = ['id', 'user_id', 'media_type', 'content', 'background', 'audience', 'created_at', 'expires_at', 'deleted_at']
    .filter(c => old.includes(c)).join(', ');
  db.pragma('foreign_keys = OFF');
  try {
    // Order matters: create the new table under a temp name, copy, DROP the old one, then
    // rename the NEW table into place. (Renaming the old table away first would make SQLite
    // rewrite story_views' foreign key to point at the renamed — then dropped — table.)
    db.exec(`
      BEGIN;
      CREATE TABLE stories_new (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_type  TEXT NOT NULL DEFAULT 'text' CHECK (media_type IN ('text','image','video')),
        content     TEXT NOT NULL,
        caption     TEXT,
        edits       TEXT,
        background  TEXT NOT NULL DEFAULT '#7C5CFF',
        audience    TEXT NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','followers','close_friends')),
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at  TEXT NOT NULL,
        deleted_at  TEXT
      );
      INSERT INTO stories_new (${keep}) SELECT ${keep} FROM stories;
      DROP TABLE stories;
      ALTER TABLE stories_new RENAME TO stories;
      CREATE INDEX IF NOT EXISTS idx_stories_user_time ON stories(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories(expires_at);
      COMMIT;
    `);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Every "author"/"actor"/"user" summary sent to the client (post authors, commenters,
// notification actors, message participants, game/tournament players, story/note
// authors, callers, search results, etc.) should carry the same profile-media fields
// as the full profile, so that changing your avatar photo or profile video shows up
// everywhere your identity appears in the app — not just on your own Profile page.
// SQL snippet to append to any `SELECT ... FROM users u` (or aliased join) to pull in
// the columns toPublicUser() below expects.
export const USER_MEDIA_COLUMNS_SQL = 'avatar_photo_url, profile_video_url, profile_video_cover_url, profile_video_muted, profile_display_mode';

// Builds the small "who is this" object used throughout the app (as opposed to
// profileFor() in routes/users.js, which builds the full profile page payload).
// Expects a row with: id, username, display_name, avatar_color, and — whenever the
// query selected them — avatar_photo_url, profile_video_url, profile_video_cover_url,
// profile_video_muted, profile_display_mode. Missing media columns just fall back to
// the plain color avatar, so this is safe to call even before every query is updated.
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarPhotoUrl: row.avatar_photo_url || null,
    profileVideoUrl: row.profile_video_url || null,
    profileVideoCoverUrl: row.profile_video_cover_url || null,
    profileVideoMuted: !!row.profile_video_muted,
    displayMode: row.profile_display_mode || 'color',
  };
}

export default db;
