// Client-side shortlist shared by the Find and Compare pages. Persists a small
// list of institution ids in localStorage so a student can build a comparison
// set on one page and open it on another. Guards every access so it is safe to
// import from any Astro <script> island.
export const SHORTLIST_KEY = 'unirank.shortlist';
export const SHORTLIST_EVENT = 'unirank:shortlist';
export const SHORTLIST_MAX = 4;

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readShortlist(): string[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(SHORTLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string').slice(0, SHORTLIST_MAX);
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(SHORTLIST_KEY, JSON.stringify(ids.slice(0, SHORTLIST_MAX)));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHORTLIST_EVENT, { detail: ids.slice(0, SHORTLIST_MAX) }));
  }
}

export function hasInShortlist(id: string): boolean {
  return readShortlist().includes(id);
}

export function isShortlistFull(): boolean {
  return readShortlist().length >= SHORTLIST_MAX;
}

// Returns true if the id ended up in the shortlist after the toggle.
export function toggleShortlist(id: string): boolean {
  const current = readShortlist();
  if (current.includes(id)) {
    write(current.filter((entry) => entry !== id));
    return false;
  }
  if (current.length >= SHORTLIST_MAX) return false;
  write([...current, id]);
  return true;
}

export function removeFromShortlist(id: string): void {
  write(readShortlist().filter((entry) => entry !== id));
}

export function addManyToShortlist(ids: string[]): void {
  const merged: string[] = [];
  for (const id of [...readShortlist(), ...ids]) {
    if (id && !merged.includes(id)) merged.push(id);
  }
  write(merged.slice(0, SHORTLIST_MAX));
}

export function clearShortlist(): void {
  write([]);
}

// Fires the callback on any change from this tab (custom event) or another tab
// (storage event). Returns an unsubscribe function.
export function subscribeShortlist(callback: (ids: string[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onCustom = (): void => callback(readShortlist());
  const onStorage = (event: StorageEvent): void => {
    if (event.key === SHORTLIST_KEY) callback(readShortlist());
  };
  window.addEventListener(SHORTLIST_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SHORTLIST_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
