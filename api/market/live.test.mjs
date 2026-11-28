import assert from 'node:assert/strict';
import test from 'node:test';
import { GET, streamMarket } from './live.ts';

const owner = '00000000-0000-0000-0000-000000000001';
const key = Buffer.alloc(32);

test('live quotes require an authenticated session', async () => {
  const response = await GET(new Request('https://example.test/api/market/live?symbols=BTCUSDT'));
  assert.equal(response.status, 401);
});

test('rejects invalid requests before opening a database session', async () => {
  for (const [id, search, status] of [
    ['invalid', 'symbols=BTCUSDT', 403],
    [owner, 'symbols=', 400],
    [owner, 'symbols=AAPL&symbol=BTCUSDT&frame=1m', 400],
    [owner, 'symbols=AAPL&symbol=AAPL&frame=2y', 400],
    [owner, 'symbols=' + Array(65).fill('AAPL').join(','), 400],
  ]) {
    const response = await streamMarket(
      new Request('https://example.test/?' + search),
      id,
      '',
      key,
    );
    assert.equal(response.status, status);
  }
});
