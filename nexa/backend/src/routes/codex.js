import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { parseCommand, editDistance, SPLIT_RE } from '../nlu.js';
import { sanitizeControls, resolveControl, resolveField, resolveLandmark, planMixed, riskOf } from '../uiAgent.js';
import { sendDirectMessage } from './messages.js';
import { isBlocked } from './users.js';
import { createRoom, joinRoomByCode, roomDTO } from './games.js';
import { REEL_URL_RE } from './reels.js';
import { processMentionsAndHashtags } from '../content.js';
import {
  saveProfileNickname, updateProfileNickname, deleteProfileNickname,
  listProfileNicknames, resolveProfileNickname, userRowForNickname,
} from '../nicknames.js';

const router = Router();

// The complete allowlisted action registry Codex may choose from. Nothing outside this
// list can ever be executed, regardless of what the model outputs — executeAction() below
// only recognizes these exact names, and every branch re-validates authorization server-side.
const TOOLS = [
  { name: 'send_message', description: 'Send a direct message to a NEXA user by username.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' }, text: { type: 'string' } }, required: ['username', 'text'] } },
  { name: 'follow_user', description: 'Follow a NEXA user by username.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'unfollow_user', description: 'Unfollow a NEXA user by username.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'navigate', description: "Move the user to a different screen inside NEXA, optionally a specific sub-view (e.g. \"open my saved reels\" -> screen 'saved-reels'; \"show my reels history\"/\"reels I've watched\" -> screen 'reels-history'; \"open profile studio\"/\"change my profile video or photo\" -> screen 'profile-studio'; \"open tournaments\" -> screen 'games' with tab 'tournaments').",
    input_schema: { type: 'object', properties: {
      screen: { type: 'string', enum: ['feed', 'messages', 'profile', 'notifications', 'reels', 'games', 'search', 'settings', 'saved-posts', 'saved-reels', 'reels-history', 'profile-studio'] },
      username: { type: 'string', description: 'only for the profile/messages screens' },
      tab: { type: 'string', enum: ['discover', 'friends', 'mine', 'tournaments'], description: 'only for the games screen' },
    }, required: ['screen'] } },
  { name: 'set_theme', description: 'Switch NEXA between dark and light appearance.',
    input_schema: { type: 'object', properties: { theme: { type: 'string', enum: ['dark', 'light'] } }, required: ['theme'] } },
  { name: 'start_call', description: 'Start a voice or video call with a user you already have a conversation with.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' }, video: { type: 'boolean' } }, required: ['username'] } },
  { name: 'open_app', description: 'Open an external app/website by name (e.g. Spotify, YouTube, Maps, WhatsApp), optionally with a search term.',
    input_schema: { type: 'object', properties: { appName: { type: 'string' }, searchFor: { type: 'string' } }, required: ['appName'] } },
  { name: 'create_note', description: "Post to the user's Note (shown above Messages), which expires in 24h.",
    input_schema: { type: 'object', properties: { text: { type: 'string' }, emoji: { type: 'string' } }, required: ['text'] } },
  { name: 'create_story', description: 'Post a text Story that expires in 24h.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'search', description: 'Search NEXA for a user or hashtag.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'invite_to_game', description: 'Create a new game room and send the invite to a friend by username.',
    input_schema: { type: 'object', properties: { gameId: { type: 'string', enum: ['tic-tac-toe', 'connect-four', 'checkers', 'chess'] }, username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['gameId', 'username'] } },
  { name: 'join_game', description: 'Join an existing game room using an invite code.',
    input_schema: { type: 'object', properties: { inviteCode: { type: 'string' } }, required: ['inviteCode'] } },
  { name: 'create_post', description: 'Publish a new post to the feed with a text caption.',
    input_schema: { type: 'object', properties: { caption: { type: 'string' } }, required: ['caption'] } },
  { name: 'create_reel', description: "Publish a new reel from a direct URL to an already-hosted .mp4/.webm/.mov video file. Codex can't attach a file from the user's device itself — for uploading a video from their gallery/camera roll/downloads, tell them to use the Upload option in the Reels composer instead.",
    input_schema: { type: 'object', properties: { videoUrl: { type: 'string' }, caption: { type: 'string' } }, required: ['videoUrl'] } },
  { name: 'mute_user', description: 'Mute a user by username (hides their posts from your feed without unfollowing or blocking them).',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'unmute_user', description: 'Unmute a previously muted user by username.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'block_user', description: 'Block a user by username. This also removes any follow relationship in either direction. Destructive — always confirmed first.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'unblock_user', description: 'Unblock a previously blocked user by username.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'restrict_user', description: "Restrict a user by username (limits their comment visibility on your posts without them knowing they're restricted).",
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'unrestrict_user', description: 'Remove a restriction on a user by username.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'share_content', description: 'Share the currently open Reel or Post to a user by sending it as a message. Only works if Context shows a currentReel or currentPost — if Context has neither, call no_match and say nothing is currently open to share.',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The username, display name, or the caller\'s private nickname for this person, exactly as the user typed it.' } }, required: ['username'] } },
  { name: 'like_content', description: 'Like the currently open Reel or Post. Only works if Context shows a currentReel or currentPost.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'save_content', description: 'Save (bookmark) the currently open Reel or Post. Only works if Context shows a currentReel or currentPost.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'unlike_content', description: 'Remove your like from the currently open Reel or Post. Only works if Context shows a currentReel or currentPost.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'unsave_content', description: 'Remove the currently open Reel or Post from your saved items. Only works if Context shows a currentReel or currentPost.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'comment_content', description: 'Comment on the currently open Reel or Post. Only works if Context shows a currentReel or currentPost.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'mark_notifications_read', description: 'Mark all of your notifications as read and open the notifications screen.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'delete_post', description: "Permanently delete the currently open Post (must be the user's own post, and Context must show a currentPost). Destructive — always confirmed first.",
    input_schema: { type: 'object', properties: {} } },

  // Section 3/11 — private profile nicknames. Nicknames are never a target by themselves:
  // every other tool's "username" field already accepts a nickname directly (the caller
  // just resolves it), so these five tools exist only for explicitly managing the mapping
  // itself ("save Rahul as Bestie", "who is Bestie", "forget Bestie").
  { name: 'save_profile_nickname', description: 'Privately save a nickname for another NEXA profile, e.g. "save Rahul as Bestie" / "Rahul-a Bestie-nu save pannu".',
    input_schema: { type: 'object', properties: { username: { type: 'string', description: 'The real username or display name of the profile to nickname.' }, nickname: { type: 'string' } }, required: ['username', 'nickname'] } },
  { name: 'update_profile_nickname', description: 'Rename an existing nickname to a new one, e.g. "rename Bestie to Bro".',
    input_schema: { type: 'object', properties: { oldNickname: { type: 'string' }, newNickname: { type: 'string' } }, required: ['oldNickname', 'newNickname'] } },
  { name: 'delete_profile_nickname', description: 'Remove a previously saved nickname, e.g. "forget Bestie" / "remove nickname Bestie".',
    input_schema: { type: 'object', properties: { nickname: { type: 'string' } }, required: ['nickname'] } },
  { name: 'list_profile_nicknames', description: 'List all nicknames the caller has privately saved, e.g. "show my nicknames" / "who have I saved nicknames for".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'resolve_profile_nickname', description: 'Look up which real profile a nickname points to, e.g. "who is Bestie".',
    input_schema: { type: 'object', properties: { nickname: { type: 'string' } }, required: ['nickname'] } },

  // Universal UI control. These four let Codex operate ANY control that is on screen right now
  // (every button, tab, link, card, toggle and text box on every page) without a hand-written
  // tool per button. The browser sends a live map of what's on screen; /codex/ui-resolve picks
  // the control; the browser presses it. Risky controls are policed in code (see riskOf in
  // uiAgent.js): security/account controls are never pressed, destructive ones need a confirm.
  { name: 'ui_click', description: "Press ANY button, tab, link, card, toggle or icon visible on the current screen (see UI CONTROLS). Use it for everything the other tools don't cover: 'press the dark button', 'open the Following tab', 'tap Accept', 'hit the heart', 'click Edit', 'close this'. Put the control in the user's own words in `target`, plus `controlId` when you can see exactly which listed control it is. Do not use it for password, 2FA, deactivate or delete-account controls.",
    input_schema: { type: 'object', properties: { target: { type: 'string', description: "The control as the user described it, in their own words." }, controlId: { type: 'string', description: 'The id from UI CONTROLS, if you can see which one it is.' } }, required: ['target'] } },
  { name: 'ui_type', description: "Type text into a text box on screen (search box, comment box, message box, caption, bio...). Set submit:true only if the user also asked to send/post/search it. Never for password fields.",
    input_schema: { type: 'object', properties: { target: { type: 'string', description: 'Which box, in the user\'s words (may be empty for "the box").' }, text: { type: 'string', description: 'Exactly the text to type, as the user wrote it.' }, controlId: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'] } },
  { name: 'ui_scroll', description: "Scroll the current page: direction up/down/top/bottom, or next/previous for one screenful (e.g. 'next reel'); or bring a named section into view with `target` (e.g. 'privacy', 'two-factor').",
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom', 'next', 'previous'] }, target: { type: 'string' } } } },
  { name: 'ui_back', description: 'Go back: presses the on-screen Back/← button if there is one, otherwise returns to the previous page.',
    input_schema: { type: 'object', properties: {} } },
];

const UI_TOOLS = new Set(['ui_click', 'ui_type', 'ui_scroll', 'ui_back']);

// Browser-supplied tool input is untrusted: clamp every field before it goes anywhere.
function cleanUiStep(name, input = {}) {
  const t = (v, n) => String(v ?? '').trim().slice(0, n);
  switch (name) {
    case 'ui_click': return { type: 'click', target: t(input.target, 160), controlId: t(input.controlId, 24) || undefined };
    case 'ui_type': return { type: 'type', target: t(input.target, 160), text: String(input.text ?? '').slice(0, 2000), controlId: t(input.controlId, 24) || undefined, submit: !!input.submit };
    case 'ui_scroll': return { type: 'scroll', direction: ['up', 'down', 'top', 'bottom', 'next', 'previous'].includes(input.direction) ? input.direction : undefined, target: t(input.target, 120) || undefined };
    default: return { type: 'back' };
  }
}

// Actions that must be confirmed before executing, per the spec's destructive-action rule —
// Codex never silently blocks, deletes, or otherwise takes a high-impact action. Account
// deletion is deliberately NOT a Codex tool at all — it already requires password
// confirmation through the dedicated Settings flow, which is a stronger safeguard than a
// chat confirmation and shouldn't be shortcut-able through conversation.
const DESTRUCTIVE = new Set(['block_user', 'delete_post']);

function confirmationPrompt(name, input) {
  if (name === 'block_user') return `Block @${input.username}? They won't be able to follow, message, or see your content.`;
  if (name === 'delete_post') return "Permanently delete this post? This can't be undone.";
  return 'Are you sure?';
}

// Section 165/183 — profile-aware resolution with disambiguation. Every action that takes
// a `username` from the model runs through here before it does anything else: exact
// username match wins immediately (no disambiguation needed for the common case), a
// single fuzzy match on username/display name is accepted, and 2+ matches pause the
// action and hand the real candidate list back to the user ("I found 3 people named
// Rahul. Which one?") instead of guessing. Zero matches is a normal not-found error.
//
// Section 190 — Nickname-aware: `ownerId` (the person talking to Codex) is checked
// first against their own private nicknames table, so "message bro" or "block boss"
// resolves exactly like typing the real username — an exact nickname match wins
// immediately, same as an exact username match, since it's a deliberate personal label
// the person themselves chose. Nicknames only ever match against the caller's own
// nicknames; nobody else's aliases for a person can affect resolution.
function resolveUser(identifier, ownerId) {
  const id = (identifier || '').replace(/^@/, '').trim();
  if (!id) throw new Error('User not found.');

  // Section 4 — nickname resolution runs first and, on an exact or unambiguous loose/
  // prefix match, wins immediately (same precedence as typing the real username). Never
  // guess: 2+ distinct profiles for the same nickname text pauses and hands the real
  // candidate list back instead of picking one.
  if (ownerId) {
    const byNickname = resolveProfileNickname(ownerId, id);
    if (byNickname.status === 'found') {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(byNickname.profile.id);
    }
    if (byNickname.status === 'ambiguous') {
      const err = new Error(`Which "${id}" do you mean?`);
      err.isAmbiguous = true;
      err.candidates = byNickname.candidates.map(c => ({ username: c.username, displayName: c.displayName, nickname: c.nickname }));
      throw err;
    }
  }

  const exact = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(id);
  if (exact) return exact;

  const candidates = db.prepare(`
    SELECT DISTINCT u.* FROM users u
    LEFT JOIN nicknames n ON n.target_id = u.id AND n.owner_id = ?
    WHERE LOWER(u.username) LIKE LOWER(?) OR LOWER(u.display_name) LIKE LOWER(?) OR LOWER(n.nickname) LIKE LOWER(?)
    LIMIT 6
  `).all(ownerId || null, `%${id}%`, `%${id}%`, `%${id}%`);
  if (candidates.length === 0) {
    // Last resort: tolerate a typo in the name ("rahull", "priyaa", "arjn").
    const fuzzy = fuzzyUsers(id, ownerId);
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) {
      const err = new Error(`I found ${fuzzy.length} people close to \"${id}\". Which one?`);
      err.isAmbiguous = true;
      err.candidates = fuzzy.map(c => ({ username: c.username, displayName: c.display_name }));
      throw err;
    }
    throw new Error('User not found.');
  }
  if (candidates.length === 1) return candidates[0];
  const err = new Error(`I found ${candidates.length} people matching "${id}". Which one?`);
  err.isAmbiguous = true;
  err.candidates = candidates.map(c => ({ username: c.username, displayName: c.display_name }));
  throw err;
}

// Typo-tolerant user lookup: same first letter, edit distance <= 1 (<= 2 for long names),
// matched against usernames, display names and the caller's own private nicknames.
function fuzzyUsers(word, ownerId) {
  const w = word.toLowerCase().normalize('NFKC');
  if (w.length < 3) return [];
  const thr = w.length >= 8 ? 2 : 1;
  const first = w[0].replace(/[%_]/g, '');
  if (!first) return [];
  const rows = db.prepare(`
    SELECT DISTINCT u.*, pn.normalized_nickname AS nick FROM users u
    LEFT JOIN profile_nicknames pn ON pn.target_profile_id = u.id AND pn.owner_user_id = ?
    WHERE LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ? OR pn.normalized_nickname LIKE ?
    LIMIT 300
  `).all(ownerId || null, `${first}%`, `${first}%`, `${first}%`);
  const seen = new Map();
  for (const r of rows) {
    const names = [r.username, r.display_name, (r.display_name || '').split(/\s+/)[0], r.nick].filter(Boolean).map(x => x.toLowerCase());
    if (names.some(n => editDistance(w, n) <= thr)) seen.set(r.id, r);
  }
  return [...seen.values()].slice(0, 6);
}

// How strongly a typed word refers to a known person: 2 = exact username / display name /
// first name / the caller's own nickname, 1 = prefix or one-typo match, 0 = not a person.
// Used only by the offline NLU to tell names apart from ordinary words.
function personStrength(ownerId, rawWord) {
  const w = String(rawWord || '').toLowerCase();
  if (w.length < 2 || /[%_]/.test(w)) return 0;
  const exact = db.prepare(`SELECT 1 FROM users WHERE LOWER(username) = ? OR LOWER(display_name) = ? OR LOWER(display_name) LIKE ? LIMIT 1`).get(w, w, `${w} %`)
    || (ownerId && db.prepare('SELECT 1 FROM profile_nicknames WHERE owner_user_id = ? AND normalized_nickname = ? LIMIT 1').get(ownerId, w));
  if (exact) return 2;
  if (w.length >= 3) {
    const pre = db.prepare(`SELECT 1 FROM users WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ? LIMIT 1`).get(`${w}%`, `${w}%`)
      || (ownerId && db.prepare('SELECT 1 FROM profile_nicknames WHERE owner_user_id = ? AND normalized_nickname LIKE ? LIMIT 1').get(ownerId, `${w}%`));
    if (pre) return 1;
  }
  if (w.length >= 5 && fuzzyUsers(w, ownerId).length) return 1;
  return 0;
}

// App catalog for the NLU: display name first (that's what open_app receives), then aliases.
function loadAppsForNlu() {
  return db.prepare('SELECT * FROM app_registry').all().map(a => ({
    id: a.id,
    names: [a.display_name.toLowerCase(), ...db.prepare('SELECT alias FROM app_aliases WHERE app_id = ?').all(a.id).map(r => r.alias.toLowerCase())],
  }));
}

// Section 171 — AI action preview. Turns a resolved action into the short icon+label line
// shown in the "I understood: ..." preview card, purely for display — it never affects
// what actually executes.
function describeStep(name, input) {
  const at = (u) => `@${u}`;
  switch (name) {
    case 'send_message': return `💬 Message ${at(input.username)}: "${(input.text || '').slice(0, 60)}${(input.text || '').length > 60 ? '…' : ''}"`;
    case 'follow_user': return `👤 Follow ${at(input.username)}`;
    case 'unfollow_user': return `👤 Unfollow ${at(input.username)}`;
    case 'navigate': return `📍 Open ${input.screen === 'reels-history' ? 'reels history' : input.screen === 'profile-studio' ? 'Profile Studio' : input.screen}${input.username ? ` — ${at(input.username)}` : ''}${input.tab ? ` (${input.tab})` : ''}`;
    case 'set_theme': return `🎨 Switch to ${input.theme} mode`;
    case 'start_call': return `${input.video ? '🎥' : '📞'} ${input.video ? 'Video' : 'Voice'} call ${at(input.username)}`;
    case 'open_app': return `🔗 Open ${input.appName}${input.searchFor ? ` and search "${input.searchFor}"` : ''}`;
    case 'create_note': return `📝 Post a note: "${input.text}"`;
    case 'create_story': return `📸 Post a story: "${input.text}"`;
    case 'search': return `🔍 Search "${input.query}"`;
    case 'invite_to_game': return `🎮 Create a ${input.gameId} room and invite ${at(input.username)}`;
    case 'join_game': return `🎮 Join game room ${input.inviteCode}`;
    case 'create_post': return `📰 Post: "${(input.caption || '').slice(0, 60)}"`;
    case 'create_reel': return `🎬 Post a reel${input.caption ? `: "${input.caption.slice(0, 60)}"` : ''}`;
    case 'mute_user': return `🔇 Mute ${at(input.username)}`;
    case 'unmute_user': return `🔊 Unmute ${at(input.username)}`;
    case 'block_user': return `🚫 Block ${at(input.username)}`;
    case 'unblock_user': return `✅ Unblock ${at(input.username)}`;
    case 'restrict_user': return `⚠️ Restrict ${at(input.username)}`;
    case 'unrestrict_user': return `↩️ Unrestrict ${at(input.username)}`;
    case 'share_content': return `↗️ Share the open Reel/Post with ${at(input.username)}`;
    case 'like_content': return '❤️ Like the currently open content';
    case 'save_content': return '🔖 Save the currently open content';
    case 'delete_post': return '🗑️ Delete the currently open post';
    case 'unlike_content': return '💔 Remove your like from the open content';
    case 'unsave_content': return '🔖 Remove the open content from your saved items';
    case 'comment_content': return `💬 Comment: "${(input.text || '').slice(0, 60)}"`;
    case 'mark_notifications_read': return '🔔 Mark all notifications as read';
    case 'save_profile_nickname': return `🏷️ Save ${at(input.username)} as "${input.nickname}"`;
    case 'update_profile_nickname': return `🏷️ Rename "${input.oldNickname}" to "${input.newNickname}"`;
    case 'delete_profile_nickname': return `🏷️ Forget nickname "${input.nickname}"`;
    case 'ui_click': return `👆 Press “${(input.target || '').slice(0, 50)}” on screen`;
    case 'ui_type': return `⌨️ Type “${(input.text || '').slice(0, 40)}${(input.text || '').length > 40 ? '…' : ''}” into ${input.target ? `“${input.target.slice(0, 30)}”` : 'the text box'}${input.submit ? ' and send it' : ''}`;
    case 'ui_scroll': return `↕️ Scroll ${input.target ? `to “${input.target}”` : (input.direction || 'down')}`;
    case 'ui_back': return '↩️ Go back';
    case 'list_profile_nicknames': return '🏷️ List your saved nicknames';
    case 'resolve_profile_nickname': return `🏷️ Look up "${input.nickname}"`;
    default: return `• ${name}`;
  }
}

function audit({ userId, inputText, actionName, actionInput, status, resultSummary }) {
  db.prepare(`
    INSERT INTO codex_actions (id, user_id, input_text, action_name, action_input, status, result_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), userId, inputText, actionName || null, actionInput ? JSON.stringify(actionInput) : null, status, resultSummary || null);
}

router.get('/status', requireAuth, (_req, res) => {
  res.json({ configured: true, offlineUnderstanding: true, local: true });
});

router.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM codex_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.userId);
  res.json({ actions: rows.map(r => ({ id: r.id, inputText: r.input_text, actionName: r.action_name, status: r.status, resultSummary: r.result_summary, createdAt: r.created_at })) });
});

router.post('/act', requireAuth, async (req, res) => {
  const { text, context: rawContext, history, confirmedAction, resolvedAction, confirmedPlan, remainingActions } = req.body || {};
  // `controls` is the live map of everything pressable on screen (see uiAgent.js). It travels with
  // the context but is kept separate: it's large, untrusted page text, and only the UI tools use it.
  const { controls: rawControls, ...context } = (rawContext && typeof rawContext === 'object') ? rawContext : {};
  const controls = sanitizeControls(rawControls);
  const io = req.app.get('io');

  let actionsQueue;
  let inputTextForAudit = text;
  let requiresPlanPreview = false;

  if (confirmedAction && confirmedAction.name) {
    // The user already saw the confirmation prompt and said yes — skip AI resolution for
    // this one action, but every authorization/ownership check below still runs exactly
    // as it would for any other action. Confirmation never bypasses validation, only the
    // "ask again" step. Any further steps from the original multi-action request (e.g.
    // "block him and send Priya this reel") continue afterward via remainingActions.
    actionsQueue = [{ ...confirmedAction, __alreadyConfirmed: true }, ...(Array.isArray(remainingActions) ? remainingActions : [])];
    inputTextForAudit = `[confirmed] ${confirmedAction.name}`;
  } else if (resolvedAction && resolvedAction.name) {
    // The user picked one of several people with matching names/usernames after a
    // resolveUser() disambiguation prompt. This is NOT a confirmation — it does not skip
    // the destructive-action confirmation step, since the person only chose *who*, not
    // *whether*. It re-enters the queue like a fresh action and gets fully re-validated.
    actionsQueue = [resolvedAction, ...(Array.isArray(remainingActions) ? remainingActions : [])];
    inputTextForAudit = `[resolved] ${resolvedAction.name}`;
  } else if (Array.isArray(confirmedPlan) && confirmedPlan.length) {
    // Section 171 — the user approved the whole multi-step plan preview below. This
    // re-enters the ordinary execution loop, so any individual destructive step or
    // ambiguous name inside the plan still pauses and asks on its own; approving the plan
    // only means "yes, that's what I meant", not "skip every other safety check".
    actionsQueue = confirmedPlan;
    inputTextForAudit = '[plan confirmed]';
  } else {
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: { code: 'EMPTY_INPUT', message: 'Say something for Codex to act on.' } });
    }
    // Understanding pipeline: the local NLU engine (nlu.js / uiAgent.js) — fully offline. Either way the result is the same allowlisted tool calls, and every one is
    // re-validated and executed by executeAction() below.
    const cleanText = text.trim();
    const env = { context, person: (w) => personStrength(req.userId, w), apps: loadAppsForNlu() };
    let meaningful = [];

    if (!meaningful.length) {
      // (a) Explicit on-screen commands — alone or mixed with ordinary ones ("open settings and
      //     press dark", "scroll down", "type hello in search"). Only fires when a UI step is present.
      const mixed = planMixed(cleanText, { parseCommand, env, splitRe: SPLIT_RE });
      if (mixed) {
        if (mixed.actions.length) meaningful = mixed.actions;
        else {
          audit({ userId: req.userId, inputText: text, status: 'no_match', resultSummary: mixed.clarify });
          return res.json({ handled: false, message: mixed.clarify });
        }
      }
    }

    if (!meaningful.length) {
      let nlu = parseCommand(cleanText, env);
      // (b) The offline NLU didn't know the phrase (or needed more info), but something on screen
      //     matches it well — "edit profile", "accept", "next", "maru" — so press that.
      if ((nlu.kind === 'none' || nlu.kind === 'clarify') && controls.length) {
        const guess = resolveControl(cleanText, controls, { minScore: 0.75 });
        if (guess.status === 'ok' || guess.status === 'already' || guess.status === 'ambiguous') {
          nlu = { kind: 'actions', actions: [{ name: 'ui_click', input: { target: cleanText } }] };
        }
      }
      if (nlu.kind === 'actions') {
        meaningful = nlu.actions;
      } else if (nlu.kind === 'reply') {
        audit({ userId: req.userId, inputText: text, status: 'executed', resultSummary: 'reply' });
        return res.json({ handled: true, message: nlu.message, navigate: nlu.navigate });
      } else if (nlu.kind === 'clarify') {
        audit({ userId: req.userId, inputText: text, status: 'no_match', resultSummary: nlu.message });
        return res.json({ handled: false, message: nlu.message });
      } else {
        audit({ userId: req.userId, inputText: text, status: 'no_match', resultSummary: 'no local match' });
        return res.json({ handled: false, message: `I didn't understand that. Try rephrasing, or type "help" to see what I can do.` });
      }
    }
    // The specialised like/save tools act on "the open Reel/Post" from the screen context. If that
    // context is missing but the matching button is visibly on screen, press the button instead of
    // answering "nothing is open".
    if (!context.currentReel && !context.currentPost && controls.length) {
      const WORD = { like_content: 'like', unlike_content: 'unlike', save_content: 'save', unsave_content: 'unsave' };
      meaningful = meaningful.map(a => {
        const w = WORD[a.name];
        if (!w) return a;
        const g = resolveControl(w, controls, { minScore: 0.75 });
        return (g.status === 'ok' || g.status === 'already') ? { name: 'ui_click', input: { target: w } } : a;
      });
    }
    actionsQueue = meaningful;
    requiresPlanPreview = actionsQueue.length > 1;
  }

  if (requiresPlanPreview) {
    audit({ userId: req.userId, inputText: text, status: 'pending_preview', resultSummary: actionsQueue.map(a => a.name).join(', ') });
    return res.json({
      handled: true,
      needsPreview: true,
      message: 'Here\'s what I understood:',
      steps: actionsQueue.map(a => describeStep(a.name, a.input)),
      pendingPlan: actionsQueue,
    });
  }

  const messages = [];
  let lastNavigate, lastOpenUrl, lastStartCall, lastSetTheme;
  // Everything the browser must do, in the order the user asked for it. Only sent when a UI step
  // is involved (the browser then runs its observe→act loop); otherwise the legacy fields below suffice.
  const sequence = [];
  let hasUiStep = false;

  while (actionsQueue.length) {
    const { name, input, __alreadyConfirmed } = actionsQueue.shift();

    if (DESTRUCTIVE.has(name) && !__alreadyConfirmed) {
      audit({ userId: req.userId, inputText: inputTextForAudit, actionName: name, actionInput: input, status: 'pending_confirmation' });
      return res.json({
        handled: true,
        needsConfirmation: true,
        message: [...messages, confirmationPrompt(name, input)].filter(Boolean).join(' '),
        pendingAction: { name, input },
        remainingActions: actionsQueue,
      });
    }

    try {
      const result = executeAction(name, input, { req, io, context });
      if (result.message) messages.push(result.message);
      if (result.navigate) { lastNavigate = result.navigate; sequence.push({ kind: 'navigate', ...result.navigate }); }
      if (result.openUrl) { lastOpenUrl = result.openUrl; sequence.push({ kind: 'openUrl', url: result.openUrl }); }
      if (result.startCall) { lastStartCall = result.startCall; sequence.push({ kind: 'startCall', ...result.startCall }); }
      if (result.setTheme) { lastSetTheme = result.setTheme; sequence.push({ kind: 'theme', theme: result.setTheme }); }
      if (result.uiStep) { hasUiStep = true; sequence.push({ kind: 'ui', step: result.uiStep }); }
      audit({ userId: req.userId, inputText: inputTextForAudit, actionName: name, actionInput: input, status: 'executed', resultSummary: result.message });
    } catch (err) {
      if (err.isAmbiguous) {
        audit({ userId: req.userId, inputText: inputTextForAudit, actionName: name, actionInput: input, status: 'pending_disambiguation', resultSummary: `${err.candidates.length} matches` });
        return res.json({
          handled: true,
          needsDisambiguation: true,
          message: [...messages, err.message].filter(Boolean).join(' '),
          pendingAction: { name, input },
          candidates: err.candidates,
          remainingActions: actionsQueue,
        });
      }
      messages.push(err.message);
      // Steps that already succeeded and need the browser (navigate, UI presses) still run, up to the failure.
      audit({ userId: req.userId, inputText: inputTextForAudit, actionName: name, actionInput: input, status: 'failed', resultSummary: err.message });
      // Honest partial-completion: stop the sequence on the first failure rather than
      // continuing as if nothing went wrong.
      break;
    }
  }

  return res.json({ handled: true, message: messages.filter(Boolean).join(' '), navigate: lastNavigate, openUrl: lastOpenUrl, startCall: lastStartCall, setTheme: lastSetTheme, sequence: hasUiStep ? sequence : undefined });
});

// ───────────────────────── live-screen control resolution ─────────────────────────
// The browser calls this for every on-screen step ("press X", "type into Y", "scroll to Z"):
// it sends a fresh scan of the screen and gets back exactly one decision. Re-resolving against a
// fresh scan at each step is what lets multi-step commands work across page changes
// ("open settings and press dark" — the Dark button doesn't exist until Settings has loaded).
const publicControl = (c) => c && ({ id: c.id, label: c.label, kind: c.kind, type: c.type });

router.post('/ui-resolve', requireAuth, async (req, res) => {
  const { action, query, controlId, controls: rawList } = req.body || {};
  const list = sanitizeControls(rawList);
  const q = String(query ?? '').slice(0, 200);
  if (!list.length) return res.json({ status: 'none', message: "I can't see any controls on this screen yet." });

  let r;
  if (action === 'scroll') r = resolveLandmark(q, list);
  else if (action === 'type') r = resolveField(q, list);
  else r = resolveControl(q, list, { hintId: controlId });

  // Local fallback: a looser fuzzy match over the same on-screen control map (still risk-checked below).
  if (r.status === 'none' && q.trim() && action !== 'scroll') {
    const loose = resolveControl(q, list, { hintId: controlId, minScore: 0.45, kinds: action === 'type' ? ['input', 'select'] : undefined });
    if (loose.status === 'ok') r = { ...loose, via: 'local' };
  }

  const out = { status: r.status, message: r.message };
  if (r.control) {
    out.control = publicControl(r.control);
    // The risk level is always computed here, from the control itself — never taken from the
    // browser or the model.
    out.risk = r.status === 'ok' ? (r.risk || riskOf(r.control)) : undefined;
  }
  if (r.candidates) out.candidates = r.candidates;
  res.json(out);
});

// The browser reports what it actually did, so the audit log shows real outcomes
// (pressed / cancelled / refused / not found) rather than just intentions.
router.post('/ui-report', requireAuth, (req, res) => {
  const { step, label, outcome, detail } = req.body || {};
  const name = { click: 'ui_click', type: 'ui_type', scroll: 'ui_scroll', back: 'ui_back' }[step] || 'ui_click';
  const ok = outcome === 'done';
  audit({
    userId: req.userId,
    inputText: `[screen] ${String(label ?? '').slice(0, 80)}`,
    actionName: name,
    actionInput: { label: String(label ?? '').slice(0, 80), outcome: String(outcome ?? '').slice(0, 20) },
    status: ok ? 'executed' : 'failed',
    resultSummary: ok ? `Pressed “${String(label ?? '').slice(0, 60)}”` : `${String(outcome ?? 'failed').slice(0, 20)}: ${String(detail ?? '').slice(0, 120)}`,
  });
  res.json({ ok: true });
});

// All actual execution lives here so both the fresh-request path and the post-confirmation
// path run through the exact same authorization logic — confirmation only skips re-asking,
// never re-validates less strictly.
function executeAction(name, input, { req, io, context }) {
  // Every action that carries a `username` (send_message, follow, mute, block, restrict,
  // start_call, share_content, invite_to_game...) is resolved through the same
  // disambiguation-aware lookup before its own logic runs, so "message rahul" and "invite
  // rahul to a game" get identical, real user resolution rather than each branch trusting
  // whatever raw string the model produced.
  if (input && typeof input.username === 'string' && input.username.trim()) {
    const resolved = resolveUser(input.username, req.userId);
    input = { ...input, username: resolved.username, __resolvedUserId: resolved.id };
  }
  switch (name) {
    case 'send_message': {
      if (input.__resolvedUserId === req.userId) throw new Error("You can't message yourself.");
      const r = sendDirectMessage({ fromUserId: req.userId, toUsername: input.username, text: input.text, io });
      if (r.httpStatus >= 400) throw new Error(r.body.error.message);
      return { message: r.body.status === 'sent' ? `Sent to @${input.username}.` : r.body.message, navigate: { screen: 'messages', username: input.username } };
    }
    case 'follow_user':
    case 'unfollow_user': {
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(input.username);
      if (!target) throw new Error('User not found.');
      if (name === 'follow_user') {
        if (isBlocked(req.userId, target.id)) throw new Error('Unable to follow this user.');
        db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)').run(req.userId, target.id);
        db.prepare("INSERT INTO notifications (id, recipient_id, actor_id, type) VALUES (?, ?, ?, 'follow')").run(uuid(), target.id, req.userId);
      } else {
        db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?').run(req.userId, target.id);
      }
      return { message: `${name === 'follow_user' ? 'Followed' : 'Unfollowed'} @${input.username}.`, navigate: { screen: 'profile', username: input.username } };
    }
    case 'navigate': {
      const label = input.screen === 'saved-posts' ? 'your saved posts' : input.screen === 'saved-reels' ? 'your saved reels' : input.screen === 'reels-history' ? 'your reels history' : input.screen === 'profile-studio' ? 'your Profile Studio' : input.screen;
      return { message: `Opening ${label}.`, navigate: { screen: input.screen, username: input.username, tab: input.tab } };
    }
    case 'set_theme': {
      return { message: `Switched to ${input.theme} mode.`, setTheme: input.theme };
    }
    case 'start_call': {
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(input.username);
      if (!target) throw new Error('User not found.');
      if (isBlocked(req.userId, target.id)) throw new Error("You can't call this user.");
      const convo = db.prepare(`
        SELECT c.id FROM conversations c
        JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = ?
        JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = ?
        WHERE c.type = 'direct' LIMIT 1
      `).get(req.userId, target.id);
      if (!convo) throw new Error(`You don't have a conversation with @${input.username} yet, so I can't start a call. Message them first.`);
      return { message: `Starting a ${input.video ? 'video' : 'voice'} call with @${input.username}…`, navigate: { screen: 'messages', username: input.username }, startCall: { conversationId: convo.id, type: input.video ? 'video' : 'voice' } };
    }
    case 'open_app': {
      const normalized = input.appName.toLowerCase();
      let app = db.prepare(`
        SELECT ar.* FROM app_registry ar LEFT JOIN app_aliases aa ON aa.app_id = ar.id
        WHERE LOWER(ar.display_name) = ? OR aa.alias = ? LIMIT 1
      `).get(normalized, normalized);
      if (!app) app = db.prepare(`
        SELECT ar.* FROM app_registry ar LEFT JOIN app_aliases aa ON aa.app_id = ar.id
        WHERE LOWER(ar.display_name) LIKE ? OR aa.alias LIKE ? LIMIT 1
      `).get(`%${normalized}%`, `%${normalized}%`);
      if (!app) throw new Error(`I don't have "${input.appName}" in the app catalog for this build.`);
      if (app.native_only) throw new Error(`${app.display_name} doesn't have a web version I can open from a browser — this build can't launch native OS apps.`);
      const url = (input.searchFor && app.search_url_template) ? app.search_url_template.replace('{q}', encodeURIComponent(input.searchFor)) : app.launch_url_web;
      return { message: `Opening ${app.display_name}${input.searchFor ? ` and searching "${input.searchFor}"` : ''}…`, openUrl: url };
    }
    case 'create_note': {
      const id = uuid();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO notes (id, user_id, text, emoji, audience, expires_at) VALUES (?, ?, ?, ?, 'followers', ?)
        ON CONFLICT(user_id) DO UPDATE SET id = excluded.id, text = excluded.text, emoji = excluded.emoji, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at = excluded.expires_at
      `).run(id, req.userId, input.text.slice(0, 60), input.emoji || null, expiresAt);
      return { message: 'Posted your note.', navigate: { screen: 'messages' } };
    }
    case 'create_story': {
      const id = uuid();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      db.prepare(`INSERT INTO stories (id, user_id, media_type, content, audience, expires_at) VALUES (?, ?, 'text', ?, 'everyone', ?)`)
        .run(id, req.userId, input.text.slice(0, 200), expiresAt);
      return { message: 'Posted your story.', navigate: { screen: 'feed' } };
    }
    case 'search': {
      return { message: `Searching for "${input.query}".`, navigate: { screen: 'search', query: input.query } };
    }
    case 'invite_to_game': {
      const created = createRoom(input.gameId, req.userId);
      if (created.error) throw new Error(created.error);
      const inviteText = `Join my ${created.game.name} game on NEXA — invite code: ${created.room.invite_code}`;
      const r = sendDirectMessage({ fromUserId: req.userId, toUsername: input.username, text: inviteText, io });
      if (r.httpStatus >= 400) throw new Error(r.body.error.message);
      return { message: `Created a ${created.game.name} room and invited @${input.username}.`, navigate: { screen: 'games' } };
    }
    case 'join_game': {
      const joined = joinRoomByCode(input.inviteCode, req.userId);
      if (joined.error) throw new Error(joined.error);
      io?.to(`game:${joined.room.id}`).emit('game:state', roomDTO(joined.room));
      return { message: 'Joined the game room.', navigate: { screen: 'games' } };
    }
    case 'create_post': {
      const cap = input.caption.slice(0, 2200);
      if (!cap.trim()) throw new Error('A post needs some text.');
      const id = uuid();
      db.prepare('INSERT INTO posts (id, user_id, caption) VALUES (?, ?, ?)').run(id, req.userId, cap);
      processMentionsAndHashtags({ text: cap, sourceType: 'post', sourceId: id, actorId: req.userId, io });
      return { message: 'Posted to your feed.', navigate: { screen: 'feed' } };
    }
    case 'create_reel': {
      const url = (input.videoUrl || '').trim();
      if (!REEL_URL_RE.test(url)) {
        throw new Error('That needs to be a direct link to an already-hosted .mp4/.webm/.mov file — to post from a file on your device, use the Upload option on the Reels page instead.');
      }
      const cap = (input.caption || '').slice(0, 2200);
      const id = uuid();
      db.prepare('INSERT INTO reels (id, user_id, video_url, caption) VALUES (?, ?, ?, ?)').run(id, req.userId, url.slice(0, 2000), cap);
      processMentionsAndHashtags({ text: cap, sourceType: 'reel', sourceId: id, actorId: req.userId, io });
      return { message: 'Posted your reel.', navigate: { screen: 'reels' } };
    }
    case 'mute_user':
    case 'unmute_user': {
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(input.username);
      if (!target) throw new Error('User not found.');
      if (name === 'mute_user') db.prepare('INSERT OR IGNORE INTO mutes (muter_id, muted_id) VALUES (?, ?)').run(req.userId, target.id);
      else db.prepare('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?').run(req.userId, target.id);
      return { message: `${name === 'mute_user' ? 'Muted' : 'Unmuted'} @${input.username}.`, navigate: { screen: 'profile', username: input.username } };
    }
    case 'block_user':
    case 'unblock_user': {
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(input.username);
      if (!target) throw new Error('User not found.');
      if (target.id === req.userId) throw new Error("You can't do that to yourself.");
      if (name === 'block_user') {
        db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.userId, target.id);
        db.prepare('DELETE FROM follows WHERE (follower_id = ? AND followed_id = ?) OR (follower_id = ? AND followed_id = ?)')
          .run(req.userId, target.id, target.id, req.userId);
      } else {
        db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.userId, target.id);
      }
      return { message: `${name === 'block_user' ? 'Blocked' : 'Unblocked'} @${input.username}.`, navigate: { screen: 'profile', username: input.username } };
    }
    case 'restrict_user':
    case 'unrestrict_user': {
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(input.username);
      if (!target) throw new Error('User not found.');
      if (target.id === req.userId) throw new Error("You can't do that to yourself.");
      if (name === 'restrict_user') db.prepare('INSERT OR IGNORE INTO restricts (owner_id, restricted_id) VALUES (?, ?)').run(req.userId, target.id);
      else db.prepare('DELETE FROM restricts WHERE owner_id = ? AND restricted_id = ?').run(req.userId, target.id);
      return { message: `${name === 'restrict_user' ? 'Restricted' : 'Unrestricted'} @${input.username}.`, navigate: { screen: 'profile', username: input.username } };
    }
    case 'share_content': {
      const reel = context?.currentReel, post = context?.currentPost;
      if (!reel && !post) throw new Error("There's no Reel or Post currently open to share.");
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(input.username);
      if (!target) throw new Error('User not found.');
      const label = reel ? 'Reel' : 'Post';
      const caption = (reel || post).caption;
      const shareText = `Shared a ${label} on NEXA${caption ? `: "${caption.slice(0, 100)}"` : ''}`;
      const r = sendDirectMessage({ fromUserId: req.userId, toUsername: input.username, text: shareText, io });
      if (r.httpStatus >= 400) throw new Error(r.body.error.message);
      return { message: r.body.status === 'sent' ? `Sent the ${label.toLowerCase()} to @${input.username}.` : r.body.message, navigate: { screen: 'messages', username: input.username } };
    }
    case 'like_content': {
      const reel = context?.currentReel, post = context?.currentPost;
      if (!reel && !post) throw new Error("There's no Reel or Post currently open to like.");
      if (reel) { db.prepare('INSERT OR IGNORE INTO reel_likes (user_id, reel_id) VALUES (?, ?)').run(req.userId, reel.id); return { message: 'Liked the reel.' }; }
      db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(req.userId, post.id);
      return { message: 'Liked the post.' };
    }
    case 'save_content': {
      const reel = context?.currentReel, post = context?.currentPost;
      if (!reel && !post) throw new Error("There's no Reel or Post currently open to save.");
      if (reel) { db.prepare('INSERT OR IGNORE INTO saved_reels (user_id, reel_id) VALUES (?, ?)').run(req.userId, reel.id); return { message: 'Saved the reel.' }; }
      db.prepare('INSERT OR IGNORE INTO saved_posts (user_id, post_id) VALUES (?, ?)').run(req.userId, post.id);
      return { message: 'Saved the post.' };
    }
    case 'unlike_content': {
      const reel = context?.currentReel, post = context?.currentPost;
      if (!reel && !post) throw new Error("There's no Reel or Post currently open to unlike.");
      if (reel) { db.prepare('DELETE FROM reel_likes WHERE user_id = ? AND reel_id = ?').run(req.userId, reel.id); return { message: 'Removed your like from the reel.' }; }
      db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.userId, post.id);
      return { message: 'Removed your like from the post.' };
    }
    case 'unsave_content': {
      const reel = context?.currentReel, post = context?.currentPost;
      if (!reel && !post) throw new Error("There's no Reel or Post currently open to unsave.");
      if (reel) { db.prepare('DELETE FROM saved_reels WHERE user_id = ? AND reel_id = ?').run(req.userId, reel.id); return { message: 'Removed the reel from your saved items.' }; }
      db.prepare('DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?').run(req.userId, post.id);
      return { message: 'Removed the post from your saved items.' };
    }
    case 'comment_content': {
      const reel = context?.currentReel, post = context?.currentPost;
      if (!reel && !post) throw new Error("There's no Reel or Post currently open to comment on.");
      const text = String(input.text || '').trim().slice(0, 1000);
      if (!text) throw new Error('What should the comment say?');
      const id = uuid();
      if (reel) {
        const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(reel.id);
        if (!row) throw new Error('That reel is no longer available.');
        db.prepare('INSERT INTO reel_comments (id, reel_id, user_id, text) VALUES (?, ?, ?, ?)').run(id, row.id, req.userId, text);
        if (row.user_id !== req.userId) {
          db.prepare("INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, 'reel_comment', ?)").run(uuid(), row.user_id, req.userId, row.id);
          io?.to(`user:${row.user_id}`).emit('notification:new', { type: 'reel_comment' });
        }
        return { message: 'Commented on the reel.' };
      }
      const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(post.id);
      if (!row) throw new Error('That post is no longer available.');
      db.prepare('INSERT INTO comments (id, post_id, user_id, parent_comment_id, text) VALUES (?, ?, ?, NULL, ?)').run(id, row.id, req.userId, text);
      processMentionsAndHashtags({ text, sourceType: 'comment', sourceId: id, actorId: req.userId, io });
      if (row.user_id !== req.userId) {
        db.prepare('INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, ?, ?)').run(uuid(), row.user_id, req.userId, 'comment', row.id);
        io?.to(`user:${row.user_id}`).emit('notification:new', { type: 'comment' });
      }
      return { message: 'Commented on the post.' };
    }
    case 'mark_notifications_read': {
      const r = db.prepare('UPDATE notifications SET read = 1 WHERE recipient_id = ? AND read = 0').run(req.userId);
      return { message: r.changes ? `Marked ${r.changes} notification${r.changes === 1 ? '' : 's'} as read.` : 'You have no unread notifications.', navigate: { screen: 'notifications' } };
    }
    case 'save_profile_nickname': {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(input.__resolvedUserId);
      const r = saveProfileNickname(req.userId, target, input.nickname);
      return { message: r.status === 'unchanged' ? `@${input.username} is already saved as "${r.nickname}".` : `Saved @${input.username} as "${r.nickname}".` };
    }
    case 'update_profile_nickname': {
      const r = updateProfileNickname(req.userId, input.oldNickname, input.newNickname);
      return { message: `Renamed "${input.oldNickname}" to "${r.nickname}" (@${r.profile.username}).` };
    }
    case 'delete_profile_nickname': {
      const r = deleteProfileNickname(req.userId, input.nickname);
      return { message: `Forgot the nickname "${r.nickname}" for @${r.profile.username}.` };
    }
    case 'list_profile_nicknames': {
      const rows = listProfileNicknames(req.userId);
      if (!rows.length) return { message: "You haven't saved any nicknames yet." };
      return { message: `Your nicknames: ${rows.map(r => `"${r.nickname}" → @${r.targetUsername}`).join(', ')}.` };
    }
    case 'resolve_profile_nickname': {
      const found = userRowForNickname(req.userId, input.nickname);
      if (found.status === 'ambiguous') { const e = new Error(`Which "${input.nickname}" do you mean?`); e.isAmbiguous = true; e.candidates = found.candidates; throw e; }
      if (found.status === 'none' || !found.user) throw new Error(`I couldn't find a profile saved as ${input.nickname}.`);
      return { message: `"${input.nickname}" is @${found.user.username} (${found.user.display_name}).` };
    }
    case 'ui_click':
    case 'ui_type':
    case 'ui_scroll':
    case 'ui_back':
      // Executed in the browser against the live screen — the backend only validates and relays.
      return { message: '', uiStep: cleanUiStep(name, input) };
    case 'delete_post': {
      const post = context?.currentPost;
      if (!post) throw new Error('No post is currently open to delete.');
      const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
      if (!row || row.deleted_at) throw new Error('That post is no longer available.');
      if (row.user_id !== req.userId) throw new Error('You can only delete your own posts.');
      db.prepare("UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
      return { message: 'Post deleted.', navigate: { screen: 'feed' } };
    }
    default:
      throw new Error('Unrecognized action.');
  }
}

export default router;
