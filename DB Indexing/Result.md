# Kết quả thực nghiệm Index Table

Thực nghiệm dùng SQLite để so sánh hai cách tìm cư dân có phường/xã
**Cầu Giấy**, thuộc tỉnh/thành phố bất kỳ: đọc toàn bộ bảng và lọc bằng
vòng lặp Python, hoặc tra qua Index Table rồi lấy bản ghi theo ID.

## Dữ liệu và cách sinh

Bảng `residents` lưu thông tin cư dân:

| Cột | Kiểu SQLite | Ý nghĩa |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | ID duy nhất, từ 1 đến số bản ghi |
| `full_name` | `TEXT NOT NULL` | Họ tên |
| `permanent_address` | `TEXT NOT NULL` | Chuỗi JSON gồm địa chỉ chi tiết, phường/xã, tỉnh/thành phố |

Ví dụ giá trị `permanent_address`:

```json
["Số 12, ngõ 5, đường Xuân Thủy", "Cầu Giấy", "Hà Nội"]
```

`generate_data.py` mặc định sinh **10.000 bản ghi**:

- Họ tên có 2–4 từ; họ được chọn theo trọng số.
- Tỉnh/thành phố được chọn theo trọng số giả lập, tạo phân bố không đều.
- Mỗi người có xác suất 8% thuộc phường/xã Cầu Giấy; các trường hợp còn lại
  chọn phường/xã khác trong danh sách của tỉnh/thành phố đã chọn.
- Địa chỉ chi tiết có ba dạng: nhà mặt đường (50%), nhà trong ngõ (30%),
  căn hộ (20%). Đây là xác suất chọn, không phải tỷ lệ cố định trong dữ liệu.
- Mỗi lần chạy mặc định tạo dữ liệu mới; có thể truyền `--seed` để tái lập.

Địa danh và trọng số dùng để tạo dữ liệu giả. Cố ý cho tên Cầu Giấy xuất hiện
ở nhiều tỉnh/thành phố để kiểm tra điều kiện tìm kiếm không phụ thuộc tỉnh.
Số người thuộc Cầu Giấy thay đổi theo lần sinh, không cố định ở mức 800.

## Hai cách truy vấn

### Baseline: đọc toàn bộ bảng và lọc bằng `for`

Đọc tất cả các dòng của `residents` theo ID, giải mã địa chỉ JSON của từng
người rồi kiểm tra `address[1] == ward` trong vòng lặp `for`.
Chỉ so sánh đúng phần phường/xã, không tìm chuỗi con trong toàn bộ địa chỉ.

### Index Table: secondary key → reference

Bảng `ward_index` ánh xạ tên phường/xã (`ward`) sang ID cư dân (`resident_id`):

```sql
CREATE TABLE ward_index (
    ward TEXT NOT NULL,
    resident_id INTEGER NOT NULL,
    PRIMARY KEY (ward, resident_id),
    FOREIGN KEY (resident_id) REFERENCES residents(id)
) WITHOUT ROWID;
```

Mỗi cư dân có một dòng trong bảng tra cứu. Khóa chính ghép bắt đầu bằng
`ward` hỗ trợ tìm theo phường/xã; `resident_id` tham chiếu về bảng cư dân.
Đây là bảng tra cứu riêng, được tăng tốc bằng khóa chính của SQLite.

Truy vấn lấy đủ thông tin cư dân, sắp xếp theo ID như baseline:

```sql
SELECT r.id, r.full_name, r.permanent_address
    FROM ward_index AS i
    JOIN residents AS r ON r.id = i.resident_id
    WHERE i.ward = ?
    ORDER BY i.resident_id
```

Tham số `?` nhận tên phường/xã cần tìm, mặc định là `Cầu Giấy`.

## Cách chạy

Cần Python 3.10 trở lên, sử dụng hoàn toàn thư viện chuẩn, không cần cài
thêm gói hay chạy máy chủ database. Chạy các lệnh trong thư mục dự án:

```bash
python3 generate_data.py
python3 -m unittest -v test_index_table
python3 test_index_table.py
```

- `generate_data.py` tạo lại bảng dữ liệu trong `data/residents.db` và xóa
  bảng tra cứu cũ nếu có.
- Lệnh `unittest` kiểm tra cấu trúc dữ liệu, ánh xạ bảng tra cứu, khả năng
  tái lập theo seed, kết quả truy vấn, query plan và báo cáo. Database kiểm
  thử nằm trong thư mục tạm, được dọn sau khi chạy.
- `test_index_table.py` tạo lại Index Table từ dữ liệu hiện có, đo tốc độ
  và ghi lại `README.md`, bao gồm phần hướng dẫn này và kết quả mới.

Để sinh dữ liệu có thể tái lập, thay lệnh đầu bằng:

```bash
python3 generate_data.py --records 10000 --seed 42
```

Cùng seed và số bản ghi giúp tái lập dữ liệu; thời gian đo vẫn có thể thay đổi.

## Cách đo

Chương trình tạo Index Table trước khi đo, chạy mỗi phương án một lần để
làm nóng bộ nhớ đệm và so sánh toàn bộ kết quả, gồm cả thứ tự theo ID.
Sau đó đo mỗi phương án theo số lượt cấu hình, mặc định 200, đổi thứ tự
chạy hai phương án sau mỗi lượt để giảm ảnh hưởng của thứ tự chạy.

Thời gian dùng `time.perf_counter_ns()`, quy đổi sang mili giây, bao gồm
đọc dữ liệu, giải mã JSON và tạo danh sách kết quả. Không tính thời gian
sinh dữ liệu, xây Index Table hoặc ghi báo cáo.

## Kết quả đo

- Số bản ghi fact table: **10000**
- Số bản ghi index table: **10000**
- Secondary key cần tìm: **Cầu Giấy**
- Số kết quả: **809**
- Số lần đo mỗi phương án: **200**
- Hai phương án trả cùng kết quả: **Có**

| Phương án | Mean (ms) | Median (ms) | P95 (ms) | Min (ms) | Max (ms) |
|---|---:|---:|---:|---:|---:|
| Baseline: full scan + vòng `for` | 17.3617 | 17.1669 | 18.2154 | 16.6979 | 26.8777 |
| Index Table: secondary key → reference | 1.5248 | 1.4993 | 1.6462 | 1.4298 | 2.8040 |

**Index Table nhanh hơn trung bình 11.39 lần.**

Mean là thời gian trung bình; Median là trung vị; P95 là giá trị tại vị trí
`ceil(0.95 × số lần đo)` trong dãy thời gian đã sắp tăng dần; Min và Max là
thời gian nhỏ nhất và lớn nhất. Tỷ lệ tăng tốc bằng Mean baseline chia cho
Mean Index Table.

## Query plan

```text
SEARCH i USING PRIMARY KEY (ward=?)
SEARCH r USING INTEGER PRIMARY KEY (rowid=?)
```

`SEARCH i USING PRIMARY KEY` cho biết SQLite tra bảng `ward_index` theo
phường/xã bằng khóa chính. `SEARCH r USING INTEGER PRIMARY KEY` cho biết
SQLite lấy bản ghi cư dân bằng ID, thay vì quét toàn bộ bảng cư dân.

## Đánh giá

Baseline đọc và giải mã JSON của tất cả cư dân. Index Table tra các ID phù
hợp trước, rồi chỉ lấy và giải mã thông tin của những người khớp điều kiện.
