import type { ProductInput } from './product';

export interface PriceRecord {
  rjCode: string;
  title: string;
  dlsiteUrl?: string;
  category?: string;
  currentPrice?: number;
  currentPriceObservedAt?: string;
  lowestPrice: number | null;
  regularPrice?: number;
  discountRate?: number;
  lastChecked?: string; // Legacy: not a trustworthy success timestamp.
  lastAttemptAt?: string;
  lastAttemptFinishedAt?: string;
  lastAttemptResult?: 'success' | 'no_data' | 'failed';
  lastErrorCode?: string;
  lastSuccessAt?: string;
  attemptSequence?: number;
  dlwatcherUrl: string;
  isFavorite: boolean; // Compatibility mirror; favorites is authoritative.
  favoriteAddedAt?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FavoriteRecord {
  rjCode: string;
  addedAt: string;
  note: string;
  noteRevision: number;
  trackingToken: string;
}

export interface TrackedRecord extends PriceRecord {
  note: string;
  noteRevision: number;
  trackingToken: string;
  addedAt: string;
}

export interface SettingRecord { key: string; value: unknown; updatedAt: string }

export type FetchPriceResult =
  | { status: 'success'; title?: string; lowestPrice: number; regularPrice?: number; discountRate?: number }
  | { status: 'no_data' }
  | { status: 'failed'; error: string; retryAfterMs?: number };

export interface PriceAttempt {
  rjCode: string;
  sequence: number;
  startedAt: string;
  trackingToken: string | null;
}

export type ItemStatus = 'success' | 'no_data' | 'failed' | 'skipped';
export interface OperationItem { rjCode: string; status: ItemStatus; error?: string }
export interface Operation {
  id: string;
  status: 'running' | 'completed';
  total: number;
  completed: number;
  success: number;
  noData: number;
  failed: number;
  skipped: number;
  items: OperationItem[];
  startedAt: string;
  finishedAt?: string;
}
export interface ImportResult { added: number; existing: number; reused: number; operationId: string }

export interface RuntimeProtocol {
  GET_IMPORT_PROTOCOL: { payload: undefined; data: { version: number } };
  GET_OR_FETCH_PRICE: { payload: ProductInput; data: PriceRecord | null };
  IMPORT_FAVORITES: { payload: { products: ProductInput[] }; data: ImportResult };
  LIST_RECORDS: { payload: undefined; data: TrackedRecord[] };
  UPDATE_ONE: { payload: { rjCode: string }; data: { operationId: string } };
  UPDATE_SELECTED: { payload: { rjCodes: string[] }; data: { operationId: string } };
  UPDATE_ALL_FAVORITES: { payload: undefined; data: { operationId: string } };
  GET_OPERATION: { payload: { id: string }; data: Operation | null };
  DELETE_TRACKED: { payload: { rjCodes: string[] }; data: { deleted: number } };
  SAVE_NOTE: { payload: { rjCode: string; note: string; revision: number; trackingToken: string }; data: FavoriteRecord };
  GET_STATS: { payload: undefined; data: { favorites: number } };
  EXPORT_CSV: { payload: undefined; data: { csv: string } };
}
export type RequestFor<K extends keyof RuntimeProtocol> = { type: K } &
  (RuntimeProtocol[K]['payload'] extends undefined ? { payload?: never } : { payload: RuntimeProtocol[K]['payload'] });
export type RuntimeRequest = { [K in keyof RuntimeProtocol]: RequestFor<K> }[keyof RuntimeProtocol];
export type RuntimeResponse<T> = { ok: true; data: T } | { ok: false; error: string };
