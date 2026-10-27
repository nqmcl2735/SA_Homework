
## Kiến trúc

```text
Client
  |
  | :3000 — JWT + rate limit 10 request/giây/IP
  v
API Gateway
  |-- /users, /login -----------> User Service :3001
  |-- /orders -----------------> Order Service :3002
  |-- /dashboard --+-----------> User Service
                   +-----------> Order Service (song song)

Client -- PUT bằng URL ký sẵn, hết hạn 300 giây --> MinIO :9000
```

User Service và Order Service chỉ truy cập qua mạng nội bộ Docker. `/login` và `/health` không yêu cầu JWT.

## Yêu cầu

| Yêu cầu | Thực hiện |
| --- | --- |
| Routing | Gateway chuyển `/users` đến User Service và `/orders` đến Order Service |
| Offloading | Gateway xác minh JWT HS256 và giới hạn 10 request/giây/IP |
| Aggregation | `/dashboard` gọi hai service song song, timeout 5 giây; trả 206 nếu chỉ một service thành công, 502 nếu cả hai lỗi |
| Valet Key | `POST /users/:id/avatar-upload-url` cấp pre-signed PUT URL cho một object, hết hạn sau 300 giây; ký kèm Content-Type PNG/JPEG/WebP |
| Đo độ trễ | `test/benchmark.js` đo 20 request mỗi đường gọi trực tiếp, qua Gateway và Dashboard |

## Chạy hệ thống

Yêu cầu Docker Engine và Docker Compose. Các lệnh dưới đây dùng Bash trên Linux.

```bash
# Chỉ sao chép nếu chưa có .env:
cp -n .env.example .env
sudo docker compose up --build -d
sudo docker compose ps
```

Lần build đầu có thể mất nhiều phút vì MinIO và `mc` được biên dịch từ mã nguồn chính thức.

- Gateway: `http://localhost:3000`
- MinIO S3 API: `http://localhost:9000`
- Tài khoản demo: `user@example.com` / `123456` (user 1, có hai đơn hàng).
- Tài khoản thứ hai: `user2@example.com` / `123456` (user 2, chưa có đơn hàng).

## Chạy kiểm thử và benchmark

```bash
sudo docker compose -p sa-homework-test -f compose.test.yaml run --build --rm tests
```

Lệnh tự chạy stack test riêng, kiểm thử cả upload MinIO thật, rồi chạy benchmark sau khi test thành công. Kết quả test và bảng độ trễ hiển thị trong terminal. Benchmark đo HTTP loopback trong container test.

Dọn stack test:

```bash
sudo docker compose -p sa-homework-test -f compose.test.yaml down --volumes --remove-orphans
```

## Kết quả

Xem [Evaluate.md](Evaluate.md): 50 tình huống kiểm thử, kết quả chạy test, benchmark và cấu hình máy thực hiện.
