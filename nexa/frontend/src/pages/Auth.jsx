import { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

export default function Auth() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState('login');
  const [needs2FA, setNeeds2FA] = useState(false);
  const [form, setForm] = useState({ identifier: '', password: '', username: '', email: '', displayName: '', totpCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        const result = await login(form.identifier, form.password, form.totpCode || undefined);
        if (result.requires2FA) { setNeeds2FA(true); setBusy(false); return; }
      } else {
        await signup({ username: form.username, email: form.email, password: form.password, displayName: form.displayName });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="glass-card auth-card">
        <h1><img src="/logo.png" alt="" width="44" height="44" style={{borderRadius:'50%',verticalAlign:'middle',marginRight:10}} />CHEX</h1>
        <p className="sub">CONNECT. CREATE. CHAT. PLAY. THINK.</p>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          {needs2FA && (
            <div className="field">
              <label>6-digit authenticator code</label>
              <input value={form.totpCode} onChange={update('totpCode')} placeholder="123456" inputMode="numeric" maxLength={6} autoFocus required />
            </div>
          )}
          {!needs2FA && mode === 'signup' && (
            <>
              <div className="field">
                <label>Username</label>
                <input value={form.username} onChange={update('username')} placeholder="rahul" autoComplete="username" required />
              </div>
              <div className="field">
                <label>Display name</label>
                <input value={form.displayName} onChange={update('displayName')} placeholder="Rahul" />
              </div>
              <div className="field">
                <label>Email</label>
                <input type="email" value={form.email} onChange={update('email')} placeholder="you@example.com" required />
              </div>
            </>
          )}
          {mode === 'login' && !needs2FA && (
            <div className="field">
              <label>Username or email</label>
              <input value={form.identifier} onChange={update('identifier')} placeholder="rahul" autoComplete="username" required />
            </div>
          )}
          {!needs2FA && (
            <div className="field">
              <label>Password</label>
              <input type="password" value={form.password} onChange={update('password')} placeholder="••••••••" autoComplete="current-password" required />
            </div>
          )}
          <button className="btn-primary" disabled={busy} type="submit">
            {busy ? 'Please wait…' : needs2FA ? 'Verify' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
        <div className="switch-line">
          {mode === 'login' ? (
            <>New to CHEX? <button onClick={() => { setMode('signup'); setError(''); }}>Create an account</button></>
          ) : (
            <>Already have an account? <button onClick={() => { setMode('login'); setError(''); }}>Log in</button></>
          )}
        </div>
        <div className="switch-line" style={{ marginTop: 10, opacity: 1 }}>
          Demo accounts: rahul / priya / arjun — password: password123
        </div>
      </div>
    </div>
  );
}
