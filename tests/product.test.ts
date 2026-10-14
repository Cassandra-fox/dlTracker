import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProductId, parseDlsiteProductUrl, uniqueProducts } from '@/shared/product';
import { parseRequest } from '@/shared/validation';

const examples = [
  ['home', 'RJ01735938'], ['soft', 'VJ01005286'], ['app', 'RJ01723094'],
  ['ai', 'RJ01708541'], ['garumani', 'BJ01543907'], ['maniax', 'RJ01727837'],
  ['books', 'BJ03054126'],
];
for (const [category, id] of examples) {
  test(`parse ${category}/${id}`, () => {
    const url = `https://www.dlsite.com/${category}/work/=/product_id/${id}.html`;
    assert.deepEqual(parseDlsiteProductUrl(url), { rjCode: id, category, dlsiteUrl: url });
    assert.equal(parseDlsiteProductUrl(url.replace(id, id.toLowerCase()) + '/?select=RJ99999999#details')?.rjCode, id);
  });
}
test('arbitrary categories, relative URLs, canonical identity and deduplication', () => {
  const first = parseDlsiteProductUrl('/新频道-2026/work/=/product_id/vj01005286.html', 'https://www.dlsite.com/soft/mypage/wishlist')!;
  const second = parseDlsiteProductUrl('https://www.dlsite.com/other/work/=/product_id/VJ01005286.html')!;
  assert.equal(first.category, '新频道-2026');
  assert.equal(uniqueProducts([first, second]).length, 1);
  assert.equal(normalizeProductId(' vj01005286 '), 'VJ01005286');
});
test('reject malformed, unrelated or foreign product URLs', () => {
  for (const url of [
    'https://evil.example/home/work/=/product_id/RJ01735938.html',
    'https://www.dlsite.com.evil.example/home/work/=/product_id/RJ01735938.html',
    'https://www.dlsite.com@evil.example/home/work/=/product_id/RJ01735938.html',
    'https://u:p@www.dlsite.com/home/work/=/product_id/RJ01735938.html',
    'http://www.dlsite.com/home/work/=/product_id/RJ01735938.html',
    'https://www.dlsite.com:444/home/work/=/product_id/RJ01735938.html',
    'https://www.dlsite.com/search/?product_id=RJ01735938',
    'https://www.dlsite.com/home/work/=/product_id/XJ01735938.html',
    'https://www.dlsite.com/home/work/=/product_id/.html',
    'https://www.dlsite.com/home/work/=/product_id/RJ01735938.html/extra',
    'https://www.dlsite.com/home/work/=/product_id/RJ01735938x.html',
    'https://www.dlsite.com/a%2fb/work/=/product_id/RJ01735938.html',
  ]) assert.equal(parseDlsiteProductUrl(url), null, url);
});
test('message boundary validates types, identity, deduplication and limits', () => {
  const request = parseRequest({ type: 'IMPORT_FAVORITES', payload: { products: [{ rjCode: 'rj01735938' }, { rjCode: 'RJ01735938' }] } });
  assert.equal(request.type, 'IMPORT_FAVORITES');
  if (request.type === 'IMPORT_FAVORITES') assert.equal(request.payload.products.length, 1);
  assert.throws(() => parseRequest({ type: 'IMPORT_FAVORITES', payload: { products: Array.from({ length: 301 }, (_, i) => ({ rjCode: `RJ${100000 + i}` })) } }));
  assert.throws(() => parseRequest({ type: 'GET_OR_FETCH_PRICE', payload: { rjCode: 'RJ123456', currentPrice: '100' } }));
  assert.throws(() => parseRequest({ type: 'GET_OR_FETCH_PRICE', payload: { rjCode: 'RJ123456', dlsiteUrl: 'https://www.dlsite.com/home/work/=/product_id/RJ999999.html' } }));
  assert.throws(() => parseRequest({ type: 'SAVE_NOTE', payload: { rjCode: 'RJ123456', revision: 0, trackingToken: 'token', note: '字'.repeat(1001) } }));
  assert.throws(() => parseRequest(null));
});
