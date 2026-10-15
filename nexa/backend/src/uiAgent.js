// Codex UI agent — lets Codex operate ANY button, tab, link, input or clickable card that is
// currently on screen, in any language, with typos.
//
// How it works (and why it is built this way):
//   • The frontend reads the live DOM at command time and sends a compact "control map"
//     (id, kind, label, nearby text, visible?, distance from screen centre, inside a dialog?).
//     Nothing is hand-registered per button, so new buttons work without code changes.
//   • This module turns the user's words into a pick from that map. It is deterministic and
//     offline: a multilingual concept lexicon + an emoji/icon map (many NEXA buttons are just
//     ♡ or 💬) + typo-tolerant matching + state awareness ("like" on an already-liked post).
//     A looser local fuzzy pass over the same control map handles phrasing
//     this vocabulary doesn't know; the code-enforced risk policy below applies to both paths.
//   • It never executes anything. It returns a decision; the browser performs the click.
//
// Honest limits: the offline matcher is vocabulary-based, not a language model. English,
// Tanglish and Hinglish are the strongest; the other listed languages cover the common
// interface words. Add a word to UI_LEX_SRC to teach it one — nothing else needs to change.

import { canon, editDistance, skeleton } from './nlu.js';

// ───────────────────────────── lexicon ─────────────────────────────
// concept -> words (Latin romanisations and native scripts). One word may serve several concepts.

const UI_LEX_SRC = {
  // Verbs that mean "operate this control" — ignored when ranking, used to detect explicit UI commands.
  CLICKV: `click clik klik clck clic press pres tap taps push hit select choose pick touch tick
    azhuthu azhutthu azhuthunga azhuthungal அழுத்து அழுத்துங்க அழுத்துங்கள் thattu thatu thattunga தட்டு தட்டுங்க thodu தொடு
    dabao daba dabana dabaye dabaiye dabado दबाओ दबा दबाएं दबाइए चुनो chuno chunna chuniye
    nokku nokkandi నొక్కు ottu ottiri ಒತ್ತು amarthuka അമർത്തുക chapo চাপো tipo
    pulsa pulsar presiona presionar cliquer clique appuie appuyer klicke klicken drücke druecke drucke
    اضغط انقر 押す クリック タップ 点击 点按 按 눌러 클릭 нажми нажать`,
  TYPEV: `type typing typo fill enter input ezhuthu ezhuthungal ezhuthuka ezhutha எழுது எழுதுங்க likho likh daalo dalo bharo लिखो भरो डालो rayi rayyi baredu bareyiri lekho লেখো escribe escribir écris ecris schreibe tippe اكتب 入力 输入 輸入 입력 введи`,
  SCROLL: `scroll scrol scrolll scrolling swipe slide scrool urutu உருட்டு scrol_pannu ghumao खिसकाओ स्क्रॉल desplaza desplazar défiler defiler scrollen rolar مرر スクロール 滚动 滾動 스크롤 прокрути`,
  DOWN: `down downward downwards below keezha keezhe kila kizhe கீழே கீழ neeche nicche नीचे kindi కింద ಕೆಳಗೆ താഴെ নিচে abajo bas runter unten baixo أسفل 下 아래 вниз`,
  UP: `up upward upwards above mela mele மேலே மேல ऊपर upar oopar పైకి ಮೇಲೆ മുകളിൽ উপরে arriba haut hoch cima أعلى 上 위 вверх`,
  TOP: `top beginning start shuru शुरू arriba inicio haut oben início 最初 顶部 맨위 наверх`,
  BOTTOM: `bottom aakhir आखिर ant अंत fondo bas unten fim 最後 底部 맨아래 вниз_конец`,

  // Content concepts
  LIKE: `like likes liked love loved heart hearts fav favorite favourite thumbsup laik lyk lik
    pidichiruku pidichirukku pidichurukku virupam virumbu விருப்பம் லைக் பிடிச்சிருக்கு
    pasand pasandh पसंद पसन्द लाइक ishtam ishta ఇష్టం ಇಷ್ಟ ഇഷ್ടം pochondo পছন্দ
    gusta gustar megusta aimer jaime gefaellt gefällt curtir اعجاب إعجاب いいね 点赞 赞 좋아요 нравится лайк`,
  DISLIKE: `dislike dislikes disliked`,
  COMMENT: `comment comments cmt cmnt komment karuthu karuthukal கருத்து கமெண்ட் tippani tippanee टिप्पणी कमेंट vyakhya వ్యాఖ్య abhiprayam అభిప్రాయం ಕಾಮೆಂಟ್ കമന്റ് mantobyo মন্তব্য comentar comentario commenter commentaire kommentar kommentieren comentário تعليق コメント 评论 評論 댓글 комментарий коммент`,
  REPLY: `reply replies respond answer badhil patil பதில் jawab jawaab जवाब ఉత్తరం ಉತ್ತರ മറുപടി responder repondre antworten رد 返信 回复 답장 ответить`,
  SHARE: `share sharing shr forward pagir pagirvu பகிர் பகிர்வு ஷேர் saajha sajha shaer साझा शेयर panchu పంచు ಹಂಚು പങ്കിടുക compartir compartilhar partager teilen condividi شارك مشاركة 共有 分享 공유 поделиться`,
  SAVE: `save saved saving bookmark bookmarks semi semikka semikkavum சேமி சேமிக்க சேவ் sahej sahejo sahejein सहेजें सेव dachu దాచు ulisu ಉಳಿಸು സേവ് songrokkhon সংরক্ষণ guardar guardado enregistrer sauvegarder speichern salvar حفظ 保存 收藏 저장 сохранить`,
  FOLLOW: `follow follows following follw folow foloow fllw subscribe pinthodar பின்தொடர் ஃபாலோ folo falo faalo फॉलो फ़ॉलो anusaran अनुसरण anusarinchu అనుసరించు ಅನುಸರಿಸು പിന്തുടരുക অনুসরণ seguir suivre folgen تابع متابعة フォロー 关注 關注 팔로우 подписаться`,
  MUTE: `mute muted mutes silence amaidhi அமைதி म्यूट मूक maun मौन silenciar couper stummschalten كتم ミュート 静音 음소거 отключить`,
  BLOCK: `block blocked blok bloc blck thadai தடை thadu தடு ब्लॉक nirodhinchu నిరోధించు bloquear bloquer blockieren bloqueie حظر ブロック 차단 屏蔽 拉黑 заблокировать`,
  RESTRICT: `restrict restricted restriction limit kattuppadu கட்டுப்பாடு pratibandh प्रतिबंध restringir restreindre einschränken تقييد 制限 限制 제한 ограничить`,
  REPORT: `report reports reporting flag complain complaint pugar புகார் shikayat शिकायत रिपोर्ट ఫిర్యాదు ದೂರು പരാതി অভিযোগ denunciar signaler melden بلاغ الإبلاغ 通報 举报 신고 пожаловаться жалоба`,
  DELETE: `delete deleted del dlt erase trash destroy remove removed remve rmv azhi azhikka அழி அழிக்க neekku neeku நீக்கு hatao hata hatana हटाओ हटाएं mitao मिटाओ tholagimpu తొలగించు ಅಳಿಸು ഇല്ലാതാക്കുക muchhe মুছে eliminar borrar supprimer effacer löschen excluir apagar حذف 削除 删除 刪除 삭제 удалить`,
  EDIT: `edit edits editing modify edt thiruthu thirutthu திருத்து திருத்த badlo badal बदलो बदल संपादित सुधारो marchu మార్చు ఎడిట్ ಎಡಿಟ್ എഡിറ്റ് সম্পাদনা editar modificar modifier éditer bearbeiten تعديل 編集 编辑 編輯 수정 편집 изменить редактировать`,
  REPLACE: `replace swap maattru maatru மாற்று badlo reemplazar remplacer ersetzen substituir استبدال 置換 替换 교체 заменить`,
  SEND: `send sent snd anuppu anupu anuppunga அனுப்பு bhejo bhej भेजो भेज pampu పంపు kalisu ಕಳುಹಿಸು ayakku അയക്കുക pathao পাঠাও enviar envoyer senden invia gönder ارسل أرسل 送信 发送 發送 보내 отправить`,
  SUBMIT: `submit`,
  POST: `post posts publish publishing pathivu பதிவு पोस्ट prakashit publicar publier veröffentlichen نشر 投稿 发布 發佈 게시 опубликовать`,
  STORY: `story stories stry kathai கதை kahani कहानी కథ ಕಥೆ കഥ গল্প historia histoire geschichte história قصة ストーリー 故事 스토리 история`,
  NOTE: `note notes nots kurippu குறிப்பு नोट నోట్ ನೋಟ್ നോട്ട് নোট nota notiz ملاحظة ノート 笔记 노트 заметка`,
  CANCEL: `cancel cancl discard dismiss nevermind radhu ratthu raddhu ரத்து रद्द రద్దు ರದ್ದು റദ്ദാക്കുക বাতিল cancelar annuler abbrechen إلغاء キャンセル 取消 취소 отмена отменить`,
  CLOSE: `close closes cls shut exit moodu mooduga மூடு band बंद moosiveyi మూసివేయి muchchu ಮುಚ್ಚು അടയ്ക്കുക bondho বন্ধ cerrar fermer schließen schliessen fechar إغلاق اغلق 閉じる 关闭 關閉 닫기 закрыть`,
  BACK: `back return goback wapas vapas वापस peeche पीछे pinnadi பின்னால் திரும்பு thirumbi thirumbu venakku వెనుకకు hindhe ಹಿಂದೆ volver atras atrás retour retourner zurück zuruck voltar رجوع عودة 戻る 返回 뒤로 назад`,
  NEXT: `next nxt agla agle अगला अगले aduthu adutha அடுத்து tarvata తర్వాత ಮುಂದಿನ അടുത്ത পরবর্তী siguiente suivant weiter próximo التالي 次 下一个 다음 следующий дальше`,
  PREV: `previous prev pichala पिछला pichhla munthaiya முந்தைய anterior précédent vorherige السابق 前の 上一个 이전 предыдущий`,
  DONE: `done ok okay okey confirm yes yep yeah sure apply continue finish sari சரி seri aam ஆம் aamam haan han हाँ theek thik ठीक sare సరే avunu అవును ಸರಿ houdu ಹೌದು shari ശരി athe അതെ ঠিক hya হ্যাঁ si oui ja sim نعم はい 确认 确定 是 예 확인 да подтвердить`,
  ACCEPT: `accept approve allow ettru yettru ஏற்று sweekar स्वीकार manzoor angikarinchu aceptar accepter akzeptieren aceitar قبول 承認 接受 수락 принять`,
  DECLINE: `decline reject deny refuse marupu மறுப்பு inkar इनकार asweekar tiraskarinchu rechazar refuser ablehnen recusar رفض 拒否 拒绝 거절 отклонить`,
  SEARCH: `search find lookup seek explore thedu thedungal தேடு தேடல் khoj khojo खोज खोजो dhundo ढूंढो vetuku వెతుకు hudaku ಹುಡುಕು തിരയുക খুঁজুন buscar rechercher chercher suchen procurar بحث ابحث 検索 搜索 搜尋 검색 поиск искать`,
  SETTINGS: `settings setting seting sethting preferences prefs config configuration amaippugal amaippu அமைப்புகள் அமைப்பு सेटिंग सेटिंग्स సెట్టింగ్‌లు ಸೆಟ್ಟಿಂಗ್ಸ್ ക്രമീകരണങ്ങൾ সেটিংস ajustes configuración paramètres réglages einstellungen configurações إعدادات 設定 设置 設置 설정 настройки`,
  LOGOUT: `logout logoff signout veliyeru velieru வெளியேறு लॉगआउट salir déconnexion abmelden sair تسجيل_الخروج ログアウト 退出 登出 로그아웃`,
  LOGIN: `login signin logon ullnuzhai உள்நுழை लॉगिन ಲಾಗಿನ್ iniciar entrar connexion anmelden تسجيل_الدخول ログイン 登录 로그인 войти`,
  SIGNUP: `signup register padhivu पंजीकरण रजिस्टर registrar inscrire registrieren التسجيل 登録 注册 가입 регистрация`,
  PROFILE: `profile prof profil profilo suyavivaram சுயவிவரம் प्रोफाइल प्रोफ़ाइल ప్రొఫైల్ ಪ್ರೊಫೈಲ್ പ്രൊഫൈൽ প্রোফাইল perfil ملف プロフィール 个人资料 프로필 профиль`,
  HOME: `home homepage mugappu mukappu முகப்பு होम घर ghar inicio accueil startseite início الرئيسية ホーム 首页 홈 главная`,
  REELS: `reels reel rils reelz ரீல்ஸ் रील्स రీల్స్ ರೀಲ್ಸ್ റീൽസ് রিলস`,
  MESSAGES: `messages message msg msgs chat chats inbox dm dms mesage messge sandesh संदेश मैसेज seithi செய்தி செய்திகள் மெசேஜ் సందేశం ಸಂದೇಶ സന്ദേശം বার্তা mensajes mensaje nachrichten mensagens رسائل メッセージ 消息 訊息 메시지 сообщения`,
  NOTIF: `notifications notification notifs notif alerts alert bell arivippu அறிவிப்பு அறிவிப்புகள் सूचना नोटिफिकेशन ప్రకటన ಅಧಿಸೂಚನೆ അറിയിപ്പ് বিজ্ঞপ্তি notificaciones benachrichtigungen notificações إشعارات 通知 알림 уведомления`,
  GAMES: `games game gaming gamestore vilaiyattu விளையாட்டு khel खेल गेम ఆట ಆಟ കളി খেলা juegos jeux spiele jogos ألعاب ゲーム 游戏 게임 игры`,
  CALL: `call calls ring phone dial calling kall azhai azhaippu அழை அழைப்பு कॉल फोन కాల్ ఫోన్ ಕರೆ കോൾ কল llamar llamada appeler anrufen ligar مكالمة اتصال 電話 通話 电话 통화 звонок позвонить`,
  VOICE: `voice audio kural குரல் awaaz आवाज़ आवाज voz voix stimme`,
  VIDEO: `video vid vdo vedio videos வீடியோ वीडियो వీడియో ವೀಡಿಯೋ വീഡിയോ ভিডিও vídeo vidéo 動画 视频 視頻 비디오 видео`,
  END: `end hangup terminate mudi mudikka முடி khatam ख़त्म samapth colgar terminer raccrocher beenden desligar إنهاء 終了 结束 종료 завершить`,
  CAMERA: `camera cam kamera கேமரா காமிரா कैमरा కెమెరా ಕ್ಯಾಮೆರಾ ക്യാമറ ক্যামেরা cámara caméra câmera كاميرا カメラ 相机 相機 카메라 камера`,
  PHOTO: `photo photos image images pic pics picture pictures gallery gallary galery album library device pugaippadam புகைப்படம் படம் padam फोटो तस्वीर ఫోటో foto imagen bild bilder صورة 写真 照片 사진 фото`,
  UPLOAD: `upload uploading browse attach pathivetru பதிவேற்று अपलोड అప్‌లోడ్ ಅಪ್ಲೋಡ್ അപ്‌ലോഡ് subir cargar télécharger hochladen carregar رفع تحميل アップロード 上传 上傳 업로드 загрузить`,
  NEW: `add new create make compose plus puthu pudhu புதிய serkka சேர் சேர்க்க jodo जोड़ो nayi नया banao बनाओ kotta కొత్త hosa ಹೊಸ പുതിയ নতুন añadir agregar nuevo crear ajouter nouveau créer hinzufügen neu erstellen adicionar novo criar إضافة جديد 追加 新規 新建 添加 추가 새 добавить новый создать`,
  DARK: `dark night black moon irul இருள் iruttu இருட்டு andhera अंधेरा डार्क oscuro sombre dunkel escuro داكن مظلم ダーク 暗 深色 다크 тёмная темная`,
  LIGHTMODE: `light bright day sun white velicham வெளிச்சம் ஒளி ujala उजाला roshni रोशनी लाइट claro clair hell فاتح ライト 亮 浅色 라이트 светлая`,
  PLAY: `play resume ply odu ஓடு vilaiyadu chalao चलाओ bajao बजाओ प्ले reproducir lire jouer spielen reproduzir تشغيل 再生 播放 재생 играть воспроизвести`,
  PAUSE: `pause pauz niruthu nirutthu நிறுத்து roko रोको ruko रुको पॉज़ pausar pausieren 一時停止 暂停 일시정지 пауза`,
  SOUND: `sound volume sabdham சத்தம் sonido son ton صوت 音 声音 소리 звук`,
  MIC: `mic microphone mike micro micrófono mikrofon مايك ميكروفون マイク 麦克风 마이크 микрофон`,
  ROTATE: `rotate rotation spin suzhatru சுழற்று ghumao घुमाओ rotar tourner drehen girar تدوير 回転 旋转 회전 повернуть`,
  FLIP: `flip mirror espejo spiegeln 反転 翻转 뒤집기 отразить`,
  CROP: `crop vettu வெட்டு kato काटो क्रॉप recortar rogner zuschneiden قص トリミング 裁剪 자르기 обрезать`,
  TRIM: `trim cut clip`,
  FILTER: `filter filters effect effects color colour vadigattu வடிகட்டி फ़िल्टर filtro filtre فلتر フィルター 滤镜 필터 фильтр`,
  SPEED: `speed fast slow vegam வேகம் tez तेज़ स्पीड gati velocidad vitesse geschwindigkeit velocidade سرعة 速度 속도 скорость`,
  TEXT: `text texto texte نص テキスト 文字 文本 텍스트 текст`,
  DRAW: `draw drawing pen brush paint sketch varai வரை dibujar dessiner zeichnen desenhar رسم 描く 绘制 그리기 рисовать`,
  RESET: `reset resets restore default meetamai மீட்டமை रीसेट restablecer réinitialiser zurücksetzen redefinir إعادة_تعيين リセット 重置 초기화 сбросить`,
  RETRY: `retry again refresh reload marubadiyum மறுபடியும் meendum மீண்டும் dobara दोबारा रीट्राई reintentar réessayer wiederholen 再試行 重试 다시시도 повторить`,
  JOIN: `join joinn shamil शामिल जॉइन cheru చేరు seru ಸೇರು ചേരുക unirse rejoindre beitreten participar انضم 参加 加入 참가 присоединиться`,
  INVITE: `invite invites aamantran आमंत्रण nimantran ఆహ్వానించు invitar inviter einladen convidar دعوة 招待 邀请 초대 пригласить`,
  LEAVE: `leave quit forfeit resign vilagu விலகு chhodo छोड़ो quitter verlassen مغادرة 離れる 离开 나가기 покинуть`,
  TOURNAMENT: `tournament tournaments tourney bracket pottigal போட்டி pratiyogita प्रतियोगिता टूर्नामेंट torneo tournoi turnier torneio بطولة トーナメント 锦标赛 比赛 토너먼트 турнир`,
  DISCOVER: `discover explore browse descubrir découvrir entdecken descobrir اكتشف 発見 发现 探索 탐색 обзор`,
  FRIENDS: `friends friend buddies nanbargal நண்பர்கள் dost दोस्त mitrulu స్నేహితులు ಸ್ನೇಹಿತರು സുഹൃത്തുക്കൾ বন্ধু amigos amis freunde أصدقاء 友達 朋友 친구 друзья`,
  FORYOU: `foryou`,
  HISTORY: `history log activity varalaru வரலாறு itihas इतिहास historial historique verlauf histórico سجل 履歴 历史 기록 история`,
  PIN: `pin pinned pinning`,
  HIDE: `hide hidden hiding marai மறை chhupao छुपाओ chupa ocultar masquer verbergen إخفاء 隠す 隐藏 숨기기 скрыть`,
  REACT: `react reaction reactions emoji`,
  NICKNAME: `nickname nick nicknames alias chellapeyar செல்லப்பெயர் upnaam उपनाम निकनेम apodo surnom spitzname apelido لقب ニックネーム 昵称 별명 прозвище`,
  ORD_FIRST: `first 1st pehla pehli mudhal mudhalavathu முதல் முதலாவது primero premier erste primeiro 最初の 第一 첫번째 первый`,
  ORD_SECOND: `second 2nd dusra doosra rendavathu இரண்டாவது segundo deuxième zweite 第二 두번째 второй`,
  ORD_THIRD: `third 3rd teesra moondravathu மூன்றாவது tercero troisième dritte 第三 세번째 третий`,
  ORD_LAST: `last latest final kadaisi kadaisiya கடைசி aakhri आखिरी último dernier letzte 最後の 最后 마지막 последний`,

  // Words that never identify a control. (Language particles, politeness, UI-kind words.)
  NOISE: `off turn mode theme venam vendam vena venda வேண்டாம் mat nahi nahin stop undo please pls plz kindly the a an of on in at to for with and or my me mine this that these those it its one is are be will want need wanna would could can you u ur your i im lets let just now here there so button buttons btn icon option options tab tabs link links field box bar page screen thing s
    pannu panni pannunga pannungal pannidu pannitu pannuga seyyu seyyi seiyyu seiyungal ku kku kuu la laa lae le ah ae nu nga irukkura irukura iruku irukkum ulla ullathu athu idhu ithu intha antha enakku nee neenga enna yenna konjam romba ippo ippa sollu sollunga
    karo kar kijiye kijie kare dijiye do de dena ko ka ki ke se mein me par pe ek ye yeh wo woh mera meri mujhe hai hain zara jara
    cheyyi cheyyandi cheyyu ni lo lone ee aa naaku madu madi maadu alli ge cheyyuka il koro korun te
    por favor el la los las un una de en con le les des du pour bitte der die das den dem ein eine
    பண்ணு பண்ணுங்க செய் செய்யுங்கள் செய்யவும் பட்டன் कीजिए करो कर को का की के में पर से ये यह वो बटन ボタン 按钮 按鈕 버튼 кнопка`,
};

// Icon/emoji → concepts (the app uses many icon-only buttons).
const SYMBOLS = {
  '♥': ['LIKE'], '♡': ['LIKE'], '❤': ['LIKE'], '🤍': ['LIKE'], '💜': ['LIKE'], '👍': ['LIKE'],
  '💬': ['COMMENT', 'MESSAGES'], '🗨': ['COMMENT', 'MESSAGES'],
  '🔖': ['SAVE'], '🏷': ['SAVE'],
  '↗': ['SHARE'], '➦': ['SHARE'], '📤': ['SHARE'], '⤴': ['SHARE'], '🔗': ['SHARE'],
  '➤': ['SEND'], '➢': ['SEND'], '✉': ['SEND', 'MESSAGES'], '📨': ['SEND'],
  '✕': ['CLOSE', 'CANCEL'], '✖': ['CLOSE', 'CANCEL'], '✗': ['CLOSE'], '×': ['CLOSE'], '❌': ['CLOSE', 'DELETE'],
  '←': ['BACK'], '⬅': ['BACK'], '‹': ['BACK', 'PREV'], '◀': ['BACK', 'PREV'],
  '→': ['NEXT'], '➡': ['NEXT'], '›': ['NEXT'],
  '⚙': ['SETTINGS'], '⏻': ['LOGOUT'], '🏠': ['HOME'], '🔍': ['SEARCH'], '🔎': ['SEARCH'],
  '🎬': ['REELS'], '🔔': ['NOTIF'], '🎮': ['GAMES'], '👤': ['PROFILE'],
  '✏': ['EDIT'], '🖊': ['EDIT'], '🗑': ['DELETE'],
  '📜': ['HISTORY'], '📷': ['CAMERA'], '📸': ['CAMERA'], '🖼': ['PHOTO'],
  '🌙': ['DARK'], '☀': ['LIGHTMODE'], '⟳': ['ROTATE'], '⟲': ['ROTATE'], '↻': ['ROTATE', 'RETRY'], '↺': ['ROTATE'], '🔄': ['ROTATE', 'RETRY'],
  '+': ['NEW'], '➕': ['NEW'], '✓': ['DONE'], '✔': ['DONE'], '✅': ['DONE'],
  '🎙': ['MIC'], '🎤': ['MIC'], '🔊': ['SOUND'], '🔈': ['SOUND'], '🔉': ['SOUND'], '🔇': ['MUTE', 'SOUND'],
  '📞': ['CALL', 'VOICE'], '☎': ['CALL', 'VOICE'], '📱': ['CALL'], '🎥': ['VIDEO', 'CALL'], '📹': ['VIDEO', 'CALL'],
  '▶': ['PLAY'], '⏸': ['PAUSE'],
};
// For icon-only labels (no letters), which state does the icon show? 'on' = already active,
// so clicking it would undo. Words in the label ("Saved", "Following") override this.
const SYMBOL_STATE = { '♥': 'on', '♡': 'off', '🔖': 'on', '🏷': 'off' };

const STATEFUL = new Set(['LIKE', 'SAVE', 'FOLLOW', 'MUTE', 'BLOCK', 'RESTRICT', 'PIN', 'HIDE']);
const ON_WORDS = new Set(['liked', 'saved', 'following', 'muted', 'blocked', 'restricted', 'pinned', 'hidden']);
const UNDO_WORDS = new Set(['undo', 'stop', 'cancel', 'venam', 'vendam', 'vena', 'venda', 'வேண்டாம்', 'mat', 'nahi', 'nahin', 'band', 'बंद', 'नहीं', 'remove', 'unlike', 'dislike']);
const NOISE_CONCEPTS = new Set(['NOISE', 'CLICKV', 'TYPEV', 'SCROLL', 'DOWN', 'UP', 'TOP', 'BOTTOM', 'ORD_FIRST', 'ORD_SECOND', 'ORD_THIRD', 'ORD_LAST']);
// Words that usually name WHERE a control is or WHAT it belongs to ("settings", "this post",
// "that reel"). When the user also said what to press, a control that doesn't mention them isn't penalised.
const SOFT_CONCEPTS = new Set(['SETTINGS', 'PROFILE', 'HOME', 'REELS', 'MESSAGES', 'NOTIF', 'GAMES', 'POST', 'STORY', 'NOTE', 'VIDEO', 'PHOTO']);
const NO_FUZZY = new Set([...NOISE_CONCEPTS, 'DONE', 'SUBMIT', 'TEXT', 'NEW', 'END']);

// ───────────────────────────── tokenizer ─────────────────────────────

const TOKEN_RE = /[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}'"“”‘’.,:;!?()[\]{}<>/\\|_\-–—*#@~`^=%$]/gu;

function normalizeText(text) {
  let t = String(text ?? '').normalize('NFKC').replace(/[\uFE0E\uFE0F\u200D\u200B]/g, '').toLowerCase();
  t = t.replace(/\blog\s*out\b|\bsign\s*out\b|\blog\s*off\b/g, 'logout')
    .replace(/\blog\s*in\b|\bsign\s*in\b/g, 'login')
    .replace(/\bsign\s*up\b/g, 'signup')
    .replace(/\bgo\s*back\b/g, 'goback')
    .replace(/\bfor\s*you\b/g, 'foryou')
    .replace(/\bgame\s*store\b/g, 'gamestore')
    .replace(/\bset\s*up\b/g, 'setup')
    .replace(/\bhang\s*up\b/g, 'hangup')
    .replace(/\bthumbs?\s*up\b/g, 'thumbsup');
  return t;
}

const sortedLetters = (w) => [...w].sort().join('');
const collapseRepeats = (w) => w.replace(/(.)\1+/gu, '$1');

// Is `a` (what the user typed) close enough to `b` (a known word) to be a typo of it?
// Deliberately conservative so everyday words don't become button presses:
//   • a swap of two letters ("commnet") is always fine;
//   • a different letter is only fine in words of 6+ letters ("live" must not become "like");
//   • a missing/extra letter needs a 6+ letter shorter word ("shave" must not become "save",
//     "replay" must not become "reply") — double-letter slips are handled separately by collapseRepeats;
//   • two edits only in words of 8+ letters.
function closeEnough(a, b) {
  const d = editDistance(a, b);
  if (d === 0) return true;
  if (d === 1) {
    if (a.length === b.length) return sortedLetters(a) === sortedLetters(b) || a.length >= 6;
    return Math.min(a.length, b.length) >= 6;
  }
  return d === 2 && Math.min(a.length, b.length) >= 8;
}

const COLLAPSED = new Map(); // "mesage" -> concepts of "message", "likee" -> "like"

const UI_WORDS = new Map();
const FUZZY_POOL = [];
const CJK_WORDS = [];
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]/u;

for (const [concept, src] of Object.entries(UI_LEX_SRC)) {
  for (const raw of src.split(/\s+/).filter(Boolean)) {
    const k = canon(raw);
    if (!UI_WORDS.has(k)) UI_WORDS.set(k, new Set());
    UI_WORDS.get(k).add(concept);
  }
}
for (const [w, concepts] of UI_WORDS) {
  if (CJK_RE.test(w)) CJK_WORDS.push(w);
  const fuzzable = [...concepts].filter(c => !NO_FUZZY.has(c));
  if (fuzzable.length && /^[a-z]+$/.test(w) && w.length >= 4) {
    FUZZY_POOL.push({ word: w, concepts: new Set(fuzzable) });
    const cw = collapseRepeats(w);
    if (!COLLAPSED.has(cw)) COLLAPSED.set(cw, new Set());
    fuzzable.forEach(c => COLLAPSED.get(cw).add(c));
  }
}
CJK_WORDS.sort((a, b) => b.length - a.length);


function fuzzyConcepts(key) {
  if (key.length < 4 || !/^[a-z]+$/.test(key)) return null;
  const c = COLLAPSED.get(collapseRepeats(key));
  if (c) return new Set(c);
  let best = null, bestD = 99;
  for (const { word, concepts } of FUZZY_POOL) {
    if (Math.abs(word.length - key.length) > 2) continue;
    if (word[0] !== key[0]) continue;
    const skelEq = key.length >= 7 && word.length >= 7 && skeleton(key) === skeleton(word);  // long romanised words only ("pidichiruku"/"pidichirukku")
    if (!skelEq && !closeEnough(key, word)) continue;
    const d = skelEq ? 1 : editDistance(key, word);
    if (d < bestD) { bestD = d; best = new Set(concepts); }
    else if (d === bestD) concepts.forEach(c2 => best.add(c2));
  }
  return best;
}

function cjkSplit(piece) {
  const out = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  while (i < piece.length) {
    const hit = CJK_RE.test(piece[i]) ? CJK_WORDS.find(w => piece.startsWith(w, i)) : null;
    if (hit) { flush(); out.push(hit); i += hit.length; } else { buf += piece[i]; i++; }
  }
  flush();
  return out;
}

// → [{ w, concepts:Set, undo:boolean, symbol:boolean, noise:boolean }]
export function tokenizeUi(text) {
  const t = normalizeText(text);
  const out = [];
  for (const m of t.matchAll(TOKEN_RE)) {
    let pieces = [m[0]];
    if (CJK_RE.test(m[0])) pieces = cjkSplit(m[0]);
    for (const piece of pieces) {
      const w = canon(piece);
      const tok = { w, concepts: new Set(), undo: false, symbol: false, noise: false };
      if (SYMBOLS[w]) { tok.symbol = true; SYMBOLS[w].forEach(c => tok.concepts.add(c)); }
      else if (UI_WORDS.has(w)) UI_WORDS.get(w).forEach(c => tok.concepts.add(c));
      else {
        const un = w.match(/^(un|dis)(.{3,})$/);
        if (un && UI_WORDS.has(un[2]) && [...UI_WORDS.get(un[2])].some(c => STATEFUL.has(c))) {
          UI_WORDS.get(un[2]).forEach(c => tok.concepts.add(c));
          tok.undo = true;
        } else {
          const fz = fuzzyConcepts(w);
          if (fz) fz.forEach(c => tok.concepts.add(c));
        }
      }
      if (tok.concepts.has('DISLIKE')) { tok.concepts.delete('DISLIKE'); tok.concepts.add('LIKE'); tok.undo = true; }
      if (UNDO_WORDS.has(w)) tok.undo = true;
      tok.noise = [...tok.concepts].length > 0 && [...tok.concepts].every(c => NOISE_CONCEPTS.has(c));
      if (!tok.concepts.size && w.length === 1 && /^[\p{L}]$/u.test(w) && !CJK_RE.test(w)) tok.noise = true; // stray single letters
      if (/^\d+$/.test(w)) tok.noise = true; // counts like "♡ 12"
      if (!tok.concepts.size && !/[\p{L}\p{N}]/u.test(w) && !/\p{Extended_Pictographic}/u.test(w)) tok.noise = true; // stray "&", "✦" ...
      out.push(tok);
    }
  }
  return out;
}

const contentTokens = (toks) => toks.filter(t => !t.noise);
const hasConcept = (toks, c) => toks.some(t => t.concepts.has(c));

// ───────────────────────────── risk policy ─────────────────────────────
// Enforced in code for every path (offline matcher AND the LLM). A prompt-injected control
// label can never talk Codex into pressing these.

const BLOCKED_RE = /deactivat|delete\s+(my\s+)?account|account\s+deletion|(disable|turn\s*off|setup|set\s*up|enable)\s+(2fa|two[- ]?factor)|\b2fa\b|two[- ]?factor|authenticator|confirm\s*&\s*enable|change\s+password|\bpassword\b|payment|purchase|checkout|buy\s+now/i;
const CONFIRM_RE = /delete|remove|block(?!ed)|report|discard|clear|end\s*call|log\s*out|logout|sign\s*out|leave|decline|forget|reset|forfeit|hang\s*up/i;

export function riskOf(control) {
  if (control.kind === 'heading') return { level: 'safe' }; // scrolling to a section presses nothing
  const text = control.label || '';
  if (control.type === 'password') return { level: 'blocked', reason: "I never type into or press password controls — please do that one yourself." };
  if (control.type === 'file' || control.kind === 'file') return { level: 'blocked', reason: "Browsers don't let me open the file picker for you — tap the upload/choose button yourself, then I can carry on." };
  if (BLOCKED_RE.test(text)) return { level: 'blocked', reason: `“${control.label}” is a security/account control, so I won't press it for you. I can open the page, but please tap it yourself.` };
  if (CONFIRM_RE.test(text)) return { level: 'confirm', reason: `“${control.label}” can't be undone easily.` };
  return { level: 'safe' };
}

// ───────────────────────────── control map ─────────────────────────────

const KINDS = new Set(['button', 'link', 'tab', 'input', 'select', 'checkbox', 'file', 'click', 'heading']);
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// The browser is untrusted input here: cap size, force types, never let a field through
// that the model could abuse.
export function sanitizeControls(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw.slice(0, 350)) {
    if (!c || (typeof c.id !== 'number' && typeof c.id !== 'string')) continue;
    const kind = KINDS.has(c.kind) ? c.kind : 'click';
    out.push({
      id: String(c.id).slice(0, 24),
      kind,
      type: str(c.type, 12).toLowerCase(),
      label: str(c.label, 80),
      ctx: str(c.ctx, 70),
      disabled: !!c.disabled,
      vis: c.vis !== false,
      d: Math.min(1, Math.max(0, Number.isFinite(Number(c.d)) ? Number(c.d) : 0.5)),
      modal: !!c.modal,
      checked: c.checked === true ? true : c.checked === false ? false : undefined,
      n: out.length, // position on the page (the browser sends controls in document order)
    });
  }
  return out;
}

// Per-control derived info: tokens, polarity (does clicking do the thing or undo it?), kind hint.
function prep(control) {
  if (PREP.has(control)) return PREP.get(control);
  const toks = tokenizeUi(control.label);
  const ctxToks = tokenizeUi(control.ctx).filter(t => !t.noise);
  const content = contentTokens(toks);
  const hasLetters = toks.some(t => !t.symbol && /\p{L}/u.test(t.w));
  let polarity = null;
  const stateful = new Set();
  // Only real toggles have an on/off state. A "Following" TAB or a link to "Muted accounts" is just a place to go.
  const toggleLike = ['button', 'click', 'checkbox'].includes(control.kind);
  if (toggleLike) for (const t of content) for (const c of t.concepts) if (STATEFUL.has(c)) stateful.add(c);
  if (stateful.size) {
    if (toks.some(t => t.undo) || toks.some(t => ON_WORDS.has(t.w))) polarity = 'undo';
    else if (hasLetters) polarity = 'do';
    else {
      const sym = toks.find(t => t.symbol && SYMBOL_STATE[t.w]);
      if (sym) polarity = SYMBOL_STATE[sym.w] === 'on' ? 'undo' : 'do';
    }
  }
  const info = { toks: content, ctxToks, polarity, stateful };
  PREP.set(control, info);
  return info;
}

function tokenMatch(q, c) {
  if (q.w === c.w) return 1;
  for (const k of q.concepts) if (!NOISE_CONCEPTS.has(k) && c.concepts.has(k)) return 0.9;
  if (q.w.length >= 4 && c.w.length >= 4 && /^[a-z]+$/.test(q.w) && /^[a-z]+$/.test(c.w)) {
    if (closeEnough(q.w, c.w)) return 0.75;
    if (collapseRepeats(q.w) === collapseRepeats(c.w)) return 0.75;
    if (q.w.length >= 7 && c.w.length >= 7 && skeleton(q.w) === skeleton(c.w)) return 0.7;
  }
  if (q.w.length >= 3 && c.w.length >= 3 && /^[a-z]+$/.test(q.w) && /^[a-z]+$/.test(c.w) && (c.w.startsWith(q.w) || q.w.startsWith(c.w))) return 0.5;
  return 0;
}

const PREP = new WeakMap();
const KIND_WORDS = { button: 'button', buttons: 'button', btn: 'button', tab: 'tab', tabs: 'tab', link: 'link', field: 'input', box: 'input', textbox: 'input', bar: 'input', input: 'input', dropdown: 'select', menu: 'select', checkbox: 'checkbox', toggle: 'checkbox', switch: 'checkbox' };

function scoreControl(qToks, control, qInfo) {
  const p = prep(control);
  if (!p.toks.length && !p.ctxToks.length) return null;
  const q = qToks;
  const isSoft = (t) => t.concepts.size > 0 && [...t.concepts].every(c => SOFT_CONCEPTS.has(c));
  const hasHard = q.some(t => !isSoft(t));
  let num = 0, den = 0;
  const matchedControlToks = new Set();
  const bestMatches = new Map();
  for (const t of q) {
    let best = 0, bestIdx = -1;
    p.toks.forEach((c, i) => { const m = tokenMatch(t, c); if (m > best) { best = m; bestIdx = i; } });
    if (best < 0.5 && p.ctxToks.length) {
      const cm = Math.max(...p.ctxToks.map(c => tokenMatch(t, c)));
      if (cm >= 0.75) best = 0.55; // matched by nearby text ("rahul's post")
    }
    // "settings dark button" means the Dark button: a place word this control doesn't mention is ignored.
    bestMatches.set(t, best);
    if (hasHard && isSoft(t) && best < 0.5) continue;
    if (bestIdx >= 0 && best >= 0.5) matchedControlToks.add(bestIdx);
    num += best; den += 1;
  }
  if (!den) return null;
  const labelScore = num / den;
  if (labelScore < 0.5) return { score: labelScore, base: labelScore };
  const precision = p.toks.length ? matchedControlToks.size / p.toks.length : 0.5;
  let base = labelScore * (0.8 + 0.2 * precision);
  // Extra query words that this control also matches ("video call" → 🎥 over 📞).
  base += Math.min(0.16, 0.08 * Math.max(0, [...q].filter(t => bestMatches.get(t) >= 0.5).length - 1));
  // What kind of thing did they ask for? "comment button" is not the comment box; "search box" is not the nav button.
  const isField = control.kind === 'input' || control.kind === 'select';
  if (qInfo.kind === 'input') base += isField ? 0.1 : -0.08;
  else if (qInfo.kind === 'button') base += isField || control.kind === 'heading' ? -0.1 : 0.04;
  else if (qInfo.kind) base += control.kind === qInfo.kind ? 0.06 : 0;
  else if (isField) base -= 0.08;
  if (control.disabled) base -= 0.4;
  return { score: base, base };
}

function focusBonus(control, anyModal) {
  let b = 0;
  if (control.vis) b += 0.06;
  b += (1 - control.d) * 0.06;
  if (anyModal) b += control.modal ? 0.15 : -0.2; // an open dialog owns the screen
  return b;
}

const ORD = { ORD_FIRST: 0, ORD_SECOND: 1, ORD_THIRD: 2, ORD_LAST: -1 };
// Two controls are "the same button" if they mean the same thing (♡ and ♥ are both Like),
// so one per post is a focus decision, not an ambiguity.
const labelKey = (c) => `${c.kind}|${prep(c).toks.map(t => (t.concepts.size ? [...t.concepts].sort().join('+') : t.w)).join(' ')}`;

// resolveControl — the heart of "press whatever I said".
//   status: 'ok'        → press result.control
//           'already'   → the control is already in the state the user asked for
//           'ambiguous' → several different controls fit; result.candidates lists them
//           'none'      → nothing on screen fits
export function resolveControl(query, rawControls, { hintId, kinds, minScore = 0.6 } = {}) {
  const controls = sanitizeControls(rawControls).filter(c => !kinds || kinds.includes(c.kind));
  if (!controls.length) return { status: 'none', message: 'I can\'t see any controls on this screen.' };

  // A caller may have already pointed at a control by id — honour it only if it truly exists on screen.
  if (hintId) {
    const hinted = controls.find(c => c.id === String(hintId));
    if (hinted) return { status: 'ok', control: hinted, score: 1, risk: riskOf(hinted), via: 'hint' };
  }

  const all = tokenizeUi(query);
  const ordTok = all.find(t => [...t.concepts].some(c => c in ORD));
  const ord = ordTok ? ORD[[...ordTok.concepts].find(c => c in ORD)] : null;
  const qKind = all.map(t => KIND_WORDS[t.w]).find(Boolean) || null;
  const qToks = contentTokens(all);
  if (!qToks.length) return { status: 'none', message: 'Which button do you mean?', needsTarget: true };

  const qUndo = all.some(t => t.undo);
  const anyModal = controls.some(c => c.modal && !c.disabled);
  const scored = [];
  for (const c of controls) {
    if (c.kind === 'heading') continue;
    const s = scoreControl(qToks, c, { kind: qKind });
    if (!s || s.base < minScore) continue;
    scored.push({ control: c, base: s.base, final: s.base + focusBonus(c, anyModal) });
  }
  if (!scored.length) return { status: 'none', message: `I couldn't find anything on this screen that matches “${query.trim().slice(0, 40)}”.` };
  scored.sort((a, b) => b.final - a.final);

  // Ordinals ("second like button", "last one"): pick by DOM order among equally good matches.
  if (ord !== null) {
    const topBase = scored[0].base;
    const peers = scored.filter(s => s.base >= topBase - 0.05).sort((a, b) => a.control.n - b.control.n);
    const pick = ord === -1 ? peers[peers.length - 1] : peers[ord];
    if (!pick) return { status: 'none', message: `There aren't ${ord + 1} matching controls here.` };
    return finish(pick, qToks, qUndo);
  }

  const top = scored[0];
  const rival = scored.slice(1).find(s => top.base - s.base < 0.07 && labelKey(s.control) !== labelKey(top.control));
  if (rival) {
    const seen = new Set();
    const candidates = [];
    for (const s of scored) {
      if (top.base - s.base >= 0.07) break;
      const key = labelKey(s.control);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ id: s.control.id, label: s.control.label || s.control.ctx, kind: s.control.kind });
      if (candidates.length === 4) break;
    }
    return { status: 'ambiguous', candidates, message: 'More than one button fits — which one?' };
  }
  return finish(top, qToks, qUndo);
}

function finish(pick, qToks, qUndo) {
  const c = pick.control;
  const p = prep(c);
  // State awareness: "like" on a post that is already liked must not un-like it.
  const queryStateful = new Set();
  for (const t of qToks) for (const k of t.concepts) if (STATEFUL.has(k)) queryStateful.add(k);
  const shared = [...queryStateful].filter(k => p.stateful.has(k));
  if (shared.length && p.polarity) {
    const want = qUndo ? 'undo' : 'do';
    if (want !== p.polarity) {
      const done = { LIKE: 'liked', SAVE: 'saved', FOLLOW: 'followed', MUTE: 'muted', BLOCK: 'blocked', RESTRICT: 'restricted', PIN: 'pinned', HIDE: 'hidden' }[shared[0]];
      return { status: 'already', control: c, message: want === 'do' ? `That's already ${done}.` : `That isn't ${done} right now.` };
    }
  }
  return { status: 'ok', control: c, score: pick.final, risk: riskOf(c) };
}

// Scroll targets: headings/sections ("privacy", "two-factor"), found among kind:'heading' controls.
export function resolveLandmark(query, rawControls) {
  const heads = sanitizeControls(rawControls).filter(c => c.kind === 'heading');
  const qToks = contentTokens(tokenizeUi(query));
  if (!heads.length || !qToks.length) return { status: 'none' };
  let best = null;
  for (const h of heads) {
    const s = scoreControl(qToks, h, {});
    if (s && s.base >= 0.6 && (!best || s.base > best.base)) best = { control: h, base: s.base };
  }
  return best ? { status: 'ok', control: best.control } : { status: 'none' };
}

// Text fields for ui_type: matches inputs by label/placeholder.
export function resolveField(query, rawControls) {
  const fields = sanitizeControls(rawControls).filter(c => ['input', 'select'].includes(c.kind) && c.type !== 'file');
  if (!fields.length) return { status: 'none', message: "I don't see a text box on this screen." };
  const qToks = contentTokens(tokenizeUi(query));
  if (!qToks.length) {
    const vis = fields.filter(f => f.vis && !f.disabled && f.type !== 'password').sort((a, b) => a.d - b.d);
    return vis.length ? { status: 'ok', control: vis[0], risk: riskOf(vis[0]) } : { status: 'none', message: "I don't see a text box on this screen." };
  }
  const r = resolveControl(query, fields, { minScore: 0.5 });
  if (r.status === 'ok') return r;
  if (r.status === 'ambiguous') return r;
  return { status: 'none', message: `I couldn't find a text box matching “${query.trim().slice(0, 40)}”.` };
}

// ───────────────────────────── explicit UI commands ─────────────────────────────

const QUOTE_RE = /["“”«»「」『』]([^"“”«»「」『』]+)["“”«»「」『』]/u;
const LOCATIVE = new Set(['in', 'into', 'on', 'inside', 'la', 'laa', 'lae', 'mein', 'me', 'lo', 'alli', 'il']);

// Drop the command verb(s) (click/press/type/dabao...) so the target is just what to operate.
function stripVerbs(phrase, concept) {
  return phrase.split(/\s+/).filter(w => !UI_WORDS.get(canon(w.replace(/[^\p{L}\p{M}\p{N}]/gu, '')))?.has(concept)).join(' ').replace(/\s+/g, ' ').trim();
}

// Returns { actions:[{name,input}] } or null when this segment isn't an explicit UI command.
export function parseUiCommand(segment) {
  const raw = String(segment ?? '').trim();
  if (!raw) return null;
  const all = tokenizeUi(raw);
  if (!all.length) return null;
  const nn = all.filter(t => !t.noise || [...t.concepts].some(c => ['CLICKV', 'TYPEV', 'SCROLL', 'DOWN', 'UP', 'TOP', 'BOTTOM'].includes(c)));
  const quote = raw.match(QUOTE_RE);
  const colonLiteral = /[\p{L}\p{N}]:(?!\/\/)\s*\S/u.test(raw);

  // go back
  if (hasConcept(all, 'BACK') && contentTokens(all).filter(t => !t.concepts.has('BACK')).length === 0 && all.length <= 4) {
    return { actions: [{ name: 'ui_back', input: {} }] };
  }

  // scroll
  const nextItem = (hasConcept(all, 'NEXT') || hasConcept(all, 'PREV')) && all.some(t => ['reel', 'reels', 'post', 'posts', 'video', 'story'].includes(t.w)) && contentTokens(all).length <= 3;
  if (hasConcept(all, 'SCROLL') || nextItem) {
    const dir = hasConcept(all, 'TOP') ? 'top' : hasConcept(all, 'BOTTOM') ? 'bottom' : hasConcept(all, 'UP') || hasConcept(all, 'PREV') ? 'up' : 'down';
    const rest = all.filter(t => !t.noise && ![...t.concepts].some(c => ['SCROLL', 'UP', 'DOWN', 'TOP', 'BOTTOM', 'NEXT', 'PREV'].includes(c)));
    const hasDir = ['TOP', 'BOTTOM', 'UP', 'DOWN'].some(c => hasConcept(all, c));
    if (hasConcept(all, 'SCROLL') && rest.length && !hasDir) {
      const target = rest.map(t => t.w).join(' ');
      return { actions: [{ name: 'ui_scroll', input: { target } }] };
    }
    return { actions: [{ name: 'ui_scroll', input: { direction: dir } }] };
  }

  // type text into a box
  if (hasConcept(all, 'TYPEV')) {
    const toks = [...raw.matchAll(/\S+/gu)].map(m => ({ s: m[0], i: m.index }));
    let text = null, target = '';
    if (quote) {
      text = quote[1].trim();
      target = stripVerbs((raw.slice(0, quote.index) + ' ' + raw.slice(quote.index + quote[0].length)).trim(), 'TYPEV');
    } else if (colonLiteral) {
      const m = raw.match(/^(.*?):\s*(.+)$/u);
      if (m) { target = m[1]; text = m[2].trim(); }
    } else {
      // "type hello in comment box" (verb first)  /  "comment box la hello type pannu" (verb last)
      const lowerToks = toks.map(t => canon(t.s.replace(/[^\p{L}\p{M}\p{N}]/gu, '')));
      const li = lowerToks.findIndex(w => LOCATIVE.has(w));
      const vi = lowerToks.findIndex(w => UI_WORDS.get(w)?.has('TYPEV'));
      if (li >= 0 && vi >= 0) {
        if (vi < li) { text = toks.slice(vi + 1, li).map(t => t.s).join(' '); target = toks.slice(li + 1).map(t => t.s).join(' '); }
        else { target = toks.slice(0, li).map(t => t.s).join(' '); text = toks.slice(li + 1, vi).map(t => t.s).join(' '); }
      }
    }
    if (text && text.length) {
      const submit = /\b(and\s+)?(send|submit|enter|post)\b\s*$/i.test(target) || false;
      return { actions: [{ name: 'ui_type', input: { target: target.replace(/\b(and\s+)?(send|submit|enter|post)\b\s*$/i, '').trim(), text, submit } }] };
    }
  }

  // explicit click verb at either edge of the command ("click like", "dark button click pannu")
  if (!quote && !colonLiteral) {
    const idxs = nn.map((t, i) => (t.concepts.has('CLICKV') ? i : -1)).filter(i => i >= 0);
    if (idxs.length && (idxs[0] === 0 || idxs[idxs.length - 1] === nn.length - 1)) {
      const target = stripVerbs(raw, 'CLICKV') || raw;
      if (contentTokens(all).length) return { actions: [{ name: 'ui_click', input: { target } }] };
      return { actions: [], clarify: 'Which button should I press?' };
    }
  }
  return null;
}

// Plans a command that may mix UI steps with ordinary Codex tools ("open settings and press dark").
// `parseCommand` is injected (the offline NLU) so this file has no circular import. Returns
// { actions } only when at least one UI step is present; otherwise null so the normal pipeline runs.
export function planMixed(text, { parseCommand, env, splitRe }) {
  const raw = String(text ?? '').trim();
  const literal = QUOTE_RE.test(raw) || /[\p{L}\p{N}@]:(?!\/\/)/u.test(raw);
  const parts = literal ? [raw] : raw.split(splitRe).map(s => s.trim()).filter(Boolean);
  const actions = [];
  let sawUi = false, clarify = null;
  for (const part of parts) {
    const ui = parseUiCommand(part);
    if (ui) {
      sawUi = true;
      if (ui.clarify) clarify = ui.clarify;
      actions.push(...ui.actions);
      continue;
    }
    const r = parseCommand(part, env);
    if (r.kind === 'actions') { actions.push(...r.actions); continue; }
    return null; // a segment nobody understands → let the normal pipeline answer for the whole text
  }
  if (!sawUi) return null;
  if (!actions.length && clarify) return { actions: [], clarify };
  return { actions };
}

// Compact one-line-per-control text for the LLM prompt. Labels are untrusted page text.
export function controlsForPrompt(rawControls, limit = 120) {
  const cs = sanitizeControls(rawControls);
  const ranked = [...cs].sort((a, b) => (b.modal - a.modal) || (b.vis - a.vis) || (a.d - b.d)).slice(0, limit);
  ranked.sort((a, b) => a.n - b.n);
  return ranked.map(c => `${c.id}|${c.kind}${c.type ? ':' + c.type : ''}|${JSON.stringify(c.label || '')}${c.ctx ? '|near:' + JSON.stringify(c.ctx) : ''}${c.disabled ? '|disabled' : ''}${c.modal ? '|dialog' : ''}${!c.vis ? '|offscreen' : ''}`).join('\n');
}

export const __uiInternals = { UI_WORDS, tokenizeUi, prep, tokenMatch, normalizeText };
