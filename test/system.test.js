import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
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
  assert.equal((await call(gateway, '/dashboard', { accessToken: token() })).status, 429);
  assert.equal((await call(gateway, '/health')).status, 200);
  assert.equal((await call(gateway, '/login', { method: 'POST', body: { email: 'user@example.com', password: '123456' } })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal((await call(gateway, '/dashboard', { accessToken: token() })).status, 200);
});

test('unavailable service returns consistent 502 for proxy and dashboard', async (t) => {
  const { gateway } = await setup(t, { orderServiceUrl: 'http://127.0.0.1:1' });
  for (const path of ['/orders?userId=1', '/dashboard']) {
    assert.deepEqual(await call(gateway, path, { accessToken: token() }), { status: 502, body: { error: 'Upstream service unavailable' } });
  }
});
