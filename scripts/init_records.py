"""처음 시작하는 팀용: 빈 진행기록과 명단 CSV를 만든다.

  python3 scripts/init_records.py --config discovery_config.json --out records/

만들어지는 파일
  탐색진행상황.json     출처별 진행 위치는 설정의 sources로 채우고 나머지는 빈 목록
  기존기업명단.csv      머리글만 (이미 컨택한 기업이 있으면 같은 형식으로 행을 채워 넣는다)
  기업컨택_누적목록.csv  머리글만

이미 같은 이름의 파일이 있으면 덮어쓰지 않는다(--force로 덮어쓰기).
"""
import argparse
import csv
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from schema import (
    CUMULATIVE_HEADERS, EXISTING_HEADERS, K_BLOCKED, K_LAST_NO, K_RECENT, K_REJECTS, K_RESERVE,
    K_SOURCES, K_UPDATED, load_config, save_json,
)

KST = timezone(timedelta(hours=9))


def build_progress(config, start_number=0):
    return {
        "설명": "발굴 파이프라인이 회차마다 읽고 갱신하는 진행 기록. 마지막번호 다음부터 번호를 매긴다.",
        K_UPDATED: datetime.now(KST).strftime("%Y-%m-%d %H:%M KST"),
        K_SOURCES: {
            s["name"]: {"상태": "미착수", "다음_위치": "처음부터"}
            for s in config.get("sources", []) if s.get("type") != "reserve"
        },
        K_BLOCKED: [],
        K_REJECTS: [],
        K_RESERVE: [],
        K_RECENT: {},
        K_LAST_NO: start_number,
    }


def write_header_csv(path: Path, headers):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        csv.writer(f).writerow(headers)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--start-number", type=int, default=0, help="컨택 시트에 이미 있는 마지막 번호")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    config = load_config(args.config)
    args.out.mkdir(parents=True, exist_ok=True)
    targets = {
        "탐색진행상황.json": lambda p: save_json(p, build_progress(config, args.start_number)),
        "기존기업명단.csv": lambda p: write_header_csv(p, EXISTING_HEADERS),
        "기업컨택_누적목록.csv": lambda p: write_header_csv(p, CUMULATIVE_HEADERS),
    }
    for name, make in targets.items():
        path = args.out / name
        if path.exists() and not args.force:
            print(f"건너뜀(이미 있음): {path}")
            continue
        make(path)
        print(f"생성: {path}")


if __name__ == "__main__":
    sys.exit(main())
