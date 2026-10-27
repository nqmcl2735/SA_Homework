# Đánh giá kiểm thử và benchmark

## 1. Kết quả test và benchmark

**Test và benchmark đều chạy bằng Docker Compose**

| STT | Ca kiểm thử | Kỳ vọng | Kết quả thực tế | Trạng thái |
| --- | --- | --- | --- | --- |
| 1 | Health Gateway, User, Order | 200, JSON `status=ok`, đúng service | Cả ba khớp JSON | Đạt |
| 2 | Đăng nhập demo | 200, có JWT xác minh được | Token được xác minh thành công | Đạt |
| 3 | Cấu trúc JWT | HS256, issuer/audience theo cấu hình, sub=1, TTL=900 | Đúng thuật toán, claims và TTL | Đạt |
| 4 | Sai mật khẩu | 401 | `Invalid credentials` | Đạt |
| 5 | Thiếu Bearer hoặc dùng Basic trên các route nghiệp vụ | 401 | `Invalid or missing access token` | Đạt |
| 6 | Token hỏng | 401 | Gateway từ chối | Đạt |
| 7 | Token hết hạn | 401 | Gateway từ chối | Đạt |
| 8 | Sai issuer hoặc audience | 401 | Cả hai bị từ chối | Đạt |
| 9 | Sai thuật toán HS384 hoặc sai khóa ký | 401 | Cả hai bị từ chối | Đạt |
| 10 | Thiếu exp, thiếu sub hoặc sub trống | 401 | Gateway từ chối | Đạt |
| 11 | Routing `/users/1` | 200, id=1, không lộ password | Đúng dữ liệu | Đạt |
| 12 | Routing `/orders?userId=1` | 200, hai đơn hàng | Nhận hai đơn hàng | Đạt |
| 13 | User 1 truy cập user 2 | 403 | 403 | Đạt |
| 14 | User 1 truy cập orders user 2 | 403 | 403 | Đạt |
| 15 | Dashboard có query `userId=2`, token user 1 | Vẫn trả user 1 và đơn hàng user 1 | Khớp dữ liệu lấy qua hai API của user 1 | Đạt |
| 16 | Gọi trực tiếp User thiếu trusted identity | 401 | 401 | Đạt |
| 17 | Gọi trực tiếp Order thiếu trusted identity | 401 | 401 | Đạt |
| 18 | Giả `x-auth-user-id=2` nhưng token user 1 | Header giả bị bỏ qua | User và Dashboard vẫn thuộc user 1 | Đạt |
| 19 | Chỉ gửi header định danh, không JWT | 401 | Không vượt qua Gateway | Đạt |
| 20 | Dashboard đầy đủ | 200, user và hai orders | Cả hai thành phần đúng | Đạt |
| 21 | Order unavailable | 206, giữ user, orders=null, errors.orders | Đúng response; proxy orders vẫn 502 | Đạt |
| 22 | User unavailable | 206, user=null, giữ orders | Đúng response cho cả user có và không có đơn hàng | Đạt |
| 23 | Cả hai unavailable | 502 | `Upstream service unavailable` | Đạt |
| 24 | Upstream HTTP 503 hoặc JSON sai | Giữ phần thành công, 206 | User còn nguyên, orders=null | Đạt |
| 25 | User không tồn tại và orders sai schema | 502 | Cả hai kết quả không hợp lệ đều bị loại | Đạt |
| 26 | Gọi song song, một body bị treo | Hai request cùng bắt đầu; timeout 5s; 206 | Nhóm test hoàn tất khoảng 5,011s, giữ user | Đạt |
| 27 | POST `/orders` ngoài phạm vi | 404 | 404 dù có JWT hợp lệ | Đạt |
| 28 | Orders thiếu userId hoặc userId lặp | 400 | Cả hai bị từ chối | Đạt |
| 29 | User chưa có đơn hàng | 200, orders=[] | User 2 nhận mảng rỗng | Đạt |
| 30 | ID user không tồn tại, token cùng ID | 404 | 404 | Đạt |
| 31 | Valet Key cho PNG/JPEG/WebP | PUT, expiresIn=300, đúng prefix user, ký Content-Type | Cả ba loại khớp; X-Amz-Expires=300 | Đạt |
| 32 | MIME không cho phép hoặc thiếu | 400 | text/plain, SVG, toString và thiếu MIME bị từ chối | Đạt |
| 33 | Xin URL upload của người khác | 403 | 403 | Đạt |
| 34 | Hai lần cấp URL upload | Hai object key khác nhau | Path khác nhau, gắn đúng user | Đạt |
| 35 | 12 request nhanh trên users/orders/dashboard | 10 request đầu 200, hai request sau 429 | Đúng kỳ vọng, chung hạn mức | Đạt |
| 36 | Giả X-Forwarded-For khi vượt hạn mức | Không né được giới hạn IP | Vẫn 429 | Đạt |
| 37 | Đợi qua cửa sổ 1s | Request tiếp theo 200 | 200 sau khi đợi 1,05s | Đạt |
| 38 | Health/login độc lập với limiter nghiệp vụ | Vẫn truy cập được | Health và login trả 200 khi nghiệp vụ bị giới hạn | Đạt |
| 39 | Limiter riêng của login | 10 request được xử lý, hai request sau 429 | 10 body sai trả 400, hai request sau 429; Dashboard vẫn 200 | Đạt |
| 40 | Login thiếu/sai kiểu trường hoặc tài khoản không tồn tại | 400 hoặc 401 tương ứng | Khớp kỳ vọng | Đạt |
| 41 | JSON sai cú pháp | 400 | `Invalid JSON` | Đạt |
| 42 | JSON vượt 32 KB và vượt 100 KB | 413 ở cả ba app | Payload 33 KB và 101 KB đều 413 | Đạt |
| 43 | Route không tồn tại | 404 ở cả ba app | 404 | Đạt |
| 44 | Ẩn X-Powered-By | Header không xuất hiện | Không có trên response health và 404 của cả ba app | Đạt |
| 45 | Health các container và MinIO thật | JSON health đúng, MinIO live=200 | Cả ba service trả JSON đúng; MinIO live trả 200 | Đạt |
| 46 | Routing/Aggregation qua các container thật | 200, user 1 và hai đơn hàng | Các route trả 200; Dashboard có user 1 và hai orders | Đạt |
| 47 | PUT trực tiếp URL ký sẵn tới MinIO | 200, đọc lại đúng bytes PNG và Content-Type | PUT trả 200; đọc lại khớp bytes PNG và image/png | Đạt |
| 48 | Upload sai Content-Type | MinIO trả 403 | MinIO trả 403 khi đổi sang image/jpeg | Đạt |
| 49 | Sửa object key trong URL ký sẵn | MinIO trả 403 | MinIO trả 403 khi sửa path object | Đạt |
| 50 | GET ảnh private không chữ ký | MinIO trả 403 | GET không ký trả 403 | Đạt |

**Benchmark:** kết quả chạy trong container test theo log Docker người dùng cung cấp. Tổng cộng 100 request đo, tất cả trả HTTP 200.

| Đường gọi | Số request | Trung bình | P95 | Min | Max |
| --- | --- | --- | --- | --- | --- |
| Direct → User service | 20 | 3,93 ms | 5,55 ms | 3,01 ms | 9,70 ms |
| Client → Gateway → User service | 20 | 6,54 ms | 8,38 ms | 3,80 ms | 8,74 ms |
| Direct → Order service | 20 | 3,22 ms | 3,30 ms | 2,85 ms | 5,07 ms |
| Client → Gateway → Order service | 20 | 6,47 ms | 8,62 ms | 4,18 ms | 8,74 ms |
| Client → Gateway → Dashboard | 20 | 8,33 ms | 9,88 ms | 7,61 ms | 10,77 ms |

## 2. Môi trường máy chạy test

Thông số đọc trực tiếp từ máy đang chứa và chạy dự án:

| Thông số | Giá trị |
| --- | --- |
| Hệ điều hành | Ubuntu 25.04 (Plucky Puffin), x86_64 |
| Kernel | Linux 6.14.0-37-generic |
| CPU | Intel Core i5-11400H @ 2.70 GHz, 6 nhân / 12 luồng |
| RAM hệ điều hành nhận diện | 14,88 GiB |
| Swap | 4 GiB |
| Docker CLI | 29.2.1 |
| Docker Compose | v5.0.2 |
| Runtime trong container test | Node.js 22, image `node:22-alpine` |

Test và benchmark chạy bằng Docker trên cùng máy. Compose không đặt giới hạn CPU/RAM riêng cho container. Benchmark đo HTTP loopback bên trong container test, concurrency=1; không bao gồm độ trễ mạng giữa các container. Không thu thập mức sử dụng CPU/RAM tại thời điểm chạy benchmark.

## 3. Hướng dẫn chạy Docker test

Tại thư mục gốc dự án, với Docker Engine đang chạy:

```bash
sudo docker compose -p sa-homework-test -f compose.test.yaml run --build --rm tests
```

Dọn stack sau khi chạy:

```bash
sudo docker compose -p sa-homework-test -f compose.test.yaml down --volumes --remove-orphans
```
