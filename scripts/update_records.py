"""4단계: 이번 회차 결과로 진행기록 JSON과 명단 CSV 두 개를 갱신한다.

  python3 scripts/update_records.py --config discovery_config.json --run run/ \
      --progress records/탐색진행상황.json --existing records/기존기업명단.csv \
      --cumulative records/기업컨택_누적목록.csv --out records_new/

원본은 건드리지 않고 --out 폴더에 같은 이름으로 갱신본을 쓴다. 그 파일을 Project에 다시 올린다.

반영 내용
  출처별_진행  서브에이전트별 next_position을 '다음_위치'로, 새로 찾은 디렉토리는 새 항목으로
  조회불가     new_blocked 추가(중복 제외)
  탈락기업     이번 탈락·원문 재확인 탈락 추가. 같은 이름이 있으면 사유·일자를 갱신
               재검토에서 통과한 기업은 목록에서 삭제
  예비후보     이번에 통과(선정·예비 이관)했거나 다시 탈락한 기업은 삭제, 상한으로 빠진 기업 추가
  마지막번호·최종갱신·최근회차
  기존기업명단.csv / 기업컨택_누적목록.csv  선정 기업 행 추가
"""
import argparse
import csv
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from schema import (
    CUMULATIVE_HEADERS, EXISTING_HEADERS, K_BLOCKED, K_LAST_NO, K_RECENT, K_REJECTS, K_RESERVE,
    K_SOURCES, K_UPDATED, has_value, load_config, load_json, save_json, source_names,
)
from select_candidates import is_focus, load_candidates, tier

KST = timezone(timedelta(hours=9))


def host(url):
    try:
        return urlparse(url if "://" in url else "http://" + url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def contact_origin(c):
    """누적목록 '연락처출처' 칸: 연락처를 어디서 확인했는지 짧게"""
    urls = [u for u in (c.get("출처URL") or []) if u]
    home = host(str(c.get("홈페이지") or "")) if has_value(c.get("홈페이지")) else ""
    if home and any(host(u) == home for u in urls):
        return "공식웹"
    return host(urls[0]) if urls else ""


def employee_count(v):
    m = re.search(r"\d+", str(v or ""))
    return m.group(0) if m else "확인불가"


def append_csv(src: Path, dst: Path, headers, rows):
    if src.exists():
        shutil.copy(src, dst)
    else:
        with open(dst, "w", encoding="utf-8-sig", newline="") as f:
            csv.writer(f).writerow(headers)
    with open(dst, encoding="utf-8-sig", newline="") as f:
        text = f.read()
    with open(dst, "a", encoding="utf-8", newline="") as f:
        if text and not text.endswith("\n"):
            f.write("\r\n")
        w = csv.writer(f)
        for r in rows:
            w.writerow([r.get(h, "") for h in headers])


def reserve_entry(c, today):
    loc = f"{c.get('시도', '')} {c.get('시군구', '')}".strip()
    return {
        "기업명": c["기업명"],
        "소재지": f"{loc}({c.get('임직원수', '확인불가')}, {c.get('업종', '')})",
        "출처": c.get("출처사이트", ""),
        "전화": c.get("전화", ""),
        "이메일": c.get("이메일", ""),
        "홈페이지": c.get("홈페이지", ""),
        "사유": f"{today} {c.get('_보류사유', '상한으로 보류')}" + (f" / {c['비고']}" if c.get("비고") else ""),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--run", default=Path("run"), type=Path)
    ap.add_argument("--progress", required=True, type=Path)
    ap.add_argument("--existing", required=True, type=Path)
    ap.add_argument("--cumulative", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    run = args.run
    now = datetime.now(KST)
    today = now.strftime("%Y-%m-%d")
    names_by_agent = source_names(cfg)

    progress = load_json(args.progress)
    numbered = load_json(run / "numbered.json")
    overflow = load_json(run / "overflow.json") if (run / "overflow.json").exists() else []
    dropped = load_json(run / "dropped.json") if (run / "dropped.json").exists() else []
    recheck = load_json(run / "recheck.json") if (run / "recheck.json").exists() else []
    xlsx = load_json(run / "xlsx_name.json") if (run / "xlsx_name.json").exists() else {}
    _, rejected, meta = load_candidates(run)

    # 출처별 진행 위치
    sources = progress.setdefault(K_SOURCES, {})
    sources.pop("충북 조사 메모", None)
    blocked = progress.setdefault(K_BLOCKED, [])
    for path in sorted(run.glob("result_*.json")):
        data = load_json(path)
        agent = data.get("agent") or path.stem.split("_")[-1]
        name = names_by_agent.get(agent, f"서브에이전트 {agent}")
        if data.get("next_position"):
            entry = sources.setdefault(name, {})
            entry["다음_위치"] = data["next_position"]
            entry["최종갱신"] = now.strftime("%Y-%m-%d %H:%M")
            if entry.get("상태") in (None, "미착수"):
                entry["상태"] = "진행중"
        for s in data.get("new_sources", []) or []:
            if s.get("이름") and s["이름"] not in sources:
                sources[s["이름"]] = {"상태": "신규", "URL": s.get("URL", ""), "형식": s.get("형식", ""),
                                     "다음_위치": s.get("다음위치", ""), "발견": today}
        for b in data.get("new_blocked", []) or []:
            if b and b not in blocked:
                blocked.append(b)

    # 탈락기업
    passed_names = {c["기업명"] for c in numbered} | {c["기업명"] for c in overflow}
    rejects = [r for r in progress.get(K_REJECTS, [])
               if not (r["기업명"] in passed_names and r["기업명"] in {x["기업명"] for x in recheck})]
    index = {r["기업명"]: r for r in rejects}
    new_rejects = [{"기업명": r.get("기업명", ""), "사유": r.get("사유", "")} for r in rejected]
    new_rejects += [{"기업명": d["기업명"], "사유": "원문 재확인 불일치: " + d.get("사유", "")} for d in dropped]
    for r in new_rejects:
        if not r["기업명"]:
            continue
        if r["기업명"] in index:
            index[r["기업명"]].update(사유=r["사유"], 일자=today)
        else:
            entry = {**r, "일자": today}
            rejects.append(entry)
            index[r["기업명"]] = entry
    progress[K_REJECTS] = rejects

    # 예비후보
    gone = passed_names | {r["기업명"] for r in new_rejects}
    reserve = [r for r in progress.get(K_RESERVE, []) if r["기업명"] not in gone]
    reserve += [reserve_entry(c, today) for c in overflow]
    progress[K_RESERVE] = reserve

    last_no = numbered[-1]["번호"] if numbered else progress.get(K_LAST_NO, 0)
    progress[K_LAST_NO] = last_no
    progress[K_UPDATED] = now.strftime("%Y-%m-%d %H:%M KST")
    progress[K_RECENT] = {
        "일시": progress[K_UPDATED],
        "파일": xlsx.get("file", ""),
        "개수": len(numbered),
        "예비_이관": len(overflow),
        "조건②": sum(tier(c) == 3 for c in numbered),
        "중점분야": sum(is_focus(c) for c in numbered),
        "서브에이전트": meta,
    }

    args.out.mkdir(parents=True, exist_ok=True)
    save_json(args.out / args.progress.name, progress)

    stamp = now.strftime("%Y%m%d")
    append_csv(args.existing, args.out / args.existing.name, EXISTING_HEADERS, [
        {"번호": c["번호"], "기업명": c["기업명"],
         "전화": c.get("전화", "") if has_value(c.get("전화")) else "",
         "이메일": c.get("이메일", "") if has_value(c.get("이메일")) else "",
         "출처": f"{stamp} 추가분"} for c in numbered])
    append_csv(args.cumulative, args.out / args.cumulative.name, CUMULATIVE_HEADERS, [
        {"번호": c["번호"], "기업명": c["기업명"], "소재지": f"{c.get('시도', '')} {c.get('시군구', '')}".strip(),
         "업종": c.get("업종", ""), "임직원수": employee_count(c.get("임직원수")),
         "홈페이지": c.get("홈페이지", "") if has_value(c.get("홈페이지")) else "",
         "연락처출처": contact_origin(c), "출처사이트": c.get("출처사이트", ""), "추가일시": today}
        for c in numbered])

    print(f"갱신 완료 → {args.out}/ : 추가 {len(numbered)}행(마지막번호 {last_no}), "
          f"탈락 누적 {len(rejects)}, 예비후보 {len(reserve)}, 조회불가 {len(blocked)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
