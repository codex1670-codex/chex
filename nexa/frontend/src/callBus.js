const listeners = new Set();

export function onStartCallRequest(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function requestStartCall(conversationId, type) {
  listeners.forEach(fn => fn({ conversationId, type }));
}
