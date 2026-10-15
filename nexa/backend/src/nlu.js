// Codex NLU — a deterministic, offline, multilingual intent engine.
//
// What it is: a lexicon + fuzzy-matching + word-order-independent argument extractor that
// turns messy text ("rahul ku hi anupu", "msg open pannu", "hi to rahul", "reel", "bloc priya")
// into the SAME { name, input } tool calls the LLM path produces. It needs no API key and
// no network, so Codex understands the core commands even when the AI service is off,
// rate-limited or unreachable.
//
// What it is NOT: a language model. It only knows the words in LEX below (English, Tanglish,
// Hinglish, Telugu/Kannada/Malayalam/Bengali romanisations, plus common native-script,
// Spanish, French, German, Portuguese, Arabic, Japanese, Chinese, Korean and Russian verbs).
// Anything outside that vocabulary returns { kind: 'none' } so the caller can hand it to the
// real LLM. To teach it a new word, add it to the right concept in LEX — nothing else.
//
// It never executes anything. It returns tool calls; codex.js validates and runs them.

// ───────────────────────────── text helpers ─────────────────────────────

export function canon(s) {
  let t = String(s ?? '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  if (/^[\p{Script=Latin}\p{N}']+$/u.test(t)) t = t.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  return t;
}

// Damerau–Levenshtein (optimal string alignment) distance.
export function editDistance(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[al][bl];
}

// Vowel-agnostic consonant skeleton for romanised words: "anupu"/"anuppu" -> "anp",
// "messge"/"massage"/"msg" -> "msg". Only used for words >= 5 chars (see fuzzyConcepts).
export function skeleton(w) {
  return w
    .replace(/ph/g, 'f').replace(/ck|q/g, 'k').replace(/w/g, 'v').replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1')
    .replace(/(?!^)[aeiouy]+/g, '');
}

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]/u;

// ───────────────────────────── lexicon ─────────────────────────────
// concept -> space-separated words. A word may belong to several concepts (e.g. "message"
// is both a verb and a screen name); the intent rules below decide which reading wins.

const LEX_SRC = {
  SEND: `send sent sending snd tell say inform text dm dms forward
    anuppu anupu anuppunga anupunga anupi anuppi anupidu anuppidu anupungal anuppungal anupitu anuppitu
    sollu solu sollunga sollidu solliru sollidu pampu pampinchu pampandi pampey cheppu cheppandi
    bhejo bhej bhejna bhejiye bhejdo bhejde bata batao bol bolo kaho kahdo
    kalisu kalusu hellu ayakku ayaku ayakkuka parayu parayuka pathao pathan bolo bolun
    enviar envia envía mandar manda dile dime envoyer envoie dis dire senden sende schick schicke schicken sag sage
    invia inviare mandare gönder gonder kirim kirimkan katakan
    அனுப்பு அனுப்புங்க அனுப்புங்கள் சொல்லு சொல்லுங்க
    भेजो भेज भेजना बोलो कहो बताओ बता
    పంపు చెప్పు ಕಳುಹಿಸು ಹೇಳು അയക്കുക പറയുക পাঠাও বলো
    أرسل ارسل قل 送る 送信 发送 發送 告诉 告訴 보내 보내줘 말해 отправь отправить скажи`,
  MSG: `message messages msg msgs mesage messege massage mssg msj mensaje mensajes sms chat chats inbox convo conversation dm dms
    sandesh sandesham seithi kuruntagaval maseji
    मैसेज संदेश மெசேஜ் செய்தி మెసేజ్ ಮೆಸೇಜ್ മെസേജ് মেসেজ رسالة رسائل メッセージ 消息 信息 메시지 сообщение сообщения nachricht nachrichten`,
  OPEN: `open opn opne opened go goto show view see visit launch navigate display take bring
    thira thirakku thirakka thirakkavum thirandhu thirangaa kholo khol kholiye kholna khulo dikhao dikha dikhana dekho dekh dekhao
    chalo jao jaa po poi ponga poga pongo kaattu kaatu kaattunga kaamichu kaamikku kaanikku paaru paar paarunga paakanum venum venumnu
    teravandi tera teruvu chupinchu choodu chudu chudandi tereyiri tere torisu nodu thurakkuka thurakku
    abrir abre abra ir ve muestra muestrame ouvrir ouvre aller va montre montrer öffne öffnen zeig zeige zeigen
    apri aprire mostra buka bukak tunjukkan aç ac göster goster
    افتح اذهب اعرض 開く 開いて 打开 打開 열어 열기 открой открыть покажи
    திற திறக்க திறங்க காட்டு திறக்கவும் खोलो खोल दिखाओ తెరువు తెరవండి ತೆರೆ ತೋರಿಸು തുറക്കുക খোলো দেখাও`,
  LIGHT: `pannu panu pannunga pannungal pannuga pannunka pannidu pannuda pannitu panni seyyu seiyu seithu seiyungal seyyungal
    karo kar kijiye kijie karna karein kardo kardijiye cheyyi cheyyandi chei cheyyu cheyyuka maadi maadu madi koro korun
    hacer haz faire fais machen mach fare yap lakukan 해줘 해 して 做 请 請 пожалуйста`,
  FOLLOW: `follow follw fllw folow following followed seguir sigue suivre suis folgen ফলো फॉलो ஃபாலோ ఫాలో ಫಾಲೋ ഫോളോ فولو フォロー 关注 關注 팔로우 подписаться`,
  MUTE: `mute muted silence mutear silenciar muet stumm म्यूट மியூட் మ్యూట్ ミュート 静音 음소거 заглушить`,
  BLOCK: `block blk blck blok blocked ban bloquear bloque bloquer blockieren bloccare thadai thadu band ब्लॉक ப்ளாக் தடை బ్లాక్ ಬ್ಲಾಕ್ ബ്ലോക്ക് ব্লক حظر ブロック 屏蔽 拉黑 차단 блок заблокировать`,
  RESTRICT: `restrict restricted restrct limit restringir restreindre einschränken प्रतिबंधित கட்டுப்படுத்து 限制 제한`,
  LIKE: `like liked lyk love heart dislike unlike pidichiruku pidichi pasand pasandh ishtam ishta megusta aimer mögen gefällt लाइक லைக் లైక్ ಲೈಕ್ ലൈക്ക് লাইক اعجاب いいね 点赞 좋아요 лайк`,
  SAVE: `save bookmark sevu savu guardar guarda sauvegarder speichern सेव सहेजो சேவ் சேமி సేవ్ ಸೇವ್ സേവ് سيف 保存 저장 сохранить`,
  SAVED: `saved bookmarks bookmarked`,
  SHARE: `share sharing fwd partager compartir teilen condividere bagikan paylas शेयर ஷேர் பகிர் షేర్ ಶೇರ್ ഷെയർ شارك 共有 分享 공유 поделиться`,
  COMMENT: `comment cmnt cmt commentu comentar comentario commenter kommentieren कमेंट கமெண்ட் కామెంట్ ಕಾಮೆಂಟ್ കമന്റ് 评论 댓글 комментарий`,
  POST: `post posts publish pathivu padivu pottu publicar publier veröffentlichen पोस्ट பதிவு పోస్ట్ ಪೋಸ್ಟ್ പോസ്റ്റ് পোস্ট 投稿 发帖 게시 пост`,
  NOTE: `note notes kurippu குறிப்பு नोट नोट्स నోట్ ನೋಟ್ നോട്ട് নোট nota notas メモ 笔记 заметка`,
  STORY: `story stories status kathai historia histoire スト 스토리 история ஸ்டோரி स्टोरी`,
  CREATE: `create add new make write compose upload podu podunga poduga podungal pottu crear añade agrega créer ajouter erstellen`,
  REEL: `reel reels reeel rells ril rils reals shorts short reelz rell ரீல்ஸ் ரீல் रील रील्स రీల్స్ ರೀಲ್ಸ್ റീൽസ് রিলস リール 릴스 рилс`,
  VIDEO: `video videos vid vids vdo vedio vidio वीडियो வீடியோ వీడియో ವೀಡಿಯೊ വീഡിയോ ভিডিও فيديو ビデオ 视频 動画 비디오 видео`,
  GAME: `game games gamestore gaming gamez khel vilayattu vilaiyattu juego juegos jeu jeux spiel spiele gioco giochi oyun permainan
    गेम गेम्स கேம் கேம்ஸ் గేమ్ ಗೇಮ್ ഗെയിം গেম لعبة ゲーム 游戏 遊戲 게임 игра игры`,
  PLAY: `play playing plays vilayadu vilayaadu vilaiyadu vilayadalam vilayada vilaiyaadu vilaiyaadalam khelo khelte khelna khel aadu aadudam jugar juega jouer spielen gioca oyna
    விளையாடு விளையாடலாம் खेलो खेल ఆడు ಆಡು കളിക്കുക খেলো العب 遊ぶ 玩 놀자 играть`,
  GAMEKEY_TTT: `tictactoe ttt noughts xo xox`,
  GAMEKEY_C4: `connectfour c4 connect4`,
  GAMEKEY_CHECKERS: `checkers draughts checker`,
  GAMEKEY_CHESS: `chess satranj shatranj ajedrez echecs échecs schach scacchi catur チェス 国际象棋 체스 шахматы சதுரங்கம் शतरंज`,
  JOIN: `join joinu sernthu serungal shamil unirse únete rejoindre beitreten`,
  INVITE: `invite challenge dare invitar inviter einladen undang`,
  PROFILE: `profile prof profil perfil account பிரொபைல் प्रोफाइल ప్రొఫైల్ ಪ್ರೊಫೈಲ್ പ്രൊഫൈൽ প্রোফাইল ملف プロフィール 个人资料 프로필 профиль`,
  NOTIF: `notification notifications notifs notif alerts alert notificacion notificaciones notifs benachrichtigungen सूचना அறிவிப்பு అలర్ట్ ಅಧಿಸೂಚನೆ 通知 알림 уведомления إشعارات`,
  FEED: `feed home homepage timeline wall inicio accueil startseite होम ஹோம் హోమ్ ホーム 首页 홈 главная`,
  SEARCH: `search find lookup explore dhundo dhoondo khojo khoj thedu theadu thedunga tedu veduku buscar busca chercher cherche suchen cerca cari
    தேடு ढूंढो खोज వెతుకు ಹುಡುಕು തിരയുക খুঁজো ابحث 検索 搜索 搜尋 검색 поиск найди`,
  SETTINGS: `settings setting preferences prefs config configuration ajustes configuracion réglages einstellungen सेटिंग्स அமைப்புகள் సెట్టింగ్స్ ಸೆಟ್ಟಿಂಗ್ಸ್ 设置 設定 설정 настройки إعدادات`,
  HISTORY: `history historial historique verlauf इतिहास வரலாறு`,
  CALL: `call calls calling phone ring dial voicecall videocall vc facetime koopidu koopidunga kupidu koopudu phoneu bulao bulaao bulana phonekaro
    llamar llama appeler appelle anrufen chiama telefon कॉल கால் కాల్ ಕರೆ വിളിക്കുക اتصل 電話 电话 打电话 전화 позвони`,
  VOICE: `voice audio`,
  THEME_DARK: `dark darkmode night nightmode black இருட்டு अंधेरा oscuro sombre dunkel`,
  THEME_LIGHT: `light lightmode day daymode white bright claro clair hell வெளிச்சம் उजाला`,
  THEME: `theme mode appearance`,
  DELETE: `delete del remove erase forget alikku azhi azhichidu azhithidu mitao hatao borrar elimina supprimer löschen dele
    நீக்கு அழி हटाओ हटा डिलीट 删除 刪除 삭제 удали إحذف حذف`,
  NICK: `nickname nicknames nick alias selaperu செல்லப்பெயர்`,
  RENAME: `rename change maathu maatru badlo badal mathu cambiar changer ändern`,
  WHOIS: `whois yaar yaaru yaarunu kaun evaru yar quien quién qui wer`,
  AS: `as aaga`,
  READ: `read seen clear mark dismiss`,
  HELP: `help commands command udhavi madad ayuda aide hilfe`,
  THANKS: `thanks thx ty nandri nanri shukriya dhanyavad gracias merci danke grazie obrigado thankyou`,
  GREET: `hi hii hiii hey heyy hello helo hlo hola bonjour hallo ciao namaste namaskar vanakkam vanakam salaam salam yo sup
    வணக்கம் नमस्ते నమస్తే ನಮಸ್ಕಾರ നമസ്കാരം নমস্কার مرحبا こんにちは 你好 안녕 привет`,
  REF: `this that it idhu ithu idha idhai itha intha indha ithai ye yeh yah isko ise ee idi ida esto este ça ce diese dies
    இது இதை இந்த यह यही इसे इसको ఇది ಇದು ഇത് これ 这个 這個 이거 это هذا`,
  HIM: `him her them he she avan avanai avanukku avana aval avalai avalukku avala avar avarai avarukku avanga avangala
    usko use unhe unko woh uski atanu ataniki aame avanige avalige él ella lui elle ihn ihr
    அவன் அவள் அவரை उसे उसको 彼 彼女 그 그녀 его её ему ей هو هي`,
  ME: `me my mine myself en enoda ennoda enakku naan mera meri mere mujhe naa nenu nanna enikku ente mi mon`,
  YOU: `you u ur your nee nenga neenga tum aap tu tu vos usted toi du sie`,
  // Case markers / postpositions. DATM/ACCM follow the person ("rahul ku"), PREPM precede
  // it ("to rahul"), QUOTE closes a quoted message ("... nu sollu"), LOCM is "in/on".
  DATM: `ku kku ukku kitta kita kooda koodave udan ko ki ge tho oda ode ka ke se saath sath ni inu ikku`,
  ACCM: `ah a ne`,
  PREPM: `to for with from towards toward by of`,
  QUOTE: `nu nnu endru entru ani anta ennu ki that ante`,
  LOCM: `la il lo mein in on at par`,
  CONJ: `and then also plus aur phir aprom apram apuram appuram matrum mathum pinne`,
  FILLER: `please pls plz kindly codex nexa konjam seekiram sikkiram udane ippo ippove ippa dayavu dayavuseidhu zara jara jaldi abhi kripya ippudu okasari
    da di pa ma machi macha dei dey ji sir madam`,
  // FILLERW: ignored when classifying, but never trimmed out of a message body (so "can you come?" survives)
  FILLERW: `can could would will shall just the an is are am be was i im i'm app page screen tab section want wanna need let lets let's hai ho hoon jo`,
  TAILW: `now quickly asap immediately urgently`,
  NEG: `remove stop cancel undo off vendam venam vendaam vendamnu eduthudu eduthidu eduthuru nikalo hatao hata hatana dislike unlike cheyyakandi`,
  STORE: `store shop`,
  MYGAMES: `mygames`,
  DISCOVER: `discover`,
  FRIENDS: `friends friend`,
  TOURNAMENT: `tournament tournaments tourney`,
  SAVEDPOSTS: `savedposts`,
  SAVEDREELS: `savedreels`,
  REELSHISTORY: `reelshistory`,
  PROFILESTUDIO: `profilestudio`,
  ANYMORE: ``,
};

// Multi-word phrases merged into a single canonical token before classification.
const PHRASES = [
  [['tic', 'tac', 'toe'], 'tictactoe'], [['tic', 'tac'], 'tictactoe'],
  [['connect', '4'], 'connectfour'], [['connect', 'four'], 'connectfour'],
  [['game', 'store'], 'gamestore'], [['games', 'store'], 'gamestore'], [['game', 'stores'], 'gamestore'],
  [['video', 'call'], 'videocall'], [['video', 'calling'], 'videocall'], [['voice', 'call'], 'voicecall'], [['audio', 'call'], 'voicecall'],
  [['vdo', 'call'], 'videocall'], [['vid', 'call'], 'videocall'],
  [['dark', 'mode'], 'darkmode'], [['light', 'mode'], 'lightmode'], [['night', 'mode'], 'darkmode'], [['day', 'mode'], 'lightmode'],
  [['dark', 'theme'], 'darkmode'], [['light', 'theme'], 'lightmode'],
  [['saved', 'posts'], 'savedposts'], [['saved', 'post'], 'savedposts'], [['saved', 'reels'], 'savedreels'], [['saved', 'reel'], 'savedreels'],
  [['reels', 'history'], 'reelshistory'], [['reel', 'history'], 'reelshistory'], [['watch', 'history'], 'reelshistory'],
  [['my', 'games'], 'mygames'],
  // 3-word forms first: the first matching phrase wins, so "edit profile photo" must not be
  // swallowed by the 2-word "edit profile" (which would leave a stray "photo" -> gallery app).
  [['edit', 'profile', 'studio'], 'profilestudio'], [['edit', 'profile', 'video'], 'profilestudio'], [['edit', 'profile', 'videos'], 'profilestudio'], [['edit', 'profile', 'photo'], 'profilestudio'], [['edit', 'profile', 'picture'], 'profilestudio'], [['edit', 'profile', 'pic'], 'profilestudio'], [['edit', 'profile', 'pics'], 'profilestudio'], [['edit', 'profile', 'image'], 'profilestudio'],
  [['change', 'profile', 'studio'], 'profilestudio'], [['change', 'profile', 'video'], 'profilestudio'], [['change', 'profile', 'videos'], 'profilestudio'], [['change', 'profile', 'photo'], 'profilestudio'], [['change', 'profile', 'picture'], 'profilestudio'], [['change', 'profile', 'pic'], 'profilestudio'], [['change', 'profile', 'pics'], 'profilestudio'], [['change', 'profile', 'image'], 'profilestudio'],
  [['update', 'profile', 'studio'], 'profilestudio'], [['update', 'profile', 'video'], 'profilestudio'], [['update', 'profile', 'videos'], 'profilestudio'], [['update', 'profile', 'photo'], 'profilestudio'], [['update', 'profile', 'picture'], 'profilestudio'], [['update', 'profile', 'pic'], 'profilestudio'], [['update', 'profile', 'pics'], 'profilestudio'], [['update', 'profile', 'image'], 'profilestudio'],
  [['customize', 'profile', 'studio'], 'profilestudio'], [['customize', 'profile', 'video'], 'profilestudio'], [['customize', 'profile', 'videos'], 'profilestudio'], [['customize', 'profile', 'photo'], 'profilestudio'], [['customize', 'profile', 'picture'], 'profilestudio'], [['customize', 'profile', 'pic'], 'profilestudio'], [['customize', 'profile', 'pics'], 'profilestudio'], [['customize', 'profile', 'image'], 'profilestudio'],
  [['customise', 'profile', 'studio'], 'profilestudio'], [['customise', 'profile', 'video'], 'profilestudio'], [['customise', 'profile', 'videos'], 'profilestudio'], [['customise', 'profile', 'photo'], 'profilestudio'], [['customise', 'profile', 'picture'], 'profilestudio'], [['customise', 'profile', 'pic'], 'profilestudio'], [['customise', 'profile', 'pics'], 'profilestudio'], [['customise', 'profile', 'image'], 'profilestudio'],
  [['set', 'profile', 'studio'], 'profilestudio'], [['set', 'profile', 'video'], 'profilestudio'], [['set', 'profile', 'videos'], 'profilestudio'], [['set', 'profile', 'photo'], 'profilestudio'], [['set', 'profile', 'picture'], 'profilestudio'], [['set', 'profile', 'pic'], 'profilestudio'], [['set', 'profile', 'pics'], 'profilestudio'], [['set', 'profile', 'image'], 'profilestudio'],
  [['profile', 'studio'], 'profilestudio'], [['profile', 'video'], 'profilestudio'], [['profile', 'videos'], 'profilestudio'],
  [['profile', 'photo'], 'profilestudio'], [['profile', 'picture'], 'profilestudio'], [['profile', 'pic'], 'profilestudio'],
  [['profile', 'pics'], 'profilestudio'], [['profile', 'image'], 'profilestudio'], [['edit', 'profile'], 'profilestudio'],
  [['customize', 'profile'], 'profilestudio'], [['customise', 'profile'], 'profilestudio'], [['my', 'studio'], 'profilestudio'],
  [['what', 'can', 'you', 'do'], 'help'], [['what', 'can', 'u', 'do'], 'help'], [['what', 'you', 'can', 'do'], 'help'],
  [['who', 'are', 'you'], 'whoareyou'], [['who', 'r', 'you'], 'whoareyou'], [['who', 'are', 'u'], 'whoareyou'],
  [['who', 'is'], 'whois'], [['who', 's'], 'whois'], [['thank', 'you'], 'thanks'], [['thank', 'u'], 'thanks'],
  [['mark', 'all'], 'mark'], [['mark', 'as'], 'mark'],
];

const WORDS = new Map();        // exact word -> Set(concept)
const FUZZY_POOL = [];          // [{ word, concepts:Set }] — latin words >= 4 chars, meaningful concepts only
const CJK_WORDS = [];           // CJK lexicon words, longest first

const NO_FUZZY = new Set(['FILLER', 'FILLERW', 'TAILW', 'NEG', 'LIGHT', 'DATM', 'ACCM', 'PREPM', 'QUOTE', 'LOCM', 'CONJ', 'ME', 'YOU', 'REF', 'HIM', 'GREET', 'AS', 'STORE', 'THEME', 'READ', 'VOICE', 'THANKS', 'HELP', 'WHOIS', 'RENAME']);

for (const [concept, src] of Object.entries(LEX_SRC)) {
  for (const w of src.split(/\s+/).filter(Boolean)) {
    const k = canon(w);
    if (!WORDS.has(k)) WORDS.set(k, new Set());
    WORDS.get(k).add(concept);
  }
}
for (const [w, concepts] of WORDS) {
  if (CJK_RE.test(w)) CJK_WORDS.push(w);
  const fuzzable = [...concepts].filter(c => !NO_FUZZY.has(c));
  if (fuzzable.length && /^[a-z]+$/.test(w) && w.length >= 4) FUZZY_POOL.push({ word: w, concepts: new Set(fuzzable) });
}
CJK_WORDS.sort((a, b) => b.length - a.length);

// Verbs that can be undone with an "un" prefix / "stop" / "remove": base concept -> undo flag.
const UNDOABLE = new Set(['FOLLOW', 'MUTE', 'BLOCK', 'RESTRICT', 'LIKE', 'SAVE']);

const sortedLetters = (w) => [...w].sort().join('');

function fuzzyConcepts(key) {
  if (key.length < 4 || !/^[a-z]+$/.test(key)) return null;
  const thr = key.length >= 8 ? 2 : 1;
  let best = null, bestD = 99;
  for (const { word, concepts } of FUZZY_POOL) {
    if (Math.abs(word.length - key.length) > 2) continue;
    if (word[0] !== key[0]) continue;
    let d = editDistance(key, word);
    const skelEq = key.length >= 5 && word.length >= 5 && skeleton(key) === skeleton(word);
    if (skelEq) d = Math.min(d, 1);
    else if (d === 1 && key.length === word.length && key.length <= 5 && sortedLetters(key) !== sortedLetters(word)) continue; // "live" must not become "like"
    if (d > thr) continue;
    if (d < bestD) { bestD = d; best = new Set(concepts); }
    else if (d === bestD) concepts.forEach(c => best.add(c));
  }
  return best;
}

// ───────────────────────────── tokenizer ─────────────────────────────

function pushToken(out, raw, start) {
  out.push({ raw, lower: canon(raw), start, end: start + raw.length, kinds: new Set(), colonAfter: false });
}

function splitCjk(piece, off, out) {
  // Split a mixed CJK/other run into lexicon words (longest match) and leftovers.
  let i = 0, buf = '', bufStart = 0;
  const flush = () => { if (buf) { pushToken(out, buf, off + bufStart); buf = ''; } };
  while (i < piece.length) {
    let hit = null;
    if (CJK_RE.test(piece[i])) hit = CJK_WORDS.find(w => piece.startsWith(w, i));
    if (hit) { flush(); pushToken(out, hit, off + i); i += hit.length; bufStart = i; }
    else { if (!buf) bufStart = i; buf += piece[i]; i++; }
  }
  flush();
}

export function tokenize(text) {
  const out = [];
  const re = /\S+/gu;
  let m;
  while ((m = re.exec(text))) {
    const chunk = m[0], base = m.index;
    if (/^(https?:\/\/|www\.)/i.test(chunk)) { const t = { raw: chunk, lower: chunk.toLowerCase(), start: base, end: base + chunk.length, kinds: new Set(['URL']), colonAfter: false }; out.push(t); continue; }
    const sre = /[^-–—_/\\|]+/gu;
    let pm;
    let any = false;
    while ((pm = sre.exec(chunk))) {
      any = true;
      let s = pm[0], start = base + pm.index;
      const lead = s.match(/^[^\p{L}\p{M}\p{N}@#]+/u);
      if (lead && lead[0].length < s.length) { s = s.slice(lead[0].length); start += lead[0].length; }
      let colon = false;
      const trail = s.match(/[^\p{L}\p{M}\p{N}]+$/u);
      if (trail && trail[0].length < s.length) { colon = trail[0].includes(':'); s = s.slice(0, -trail[0].length); }
      s = s.replace(/^(.{2,})['’]s$/i, (x, stem) => (/^(it|he|she|that|what|who|there|here|let|how|where|when)$/i.test(stem) ? x : stem)); // priya's -> priya, but keep it's/that's
      if (CJK_RE.test(s)) {
        const before = out.length;
        for (const run of s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]+/gu) || [])
          splitCjk(run, start + s.indexOf(run), out);
        if (out.length > before) out[out.length - 1].colonAfter = colon;
      } else {
        pushToken(out, s, start);
        out[out.length - 1].colonAfter = colon;
      }
    }
    if (!any) pushToken(out, chunk, base);
  }
  return out;
}

function mergePhrases(toks) {
  const out = [];
  for (let i = 0; i < toks.length;) {
    let merged = false;
    for (const [seq, canonical] of PHRASES) {
      if (i + seq.length > toks.length) continue;
      if (seq.every((w, j) => toks[i + j].lower === w)) {
        const first = toks[i], last = toks[i + seq.length - 1];
        out.push({ raw: canonical, lower: canonical, start: first.start, end: last.end, kinds: new Set(), colonAfter: last.colonAfter, merged: true });
        i += seq.length; merged = true; break;
      }
    }
    if (!merged) out.push(toks[i++]);
  }
  out.forEach((t, i) => { t.i = i; });
  return out;
}

// ───────────────────────────── classification ─────────────────────────────

function classify(t, env) {
  if (t.kinds.has('URL')) return;
  if (t.raw.startsWith('@') && t.raw.length > 1) { t.kinds.add('MENTION'); t.name = t.raw.slice(1); return; }
  if (t.raw.startsWith('#') && t.raw.length > 1) { t.kinds.add('HASHTAG'); return; }
  if (/^\d+$/.test(t.lower)) { t.kinds.add('NUM'); return; }
  if (!/[\p{L}\p{N}]/u.test(t.raw)) { t.kinds.add('SYMBOL'); return; }

  const exact = WORDS.get(t.lower);
  const strongLex = exact && [...exact].some(c => c !== 'FILLER');
  const p = env.person ? env.person(t.lower) : 0;

  if (strongLex) { exact.forEach(c => t.kinds.add(c)); t.exact = true; if (p >= 2 && t.kinds.has('HIM') === false) t.personExact = true; return; }
  if (p >= 2) { t.kinds.add('PERSON'); t.known = p; return; }
  if (exact) { exact.forEach(c => t.kinds.add(c)); t.exact = true; return; }

  // "un"/"dis" prefix on an undoable verb: unfollow, unblok, unmuet, dislike
  const un = t.lower.match(/^(un|de)([a-z]{4,})$/);
  if (un) {
    const base = WORDS.get(un[2]) || fuzzyConcepts(un[2]);
    if (base) for (const c of base) if (UNDOABLE.has(c)) { t.kinds.add(c); t.kinds.add('NEG'); t.undo = true; }
    if (t.kinds.size) return;
  }

  const fz = fuzzyConcepts(t.lower);
  if (fz && p < 1) { fz.forEach(c => t.kinds.add(c)); t.fuzzy = true; return; }
  if (p >= 1) { t.kinds.add('PERSON'); t.known = p; return; }
  if (fz) { fz.forEach(c => t.kinds.add(c)); t.fuzzy = true; return; }

  // dislike/unlike spelt out
  if (/^dis?like/.test(t.lower)) { t.kinds.add('LIKE'); t.kinds.add('NEG'); t.undo = true; }
}

// ───────────────────────────── preparation ─────────────────────────────

const QUOTE_RE = /["“”«»「」『』]([^"“”«»「」『』]+)["“”«»「」『』]/u;

function prepare(seg, env) {
  let work = seg;
  let body = null;
  const q = seg.match(QUOTE_RE);
  if (q) { body = q[1].trim(); work = work.slice(0, q.index) + ' '.repeat(q[0].length) + work.slice(q.index + q[0].length); }
  // colon form: "<head>: <body>" — colon must follow a letter and not be part of a URL/time
  const cm = work.match(/[\p{L}\p{N}@]:(?!\/\/|\\)/u);
  let hasColon = false;
  if (cm && !/[\p{N}]:\d/u.test(cm[0] + work[cm.index + 2])) {
    const pos = cm.index + 1;
    if (body === null) body = seg.slice(pos + 1).trim().replace(/^["“«「『]|["”»」』]$/gu, '').trim();
    work = work.slice(0, pos) + ' '.repeat(work.length - pos);
    hasColon = true;
  }
  const toks = mergePhrases(tokenize(work));
  toks.forEach(t => classify(t, env));
  const bag = new Map();
  for (const t of toks) for (const k of t.kinds) { if (!bag.has(k)) bag.set(k, []); bag.get(k).push(t.i); }
  return { seg, work, toks, bag, body: body || null, hasColon, has: (k) => bag.has(k), first: (k) => bag.get(k)?.[0] };
}

const GENERIC_NAME_BLOCK = new Set(['SEND', 'MSG', 'OPEN', 'LIGHT', 'FOLLOW', 'MUTE', 'BLOCK', 'RESTRICT', 'LIKE', 'SAVE', 'SHARE', 'COMMENT', 'POST', 'NOTE', 'STORY', 'CREATE', 'REEL', 'VIDEO', 'GAME', 'PLAY', 'JOIN', 'INVITE', 'PROFILE', 'NOTIF', 'FEED', 'SEARCH', 'SETTINGS', 'HISTORY', 'CALL', 'THEME_DARK', 'THEME_LIGHT', 'THEME', 'DELETE', 'NICK', 'GREET', 'REF', 'ME', 'YOU', 'FILLER', 'DATM', 'ACCM', 'PREPM', 'QUOTE', 'LOCM', 'CONJ', 'URL', 'NUM', 'SYMBOL', 'HASHTAG', 'NEG', 'AS', 'STORE', 'THANKS', 'HELP', 'WHOIS', 'RENAME', 'READ', 'VOICE', 'FILLERW', 'TAILW', 'SAVED', 'HIM']);
const isNameLike = (t) => t.kinds.has('MENTION') || t.kinds.has('PERSON') || ![...t.kinds].some(k => GENERIC_NAME_BLOCK.has(k) || k.startsWith('GAMEKEY') || ['MYGAMES', 'DISCOVER', 'FRIENDS', 'TOURNAMENT', 'SAVEDPOSTS', 'SAVEDREELS', 'REELSHISTORY', 'PROFILESTUDIO'].includes(k));
const PERSON_FIRST_VERBS = new Set(['message', 'messages', 'msg', 'msgs', 'dm', 'dms', 'text', 'tell', 'say', 'sollu', 'solu', 'sollunga', 'bol', 'bolo', 'kaho', 'bata', 'batao', 'cheppu', 'parayu', 'dis', 'dile', 'dime', 'schreib']);

// ───────────────────────────── argument extraction ─────────────────────────────

function findPerson(P, state, opts = {}) {
  const T = P.toks;
  const exclude = opts.exclude || new Set();
  const scores = new Map();
  const bump = (idx, s, why) => { if (exclude.has(idx)) return; const cur = scores.get(idx); if (!cur || s > cur.s) scores.set(idx, { s, why }); };

  T.forEach(t => {
    if (exclude.has(t.i)) return;
    if (t.kinds.has('MENTION')) bump(t.i, 9, 'mention');
    else if (t.kinds.has('PERSON') || t.personExact) bump(t.i, (t.known || 1) >= 2 ? 8 : 7, 'known');
  });
  const verbIdx = T.findIndex(t => t.kinds.has('SEND') || t.kinds.has('MSG'));
  const personFirstVerb = verbIdx >= 0 && PERSON_FIRST_VERBS.has(T[verbIdx].lower);
  T.forEach((t, j) => {
    if (t.kinds.has('DATM') && T[j - 1] && isNameLike(T[j - 1]) && !T[j - 1].kinds.has('GREET')) bump(j - 1, 6, 'datm');
    if (t.kinds.has('ACCM') && T[j - 1] && (T[j - 1].kinds.has('PERSON') || T[j - 1].kinds.has('MENTION'))) bump(j - 1, 6, 'accm');
    if (t.kinds.has('PREPM') && T[j + 1] && isNameLike(T[j + 1]) && !T[j + 1].kinds.has('GREET')) {
      // "message rahul to come" — 'to' right after the person is an infinitive, not a marker
      const adjacentToVerbPerson = personFirstVerb && j - 1 === verbIdx + 1 && isNameLike(T[j - 1]);
      bump(j + 1, adjacentToVerbPerson ? 4 : 6, 'prepm');
    }
  });
  if (personFirstVerb && T[verbIdx + 1] && isNameLike(T[verbIdx + 1]) && !T[verbIdx + 1].kinds.has('GREET')) bump(verbIdx + 1, 5, 'afterverb');

  let best = null;
  for (const [idx, v] of scores) if (!best || v.s > best.s || (v.s === best.s && idx < best.idx)) best = { idx, ...v };
  if (best) return { idx: best.idx, name: T[best.idx].name || T[best.idx].raw };

  // Pronouns / carried-over person.
  if (opts.allowPronoun !== false) {
    const pr = T.find(t => t.kinds.has('HIM'));
    const carried = state.lastPerson || P.env?.context?.profileUsername || P.env?.context?.activeConversationUsername || P.env?.context?.currentReel?.authorUsername || P.env?.context?.currentPost?.authorUsername;
    if (pr && carried) return { idx: pr.i, name: carried, pronoun: true };
    if (!pr && opts.carry && carried) return { idx: -1, name: carried, carried: true };
  }

  // Last resort: the sole unclassified word (an unknown username typed by the user), or the
  // first unclassified word after a send-verb ("send rahul hi" when rahul isn't in the DB).
  const plain = T.filter(t => !t.kinds.size && !exclude.has(t.i));
  if (opts.fallbackPlain !== false && plain.length === 1) return { idx: plain[0].i, name: plain[0].raw };
  if (opts.firstPlainAfterVerb && verbIdx >= 0) {
    const after = plain.find(t => t.i > verbIdx);
    if (after) return { idx: after.i, name: after.raw };
  }
  return null;
}

// Rebuild free text from the original string for tokens that survive trimming.
function extractBody(P, removed, trimKinds, verbIdx = -1) {
  if (P.body) return P.body;
  const T = P.toks;
  const pre = new Set();
  if (verbIdx > 0) {
    // "can you please send hi to rahul" / "i want to send ..." — preamble before the verb is not message text
    for (let i = 0; i < verbIdx; i++) {
      const k = T[i].kinds;
      if (k.size && [...k].every(x => ['FILLER', 'FILLERW', 'YOU', 'ME', 'LIGHT', 'TAILW'].includes(x))) pre.add(i);
      if (i === verbIdx - 1 && k.has('PREPM')) pre.add(i);
    }
  }
  let idxs = T.filter(t => !removed.has(t.i) && !pre.has(t.i)).map(t => t.i);
  const trimmable = (i) => { const k = T[i].kinds; return k.size > 0 && [...k].some(x => trimKinds.has(x)); };
  while (idxs.length && trimmable(idxs[0])) idxs.shift();
  while (idxs.length && trimmable(idxs[idxs.length - 1])) idxs.pop();
  if (!idxs.length) return '';
  const first = T[idxs[0]], last = T[idxs[idxs.length - 1]];
  // original slice, minus any removed tokens inside it
  let out = '', cursor = first.start;
  const inner = T.filter(t => t.start >= first.start && t.end <= last.end && (removed.has(t.i) || pre.has(t.i)));
  for (const r of inner) { out += P.seg.slice(cursor, r.start); cursor = r.end; }
  out += P.seg.slice(cursor, last.end);
  // keep trailing punctuation/emoji such as "!!" "?" "😂"
  const tail = P.seg.slice(last.end).match(/^[^\p{L}\p{N}\s:]+/u);
  if (tail) out += tail[0];
  return out.replace(/\s+/g, ' ').trim();
}

function appMatch(P, env, used) {
  const apps = env.apps || [];
  if (!apps.length) return null;
  const T = P.toks;
  const cleaned = (s) => canon(s).replace(/[^\p{L}\p{N}]+/gu, '');
  let best = null;
  for (const app of apps) {
    for (const nm of app.names) {
      const n = cleaned(nm);
      if (!n || (nm === 'chat')) continue;
      // multiword names: join 1-3 consecutive tokens
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= T.length; i++) {
          const joined = cleaned(T.slice(i, i + len).map(t => t.raw).join(''));
          if (!joined) continue;
          const exactHit = joined === n;
          const typo = !exactHit && n.length >= 5 && joined.length >= 5 && editDistance(joined, n) <= (n.length >= 8 ? 2 : 1) && joined[0] === n[0];
          if (exactHit || typo) {
            const score = (exactHit ? 10 : 5) + len;
            if (!best || score > best.score) best = { app, score, from: i, to: i + len - 1 };
          }
        }
      }
    }
  }
  if (best) for (let i = best.from; i <= best.to; i++) used.add(i);
  return best;
}

// ───────────────────────────── replies ─────────────────────────────

export const HELP_TEXT = `I understand typos, mixed languages (Tanglish, Hinglish and more) and any word order. Try:
• send rahul hi / hi to rahul / rahul ku hi anupu / message rahul: running late
• open messages / msg / game store open pannu / reels / feed / my profile / settings / notifications
• follow, unfollow, mute, unmute, block, unblock, restrict — e.g. "priya ah follow pannu", "unfollow arjun"
• like this / save this / comment nice! / send this to priya (acts on the Reel or Post on screen)
• post: <text>, note: <text>, story: <text>
• call rahul / video call rahul
• play chess with priya / join game ABC123
• open spotify / youtube la <search> / search #hashtag
• dark mode / light mode
• save rahul as bestie, who is bestie, show my nicknames
Chain steps with "and": "follow priya and message her hi".`;

const GREET_REPLIES = ['Hi! What would you like me to do?', 'Hey! Tell me what to do — e.g. "open reels" or "send rahul hi".'];

// ───────────────────────────── segment parser ─────────────────────────────

const REL_ACTIONS = { FOLLOW: ['follow_user', 'unfollow_user'], MUTE: ['mute_user', 'unmute_user'], BLOCK: ['block_user', 'unblock_user'], RESTRICT: ['restrict_user', 'unrestrict_user'] };
const GAMEKEYS = { GAMEKEY_TTT: 'tic-tac-toe', GAMEKEY_C4: 'connect-four', GAMEKEY_CHECKERS: 'checkers', GAMEKEY_CHESS: 'chess' };
const NOISE = new Set(['FILLER', 'FILLERW', 'YOU', 'ME', 'LIGHT', 'ACCM', 'DATM', 'PREPM', 'LOCM', 'QUOTE', 'CONJ', 'TAILW', 'SYMBOL', 'THANKS']);
const VERB_LEADS = ['FOLLOW', 'MUTE', 'BLOCK', 'RESTRICT', 'LIKE', 'SAVE', 'CALL', 'OPEN', 'SEARCH', 'CREATE', 'POST', 'NOTE', 'STORY', 'DELETE', 'SHARE', 'COMMENT', 'JOIN', 'PLAY', 'INVITE'];
const SEND_TRIM = new Set(['SEND', 'MSG', 'LIGHT', 'FILLER', 'TAILW', 'QUOTE', 'DATM', 'ACCM', 'PREPM', 'CREATE']);
const QUERY_TRIM = new Set(['SEARCH', 'OPEN', 'PLAY', 'LIGHT', 'FILLER', 'FILLERW', 'TAILW', 'QUOTE', 'CREATE', 'DATM', 'ACCM', 'PREPM', 'LOCM', 'YOU', 'ME', 'CONJ']);
const CREATE_TRIM = new Set(['LIGHT', 'FILLER', 'TAILW', 'QUOTE', 'CREATE', 'DATM', 'ACCM', 'PREPM', 'LOCM', 'POST', 'NOTE', 'STORY', 'COMMENT', 'SEND']);

const act = (name, input) => ({ kind: 'actions', actions: [{ name, input }] });
const reply = (message, extra = {}) => ({ kind: 'reply', message, ...extra });
const clarify = (message) => ({ kind: 'clarify', message });
const NONE = { kind: 'none' };
const isNoise = (t) => t.kinds.size > 0 && [...t.kinds].every(k => NOISE.has(k));
const entityText = (T, pred) => T.filter(pred).map(t => t.raw).join(' ').trim();
const isEntity = (t) => !t.kinds.size || t.kinds.has('PERSON') || t.kinds.has('MENTION');

function parseSegment(seg, env, state) {
  const P = prepare(seg, env);
  P.env = env;
  const T = P.toks;
  const has = P.has;
  if (!T.length) return NONE;

  const nn = T.filter(t => !isNoise(t));
  const lead = nn[0], trail = nn[nn.length - 1];
  const leadIsVerb = !!lead && VERB_LEADS.some(k => lead.kinds.has(k));
  const remember = (pr) => { if (pr && !pr.pronoun && pr.name) state.lastPerson = pr.name; };
  const idxOf = (...kinds) => new Set(T.filter(t => kinds.some(k => t.kinds.has(k))).map(t => t.i));

  // ── 0. conversation / meta ──
  if (has('HELP') && nn.length <= 2 && !has('SEND')) return reply(HELP_TEXT);
  if (T.some(t => t.lower === 'whoareyou')) return reply("I'm Codex, NEXA's built-in assistant. I can message people, open screens, follow/mute/block, post, like/save what's on screen, call, play games and open apps. Say \"help\" for examples.");
  if (has('THANKS') && nn.length === 0) return reply("You're welcome!");
  if (has('GREET') && nn.every(t => t.kinds.has('GREET') || (!t.kinds.size && /^(there|bro|buddy|friend|everyone|all)$/.test(t.lower)))) {
    return reply('Hi! What would you like me to do? e.g. "open reels" or "send rahul hi".');
  }

  // ── 1. nicknames ──
  const asIdx = P.first('AS');
  const quoteIdx = P.first('QUOTE');
  const nickEntities = T.filter(isEntity);
  const nickSave = has('SAVE') && !has('REF') && (asIdx !== undefined || (quoteIdx !== undefined && nickEntities.length >= 2));
  const renameLead = !!lead && lead.kinds.has('RENAME') && T.some(x => x.lower === 'to') && nickEntities.length >= 2;
  if (has('NICK') || nickSave || renameLead) {
    if (nickSave || (has('NICK') && asIdx !== undefined && !has('RENAME') && !has('DELETE') && !has('NEG'))) {
      let who, nick;
      if (asIdx !== undefined) {
        const before = T.filter(t => t.i < asIdx && isEntity(t));
        const after = T.filter(t => t.i > asIdx && !isNoise(t) && !t.kinds.has('SAVE') && !t.kinds.has('NICK'));
        who = before[before.length - 1]; nick = after.map(t => t.raw).join(' ');
      } else {
        who = nickEntities[0]; nick = nickEntities.slice(1).map(t => t.raw).join(' ');
      }
      if (!who || !nick) return clarify('Who should I save, and as what? e.g. "save rahul as bestie".');
      state.lastPerson = who.name || who.raw;
      return act('save_profile_nickname', { username: who.name || who.raw, nickname: nick });
    }
    if (has('RENAME')) {
      const toTok = T.find(t => t.lower === 'to');
      if (toTok) {
        const oldN = entityText(T, t => t.i < toTok.i && isEntity(t));
        const newN = entityText(T, t => t.i > toTok.i && isEntity(t));
        if (oldN && newN) return act('update_profile_nickname', { oldNickname: oldN, newNickname: newN });
      }
      return clarify('Tell me which nickname to rename and what to — e.g. "rename bestie to bro".');
    }
    if (has('DELETE') || has('NEG')) {
      const n = entityText(T, isEntity);
      return n ? act('delete_profile_nickname', { nickname: n }) : clarify('Which nickname should I forget?');
    }
    if (has('WHOIS')) { const n = entityText(T, isEntity); if (n) return act('resolve_profile_nickname', { nickname: n }); }
    return act('list_profile_nicknames', {});
  }
  if (T.some(t => t.lower === 'forget') && has('DELETE')) {
    const n = entityText(T, isEntity);
    if (n) return act('delete_profile_nickname', { nickname: n });
  }
  if (has('WHOIS') && !has('SEND') && !has('OPEN')) {
    const n = entityText(T, isEntity);
    if (n) return act('resolve_profile_nickname', { nickname: n });
  }

  // ── 1b. creating content (post / note / story / reel) and commenting ──
  const BLOCKS_CREATE = ['DELETE', 'SAVE', 'SAVED', 'SAVEDPOSTS', 'SAVEDREELS', 'LIKE', 'SHARE', 'OPEN', 'SEARCH', 'HISTORY', 'REELSHISTORY', 'READ'];
  const isCreateKind = (t) => ['POST', 'NOTE', 'STORY', 'COMMENT', 'CREATE'].some(k => t.kinds.has(k));
  const createLead = lead && isCreateKind(lead);
  const createTrail = trail && ['POST', 'NOTE', 'STORY', 'COMMENT'].some(k => trail.kinds.has(k)) && nn.length > 1;
  const noBlocker = !BLOCKS_CREATE.some(k => has(k)) && !has('NEG');
  const colonCreate = P.hasColon && T.some(isCreateKind);
  if ((createLead || createTrail || colonCreate) && noBlocker && !has('SEND')) {
    const urlTok = T.find(t => t.kinds.has('URL'));
    const kindSet = idxOf('POST', 'NOTE', 'STORY', 'COMMENT', 'CREATE', 'REEL', 'URL');
    if (has('REEL') && (has('CREATE') || has('POST')) && !has('COMMENT')) {
      if (urlTok) return act('create_reel', { videoUrl: urlTok.raw, caption: extractBody(P, kindSet, CREATE_TRIM) });
      return reply("To post a reel from your device, open Reels and tap Upload. Or give me a direct .mp4/.webm/.mov link and I'll post it.", { navigate: { screen: 'reels' } });
    }
    const kind = has('COMMENT') ? 'COMMENT' : has('NOTE') ? 'NOTE' : has('STORY') ? 'STORY' : 'POST';
    const verbIdx = Math.min(...[...kindSet], T.length);
    const body = extractBody(P, kindSet, CREATE_TRIM, verbIdx === T.length ? -1 : verbIdx);
    if (body) {
      if (kind === 'COMMENT') return act('comment_content', { text: body });
      if (kind === 'NOTE') return act('create_note', { text: body });
      if (kind === 'STORY') return act('create_story', { text: body });
      return act('create_post', { caption: body });
    }
    if (has('CREATE') || P.hasColon || kind === 'COMMENT') return clarify(`What should the ${kind.toLowerCase()} say? e.g. "${kind.toLowerCase()}: had a great day".`);
  }

  // ── 2. share what's on screen: "send this to rahul", "share this with priya", "idha rahul ku anuppu" ──
  const pureSend = T.find(t => t.kinds.has('SEND'));
  const msgWord = T.find(t => t.kinds.has('MSG'));
  const realRef = T.some(t => t.kinds.has('REF') && !(t.lower === 'that' && T.slice(t.i + 1).some(x => !x.kinds.size)));
  if (has('SHARE') || (pureSend && realRef && !P.body)) {
    const refIdx = idxOf('REF', 'SHARE');
    const pr = findPerson(P, state, { exclude: refIdx, firstPlainAfterVerb: true });
    const removed = new Set([...refIdx, ...idxOf('SEND', 'MSG'), ...(pr && pr.idx >= 0 ? [pr.idx] : [])]);
    const leftover = extractBody(P, removed, new Set([...SEND_TRIM, 'REF', 'SHARE']));
    if (has('SHARE') || !leftover) {
      if (!pr) return clarify('Who should I share this with?');
      remember(pr);
      return act('share_content', { username: pr.name });
    }
  }

  // ── 3. sending a message ──
  const sendish = !!pureSend || (!!msgWord && !has('OPEN'));
  const sendWins = sendish && !(leadIsVerb && !lead.kinds.has('SEND') && !lead.kinds.has('MSG') );
  if (sendWins) {
    const verbIdx = T.findIndex(t => t.kinds.has('SEND') || t.kinds.has('MSG'));
    let pr = findPerson(P, state, { carry: state.index > 0, firstPlainAfterVerb: true, fallbackPlain: true });
    const verbSet = idxOf('SEND', 'MSG');
    if (!pr) {
      const bodyOnly = extractBody(P, verbSet, SEND_TRIM, verbIdx);
      if (!bodyOnly && (msgWord || has('OPEN'))) return act('navigate', { screen: 'messages' });
      return clarify('Who should I send that to? e.g. "send hi to rahul".');
    }
    remember(pr);
    const removed = new Set([...verbSet]);
    if (pr.idx >= 0) {
      removed.add(pr.idx);
      T.forEach(t => { if ((t.kinds.has('DATM') || t.kinds.has('ACCM')) && t.i === pr.idx + 1) removed.add(t.i); if (t.kinds.has('PREPM') && t.i === pr.idx - 1) removed.add(t.i); });
    }
    const body = extractBody(P, removed, SEND_TRIM, verbIdx);
    if (!body) {
      if (msgWord || has('OPEN')) return act('navigate', { screen: 'messages', username: pr.name });
      return clarify(`What should I say to @${pr.name}?`);
    }
    return act('send_message', { username: pr.name, text: body });
  }

  // ── 4. calls ──
  if (has('CALL') && !has('NOTIF')) {
    const pr = findPerson(P, state, { carry: state.index > 0 });
    const video = has('VIDEO') || T.some(t => ['videocall', 'vc', 'facetime'].includes(t.lower));
    if (!pr) return clarify(`Who should I ${video ? 'video ' : ''}call?`);
    remember(pr);
    return act('start_call', { username: pr.name, video });
  }

  // ── 5. theme ──
  const strongTheme = T.some(t => ['dark', 'darkmode', 'lightmode', 'nightmode', 'daymode'].includes(t.lower));
  if ((has('THEME_DARK') || has('THEME_LIGHT')) && (strongTheme || has('THEME')) && !['POST', 'NOTE', 'STORY', 'COMMENT', 'SEND', 'LIKE'].some(k => has(k))) {
    const first = T.find(t => t.kinds.has('THEME_DARK') || t.kinds.has('THEME_LIGHT'));
    return act('set_theme', { theme: first.kinds.has('THEME_DARK') ? 'dark' : 'light' });
  }

  // ── 6. relationship verbs ──
  const relTokens = T.filter(t => ['FOLLOW', 'MUTE', 'BLOCK', 'RESTRICT'].some(k => t.kinds.has(k)));
  if (relTokens.length) {
    const pr = findPerson(P, state, { exclude: new Set(relTokens.map(t => t.i)), carry: state.index > 0 });
    if (!pr) return clarify(`Who should I ${relTokens[0].lower.replace(/^un/, '')}?`);
    remember(pr);
    const undoAll = has('NEG');
    return { kind: 'actions', actions: relTokens.map(t => {
      const kind = ['FOLLOW', 'MUTE', 'BLOCK', 'RESTRICT'].find(k => t.kinds.has(k));
      const [doName, undoName] = REL_ACTIONS[kind];
      return { name: (t.undo || undoAll) ? undoName : doName, input: { username: pr.name } };
    }) };
  }

  // ── 7. like / save / delete the thing on screen ──
  if (has('DELETE') && (has('POST') || realRef) && !has('NICK')) return act('delete_post', {});
  if (has('LIKE') && !has('NOTIF')) return act(has('NEG') ? 'unlike_content' : 'like_content', {});
  if (has('SAVE') && !has('SAVED')) return act(has('NEG') ? 'unsave_content' : 'save_content', {});

  // ── 8. games ──
  if (has('JOIN')) {
    const code = T.find(t => /^[a-z0-9]{4,8}$/i.test(t.raw) && (!t.kinds.size || t.kinds.has('NUM')));
    if (code) return act('join_game', { inviteCode: code.raw.toUpperCase() });
    if (has('GAME') || nn.length <= 2) return clarify('What is the invite code? e.g. "join game ABC123".');
  }
  const gk = T.find(t => [...t.kinds].some(k => k.startsWith('GAMEKEY')));
  if (gk) {
    const pr = findPerson(P, state, { exclude: new Set([gk.i]), fallbackPlain: false });
    if ((has('PLAY') || has('INVITE') || pr) && !(has('OPEN') && !pr && !has('PLAY') && !has('INVITE'))) {
      const kind = Object.keys(GAMEKEYS).find(k => gk.kinds.has(k));
      if (!pr) return clarify(`Who should I invite to ${GAMEKEYS[kind]}? e.g. "play ${GAMEKEYS[kind]} with priya".`);
      remember(pr);
      return act('invite_to_game', { gameId: GAMEKEYS[kind], username: pr.name });
    }
  }

  // ── 9. notifications ──
  if (has('NOTIF')) return (has('READ') || has('DELETE')) ? act('mark_notifications_read', {}) : act('navigate', { screen: 'notifications' });

  // ── 10. search ──
  const appUsed = new Set();
  const appHit = appMatch(P, env, appUsed);
  if (has('SEARCH') && !appHit) {
    const query = extractBody(P, idxOf('SEARCH'), QUERY_TRIM);
    return query ? act('search', { query }) : act('navigate', { screen: 'search' });
  }

  // ── 11. external apps ──
  if (appHit) {
    const searchFor = extractBody(P, new Set([...appUsed, ...idxOf('SEARCH', 'OPEN', 'PLAY')]), QUERY_TRIM);
    return act('open_app', searchFor ? { appName: appHit.app.names[0], searchFor } : { appName: appHit.app.names[0] });
  }

  // ── 12. navigation ──
  const tabTok = T.find(t => ['MYGAMES', 'DISCOVER', 'TOURNAMENT'].some(k => t.kinds.has(k)) || (t.kinds.has('FRIENDS') && has('GAME')));
  const tab = tabTok ? (tabTok.kinds.has('MYGAMES') ? 'mine' : tabTok.kinds.has('DISCOVER') ? 'discover' : tabTok.kinds.has('FRIENDS') ? 'friends' : 'tournaments') : undefined;
  let screen = null;
  if (has('PROFILESTUDIO')) screen = 'profile-studio';
  else if (has('REELSHISTORY') || (has('HISTORY') && (has('REEL') || has('VIDEO')))) screen = 'reels-history';
  else if (has('SAVEDREELS') || (has('SAVED') && has('REEL'))) screen = 'saved-reels';
  else if (has('SAVEDPOSTS') || (has('SAVED') && has('POST'))) screen = 'saved-posts';
  else if (has('GAME') || tab || (has('PLAY') && !gk)) screen = 'games';
  else if (has('REEL') || (has('VIDEO') && !has('CALL'))) screen = 'reels';
  else if (has('PROFILE')) screen = 'profile';
  else if (has('MSG')) screen = 'messages';
  else if (has('NOTE')) screen = 'messages';
  else if (has('FEED') || has('POST') || has('STORY')) screen = 'feed';
  else if (has('SETTINGS')) screen = 'settings';
  else if (has('SAVED')) screen = 'saved-posts';
  else if (has('SEARCH')) screen = 'search';
  if (screen) {
    const input = { screen };
    if (screen === 'games' && tab) input.tab = tab;
    if (screen === 'profile' || screen === 'messages') {
      const pr = findPerson(P, state, { fallbackPlain: false, carry: false });
      if (pr && !(has('ME') && pr.how === 'fallback')) { input.username = pr.name; remember(pr); }
    }
    return act('navigate', input);
  }

  if (has('OPEN')) {
    const pr = findPerson(P, state, { fallbackPlain: false, carry: false });
    if (pr) { remember(pr); return act('navigate', { screen: 'profile', username: pr.name }); }
    const rest = entityText(T, t => !isNoise(t) && !t.kinds.has('OPEN'));
    if (rest) return act('open_app', { appName: rest });
    return NONE;
  }

  // ── 13. implicit message: "hi to rahul", "hi rahul", "rahul hi", "rahul ku late ah varuven" ──
  const pr13 = findPerson(P, state, { carry: false, fallbackPlain: has('GREET') });
  if (pr13 && pr13.idx >= 0 && !pr13.pronoun) {
    const removed = new Set([pr13.idx]);
    T.forEach(t => { if ((t.kinds.has('DATM') || t.kinds.has('ACCM')) && t.i === pr13.idx + 1) removed.add(t.i); if (t.kinds.has('PREPM') && t.i === pr13.idx - 1) removed.add(t.i); });
    const dative = removed.size > 1;
    const body = extractBody(P, removed, SEND_TRIM);
    const onlyMessagey = T.every(t => removed.has(t.i) || !t.kinds.size || ['GREET', 'DATM', 'PREPM', 'ACCM', 'FILLER', 'FILLERW', 'SYMBOL', 'NUM', 'QUOTE', 'TAILW', 'YOU', 'ME'].some(k => t.kinds.has(k)));
    if (body && onlyMessagey && (dative || has('GREET'))) { remember(pr13); return act('send_message', { username: pr13.name, text: body }); }
    if (!body && nn.length === 1 && (T[pr13.idx].kinds.has('PERSON') || T[pr13.idx].kinds.has('MENTION'))) { remember(pr13); return act('navigate', { screen: 'profile', username: pr13.name }); }
  }
  return NONE;
}

// ───────────────────────────── public API ─────────────────────────────

export const SPLIT_RE = /\s+(?:and then|and|then|&|aprom|apram|apuram|appuram|aur phir|aur|phir|also|plus|matrum|mathum)\s+|\s*[,;]\s+/i;

// env: { context, person(lowerToken) -> 0|1|2, apps: [{ id, names: [displayNameLower, ...aliases] }] }
// returns one of:
//   { kind:'actions', actions:[{name,input}] }   — tool calls to run (same shape as the LLM path)
//   { kind:'reply',   message, navigate? }       — conversational answer, nothing to execute
//   { kind:'clarify', message }                  — understood the intent but an argument is missing
//   { kind:'none' }                              — not understood (caller should try the LLM / say so)
export function parseCommand(text, env = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return NONE;
  const cache = new Map();
  const wrapped = { ...env, person: env.person ? (w) => { if (!cache.has(w)) cache.set(w, env.person(w)); return cache.get(w); } : undefined };

  const whole = parseSegment(raw, wrapped, { lastPerson: null, index: 0 });
  const literal = /[\p{L}\p{N}@]:(?!\/\/)/u.test(raw) || QUOTE_RE.test(raw);   // body text must never be split on "and"
  const parts = literal ? [raw] : raw.split(SPLIT_RE).map(s => s.trim()).filter(Boolean);

  // "open youtube and search AI tutorials" is ONE action, not two.
  if (whole.kind === 'actions' && whole.actions.length === 1 && whole.actions[0].name === 'open_app' && whole.actions[0].input.searchFor) return whole;
  if (parts.length > 1) {
    const state = { lastPerson: null, index: 0 };
    const actions = [];
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      state.index = i;
      const r = parseSegment(parts[i], wrapped, state);
      if (r.kind !== 'actions') { ok = false; break; }
      actions.push(...r.actions);
    }
    if (ok && actions.length > 1) return { kind: 'actions', actions };
  }
  return whole;
}

export const __internals = { WORDS, tokenize, fuzzyConcepts, skeleton, prepare };
