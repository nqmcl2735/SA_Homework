import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import express from 'express';
import { createUserApp } from '../user-service/app.js';
import { createOrderApp } from '../order-service/app.js';
import { createGatewayApp } from '../api-gateway/app.js';

const auth = { secret: 'test-secret', issuer: 'test-users', audience: 'test-api' };
const minio = { publicEndpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'avatars', accessKey: 'test-access', secretKey: 'test-secret' };
async function listen(app, t) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, options = {}) {
  const users = await listen(createUserApp({ auth, minio }), t);
  const orders = await listen(createOrderApp(), t);
  const gateway = await listen(createGatewayApp({ auth, userServiceUrl: users, orderServiceUrl: orders, ...options }), t);
  return { users, orders, gateway };
}
function token(sub = '1', options = {}) {
  return jwt.sign({}, auth.secret, { subject: sub, issuer: auth.issuer, audience: auth.audience, expiresIn: '15m', ...options });
}
async function call(base, path, { accessToken, body, headers, ...options } = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test('health, login, routing and dashboard use the authenticated user', async (t) => {
  const { users, orders, gateway } = await setup(t);
  for (const [base, service] of [[users, 'users'], [orders, 'orders'], [gateway, 'api-gateway']]) {
    assert.deepEqual((await call(base, '/health')).body, { status: 'ok', service });
  }
  assert.equal((await call(gateway, '/login', { method: 'POST', body: { email: 'user@example.com', password: 'wrong' } })).status, 401);
  const login = await call(gateway, '/login', { method: 'POST', body: { email: 'user@example.com', password: '123456' } });
  assert.equal(login.status, 200);
  const claims = jwt.verify(login.body.accessToken, auth.secret, { issuer: auth.issuer, audience: auth.audience, algorithms: ['HS256'] });
  assert.equal(jwt.decode(login.body.accessToken, { complete: true }).header.alg, 'HS256');
  assert.equal(claims.sub, '1');
  assert.equal(claims.exp - claims.iat, 900);
  const options = { accessToken: login.body.accessToken, headers: { 'x-auth-user-id': '2' } };
  const user = await call(gateway, '/users/1', options);
  assert.equal(user.body.id, '1');
  assert.equal(user.body.password, undefined);
  const orderList = await call(gateway, '/orders?userId=1', options);
  assert.equal(orderList.body.orders.length, 2);
  assert.deepEqual((await call(gateway, '/dashboard?userId=2', options)).body, { user: user.body, orders: orderList.body.orders });
  assert.deepEqual((await call(gateway, '/orders?userId=2', { accessToken: token('2') })).body, { orders: [] });
});

test('reject invalid JWT claims, signature, algorithm and absent identity', async (t) => {
  const { gateway, users, orders } = await setup(t);
  const invalid = [undefined, 'bad', token('1', { expiresIn: -1 }), token('1', { issuer: 'wrong' }), token('1', { audience: 'wrong' }), token('1', { algorithm: 'HS384' }), jwt.sign({ sub: '1', iss: auth.issuer, aud: auth.audience }, auth.secret), jwt.sign({ sub: '1' }, 'wrong-secret')];
  for (const accessToken of invalid) assert.equal((await call(gateway, '/dashboard', { accessToken, headers: { 'x-auth-user-id': '1' } })).status, 401);
  assert.equal((await call(users, '/users/1')).status, 401);
  assert.equal((await call(orders, '/orders?userId=1')).status, 401);
});

test('deny other users, validate input and return missing user', async (t) => {
  const { gateway } = await setup(t);
  const options = { accessToken: token() };
  assert.equal((await call(gateway, '/users/2', options)).status, 403);
  assert.equal((await call(gateway, '/orders?userId=2', options)).status, 403);
  assert.equal((await call(gateway, '/orders', options)).status, 400);
  assert.equal((await call(gateway, '/orders?userId=1&userId=2', options)).status, 400);
  assert.equal((await call(gateway, '/users/99', { accessToken: token('99') })).status, 404);
  assert.equal((await call(gateway, '/users/2/avatar-upload-url', { ...options, method: 'POST', body: { contentType: 'image/png' } })).status, 403);
});

test('presigned PUT URL expires in 300 seconds and signs content-type', async (t) => {
  const { gateway } = await setup(t);
  for (const contentType of ['image/png', 'image/jpeg', 'image/webp']) {
    const response = await call(gateway, '/users/1/avatar-upload-url', { accessToken: token(), method: 'POST', body: { contentType } });
    assert.equal(response.status, 200);
    assert.equal(response.body.method, 'PUT');
    assert.equal(response.body.expiresIn, 300);
    assert.equal(response.body.contentType, contentType);
    const url = new URL(response.body.uploadUrl);
    assert.match(url.pathname, /^\/avatars\/avatars\/1\//);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.ok(url.searchParams.get('X-Amz-SignedHeaders').split(';').includes('content-type'));
  }
  for (const contentType of ['text/plain', 'image/svg+xml', 'toString']) {
    assert.equal((await call(gateway, '/users/1/avatar-upload-url', { accessToken: token(), method: 'POST', body: { contentType } })).status, 400);
  }
});

test('shared protected limiter allows 10 requests per second and resets', async (t) => {
  const { gateway } = await setup(t);
  const paths = ['/users/1', '/orders?userId=1', '/dashboard'];
  for (let i = 0; i < 10; i++) assert.equal((await call(gateway, paths[i % 3], { accessToken: token() })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await call(gateway, '/dashboard', { accessToken: token(), headers: { 'x-forwarded-for': `192.0.2.${i + 1}` } })).status, 429);
  assert.equal((await call(gateway, '/health')).status, 200);
  assert.equal((await call(gateway, '/login', { method: 'POST', body: { email: 'user@example.com', password: '123456' } })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal((await call(gateway, '/dashboard', { accessToken: token() })).status, 200);
});

test('order failure preserves user data with 206; proxy still returns 502', async (t) => {
  const { gateway } = await setup(t, { orderServiceUrl: 'http://127.0.0.1:1' });
  assert.equal((await call(gateway, '/orders?userId=1', { accessToken: token() })).status, 502);
  const response = await call(gateway, '/dashboard', { accessToken: token() });
  assert.equal(response.status, 206);
  assert.equal(response.body.user.id, '1');
  assert.equal(response.body.orders, null);
  assert.deepEqual(response.body.errors, { orders: 'Order service unavailable' });
});

test('user failure preserves orders including an empty list', async (t) => {
  const { gateway } = await setup(t, { userServiceUrl: 'http://127.0.0.1:1' });
  for (const id of ['1', '2']) {
    const response = await call(gateway, '/dashboard', { accessToken: token(id) });
    assert.equal(response.status, 206);
    assert.equal(response.body.user, null);
    assert.equal(response.body.orders.length, id === '1' ? 2 : 0);
    assert.deepEqual(response.body.errors, { user: 'User service unavailable' });
  }
});

test('both services unavailable return 502', async (t) => {
  const { gateway } = await setup(t, { userServiceUrl: 'http://127.0.0.1:1', orderServiceUrl: 'http://127.0.0.1:1' });
  assert.deepEqual(await call(gateway, '/dashboard', { accessToken: token() }), {
    status: 502, body: { error: 'Upstream service unavailable' },
  });
});

test('HTTP errors, invalid JSON and invalid data produce partial results', async (t) => {
  const broken = express();
  broken.get('/orders', (req, res) => {
    if (req.query.userId === '1') return res.status(503).json({ orders: [] });
    if (req.query.userId === '2') return res.type('json').send('invalid json');
    res.json({ unexpected: [] });
  });
  const orderServiceUrl = await listen(broken, t);
  const { gateway } = await setup(t, { orderServiceUrl });
  for (const id of ['1', '2']) {
    const response = await call(gateway, '/dashboard', { accessToken: token(id) });
    assert.equal(response.status, 206);
    assert.equal(response.body.user.id, id);
    assert.equal(response.body.orders, null);
  }
  // Both the missing user and malformed order payload must fail.
  assert.equal((await call(gateway, '/dashboard', { accessToken: token('3') })).status, 502);
});

test('dashboard starts both calls concurrently and times out a stalled body after 5s', async (t) => {
  let releaseUser;
  const userRequested = new Promise((resolve) => { releaseUser = resolve; });
  let releaseOrders;
  const ordersRequested = new Promise((resolve) => { releaseOrders = resolve; });
  const users = express();
  users.get('/users/1', async (req, res) => {
    releaseUser();
    await ordersRequested;
    res.json({ id: '1', name: 'Test User' });
  });
  const orders = express();
  orders.get('/orders', async (req, res) => {
    releaseOrders();
    await userRequested;
    res.type('json').write('{"orders":');
    // Leave the body unfinished to verify timeout also covers reading JSON.
  });
  const userServiceUrl = await listen(users, t);
  const orderServiceUrl = await listen(orders, t);
  const { gateway } = await setup(t, { userServiceUrl, orderServiceUrl });
  const started = performance.now();
  const response = await call(gateway, '/dashboard', { accessToken: token() });
  const elapsed = performance.now() - started;
  assert.equal(response.status, 206);
  assert.equal(response.body.user.id, '1');
  assert.equal(response.body.orders, null);
  assert.ok(elapsed >= 4800 && elapsed < 7500, `Elapsed: ${elapsed}ms`);
});

test('login rejects missing fields, unknown account and malformed JSON', async (t) => {
  const { gateway } = await setup(t);
  for (const body of [{}, { email: 'user@example.com' }, { email: 1, password: '123456' }]) {
    assert.equal((await call(gateway, '/login', { method: 'POST', body })).status, 400);
  }
  assert.deepEqual(await call(gateway, '/login', { method: 'POST', body: { email: 'unknown@example.com', password: '123456' } }), {
    status: 401, body: { error: 'Invalid credentials' },
  });
  const malformed = await fetch(gateway + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON' });
});

test('body limit is 32 KB for all apps, including a payload over 100 KB', async (t) => {
  const { gateway, users, orders } = await setup(t);
  for (const base of [gateway, users, orders]) {
    for (const size of [33 * 1024, 101 * 1024]) {
      assert.equal((await call(base, '/login', { method: 'POST', body: { padding: 'x'.repeat(size) } })).status, 413);
    }
  }
});

test('unknown routes return 404 and framework header is hidden', async (t) => {
  const { gateway, users, orders } = await setup(t);
  for (const base of [gateway, users, orders]) {
    for (const path of ['/health', '/not-found']) {
      const response = await fetch(base + path);
      assert.equal(response.status, path === '/health' ? 200 : 404);
      assert.equal(response.headers.has('x-powered-by'), false);
    }
  }
  assert.equal((await call(gateway, '/orders', { method: 'POST', accessToken: token(), body: { userId: '2' } })).status, 404);
});

test('all business routes require JWT and client identity cannot bypass it', async (t) => {
  const { gateway } = await setup(t);
  for (const [path, method] of [['/users/1', 'GET'], ['/orders?userId=1', 'GET'], ['/dashboard', 'GET'], ['/users/1/avatar-upload-url', 'POST']]) {
    for (const authorization of ['', 'Basic abc']) {
      const result = await call(gateway, path, { method, headers: { authorization, 'x-auth-user-id': '1' } });
      assert.equal(result.status, 401);
      assert.equal(result.body.error, 'Invalid or missing access token');
    }
  }
});

test('JWT without sub or with blank sub is rejected', async (t) => {
  const { gateway } = await setup(t);
  for (const subject of [undefined, ' ']) {
    const accessToken = jwt.sign({}, auth.secret, { issuer: auth.issuer, audience: auth.audience, expiresIn: '15m', ...(subject ? { subject } : {}) });
    assert.equal((await call(gateway, '/dashboard', { accessToken })).status, 401);
  }
});

test('login has its own 10 requests per second limiter', async (t) => {
  const { gateway } = await setup(t);
  // Invalid field types keep this burst fast and still count toward the limit.
  for (let i = 0; i < 12; i++) {
    const result = await call(gateway, '/login', { method: 'POST', body: {} });
    assert.equal(result.status, i < 10 ? 400 : 429);
  }
  assert.equal((await call(gateway, '/dashboard', { accessToken: token() })).status, 200);
});

test('missing avatar MIME is invalid and generated object keys are distinct', async (t) => {
  const { gateway } = await setup(t);
  const options = { accessToken: token(), method: 'POST' };
  assert.equal((await call(gateway, '/users/1/avatar-upload-url', { ...options, body: {} })).status, 400);
  const first = await call(gateway, '/users/1/avatar-upload-url', { ...options, body: { contentType: 'image/png' } });
  const second = await call(gateway, '/users/1/avatar-upload-url', { ...options, body: { contentType: 'image/png' } });
  assert.notEqual(new URL(first.body.uploadUrl).pathname, new URL(second.body.uploadUrl).pathname);
});
