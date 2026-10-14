import { MAX_CONCURRENT_REQUESTS } from '@/shared/constants';
import type { FetchPriceResult } from '@/shared/types';

interface QueuedRequest { code: string; resolve: (result: FetchPriceResult) => void }

/** The only admission point for DLwatcher HTTP, shared by every background caller. */
export class PriceScheduler {
  private active = 0;
  private readonly queue: QueuedRequest[] = [];
  private readonly inFlight = new Map<string, Promise<FetchPriceResult>>();
  private blockedUntil = 0;
  private windowStart = 0;
  private startedInWindow = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fetcher: (code: string) => Promise<FetchPriceResult>,
    private readonly concurrency = MAX_CONCURRENT_REQUESTS,
    private readonly intervalMs = 1000,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  }

  request(code: string): Promise<FetchPriceResult> {
    const existing = this.inFlight.get(code);
    if (existing) return existing;
    let resolve!: QueuedRequest['resolve'];
    const promise = new Promise<FetchPriceResult>((done) => { resolve = done; });
    this.inFlight.set(code, promise);
    this.queue.push({ code, resolve });
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const now = Date.now();
    if (now >= this.windowStart + this.intervalMs) {
      this.windowStart = now;
      this.startedInWindow = 0;
    }
    // A very long server cooldown ends queued attempts instead of keeping the worker alive.
    if (this.blockedUntil - now > 30_000) {
      for (const item of this.queue.splice(0)) {
        this.inFlight.delete(item.code);
        item.resolve({ status: 'failed', error: 'rate_limited:上游限流，尚未请求，请稍后主动重试' });
      }
      return;
    }
    if (!this.queue.length || this.active >= this.concurrency) return;
    const delay = Math.max(this.blockedUntil - now, this.startedInWindow >= this.concurrency ? this.windowStart + this.intervalMs - now : 0);
    if (delay > 0) {
      this.timer = setTimeout(() => this.pump(), delay);
      return;
    }
    while (this.queue.length && this.active < this.concurrency && (this.intervalMs === 0 || this.startedInWindow < this.concurrency)) {
      const item = this.queue.shift()!;
      this.active++;
      this.startedInWindow++;
      void this.execute(item);
    }
    if (this.queue.length && this.active < this.concurrency) this.pump();
  }

  private async execute(item: QueuedRequest): Promise<void> {
    let result: FetchPriceResult;
    try { result = await this.fetcher(item.code); }
    catch { result = { status: 'failed', error: 'network:请求失败' }; }
    if (result.status === 'failed' && result.retryAfterMs !== undefined) {
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + result.retryAfterMs);
    }
    this.active--;
    this.inFlight.delete(item.code);
    item.resolve(result);
    this.pump();
  }
}
