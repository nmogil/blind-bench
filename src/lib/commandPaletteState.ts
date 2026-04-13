type Listener = () => void;
const listeners = new Set<Listener>();

export function onToggleCommandPalette(fn: Listener) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function toggleCommandPalette() {
  listeners.forEach((fn) => fn());
}
