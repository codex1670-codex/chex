let current = { screen: 'feed' };

export function setCodexContext(partial) {
  current = { ...partial };
}

export function updateCodexContext(partial) {
  current = { ...current, ...partial };
}

export function getCodexContext() {
  return current;
}
