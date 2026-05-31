/**
 * Source-Filter Recordings — IndexedDB wrapper
 * Stores user voice recordings locally. No server, no account.
 */

const DB_NAME = 'sourcefilter-recordings';
const DB_VERSION = 1;
const STORE = 'recordings';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const os = db.createObjectStore(STORE, { keyPath: 'id' });
                os.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function tx(mode) {
    return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function reqToPromise(req) {
    return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

const RecordingsDB = {
    async save({ blob, durationMs, mimeType, sampleRate }) {
        const id = (crypto.randomUUID && crypto.randomUUID()) || `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record = {
            id,
            createdAt: Date.now(),
            durationMs,
            mimeType,
            sampleRate,
            blob,
            label: ''
        };
        const store = await tx('readwrite');
        await reqToPromise(store.add(record));
        return record;
    },

    async list() {
        const store = await tx('readonly');
        const all = await reqToPromise(store.getAll());
        return all.sort((a, b) => b.createdAt - a.createdAt);
    },

    async get(id) {
        const store = await tx('readonly');
        return reqToPromise(store.get(id));
    },

    async remove(id) {
        const store = await tx('readwrite');
        return reqToPromise(store.delete(id));
    },

    async updateLabel(id, label) {
        const store = await tx('readwrite');
        const rec = await reqToPromise(store.get(id));
        if (!rec) return null;
        rec.label = label;
        await reqToPromise(store.put(rec));
        return rec;
    },

    async estimate() {
        if (navigator.storage && navigator.storage.estimate) {
            return navigator.storage.estimate();
        }
        return null;
    }
};

window.RecordingsDB = RecordingsDB;
