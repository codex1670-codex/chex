import { useEffect, useRef, useState } from 'react';
import { getSocket } from '../socket.js';
import { onStartCallRequest } from '../callBus.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Call phases: idle -> ringing-out (we called) | ringing-in (incoming) -> connecting -> active -> idle
export default function CallLayer() {
  const [phase, setPhase] = useState('idle');
  const [incoming, setIncoming] = useState(null); // { callId, type, caller }
  const [callId, setCallId] = useState(null);
  const [callType, setCallType] = useState('voice');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const conversationIdRef = useRef(null);
  const isCallerRef = useRef(false);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const cleanupCall = () => {
      pcRef.current?.close();
      pcRef.current = null;
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
      setPhase('idle');
      setIncoming(null);
      setCallId(null);
      setMuted(false);
      setCameraOff(false);
    };

    const setupPeerConnection = async (targetType) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: targetType === 'video' });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.ontrack = (e) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('call:signal', { callId: callId, data: { kind: 'ice', candidate: e.candidate } });
      };
      pcRef.current = pc;
      return pc;
    };

    const onIncoming = (data) => {
      setIncoming(data);
      setCallType(data.type);
      setCallId(data.callId);
      conversationIdRef.current = data.conversationId;
      setPhase('ringing-in');
    };

    const onRinging = () => setPhase('ringing-out');

    const onAccepted = async () => {
      setPhase('connecting');
      if (isCallerRef.current) {
        try {
          const pc = await setupPeerConnection(callType);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('call:signal', { callId, data: { kind: 'offer', sdp: offer } });
        } catch (err) {
          setError('Could not access camera/microphone: ' + err.message);
        }
      }
    };

    const onSignal = async ({ data }) => {
      let pc = pcRef.current;
      if (data.kind === 'offer') {
        if (!pc) pc = await setupPeerConnection(callType);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:signal', { callId, data: { kind: 'answer', sdp: answer } });
        setPhase('active');
      } else if (data.kind === 'answer') {
        await pc?.setRemoteDescription(new RTCSessionDescription(data.sdp));
        setPhase('active');
      } else if (data.kind === 'ice' && pc) {
        try { await pc.addIceCandidate(data.candidate); } catch { /* benign race, ignore */ }
      }
    };

    const onDeclined = () => { setError('Call declined.'); cleanupCall(); };
    const onEnded = () => cleanupCall();
    const onMissed = () => { setError('No answer.'); cleanupCall(); };
    const onCallError = (e) => setError(e.message);

    socket.on('call:incoming', onIncoming);
    socket.on('call:ringing', onRinging);
    socket.on('call:accepted', onAccepted);
    socket.on('call:signal', onSignal);
    socket.on('call:declined', onDeclined);
    socket.on('call:ended', onEnded);
    socket.on('call:missed', onMissed);
    socket.on('call:error', onCallError);

    const unsubscribeStart = onStartCallRequest(({ conversationId, type }) => {
      isCallerRef.current = true;
      conversationIdRef.current = conversationId;
      setCallType(type);
      setError('');
      socket.emit('call:invite', { conversationId, type });
    });

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:ringing', onRinging);
      socket.off('call:accepted', onAccepted);
      socket.off('call:signal', onSignal);
      socket.off('call:declined', onDeclined);
      socket.off('call:ended', onEnded);
      socket.off('call:missed', onMissed);
      socket.off('call:error', onCallError);
      unsubscribeStart();
    };
    // eslint-disable-next-line
  }, [callId, callType]);

  const acceptIncoming = () => {
    isCallerRef.current = false;
    getSocket()?.emit('call:accept', { callId: incoming.callId });
    setPhase('connecting');
  };
  const declineIncoming = () => {
    getSocket()?.emit('call:decline', { callId: incoming.callId });
    setPhase('idle');
    setIncoming(null);
  };
  const endCall = () => {
    getSocket()?.emit('call:end', { callId });
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    setPhase('idle');
  };
  const toggleMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMuted(!track.enabled); }
  };
  const toggleCamera = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setCameraOff(!track.enabled); }
  };

  if (phase === 'idle' && !error) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,10,0.95)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="glass-card" style={{ width: 380, maxWidth: '92vw', padding: 24, textAlign: 'center' }}>
        {error && (
          <div className="error-banner" style={{ marginBottom: 14 }}>
            {error}
            <button className="btn-ghost" style={{ display: 'block', margin: '10px auto 0' }} onClick={() => setError('')}>Dismiss</button>
          </div>
        )}

        {phase === 'ringing-in' && incoming && !error && (
          <>
            <div style={{ fontSize: 16, marginBottom: 6 }}>{incoming.caller.displayName}</div>
            <div style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 20 }}>Incoming {incoming.type} call…</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button className="btn-ghost" style={{ color: 'var(--pink-ink)' }} onClick={declineIncoming}>Decline</button>
              <button className="btn-primary" style={{ width: 'auto', padding: '9px 20px' }} onClick={acceptIncoming}>Accept</button>
            </div>
          </>
        )}

        {phase === 'ringing-out' && !error && (
          <>
            <div style={{ fontSize: 15, marginBottom: 16 }}>Calling…</div>
            <button className="btn-ghost" style={{ color: 'var(--pink-ink)' }} onClick={endCall}>Cancel</button>
          </>
        )}

        {(phase === 'connecting' || phase === 'active') && !error && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 10 }}>{phase === 'connecting' ? 'Connecting…' : 'On call'}</div>
            {callType === 'video' && (
              <div style={{ position: 'relative', background: '#000', borderRadius: 12, overflow: 'hidden', marginBottom: 16, height: 220 }}>
                <video ref={remoteVideoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <video ref={localVideoRef} autoPlay playsInline muted style={{ position: 'absolute', bottom: 8, right: 8, width: 80, borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)' }} />
              </div>
            )}
            {callType === 'voice' && <audio ref={remoteVideoRef} autoPlay />}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn-ghost" onClick={toggleMute}>{muted ? '🔇 Unmute' : '🎙 Mute'}</button>
              {callType === 'video' && <button className="btn-ghost" onClick={toggleCamera}>{cameraOff ? '📷 Camera on' : '📷 Camera off'}</button>}
              <button className="btn-ghost" style={{ color: 'var(--pink-ink)' }} onClick={endCall}>End call</button>
            </div>
            <div className="codex-hint" style={{ marginTop: 12 }}>STUN-only signaling — works on the same network/localhost; a production deployment would need a TURN server for calls across restrictive NATs.</div>
          </>
        )}
      </div>
    </div>
  );
}
