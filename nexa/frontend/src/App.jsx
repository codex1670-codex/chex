import { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import Auth from './pages/Auth.jsx';
import Feed from './pages/Feed.jsx';
import Profile from './pages/Profile.jsx';
import Messages from './pages/Messages.jsx';
import Reels from './pages/Reels.jsx';
import Notifications from './pages/Notifications.jsx';
import Games from './pages/Games.jsx';
import Search from './pages/Search.jsx';
import Settings from './pages/Settings.jsx';
import Avatar from './components/Avatar.jsx';
import Codex from './components/Codex.jsx';
import CallLayer from './components/CallLayer.jsx';
import InstallBanner from './components/InstallBanner.jsx';
import Splash from './components/Splash.jsx';
import { api } from './api.js';
import { connectSocket, disconnectSocket, getSocket } from './socket.js';
import { setCodexContext } from './codexContext.js';

const NAV = [
  { key: 'feed', label: 'Home', icon: '🏠' },
  { key: 'search', label: 'Search', icon: '🔍' },
  { key: 'reels', label: 'Reels', icon: '🎬' },
  { key: 'messages', label: 'Messages', icon: '💬' },
  { key: 'notifications', label: 'Notifications', icon: '🔔' },
  { key: 'games', label: 'Games', icon: '🎮' },
  { key: 'profile', label: 'Profile', icon: '👤' },
];

export default function App() {
  const { user, booting, logout } = useAuth();
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [route, setRoute] = useState('feed');
  const [profileUsername, setProfileUsername] = useState(null);
  const [profileView, setProfileView] = useState(null); // 'saved-posts' | 'saved-reels' | 'reels-history' | 'profile-studio' | null
  const [gamesTab, setGamesTab] = useState(null); // 'discover' | 'friends' | 'mine' | 'tournaments' | null
  const [messageStart, setMessageStart] = useState(null);
  const [searchQuery, setSearchQuery] = useState(null);
  const [unread, setUnread] = useState(0);
  const historyRef = useRef([]); // previous screens, so Codex's "go back" can return to them

  useEffect(() => {
    const t1 = setTimeout(() => setSplashLeaving(true), 2200);
    const t2 = setTimeout(() => setSplashDone(true), 2650);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  useEffect(() => {
    if (!user) return;
    connectSocket();
    api.notifications().then(res => setUnread(res.unreadCount)).catch(() => {});
    const socket = getSocket();
    const onNotif = () => setUnread(u => u + 1);
    socket?.on('notification:new', onNotif);
    return () => {
      socket?.off('notification:new', onNotif);
      disconnectSocket();
    };
  }, [user]);

  // Launch screen: always shown briefly before login/home, then fades out.
  if (booting || !splashDone) return <Splash leaving={!booting && splashLeaving} />;
  if (!user) return <Auth />;

  const goBack = () => {
    const prev = historyRef.current.pop();
    if (!prev) return false;
    setProfileUsername(prev.profileUsername);
    setProfileView(prev.profileView);
    setGamesTab(prev.gamesTab);
    setRoute(prev.route);
    setCodexContext({ screen: prev.route });
    return true;
  };

  const navigate = (key, param) => {
    historyRef.current.push({ route, profileUsername, profileView, gamesTab });
    if (historyRef.current.length > 30) historyRef.current.shift();
    const username = typeof param === 'string' ? param : param?.username;
    const query = typeof param === 'object' ? param?.query : undefined;
    const tab = typeof param === 'object' ? param?.tab : undefined;
    const view = typeof param === 'object' ? param?.view : undefined;

    // 'saved-posts' / 'saved-reels' / 'reels-history' are deep links into the current
    // user's own Profile, not separate top-level screens (spec #164/#173's "Open my
    // saved reels" / "Show my reels history" etc).
    if (key === 'saved-posts' || key === 'saved-reels' || key === 'reels-history' || key === 'profile-studio') {
      setProfileUsername(user.username);
      setProfileView(key);
      setRoute('profile');
      setCodexContext({ screen: 'profile' });
      return;
    }
    if (key === 'profile') { setProfileUsername(username || user.username); setProfileView(['saved-posts', 'saved-reels', 'reels-history', 'profile-studio'].includes(view) ? view : null); }
    if (key === 'games') setGamesTab(tab && ['discover', 'friends', 'mine', 'tournaments'].includes(tab) ? tab : null);
    if (key === 'messages') setMessageStart(username || null);
    if (key === 'notifications') setUnread(0);
    if (key === 'search' && query) setSearchQuery(query);
    setRoute(key);
    // Baseline context reset on navigation — the destination page's own effect will
    // shortly enrich this with real content (current reel/profile/conversation) once
    // it mounts and loads. Codex only ever reads this at command time, never earlier.
    setCodexContext({ screen: key });
  };
  const openSettings = () => navigate('settings');

  return (
    <div className="app-shell">
      <nav className="nav-rail">
        <div className="nexa-wordmark"><img src="/logo.png" alt="" width="26" height="26" style={{borderRadius:'50%',verticalAlign:'middle',marginRight:8}} />CHEX</div>
        {NAV.map(n => (
          <button
            key={n.key}
            className={`nav-link ${route === n.key ? 'active' : ''}`}
            onClick={() => navigate(n.key, n.key === 'profile' ? user.username : undefined)}
          >
            <span>{n.icon}</span> {n.label}
            {n.key === 'notifications' && unread > 0 && <span className="dot" />}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
          <Avatar user={user} size={32} fullscreenOnClick />
          <div style={{ fontSize: 13, fontWeight: 700 }}>{user.displayName}</div>
        </div>
        <button className="nav-link" onClick={logout}>⏻ Log out</button>
      </nav>

      <main className="main-col">
        {route === 'feed' && <Feed onOpenProfile={(u) => navigate('profile', u)} />}
        {route === 'search' && <Search onOpenProfile={(u) => navigate('profile', u)} initialQuery={searchQuery} onConsumeQuery={() => setSearchQuery(null)} />}
        {route === 'reels' && <Reels />}
        {route === 'notifications' && <Notifications onOpenProfile={(u) => navigate('profile', u)} />}
        {route === 'games' && <Games initialTab={gamesTab} onConsumeInitialTab={() => setGamesTab(null)} />}
        {route === 'settings' && <Settings onBack={() => navigate('profile', user.username)} />}
        {route === 'profile' && (
          <Profile
            username={profileUsername || user.username}
            initialView={profileView}
            onConsumeInitialView={() => setProfileView(null)}
            onOpenMessage={(u) => navigate('messages', u)}
            onOpenSettings={openSettings}
          />
        )}
        {route === 'messages' && (
          <Messages startWithUsername={messageStart} onConsumeStart={() => setMessageStart(null)} />
        )}
      </main>

      <div className="nav-bar-mobile">
        {NAV.map(n => (
          <button key={n.key} className={route === n.key ? 'active' : ''} onClick={() => navigate(n.key, n.key === 'profile' ? user.username : undefined)} style={{ position: 'relative' }}>
            {n.icon}
            {n.key === 'notifications' && unread > 0 && <span className="dot" style={{ position: 'absolute', top: 4, right: 10 }} />}
          </button>
        ))}
      </div>

      <Codex navigate={navigate} goBack={goBack} currentUser={user} />
      <CallLayer />
      <InstallBanner />
    </div>
  );
}
