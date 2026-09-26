/**
 * Rendered model posters, kept in IndexedDB (per browser profile) so a board
 * of models opens showing them without loading a single model. Keyed by the
 * model URL + everything that changes the render (the view settings); the
 * render size is stored so a too-small poster can be sharpened later.
 * Best effort throughout: any failure just means rendering again.
 */

const DB = 'refthing-model-posters';
const STORE = 'posters';
/** Entries kept; the least recently written go first past this. */
const MAX_ENTRIES = 600;

type Poster = { key: string; blob: Blob; width: number; height: number; at: number };

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('at', 'at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  opened.catch(() => {
    opened = null;
  });
  return opened;
}

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

export async function readPoster(key: string): Promise<Poster | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as Poster | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

let writes = 0;

export async function writePoster(
  key: string,
  blob: Blob,
  width: number,
  height: number,
): Promise<void> {
  const db = await open();
  const existing = await readPoster(key);
  // Never replace a sharper poster of the same view with a smaller one.
  if (existing && existing.width * existing.height > width * height) return;
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).put({ key, blob, width, height, at: Date.now() } as Poster);
  await done(transaction);
  writes += 1;
  if (writes % 50 === 0) await prune(db);
}

async function prune(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  const count = await new Promise<number>((resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let excess = count - MAX_ENTRIES;
  if (excess > 0) {
    const cursor = store.index('at').openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current || excess <= 0) return;
      current.delete();
      excess -= 1;
      current.continue();
    };
  }
  await done(transaction);
}
