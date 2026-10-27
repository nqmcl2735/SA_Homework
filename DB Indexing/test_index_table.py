"""Đo và ghi báo cáo: python test_index_table.py.

Kiểm thử tính đúng: python -m unittest -v test_index_table.
Chạy generate_data.py trước khi đo. Thời gian đo bao gồm đọc DB,
giải mã địa chỉ JSON và tạo danh sách kết quả; không gồm tạo Index Table.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import statistics
import tempfile
import time
import unittest
from pathlib import Path
from typing import Callable

from generate_data import (
    DEFAULT_DB,
    TARGET_WARD,
    create_database,
    create_index_table,
    generate_rows,
    open_database,
)


Resident = tuple[int, str, list[str]]
Query = Callable[[sqlite3.Connection, str], list[Resident]]
INDEXED_SQL = """
    SELECT r.id, r.full_name, r.permanent_address
    FROM ward_index AS i
    JOIN residents AS r ON r.id = i.resident_id
    WHERE i.ward = ?
    ORDER BY i.resident_id
"""


def baseline_query(connection: sqlite3.Connection, ward: str) -> list[Resident]:
    """Đọc toàn bộ bảng, dùng for lọc đúng phần phường/xã, không lọc tỉnh."""
    matches = []
    rows = connection.execute(
        "SELECT id, full_name, permanent_address FROM residents ORDER BY id"
    )
    for resident_id, full_name, raw_address in rows:
        address = json.loads(raw_address)
        if address[1] == ward:
            matches.append((resident_id, full_name, address))
    return matches


def indexed_query(connection: sqlite3.Connection, ward: str) -> list[Resident]:
    """Tra phường trong Index Table rồi JOIN bằng ID để lấy thông tin đầy đủ."""
    return [
        (resident_id, full_name, json.loads(raw_address))
        for resident_id, full_name, raw_address in connection.execute(INDEXED_SQL, (ward,))
    ]


def query_plan(connection: sqlite3.Connection, ward: str) -> list[str]:
    return [
        row[3]
        for row in connection.execute("EXPLAIN QUERY PLAN " + INDEXED_SQL, (ward,))
    ]


def measure_once(query: Query, connection: sqlite3.Connection, ward: str) -> float:
    started = time.perf_counter_ns()
    result = query(connection, ward)
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    # Giữ kết quả đến sau khi chốt thời gian để không tính chi phí giải phóng.
    del result
    return elapsed_ms


def summarize(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    return {
        "mean": statistics.fmean(samples),
        "median": statistics.median(samples),
        "p95": ordered[math.ceil(0.95 * len(ordered)) - 1],
        "min": ordered[0],
        "max": ordered[-1],
    }


def benchmark(db_path: Path, ward: str, iterations: int) -> dict:
    if iterations <= 0:
        raise ValueError("Số lần đo phải lớn hơn 0")
    if not db_path.is_file():
        raise FileNotFoundError(f"Chưa có database {db_path}. Chạy generate_data.py trước.")

    with open_database(db_path) as connection:
        create_index_table(connection)
        # Đồng thời warm-up và kiểm tra toàn bộ dữ liệu kết quả, gồm cả thứ tự.
        baseline_rows = baseline_query(connection, ward)
        indexed_rows = indexed_query(connection, ward)
        if baseline_rows != indexed_rows:
            raise AssertionError("Hai phương án trả về kết quả khác nhau")

        baseline_samples: list[float] = []
        indexed_samples: list[float] = []
        # Đổi thứ tự đo sau mỗi lượt để giảm ảnh hưởng của thứ tự chạy/cache.
        methods = ((baseline_query, baseline_samples), (indexed_query, indexed_samples))
        for iteration in range(iterations):
            for query, samples in methods[::1 if iteration % 2 == 0 else -1]:
                samples.append(measure_once(query, connection, ward))

        records = connection.execute("SELECT COUNT(*) FROM residents").fetchone()[0]
        index_rows = connection.execute("SELECT COUNT(*) FROM ward_index").fetchone()[0]
        plans = query_plan(connection, ward)

    baseline_stats = summarize(baseline_samples)
    indexed_stats = summarize(indexed_samples)
    return {
        "records": records,
        "index_rows": index_rows,
        "ward": ward,
        "matches": len(baseline_rows),
        "iterations": iterations,
        "equivalent_results": True,
        "baseline": baseline_stats,
        "index_table": indexed_stats,
        "speedup": baseline_stats["mean"] / indexed_stats["mean"],
        "query_plan": plans,
    }


def format_report(result: dict) -> str:
    def table_row(label: str, stats: dict[str, float]) -> str:
        cells = " | ".join(f"{stats[key]:.4f}" for key in ("mean", "median", "p95", "min", "max"))
        return f"| {label} | {cells} |"

    baseline_row = table_row("Baseline: full scan + vòng `for`", result["baseline"])
    indexed_row = table_row("Index Table: secondary key → reference", result["index_table"])
    speedup = result["speedup"]
    comparison = (
        f"Index Table nhanh hơn trung bình {speedup:.2f} lần."
        if speedup >= 1
        else f"Index Table chậm hơn trung bình {1 / speedup:.2f} lần."
    )
    return f"""# Kết quả thực nghiệm Index Table

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
{INDEXED_SQL.strip()}
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

- Số bản ghi fact table: **{result['records']}**
- Số bản ghi index table: **{result['index_rows']}**
- Secondary key cần tìm: **{result['ward']}**
- Số kết quả: **{result['matches']}**
- Số lần đo mỗi phương án: **{result['iterations']}**
- Hai phương án trả cùng kết quả: **{'Có' if result['equivalent_results'] else 'Không'}**

| Phương án | Mean (ms) | Median (ms) | P95 (ms) | Min (ms) | Max (ms) |
|---|---:|---:|---:|---:|---:|
{baseline_row}
{indexed_row}

**{comparison}**

Mean là thời gian trung bình; Median là trung vị; P95 là giá trị tại vị trí
`ceil(0.95 × số lần đo)` trong dãy thời gian đã sắp tăng dần; Min và Max là
thời gian nhỏ nhất và lớn nhất. Tỷ lệ tăng tốc bằng Mean baseline chia cho
Mean Index Table.

## Query plan

```text
{chr(10).join(result['query_plan'])}
```

`SEARCH i USING PRIMARY KEY` cho biết SQLite tra bảng `ward_index` theo
phường/xã bằng khóa chính. `SEARCH r USING INTEGER PRIMARY KEY` cho biết
SQLite lấy bản ghi cư dân bằng ID, thay vì quét toàn bộ bảng cư dân.

## Đánh giá

Baseline đọc và giải mã JSON của tất cả cư dân. Index Table tra các ID phù
hợp trước, rồi chỉ lấy và giải mã thông tin của những người khớp điều kiện.
Chênh lệch thời gian vì vậy bao gồm cả phần xử lý JSON trong Python.

Kết quả trên phản ánh lần chạy với dữ liệu và bộ nhớ đệm hiện tại; tốc độ
phụ thuộc máy chạy, tải hệ thống và tỷ lệ bản ghi khớp. Bảng tra cứu cần
thêm dung lượng và phải được cập nhật khi thêm, sửa hoặc xóa cư dân.
Script hiện tại xây lại bảng tra cứu trước mỗi lần benchmark, chưa tự động
đồng bộ khi dữ liệu cư dân thay đổi.
"""


class IndexTableTests(unittest.TestCase):
    def test_generated_data_and_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "test.db"
            create_database(db_path, seed=42)
            with open_database(db_path) as connection:
                create_index_table(connection)
                rows = connection.execute("SELECT * FROM residents ORDER BY id").fetchall()
                self.assertEqual(10_000, len(rows))
                self.assertEqual(list(range(1, 10_001)), [row[0] for row in rows])
                for _, name, address in rows:
                    self.assertTrue(name)
                    parts = json.loads(address)
                    self.assertEqual(3, len(parts))
                    self.assertTrue(all(isinstance(part, str) and part for part in parts))
                expected = [(json.loads(address)[1], resident_id) for resident_id, _, address in rows]
                actual = connection.execute("SELECT ward, resident_id FROM ward_index").fetchall()
                self.assertEqual(sorted(expected), sorted(actual))
                self.assertEqual([], connection.execute("PRAGMA foreign_key_check").fetchall())
                target_provinces = {
                    parts[2]
                    for _, _, address in rows
                    if (parts := json.loads(address))[1] == TARGET_WARD
                }
                self.assertGreater(len(target_provinces), 1)
                self.assertEqual(
                    baseline_query(connection, TARGET_WARD),
                    indexed_query(connection, TARGET_WARD),
                )

    def test_seed_is_reproducible(self) -> None:
        self.assertEqual(list(generate_rows(20, 42)), list(generate_rows(20, 42)))
        self.assertNotEqual(list(generate_rows(20, 42)), list(generate_rows(20, 43)))

    def test_exact_ward_in_any_province_and_missing_ward(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "test.db"
            create_database(db_path, count=1)
            with open_database(db_path) as connection:
                fixtures = [
                    (1, "Nguyễn Văn An", ["Số 1", "Cầu Giấy", "Hà Nội"]),
                    (2, "Trần Thị Bình", ["Số 2", "Cầu Giấy", "Đà Nẵng"]),
                    (3, "Lê Minh Chi", ["Đường Cầu Giấy", "Dịch Vọng", "Hà Nội"]),
                    (4, "Phạm Ngọc Dũng", ["Số 4", "Cầu Giấy Mới", "Hà Nội"]),
                    (5, "Hoàng Thanh Hà", ["Số 5", "Yên Hòa", "Cầu Giấy"]),
                ]
                with connection:
                    connection.execute("DELETE FROM residents")
                    connection.executemany(
                        "INSERT INTO residents VALUES (?, ?, ?)",
                        [(key, name, json.dumps(address, ensure_ascii=False)) for key, name, address in fixtures],
                    )
                create_index_table(connection)
                for query in (baseline_query, indexed_query):
                    self.assertEqual(fixtures[:2], query(connection, TARGET_WARD))
                    self.assertEqual([], query(connection, "Không tồn tại"))
                plan = " ".join(query_plan(connection, TARGET_WARD)).upper()
                self.assertIn("SEARCH I USING PRIMARY KEY", plan)
                self.assertIn("SEARCH R USING INTEGER PRIMARY KEY", plan)

    def test_benchmark_and_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "test.db"
            create_database(db_path, count=100, seed=42)
            result = benchmark(db_path, TARGET_WARD, iterations=3)
            self.assertTrue(result["equivalent_results"])
            self.assertEqual(100, result["records"])
            self.assertEqual(100, result["index_rows"])
            self.assertGreater(result["matches"], 0)
            for method in ("baseline", "index_table"):
                stats = result[method]
                self.assertGreater(stats["min"], 0)
                self.assertLessEqual(stats["min"], stats["median"])
                self.assertLessEqual(stats["median"], stats["p95"])
                self.assertLessEqual(stats["p95"], stats["max"])
            report = format_report(result)
            self.assertTrue(report.startswith("# Kết quả thực nghiệm Index Table\n"))
            self.assertIn("## Query plan", report)
            with self.assertRaises(ValueError):
                benchmark(db_path, TARGET_WARD, iterations=0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Đo baseline và Index Table, ghi README.md")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--ward", default=TARGET_WARD)
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "README.md")
    args = parser.parse_args()
    if args.iterations <= 0:
        parser.error("--iterations phải lớn hơn 0")
    if not args.db.is_file():
        parser.error(f"Chưa có database {args.db}. Chạy generate_data.py trước.")
    result = benchmark(args.db, args.ward, args.iterations)
    report = format_report(result)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report, encoding="utf-8")
    print(report)
    print(f"Đã lưu báo cáo: {args.output}")


if __name__ == "__main__":
    main()
