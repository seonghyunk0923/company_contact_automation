# 기록 파일 형식

실제 기업 명단·연락처·진행기록은 **이 저장소에 넣지 않습니다.** 공개 디렉토리에서 모은 연락처라도 재배포 문제가 있고, 담당자 개인 연락처가 섞일 수 있기 때문입니다. `.gitignore`가 `data/` 아래 실제 파일과 실행 중 작업 폴더(`work/`, `run/`, `records/`)를 막아 둡니다.

[`sample/`](sample)에는 형식만 보여 주는 **가상의** 예시가 있습니다. 회사명·전화번호·이메일은 모두 지어낸 값(`example.com`, `000-0000`)입니다.

운영할 때 이 세 파일은 claude.ai Project 안(`config.files` 경로, 기본 `claude/…`)에 있고, 발굴 프롬프트가 매 실행마다 읽고 갱신합니다. 첫 실행 때 없으면 [`init_records.py`](../scripts/init_records.py)가 빈 파일을 만듭니다.

## 기존기업명단.csv — 중복 확인 기준

컨택 시트에 이미 있는 기업, 제외하고 싶은 기업. 이 명단과 이름(정규화 후 일치·부분일치)·전화·이메일이 겹치면 발굴에서 빠집니다.

| 열 | 설명 |
|---|---|
| 번호 | 컨택 시트 행 번호. 다음 실행의 번호는 이 값의 최대값 다음부터 |
| 기업명 | 시트에 적힌 그대로 |
| 전화, 이메일 | 여러 개면 `,` `/` 로 구분 |
| 출처 | 예: `원본시트`, `20261001 추가분` |

## 기업컨택_누적목록.csv — 발굴로 추가한 이력

`번호, 기업명, 소재지, 업종, 임직원수, 홈페이지, 연락처출처, 출처사이트, 추가일시`

## 탐색진행상황.json — 실행 사이의 상태

| 키 | 내용 |
|---|---|
| `출처별_진행` | 출처 이름별 `상태`(미착수·진행중·소진·신규·사용불가)와 `다음_위치`(다음에 조회할 URL·페이지·미처리 후보) |
| `조회불가_사이트` | robots·SSL·403 등으로 실패한 사이트. 서브에이전트가 시도하지 않음 |
| `탈락기업` | `{기업명, 사유, 일자}`. 사유에 `[재검토가능]`이 있으면 재검토 대상, `재검토:`로 시작하면 이미 재검토함 |
| `예비후보(통과 가능·상한으로 보류)` | 검증은 통과했지만 상한 때문에 빠진 기업. 다음 실행에 먼저 재확인 |
| `최근회차` | 마지막 실행 일시·파일명·개수 |
| `마지막번호` | 다음 실행의 번호 매기기 기준 |

## 실행 중 작업 파일 (`run/`)

| 파일 | 만드는 곳 | 쓰는 곳 |
|---|---|---|
| `discovery_config.json`, `rules.md` | 메인(복사) | 서브에이전트 |
| `exclude_names.txt`, `recheck.json`, `reserve.json`, `sources.json`, `check_dup.py`, `normalize.py` | `prep_exclude.py` | 서브에이전트 |
| `result_<ID>.json` | 서브에이전트 | `select_candidates.py` |
| `dropped.json` | 메인(원문 재확인 불일치) | `select_candidates.py`, `update_records.py` |
| `selected.json`, `overflow.json`, `duplicates.json`, `spot_check.json`, `summary.json` | `select_candidates.py` | 메인, `build_xlsx.py` |
| `numbered.json`, `xlsx_name.json` | `build_xlsx.py` | `update_records.py` |

## 로컬에서 스크립트만 돌려 보기

```bash
cd scripts
python3 init_records.py --config ../config/discovery.example.json --out ../records
python3 prep_exclude.py --config ../config/discovery.example.json --progress ../records/탐색진행상황.json \
  --existing ../records/기존기업명단.csv --cumulative ../records/기업컨택_누적목록.csv --out ../run
# run/result_A.json 등을 subagent_rules.md 형식으로 만든 뒤
python3 select_candidates.py --config ../config/discovery.example.json --run ../run
python3 build_xlsx.py --config ../config/discovery.example.json --run ../run \
  --progress ../records/탐색진행상황.json --existing ../records/기존기업명단.csv --out-dir ../outputs
python3 update_records.py --config ../config/discovery.example.json --run ../run \
  --progress ../records/탐색진행상황.json --existing ../records/기존기업명단.csv \
  --cumulative ../records/기업컨택_누적목록.csv --out ../records_new
```

[`tests/test_pipeline.py`](../tests/test_pipeline.py)가 이 흐름 전체를 가상 결과로 돌려 봅니다.
