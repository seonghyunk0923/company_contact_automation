"""서브에이전트용 중복 확인기.

후보의 기업명·전화·이메일을 인자로 여러 개 한꺼번에 넘기면 한 줄씩 판정한다.
도구 호출 한 번으로 여러 후보를 거르기 위해 인자를 묶어 받는다.

  python3 run/check_dup.py "(주)가나정밀" "031-000-0000" "info@example.com" "다라산업"

출력 예:
  (주)가나정밀 => 중복/제외: 가나정밀(주)
  031-000-0000 => OK
  info@example.com => OK
  다라산업 => OK

기준 파일은 같은 폴더의 exclude_names.txt (prep_exclude.py가 생성). --exclude로 바꿀 수 있다.
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from normalize import names_match, norm_name, norm_phone  # noqa: E402


def load_exclude(path: Path):
    names, phones, emails = [], set(), set()
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# [NAMES]"):
            section = "n"
            continue
        if line.startswith("# [PHONES]"):
            section = "p"
            continue
        if line.startswith("# [EMAILS]"):
            section = "e"
            continue
        if not line or line.startswith("#"):
            continue
        if section == "n":
            parts = line.split("\t")
            original = parts[0]
            normalized = parts[1] if len(parts) > 1 else norm_name(original)
            names.append((original, normalized))
        elif section == "p":
            phones.add(line.strip())
        elif section == "e":
            emails.add(line.strip().lower())
    return names, phones, emails


def check(query: str, names, phones, emails):
    if "@" in query:
        return [f"EMAIL {query}"] if query.strip().lower() in emails else []
    if re.fullmatch(r"[\d\-\s~()]+", query):
        return [f"PHONE {query}"] if norm_phone(query) in phones else []
    q = norm_name(query)
    return [original for original, normalized in names if names_match(q, normalized)]


def main():
    default_exclude = Path(__file__).resolve().with_name("exclude_names.txt")
    ap = argparse.ArgumentParser(description="후보 기업 중복 확인")
    ap.add_argument("queries", nargs="+", help="기업명·전화·이메일 (여러 개 가능)")
    ap.add_argument("--exclude", type=Path, default=default_exclude)
    args = ap.parse_args()

    names, phones, emails = load_exclude(args.exclude)
    for q in args.queries:
        hits = check(q, names, phones, emails)
        print(q, "=>", "중복/제외: " + ", ".join(hits[:5]) if hits else "OK")


if __name__ == "__main__":
    main()
