import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setTokens, getStoredRefreshToken, onAuthFailure } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* best-effort */ }
    setTokens(null);
    setUser(null);
  }, []);

  useEffect(() => {
    onAuthFailure(() => setUser(null));
  }, []);

  useEffect(() => {
    (async () => {
      const stored = getStoredRefreshToken();
      if (!stored) { setBooting(false); return; }
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: stored }),
        });
        if (res.ok) {
          const tokens = await res.json();
          setTokens(tokens);
          const me = await api.me();
          setUser(me.user);
        }
      } catch { /* stay logged out */ }
      setBooting(false);
    })();
  }, []);

  const login = async (identifier, password, totpCode) => {
    const data = await api.login({ identifier, password, totpCode });
    if (data.requires2FA) return { requires2FA: true };
    setTokens(data);
    setUser(data.user);
    return { requires2FA: false };
  };

  const signup = async (payload) => {
    const data = await api.signup(payload);
    setTokens(data);
    setUser(data.user);
  };

  return (
    <AuthContext.Provider value={{ user, setUser, booting, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
