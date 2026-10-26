const test = require('node:test');
const assert = require('node:assert/strict');
const { urlKey } = require('../server/lib/urlKey');

test('urlKey treats scheme, www, trailing slash and tracking params as the same page', () => {
  const base = urlKey('https://brill.com/view/journals/ifam/28/1/article-p19_2.xml?language=en');
  assert.equal(urlKey('https://brill.com/view/journals/ifam/28/1/article-p19_2.xml?language=en&srsltid=AU7gw4Vq'), base);
  assert.equal(urlKey('http://www.fnbnews.com/Top-News/a-1'), urlKey('https://fnbnews.com/Top-News/a-1/'));
  assert.equal(urlKey('https://v.daum.net/v/2026?f=p'), urlKey('https://v.daum.net/v/2026'));
  assert.equal(urlKey('https://x.com/a#frag'), urlKey('https://x.com/a'));
});

test('urlKey keeps identifying query params apart', () => {
  assert.notEqual(urlKey('https://www.eia.gov/todayinenergy/detail.php?id=1'), urlKey('https://www.eia.gov/todayinenergy/detail.php?id=2'));
  assert.notEqual(urlKey('https://www.youtube.com/watch?v=a'), urlKey('https://www.youtube.com/watch?v=b'));
});
