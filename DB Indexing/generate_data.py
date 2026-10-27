"""Tạo dữ liệu SQLite: python generate_data.py.

Sinh theo xác suất có trọng số, chọn tỉnh trước rồi chọn phường theo tỉnh.
Mặc định mỗi lần chạy tạo dữ liệu mới; truyền --seed để tái lập dữ liệu.
Các địa chỉ là dữ liệu giả, không đại diện cho địa chỉ hành chính thực tế.
"""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


DEFAULT_DB = Path(__file__).resolve().parent / "data" / "residents.db"
TARGET_WARD = "Cầu Giấy"
FAMILY_NAMES = ("Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Vũ", "Đặng", "Bùi", "Đỗ", "Hồ")
FAMILY_WEIGHTS = (30, 15, 12, 10, 8, 7, 6, 5, 4, 3)
MIDDLE_NAMES = ("Văn", "Thị", "Minh", "Ngọc", "Đức", "Thanh", "Quang", "Thu", "Gia", "Hải")
GIVEN_NAMES = ("An", "Bình", "Chi", "Dũng", "Giang", "Hà", "Hùng", "Lan", "Linh", "Nam", "Phúc", "Trang")
STREETS = (
    "Trần Duy Hưng", "Xuân Thủy", "Nguyễn Trãi", "Láng Hạ",
    "Kim Mã", "Minh Khai", "Hoàng Quốc Việt", "Phạm Văn Đồng",
)
# Trọng số giả lập để phân bố dữ liệu không đều, không phải thống kê dân số.
# Cố ý cho Cầu Giấy xuất hiện ở nhiều tỉnh để kiểm tra truy vấn không lọc tỉnh.
PROVINCE_PROFILES = (
    ("Hà Nội", 30, (TARGET_WARD, "Dịch Vọng", "Mai Dịch", "Yên Hòa", "Mỹ Đình")),
    ("Thành phố Hồ Chí Minh", 25, (TARGET_WARD, "Bến Nghé", "Tân Định", "Linh Trung")),
    ("Đà Nẵng", 12, (TARGET_WARD, "Hải Châu", "An Hải", "Hòa Cường")),
    ("Hải Phòng", 10, (TARGET_WARD, "Lê Chân", "Ngô Quyền", "Hồng Bàng")),
    ("Cần Thơ", 8, (TARGET_WARD, "Ninh Kiều", "Cái Răng", "Bình Thủy")),
    ("Quảng Ninh", 6, (TARGET_WARD, "Hồng Gai", "Bãi Cháy", "Cẩm Phả")),
    ("Thanh Hóa", 5, (TARGET_WARD, "Đông Vệ", "Lam Sơn", "Hàm Rồng")),
    ("Bắc Ninh", 4, (TARGET_WARD, "Kinh Bắc", "Võ Cường", "Đình Bảng")),
)


def generate_name(rng: random.Random) -> str:
    family = rng.choices(FAMILY_NAMES, weights=FAMILY_WEIGHTS, k=1)[0]
    middle_count = rng.choices((0, 1, 2), weights=(10, 70, 20), k=1)[0]
    parts = [family, *rng.sample(MIDDLE_NAMES, middle_count), rng.choice(GIVEN_NAMES)]
    return " ".join(parts)


def generate_address_detail(rng: random.Random) -> str:
    street = rng.choice(STREETS)
    house = rng.randint(1, 999)
    kind = rng.choices(("house", "alley", "apartment"), weights=(50, 30, 20), k=1)[0]
    if kind == "alley":
        return f"Số {house}, ngõ {rng.randint(1, 150)}, đường {street}"
    if kind == "apartment":
        floor = rng.randint(1, 35)
        room = rng.randint(1, 20)
        return f"Căn hộ {floor}{room:02d}, tòa {rng.choice('ABCD')}, số {house}, đường {street}"
    return f"Số {house}, đường {street}"


@contextmanager
def open_database(db_path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(db_path)
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
    finally:
        connection.close()


def generate_rows(count: int, seed: int | None = None) -> Iterator[tuple[int, str, str]]:
    """Sinh tên dài 2–4 từ và địa chỉ nhiều mẫu; ID vẫn từ 1 đến count."""
    rng = random.Random(seed)
    for resident_id in range(1, count + 1):
        full_name = generate_name(rng)
        province, _, wards = rng.choices(
            PROVINCE_PROFILES, weights=[profile[1] for profile in PROVINCE_PROFILES], k=1
        )[0]
        # Khoảng 8% cư dân thuộc Cầu Giấy; không ấn định số kết quả cố định.
        ward = TARGET_WARD if rng.random() < 0.08 else rng.choice(wards[1:])
        address = [generate_address_detail(rng), ward, province]
        yield resident_id, full_name, json.dumps(address, ensure_ascii=False)


def create_database(
    db_path: Path, count: int = 10_000, seed: int | None = None
) -> None:
    """Tạo lại bảng residents; xóa bảng tra cứu cũ nếu có."""
    if count <= 0:
        raise ValueError("Số bản ghi phải lớn hơn 0")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with open_database(db_path) as connection:
        with connection:
            connection.execute("DROP TABLE IF EXISTS ward_index")
            connection.execute("DROP TABLE IF EXISTS residents")
            connection.execute(
                """
                CREATE TABLE residents (
                    id INTEGER PRIMARY KEY,
                    full_name TEXT NOT NULL,
                    permanent_address TEXT NOT NULL
                )
                """
            )
            connection.executemany(
                "INSERT INTO residents VALUES (?, ?, ?)", generate_rows(count, seed)
            )


def create_index_table(connection: sqlite3.Connection) -> None:
    """Tạo bảng ánh xạ secondary key (phường/xã) sang reference (ID)."""
    with connection:
        connection.execute("DROP TABLE IF EXISTS ward_index")
        connection.execute(
            """
            CREATE TABLE ward_index (
                ward TEXT NOT NULL,
                resident_id INTEGER NOT NULL,
                PRIMARY KEY (ward, resident_id),
                FOREIGN KEY (resident_id) REFERENCES residents(id)
            ) WITHOUT ROWID
            """
        )
        residents = connection.execute("SELECT id, permanent_address FROM residents")
        connection.executemany(
            "INSERT INTO ward_index VALUES (?, ?)",
            ((json.loads(address)[1], resident_id) for resident_id, address in residents),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Sinh dữ liệu cư dân cho thực nghiệm Index Table")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--records", type=int, default=10_000)
    parser.add_argument("--seed", type=int, help="Seed tùy chọn để sinh lại cùng dữ liệu")
    args = parser.parse_args()
    if args.records <= 0:
        parser.error("--records phải lớn hơn 0")
    create_database(args.db, args.records, args.seed)
    print(f"Đã tạo {args.records} bản ghi trong {args.db}")


if __name__ == "__main__":
    main()
