"""2단계: 서브에이전트 결과를 합쳐 중복을 지우고, 상한을 지키며 최대 N개를 고른다.

  python3 scripts/select_candidates.py --config discovery_config.json --run run/

읽는 파일 (run/)
  result_*.json        서브에이전트 결과
  exclude_names.txt    prep_exclude.py가 만든 제외명단
  dropped.json         (선택) 원문 재확인에서 떨어뜨린 기업 [{"기업명":..., "사유":...}]

쓰는 파일 (run/)
  selected.json        최종 선정(선정 순서대로)
  overflow.json        통과했지만 상한·개수 때문에 빠진 기업 → 다음 회차 예비후보
  duplicates.json      제외명단 또는 서로 간 중복으로 지운 기업
  spot_check.json      원문 재확인할 기업(조건② 통과분 우선)
  summary.json         출처·지역·업종별 개수, 상한 준수 여부, 부족 수

원문 재확인에서 불일치가 나오면 dropped.json에 적고 이 스크립트를 다시 돌리면
그 기업을 빼고 다음 후보로 채운다. 같은 --seed면 재확인 대상도 같게 나온다.

선정 규칙
  1) 우선순위: 조건① + 이메일·홈페이지 모두 > 조건① > 조건②
  2) 같은 순위면 중점분야(focus_tags) 기업 우선, 그다음 업종·시군구·출처가 덜 겹치는 쪽
  3) 상한: 출처별, 시·도별(per_region_override 우선), 시·군·구별, 업종별
"""
import argparse
import glob
import random
import sys
from collections import Counter
from pathlib import Path

from check_dup import check as dup_check
from check_dup import load_exclude
from normalize import names_match, norm_name, norm_phone
from schema import has_value, load_config, load_json, save_json


def is_focus(c) -> bool:
    v = str(c.get("중점분야", c.get("반도체이차전지", ""))).strip()
    return bool(v) and v not in ("아니오", "해당없음", "X", "x")


def tier(c) -> int:
    cond = str(c.get("통과조건", ""))
    if "①" in cond or cond.strip() == "1":
        return 1 if has_value(c.get("이메일")) and has_value(c.get("홈페이지")) else 2
    return 3


def load_candidates(run: Path):
    cands, rejected, meta = [], [], {}
    for path in sorted(glob.glob(str(run / "result_*.json"))):
        data = load_json(path)
        agent = data.get("agent") or Path(path).stem.split("_")[-1]
        meta[agent] = {"calls_used": data.get("calls_used"), "passed": len(data.get("passed", [])),
                       "rejected": len(data.get("rejected", []))}
        for i, c in enumerate(data.get("passed", [])):
            c = dict(c)
            c["_agent"] = agent
            c["_order"] = (agent, i)
            cands.append(c)
        for r in data.get("rejected", []):
            rejected.append({**r, "_agent": agent})
    return cands, rejected, meta


def same_company(a, b) -> bool:
    if names_match(norm_name(a.get("기업명", "")), norm_name(b.get("기업명", ""))):
        return True
    pa, pb = norm_phone(a.get("전화", "")), norm_phone(b.get("전화", ""))
    if len(pa) >= 7 and pa == pb:
        return True
    ea, eb = str(a.get("이메일", "")).strip().lower(), str(b.get("이메일", "")).strip().lower()
    return "@" in ea and ea == eb


def dedupe(cands, exclude, dropped_names):
    names, phones, emails = exclude
    kept, dups = [], []
    for c in sorted(cands, key=lambda c: (tier(c), not is_focus(c), c["_order"])):
        if c["기업명"] in dropped_names:
            continue
        hits = []
        for q in (c.get("기업명"), c.get("전화"), c.get("이메일")):
            if has_value(q):
                hits += dup_check(str(q), names, phones, emails)
        if hits:
            dups.append({**c, "_중복": "제외명단: " + ", ".join(hits[:3])})
            continue
        twin = next((k for k in kept if same_company(c, k)), None)
        if twin:
            dups.append({**c, "_중복": f"서브에이전트 간 중복: {twin['기업명']}({twin['_agent']})"})
            continue
        kept.append(c)
    return kept, dups


class Caps:
    def __init__(self, caps):
        self.c = caps
        self.n = {k: Counter() for k in ("source", "region", "district", "industry")}

    @staticmethod
    def keys(c):
        return {
            "source": c.get("출처사이트", ""),
            "region": c.get("시도", ""),
            "district": (c.get("시도", ""), c.get("시군구", "")),
            "industry": c.get("업종", ""),
        }

    def limit(self, kind, key):
        if kind == "source":
            return self.c.get("per_source", 10**9)
        if kind == "region":
            return self.c.get("per_region_override", {}).get(key, self.c.get("per_region", 10**9))
        if kind == "district":
            return self.c.get("per_district", 10**9)
        return self.c.get("per_industry", 10**9)

    def blocked_by(self, c):
        return [kind for kind, key in self.keys(c).items() if self.n[kind][key] >= self.limit(kind, key)]

    def add(self, c):
        for kind, key in self.keys(c).items():
            self.n[kind][key] += 1


def select(pool, caps_cfg, max_n):
    caps = Caps(caps_cfg)
    selected, rest = [], list(pool)
    while len(selected) < max_n:
        fits = [c for c in rest if not caps.blocked_by(c)]
        if not fits:
            break
        k = caps.keys

        def score(c):
            ks = k(c)
            return (tier(c), not is_focus(c), caps.n["industry"][ks["industry"]],
                    caps.n["district"][ks["district"]], caps.n["source"][ks["source"]], c["_order"])

        best = min(fits, key=score)
        selected.append(best)
        caps.add(best)
        rest.remove(best)
    overflow = []
    for c in rest:
        why = caps.blocked_by(c)
        overflow.append({**c, "_보류사유": ("상한: " + ", ".join(why)) if why else f"최대 {max_n}개 초과"})
    return selected, overflow, caps


def summarize(selected, overflow, dups, rejected, meta, caps, cfg):
    def count(field):
        return dict(Counter(c.get(field, "") for c in selected).most_common())
    max_n = cfg["run"].get("max_per_run", 50)
    sources = count("출처사이트")
    ok = {
        kind: all(n <= caps.limit(kind, key) for key, n in caps.n[kind].items())
        for kind in caps.n
    }
    return {
        "선정": len(selected),
        "목표": max_n,
        "부족": max(0, max_n - len(selected)),
        "예비로_이관": len(overflow),
        "중복_제거": len(dups),
        "탈락": len(rejected),
        "출처별": sources,
        "시도별": count("시도"),
        "시군구별": {f"{a} {b}": n for (a, b), n in Counter((c.get("시도"), c.get("시군구")) for c in selected).most_common()},
        "업종별": count("업종"),
        "상한_준수": ok,
        "출처_수": len(sources),
        "출처_최소_충족": len(sources) >= cfg["caps"].get("min_sources", 0),
        "중점분야": sum(is_focus(c) for c in selected),
        "이메일_확보": sum(has_value(c.get("이메일")) for c in selected),
        "홈페이지_확보": sum(has_value(c.get("홈페이지")) for c in selected),
        "조건②_통과": sum(tier(c) == 3 for c in selected),
        "재검토_통과": sum(str(c.get("재검토")) == "예" for c in selected),
        "예비후보_통과": sum(str(c.get("예비후보")) == "예" for c in selected),
        "서브에이전트": meta,
        "빠진_이유": dict(Counter(c["_보류사유"] for c in overflow).most_common()),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--run", default=Path("run"), type=Path)
    ap.add_argument("--exclude", type=Path, help="기본값: <run>/exclude_names.txt")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    cfg.setdefault("run", {})
    cfg.setdefault("caps", {})
    run = args.run
    exclude = load_exclude(args.exclude or run / "exclude_names.txt")
    dropped_path = run / "dropped.json"
    dropped = load_json(dropped_path) if dropped_path.exists() else []
    dropped_names = {d["기업명"] for d in dropped}

    cands, rejected, meta = load_candidates(run)
    pool, dups = dedupe(cands, exclude, dropped_names)
    selected, overflow, caps = select(pool, cfg["caps"], cfg["run"].get("max_per_run", 50))

    lo, hi = cfg["run"].get("spot_check", [3, 5])
    rng = random.Random(args.seed)
    cond2 = [c for c in selected if tier(c) == 3]
    others = [c for c in selected if tier(c) != 3]
    rng.shuffle(cond2)
    rng.shuffle(others)
    k = min(len(selected), rng.randint(lo, hi))
    spot = (cond2 + others)[:k]

    summary = summarize(selected, overflow, dups, rejected, meta, caps, cfg)
    save_json(run / "selected.json", selected)
    save_json(run / "overflow.json", overflow)
    save_json(run / "duplicates.json", dups)
    save_json(run / "spot_check.json", [{"기업명": c["기업명"], "출처URL": c.get("출처URL"),
                                          "통과조건": c.get("통과조건")} for c in spot])
    save_json(run / "summary.json", summary)

    print(f"선정 {len(selected)}/{summary['목표']} · 예비 이관 {len(overflow)} · 중복 제거 {len(dups)} · "
          f"출처 {summary['출처_수']}곳 · 재확인 대상 {len(spot)}개")
    if summary["부족"]:
        print(f"부족 {summary['부족']}개 — 빠진 이유: {summary['빠진_이유'] or '통과 후보 부족'}")


if __name__ == "__main__":
    sys.exit(main())
