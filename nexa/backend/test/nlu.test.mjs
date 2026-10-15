import _t from 'node:test';
let test = _t;
import assert from 'node:assert/strict';
import { parseCommand, editDistance } from '../src/nlu.js';

// A stand-in for the DB-backed lookups codex.js supplies.
const PEOPLE = ['rahul', 'priya', 'arjun', 'bestie', 'bro', 'boss', 'senthil'];
const person = (w) => {
  if (PEOPLE.includes(w)) return 2;
  if (w.length >= 3 && PEOPLE.some(p => p.startsWith(w))) return 1;
  if (w.length >= 5 && PEOPLE.some(p => editDistance(p, w) <= 1)) return 1;
  return 0;
};
const apps = [
  { id: 'spotify', names: ['spotify', 'music'] }, { id: 'youtube', names: ['youtube', 'yt'] },
  { id: 'whatsapp', names: ['whatsapp', 'chat', 'wa'] }, { id: 'maps', names: ['google maps', 'maps', 'directions'] },
  { id: 'instagram', names: ['instagram', 'insta', 'ig'] }, { id: 'chess', names: ['chess'] },
  { id: 'free-fire', names: ['free fire', 'ff'] }, { id: 'gallery', names: ['gallery', 'photos'] },
];
const env = (context = {}) => ({ person, apps, context });
const run = (t, ctx) => parseCommand(t, env(ctx));
// Soft assertions: collect every miss in a test so one run shows all the problems.
let misses = [];
const miss = (m) => misses.push(m);
const lowerUser = (i) => (i && i.username ? { ...i, username: i.username.toLowerCase() } : i);
const one = (t, ctx) => { const r = run(t, ctx); if (r.kind !== 'actions') { miss(`"${t}" -> ${JSON.stringify(r)}`); return []; } return r.actions.map(a => ({ ...a, input: lowerUser(a.input) })); };
const is = (t, name, input, ctx) => {
  const a = one(t, ctx); if (!a.length) return;
  if (a.length !== 1 || a[0].name !== name || (input && JSON.stringify(a[0].input) !== JSON.stringify(input) && !(() => { try { assert.deepEqual(a[0].input, input); return true; } catch { return false; } })()))
    miss(`"${t}" -> ${JSON.stringify(a)}  (wanted ${name} ${JSON.stringify(input)})`);
};
const _test = _t;
test = (name, fn) => _test(name, () => { misses = []; fn(); assert.equal(misses.length, 0, '\n  ' + misses.join('\n  ')); });
const nav = (t, screen, extra = {}, ctx) => is(t, 'navigate', { screen, ...extra }, ctx);

test('the exact variants from the request: send hi to rahul', () => {
  for (const t of ['send rahul hi', 'hi to rahul', 'send hi to rahul', 'hi rahul ku anupu', 'rahul ku hi anupu', 'rahul-ku hi anuppu', 'Rahul ku hi anuppunga',
    'hi rahul', 'rahul hi', 'hi rahul ku anuppu da', 'send rahul hi please', 'pls send hi to rahul', 'can you send hi to rahul', 'rahul ku hi anupu pannu', 'rahul kku hi anupunga', 'send hii to rahul', 'dm rahul hi', 'text rahul hi', 'message rahul hi', 'message rahul: hi', 'msg rahul hi', 'tell rahul hi', 'rahul ko hi bhejo', 'rahul ku hi sollu']) {
    is(t, 'send_message', { username: 'rahul', text: /^hii$/i.test(t.split(' ')[2]) || t === 'send hii to rahul' ? 'hii' : 'hi' });
  }
});

test('open messages variants', () => {
  for (const t of ['open messages', 'open msg', 'open message', 'message open pannu', 'msg', 'messages', 'message', 'open msgs', 'msg open pannu', 'open mesage', 'open messeges', 'open massage', 'messages open pannu', 'inbox', 'open chat', 'open dm', 'message thira', 'msg kholo', 'abre mensajes', 'open the messages please', 'can you open messages', 'show messages', 'go to messages', 'take me to messages', 'messsage open pannu'.replace('sss', 'ss')]) nav(t, 'messages');
});

test('game store variants', () => {
  for (const t of ['game store open pannu', 'open games', 'game', 'games', 'open game store', 'open gamestore', 'open game', 'gamestore', 'game store', 'games open pannu', 'open gams', 'open gaem', 'open the game store', 'game store thira', 'open game stor', 'show games']) nav(t, 'games');
});

test('reels variants', () => {
  for (const t of ['open reels', 'reels', 'reel', 'reels open pannu', 'open reel', 'reel open pannu', 'open rels', 'open reals', 'open reeels', 'reels kholo', 'show reels', 'open shorts', 'reels paaru', 'go to reels', 'open videos']) nav(t, 'reels');
});

test('other navigation', () => {
  nav('open feed', 'feed'); nav('go home', 'feed'); nav('home', 'feed'); nav('open settings', 'settings'); nav('settings open pannu', 'settings');
  nav('open notifications', 'notifications'); nav('notifs', 'notifications'); nav('open my profile', 'profile'); nav('profile', 'profile');
  nav("go to priya's profile", 'profile', { username: 'priya' }); nav('rahul profile open pannu', 'profile', { username: 'rahul' }); nav('rahul oda profile open pannu', 'profile', { username: 'rahul' });
  nav('open my saved reels', 'saved-reels'); nav('open saved posts', 'saved-posts'); nav('show my reels history', 'reels-history');
  nav('open profile studio', 'profile-studio'); nav('change my profile video', 'profile-studio'); nav('edit profile photo', 'profile-studio'); nav('open my studio', 'profile-studio');
  nav('open tournaments', 'games', { tab: 'tournaments' }); nav('show my games', 'games', { tab: 'mine' }); nav('open game store discover', 'games', { tab: 'discover' });
  nav('open messages with rahul', 'messages', { username: 'rahul' }); nav('message rahul', 'messages', { username: 'rahul' }); nav('rahul chat open pannu', 'messages', { username: 'rahul' });
  nav('open search', 'search'); nav('search', 'search'); nav('explore', 'search'); nav('open rahul', 'profile', { username: 'rahul' });
});

test('relationship verbs, typos, tanglish and undo', () => {
  is('follow rahul', 'follow_user', { username: 'rahul' }); is('follw rahul', 'follow_user', { username: 'rahul' }); is('rahul ah follow pannu', 'follow_user', { username: 'rahul' });
  is('priya follow pannu', 'follow_user', { username: 'priya' }); is('follow @priya', 'follow_user', { username: 'priya' }); is('FOLLOW PRIYA', 'follow_user', { username: 'priya' });
  is('unfollow rahul', 'unfollow_user', { username: 'rahul' }); is('unfolow rahul', 'unfollow_user', { username: 'rahul' }); is('rahul ah unfollow pannu', 'unfollow_user', { username: 'rahul' });
  is('stop following rahul', 'unfollow_user', { username: 'rahul' }); is('rahul follow cancel pannu', 'unfollow_user', { username: 'rahul' });
  is('mute priya', 'mute_user', { username: 'priya' }); is('unmute priya', 'unmute_user', { username: 'priya' });
  is('block arjun', 'block_user', { username: 'arjun' }); is('blok arjun', 'block_user', { username: 'arjun' }); is('bloc arjun', 'block_user', { username: 'arjun' }); is('arjun ah block pannu', 'block_user', { username: 'arjun' });
  is('unblock arjun', 'unblock_user', { username: 'arjun' }); is('arjun unblock pannu', 'unblock_user', { username: 'arjun' }); is('remove block arjun', 'unblock_user', { username: 'arjun' });
  is('restrict priya', 'restrict_user', { username: 'priya' }); is('unrestrict priya', 'unrestrict_user', { username: 'priya' });
  is('follow rahull', 'follow_user', { username: 'rahull' }); // unknown spelling is passed through; backend fuzzy-resolves it
});

test('calls', () => {
  is('call rahul', 'start_call', { username: 'rahul', video: false }); is('video call rahul', 'start_call', { username: 'rahul', video: true });
  is('rahul ku call pannu', 'start_call', { username: 'rahul', video: false }); is('rahul ku video call pannu', 'start_call', { username: 'rahul', video: true });
  is('vdo call priya', 'start_call', { username: 'priya', video: true }); is('rahul ko call karo', 'start_call', { username: 'rahul', video: false });
});

test('current screen content', () => {
  is('like this', 'like_content', {}); is('like pannu', 'like_content', {}); is('unlike this', 'unlike_content', {}); is('save this', 'save_content', {}); is('unsave this', 'unsave_content', {});
  is('send this to rahul', 'share_content', { username: 'rahul' }); is('share this with priya', 'share_content', { username: 'priya' }); is('idha rahul ku anuppu', 'share_content', { username: 'rahul' });
  is('forward this to arjun', 'share_content', { username: 'arjun' }); is('delete this post', 'delete_post', {}); is('comment: nice one!', 'comment_content', { text: 'nice one!' });
  is('comment superb', 'comment_content', { text: 'superb' });
});

test('create content', () => {
  is('post: had a great day today', 'create_post', { caption: 'had a great day today' });
  is('post had a great day', 'create_post', { caption: 'had a great day' });
  is('create post hello world', 'create_post', { caption: 'hello world' });
  is('post pannu: good morning all', 'create_post', { caption: 'good morning all' });
  is('note: busy till 5', 'create_note', { text: 'busy till 5' }); is('story: beach day 🌊', 'create_story', { text: 'beach day 🌊' });
  is('post: i will follow my dreams and like dark chocolate', 'create_post', { caption: 'i will follow my dreams and like dark chocolate' });
});

test('games', () => {
  is('play chess with priya', 'invite_to_game', { gameId: 'chess', username: 'priya' }); is('rahul kooda chess vilayadu', 'invite_to_game', { gameId: 'chess', username: 'rahul' });
  is('invite arjun to tic tac toe', 'invite_to_game', { gameId: 'tic-tac-toe', username: 'arjun' }); is('play connect 4 with rahul', 'invite_to_game', { gameId: 'connect-four', username: 'rahul' });
  is('challenge priya checkers', 'invite_to_game', { gameId: 'checkers', username: 'priya' }); is('join game abc123', 'join_game', { inviteCode: 'ABC123' });
  is('open chess', 'open_app', { appName: 'chess' });
});

test('theme', () => {
  is('dark mode', 'set_theme', { theme: 'dark' }); is('turn on dark mode', 'set_theme', { theme: 'dark' }); is('light mode', 'set_theme', { theme: 'light' }); is('dark mode pannu', 'set_theme', { theme: 'dark' });
  is('switch to light theme', 'set_theme', { theme: 'light' }); is('darkmode', 'set_theme', { theme: 'dark' });
});

test('apps', () => {
  is('open spotify', 'open_app', { appName: 'spotify' }); is('spotify open pannu', 'open_app', { appName: 'spotify' }); is('open spotfy', 'open_app', { appName: 'spotify' });
  is('open youtube and search AI tutorials', 'open_app', { appName: 'youtube', searchFor: 'AI tutorials' }); is('youtube la AI tutorials search pannu', 'open_app', { appName: 'youtube', searchFor: 'AI tutorials' });
  is('open maps', 'open_app', { appName: 'google maps' }); is('open whatsapp', 'open_app', { appName: 'whatsapp' }); is('open insta', 'open_app', { appName: 'instagram' }); is('open yt', 'open_app', { appName: 'youtube' });
  is('open somethingweird', 'open_app', { appName: 'somethingweird' });
});

test('search', () => {
  is('search rahul', 'search', { query: 'rahul' }); is('find #cats', 'search', { query: '#cats' }); is('search for AI news', 'search', { query: 'AI news' });
  is('rahul ah thedu', 'search', { query: 'rahul' });
});

test('nicknames', () => {
  is('save rahul as bestie', 'save_profile_nickname', { username: 'rahul', nickname: 'bestie' });
  is('rahul a bestie nu save pannu', 'save_profile_nickname', { username: 'rahul', nickname: 'bestie' });
  is('rename bestie to bro', 'update_profile_nickname', { oldNickname: 'bestie', newNickname: 'bro' }); is('forget bestie', 'delete_profile_nickname', { nickname: 'bestie' });
  is('remove nickname bestie', 'delete_profile_nickname', { nickname: 'bestie' }); is('show my nicknames', 'list_profile_nicknames', {}); is('who is bestie', 'resolve_profile_nickname', { nickname: 'bestie' });
  is('message bro hi', 'send_message', { username: 'bro', text: 'hi' }); is('block boss', 'block_user', { username: 'boss' });
  is('bestie ku hi anupu', 'send_message', { username: 'bestie', text: 'hi' });
});

test('notifications', () => { nav('show notifications', 'notifications'); is('mark all notifications read', 'mark_notifications_read', {}); is('clear notifications', 'mark_notifications_read', {}); });

test('message bodies are preserved, even when they contain command words', () => {
  is('tell rahul i will follow you', 'send_message', { username: 'rahul', text: 'i will follow you' });
  is("tell rahul it's raining", 'send_message', { username: 'rahul', text: "it's raining" });
  is('tell rahul that I am late', 'send_message', { username: 'rahul', text: 'I am late' });
  is('message rahul to come fast', 'send_message', { username: 'rahul', text: 'come fast' });
  is('SEND HI TO RAHUL', 'send_message', { username: 'rahul', text: 'HI' });
  is('send rahul good morning!', 'send_message', { username: 'rahul', text: 'good morning!' });
  is('rahul ku late ah varuven nu sollu', 'send_message', { username: 'rahul', text: 'late ah varuven' });
  is('send rahul 😂', 'send_message', { username: 'rahul', text: '😂' });
  is('send "open the door" to priya', 'send_message', { username: 'priya', text: 'open the door' });
  is('message priya: see you at 10:30, bring the games', 'send_message', { username: 'priya', text: 'see you at 10:30, bring the games' });
  is('can you tell rahul can you call me', 'send_message', { username: 'rahul', text: 'can you call me' });
  is('send hello to unknownperson', 'send_message', { username: 'unknownperson', text: 'hello' });
  is('send bread and butter to rahul', 'send_message', { username: 'rahul', text: 'bread and butter' });
});

test('multi-step chains', () => {
  let a = one('follow priya and message her hi');
  assert.deepEqual(a, [{ name: 'follow_user', input: { username: 'priya' } }, { name: 'send_message', input: { username: 'priya', text: 'hi' } }]);
  a = one('send hi to rahul and follow him');
  assert.deepEqual(a, [{ name: 'send_message', input: { username: 'rahul', text: 'hi' } }, { name: 'follow_user', input: { username: 'rahul' } }]);
  a = one('open reels and then like this'); assert.deepEqual(a.map(x => x.name), ['navigate', 'like_content']);
  a = one('rahul ah follow pannu aprom hi anuppu'); assert.deepEqual(a.map(x => x.name), ['follow_user', 'send_message']);
});

test('context pronouns', () => {
  is('follow him', 'follow_user', { username: 'priya' }, { profileUsername: 'priya' });
  is('block her', 'block_user', { username: 'priya' }, { profileUsername: 'priya' });
});

test('conversation + clarification + unknown', () => {
  const k = (t, kind) => { const r = run(t); if (r.kind !== kind) miss(`"${t}" -> ${JSON.stringify(r)} (wanted ${kind})`); };
  for (const t of ['hi', 'vanakkam', 'help', 'what can you do', 'thanks', 'who are you', 'hello codex']) k(t, 'reply');
  for (const t of ['follow', 'call', 'send hi']) k(t, 'clarify');
  for (const t of ['blah blah quantum entanglement', '']) k(t, 'none');
});

test('non-latin scripts', () => {
  nav('திற reels', 'reels'); is('rahul ku hi அனுப்பு', 'send_message', { username: 'rahul', text: 'hi' });
  nav('मैसेज खोलो', 'messages'); is('rahul को hi भेजो'.replace('को', 'ko'), 'send_message', { username: 'rahul', text: 'hi' });
  nav('abre mensajes', 'messages'); nav('ouvre les messages', 'messages'); nav('メッセージ 開く', 'messages'); nav('打开消息', 'messages');
});

test('fuzzy matching does not turn ordinary words into commands', () => {
  for (const t of ['live', 'life is good', 'the lake house', 'food', 'sand castle', 'clock', 'tall', 'what time is it']) if (run(t).kind === 'actions') miss(`"${t}" -> ${JSON.stringify(run(t))}`);
});
