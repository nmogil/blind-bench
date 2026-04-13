type Listener = () => void;
const listeners = new Set<Listener>();

export function onToggleCheatSheet(fn: Listener) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function toggleCheatSheet() {
  listeners.forEach((fn) => fn());
}
