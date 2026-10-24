"""파일 형식 상수. 스크립트끼리, 그리고 Apps Script와 맞춰야 하는 이름은 모두 여기에 둔다."""
import json
from pathlib import Path

# 컨택 시트(=추가분 엑셀 시트1) 16열. Apps Script도 이 열 이름으로 위치를 찾는다.
CONTACT_HEADERS = [
    "번호", "팀원명", "팀원연락처", "기업명", "메일답장여부", "전화 연결 여부", "전화 내용",
    "전화한 인원 이름", "담당자 연락처(전화번호+이메일)", "홈페이지 주소", "컨택일자", "방문일자",
    "기업소개 및 제안주제", "직무명", "담당자명/직급", "초안작성여부",
]
# 사람이 채우거나 Apps Script가 채우는 열 → 발굴 파이프라인은 반드시 비워 둔다
MUST_BE_BLANK = [
    "팀원명", "팀원연락처", "메일답장여부", "전화 연결 여부", "전화 내용",
    "전화한 인원 이름", "컨택일자", "방문일자", "초안작성여부",
]
VERIFY_HEADERS = [
    "번호", "기업명", "시도", "시군구", "업종", "임직원수", "통과조건(①/②)", "중점분야 여부",
    "재검토 여부", "출처사이트", "출처URL", "비고(확인 필요 사항)",
]
REJECT_HEADERS = ["기업명", "사유", "출처"]
SHEET_NAMES = ["추가분", "검증정보", "탈락", "요약"]

EXISTING_HEADERS = ["번호", "기업명", "전화", "이메일", "출처"]
CUMULATIVE_HEADERS = ["번호", "기업명", "소재지", "업종", "임직원수", "홈페이지", "연락처출처", "출처사이트", "추가일시"]

# 진행기록 JSON 키
K_SOURCES = "출처별_진행"
K_BLOCKED = "조회불가_사이트"
K_REJECTS = "탈락기업"
K_RESERVE = "예비후보(통과 가능·상한으로 보류)"
K_LAST_NO = "마지막번호"
K_UPDATED = "최종갱신"
K_RECENT = "최근회차"

RECHECK_MARK = "[재검토가능]"
RECHECK_DONE = "재검토:"

UNKNOWN = "확인불가"
NO_HOMEPAGE = "공식홈페이지 없음"
EMPTY_VALUES = {"", UNKNOWN, NO_HOMEPAGE, None}


def has_value(v) -> bool:
    return (v.strip() if isinstance(v, str) else v) not in EMPTY_VALUES


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def load_config(path):
    """discovery_config.json 읽기. '_'로 시작하는 설명 키는 무시한다."""
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if not k.startswith("_")}
        if isinstance(o, list):
            return [strip(v) for v in o]
        return o
    return strip(load_json(path))


def source_names(config) -> dict:
    """서브에이전트 ID → 출처 이름"""
    return {s["id"]: s["name"] for s in config.get("sources", [])}
