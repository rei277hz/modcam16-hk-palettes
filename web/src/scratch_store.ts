// Small compatibility layer for browsers whose OPFS implementation is
// exposed but cannot create files at runtime (notably some Safari sessions).
// Files are stored as independently keyed chunks so callers can keep their
// existing streaming writes without building one large transaction payload.

const DATABASE = "modcam16-scratch";
const STORE = "chunks";
const CHUNK_BYTES = 1 << 20;

type Chunk = { name: string; offset: number; data: ArrayBuffer };

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("This browser has neither usable OPFS nor IndexedDB scratch storage."));
        return;
      }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: ["name", "offset"] });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB scratch storage."));
    });
  }
  return database;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB scratch operation failed."));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(STORE, mode);
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB scratch transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB scratch transaction aborted."));
  });
  const result = operation(tx.objectStore(STORE));
  const value = result ? await requestResult(result) : undefined;
  await complete;
  return value;
}

function keyRange(name: string): IDBKeyRange {
  return IDBKeyRange.bound([name, 0], [name, Number.MAX_SAFE_INTEGER]);
}

export async function clearIndexedDbFile(name: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const cursor = store.openCursor(keyRange(name));
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (current) { current.delete(); current.continue(); }
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Unable to clear IndexedDB scratch file."));
    tx.onabort = () => reject(tx.error ?? new Error("Unable to clear IndexedDB scratch file."));
  });
}

export async function writeIndexedDbFile(name: string, data: Uint8Array, offset: number): Promise<void> {
  if (offset === 0) await clearIndexedDbFile(name);
  for (let start = 0; start < data.byteLength; start += CHUNK_BYTES) {
    const chunk = data.subarray(start, Math.min(data.byteLength, start + CHUNK_BYTES));
    await transaction("readwrite", store => store.put({ name, offset: offset + start, data: chunk.slice().buffer } satisfies Chunk));
  }
}

export async function readIndexedDbFile(name: string, mime = "application/octet-stream"): Promise<File> {
  const chunks = await transaction("readonly", store => store.getAll(keyRange(name))) as Chunk[] | undefined;
  if (!chunks?.length) throw new Error(`Scratch file ${name} was not found.`);
  chunks.sort((a, b) => a.offset - b.offset);
  return new File(chunks.map(chunk => chunk.data), name, { type: mime });
}

export async function removeIndexedDbFile(name: string): Promise<void> {
  try { await clearIndexedDbFile(name); } catch { /* best effort cleanup */ }
}

export async function listIndexedDbFiles(): Promise<string[]> {
  const chunks = await transaction("readonly", store => store.getAllKeys()) as IDBValidKey[] | undefined;
  return [...new Set((chunks ?? []).map(key => Array.isArray(key) ? String(key[0]) : String(key)))];
}

export class IndexedDbAccess {
  constructor(private readonly name: string) {}
  private offset = 0;
  async truncate(size: number): Promise<void> { if (size === 0) await clearIndexedDbFile(this.name); }
  async write(data: Uint8Array, options?: { at: number }): Promise<number> {
    const at = options?.at ?? this.offset;
    await writeIndexedDbFile(this.name, data, at);
    this.offset = at + data.byteLength;
    return data.byteLength;
  }
  async seek(offset: number): Promise<void> { this.offset = offset; }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export async function readScratchFile(name: string, mime = "application/octet-stream"): Promise<File> {
  try {
    // An IndexedDB copy is authoritative when a previous OPFS attempt failed
    // after creating a stale/locked entry with the same name.
    return await readIndexedDbFile(name, mime);
  } catch {
    // No IndexedDB copy; continue with OPFS.
  }
  try {
    const root = await (navigator.storage as any).getDirectory();
    const handle = await root.getFileHandle(name);
    return new File([await handle.getFile()], name, { type: mime });
  } catch (opfsError) {
    throw opfsError;
  }
}

export async function removeScratchFile(name: string): Promise<void> {
  try {
    const root = await (navigator.storage as any).getDirectory();
    await root.removeEntry(name);
  } catch { /* best effort */ }
  await removeIndexedDbFile(name);
}

export async function listScratchFiles(): Promise<string[]> {
  const names = new Set<string>();
  try {
    const root = await (navigator.storage as any).getDirectory();
    for await (const [name] of root.entries()) names.add(name);
  } catch { /* use IndexedDB below */ }
  try { for (const name of await listIndexedDbFiles()) names.add(name); } catch { /* unavailable */ }
  return [...names];
}
