import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FavoriteRecord, PriceRecord, SettingRecord } from '@/shared/types';
import { emptyPrice } from '@/shared/price';
import { nowIso } from '@/shared/utils';

export interface DlTrackerDB extends DBSchema {
  prices: {
    key: string;
    value: PriceRecord;
    indexes: { 'by-lastChecked': string; 'by-lowestPrice': number; 'by-updatedAt': string; 'by-isFavorite': number };
  };
  favorites: { key: string; value: FavoriteRecord; indexes: { 'by-addedAt': string } };
  settings: { key: string; value: SettingRecord; indexes: { 'by-updatedAt': string } };
}
const DB_VERSION = 3;
let dbPromise: Promise<IDBPDatabase<DlTrackerDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<DlTrackerDB>> {
  if (!dbPromise) {
    const opening = openDB<DlTrackerDB>('dltracker', DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const prices = db.createObjectStore('prices', { keyPath: 'rjCode' });
          prices.createIndex('by-lastChecked', 'lastChecked');
          prices.createIndex('by-lowestPrice', 'lowestPrice');
        }
        if (oldVersion < 2) {
          const prices = tx.objectStore('prices');
          prices.createIndex('by-updatedAt', 'updatedAt');
          db.createObjectStore('favorites', { keyPath: 'rjCode' }).createIndex('by-addedAt', 'addedAt');
          db.createObjectStore('settings', { keyPath: 'key' }).createIndex('by-updatedAt', 'updatedAt');
        }
        if (oldVersion < 3) {
          // Only IDB promises are awaited within this versionchange transaction.
          void (async () => {
            const prices = tx.objectStore('prices');
            const favorites = tx.objectStore('favorites');
            if (prices.indexNames.contains('by-isFavorite')) prices.deleteIndex('by-isFavorite');
            const now = nowIso();
            for (const record of await prices.getAll()) {
              if (record.isFavorite && !await favorites.get(record.rjCode)) {
                await favorites.put({ rjCode: record.rjCode, addedAt: record.favoriteAddedAt || now, note: '', noteRevision: 0, trackingToken: crypto.randomUUID() });
              }
            }
            for (const favorite of await favorites.getAll()) {
              const next = { ...favorite, note: favorite.note ?? '', noteRevision: favorite.noteRevision ?? 0, trackingToken: favorite.trackingToken || crypto.randomUUID() };
              await favorites.put(next);
              const price = await prices.get(favorite.rjCode) ?? emptyPrice(favorite.rjCode, now);
              await prices.put({ ...price, isFavorite: true, favoriteAddedAt: next.addedAt });
            }
          })().catch(() => { tx.abort(); });
        }
      },
      blocking() { void closeDb(); },
      terminated() { dbPromise = null; },
    });
    dbPromise = opening;
    void opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
  }
  return dbPromise;
}

export async function closeDb(): Promise<void> {
  const opening = dbPromise;
  dbPromise = null;
  try { (await opening)?.close(); } catch { /* A failed opening is already reported to its caller. */ }
}
