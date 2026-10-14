import './style.css';
import { MAX_IMPORT_PRODUCTS, UI_CLASSNAME } from '@/shared/constants';
import { parseDlsiteProductUrl, type ProductInput } from '@/shared/product';
import type { PriceRecord } from '@/shared/types';
import { hasPrice, priceFailureMessage } from '@/shared/price';
import { errorMessage, operationSummary, sendRuntimeMessage, waitForOperation } from '@/shared/runtime';
import { nowIso, toYen } from '@/shared/utils';
import { parseWishlistProducts } from './favorites';

function isFavoritePage(url: string): boolean { return /\/(favorites?|wishlist)(?:[/?#]|$)/i.test(url); }
function parseCurrentPrice(): number | undefined {
  const target = document.querySelector('#work_price')?.textContent;
  const match = target?.replace(/,/g, '').match(/(\d{1,9})\s*円/);
  return match ? Number(match[1]) : undefined;
}
function parseTitle(): string { return (document.querySelector('h1')?.textContent?.trim() || document.title).slice(0, 2000); }

function renderCard(host: Element, record?: PriceRecord | null, message?: string): void {
  host.querySelector(`.${UI_CLASSNAME}`)?.remove();
  const card = document.createElement('div');
  card.className = UI_CLASSNAME;
  const chip = document.createElement('span');
  chip.className = 'dltracker-chip';
  if (message || !record || !hasPrice(record)) {
    chip.textContent = message || (record?.lastAttemptResult === 'failed' ? priceFailureMessage(record.lastErrorCode) : record?.lastAttemptResult === 'no_data' ? '暂无有效史低数据' : '尚未获取史低，请在管理页更新');
    if (message !== '史低获取中...') chip.classList.add('dltracker-error');
  } else {
    const discount = typeof record.discountRate === 'number' ? ` (${record.discountRate.toFixed(1)}%OFF)` : '';
    chip.textContent = `史低：${toYen(record.lowestPrice)}${discount}`;
  }
  card.appendChild(chip);
  if (record && hasPrice(record)) {
    const link = document.createElement('a');
    link.className = 'dltracker-btn';
    link.textContent = '查看价格趋势';
    link.href = record.dlwatcherUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', (event) => event.stopPropagation());
    card.appendChild(link);
  }
  host.appendChild(card);
}

let lastUrl = location.href;
let generation = 0;
const rendered = new WeakMap<Element, string>();
function enhance(host: Element, product: ProductInput, stillMatches: () => boolean): void {
  const key = `${generation}:${product.rjCode}`;
  if (rendered.get(host) === key && host.querySelector(`.${UI_CLASSNAME}`)) return;
  rendered.set(host, key);
  const expectedGeneration = generation;
  renderCard(host, undefined, '史低获取中...');
  void sendRuntimeMessage({ type: 'GET_OR_FETCH_PRICE', payload: product }).then((record) => {
    if (host.isConnected && generation === expectedGeneration && rendered.get(host) === key && stillMatches()) renderCard(host, record);
  }).catch((error: unknown) => {
    if (host.isConnected && generation === expectedGeneration && rendered.get(host) === key && stillMatches()) renderCard(host, null, `史低获取失败：${errorMessage(error)}`);
  });
}

function injectImportBox(): void {
  if (document.querySelector('.dltracker-import-box')) return;
  const baseTitle = document.querySelector('#main_inner > div.base_title');
  const anchor = baseTitle?.parentElement || document.body;
  const box = document.createElement('div');
  box.className = 'dltracker-import-box';
  const text = document.createElement('span');
  text.textContent = 'DL Price Tracker：仅追加本页收藏列表，不含其他分页';
  const button = document.createElement('button');
  button.textContent = '导入当前页';
  const status = document.createElement('span');
  status.className = 'dltracker-import-status';
  status.setAttribute('role', 'status');
  let remaining: ProductInput[] = [];
  let snapshot = '';
  button.addEventListener('click', () => {
    void (async () => {
      button.disabled = true;
      try {
        const found = parseWishlistProducts(document, location.href);
        const identity = JSON.stringify([location.href, found.map((item) => item.rjCode)]);
        if (identity !== snapshot || !remaining.length) { remaining = found; snapshot = identity; }
        if (!remaining.length) { status.textContent = '当前收藏列表没有可识别作品；本地追踪记录保持不变'; return; }
        const batch = remaining.slice(0, MAX_IMPORT_PRODUCTS);
        status.textContent = `本次追加 ${batch.length} 个作品，剩余 ${Math.max(0, remaining.length - batch.length)} 个需下一批`;
        const result = await sendRuntimeMessage({ type: 'IMPORT_FAVORITES', payload: { products: batch } });
        remaining = remaining.slice(batch.length);
        const prefix = `新加入 ${result.added}，已存在 ${result.existing}，复用已有价格 ${result.reused}；`;
        await waitForOperation(result.operationId, (operation) => { status.textContent = prefix + operationSummary(operation); });
      } catch (error) {
        status.textContent = `导入未完成：${errorMessage(error)}`;
      } finally {
        button.disabled = false;
        button.textContent = remaining.length ? `继续导入剩余 ${remaining.length} 个` : '导入当前页';
      }
    })();
  });
  box.append(text, button, status);
  if (baseTitle) baseTitle.after(box);
  else anchor.prepend(box);
}

function scan(): void {
  if (location.href !== lastUrl) { lastUrl = location.href; generation++; }
  const product = parseDlsiteProductUrl(location.href);
  if (product) {
    const host = document.querySelector('#work_price .work_buy_container') || document.querySelector('#work_price');
    if (host) enhance(host, { ...product, title: parseTitle(), currentPrice: parseCurrentPrice(), observedAt: nowIso() },
      () => parseDlsiteProductUrl(location.href)?.rjCode === product.rjCode);
  }
  if (isFavoritePage(location.href)) {
    injectImportBox();
    for (const card of document.querySelectorAll('#wishlist_work article')) {
      const host = card.querySelector('div.primary dl dd.work_price_wrap');
      const link = card.querySelector<HTMLAnchorElement>('a[href*="product_id/"]');
      const parsed = link && parseDlsiteProductUrl(link.getAttribute('href') ?? '', location.href);
      if (!host || !parsed) continue;
      enhance(host, { ...parsed, title: link?.textContent?.trim().slice(0, 2000) || parsed.rjCode },
        () => parseDlsiteProductUrl(link?.getAttribute('href') ?? '', location.href)?.rjCode === parsed.rjCode);
    }
  }
}

let pending: ReturnType<typeof setTimeout> | undefined;
function scheduleScan(): void {
  if (pending) return;
  pending = setTimeout(() => { pending = undefined; scan(); }, 300);
}
const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('popstate', scheduleScan);
const urlTimer = setInterval(() => { if (location.href !== lastUrl) scheduleScan(); }, 500);
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  observer.disconnect();
  clearInterval(urlTimer);
  if (pending) clearTimeout(pending);
});
scan();
