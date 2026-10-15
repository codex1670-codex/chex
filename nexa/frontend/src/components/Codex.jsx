import { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';
import { requestStartCall } from '../callBus.js';
import { getCodexContext } from '../codexContext.js';
import { applyTheme } from '../theme.js';
import { scanControls, pressControl, typeInto, scrollPage, scrollToControl, settle, sleep } from '../uiControls.js';

const MAX_STEPS = 8;

// ── Voice helpers ───────────────────────────────────────────────────────────────────────
// Script -> BCP-47 language, used to (a) remember which language the person actually spoke
// and (b) pick a matching voice for spoken replies. Latin text is ambiguous, so it returns null.
const SCRIPT_LANGS = [
  [/[\u0B80-\u0BFF]/, 'ta-IN'], [/[\u0900-\u097F]/, 'hi-IN'], [/[\u0C00-\u0C7F]/, 'te-IN'],
  [/[\u0C80-\u0CFF]/, 'kn-IN'], [/[\u0D00-\u0D7F]/, 'ml-IN'], [/[\u0980-\u09FF]/, 'bn-IN'],
  [/[\u0600-\u06FF]/, 'ar-SA'], [/[\u3040-\u30FF]/, 'ja-JP'], [/[\uAC00-\uD7AF]/, 'ko-KR'],
  [/[\u4E00-\u9FFF]/, 'zh-CN'], [/[\u0400-\u04FF]/, 'ru-RU'],
];
const detectScriptLang = (t) => { for (const [re, l] of SCRIPT_LANGS) if (re.test(t)) return l; return null; };

const MIC_ERRORS = {
  'not-allowed': 'Microphone is blocked. Allow mic access for this site (lock icon in the address bar → Microphone → Allow), then tap 🎙 again.',
  'service-not-allowed': 'Speech recognition is blocked by the browser/OS. Check your microphone and speech-service permissions.',
  'audio-capture': 'I can\'t find a working microphone. Plug one in or check your device settings.',
  'network': 'Speech recognition needs an internet connection (the browser sends audio to its speech service). Check your connection and try again.',
  'language-not-supported': 'This browser can\'t recognise that language. Pick another language in the dropdown.',
};   // a single command never runs more than this many actions

// Codex action registry for this vertical slice.
// Only these actions exist; every one calls the real backend and reports the real result.
// Anything outside this registry (games, media editing) is explicitly out of scope for
// this slice and Codex says so rather than pretending to do it.
const HELP = `I can help with things CHEX's backend actually supports right now:
• "message rahul: hey there" — send a message (or a message request if they haven't accepted you yet)
• "follow priya" / "unfollow priya"
• "mute priya" / "unmute priya" — hides their posts from your feed
• "block priya" / "unblock priya" — also removes any follow relationship (I'll ask you to confirm first)
• "restrict priya" / "unrestrict priya" — limits their comment visibility on your posts
• "post: had a great day today" — publishes a text post to your feed
• "send this to rahul" / "like this" / "save this" — acts on whichever Reel or Post is
  currently in view, no ID needed
• "go to priya's profile" / "open feed" / "open messages" / "open settings"
• "open my saved posts" / "open my saved reels" / "show my reels history"
• "open the game store" / "show my tournaments" / "show my games" — jumps to that Game Store tab
• "turn on dark mode" / "turn on light mode"
• "call rahul" / "video call rahul" — starts a real call if you already have a conversation with them
• "open spotify" / "open youtube and search AI tutorials" — opens the real web app in a new tab
• "save rahul as bestie" — a private nickname only you can see; once saved, the local
  Codex can use it anywhere you'd type a username (e.g. "message bestie", "who is bestie")
• "comment: nice one!" / "unlike this" / "unsave this" / "mark notifications read"
• "play chess with priya" / "join game ABC123"
• Anything on screen: "press the dark button" / "like button click pannu" / "open the Following tab" /
  "tap Accept" / "close this" / "type \"hello\" in the search box" / "scroll down" / "next reel" / "go back" —
  I read what's on your screen and press it for you, on any page. Security controls (passwords, 2FA,
  deactivate/delete account) I never press; things like Delete or Report I ask you to confirm first.
Codex understands typos, any word order and mixed languages (Tanglish, Hinglish, Telugu, Kannada,
Malayalam, Bengali, Spanish, French and more) even without an AI key — e.g. "msg", "message open
pannu", "game store open pannu", "reel", "rahul ku hi anupu", "hi to rahul", "bloc priya" all work.
Everything runs on NEXA's built-in local AI (no API key). It also handles free-form sentences in any language, and chains
steps ("follow him and send this reel").`;

async function runCommand(raw, { navigate, currentUser }) {
  const text = raw.trim();
  const lower = text.toLowerCase();

  // Section 2/10 — same-intent phrasing/spelling variants, including Tanglish particles
  // ("-ku", "anuppu"/"anupu", "pannu"). These normalize BEFORE the real patterns below run,
  // so "rahul ku hi anupu" and "hi to rahul" reach the exact same branch as "message rahul: hi".
  let normalized = text;
  let nm;
  // "<name>[-]ku <text> anupp/anupu(nu)" -> "message <name>: <text>"
  nm = normalized.match(/^@?([\w'.]+)\s*-?\s*ku[u]?\s+(.+?)\s+anupp?u(nu)?$/i);
  if (nm) normalized = `message ${nm[1]}: ${nm[2]}`;
  // "<text> to <name>" (not "this"/"it", which are handled as share_content below) -> "message <name>: <text>"
  if (normalized === text) {
    nm = normalized.match(/^(?:send\s+)?(.+?)\s+to\s+@?([\w'.]+)$/i);
    if (nm && !/^(this|that|it)$/i.test(nm[1].trim())) normalized = `message ${nm[2]}: ${nm[1]}`;
  }
  const nlower = normalized.toLowerCase().trim();
  // Command-only synonyms for opening a screen (not when the word appears inside a longer
  // sentence, so these only fire when the ENTIRE input is just the shorthand).
  if (/^(open\s+)?(msg|message|messages)(\s+open)?(\s+pannu)?$/.test(nlower)) {
    return { ok: true, text: 'Opening messages.', navigate: () => navigate('messages') };
  }
  if (/^(open\s+(the\s+)?)?(game|games|game\s*store)(\s+open)?(\s+pannu)?$/.test(nlower)) {
    return { ok: true, text: 'Opening the Game Store.', navigate: () => navigate('games') };
  }
  if (/^(open\s+)?(reel|reels)(\s+open)?(\s+pannu)?$/.test(nlower)) {
    return { ok: true, text: 'Opening Reels.', navigate: () => navigate('reels') };
  }

  const usingNormalized = normalized !== text;
  let m = normalized.toLowerCase().match(/^message\s+@?(\w[\w'.]*)[:,]?\s*(.*)$/) || (!usingNormalized && lower.match(/^(?:send|dm)\s+@?(\w+)\s+(.*)$/));
  if (m) {
    const [, username, rest] = m;
    // When we rewrote the input ourselves (Tanglish/"X to Y" normalization), rest is
    // already the exact clean message text — re-deriving it from the raw original string
    // would find the wrong substring, so only do that recovery for un-normalized input.
    const body = usingNormalized ? rest.trim() : (text.slice(text.toLowerCase().indexOf(rest)).trim() || rest);
    if (!body) return { ok: false, text: `What should I say to @${username}?` };
    if (username === currentUser?.username) return { ok: false, text: "You can't message yourself." };
    try {
      const res = await api.sendMessage({ toUsername: username, text: body });
      if (res.status === 'sent') return { ok: true, text: `Sent to @${username}.`, navigate: () => navigate('messages', username) };
      return { ok: true, text: res.message, navigate: () => navigate('messages', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't message @${username}: ${err.message}` };
    }
  }

  m = lower.match(/^(follow|unfollow)\s+@?(\w+)$/);
  if (m) {
    const [, action, username] = m;
    try {
      const res = action === 'follow' ? await api.follow(username) : await api.unfollow(username);
      return { ok: true, text: `${action === 'follow' ? 'Followed' : 'Unfollowed'} @${res.user.username}.`, navigate: () => navigate('profile', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't ${action} @${username}: ${err.message}` };
    }
  }

  m = lower.match(/^(mute|unmute)\s+@?(\w+)$/);
  if (m) {
    const [, action, username] = m;
    try {
      await (action === 'mute' ? api.mute(username) : api.unmute(username));
      return { ok: true, text: `${action === 'mute' ? 'Muted' : 'Unmuted'} @${username}.`, navigate: () => navigate('profile', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't ${action} @${username}: ${err.message}` };
    }
  }

  m = lower.match(/^(block|unblock)\s+@?(\w+)$/);
  if (m) {
    const [, action, username] = m;
    if (action === 'block' && !window.confirm(`Block @${username}? They won't be able to follow, message, or see your content.`)) {
      return { ok: true, text: 'Cancelled.' };
    }
    try {
      await (action === 'block' ? api.block(username) : api.unblock(username));
      return { ok: true, text: `${action === 'block' ? 'Blocked' : 'Unblocked'} @${username}.`, navigate: () => navigate('profile', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't ${action} @${username}: ${err.message}` };
    }
  }

  m = lower.match(/^(restrict|unrestrict)\s+@?(\w+)$/);
  if (m) {
    const [, action, username] = m;
    try {
      await (action === 'restrict' ? api.restrict(username) : api.unrestrict(username));
      return { ok: true, text: `${action === 'restrict' ? 'Restricted' : 'Unrestricted'} @${username}.`, navigate: () => navigate('profile', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't ${action} @${username}: ${err.message}` };
    }
  }

  // Section 3 — save a private nickname. Offline mode only accepts a real username here
  // (resolving "forget bestie" or "who is bestie" back to a person needs the AI-backed
  // /codex/act path, since that lookup lives in the nickname resolver on the backend).
  m = text.match(/^save\s+@?([\w'.]+)\s+as\s+(.+)$/i);
  if (m) {
    const [, username, nickname] = m;
    if (username.toLowerCase() === currentUser?.username?.toLowerCase()) return { ok: false, text: "You can't set a nickname for yourself." };
    try {
      await api.setNickname(username, nickname.trim());
      return { ok: true, text: `Saved @${username} as "${nickname.trim()}".` };
    } catch (err) {
      return { ok: false, text: `Couldn't save that nickname: ${err.message}` };
    }
  }

  m = text.match(/^post:\s*(.+)$/i);
  if (m) {
    const caption = m[1].trim();
    if (!caption) return { ok: false, text: 'What should the post say?' };
    try {
      await api.createPost({ caption });
      return { ok: true, text: 'Posted to your feed.', navigate: () => navigate('feed') };
    } catch (err) {
      return { ok: false, text: `Couldn't post: ${err.message}` };
    }
  }

  m = lower.match(/^send\s+this\s+to\s+@?(\w+)$/) || lower.match(/^share\s+this\s+with\s+@?(\w+)$/);
  if (m) {
    const [, username] = m;
    const ctx = getCodexContext();
    const content = ctx.currentReel || ctx.currentPost;
    if (!content) return { ok: false, text: "There's no Reel or Post currently in view to share — scroll to one first." };
    const label = ctx.currentReel ? 'Reel' : 'Post';
    try {
      const res = await api.sendMessage({ toUsername: username, text: `Shared a ${label} on NEXA${content.caption ? `: "${content.caption.slice(0, 100)}"` : ''}` });
      const okText = res.status === 'sent' ? `Sent the ${label.toLowerCase()} to @${username}.` : res.message;
      return { ok: true, text: okText, navigate: () => navigate('messages', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't share: ${err.message}` };
    }
  }

  if (/^like\s+this$/.test(lower)) {
    const ctx = getCodexContext();
    try {
      if (ctx.currentReel) { await api.likeReel(ctx.currentReel.id); return { ok: true, text: 'Liked the reel.' }; }
      if (ctx.currentPost) { await api.like(ctx.currentPost.id); return { ok: true, text: 'Liked the post.' }; }
      return { ok: false, text: "There's nothing currently in view to like — scroll to a Reel or Post first." };
    } catch (err) {
      return { ok: false, text: `Couldn't like that: ${err.message}` };
    }
  }

  if (/^save\s+this$/.test(lower)) {
    const ctx = getCodexContext();
    try {
      if (ctx.currentReel) { await api.saveReel(ctx.currentReel.id); return { ok: true, text: 'Saved the reel.' }; }
      if (ctx.currentPost) { await api.savePost(ctx.currentPost.id); return { ok: true, text: 'Saved the post.' }; }
      return { ok: false, text: "There's nothing currently in view to save — scroll to a Reel or Post first." };
    } catch (err) {
      return { ok: false, text: `Couldn't save that: ${err.message}` };
    }
  }

  m = lower.match(/^(?:go to|open)\s+@?(\w+)(?:'s)?\s+profile$/);
  if (m) {
    const username = m[1];
    return { ok: true, text: `Opening @${username}'s profile.`, navigate: () => navigate('profile', username) };
  }

  if (/^open feed$|^go home$|^show (my )?feed$/.test(lower)) {
    return { ok: true, text: 'Opening your feed.', navigate: () => navigate('feed') };
  }
  if (/^open messages$/.test(lower)) {
    return { ok: true, text: 'Opening messages.', navigate: () => navigate('messages') };
  }
  if (/^open settings$/.test(lower)) {
    return { ok: true, text: 'Opening settings.', navigate: () => navigate('settings') };
  }
  if (/^(open|show|edit|change|update|customi[sz]e)( my)? (profile studio|studio|profile (video|photo|picture|pic|image)|profile)$/.test(lower) && !/^(open|show) (my )?profile$/.test(lower)) {
    return { ok: true, text: 'Opening your Profile Studio.', navigate: () => navigate('profile-studio') };
  }
  if (/^open (my )?saved posts$/.test(lower)) {
    return { ok: true, text: 'Opening your saved posts.', navigate: () => navigate('saved-posts') };
  }
  if (/^open (my )?saved reels$/.test(lower)) {
    return { ok: true, text: 'Opening your saved reels.', navigate: () => navigate('saved-reels') };
  }
  if (/^(open|show) (my )?reels history$/.test(lower)) {
    return { ok: true, text: 'Opening your reels history.', navigate: () => navigate('reels-history') };
  }
  if (/^(open (the )?)?game ?store$|^open games$/.test(lower)) {
    return { ok: true, text: 'Opening the Game Store.', navigate: () => navigate('games') };
  }
  m = lower.match(/^(?:show|open) (?:my )?(discover|friends|my games|tournaments)$/);
  if (m) {
    const tab = m[1] === 'my games' ? 'mine' : m[1];
    return { ok: true, text: `Opening ${m[1]}.`, navigate: () => navigate('games', { tab }) };
  }
  m = lower.match(/^(?:turn on|switch to|enable)\s+(dark|light)(?:\s+mode)?$/);
  if (m) {
    applyTheme(m[1], true);
    return { ok: true, text: `Switched to ${m[1]} mode.` };
  }

  m = lower.match(/^(video call|call)\s+@?(\w+)$/);
  if (m) {
    const [, kind, username] = m;
    const type = kind === 'video call' ? 'video' : 'voice';
    try {
      const convos = await api.conversations();
      const convo = convos.conversations.find(c => c.participants.some(p => p.username === username));
      if (!convo) return { ok: false, text: `You don't have a conversation with @${username} yet, so I can't start a call. Message them first.` };
      requestStartCall(convo.id, type);
      return { ok: true, text: `Starting a ${type} call with @${username}…`, navigate: () => navigate('messages', username) };
    } catch (err) {
      return { ok: false, text: `Couldn't start the call: ${err.message}` };
    }
  }

  m = lower.match(/^open\s+([a-z0-9 ]+?)(?:\s+and\s+search\s+(.+))?$/);
  if (m) {
    const [, appQuery, searchFor] = m;
    try {
      const res = await api.resolveApp(appQuery.trim(), searchFor);
      if (!res.resolved) return { ok: false, text: res.message };
      if (!res.launchable) return { ok: false, text: res.message };
      window.open(res.url, '_blank', 'noopener');
      return { ok: true, text: `Opening ${res.app.displayName}${searchFor ? ` and searching "${searchFor}"` : ''}…` };
    } catch (err) {
      return { ok: false, text: `Couldn't resolve that app: ${err.message}` };
    }
  }

  return { ok: false, text: "I didn't recognize that. Type \"help\" to see what I can actually do." };
}

export default function Codex({ navigate, goBack, currentUser }) {
  const [open, setOpen] = useState(false); // true = the full panel; false = the small type box
  const [showReply, setShowReply] = useState(false); // small reply square under/over the type box
  // Split-screen dock: while open, the app shrinks so the panel never covers any page.
  useEffect(() => {
    document.documentElement.classList.toggle('codex-split', open);
    return () => document.documentElement.classList.remove('codex-split');
  }, [open]);
  const [log, setLog] = useState([{ who: 'codex', text: "Hi, I'm Codex. Try: \"hi to rahul\", \"reels open pannu\" or \"follow priya\" — typos and any language are fine. Tap 🎙 to talk to me." }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(null);
  const [listening, setListening] = useState(false);
  const [voiceOutOn, setVoiceOutOn] = useState(false);
  const [voiceLang, setVoiceLang] = useState('auto'); // 'auto' = follow the language you speak / your browser
  const [interim, setInterim] = useState('');
  const [pending, setPending] = useState(null); // { pendingAction, remainingActions, candidates? }
  const [showHistory, setShowHistory] = useState(false);
  const [historyRows, setHistoryRows] = useState(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [uiPrompt, setUiPrompt] = useState(null); // { kind:'confirm'|'pick', text, candidates?, resolve }
  const abortRef = useRef(false);
  const logRef = useRef(null);
  const recognitionRef = useRef(null);
  // Refs mirror state that the speech callbacks read. Callbacks created when the mic is tapped
  // would otherwise see STALE values (e.g. voiceOutOn=false, so the first spoken reply was silent).
  const voiceOutRef = useRef(false);
  const voiceLangRef = useRef('auto');
  const heardLangRef = useRef(null);   // last non-Latin language we actually heard
  const logStateRef = useRef([]);
  const runTextRef = useRef(null);
  useEffect(() => { voiceOutRef.current = voiceOutOn; }, [voiceOutOn]);
  useEffect(() => { voiceLangRef.current = voiceLang; }, [voiceLang]);
  useEffect(() => { logStateRef.current = log; }, [log]);
  useEffect(() => () => { try { recognitionRef.current?.abort(); } catch {} window.speechSynthesis?.cancel(); }, []);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);
  useEffect(() => { api.codexStatus().then(r => setAiConfigured(r.configured)).catch(() => setAiConfigured(false)); }, []);

  // Speak a reply in the right voice: the reply's own script if it has one (Tamil reply -> Tamil
  // voice), otherwise English. Never read the long HELP text aloud, and never speak into an open mic.
  const speak = (text) => {
    if (!voiceOutRef.current || !window.speechSynthesis || !text || text === HELP) return;
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 220);
    const lang = detectScriptLang(clean) || 'en-US';
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = lang;
    const voices = window.speechSynthesis.getVoices?.() || [];
    const v = voices.find(x => x.lang === lang) || voices.find(x => x.lang?.startsWith(lang.split('-')[0]));
    if (v) utter.voice = v;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  };

  const recentHistory = (log) => log.slice(-8).map(m => ({ role: m.who, text: m.text }));

  const say = (text) => { setLog(l => [...l, { who: 'codex', text }]); speak(text); };
  const ask = (prompt) => new Promise(resolve => setUiPrompt({ ...prompt, resolve }));
  const answerPrompt = (value) => { const p = uiPrompt; setUiPrompt(null); p?.resolve(value); };
  const stopAgent = () => { abortRef.current = true; uiPrompt?.resolve(null); setUiPrompt(null); };

  // One on-screen step: observe (fresh scan) → decide (server resolves against that scan) →
  // gate (blocked / confirm) → act → wait for the page to settle → report the real outcome.
  const runUiStep = async (step) => {
    const report = (outcome, label, detail) => api.codexUiReport({ step: step.type, label, outcome, detail });
    const spoken = step.target || step.text || step.direction || step.type;

    if (step.type === 'scroll' && step.direction) {
      const r = await scrollPage(step.direction);
      if (!r.ok) { say(r.error); report('failed', spoken, r.error); return false; }
      report('done', `scroll ${step.direction}`);
      return true;
    }

    const action = step.type === 'type' ? 'type' : step.type === 'scroll' ? 'scroll' : 'click';
    const query = step.type === 'back' ? 'back' : (step.target || '');
    let r;
    // The page may still be loading (we may have just navigated): look again a few times before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (abortRef.current) return false;
      r = await api.codexUiResolve({ action, query, controlId: step.controlId, controls: scanControls() });
      if (r.status !== 'none' || step.type === 'back') break;
      await sleep(450);
      await settle({ quiet: 250, max: 1200 });
    }

    if (step.type === 'back' && !(r.status === 'ok' && r.risk?.level === 'safe')) {
      if (goBack?.()) { await settle(); report('done', 'back'); return true; }
      say("There's nothing to go back to."); report('failed', 'back', 'no history'); return false;
    }
    if (r.status === 'none') { say(r.message || `I couldn't find “${spoken}” on this screen.`); report('failed', spoken, 'not found'); return false; }
    if (r.status === 'already') { say(r.message); return true; }

    let controlId, label, risk = r.risk;
    if (r.status === 'ambiguous') {
      const pick = await ask({ kind: 'pick', text: r.message, candidates: r.candidates });
      if (!pick) { say('Cancelled.'); report('cancelled', spoken); return false; }
      // Re-resolve the chosen one so the risk level is computed by the server, not assumed.
      const again = await api.codexUiResolve({ action, query: '', controlId: pick.id, controls: scanControls() });
      if (again.status !== 'ok') { say(again.message || "That one isn't on screen any more."); return false; }
      r = again; risk = again.risk;
    }
    controlId = r.control.id; label = r.control.label || spoken;

    if (risk?.level === 'blocked') { say(risk.reason); report('refused', label, 'blocked by policy'); return false; }
    if (risk?.level === 'confirm') {
      const yes = await ask({ kind: 'confirm', text: `Press “${label}”? ${risk.reason || ''}`.trim() });
      if (!yes) { say('Cancelled.'); report('cancelled', label); return false; }
    }

    let result;
    if (step.type === 'scroll') result = await scrollToControl(controlId);
    else if (step.type === 'type') result = await typeInto(controlId, step.text, step.submit);
    else result = await pressControl(controlId);
    if (!result.ok) { say(result.error); report('failed', label, result.error); return false; }

    await settle();
    report('done', label);
    say(step.type === 'type' ? `Typed into “${label}”${step.submit ? ' and sent it' : ''}.` : step.type === 'scroll' ? `Scrolled to “${label}”.` : `Pressed “${label}”.`);
    return true;
  };

  // Runs the server's ordered plan. Stops at the first step that fails and says so — it never
  // carries on as if nothing went wrong.
  const runSequence = async (sequence) => {
    setAgentRunning(true);
    abortRef.current = false;
    try {
      const steps = sequence.slice(0, MAX_STEPS);
      if (sequence.length > MAX_STEPS) say(`That's a lot — I'll do the first ${MAX_STEPS} steps.`);
      for (const item of steps) {
        if (abortRef.current) { say('Stopped.'); return; }
        if (item.kind === 'navigate') { navigate(item.screen, item); await settle(); }
        else if (item.kind === 'theme') applyTheme(item.theme, true);
        else if (item.kind === 'openUrl') window.open(item.url, '_blank', 'noopener');
        else if (item.kind === 'startCall') requestStartCall(item.conversationId, item.type);
        else if (item.kind === 'ui') { if (!(await runUiStep(item.step))) return; }
      }
    } catch (err) {
      say(`Something went wrong: ${err.message}`);
    } finally {
      setAgentRunning(false);
    }
  };

  const handleAiResult = (res, originalText) => {
    if (res.needsConfirmation) {
      setLog(l => [...l, { who: 'codex', text: res.message }]);
      speak(res.message);
      setPending({ pendingAction: res.pendingAction, remainingActions: res.remainingActions || [] });
      return;
    }
    if (res.needsDisambiguation) {
      setLog(l => [...l, { who: 'codex', text: res.message }]);
      speak(res.message);
      setPending({ pendingAction: res.pendingAction, remainingActions: res.remainingActions || [], candidates: res.candidates || [] });
      return;
    }
    if (res.needsPreview) {
      // Section 171 — complex/multi-step commands are previewed as "I understood: ..."
      // before anything runs, with Confirm / Edit / Cancel, instead of silently chaining
      // several actions together.
      setLog(l => [...l, { who: 'codex', text: res.message }]);
      speak(res.message);
      setPending({ plan: res.pendingPlan, steps: res.steps || [], originalText });
      return;
    }
    if (res.message) { setLog(l => [...l, { who: 'codex', text: res.message }]); speak(res.message); }
    if (res.sequence) { runSequence(res.sequence); return; }
    if (res.navigate) navigate(res.navigate.screen, res.navigate);
    if (res.openUrl) window.open(res.openUrl, '_blank', 'noopener');
    if (res.startCall) requestStartCall(res.startCall.conversationId, res.startCall.type);
    if (res.setTheme) applyTheme(res.setTheme, true);
  };

  const runText = async (text, alternatives = []) => {
    setShowReply(true);
    setShowHistory(false);
    setLog(l => [...l, { who: 'user', text }]);
    if (text.toLowerCase() === 'help') {
      setLog(l => [...l, { who: 'codex', text: HELP }]);
      speak(HELP);
      return;
    }
    setBusy(true);
    // The backend understands typos, word order and many languages with or without an AI key
    // (offline NLU), so it is always asked first. The local pattern parser below is only a
    // safety net for when the server can't be reached.
    try {
      let res = await api.codexAct(text, { ...getCodexContext(), controls: scanControls() }, recentHistory(logStateRef.current));
      // The recogniser's top guess isn't always right. If Codex couldn't act on it, try the
      // recogniser's other candidate transcripts before giving up.
      for (const alt of alternatives) {
        if (res.handled !== false) break;
        const r2 = await api.codexAct(alt, { ...getCodexContext(), controls: scanControls() }, recentHistory(logStateRef.current));
        if (r2.handled !== false) { res = r2; text = alt; }
      }
      handleAiResult(res, text);
      setBusy(false);
      return;
    } catch {
      // fall through to local parser below
    }
    const result = await runCommand(text, { navigate, currentUser });
    setLog(l => [...l, { who: 'codex', text: result.text }]);
    speak(result.text);
    result.navigate?.();
    setBusy(false);
  };

  const confirmPending = async (confirmed) => {
    const { pendingAction, remainingActions } = pending;
    setPending(null);
    if (!confirmed) {
      setLog(l => [...l, { who: 'codex', text: 'Cancelled.' }]);
      return;
    }
    setBusy(true);
    try {
      const res = await api.codexConfirm(pendingAction, remainingActions, getCodexContext());
      handleAiResult(res);
    } catch (err) {
      setLog(l => [...l, { who: 'codex', text: `Something went wrong: ${err.message}` }]);
    }
    setBusy(false);
  };

  // Section 183 — when a name like "Rahul" matches more than one person, Codex hands the
  // real candidate list back instead of guessing; picking one here resubmits the exact
  // same action with the exact username filled in.
  const pickCandidate = async (candidate) => {
    const { pendingAction, remainingActions } = pending;
    setPending(null);
    setBusy(true);
    try {
      const resolvedAction = { name: pendingAction.name, input: { ...pendingAction.input, username: candidate.username } };
      const res = await api.codexResolve(resolvedAction, remainingActions, getCodexContext());
      handleAiResult(res);
    } catch (err) {
      setLog(l => [...l, { who: 'codex', text: `Something went wrong: ${err.message}` }]);
    }
    setBusy(false);
  };

  // Section 171 — approving the whole previewed plan. Declining or editing never touches
  // the backend at all, since nothing has executed yet.
  const confirmPlan = async (confirmed) => {
    const { plan, originalText } = pending;
    setPending(null);
    if (!confirmed) {
      setLog(l => [...l, { who: 'codex', text: 'Cancelled.' }]);
      return;
    }
    setBusy(true);
    try {
      const res = await api.codexConfirmPlan(plan, getCodexContext());
      handleAiResult(res, originalText);
    } catch (err) {
      setLog(l => [...l, { who: 'codex', text: `Something went wrong: ${err.message}` }]);
    }
    setBusy(false);
  };

  const editPlan = () => {
    setInput(pending.originalText || '');
    setPending(null);
  };

  // Section 184 — AI action log. Lazily loads the user's recent Codex actions from the
  // real audit trail the backend already keeps (GET /codex/history) so they can see what
  // Codex actually did, not a fabricated summary.
  const toggleHistory = async () => {
    if (!showHistory && historyRows === null) {
      try {
        const res = await api.codexHistory();
        setHistoryRows(res.actions || []);
      } catch {
        setHistoryRows([]);
      }
    }
    setShowHistory(s => !s);
  };

  const STATUS_ICON = { executed: '✓', failed: '✕', no_match: '?', pending_confirmation: '⏳', pending_disambiguation: '⏳', ai_unavailable: '⚠' };

  // Section 185 — command bar suggested commands, shown only while the conversation is
  // still at its initial empty state so they don't clutter an ongoing exchange.
  const SUGGESTIONS = ['Open Messages', 'game store open pannu', 'reels', 'scroll down', 'like button click pannu'];

  useEffect(() => { runTextRef.current = runText; });

  const submit = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    await runText(text);
  };

  const SpeechRecognitionCtor = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

  const micSay = (text) => setLog(l => [...l, { who: 'codex', text }]);

  const toggleListening = async () => {
    if (!SpeechRecognitionCtor) {
      micSay("This browser doesn't support voice input (Chrome, Edge and Safari do; Firefox doesn't). You can still type.");
      return;
    }
    if (listening) { try { recognitionRef.current?.stop(); } catch {} return; }
    // Browsers only allow the mic on https:// or localhost.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      micSay('The microphone only works on a secure page (https:// or localhost). Open the app over https and try again.');
      return;
    }
    window.speechSynthesis?.cancel(); // never listen to our own voice

    // Ask for mic permission explicitly first, so a denied/missing mic gives a clear message
    // instead of the recogniser failing silently.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch (err) {
        micSay(err?.name === 'NotFoundError' ? MIC_ERRORS['audio-capture'] : MIC_ERRORS['not-allowed']);
        return;
      }
    }

    // 'auto' = the language you last spoke in (by script), else your browser's language.
    const chosen = voiceLangRef.current;
    const lang = chosen !== 'auto' ? chosen : (heardLangRef.current || navigator.language || 'en-IN');

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;   // show words live so you can see it hearing you
    recognition.maxAlternatives = 3;
    let gotFinal = false, failed = false;
    recognition.onstart = () => { setListening(true); setInterim(''); };
    recognition.onresult = (e) => {
      const res = e.results[e.results.length - 1];
      const top = res[0].transcript.trim();
      if (!res.isFinal) { setInterim(top); return; }
      gotFinal = true;
      setInterim('');
      if (!top) return;
      const alts = [];
      for (let i = 1; i < res.length; i++) { const t = res[i].transcript.trim(); if (t && t !== top) alts.push(t); }
      const sl = detectScriptLang(top);
      if (sl) heardLangRef.current = sl;   // remember the language for next time + for the reply voice
      voiceOutRef.current = true;          // once you talk to Codex, it talks back
      setVoiceOutOn(true);
      runTextRef.current?.(top, alts);
    };
    recognition.onerror = (e) => {
      failed = true;
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech') { micSay("I didn't hear anything. Tap 🎙 and speak after it says Listening."); return; }
      micSay(MIC_ERRORS[e.error] || `Voice input stopped (${e.error}). Please try again.`);
    };
    recognition.onend = () => {
      setListening(false);
      setInterim('');
      if (!gotFinal && !failed) micSay("I couldn't catch that. Please try again, a little closer to the mic.");
    };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch { setListening(false); }
  };

  const interactiveJsx = (
    <>
      {busy && <div className="codex-msg codex"><span className="loading-dot" /></div>}
      {agentRunning && !uiPrompt && (
        <div className="codex-msg codex" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="loading-dot" /> Working on your screen…
          <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12, width: 'auto' }} onClick={stopAgent}>Stop</button>
        </div>
      )}
      {uiPrompt?.kind === 'confirm' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <div style={{ fontSize: 13, color: 'var(--text-hi)' }}>{uiPrompt.text}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 12, width: 'auto' }} onClick={() => answerPrompt(false)}>Cancel</button>
            <button className="btn-primary" style={{ width: 'auto', padding: '4px 14px', fontSize: 12 }} onClick={() => answerPrompt(true)}>Yes, press it</button>
          </div>
        </div>
      )}
      {uiPrompt?.kind === 'pick' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          <div style={{ width: '100%', fontSize: 13, color: 'var(--text-hi)' }}>{uiPrompt.text}</div>
          {uiPrompt.candidates.map(c => (
            <button key={c.id} className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, width: 'auto' }} onClick={() => answerPrompt(c)}>{c.label || '(unlabelled)'}</button>
          ))}
          <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, width: 'auto' }} onClick={() => answerPrompt(null)}>Cancel</button>
        </div>
      )}
      {pending && !busy && pending.steps && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          {pending.steps.map((s, i) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--text-mid)' }}>{s}</div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 12, width: 'auto' }} onClick={() => confirmPlan(false)}>Cancel</button>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 12, width: 'auto' }} onClick={editPlan}>Edit</button>
            <button className="btn-primary" style={{ width: 'auto', padding: '4px 14px', fontSize: 12 }} onClick={() => confirmPlan(true)}>Confirm</button>
          </div>
        </div>
      )}
      {pending && !busy && !pending.steps && !pending.candidates && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => confirmPending(false)}>Cancel</button>
          <button className="btn-primary" style={{ width: 'auto', padding: '4px 14px', fontSize: 12 }} onClick={() => confirmPending(true)}>Confirm</button>
        </div>
      )}
      {pending && !busy && pending.candidates && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {pending.candidates.map(c => (
            <button key={c.username} className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, width: 'auto' }} onClick={() => pickCandidate(c)}>
              @{c.username} <span style={{ opacity: 1 }}>({c.displayName})</span>
            </button>
          ))}
          <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, width: 'auto' }} onClick={() => { setPending(null); setLog(l => [...l, { who: 'codex', text: 'Cancelled.' }]); }}>Cancel</button>
        </div>
      )}
    </>
  );

  // Messages Codex wrote since the person's last message — the small reply square shows only these.
  const lastUser = log.map(m => m.who).lastIndexOf('user');
  const replies = lastUser === -1 ? [] : log.slice(lastUser + 1).filter(m => m.who === 'codex');
  const replyVisible = showReply && (replies.length > 0 || busy || agentRunning || !!pending || !!uiPrompt);

  const onMiniChange = (e) => {
    setInput(e.target.value);
    // Typing again makes the reply square disappear — unless Codex is waiting for an answer.
    if (showReply && !pending && !uiPrompt) setShowReply(false);
  };

  return (
    <>
      {!open && (
        <div className="codex-mini-wrap">
          {replyVisible && (
            <div className="glass-card codex-mini-reply" role="status">
              <button className="codex-mini-x" onClick={() => { if (pending) setPending(null); setShowReply(false); }} aria-label="Close reply">✕</button>
              {replies.map((m, i) => <div key={i} className="codex-mini-msg">{m.text}</div>)}
              {interactiveJsx}
            </div>
          )}
          <form className="glass-card codex-mini" onSubmit={submit}>
            <button type="button" className="codex-mini-btn" onClick={toggleListening} disabled={!!pending || !!uiPrompt} aria-label="Talk to Codex"
              style={{ background: listening ? 'var(--pink)' : 'transparent' }}>{listening ? '⏹' : '🎙'}</button>
            <input
              placeholder={pending || uiPrompt ? 'Answer above first…' : agentRunning ? 'Working…' : listening ? 'Listening…' : 'Ask Codex… (type help)'}
              value={listening && interim ? interim : input} onChange={onMiniChange} disabled={!!pending || !!uiPrompt || agentRunning} aria-label="Ask Codex"
            />
            <select value={voiceLang} onChange={e => setVoiceLang(e.target.value)} aria-label="Voice language" title="Voice language"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-mid)', fontSize: 11, maxWidth: 52, cursor: 'pointer' }}>
              <option value="auto">Auto</option><option value="en-US">EN</option><option value="en-IN">EN-IN</option>
              <option value="ta-IN">TA</option><option value="hi-IN">HI</option><option value="te-IN">TE</option>
              <option value="kn-IN">KN</option><option value="ml-IN">ML</option><option value="bn-IN">BN</option>
              <option value="ar-SA">AR</option><option value="es-ES">ES</option><option value="fr-FR">FR</option>
              <option value="de-DE">DE</option><option value="pt-BR">PT</option><option value="ja-JP">JA</option>
              <option value="ko-KR">KO</option><option value="ru-RU">RU</option>
            </select>
            <button type="button" className="codex-mini-btn" onClick={() => setOpen(true)} aria-label="Open full Codex" title="Open full Codex">⤢</button>
          </form>
        </div>
      )}
      {open && (
        <div className="glass-card codex-panel">
          <div className="codex-panel-header">
            <span className="t">Codex</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={voiceLang} onChange={e => setVoiceLang(e.target.value)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-soft)', borderRadius: 6, color: 'var(--text-mid)', fontSize: 11 }}>
                <option value="auto">Auto</option>
                <option value="en-US">EN</option>
                <option value="en-IN">EN-IN</option>
                <option value="ta-IN">TA</option>
                <option value="hi-IN">HI</option>
                <option value="te-IN">TE</option>
                <option value="kn-IN">KN</option>
                <option value="ml-IN">ML</option>
                <option value="bn-IN">BN</option>
                <option value="ar-SA">AR</option>
                <option value="es-ES">ES</option>
                <option value="fr-FR">FR</option>
                <option value="de-DE">DE</option>
                <option value="pt-BR">PT</option>
                <option value="ja-JP">JA</option>
                <option value="ko-KR">KO</option>
                <option value="ru-RU">RU</option>
              </select>
              <button onClick={() => setVoiceOutOn(v => !v)} title="Toggle spoken replies" style={{ opacity: voiceOutOn ? 1 : 0.4 }}>🔊</button>
              <button onClick={toggleHistory} title="Recent AI actions" style={{ opacity: showHistory ? 1 : 0.6 }}>📜</button>
              <button onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>
          {showHistory ? (
            <div className="codex-log" ref={logRef}>
              <div className="codex-msg codex" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-low)' }}>Recent AI actions</div>
              {historyRows === null && <div className="codex-msg codex"><span className="loading-dot" /></div>}
              {historyRows?.length === 0 && <div className="codex-msg codex">Nothing yet — actions you ask Codex to take will show up here.</div>}
              {historyRows?.map(row => (
                <div key={row.id} className="codex-msg codex" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ opacity: 1 }}>{STATUS_ICON[row.status] || '•'}</span>
                  <span>
                    <span style={{ color: 'var(--text-hi)' }}>{row.actionName || row.inputText}</span>
                    {row.resultSummary ? ` — ${row.resultSummary}` : ''}
                    <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-low)' }}>{new Date(row.createdAt).toLocaleString()}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="codex-log" ref={logRef}>
              {log.map((m, i) => (
                <div key={i} className={`codex-msg ${m.who}`}>
                  <span className="who">{m.who === 'codex' ? 'Codex' : 'You'}</span>
                  {m.text}
                </div>
              ))}
              {log.length === 1 && !busy && !pending && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                  {SUGGESTIONS.map(s => (
                    <button key={s} className="btn-ghost" style={{ padding: '4px 10px', fontSize: 11.5, width: 'auto' }} onClick={() => runText(s)}>{s}</button>
                  ))}
                </div>
              )}
              {interactiveJsx}
            </div>
          )}
          <div className="codex-hint">
            {aiConfigured === null ? 'Checking AI availability…' : aiConfigured
              ? 'AI-powered — any language, any phrasing, typos OK.'
              : 'Built-in local AI — no API key. Typos, Tanglish & many languages OK.'}
          </div>
          <form className="codex-input-row" onSubmit={submit}>
            <button type="button" onClick={toggleListening} disabled={!!pending || !!uiPrompt} style={{ background: listening ? 'var(--pink)' : 'transparent', border: '1px solid var(--border-soft)', borderRadius: '50%', width: 34, height: 34, color: 'white', cursor: 'pointer', flexShrink: 0 }}>
              {listening ? '⏹' : '🎙'}
            </button>
            <input placeholder={pending || uiPrompt ? 'Answer above first…' : agentRunning ? 'Working…' : listening ? 'Listening…' : 'Tell Codex what to do…'} value={listening && interim ? interim : input} onChange={e => setInput(e.target.value)} disabled={!!pending || !!uiPrompt || agentRunning} />
          </form>
        </div>
      )}
    </>
  );
}
