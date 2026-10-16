// Preloaded once for the whole suite (see package.json's `test` script:
// `node --test --require ./test/_setup.js`). Real DNS lookups aren't
// available in CI/sandboxed test environments, and every test already
// mocks fetch() itself rather than making a real request — so safeUrl.js's
// hostname-resolution check just needs a benign public IP to let a mocked
// fetch() proceed. This is NOT a bypass of the actual safety check: the
// private/internal-IP rejection logic in safeUrl.js is exercised directly
// (with its own locally-mocked dns.lookup results) by safeUrl.test.js —
// this stub only removes the real-network dependency for every other test
// that happens to fetch an ordinary-looking example.org/example.com URL.
const dns = require('dns').promises;
dns.lookup = async () => ([{ address: '93.184.216.34', family: 4 }]);
process.env.AI_SEARCH_CACHE = 'off';
