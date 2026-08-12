// Tiny IndexedDB-backed store for `FileSystemDirectoryHandle`s. The File
// System Access API deliberately never hands the page a real path string
// back (that would leak local filesystem layout), so this is how a picked
// folder survives a reload: the handle itself is structured-cloneable,
// and IndexedDB is one of the few browser stores the spec guarantees can
// hold one (`localStorage`/cookies are string-only).

const DB_NAME = "dendroid-fs-handles";
const STORE_NAME = "workspaces";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

/** Keyed by `handle.name` — see `dialog.ts`'s `pickFolder`, which uses
 * that same name as the `DocBackend` workspace identifier, so this
 * lookup and the settings store's `rootPath` string always agree. */
export async function putWorkspaceHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(handle, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}

export async function getWorkspaceHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  try {
    const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      req.onerror = () => reject(req.error as Error);
    });
    return handle ?? null;
  } finally {
    db.close();
  }
}
