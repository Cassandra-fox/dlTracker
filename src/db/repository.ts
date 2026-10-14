import type { IDBPTransaction } from 'idb';
import { getDb, type DlTrackerDB } from './index';
import type { FavoriteRecord, FetchPriceResult, PriceAttempt, PriceRecord, TrackedRecord } from '@/shared/types';
import type { ProductInput } from '@/shared/product';
import { uniqueProducts } from '@/shared/product';
import { CACHE_TTL_MS, MAX_IMPORT_PRODUCTS, MAX_NOTE_LENGTH } from '@/shared/constants';
import { emptyPrice, hasPrice, mergePriceResult } from '@/shared/price';
import { noteLength, nowIso } from '@/shared/utils';

type WriteTx = IDBPTransaction<DlTrackerDB, ['favorites', 'prices'], 'readwrite'>;
async function write<T>(callback: (tx: WriteTx) => Promise<T>): Promise<T> {
  const db = await getDb();
  const tx = db.transaction(['favorites', 'prices'], 'readwrite');
  // Observe aborts even if an individual request rejects before tx.done is awaited.
  void tx.done.catch(() => {});
  try {
    const result = await callback(tx);
    await tx.done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* It may already have aborted. */ }
    await tx.done.catch(() => {});
    throw error;
  }
}
export async function getPriceRecord(code: string): Promise<PriceRecord | undefined> { return (await getDb()).get('prices', code); }
export async function getTracking(code: string): Promise<FavoriteRecord | undefined> { return (await getDb()).get('favorites', code); }
export async function listTracking(): Promise<FavoriteRecord[]> { return (await getDb()).getAll('favorites'); }
export async function trackingCount(): Promise<number> { return (await getDb()).count('favorites'); }

export async function listTrackedRecords(): Promise<TrackedRecord[]> {
  const db = await getDb();
  const tx = db.transaction(['favorites', 'prices']);
  const result: TrackedRecord[] = [];
  for (const favorite of await tx.objectStore('favorites').getAll()) {
    const price = await tx.objectStore('prices').get(favorite.rjCode) ?? emptyPrice(favorite.rjCode, favorite.addedAt);
    result.push({ ...price, ...favorite, isFavorite: true });
  }
  await tx.done;
  return result;
}

function withMetadata(record: PriceRecord, input: ProductInput, now: string): PriceRecord {
  const next = { ...record };
  if (input.title && (!next.title || next.title === next.rjCode)) next.title = input.title;
  if (input.dlsiteUrl && !next.dlsiteUrl) {
    next.dlsiteUrl = input.dlsiteUrl;
    next.category = input.category;
  }
  if (input.currentPrice !== undefined && (!next.currentPriceObservedAt || (input.observedAt ?? now) >= next.currentPriceObservedAt)) {
    next.currentPrice = input.currentPrice;
    next.currentPriceObservedAt = input.observedAt ?? now;
  }
  return next;
}

export async function observeProduct(input: ProductInput): Promise<{ record: PriceRecord; tracking?: FavoriteRecord }> {
  return write(async (tx) => {
    const now = nowIso();
    const tracking = await tx.objectStore('favorites').get(input.rjCode);
    const existing = await tx.objectStore('prices').get(input.rjCode);
    const record = withMetadata(existing ?? emptyPrice(input.rjCode, now), input, now);
    record.isFavorite = !!tracking;
    if (!existing || JSON.stringify(record) !== JSON.stringify(existing)) {
      record.updatedAt = now;
      await tx.objectStore('prices').put(record);
    }
    return { record, tracking };
  });
}

export async function appendTrackedProducts(inputs: ProductInput[]): Promise<{ added: number; existing: number; reused: number; targets: FavoriteRecord[] }> {
  const products = uniqueProducts(inputs);
  if (products.length > MAX_IMPORT_PRODUCTS) throw new Error(`单次最多导入 ${MAX_IMPORT_PRODUCTS} 个不同作品，请分批操作`);
  return write(async (tx) => {
    let added = 0, reused = 0;
    const targets: FavoriteRecord[] = [];
    const now = nowIso();
    for (const input of products) {
      let favorite = await tx.objectStore('favorites').get(input.rjCode);
      if (!favorite) {
        favorite = { rjCode: input.rjCode, addedAt: now, note: '', noteRevision: 0, trackingToken: crypto.randomUUID() };
        await tx.objectStore('favorites').put(favorite);
        added++;
      }
      const price = withMetadata(await tx.objectStore('prices').get(input.rjCode) ?? emptyPrice(input.rjCode, now), input, now);
      await tx.objectStore('prices').put({ ...price, isFavorite: true, favoriteAddedAt: favorite.addedAt });
      if (hasPrice(price)) reused++;
      else targets.push(favorite);
    }
    return { added, existing: products.length - added, reused, targets };
  });
}

export async function beginAttempt(code: string, trackingToken: string | null): Promise<PriceAttempt | null> {
  return write(async (tx) => {
    const tracking = await tx.objectStore('favorites').get(code);
    if ((tracking?.trackingToken ?? null) !== trackingToken) return null;
    const now = nowIso();
    const price = await tx.objectStore('prices').get(code) ?? emptyPrice(code, now);
    const sequence = (price.attemptSequence ?? 0) + 1;
    await tx.objectStore('prices').put({ ...price, attemptSequence: sequence, lastAttemptAt: now, lastAttemptFinishedAt: undefined, lastAttemptResult: undefined, lastErrorCode: undefined });
    return { rjCode: code, trackingToken, sequence, startedAt: now };
  });
}

export async function commitAttempt(attempt: PriceAttempt, result: FetchPriceResult): Promise<boolean> {
  return write(async (tx) => {
    const tracking = await tx.objectStore('favorites').get(attempt.rjCode);
    const price = await tx.objectStore('prices').get(attempt.rjCode);
    if ((tracking?.trackingToken ?? null) !== attempt.trackingToken || !price) return false;
    const now = nowIso();
    const merged = mergePriceResult(price, result, now);
    if (price.attemptSequence !== attempt.sequence) {
      if (result.status !== 'success') return false;
      // An older successful observation may lower the minimum, but cannot replace
      // the newer attempt's outcome or any user/page-maintained fields.
      await tx.objectStore('prices').put({ ...price, lowestPrice: merged.lowestPrice, regularPrice: merged.regularPrice, discountRate: merged.discountRate, lastSuccessAt: now, updatedAt: now });
    } else await tx.objectStore('prices').put(merged);
    return true;
  });
}

export async function saveTrackingNote(code: string, note: string, revision: number, trackingToken: string): Promise<FavoriteRecord> {
  if (noteLength(note) > MAX_NOTE_LENGTH) throw new Error(`备注不能超过 ${MAX_NOTE_LENGTH} 字符`);
  return write(async (tx) => {
    const favorite = await tx.objectStore('favorites').get(code);
    if (!favorite || favorite.trackingToken !== trackingToken) throw new Error('作品已删除或重新加入，请刷新列表');
    if (favorite.noteRevision !== revision) throw new Error('备注已在其他页面修改；草稿已保留，请重新载入备注后确认');
    const next = { ...favorite, note, noteRevision: revision + 1 };
    await tx.objectStore('favorites').put(next);
    return next;
  });
}

export async function removeTrackedProducts(codes: string[]): Promise<number> {
  return write(async (tx) => {
    let deleted = 0;
    for (const code of new Set(codes)) {
      if (!await tx.objectStore('favorites').get(code)) continue;
      await tx.objectStore('favorites').delete(code);
      const price = await tx.objectStore('prices').get(code);
      if (price) {
        // Invalidate older attempts, retaining prices with their original expiry.
        if (hasPrice(price)) await tx.objectStore('prices').put({ ...price, isFavorite: false, favoriteAddedAt: undefined, attemptSequence: (price.attemptSequence ?? 0) + 1 });
        else await tx.objectStore('prices').delete(code);
      }
      deleted++;
    }
    return deleted;
  });
}

export async function cleanExpiredCache(now = Date.now()): Promise<number> {
  return write(async (tx) => {
    let deleted = 0;
    let cursor = await tx.objectStore('prices').openCursor();
    while (cursor) {
      const price = cursor.value;
      const stamp = price.lastAttemptResult === 'no_data' ? price.lastAttemptFinishedAt : price.lastSuccessAt;
      const expiryBase = Date.parse(stamp ?? price.createdAt);
      const recentlyAttempted = now - Date.parse(price.lastAttemptAt ?? '') < 60_000;
      if (!await tx.objectStore('favorites').get(price.rjCode) && !recentlyAttempted && (!Number.isFinite(expiryBase) || now - expiryBase >= CACHE_TTL_MS)) {
        await cursor.delete();
        deleted++;
      }
      cursor = await cursor.continue();
    }
    return deleted;
  });
}
