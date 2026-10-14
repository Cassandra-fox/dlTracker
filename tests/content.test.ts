import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parseWishlistProducts } from '@/content/favorites';

test('wishlist import excludes recommendations, foreign links, duplicates and query IDs', () => {
  const dom = new JSDOM(`<a href="/home/work/=/product_id/RJ999999.html">推荐</a>
    <div id="wishlist_work">
      <article><a href="/home/work/=/product_id/RJ123456.html?select=RJ888888">作品 A</a></article>
      <article><a href="/ai/work/=/product_id/rj123456.html">同编号</a></article>
      <article><a href="/soft/work/=/product_id/VJ123456.html">作品 B</a></article>
      <article><a href="https://evil.example/home/work/=/product_id/BJ123456.html">外站</a></article>
    </div><aside><a href="/home/work/=/product_id/RJ999998.html">另一个推荐</a></aside>`);
  const result = parseWishlistProducts(dom.window.document, 'https://www.dlsite.com/home/mypage/wishlist');
  assert.deepEqual(result.map((r) => r.rjCode), ['RJ123456', 'VJ123456']);
});
for (const size of [30, 50, 100]) test(`current-page import handles ${size} cards`, () => {
  const cards = Array.from({ length: size }, (_, i) => `<article><a href="/any/work/=/product_id/RJ${100000 + i}.html">作品</a></article>`).join('');
  const dom = new JSDOM(`<div id="wishlist_work">${cards}</div>`);
  assert.equal(parseWishlistProducts(dom.window.document, 'https://www.dlsite.com/').length, size);
});
test('missing container is safely empty, not a whole-document fallback', () => {
  const dom = new JSDOM('<a href="/home/work/=/product_id/RJ123456.html">推荐</a>');
  assert.deepEqual(parseWishlistProducts(dom.window.document, 'https://www.dlsite.com/'), []);
});
