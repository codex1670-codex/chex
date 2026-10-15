import { useEffect, useState } from 'react';

// Shows an "Install CHEX" prompt when the browser allows it, and an offline notice when the
// connection drops. Dismissal is remembered for the session only.
export default function InstallBanner() {
  const [deferred, setDeferred] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('nexa-install-hidden') === '1');

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => setDeferred(null);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    setDeferred(null);
  };
  const dismiss = () => { sessionStorage.setItem('nexa-install-hidden', '1'); setHidden(true); };

  if (!online) return <div className="pwa-banner pwa-offline" role="status">You're offline — showing the saved app. Reconnecting automatically…</div>;
  if (!deferred || hidden) return null;
  return (
    <div className="pwa-banner" role="dialog" aria-label="Install CHEX">
      <span>Install CHEX for a faster, full-screen app.</span>
      <button className="pwa-btn" onClick={install}>Install</button>
      <button className="pwa-x" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
