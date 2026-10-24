"""기업명·전화번호 정규화 함수 (prep_exclude.py, check_dup.py 공용)."""
import re

# 법인 표기와 괄호 안 부기(지역명 등)를 지운 뒤 공백·구두점을 제거한다.
_CORP_MARKS = re.compile(
    r"\(주\)|㈜|주식회사|\(유\)|유한회사|주）|주\.|\(.*?\)|（.*?）"
)
_PUNCT = re.compile(r"[\s\.\,\-·&]")


def norm_name(name: str) -> str:
    """'(주)가나정밀(안산)' → '가나정밀'"""
    s = _CORP_MARKS.sub("", name or "")
    s = _PUNCT.sub("", s)
    return s.lower()


def norm_phone(phone: str) -> str:
    """'031-123-4567' → '0311234567'"""
    return re.sub(r"\D", "", phone or "")


# 부분일치를 허용하는 최소 길이. '(주)일'·'(주)케이' 같은 짧은 이름이
# 무관한 회사에 걸리는 오탐을 막기 위해 양쪽 모두 3자 이상일 때만 적용한다.
MIN_PARTIAL_LEN = 3


def names_match(a: str, b: str) -> bool:
    """정규화된 두 이름이 같거나, 양쪽 모두 3자 이상이면서 한쪽이 다른 쪽을 포함하면 True."""
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) >= MIN_PARTIAL_LEN and len(b) >= MIN_PARTIAL_LEN:
        return a in b or b in a
    return False
