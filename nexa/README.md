# NEXA — Extended Build

A real, runnable implementation covering most of the NEXA spec end to end against a real
SQLite database — no mocked success states, no fake data. Every button calls a real API
endpoint or a real Socket.io event and shows the real result.

## What's actually implemented

**Auth & Security**
- Signup/login/logout, bcrypt hashing, JWT access + rotating refresh tokens
- Real TOTP 2FA (setup → scan into an authenticator app → enable → required on next login)
- Account deactivate/reactivate-on-login, delete-with-14-day-grace-period/cancel
- Rate limiting on all routes (tighter on auth)

**Social graph**
- Follow/unfollow, block, mute, restrict, close friends
- Profile relationship menu (mute/restrict/block/report)

**Games**
- Tic-Tac-Toe, Connect Four, Checkers and **Chess** (server-validated moves, check /
  checkmate / stalemate). Chess uses simplified rules, stated in the UI: no castling, no en
  passant, pawns always promote to a queen. Run `npm run seed` once on an existing database
  to add Chess to the game catalog.

**Content**
- Posts, comments (with replies, edit, delete, and author-side hide/moderation),
  duplicate-safe likes, real @mention and #hashtag parsing (→
  notifications, → searchable)
- Editing: posts, comments, reels (caption), and notes (a true edit that preserves the
  original 24h timer, distinct from posting a new note) all support real edits with
  ownership checks and `editedAt` tracking
- Saved posts and saved reels
- Stories (24h, text/image, audience control, per-viewer tracking) and Notes (24h,
  audience control, replies routed through the real message-request system)
- Reels (video-URL based — see media note below)
- Following feed + engagement-ranked "For You" feed, both paginated and block/mute-aware


**Media upload & editing (posts, stories, reels)**
- Posts, stories and reels all accept a **photo or video from the device**: the native file
  picker (gallery / camera roll / any downloaded file), a **Camera** button that opens the
  phone camera directly, or drag-and-drop a file onto the box on desktop. Photos
  (.jpg/.png/.webp/.gif, ≤10MB) and videos (.mp4/.webm/.mov — **any size** for posts and stories; reels stay ≤50MB). Stories still support
  text and image URLs too. Reels are video-only.
- The server checks each upload's real file header (not just the browser-supplied type), so
  a renamed `.html` can't be passed off as a photo; a blank/generic type from a downloaded
  file falls back to its extension.
- **Photo editor** (before posting, and again after posting): crop with draggable handles and
  1:1 / 4:5 / 9:16 / 16:9 presets, rotate, flip, filter presets + brightness / contrast /
  saturation / sepia / B&W / hue / blur, text, and freehand drawing. The result is baked into
  a new JPEG. An edited animated GIF loses its animation (one frame is rendered).
- **Video editor** (before and after posting): trim, playback speed (0.5×–2×), mute, colour
  filters, and draggable text overlays. **Videos are not re-encoded** — this server has no
  transcoder. Instead the edits are saved as a small settings document next to the original
  file and applied during playback for every viewer. Upside: any video can be re-edited later
  without quality loss. Downside: the raw file at `/uploads/...` is the *unedited* original,
  so a downloaded copy won't include the trim/filter/text.
- Story videos have no size or length cap. (To restore a length cap, set `MAX_STORY_VIDEO_SECONDS` in
  `backend/src/uploads.js` and `MAX_STORY_SECONDS` in `frontend/src/editSettings.js`.)
- Profile videos must be 40 seconds or under (checked in the browser, re-checked with `ffprobe` when installed).
- After posting you can edit a post, reel or story: change the caption, re-open the editor,
  or replace the file (old file is deleted from disk). Editing a story does not reset its
  24-hour timer.
- Existing databases upgrade automatically on startup (new columns, and `stories` is rebuilt
  once to allow video — views and indexes are preserved).
**Messaging**
- The mandatory message-request gate (Accept/Delete/Block/Report)
- One-to-one + group conversations, chat themes
- Message reactions, edit, delete, pin/unpin, forward
- Realtime delivery over Socket.io

**Calls**
- Real WebRTC signaling over Socket.io: invite → ring (45s auto-timeout to "missed") →
  accept/decline → SDP/ICE relay → end → history. Voice and video, mute/camera toggle.
- STUN-only (no TURN) — reliable on the same network/localhost; a production deployment
  would need a TURN server for calls across restrictive NATs.

**Games & Game Store**
- Server-authoritative Tic-Tac-Toe, Connect Four, and Checkers (pluggable engine in
  `gameEngine.js` — every move validated server-side, no client-trusted state)
- Game Store with **Discover** (per-game real open-room counts, no fabricated stats),
  **Friends** (privacy-respecting: only rooms hosted by people you follow),
  **My Games**, and **Tournaments**
- **Tournaments**: a real round-robin bracket — pick a game, invite people, and starting
  it generates a genuine, playable game room for every pair. Standings update
  automatically the instant a match finishes, with zero client-reported results.
- Room creation, invite codes, ready-up flow, forfeit-on-disconnect, and a real
  message-based invite flow (`SEND_GAME_INVITE`)

**Search & Moderation**
- Search users and hashtags; tap a hashtag to see everything tagged with it
- Report content/users, stored for moderation review
- Missed calls generate a real notification (verified with an actual 45-second live
  test, not just code review): the caller's timeout, the DB status change, the realtime
  push, and the persisted notification record all confirmed working together

**Codex understanding layer (new) — works fully offline — no API key**
- `backend/src/nlu.js`: a deterministic multilingual intent engine. It tolerates typos
  (edit distance + consonant-skeleton matching, e.g. `follw`, `blok`, `mesage`, `anupu`/`anuppu`),
  any word order (`send rahul hi` = `hi to rahul` = `rahul ku hi anupu`), politeness filler
  (`pls`, `can you`), Tanglish/Hinglish particles (`-ku`, `-ah`, `pannu`, `nu sollu`), and
  vocabulary in English, Tamil/Telugu/Kannada/Malayalam/Bengali/Hindi (romanised and native
  script), Spanish, French, German, Portuguese, Arabic, Japanese, Chinese, Korean and Russian.
  `open messages` = `open msg` = `message open pannu` = `msg`; `game store open pannu` = `games`
  = `game`; `reels` = `reel` = `reels open pannu`.
- Message text is preserved exactly as typed (including words like "follow" inside it);
  `"quoted text"` and `message x: text` are taken verbatim. Names are resolved with the same
  DB-backed lookup as before, now also tolerating a one-letter typo in a username.
- Pipeline: LLM first when `ANTHROPIC_API_KEY` is set; the offline NLU answers when there is no
  key, the call fails, or the model finds no match. Both produce the same allowlisted tool calls,
  and every one is still validated, confirmed (block / delete) and audit-logged by `executeAction`.
- New tools: `unlike_content`, `unsave_content`, `comment_content`, `mark_notifications_read`;
  `invite_to_game` now accepts `chess`.
- Honest limits: the NLU is vocabulary-based, not a language model. A language or phrasing outside
  its word lists falls through to the LLM (if configured) or a polite "I didn't understand". To
  teach it a word, add it to the matching concept in `LEX_SRC` in `nlu.js`. Run `npm test` in
  `backend/` for the regression tests (NLU + screen agent, 46 in total).

**Codex screen agent (new) — operates every button and page, in any language**
- **Sees your screen.** On every command the browser reads the live DOM (`frontend/src/uiControls.js`):
  every visible button, tab, link, switch, text box, clickable card/row, and section heading — with its
  label, nearby text ("Priya"), whether it is on screen, how close it is to the middle of the screen, and
  whether it sits in a dialog. Nothing is registered per button, so **any button added to any page is
  controllable with no code changes**. Field *values* are never read or sent.
- **Resolves by meaning** (`backend/src/uiAgent.js`, offline, no key needed): English, Tanglish, Hinglish,
  Telugu/Kannada/Malayalam/Bengali romanisations, Tamil/Hindi/Arabic/Japanese/Chinese/Korean/Russian
  native script, plus Spanish/French/German/Portuguese — with typos (`lyk`, `commnet`, `likee`, `sned`,
  `appearence`), filler (`pls`, `button`, `pannu`, `dabao`) and any word order. Icon-only buttons are
  understood (♡/♥ like, 💬 comments, 🔖 save, ➤ send, ✕ close, ⚙ settings, 📞/🎥 calls, ⏻ log out…).
  Examples: `like button click pannu`, `comment button dabao`, `pidichiruku priya`, `settings la dark button
  click pannu`, `Following tab`, `second like`, `video call`, `close`, `next reel`, `scroll to privacy`,
  `type "hello" in the comment box and send`, `go back`.
- **Understands context.** A control is matched using the post/person next to it ("arjun like"), the one
  in the middle of the screen wins ties (so "like" likes the post you're looking at), an open dialog takes
  priority, and ordinals work ("last like").
- **State-aware.** "like" on an already-liked post answers *"That's already liked."* instead of un-liking it;
  `unlike`, `like venam`, `stop following` do the reverse. Tabs are treated as places, not toggles.
- **Asks instead of guessing.** If several different controls fit ("call" → 📞 or 🎥) it shows a picker.
- **Agent loop.** Multi-step commands ("open settings and press dark") run as observe → resolve → act →
  wait for the page to settle → re-scan → next step, so a control that only exists after a page change is
  found. It highlights each control before pressing it, stops at the first failed step and says so, has a
  **Stop** button, and never runs more than 8 steps per command.
- **Safety is enforced in code, not in a prompt** (`riskOf` in `uiAgent.js`, applied to the offline matcher
  *and* the LLM):
  - *Never pressed:* password fields, 2FA set-up/disable/confirm, deactivate account, delete account,
    change password, payment-style controls, file inputs. Codex will open the page and tell you to tap it.
  - *Always asks first:* Delete, Remove, Block, Report, Decline, End call, Log out, Leave, Reset…
  - On-screen text is untrusted: the model is told that labels are data, and even a hijacked model cannot
    press a blocked control. The server recomputes risk itself; it never trusts the browser or the model.
- **New tools / endpoints:** `ui_click`, `ui_type`, `ui_scroll`, `ui_back` (also offered to the LLM);
  `POST /api/codex/ui-resolve` (one decision per on-screen step, on its own 240/min limit so a multi-step
  command isn't throttled; `/act` stays at 20/min) and `POST /api/codex/ui-report` (real outcomes —
  pressed / cancelled / refused / not found — land in the existing Codex action log).
- **Fallback chain for a command:** LLM (if a key is set) → explicit UI commands (alone or mixed with normal
  ones) → the existing offline NLU → "something on screen matches this well" → honest "I didn't understand".
  The existing like/save tools fall back to the visible button when no post is registered as open.
- **What I verified, and what I did not.** Verified with automated tests: 46 backend tests (`npm test`),
  a live-server run of `/act`, `/ui-resolve` and `/ui-report`, the real scanner/actuator in jsdom (finds
  buttons, clickable divs, headings; skips hidden/Codex's own controls; presses, types, submits), and the
  real `Codex.jsx` rendered in jsdom against the live backend (12 scenarios: Tanglish/Hinglish presses,
  confirm + cancel, blocked refusal, ambiguity picker, multi-step across a page change, honest failure).
  **Not verified:** the AI-key path (no key here), and real-browser layout behaviour — jsdom has no layout, so
  "closest to the middle of the screen", dialog detection via `position: fixed`, the cursor-pointer
  heuristic for clickable divs, and smooth scrolling should be sanity-checked once in Chrome. File pickers:
  Codex can press an "Upload" button, but the browser may refuse to open the picker without a fresh tap.
- **Honest limit.** Offline understanding is vocabulary-based, not a language model. Everyday UI words are
  covered in the languages above; a word outside the lists is simply not understood offline (Codex says so)
  but works with `ANTHROPIC_API_KEY` set, since the model sees the same screen map. To teach it a word,
  add it to the matching concept in `UI_LEX_SRC` in `uiAgent.js`.

**Codex — the AI assistant, honestly implemented**
- A real, narrow, allowlisted action registry — 22 tools covering messaging
  (`send_message`), social graph control (`follow_user`/`unfollow_user`,
  `mute_user`/`unmute_user`, `block_user`/`unblock_user`, `restrict_user`/`unrestrict_user`),
  content creation (`create_post`, `create_reel`, `create_note`, `create_story`),
  content interaction on whatever's currently on screen (`share_content`, `like_content`,
  `save_content`, `delete_post`), navigation (`navigate`), calling (`start_call`), the app
  launcher (`open_app`), search (`search`), and games (`invite_to_game`, `join_game`) —
  every action is re-validated and executed by the backend, audit-logged to
  `codex_actions`, and the model is **never** given execution power, only the ability to
  pick one predefined tool
- **Current-screen context ("this Reel", "him")**: the frontend tracks real state — which
  Reel/Post is actually majority-visible in your viewport (via IntersectionObserver, not
  guessed), which profile you're viewing, which conversation is open — and sends it to
  Codex on every command. The model can only ever reference what's genuinely in that
  context; it cannot invent a Reel/Post ID that isn't actually on screen. Tested
  end-to-end: opening a reel, then telling Codex "share this with arjun" via a raw
  `confirmedAction` call with the real tracked context, correctly delivered a message
  request containing that exact reel's caption
- **Multi-step commands** ("follow him and send this reel"): the model can return several
  tool calls in one response; the backend executes them in order and honestly reports
  partial completion if a later step fails (verified: a 2-step chain where step one
  succeeds and step two fails returns *"Posted to your feed. User not found."* — never a
  blanket "Done")
- **Destructive-action confirmation**: `block_user` and `delete_post` always return a
  confirmation prompt first instead of executing — verified the full round-trip
  (confirmation prompt → user confirms → action actually executes → any queued follow-up
  steps continue afterward). Account deletion is deliberately **not** a Codex tool at
  all — it already requires password confirmation through Settings, a stronger safeguard
  than a chat prompt, and shouldn't be shortcut-able through conversation
- **With `ANTHROPIC_API_KEY` set**: Codex uses real Anthropic tool-calling to understand
  free-form, multilingual requests (including Tanglish-style code-switching) and maps
  them to the allowlist above
- **Without a key**: Codex is honest about it ("Basic pattern matching only…") and
  falls back to a deterministic regex command parser that still covers the core flows —
  including "send this to X" / "like this" / "save this" using the same real screen
  context, and a native browser confirm dialog before blocking anyone
- **Real voice I/O**: a mic button uses the browser's native SpeechRecognition API for
  input and SpeechSynthesis for spoken replies (English/Tamil/Hindi/Spanish/French
  selectable) — genuinely functional, no external service, works in Chrome/Edge

**Testing caveat, stated plainly**: this environment has no `ANTHROPIC_API_KEY` configured,
so the multi-step and context-resolution mechanics above were verified by calling
`/codex/act` directly with hand-constructed actions and context (bypassing the AI
resolution step) — proving the *execution engine* (confirmation, chaining, context
lookup, honest partial-failure) is correct. What I have **not** personally verified is
how reliably the real Claude model decomposes a natural sentence like "follow him and
send this reel" into that exact tool sequence — that depends on live model behavior with
a real key, which you'll want to sanity-check once you add yours.
- **Bio AI assist** (Write/Improve/Professional/Shorter/Translate) in Account Settings —
  real text generation via the same Anthropic integration when configured; an honest
  "needs an API key" message otherwise
- **Universal App Launcher**: resolves app names/aliases to real web URLs it opens in a
  new tab (Spotify, YouTube, WhatsApp Web, Google Maps, Discord, Telegram, Instagram,
  Amazon Music, lichess.org for Chess) — or an honest refusal for apps with no web
  equivalent (Free Fire, Minecraft, Camera, Gallery), since this is a web app and
  cannot launch native OS apps

### Built-in local AI (no API key)

NEXA no longer depends on the Anthropic API or any external AI service. Everything runs inside
the server process:

- **Codex understanding** — `backend/src/nlu.js` + `backend/src/uiAgent.js`: fuzzy, typo- and
  language-tolerant (Tanglish, Hinglish, etc.) intent parsing and on-screen control matching,
  with a looser local fuzzy pass when the strict matcher finds nothing. Every action is still
  validated server-side by the same allowlist, risk policy and confirmation steps.
- **Bio tools** (Write / Improve / Professional / Shorter / Translate) — `backend/src/localAI.js`:
  template + rewrite rules and a small built-in phrasebook for Translate.

Honest limits: this is a deterministic rule-based engine, not a neural language model. Free-form
bios are templated, and Translate is word-level for common bio vocabulary (unknown words are left
as typed). To extend it, add words to `nlu.js` / the phrasebook in `localAI.js`.

## What's still not implemented, and why

- **Google OAuth / SMS OTP / email delivery** — need real registered credentials with
  Google/an SMS/email provider that only you can obtain.
- **Native OS app launching** — structurally impossible from a web app.
- **A real CDN/transcode pipeline** — posts, stories and reels all take real file uploads
  now (local disk, served via `/uploads`). There is no transcoding or thumbnailing, so the
  browser plays back whatever container/codec it was given (an iPhone `.mov` may not play in
  every browser), video edits are playback-time settings rather than a re-encoded file, and
  there's no CDN in front of any of it.
- **4 of the 8 named games** (Carrom, Bike Race, Ludo, Snake-style). Chess is now playable
  (see below). `backend/src/gameEngines/ludo.js` exists but isn't registered: Ludo needs a
  dice-roll step and 2–4 players, which the current two-player move flow doesn't have.
  Carrom, Bike Race and Snake are real-time/physics games and would need a different
  server model than turn-based `init`/`applyMove`.
- **Group video calls** — current signaling is 1:1 only.
- **Production infra** — no real CDN, observability pipeline, or CI/CD.

## Running it locally

Requires Node.js 18+ (20/22 LTS recommended).

```bash
# 1. Backend
cd backend
npm install
npm run seed     # demo users: rahul, priya, arjun (password: password123)
npm start        # http://localhost:4000

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev      # http://localhost:5173, proxies /api and /socket.io to :4000
```

Log in as `rahul`, `priya`, or `arjun` (password `password123`), or sign up fresh.

Things worth trying:
- **Tournaments**: Game Store → Discover → "Start tournament" on Tic-Tac-Toe, join with
  a second account, start it, and play — standings update live.
- **Codex voice**: open the Codex panel, tap the mic icon, and say "follow priya" out loud.
- **Codex + AI**: set `ANTHROPIC_API_KEY` and try something the regex parser couldn't
  handle, like "hey can you tell rahul I'll be a bit late" — it should still correctly
  resolve to messaging @rahul.
- **Calls**: the call buttons in a chat header — two browser tabs on the same machine
  work great.

## Notes on the database

SQLite file at `backend/nexa.db`. Delete it and re-run `npm run seed` to reset. Schema
in `backend/src/schema.sql`.


## Profile Studio

The Profile page header is now the **Profile Studio** (`frontend/src/components/ProfileStudio.jsx`).

**Open it:** tap your own profile avatar / "Profile video" / "Customize", or tell Codex
*"open profile studio"*, *"change my profile video"*, *"edit profile photo"*, *"customize profile"*
(handled by both the local command parser and the NLU, screen `profile-studio`).

**What it does** (all saved on the server, so everyone viewing your profile sees it):
- Profile **photo or video**: upload your own (photo jpg/png/webp <8MB; video mp4/webm/mov, 40s max, <150MB)
  or pick one of the 19 preset clips (`frontend/public/studio/clip-N.mp4`). Presets are uploaded as your real profile video,
  so your avatar changes everywhere (posts, comments, messages, stories...).
- **Name and bio**: click the text on the card to edit; saved when you click away.
- **Theme, background** (colour, gradient, preset clip, or your own profile video), **dim** and **blur**:
  stored in `users.profile_studio` (JSON; column added automatically on boot) via `PATCH /api/users/me/studio`.

The older trim/cover-frame editor is still available under "Trim & cover tools".

## App colours (background, letters, boxes)

Settings -> Appearance lets each user pick a colour combination: a two-colour gradient background
(fixed behind the whole app), the letter colour, and the box/table colour. Eight ready-made
combinations plus custom pickers; a contrast check warns when letters are hard to read and can fix them
automatically. Saved per device (`localStorage: nexa.colors`); logic in `frontend/src/colors.js`.
All text is bold and boxes/tables have 2px borders (see the end of `styles.css`).

## Advanced app layer (v11 — CHEX branding)
- **Installable PWA**: manifest, icon, service worker (offline app shell; API, uploads and sockets are never cached), in-app *Install NEXA* prompt and offline banner. Active in production builds.
- **One-process production mode**: the backend serves `frontend/dist` with correct caching and SPA fallback. `npm run install:all && npm start` from the project root builds and runs everything on port 4000.
- **Hardening**: security headers, `trust proxy`, refuses to boot in production on the default JWT secrets, `/api/ready` DB-backed readiness check, graceful SIGTERM/SIGINT shutdown.
- **Docker**: `NEXA_ACCESS_SECRET=… NEXA_REFRESH_SECRET=… docker compose up --build` (SQLite and uploads should live on the `/data` volume; point `NEXA_DB_PATH` there, already set).
- Not done here: TURN server for calls, HTTPS termination (use a reverse proxy), and moving uploads off local disk.
- **v12 fixes**: on phones the desktop sidebar was never hidden (a later CSS rule overrode the mobile `display:none`), so it pushed the feed down; and the Codex button sat on top of the bottom nav. Both fixed, plus safe-area padding for notched phones.
- **CHEX branding**: app renamed to CHEX; your logo is the app icon (`frontend/public/icon-192.png`, `icon-512.png`, `logo.png`). A launch screen (falling binary, rotating coin, "chex" wordmark) shows before login (`components/Splash.jsx`), and every in-app loading spinner is now the spinning CHEX logo.
