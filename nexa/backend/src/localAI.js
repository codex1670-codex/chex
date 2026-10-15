// NEXA local AI — runs entirely inside the server process. No API key, no network calls, no
// third-party model. Two parts:
//   1. Codex understanding  -> nlu.js + uiAgent.js (fuzzy, multilingual rule engine, unchanged)
//   2. Bio writing tools    -> this file (template + rewrite rules + small phrasebook)
// It is deterministic and rule-based, not a neural network: it is honest about being small.

const pick = (arr, seed = Math.random()) => arr[Math.floor(seed * arr.length) % arr.length];

export function isConfigured() { return true; } // nothing to configure — always available

const clip = (s, n) => {
  s = s.trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—\s]+$/, '') + '…';
};

// ---------- write ----------
const OPENERS = ['Living life one story at a time', 'Good vibes only', 'Making moments count', 'Curious mind, open heart',
  'Collecting memories, not things', 'Here for the fun and the friends', 'Dreamer. Doer. Always learning', 'Keeping it real'];
const CLOSERS = ['Say hi 👋', "Let's connect ✨", 'Always up for a chat', 'Stay kind 💛', 'Coffee & good music ☕🎶'];

function write(seed) {
  return clip(`${pick(OPENERS, seed)} • ${pick(CLOSERS, (seed * 7.13) % 1)}`, 150);
}

// ---------- improve / professional / shorter ----------
const CASUAL_TO_PRO = [
  [/\bgonna\b/gi, 'going to'], [/\bwanna\b/gi, 'want to'], [/\bgotta\b/gi, 'have to'], [/\bluv\b/gi, 'love'],
  [/\bu\b/gi, 'you'], [/\bur\b/gi, 'your'], [/\bbtw\b/gi, ''], [/\blol\b/gi, ''], [/\bfr\b/gi, ''],
  [/\bawesome\b/gi, 'passionate'], [/\bcool stuff\b/gi, 'creative work'], [/\bstuff\b/gi, 'work'],
  [/\bchilling\b/gi, 'relaxing'], [/\bvibes?\b/gi, 'energy'], [/\bguy\b/gi, 'professional'],
  [/\bi'm\b/gi, 'I am'], [/\bi love\b/gi, 'I am passionate about'],
];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

function tidy(s) {
  s = s.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase());
  s = s.replace(/\bi\b/g, 'I');
  return s;
}

function improve(bio) {
  let s = tidy(bio.replace(/([!?.])\1{1,}/g, '$1'));
  if (!/[.!?…]$|[\u{1F300}-\u{1FAFF}]$/u.test(s)) s += '.';
  if (s.length < 40 && !EMOJI.test(s)) s += ' ✨';
  EMOJI.lastIndex = 0;
  return clip(s, 150);
}

function professional(bio) {
  let s = bio.replace(EMOJI, '');
  for (const [re, to] of CASUAL_TO_PRO) s = s.replace(re, to);
  s = tidy(s.replace(/[!]+/g, '.').replace(/\s*[|•·]\s*/g, '. '));
  if (!/[.!?]$/.test(s)) s += '.';
  return clip(s, 150);
}

function shorter(bio) {
  const parts = bio.split(/\s*(?:[.!?|•·\n]+|\s-\s)\s*/).map(p => p.trim()).filter(Boolean);
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} • ${p}` : p;
    if (next.length > 80) break;
    out = next;
  }
  return clip(out || bio, 80);
}

// ---------- translate (small offline phrasebook) ----------
const PHRASEBOOK = {
  spanish:  { hello: 'hola', hi: 'hola', love: 'amor', life: 'vida', music: 'música', travel: 'viajes', coffee: 'café', friends: 'amigos', food: 'comida', dreamer: 'soñador', always: 'siempre', learning: 'aprendiendo', good: 'buenas', vibes: 'vibras', only: 'solo', and: 'y', the: 'el', of: 'de', in: 'en', with: 'con', for: 'para', i: 'yo', am: 'soy', a: 'un', my: 'mi', here: 'aquí', fun: 'diversión', kind: 'amable', stay: 'mantente', photography: 'fotografía', gamer: 'jugador', student: 'estudiante', artist: 'artista', writer: 'escritor', say: 'di', moments: 'momentos', memories: 'recuerdos', story: 'historia', one: 'una', time: 'vez', at: 'a', real: 'real', keeping: 'manteniendo', it: 'lo', curious: 'curioso', mind: 'mente', open: 'abierto', heart: 'corazón', making: 'haciendo', count: 'cuentan', let: 'dejemos', connect: 'conectemos', chat: 'charlar', up: 'listo', to: 'para', things: 'cosas', not: 'no', collecting: 'coleccionando', living: 'viviendo', day: 'día', every: 'cada' },
  french:   { hello: 'bonjour', hi: 'salut', love: 'amour', life: 'vie', music: 'musique', travel: 'voyage', coffee: 'café', friends: 'amis', food: 'cuisine', dreamer: 'rêveur', always: 'toujours', learning: 'apprendre', good: 'bonnes', vibes: 'ondes', only: 'seulement', and: 'et', the: 'le', of: 'de', in: 'en', with: 'avec', for: 'pour', i: 'je', am: 'suis', a: 'un', my: 'mon', here: 'ici', fun: 'amusement', kind: 'gentil', stay: 'reste', photography: 'photographie', gamer: 'joueur', student: 'étudiant', artist: 'artiste', writer: 'écrivain', say: 'dis', moments: 'moments', memories: 'souvenirs', story: 'histoire', one: 'une', time: 'fois', at: 'à', real: 'vrai', keeping: 'rester', it: 'ça', curious: 'curieux', mind: 'esprit', open: 'ouvert', heart: 'cœur', making: 'créer', count: 'compter', let: 'laisse', connect: 'connecter', chat: 'discuter', things: 'choses', not: 'pas', collecting: 'collectionner', living: 'vivre', day: 'jour', every: 'chaque' },
  hindi:    { hello: 'नमस्ते', hi: 'नमस्ते', love: 'प्यार', life: 'ज़िंदगी', music: 'संगीत', travel: 'यात्रा', coffee: 'कॉफ़ी', friends: 'दोस्त', food: 'खाना', dreamer: 'सपने देखने वाला', always: 'हमेशा', learning: 'सीखना', good: 'अच्छी', vibes: 'वाइब्स', only: 'सिर्फ़', and: 'और', i: 'मैं', am: 'हूँ', my: 'मेरा', here: 'यहाँ', fun: 'मज़ा', kind: 'दयालु', stay: 'रहो', photography: 'फ़ोटोग्राफ़ी', gamer: 'गेमर', student: 'छात्र', artist: 'कलाकार', writer: 'लेखक', moments: 'पल', memories: 'यादें', story: 'कहानी', real: 'असली', curious: 'जिज्ञासु', heart: 'दिल', chat: 'बात', life: 'ज़िंदगी' },
  tamil:    { hello: 'வணக்கம்', hi: 'வணக்கம்', love: 'காதல்', life: 'வாழ்க்கை', music: 'இசை', travel: 'பயணம்', coffee: 'காபி', friends: 'நண்பர்கள்', food: 'உணவு', dreamer: 'கனவு காண்பவர்', always: 'எப்போதும்', learning: 'கற்றல்', good: 'நல்ல', vibes: 'உணர்வுகள்', only: 'மட்டும்', and: 'மற்றும்', i: 'நான்', am: 'இருக்கிறேன்', my: 'என்', here: 'இங்கே', fun: 'மகிழ்ச்சி', kind: 'அன்பு', stay: 'இரு', photography: 'புகைப்படம்', gamer: 'விளையாட்டாளர்', student: 'மாணவர்', artist: 'கலைஞர்', writer: 'எழுத்தாளர்', moments: 'தருணங்கள்', memories: 'நினைவுகள்', story: 'கதை', real: 'உண்மை', curious: 'ஆர்வம்', heart: 'இதயம்', chat: 'பேச்சு' },
  japanese: { hello: 'こんにちは', hi: 'やあ', love: '愛', life: '人生', music: '音楽', travel: '旅', coffee: 'コーヒー', friends: '友達', food: '食べ物', dreamer: '夢見る人', always: 'いつも', learning: '学び', good: '良い', vibes: 'バイブス', and: 'と', i: '私', my: '私の', here: 'ここ', fun: '楽しさ', kind: '優しさ', photography: '写真', gamer: 'ゲーマー', student: '学生', artist: 'アーティスト', writer: '作家', moments: '瞬間', memories: '思い出', story: '物語', real: '本物', heart: '心', chat: 'おしゃべり' },
  arabic:   { hello: 'مرحبا', hi: 'أهلا', love: 'حب', life: 'حياة', music: 'موسيقى', travel: 'سفر', coffee: 'قهوة', friends: 'أصدقاء', food: 'طعام', dreamer: 'حالم', always: 'دائما', learning: 'تعلم', good: 'جيدة', vibes: 'أجواء', only: 'فقط', and: 'و', i: 'أنا', my: 'لي', here: 'هنا', fun: 'متعة', kind: 'لطيف', photography: 'تصوير', gamer: 'لاعب', student: 'طالب', artist: 'فنان', writer: 'كاتب', moments: 'لحظات', memories: 'ذكريات', story: 'قصة', real: 'حقيقي', heart: 'قلب', chat: 'دردشة' },
};

function translate(bio, lang) {
  const book = PHRASEBOOK[String(lang || 'spanish').toLowerCase()] || PHRASEBOOK.spanish;
  const out = bio.replace(/[\p{L}']+/gu, (w) => {
    const t = book[w.toLowerCase().replace(/'/g, '')];
    return t ?? w;
  });
  return clip(out, 150);
}

export async function generateText({ action, bio = '', targetLanguage }) {
  try {
    const text = action === 'write' ? write(Math.random())
      : action === 'improve' ? improve(bio)
      : action === 'professional' ? professional(bio)
      : action === 'shorter' ? shorter(bio)
      : action === 'translate' ? translate(bio, targetLanguage)
      : null;
    if (!text) return { ok: false, reason: 'bad_action' };
    return { ok: true, text, local: true };
  } catch (err) {
    return { ok: false, reason: 'local_error', message: err.message };
  }
}
