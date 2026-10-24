"""0단계: 진행기록과 기업 명단에서 서브에이전트용 작업 파일을 만든다.

서브에이전트 여럿이 원본 CSV(수천 행)와 진행기록 JSON을 각자 다시 읽지 않도록,
필요한 것만 추려 작업 디렉터리에 써 둔다.

  exclude_names.txt  중복 확인 기준(기업명·정규화명, 전화, 이메일)
  recheck.json       이번 회차 재검토 대상(설정 run.recheck_per_run개까지)
  reserve.json       예비후보 전체
  sources.json       출처별 다음 조회 위치 + 조회불가 사이트
  check_dup.py, normalize.py  서브에이전트가 run/ 에서 바로 쓰는 중복 확인기

사용법:
  python3 scripts/prep_exclude.py --config discovery_config.json \
      --progress records/탐색진행상황.json --existing records/기존기업명단.csv \
      --cumulative records/기업컨택_누적목록.csv --out run/
"""
import argparse
import csv
import re
import shutil
import sys
from pathlib import Path

from normalize import norm_name, norm_phone
from schema import (
    K_BLOCKED, K_REJECTS, K_RESERVE, K_SOURCES, RECHECK_DONE, RECHECK_MARK,
    load_config, load_json, save_json,
)

DROP_SOURCE_KEYS = {"충북 조사 메모"}


def read_csv(path: Path):
    if not path or not Path(path).exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def split_multi(value: str):
    """'031-1-2, 031-3-4' 또는 'a@x.com / b@y.com' 처럼 여러 값이 든 칸을 나눈다."""
    return [v for v in re.split(r"[,/\s]+", value or "") if v]


def pick_recheck(rejects, limit):
    """[재검토가능] 표시가 있고 아직 재검토하지 않은 기업, 앞에서부터 limit개"""
    return [
        r for r in rejects
        if RECHECK_MARK in r.get("사유", "") and RECHECK_DONE not in r.get("사유", "")
    ][:limit]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=Path, help="discovery_config.json (재검토 개수에 사용)")
    ap.add_argument("--progress", required=True, type=Path)
    ap.add_argument("--existing", required=True, type=Path)
    ap.add_argument("--cumulative", required=True, type=Path)
    ap.add_argument("--out", default=Path("run"), type=Path)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)

    limit = 5
    if args.config:
        limit = load_config(args.config).get("run", {}).get("recheck_per_run", limit)

    progress = load_json(args.progress)
    rejects = progress.get(K_REJECTS, [])
    recheck = pick_recheck(rejects, limit)
    recheck_names = {r["기업명"] for r in recheck}

    names, phones, emails = set(), set(), set()
    for row in read_csv(args.existing):
        if row.get("기업명", "").strip():
            names.add(row["기업명"].strip())
        for p in split_multi(row.get("전화")):
            digits = norm_phone(p)
            if len(digits) >= 7:
                phones.add(digits)
        for e in split_multi(row.get("이메일")):
            if "@" in e:
                emails.add(e.strip().lower())
    for row in read_csv(args.cumulative):
        if row.get("기업명", "").strip():
            names.add(row["기업명"].strip())
    for r in rejects:
        if r["기업명"] not in recheck_names:
            names.add(r["기업명"].strip())

    with open(args.out / "exclude_names.txt", "w", encoding="utf-8") as f:
        f.write("# 제외명단: 기존기업명단 + 누적목록 + 탈락기업(이번 회차 재검토 대상 제외)\n")
        f.write("# [NAMES] 원명\\t정규화명\n")
        for n in sorted(names):
            f.write(f"{n}\t{norm_name(n)}\n")
        f.write("# [PHONES] 숫자만\n")
        f.writelines(p + "\n" for p in sorted(phones))
        f.write("# [EMAILS]\n")
        f.writelines(e + "\n" for e in sorted(emails))

    reserve = progress.get(K_RESERVE, [])
    save_json(args.out / "recheck.json", recheck)
    save_json(args.out / "reserve.json", reserve)
    save_json(args.out / "sources.json", {
        K_SOURCES: {k: v for k, v in progress.get(K_SOURCES, {}).items() if k not in DROP_SOURCE_KEYS},
        K_BLOCKED: progress.get(K_BLOCKED, []),
    })

    # 서브에이전트가 run/check_dup.py 로 바로 쓸 수 있도록 확인기와 정규화 모듈을 함께 복사
    here = Path(__file__).resolve().parent
    for name in ("check_dup.py", "normalize.py"):
        if (args.out / name).resolve() != (here / name):
            shutil.copy(here / name, args.out / name)

    print(f"names={len(names)} phones={len(phones)} emails={len(emails)} "
          f"recheck={len(recheck)} reserve={len(reserve)} -> {args.out}/")


if __name__ == "__main__":
    sys.exit(main())
