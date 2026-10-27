import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import { createUserApp } from '../user-service/app.js';
import { createOrderApp } from '../order-service/app.js';
import { createGatewayApp } from '../api-gateway/app.js';

const count = 20;
const warmup = 5;
const gapMs = 150;
const servers = [];
const auth = { secret: 'benchmark-only-secret', issuer: 'benchmark-users', audience: 'benchmark-api' };
async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

try {
  const users = await listen(createUserApp({ auth, minio: {
    publicEndpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'benchmark',
    accessKey: 'benchmark-access', secretKey: 'benchmark-secret',
  } }));
  const orders = await listen(createOrderApp());
  const gateway = await listen(createGatewayApp({ auth, userServiceUrl: users, orderServiceUrl: orders }));
  const accessToken = jwt.sign({}, auth.secret, {
    algorithm: 'HS256', subject: '1', issuer: auth.issuer, audience: auth.audience, expiresIn: '15m',
  });
  const directHeaders = { 'x-auth-user-id': '1' };
  const gatewayHeaders = { authorization: `Bearer ${accessToken}` };
  const checkUser = (data) => assert.equal(data.id, '1');
  const checkOrders = (data) => {
    assert.equal(data.orders.length, 2);
    assert.ok(data.orders.every((order) => order.userId === '1'));
  };
  const routes = [
    { name: 'Direct → User service', url: `${users}/users/1`, headers: directHeaders, check: checkUser },
    { name: 'Client → Gateway → User service', url: `${gateway}/users/1`, headers: gatewayHeaders, check: checkUser },
    { name: 'Direct → Order service', url: `${orders}/orders?userId=1`, headers: directHeaders, check: checkOrders },
    { name: 'Client → Gateway → Order service', url: `${gateway}/orders?userId=1`, headers: gatewayHeaders, check: checkOrders },
    { name: 'Client → Gateway → Dashboard', url: `${gateway}/dashboard`, headers: gatewayHeaders, check: (data) => { checkUser(data.user); checkOrders(data); } },
  ];
  async function measure(route) {
    const start = performance.now();
    const response = await fetch(route.url, { headers: route.headers, signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    const elapsed = performance.now() - start;
    // Reject failed requests rather than presenting 429/502 latency as successful traffic.
    assert.equal(response.status, 200, `${route.name}: ${response.status} ${body}`);
    route.check(JSON.parse(body));
    return elapsed;
  }
  const results = [];
  for (const route of routes) {
    for (let i = 0; i < warmup; i++) {
      await measure(route);
      await sleep(gapMs);
    }
    const samples = [];
    for (let i = 0; i < count; i++) {
      samples.push(await measure(route));
      await sleep(gapMs);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    results.push({ route: route.name, requests: count, meanMs: samples.reduce((sum, value) => sum + value, 0) / count,
      p95Ms: sorted[Math.ceil(0.95 * count) - 1], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: samples });
    console.log(`Completed ${route.name}: ${count}/${count} HTTP 200`);
  }
  const measuredAt = new Date().toISOString();
  const environment = { node: process.version, os: platform(), arch: arch(), cpu: cpus()[0]?.model,
    mode: 'HTTP loopback; client and three Express apps in one Node.js process; not Docker' };
  await writeFile(new URL('../benchmark-results.json', import.meta.url), JSON.stringify({ measuredAt, environment, count, warmup, gapMs, results }, null, 2) + '\n');
  const fmt = (value) => `${value.toFixed(2).replace('.', ',')} ms`;
  const table = [
    '| Đường gọi | Số request | Trung bình | P95 | Min | Max |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((row) => `| ${row.route} | ${row.requests} | ${fmt(row.meanMs)} | ${fmt(row.p95Ms)} | ${fmt(row.minMs)} | ${fmt(row.maxMs)} |`),
  ].join('\n');
  console.log(table);
  if (process.argv.includes('--report')) {
    const reportPath = new URL('../Evaluate.md', import.meta.url);
    const marker = '\n## Benchmark độ trễ\n';
    const original = await readFile(reportPath, 'utf8');
    const existing = original.indexOf(marker);
    const base = existing < 0 ? original.trimEnd() : original.slice(0, existing).trimEnd();
    const localTime = new Date(measuredAt).toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok', hour12: false });
    await writeFile(reportPath, `${base}\n${marker}
Thời điểm đo: **${localTime} (Asia/Bangkok)**. Kết quả do script benchmark chạy thực tế tạo ra, độc lập với log kiểm thử Docker ở trên.

Môi trường: **${environment.node}**, **${environment.os}/${environment.arch}**, CPU **${environment.cpu}**. Client và ba Express app thật chạy HTTP loopback trên cổng ngẫu nhiên, **cùng một tiến trình Node.js trên host, không chạy trong Docker**. Không gọi MinIO trong benchmark này.

Mỗi đường gọi có **5 request khởi động không tính vào thống kê**, sau đó **20 request đo tuần tự**, concurrency=1. Nghỉ 150 ms sau mỗi request (không tính vào độ trễ), giữ nguyên rate limiter 10 request/giây. Tất cả 100 request đo phải trả HTTP 200 và đúng dữ liệu; script dừng nếu gặp lỗi, không loại lỗi âm thầm. JWT được tạo trước khi đo; đường qua Gateway vẫn xác minh JWT ở mỗi request, đường direct gửi trusted identity.

Độ trễ đo bằng performance.now(), từ trước fetch đến khi nhận đầy đủ response body; không tính bước parse/kiểm tra dữ liệu. Dùng fetch mặc định có tái sử dụng kết nối. P95 dùng nearest-rank: phần tử thứ **19** trong 20 mẫu đã sắp tăng dần (không phải mặc định lấy Max).

${table}

Đây là phép đo nhỏ trên loopback, không phải benchmark tải cao hay độ trễ mạng/container thực tế. Các đường được đo lần lượt nên chênh lệch có thể chịu ảnh hưởng của JIT, GC và tải máy; không suy rộng thành mức overhead cố định của Gateway.

Mẫu đo thô và thông tin môi trường: [benchmark-results.json](benchmark-results.json).

Chạy lại từ thư mục gốc (không cần Docker hoặc MinIO):

\x60\x60\x60bash
npm run benchmark
# Chạy và cập nhật phần benchmark ở cuối Evaluate.md:
npm run benchmark -- --report
\x60\x60\x60
`);
  }
} finally {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
}
