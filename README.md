# User Service, Order Service và API Gateway

JavaScript, Express; đúng phạm vi backend của đề bài. Dữ liệu mẫu lưu trong bộ nhớ, không có frontend hay API CRUD bổ sung.

## Chạy bằng Docker Compose

```bash
cp .env.example .env
docker compose up --build -d
```

Gateway: `http://localhost:3000`. MinIO: `http://localhost:9000`.
Compose tự tạo bucket private `avatars`. User Service (3001) và Order Service (3002) chỉ ở mạng nội bộ, không publish cổng. Chỉ Gateway xác minh JWT; các service kiểm tra `x-auth-user-id` và quyền truy cập dữ liệu của chính người đó. Gateway tự đặt header này từ JWT, bỏ qua header giả mạo của client.

## Endpoint

| Thành phần | Method | Endpoint | Xác thực |
| --- | --- | --- | --- |
| User Service | GET | `/health` | Công khai |
| User Service | POST | `/login` | Công khai |
| User Service | GET | `/users/:id` | Định danh Gateway, đúng user |
| User Service | POST | `/users/:id/avatar-upload-url` | Định danh Gateway, đúng user |
| Order Service | GET | `/health` | Công khai |
| Order Service | GET | `/orders?userId=:id` | Định danh Gateway, đúng user |
| API Gateway | GET | `/health` | Công khai |
| API Gateway | POST | `/login` | Công khai, limiter riêng |
| API Gateway | GET | `/users/:id` | JWT, chuyển tiếp User Service |
| API Gateway | POST | `/users/:id/avatar-upload-url` | JWT, chuyển tiếp User Service |
| API Gateway | GET | `/orders?userId=:id` | JWT, chuyển tiếp Order Service |
| API Gateway | GET | `/dashboard` | JWT, gọi song song cả hai service |

JWT dùng HS256, `sub`, `iss`, `aud`, `exp`, hết hạn sau 15 phút. Gateway kiểm tra tất cả các trường trên. `/users`, `/orders`, `/dashboard` dùng chung limiter 10 request / cửa sổ 1 giây / IP; `/login` có limiter riêng cùng mức. `/health` không giới hạn. Không bật `trust proxy`, không tin IP tự khai báo qua `X-Forwarded-For`.

Dashboard trả `{ "user": {...}, "orders": [...] }`, luôn lấy user ID từ JWT. Lỗi kết nối/timeout service trả 502; Dashboard trả 502 nếu một service không thành công. Proxy giữ status/body do service trả về. Lỗi JSON có dạng `{ "error": "..." }`: 400 đầu vào sai, 401 xác thực sai, 403 khác user, 404 không tồn tại, 429 vượt giới hạn.

## Gọi thử

Tài khoản mẫu: `user@example.com` / `123456` (ID `1`, hai đơn hàng); `user2@example.com` / `123456` (ID `2`, chưa có đơn hàng).

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"123456"}'

# Điền accessToken nhận được:
TOKEN='your-access-token'
curl http://localhost:3000/users/1 -H "Authorization: Bearer $TOKEN"
curl 'http://localhost:3000/orders?userId=1' -H "Authorization: Bearer $TOKEN"
curl http://localhost:3000/dashboard -H "Authorization: Bearer $TOKEN"

curl -X POST http://localhost:3000/users/1/avatar-upload-url \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"contentType":"image/png"}'

# Điền uploadUrl vừa nhận, giữ nguyên toàn bộ URL và dùng đúng Content-Type:
UPLOAD_URL='your-presigned-url'
curl --fail-with-body -X PUT "$UPLOAD_URL" \
  -H 'Content-Type: image/png' --data-binary @avatar.png
```

URL upload dùng PUT, hết hạn sau 300 giây, key `avatars/<userId>/<uuid>.<extension>`. Chỉ nhận `image/png`, `image/jpeg`, `image/webp`. `Content-Type` nằm trong chữ ký nên thay header này khi upload sẽ làm chữ ký không hợp lệ ([tài liệu AWS SDK](https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner#readme)). Đây là giới hạn MIME header; không kiểm tra nội dung nhị phân file. File đi thẳng từ client tới MinIO. `MINIO_PUBLIC_ENDPOINT` phải là địa chỉ client truy cập được, vì hostname là một phần chữ ký.

`avatarUrl` trong dữ liệu mẫu là `null`. Endpoint chỉ cấp URL upload theo thiết kế; không có API xác nhận upload, cập nhật hồ sơ hoặc public ảnh.

## Chạy Node.js và kiểm thử

Node.js 20 trở lên. Cài dependencies và tạo cấu hình:

```bash
npm ci
cp .env.example .env
npm test
```

Chạy mỗi lệnh ở một terminal riêng:

```bash
npm run start:users
npm run start:orders
npm run start:gateway
```

Khi chạy trực tiếp, User/Order chỉ bind `127.0.0.1` (máy local được xem là mạng tin cậy). MinIO vẫn cần chạy và bucket cần được tạo; có thể dùng `docker compose up -d minio minio-init`.

Test khởi động cả ba Express app trên cổng ngẫu nhiên, kiểm tra login/JWT, routing, phân quyền, giả mạo header, aggregation, rate limiting, lỗi upstream và thông số/chữ ký URL. Test không cần MinIO; việc upload thực tế cần MinIO đang chạy.
