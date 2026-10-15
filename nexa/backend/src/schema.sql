-- NEXA vertical slice schema: auth + social graph + posts/feed + messaging + message requests

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  bio            TEXT NOT NULL DEFAULT '',
  avatar_color   TEXT NOT NULL DEFAULT '#7C5CFF',
  -- Section 127/128 — real uploaded profile media. avatar_photo_url and the profile_video_*
  -- columns are only ever populated by the upload endpoints in users.js (never trusted
  -- from arbitrary client input), so a URL showing up here always points at a file this
  -- server actually wrote to disk.
  avatar_photo_url        TEXT,
  profile_video_url       TEXT,
  profile_video_cover_url TEXT,
  profile_video_muted     INTEGER NOT NULL DEFAULT 0,
  -- Which one to actually show on the profile: the plain color+initial avatar, the
  -- uploaded photo, or the uploaded video. Switching to 'photo'/'video' is only allowed
  -- (see PATCH /users/me/display-mode) when the matching *_url column is already set.
  profile_display_mode TEXT NOT NULL DEFAULT 'color' CHECK (profile_display_mode IN ('color','photo','video')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','deactivated','deleted')),
  totp_secret    TEXT,
  totp_enabled   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS follows (
  follower_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id != followed_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);

-- Restrict: lighter-touch than block. A restricted user can still see the relationship
-- normally, but their comments are only visible to themselves and the post author.
CREATE TABLE IF NOT EXISTS restricts (
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restricted_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, restricted_id),
  CHECK (owner_id != restricted_id)
);

CREATE TABLE IF NOT EXISTS saved_posts (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS hashtags (
  id          TEXT PRIMARY KEY,
  tag         TEXT NOT NULL UNIQUE, -- normalized (lowercase, no #)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id  TEXT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag ON post_hashtags(hashtag_id);

CREATE TABLE IF NOT EXISTS mentions (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL CHECK (source_type IN ('post','comment','reel','story','note')),
  source_id       TEXT NOT NULL,
  mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(mentioned_user_id);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post','comment','reel','reel_comment','story','note','user','message')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','actioned','dismissed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS account_deletions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','completed')),
  requested_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scheduled_at   TEXT NOT NULL,
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS chat_themes (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  conversation_id    TEXT,
  theme              TEXT NOT NULL DEFAULT 'default',
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption     TEXT NOT NULL DEFAULT '',
  image_url   TEXT,
  media_type  TEXT CHECK (media_type IN ('image','video')),
  edits       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_user_time ON posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(created_at);

CREATE TABLE IF NOT EXISTS likes (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_time ON comments(post_id, created_at);

-- Conversations: 'direct' (exactly 2 participants) or 'group'
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct','group')),
  direct_key  TEXT UNIQUE, -- for 'direct' convos: sorted "userA:userB" to enforce uniqueness
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_read_at     TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_convo_participants_user ON conversation_participants(user_id);

CREATE TABLE IF NOT EXISTS conversation_meta (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT
);

-- Calls: signaling metadata + history. Actual media never touches the server —
-- WebRTC peer connections are negotiated directly between browsers using this
-- table (and Socket.io) purely to exchange call state and SDP/ICE messages.
CREATE TABLE IF NOT EXISTS calls (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  caller_id        TEXT NOT NULL REFERENCES users(id),
  type             TEXT NOT NULL DEFAULT 'voice' CHECK (type IN ('voice','video')),
  status           TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','declined','missed','ended')),
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  answered_at      TEXT,
  ended_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_conversation ON calls(conversation_id, started_at);

CREATE TABLE IF NOT EXISTS call_participants (
  call_id     TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   TEXT,
  left_at     TEXT,
  PRIMARY KEY (call_id, user_id)
);

-- Message requests: required gate before messaging is allowed between two users
-- who have no accepted conversation yet.
CREATE TABLE IF NOT EXISTS message_requests (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','deleted','blocked','reported')),
  first_text   TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (sender_id, receiver_id),
  CHECK (sender_id != receiver_id)
);
CREATE INDEX IF NOT EXISTS idx_msgreq_receiver ON message_requests(receiver_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text')),
  content          TEXT NOT NULL,
  reply_to_id      TEXT REFERENCES messages(id),
  forwarded_from_id TEXT REFERENCES messages(id),
  pinned           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','read','failed')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at        TEXT,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_convo_time ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('like','comment','follow','message_request','message','note_reply','story_view','reel_like','reel_comment','game_invite','mention','missed_call')),
  target_id   TEXT,
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_time ON notifications(recipient_id, created_at);

-- Close friends: used to gate 'close_friends' audience on stories/notes
CREATE TABLE IF NOT EXISTS close_friends (
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, friend_id),
  CHECK (owner_id != friend_id)
);

-- Nicknames: a private label the owner sets on someone else's profile, visible only to
-- the owner. Also doubles as an alias Codex/AI understands — resolveUser() in
-- routes/codex.js checks this table (scoped to the requesting user) before falling back
-- to username/display-name matching, so "message bro" or "block boss" work exactly like
-- typing the real username, without ever exposing the nickname to anyone else.
CREATE TABLE IF NOT EXISTS nicknames (
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, target_id),
  CHECK (owner_id != target_id)
);

-- Codex spec §13 — private profile nicknames. Only the owner can read these rows; they are
-- never exposed by public profile APIs. UNIQUE(owner_user_id, normalized_nickname) makes a
-- nickname unique per owner and case-insensitive. (The older `nicknames` table above is
-- kept only so existing databases can be migrated once at boot — see db.js.)
CREATE TABLE IF NOT EXISTS profile_nicknames (
  id                  TEXT PRIMARY KEY,
  owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname            TEXT NOT NULL,
  normalized_nickname TEXT NOT NULL,
  target_profile_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (owner_user_id, normalized_nickname),
  CHECK (owner_user_id != target_profile_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_nicknames_target ON profile_nicknames(owner_user_id, target_profile_id);

-- Notes: ephemeral status shown above Messages. One active note per user (upsert on create).
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL DEFAULT '',
  emoji       TEXT,
  mood        TEXT,
  audience    TEXT NOT NULL DEFAULT 'followers' CHECK (audience IN ('everyone','followers','close_friends','no_one')),
  song_id     TEXT,
  song_title  TEXT,
  song_artist TEXT,
  song_url    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_likes (
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (note_id, user_id)
);

-- Stories: 24h-expiring content — text, or an uploaded/linked photo or video — with per-viewer tracking.
CREATE TABLE IF NOT EXISTS stories (
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
CREATE INDEX IF NOT EXISTS idx_stories_user_time ON stories(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories(expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (story_id, viewer_id)
);

-- Reels: video-URL-based short posts (no upload/transcode pipeline in this slice —
-- the video_url must point to an already-hosted video; see README).
CREATE TABLE IF NOT EXISTS reels (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_url   TEXT NOT NULL,
  caption     TEXT NOT NULL DEFAULT '',
  edits       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reels_time ON reels(created_at);

CREATE TABLE IF NOT EXISTS reel_likes (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reel_id     TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, reel_id)
);

CREATE TABLE IF NOT EXISTS reel_comments (
  id          TEXT PRIMARY KEY,
  reel_id     TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reel_comments_reel_time ON reel_comments(reel_id, created_at);

CREATE TABLE IF NOT EXISTS reel_hashtags (
  reel_id     TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  hashtag_id  TEXT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (reel_id, hashtag_id)
);
CREATE INDEX IF NOT EXISTS idx_reel_hashtags_hashtag ON reel_hashtags(hashtag_id);

-- Games: catalog + authoritative room/player/match state.
CREATE TABLE IF NOT EXISTS games (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL,
  min_players       INTEGER NOT NULL,
  max_players       INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS game_rooms (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id),
  host_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code   TEXT NOT NULL UNIQUE,
  capacity      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished')),
  state         TEXT NOT NULL DEFAULT '{}', -- authoritative JSON game state (board, turn, winner)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at    TEXT,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_rooms_status ON game_rooms(status);

CREATE TABLE IF NOT EXISTS game_players (
  room_id     TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot        INTEGER NOT NULL,
  ready       INTEGER NOT NULL DEFAULT 0,
  joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at     TEXT,
  PRIMARY KEY (room_id, user_id),
  UNIQUE (room_id, slot)
);

-- Tournaments: a real round-robin bracket built on top of the existing 2-player game_rooms.
-- Not fabricated data — every match is a genuine, playable, server-authoritative game room.
CREATE TABLE IF NOT EXISTS tournaments (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES games(id),
  host_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','finished')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at  TEXT,
  ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS tournament_participants (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  joined_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  room_id        TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  player_a_id    TEXT NOT NULL REFERENCES users(id),
  player_b_id    TEXT NOT NULL REFERENCES users(id),
  winner_id      TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tournament_matches_tournament ON tournament_matches(tournament_id);

-- Saved reels: mirrors saved_posts for the reels content type.
CREATE TABLE IF NOT EXISTS saved_reels (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reel_id     TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, reel_id)
);

-- Section 130 — Reels History: one row per (viewer, reel), upserted on each view so
-- viewed_at always reflects the most recent watch, not the first. Always queried by the
-- viewer's own user_id (see GET /reels/history/mine) — no other user can ever read this.
CREATE TABLE IF NOT EXISTS reel_views (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reel_id     TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  viewed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, reel_id)
);
CREATE INDEX IF NOT EXISTS idx_reel_views_user_time ON reel_views(user_id, viewed_at);

-- Mutes: content-silencing only (still see profile/can still message) — distinct from block/restrict.
CREATE TABLE IF NOT EXISTS mutes (
  muter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (muter_id, muted_id)
);

-- App registry: the catalog Codex's Universal App Launcher resolves aliases against.
-- launch_url_web is a REAL web entry point (opens the actual official site), not a native
-- app intent — this build is a web app and cannot invoke native OS app launching.
CREATE TABLE IF NOT EXISTS app_registry (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  launch_url_web      TEXT,
  search_url_template TEXT, -- contains {q} placeholder for "open X and search Y"
  native_only         INTEGER NOT NULL DEFAULT 0 -- 1 = no meaningful web equivalent (e.g. Free Fire)
);

CREATE TABLE IF NOT EXISTS app_aliases (
  app_id      TEXT NOT NULL REFERENCES app_registry(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL UNIQUE, -- normalized, lowercase
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Codex action audit: every LLM-resolved action taken on the user's behalf, isolated from
-- ordinary app data. Never stores raw model output beyond what's needed to explain the result.
CREATE TABLE IF NOT EXISTS codex_actions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_text    TEXT NOT NULL,
  action_name   TEXT,              -- NULL if no tool matched
  action_input  TEXT,              -- JSON of the tool arguments actually used
  status        TEXT NOT NULL CHECK (status IN ('executed','failed','no_match','ai_unavailable','pending_confirmation','pending_disambiguation','pending_preview','needs_clarification')),
  result_summary TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_codex_actions_user_time ON codex_actions(user_id, created_at);
