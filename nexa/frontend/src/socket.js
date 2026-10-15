import { io } from 'socket.io-client';
import { getAccessToken } from './api.js';

let socket = null;

export function connectSocket() {
  if (socket) return socket;
  socket = io('/', { auth: { token: getAccessToken() } });
  return socket;
}

export function getSocket() { return socket; }

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
