import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';
import { useAuth } from '../AuthContext.jsx';
import { connectSocket } from '../socket.js';

const GAME_META = {
  'tic-tac-toe': { icon: '⭕', category: 'Board', estTime: '2–5 min', name: 'Tic-Tac-Toe' },
  'connect-four': { icon: '🔴', category: 'Board', estTime: '5–10 min', name: 'Connect Four' },
  'checkers': { icon: '⚫', category: 'Board', estTime: '10–20 min', name: 'Checkers' },
  'chess': { icon: '♞', category: 'Board', estTime: '15–40 min', name: 'Chess' },
};
function gameName(gameId) { return GAME_META[gameId]?.name || gameId; }

function TicTacToeBoard({ room, myId, onMove }) {
  const { board, turn, marks } = room.state;
  const myTurn = turn === myId && !room.state.winner;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 84px)', gap: 8, justifyContent: 'center' }}>
      {board.map((cell, i) => (
        <button key={i} onClick={() => !cell && myTurn && onMove(i)}
          style={{ width: 84, height: 84, borderRadius: 14, fontSize: 32, fontWeight: 700,
            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-soft)',
            color: cell === marks[myId] ? 'var(--violet-bright)' : 'var(--pink)',
            cursor: !cell && myTurn ? 'pointer' : 'default' }}>
          {cell}
        </button>
      ))}
    </div>
  );
}

function ConnectFourBoard({ room, myId, onMove }) {
  const { board, turn, marks } = room.state;
  const myTurn = turn === myId && !room.state.winner;
  const COLS = 7, ROWS = 6;
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: `repeat(${COLS}, 36px)`, gap: 4, background: 'rgba(124,92,255,0.12)', padding: 8, borderRadius: 12 }}>
      {Array.from({ length: ROWS * COLS }).map((_, i) => {
        const col = i % COLS;
        const cell = board[i];
        const color = cell === marks[myId] ? 'var(--violet-bright)' : cell ? 'var(--pink)' : 'rgba(255,255,255,0.08)';
        return (
          <button key={i} onClick={() => myTurn && onMove(col)} disabled={!myTurn}
            style={{ width: 36, height: 36, borderRadius: '50%', background: color, border: 'none', cursor: myTurn ? 'pointer' : 'default' }} />
        );
      })}
    </div>
  );
}

function CheckersBoard({ room, myId, onMove }) {
  const [selected, setSelected] = useState(null);
  const { board, turn, marks } = room.state;
  const myMark = marks[myId];
  const myTurn = turn === myId && !room.state.winner;

  const isMine = (piece) => piece && piece.toLowerCase() === myMark;

  const handleClick = (i) => {
    if (!myTurn) return;
    if (selected === null) {
      if (isMine(board[i])) setSelected(i);
      return;
    }
    if (i === selected) { setSelected(null); return; }
    if (isMine(board[i])) { setSelected(i); return; }
    onMove({ from: selected, to: i });
    setSelected(null);
  };

  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(8, 40px)', gap: 0, border: '2px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
      {board.map((cell, i) => {
        const row = Math.floor(i / 8), col = i % 8;
        const dark = (row + col) % 2 === 1;
        const isKing = cell && cell === cell.toUpperCase() && cell.toLowerCase() !== cell;
        return (
          <div key={i} onClick={() => dark && handleClick(i)}
            style={{
              width: 40, height: 40, background: dark ? (selected === i ? 'rgba(124,92,255,0.35)' : 'rgba(255,255,255,0.05)') : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: dark && myTurn ? 'pointer' : 'default',
            }}>
            {cell && (
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: cell.toLowerCase() === myMark ? 'var(--violet-bright)' : 'var(--pink)',
                border: isKing ? '2px solid gold' : 'none',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const CHESS_GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

// Chess board. The server stores white on rows 0–1 and files a–h as columns 0–7. Each player
// should see their own pieces at the bottom with the standard orientation (a1 bottom-left for
// white, h8 bottom-left for black), so white's view flips the ROWS and black's view flips the
// COLUMNS. (A 180° rotation for white would draw a mirror-image board with king and queen
// swapped.) `toActual` maps a displayed square back to the real board index before anything is
// sent to the server.
function ChessBoard({ room, myId, onMove }) {
  const [selected, setSelected] = useState(null); // actual board index
  const { board, turn, colors, check, winner } = room.state;
  const myColor = colors[myId];
  const myTurn = turn === myId && !winner;
  const flipped = myColor === 'w';
  const toActual = (d) => {
    const dr = Math.floor(d / 8), dc = d % 8;
    return flipped ? (7 - dr) * 8 + dc : dr * 8 + (7 - dc);
  };

  const handleClick = (displayIdx) => {
    if (!myTurn) return;
    const i = toActual(displayIdx);
    const piece = board[i];
    if (selected === null) { if (piece && piece.color === myColor) setSelected(i); return; }
    if (i === selected) { setSelected(null); return; }
    if (piece && piece.color === myColor) { setSelected(i); return; }
    onMove({ from: [Math.floor(selected / 8), selected % 8], to: [Math.floor(i / 8), i % 8] });
    setSelected(null);
  };

  const kingInCheckIdx = check ? board.findIndex(p => p && p.type === 'k' && p.color === check) : -1;
  return (
    <div>
      <div style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(8, 44px)', border: '2px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
        {Array.from({ length: 64 }, (_, d) => {
          const i = toActual(d);
          const piece = board[i];
          const row = Math.floor(d / 8), col = d % 8;
          const dark = (row + col) % 2 === 1;
          const bg = i === selected ? 'rgba(124,92,255,0.55)' : i === kingInCheckIdx ? 'rgba(255,92,147,0.55)' : dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.02)';
          return (
            <div key={d} onClick={() => handleClick(d)}
              style={{ width: 44, height: 44, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, lineHeight: 1, cursor: myTurn ? 'pointer' : 'default', userSelect: 'none' }}>
              {piece && (
                <span style={{ color: piece.color === 'w' ? '#f4f1ff' : '#150f24', textShadow: piece.color === 'w' ? '0 0 2px #000, 0 1px 3px rgba(0,0,0,0.7)' : '0 0 2px #cbb8ff, 0 0 4px rgba(203,184,255,0.7)' }}>
                  {CHESS_GLYPH[piece.type]}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-mid)' }}>
        You play {myColor === 'w' ? 'white' : 'black'}.{check && !winner ? (check === myColor ? ' ⚠️ You are in check!' : ' Check!') : ''}
        <div style={{ opacity: 1, marginTop: 4 }}>Simplified rules: no castling or en passant, and pawns always promote to a queen.</div>
      </div>
    </div>
  );
}

function RoomView({ room: initialRoom, onLeave }) {
  const { user } = useAuth();
  const [room, setRoom] = useState(initialRoom);
  const [error, setError] = useState('');
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteStatus, setInviteStatus] = useState('');

  useEffect(() => {
    const socket = connectSocket();
    const onState = (r) => { if (r.id === room.id) setRoom(r); };
    const onErr = (e) => setError(e.message);
    socket.on('game:state', onState);
    socket.on('game:error', onErr);
    socket.emit('game:join', { roomId: room.id });
    return () => { socket.off('game:state', onState); socket.off('game:error', onErr); };
    // eslint-disable-next-line
  }, [room.id]);

  const ready = () => connectSocket().emit('game:ready', { roomId: room.id });
  const move = (payload) => {
    if (payload && typeof payload === 'object') {
      connectSocket().emit('game:move', { roomId: room.id, move: payload });
    } else {
      connectSocket().emit('game:move', { roomId: room.id, cell: payload });
    }
  };
  const leave = () => { connectSocket().emit('game:leave', { roomId: room.id }); onLeave(); };
  const sendInvite = async (e) => {
    e.preventDefault();
    try {
      const res = await api.inviteToGameRoom(room.id, inviteUsername.trim());
      setInviteStatus(res.status === 'sent' ? `Invited @${inviteUsername}.` : res.message);
      setInviteUsername('');
    } catch (err) { setInviteStatus(err.message); }
  };

  const me = room.players.find(p => p.user.id === user.id);
  const isFull = room.players.length === room.capacity;
  const meta = GAME_META[room.gameId] || {};

  return (
    <div>
      <button className="btn-ghost" style={{ marginBottom: 16 }} onClick={leave}>← Leave game</button>
      <div className="glass-card" style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 4 }}>{meta.icon} {gameName(room.gameId)}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-low)', marginBottom: 18 }}>Room code: <b>{room.inviteCode}</b></div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginBottom: 20, flexWrap: 'wrap' }}>
          {room.players.map(p => (
            <div key={p.user.id} style={{ textAlign: 'center' }}>
              <Avatar user={p.user} size={44} />
              <div style={{ fontSize: 12.5, marginTop: 6 }}>{p.user.displayName}</div>
              {room.status === 'waiting' && <div style={{ fontSize: 11, color: p.ready ? 'var(--teal)' : 'var(--text-low)' }}>{p.ready ? 'Ready' : 'Not ready'}</div>}
            </div>
          ))}
          {!isFull && <div style={{ textAlign: 'center', color: 'var(--text-low)', fontSize: 12.5 }}>Waiting for a<br />second player…</div>}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {room.status === 'waiting' && !isFull && (
          <form onSubmit={sendInvite} style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14 }}>
            <input value={inviteUsername} onChange={e => setInviteUsername(e.target.value)} placeholder="Invite by username"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '8px 12px', color: 'var(--text-hi)', fontSize: 13, outline: 'none' }} />
            <button className="btn-ghost" type="submit">Invite</button>
          </form>
        )}
        {inviteStatus && <div className="request-banner" style={{ marginBottom: 14 }}>{inviteStatus}</div>}

        {room.status === 'waiting' && isFull && (
          <button className="btn-primary" style={{ width: 'auto', padding: '10px 24px' }} disabled={me?.ready} onClick={ready}>
            {me?.ready ? 'Waiting for opponent…' : "I'm ready"}
          </button>
        )}
        {room.status === 'waiting' && !isFull && (
          <div style={{ fontSize: 13, color: 'var(--text-mid)' }}>Share code <b>{room.inviteCode}</b> or invite a friend above.</div>
        )}
        {(room.status === 'active' || room.status === 'finished') && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 12 }}>
              {room.state.winner === 'draw' && "It's a draw!"}
              {room.state.winner && room.state.winner !== 'draw' && (room.state.winner === user.id ? 'You won! 🎉' : 'You lost this round.')}
              {!room.state.winner && (room.state.turn === user.id ? 'Your turn' : 'Waiting for opponent…')}
            </div>
            {room.gameId === 'tic-tac-toe' && <TicTacToeBoard room={room} myId={user.id} onMove={move} />}
            {room.gameId === 'connect-four' && <ConnectFourBoard room={room} myId={user.id} onMove={move} />}
            {room.gameId === 'checkers' && <CheckersBoard room={room} myId={user.id} onMove={move} />}
            {room.gameId === 'chess' && <ChessBoard room={room} myId={user.id} onMove={move} />}
          </>
        )}
        {room.status === 'finished' && (
          <button className="btn-ghost" style={{ marginTop: 16 }} onClick={leave}>Back to Game Store</button>
        )}
      </div>
    </div>
  );
}

function TournamentView({ tournament: initial, onBack, myId }) {
  const [t, setT] = useState(initial);
  const [error, setError] = useState('');

  const refresh = async () => setT((await api.getTournament(t.id)).tournament);
  useEffect(() => { const id = setInterval(refresh, 3000); return () => clearInterval(id); }, [t.id]);

  const start = async () => {
    setError('');
    try { setT((await api.startTournament(t.id)).tournament); } catch (err) { setError(err.message); }
  };
  const join = async () => {
    setError('');
    try { setT((await api.joinTournament(t.id)).tournament); } catch (err) { setError(err.message); }
  };

  const iJoined = t.participants.some(p => p.user.id === myId);

  return (
    <div>
      <button className="btn-ghost" style={{ marginBottom: 16 }} onClick={onBack}>← Back to Game Store</button>
      <div className="glass-card" style={{ padding: 20 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>{t.name}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-low)', marginBottom: 16 }}>{t.game.name} · {t.status}</div>
        {error && <div className="error-banner">{error}</div>}

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 6, textTransform: 'uppercase' }}>Standings</div>
          {t.participants.map(p => (
            <div key={p.user.id} className="convo-item" style={{ padding: 8 }}>
              <Avatar user={p.user} size={30} />
              <div className="last">{p.user.displayName} — {p.wins}W {p.losses}L</div>
            </div>
          ))}
        </div>

        {t.status === 'open' && !iJoined && <button className="btn-primary" style={{ width: 'auto', padding: '9px 18px' }} onClick={join}>Join tournament</button>}
        {t.status === 'open' && iJoined && t.hostId === myId && (
          <button className="btn-primary" style={{ width: 'auto', padding: '9px 18px' }} onClick={start} disabled={t.participants.length < 2}>
            {t.participants.length < 2 ? 'Need at least 2 players' : `Start (${t.participants.length} joined)`}
          </button>
        )}
        {t.status === 'open' && iJoined && t.hostId !== myId && <div style={{ fontSize: 13, color: 'var(--text-mid)' }}>Waiting for the host to start…</div>}

        {t.status !== 'open' && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 6, textTransform: 'uppercase' }}>Matches</div>
            {t.matches.map(m => (
              <div key={m.id} className="convo-item" style={{ padding: 8 }}>
                <div className="last">
                  Room {m.inviteCode} · {m.roomStatus}
                  {m.winnerId && ` · winner: ${t.participants.find(p => p.user.id === m.winnerId)?.user.displayName || '—'}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Games({ initialTab, onConsumeInitialTab }) {
  const { user } = useAuth();
  const [tab, setTab] = useState(initialTab && ['discover', 'friends', 'mine', 'tournaments'].includes(initialTab) ? initialTab : 'discover');
  const [games, setGames] = useState(null);
  const [myRooms, setMyRooms] = useState(null);
  const [friendsRooms, setFriendsRooms] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [room, setRoom] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [openTournaments, setOpenTournaments] = useState(null);
  const [myTournaments, setMyTournaments] = useState(null);

  // Deep-link support: Codex's `navigate` action can jump straight to a tab, e.g.
  // "open my tournaments" or "show my games".
  useEffect(() => {
    if (!initialTab) return;
    if (['discover', 'friends', 'mine', 'tournaments'].includes(initialTab)) setTab(initialTab);
    onConsumeInitialTab?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  const loadAll = async () => {
    const [g, mine, friends, openT, myT] = await Promise.all([
      api.games(), api.myGameRooms(), api.gamesFriendsRooms(), api.openTournaments(), api.myTournaments(),
    ]);
    setGames(g.games);
    setMyRooms(mine.rooms);
    setFriendsRooms(friends.rooms);
    setOpenTournaments(openT.tournaments);
    setMyTournaments(myT.tournaments);
  };
  useEffect(() => { loadAll(); }, []);

  const create = async (gameId) => {
    setError('');
    try {
      const res = await api.createGameRoom(gameId);
      setRoom(res.room);
    } catch (err) { setError(err.message); }
  };

  const createTournamentFor = async (gameId, gameName) => {
    setError('');
    try {
      const res = await api.createTournament(gameId, `${gameName} Tournament`);
      setTournament(res.tournament);
    } catch (err) { setError(err.message); }
  };

  const join = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api.joinGameRoom(joinCode.trim());
      setRoom(res.room);
    } catch (err) { setError(err.message); }
  };

  if (room) return <RoomView room={room} onLeave={() => { setRoom(null); loadAll(); }} />;
  if (tournament) return <TournamentView tournament={tournament} myId={user.id} onBack={() => { setTournament(null); loadAll(); }} />;

  return (
    <div>
      <h2 className="page-title">Game Store</h2>

      <div className="feed-tabs">
        <button className={tab === 'discover' ? 'active' : ''} onClick={() => setTab('discover')}>Discover</button>
        <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>Friends</button>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>My Games</button>
        <button className={tab === 'tournaments' ? 'active' : ''} onClick={() => setTab('tournaments')}>Tournaments</button>
      </div>

      {tab === 'discover' && (
        <>
          <form className="glass-card" style={{ padding: 20, marginBottom: 16 }} onSubmit={join}>
            <div style={{ fontSize: 13.5, marginBottom: 10, color: 'var(--text-mid)' }}>Have a room code?</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="e.g. XYZ123"
                style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '9px 12px', color: 'var(--text-hi)', outline: 'none', fontSize: 14, textTransform: 'uppercase' }} />
              <button className="btn-primary" style={{ width: 'auto', padding: '9px 18px' }} type="submit">Join</button>
            </div>
            {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
          </form>

          <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Board</div>
          {games === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {games?.map(g => {
            const meta = GAME_META[g.id] || {};
            return (
              <div key={g.id} className="glass-card" style={{ padding: 18, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 32 }}>{meta.icon}</div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 15.5 }}>{g.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-mid)' }}>{g.category} · {g.minPlayers}–{g.maxPlayers} players · {meta.estTime} · {g.openRooms} open room{g.openRooms === 1 ? '' : 's'}</div>
                </div>
                <button className="btn-ghost" onClick={() => createTournamentFor(g.id, g.name)}>Start tournament</button>
                <button className="btn-primary" style={{ width: 'auto', padding: '9px 18px' }} onClick={() => create(g.id)}>Play</button>
              </div>
            );
          })}

          {['Card', 'Racing', 'Arcade', 'Puzzle', 'Party'].map(cat => (
            <div key={cat} style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{cat}</div>
              <div className="empty-state" style={{ padding: 20, color: 'var(--text-low)' }}>No {cat.toLowerCase()} games in this build yet.</div>
            </div>
          ))}
        </>
      )}

      {tab === 'friends' && (
        <div>
          {friendsRooms === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {friendsRooms?.length === 0 && <div className="empty-state">No open rooms from people you follow right now.</div>}
          {friendsRooms?.map(r => {
            const meta = GAME_META[r.gameId] || {};
            const host = r.players[0]?.user;
            return (
              <div key={r.id} className="glass-card" style={{ padding: 16, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar user={host} size={38} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14 }}>{host?.displayName}'s {meta.icon} {gameName(r.gameId)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-low)' }}>Waiting for a player</div>
                </div>
                <button className="btn-ghost" onClick={async () => { const res = await api.joinGameRoom(r.inviteCode); setRoom(res.room); }}>Join</button>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'mine' && (
        <div>
          {myRooms === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {myRooms?.length === 0 && <div className="empty-state">No active games. Head to Discover to start one.</div>}
          {myRooms?.map(r => {
            const meta = GAME_META[r.gameId] || {};
            return (
              <div key={r.id} className="glass-card convo-item" style={{ padding: 14, marginBottom: 8 }} onClick={() => setRoom(r)}>
                <div className="last">{meta.icon} {gameName(r.gameId)} · room {r.inviteCode} · {r.status}</div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'tournaments' && (
        <div>
          {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ fontSize: 12, color: 'var(--text-low)', marginBottom: 8, textTransform: 'uppercase' }}>My tournaments</div>
          {myTournaments === null && <div className="empty-state"><span className="loading-dot" /></div>}
          {myTournaments?.length === 0 && <div className="empty-state" style={{ padding: 16 }}>None yet — tap "Start tournament" on a game in Discover.</div>}
          {myTournaments?.map(t => (
            <div key={t.id} className="glass-card convo-item" style={{ padding: 14, marginBottom: 8 }} onClick={() => setTournament(t)}>
              <div className="last">{t.name} · {t.game.name} · {t.status} · {t.participants.length} player{t.participants.length === 1 ? '' : 's'}</div>
            </div>
          ))}

          <div style={{ fontSize: 12, color: 'var(--text-low)', margin: '20px 0 8px', textTransform: 'uppercase' }}>Open tournaments from people you follow</div>
          {openTournaments?.length === 0 && <div className="empty-state" style={{ padding: 16 }}>None open right now.</div>}
          {openTournaments?.map(t => (
            <div key={t.id} className="glass-card convo-item" style={{ padding: 14, marginBottom: 8 }} onClick={() => setTournament(t)}>
              <div className="last">{t.name} · {t.game.name} · {t.participants.length} joined</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
