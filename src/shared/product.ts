export interface ProductInput {
  rjCode: string;
  title?: string;
  dlsiteUrl?: string;
  category?: string;
  currentPrice?: number;
  observedAt?: string;
}

export function normalizeProductId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^(RJ|BJ|VJ)\d{6,}$/.test(code) ? code : null;
}

export function parseDlsiteProductUrl(value: string, trustedBase?: string): ProductInput | null {
  try {
    const url = new URL(value, trustedBase);
    if (url.protocol !== 'https:' || url.hostname !== 'www.dlsite.com' || url.port || url.username || url.password) return null;
    const match = url.pathname.match(/^\/([^/]+)\/work\/=\/product_id\/((?:RJ|BJ|VJ)\d{6,})\.html\/?$/i);
    if (!match) return null;
    const category = decodeURIComponent(match[1]);
    if (/[\/\\\u0000-\u001f\u007f]/.test(category) || category === '.' || category === '..') return null;
    const rjCode = normalizeProductId(match[2]);
    if (!rjCode) return null;
    return { rjCode, category, dlsiteUrl: `https://www.dlsite.com/${encodeURIComponent(category)}/work/=/product_id/${rjCode}.html` };
  } catch { return null; }
}

export function uniqueProducts(products: ProductInput[]): ProductInput[] {
  return [...new Map(products.map((product) => [product.rjCode, product])).values()];
}
