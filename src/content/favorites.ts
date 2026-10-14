import { parseDlsiteProductUrl, uniqueProducts, type ProductInput } from '@/shared/product';

/** Only the existing wishlist article selector is trusted; recommendations are excluded. */
export function parseWishlistProducts(root: Document, baseUrl: string): ProductInput[] {
  const products: ProductInput[] = [];
  for (const card of root.querySelectorAll('#wishlist_work article')) {
    const link = card.querySelector<HTMLAnchorElement>('a[href*="product_id/"]');
    if (!link) continue;
    const parsed = parseDlsiteProductUrl(link.getAttribute('href') ?? '', baseUrl);
    if (parsed) products.push({ ...parsed, title: link.textContent?.trim().slice(0, 2000) || parsed.rjCode });
  }
  return uniqueProducts(products);
}
