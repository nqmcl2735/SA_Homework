import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const enabled = process.env.RUN_MINIO_TESTS === '1';
const gateway = process.env.TEST_GATEWAY_URL || 'http://api-gateway:3000';
const endpoint = process.env.MINIO_PUBLIC_ENDPOINT || 'http://minio:9000';
async function ready(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service not ready: ${url}`);
}

test('MinIO and deployed services integration', { skip: !enabled, timeout: 90000 }, async (t) => {
  await t.test('health: Gateway, User, Order and real MinIO', async () => {
    for (const [url, service] of [
      [gateway, 'api-gateway'],
      [process.env.USER_SERVICE_URL, 'users'],
      [process.env.ORDER_SERVICE_URL, 'orders'],
    ]) {
      await ready(`${url}/health`);
      const response = await fetch(`${url}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', service });
    }
    await ready(`${endpoint}/minio/health/live`);
    assert.equal((await fetch(`${endpoint}/minio/health/live`)).status, 200);
  });
  const login = await fetch(`${gateway}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: '123456' }),
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json();
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  await t.test('deployed Gateway routes and aggregates both services', async () => {
    for (const path of ['/users/1', '/orders?userId=1', '/dashboard']) {
      const response = await fetch(gateway + path, { headers });
      assert.equal(response.status, 200);
      const data = await response.json();
      if (path === '/dashboard') {
        assert.equal(data.user.id, '1');
        assert.equal(data.orders.length, 2);
      }
    }
  });
  const response = await fetch(`${gateway}/users/1/avatar-upload-url`, {
    method: 'POST', headers, body: JSON.stringify({ contentType: 'image/png' }),
  });
  assert.equal(response.status, 200);
  const { uploadUrl } = await response.json();
  const url = new URL(uploadUrl);
  assert.equal(url.origin, endpoint);
  const bucket = process.env.MINIO_BUCKET;
  const key = decodeURIComponent(url.pathname.slice(`/${bucket}/`.length));
  const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY, secretAccessKey: process.env.MINIO_SECRET_KEY },
  });
  t.after(async () => {
    try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
    finally { s3.destroy(); }
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZkAAAAASUVORK5CYII=', 'base64');
  await t.test('direct presigned PUT stores exact bytes and Content-Type in MinIO', async () => {
    const upload = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
    assert.equal(upload.status, 200, await upload.text());
    const stored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    assert.equal(stored.ContentType, 'image/png');
    assert.deepEqual(Buffer.from(await stored.Body.transformToByteArray()), png);
  });
  await t.test('wrong Content-Type is rejected by MinIO', async () => {
    const result = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: png });
    assert.equal(result.status, 403, await result.text());
  });
  await t.test('changing the object key invalidates the signature', async () => {
    const changed = new URL(uploadUrl);
    changed.pathname += '-other';
    const result = await fetch(changed, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
    assert.equal(result.status, 403, await result.text());
  });
  await t.test('unsigned GET cannot read a private avatar', async () => {
    const result = await fetch(`${endpoint}/${bucket}/${key}`);
    assert.equal(result.status, 403, await result.text());
  });
});
