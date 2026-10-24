# 발굴 파이프라인 프롬프트

> claude.ai **Project 안에서** 이 코드 블록을 그대로 붙여 넣어 실행합니다.
> - 매일 자동으로 돌리려면 그 Project에서 예약 작업(scheduled task)을 만들고 프롬프트로 넣습니다.
> - 예약 작업을 못 쓰면 Project의 새 채팅에 붙여 넣어 1회씩 실행해도 됩니다.
>
> 팀마다 바꿀 값은 이 프롬프트가 아니라 Project에 올린 `discovery_config.json`에 있습니다.
> 준비 순서는 [`SETUP.md`](../SETUP.md) 2단계를 보세요.

---

```text
[발굴 파이프라인] 중소 제조기업 컨택 후보 발굴 — 설정 파일 기반

예약 작업으로 실행 중이면 질문으로 멈추지 말고 합리적으로 판단해 진행하고, 가정은 보고에 적는다. 사람이 읽을 보고는 SendUserMessage로 보낸다.

■ 저장소와 설정
- 스크립트·규칙 저장소: https://github.com/seonghyunk0923/company_contact_automation
- 설정: Project 문서 discovery_config.json (없으면 중단하고 "discovery_config.json을 Project에 올려 주세요"라고 보고)
- 아래에서 config는 이 설정 파일을 뜻한다. 작업 디렉터리는 work/ 로 한다.

■ 대원칙 (모든 단계·서브에이전트 공통)
1. 작문 금지: 도메인·이메일·담당자명을 회사명으로 추측·조합하지 않는다. 원문 값만 기록한다.
2. 출처 URL 필수: 연락처·홈페이지·임직원수·최근활동을 발췌한 상세 페이지 URL을 남긴다.
3. 확인 못 한 값은 '확인불가'(홈페이지는 '공식홈페이지 없음').
4. robots·SSL·403으로 막힌 사이트는 우회하지 않는다.

■ 0단계: 준비 (메인)
1) 저장소 받기: git clone --depth 1 https://github.com/seonghyunk0923/company_contact_automation work/repo
   - 실패하면 Project 문서 중 scripts/ 로 시작하는 .py 파일과 prompts/subagent_rules.md 가 있는지 project_info로 확인하고, 있으면 project_read로 work/repo/scripts/, work/repo/prompts/ 에 같은 이름으로 저장한다. 둘 다 안 되면 중단하고 보고한다.
   - pip install openpyxl (없을 때만, --break-system-packages)
2) 설정·기록 받기: project_read로 discovery_config.json 을 work/run/discovery_config.json 에 저장한다.
   config.files의 progress·existing·cumulative 경로를 project_read해 work/records/ 에 각각 탐색진행상황.json, 기존기업명단.csv, 기업컨택_누적목록.csv 로 저장한다.
   - 그 경로에 없으면 Project 루트에 같은 파일 이름(예: 기존기업명단.csv)이 있는지 project_info로 확인하고 있으면 그것을 쓴다. 팀이 처음에 루트에 올린 제외 명단을 놓치지 않기 위해서다.
   - 큰 파일은 project_read가 돌려준 로컬 경로를 복사한다.
   - 세 파일이 Project에 없으면 첫 실행이다: python3 work/repo/scripts/init_records.py --config work/run/discovery_config.json --out work/records/ 로 만든다. (기존기업명단만 있으면 그것은 그대로 쓰고 나머지만 만든다.)
3) 작업 파일 만들기:
   cd work/repo/scripts && python3 prep_exclude.py --config ../../run/discovery_config.json --progress ../../records/탐색진행상황.json --existing ../../records/기존기업명단.csv --cumulative ../../records/기업컨택_누적목록.csv --out ../../run
   cp work/repo/prompts/subagent_rules.md work/run/rules.md
   → work/run/ 에 exclude_names.txt, recheck.json, reserve.json, sources.json, check_dup.py, normalize.py, rules.md 가 생긴다.

■ 1단계: 서브에이전트 병렬 탐색
- config.sources 중 enabled가 true인 출처마다 서브에이전트를 하나씩, Agent 도구로 동시에 띄운다(최대 5개).
- 각 서브에이전트 프롬프트에 넣을 것:
  · "너는 서브에이전트 <id>다. 먼저 work/run/rules.md 를 읽고 그대로 따른다. 기준값은 work/run/discovery_config.json 에 있다."
  · 담당 출처의 name과 how(조회 방법) 원문
  · work/run/sources.json 에서 그 출처 이름의 다음_위치(또는 메모). 없으면 "처음부터"
  · type이 reserve인 출처: work/run/reserve.json(예비후보)과 work/run/recheck.json(재검토 대상)을 먼저 처리하라는 지시
  · type이 discover인 출처: 새 디렉토리를 찾아 new_sources에 기록하라는 지시
  · 결과 파일 경로 work/run/result_<id>.json, 호출 상한 config.run.agent_call_limit
- 서브에이전트가 모두 끝나면 추가 탐색을 하지 않는다. 모인 결과에서만 고른다.
- 결과 파일이 없거나 JSON이 깨진 서브에이전트는 보고에 적고 나머지로 진행한다.

■ 2단계: 선정과 원문 재확인 (메인)
1) cd work/repo/scripts && python3 select_candidates.py --config ../../run/discovery_config.json --run ../../run
   → selected.json, overflow.json, duplicates.json, spot_check.json, summary.json
2) spot_check.json 의 기업마다 출처URL 하나를 WebFetch로 열어 기업명·연락처·지역이 결과와 같은지 확인한다.
   다르면 work/run/dropped.json 에 [{"기업명": "...", "사유": "무엇이 달랐는지", "출처": "URL"}] 로 추가하고 1)을 다시 실행한다. 새로 나온 spot_check.json 에서 이미 확인한 기업은 건너뛴다. 재확인은 최대 2번 돈다.
3) 회사별 '제안안'이 비어 있으면 selected.json 에 업종·주요사업에 맞는 1문장을 채운다(config.team.proposal_hint 참고, 원문에 없는 사실은 쓰지 않는다).

■ 3단계: 엑셀
cd work/repo/scripts && python3 build_xlsx.py --config ../../run/discovery_config.json --run ../../run --progress ../../records/탐색진행상황.json --existing ../../records/기존기업명단.csv --out-dir /mnt/user-data/outputs
- 검증에 실패하면 원인을 고친 뒤 다시 실행한다. 엑셀 파일을 SendUserFile로 보낸다.
- 선정이 0개면 엑셀을 만들지 않고 4단계 보고로 넘어간다(진행기록은 갱신한다: numbered.json 이 없으면 빈 배열 [] 로 만든다).

■ 4단계: 기록 갱신과 보고
1) cd work/repo/scripts && python3 update_records.py --config ../../run/discovery_config.json --run ../../run --progress ../../records/탐색진행상황.json --existing ../../records/기존기업명단.csv --cumulative ../../records/기업컨택_누적목록.csv --out ../../records_new
2) work/records_new/ 의 세 파일을 config.files 의 경로로 project_write(local_path) 한다. 실패하면 /mnt/user-data/outputs/ 에도 저장하고 보고에 적는다.
3) SendUserMessage 보고(표 없이 3~8줄). summary.json 을 근거로:
   - 첫 줄: "○개 추가, 파일명"
   - 출처·시도·업종별 개수와 상한 준수 여부, 중점분야 수, 이메일·홈페이지 확보 수, 조건② 통과 수, 재검토·예비후보 통과 수
   - 목표보다 적으면 부족 수와 빠진 이유(summary.빠진_이유)
   - 원문 재확인에서 뺀 기업, 비고에 확인 필요가 적힌 기업
   - 마지막 줄: "엑셀을 Drive 추가분 폴더에 Google 시트로 올리면 컨택 시트에 반영됩니다."
```

## 프롬프트에서 바꾸는 곳

- **저장소 주소** — 프롬프트는 이 저장소에서 스크립트를 내려받습니다. 저장소를 포크해서 스크립트를 고쳤다면, 프롬프트의 `https://github.com/seonghyunk0923/company_contact_automation` 두 곳을 포크한 주소로 바꿉니다.
- 나머지 기준(지역·인원·업종·상한·출처)은 모두 `discovery_config.json`에서 바꿉니다.
