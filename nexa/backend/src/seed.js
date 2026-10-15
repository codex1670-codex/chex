import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from './db.js';

const users = [
  { username: 'rahul', email: 'rahul@example.com', displayName: 'Rahul' },
  { username: 'priya', email: 'priya@example.com', displayName: 'Priya' },
  { username: 'arjun', email: 'arjun@example.com', displayName: 'Arjun' },
];

const passwordHash = bcrypt.hashSync('password123', 10);
const ids = {};

for (const u of users) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
  if (existing) { ids[u.username] = existing.id; continue; }
  const id = uuid();
  ids[u.username] = id;
  db.prepare('INSERT INTO users (id, username, email, password_hash, display_name, bio) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, u.username, u.email, passwordHash, u.displayName, `Hey, I'm ${u.displayName} 👋`);
  console.log(`Created @${u.username} (password: password123)`);
}

// a couple of posts + a follow relationship so the demo isn't empty
const postCount = db.prepare('SELECT COUNT(*) c FROM posts').get().c;
if (postCount === 0) {
  db.prepare('INSERT INTO posts (id, user_id, caption) VALUES (?, ?, ?)').run(uuid(), ids.rahul, 'First post on NEXA 🚀');
  db.prepare('INSERT INTO posts (id, user_id, caption) VALUES (?, ?, ?)').run(uuid(), ids.priya, 'Cosmic purple theme looks amazing tonight ✨');
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)').run(ids.priya, ids.rahul);
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)').run(ids.arjun, ids.rahul);
  console.log('Seeded demo posts and follow relationships.');
}

const ticTacToe = db.prepare('SELECT id FROM games WHERE id = ?').get('tic-tac-toe');
if (!ticTacToe) {
  db.prepare('INSERT INTO games (id, name, category, min_players, max_players) VALUES (?, ?, ?, ?, ?)')
    .run('tic-tac-toe', 'Tic-Tac-Toe', 'Board', 2, 2);
  console.log('Seeded game catalog: Tic-Tac-Toe');
}
const connectFour = db.prepare('SELECT id FROM games WHERE id = ?').get('connect-four');
if (!connectFour) {
  db.prepare('INSERT INTO games (id, name, category, min_players, max_players) VALUES (?, ?, ?, ?, ?)')
    .run('connect-four', 'Connect Four', 'Board', 2, 2);
  console.log('Seeded game catalog: Connect Four');
}

const checkers = db.prepare('SELECT id FROM games WHERE id = ?').get('checkers');
if (!checkers) {
  db.prepare('INSERT INTO games (id, name, category, min_players, max_players) VALUES (?, ?, ?, ?, ?)')
    .run('checkers', 'Checkers', 'Board', 2, 2);
  console.log('Seeded game catalog: Checkers');
}

const chess = db.prepare('SELECT id FROM games WHERE id = ?').get('chess');
if (!chess) {
  db.prepare('INSERT INTO games (id, name, category, min_players, max_players) VALUES (?, ?, ?, ?, ?)')
    .run('chess', 'Chess', 'Board', 2, 2);
  console.log('Seeded game catalog: Chess');
}

// App registry for Codex's Universal App Launcher — real web entry points only.
// native_only = 1 means there's no meaningful web equivalent to open from a browser.
const APPS = [
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com', search: 'https://open.spotify.com/search/{q}', native: 0, aliases: ['music', 'spotify'] },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com', search: 'https://www.youtube.com/results?search_query={q}', native: 0, aliases: ['youtube', 'yt'] },
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', search: null, native: 0, aliases: ['whatsapp', 'chat', 'wa'] },
  { id: 'maps', name: 'Google Maps', url: 'https://maps.google.com', search: 'https://www.google.com/maps/search/{q}', native: 0, aliases: ['maps', 'directions'] },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', search: null, native: 0, aliases: ['discord'] },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org', search: null, native: 0, aliases: ['telegram', 'tg'] },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com', search: null, native: 0, aliases: ['instagram', 'insta', 'ig'] },
  { id: 'amazon-music', name: 'Amazon Music', url: 'https://music.amazon.com', search: null, native: 0, aliases: ['amazon music'] },
  { id: 'chess', name: 'Chess', url: 'https://lichess.org', search: null, native: 0, aliases: ['chess'] },
  { id: 'free-fire', name: 'Free Fire', url: null, search: null, native: 1, aliases: ['free fire', 'ff'] },
  { id: 'minecraft', name: 'Minecraft', url: null, search: null, native: 1, aliases: ['minecraft', 'mc'] },
  { id: 'camera', name: 'Camera', url: null, search: null, native: 1, aliases: ['camera'] },
  { id: 'gallery', name: 'Gallery', url: null, search: null, native: 1, aliases: ['gallery', 'photos'] },
];
for (const a of APPS) {
  const existing = db.prepare('SELECT id FROM app_registry WHERE id = ?').get(a.id);
  if (!existing) {
    db.prepare('INSERT INTO app_registry (id, display_name, launch_url_web, search_url_template, native_only) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.url, a.search, a.native);
    for (const alias of a.aliases) {
      db.prepare('INSERT OR IGNORE INTO app_aliases (app_id, alias) VALUES (?, ?)').run(a.id, alias);
    }
  }
}
console.log('Seeded app registry for Universal App Launcher.');

console.log('Seed complete. Demo accounts: rahul / priya / arjun, password: password123');
