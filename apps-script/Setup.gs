/**
 * 시트 메뉴 · 초기 설정 · 설정 점검
 *
 *  설치 직후 시트를 새로고침하면 [🤖 컨택 자동화] 메뉴가 생깁니다.
 *  [⚙ 초기 설정]을 한 번 실행하면
 *   1) 컨택 시트에 머리글 16열이 없으면 1행에 만들고
 *   2) 추가분을 올릴 Drive 폴더를 컨택 시트와 같은 폴더에 만들고
 *   3) 팀장 연락처·참조 메일·제안서 파일을 차례로 물어 스크립트 속성에 저장합니다.
 */

/** 컨택 시트 16열. 발굴 파이프라인(scripts/schema.py CONTACT_HEADERS)과 같아야 합니다. */
const CONTACT_HEADERS = [
  '번호', '팀원명', '팀원연락처', '기업명', '메일답장여부', '전화 연결 여부', '전화 내용',
  '전화한 인원 이름', '담당자 연락처(전화번호+이메일)', '홈페이지 주소', '컨택일자', '방문일자',
  '기업소개 및 제안주제', '직무명', '담당자명/직급', '초안작성여부',
];
const IMPORT_FOLDER_NAME = '기업컨택_추가분';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🤖 컨택 자동화')
    .addItem('⚙ 초기 설정', 'initialSetup')
    .addItem('✅ 설정 점검', 'checkSetup')
    .addSeparator()
    .addItem('📥 추가분 지금 반영', 'importNewRowsNow')
    .addItem('⏰ 추가분 자동 반영 켜기 (매시간)', 'enableAutoImport')
    .addItem('⏸ 추가분 자동 반영 끄기', 'disableAutoImport')
    .addSeparator()
    .addItem('▶ 메일 자동화 전체 실행 (Phase 1 → 2 → 보고)', 'startAutomation')
    .addItem('🧪 테스트 실행 (기록·초안 생성 없이 로그만)', 'startDryRun')
    .addItem('📋 진행 상태 / 마지막 결과 보기', 'showStatus')
    .addItem('⏹ 진행 중인 작업 중단·초기화', 'resetAutomation')
    .addToUi();
}

/** 이 스크립트가 붙어 있는 스프레드시트의 컨택 탭 */
function contactSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('컨택 시트에 붙은 스크립트가 아닙니다. 컨택 시트 → 확장 프로그램 → Apps Script에 설치하세요.');
  return (CONFIG.SHEET_NAME && ss.getSheetByName(CONFIG.SHEET_NAME)) || ss.getSheets()[0];
}

/** 처음 10행 안에서 '팀원명' 칸이 있는 행 번호(1부터). 없으면 0 */
function findHeaderRow_(sh) {
  const n = Math.min(10, sh.getLastRow());
  if (n < 1) return 0;
  const values = sh.getRange(1, 1, n, Math.max(1, sh.getLastColumn())).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i].some(v => String(v).replace(/\s+/g, '').startsWith('팀원명'))) return i + 1;
  }
  return 0;
}

function extractFileId_(text) {
  const s = String(text || '').trim();
  const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/) || s.match(/^([\w-]{20,})$/);
  return m ? m[1] : '';
}

// ============================== 초기 설정 ==============================
function initialSetup() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const sh = contactSheet_();
  const done = [];

  // 1) 머리글
  if (!findHeaderRow_(sh)) {
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, CONTACT_HEADERS.length).setValues([CONTACT_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
      done.push(`'${sh.getName()}' 탭 1행에 머리글 16열을 만들었습니다.`);
    } else {
      ui.alert(`'${sh.getName()}' 탭에 내용이 있는데 머리글('팀원명'이 있는 행)을 찾지 못했습니다.\n` +
        `처음 10행 안에 아래 머리글을 순서대로 넣은 뒤 다시 실행하세요.\n\n${CONTACT_HEADERS.join(' | ')}`);
      return;
    }
  }

  // 2) 추가분 폴더
  if (!propOpt_('FOLDER_ID')) {
    const parents = DriveApp.getFileById(sh.getParent().getId()).getParents();
    const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    const folder = getOrCreateFolder_(parent, IMPORT_FOLDER_NAME);
    getOrCreateFolder_(folder, CONFIG.IMPORT.DONE_FOLDER_NAME);
    props.setProperty('FOLDER_ID', folder.getId());
    done.push(`추가분 폴더를 만들었습니다: ${parent.getName()} / ${IMPORT_FOLDER_NAME}`);
  }

  // 3) 연락처·파일
  for (const f of PROP_FIELDS) {
    const cur = propOpt_(f.key);
    const res = ui.prompt('초기 설정',
      `${f.label}${cur ? `\n\n현재 값: ${cur}\n(바꾸지 않으려면 비워 두고 확인)` : ''}`,
      ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) {
      done.push('입력을 중간에 멈췄습니다. 남은 항목은 [⚙ 초기 설정]을 다시 실행해 입력하세요.');
      break;
    }
    let v = res.getResponseText().trim();
    if (!v) continue;
    if (f.fileId) {
      const id = extractFileId_(v);
      if (!id) { ui.alert('Drive 링크에서 파일 ID를 찾지 못했습니다. 이 항목은 건너뜁니다.'); continue; }
      v = id;
    }
    props.setProperty(f.key, v);
  }

  ui.alert((done.length ? done.join('\n') + '\n\n' : '') + setupReport_());
}

// ============================== 설정 점검 ==============================
function checkSetup() {
  SpreadsheetApp.getUi().alert(setupReport_());
}

function setupReport_() {
  const ok = (cond, text, fix) => (cond ? '✅ ' + text : '❌ ' + text + (fix ? `\n    → ${fix}` : ''));
  const lines = [];
  const sh = contactSheet_();
  lines.push(ok(findHeaderRow_(sh) > 0, `컨택 탭 머리글 ('${sh.getName()}')`, '[⚙ 초기 설정] 실행'));

  let folderOk = false;
  try { DriveApp.getFolderById(propOpt_('FOLDER_ID')).getName(); folderOk = true; } catch (e) { /* 없음 */ }
  lines.push(ok(folderOk, '추가분 폴더', '[⚙ 초기 설정] 실행'));

  PROP_FIELDS.filter(f => f.required).forEach(f =>
    lines.push(ok(!!propOpt_(f.key), f.label.replace(/\s*\(.*\)$/, ''), '[⚙ 초기 설정]에서 입력')));
  lines.push((propOpt_('CC_EMAIL') ? '✅ ' : '➖ ') + '참조(CC) 이메일' + (propOpt_('CC_EMAIL') ? '' : ' (없음 — 선택 사항)'));

  if (CONFIG.ATTACH_PROPOSAL) {
    let fileOk = false;
    try { DriveApp.getFileById(propOpt_('PROPOSAL_FILE_ID')).getName(); fileOk = true; } catch (e) { /* 없음 */ }
    lines.push(ok(fileOk, '제안서 PDF', '[⚙ 초기 설정]에서 Drive 링크 입력 (첨부하지 않으려면 Config.gs의 ATTACH_PROPOSAL을 false로)'));
  }

  let tplOk = true, tplErr = '';
  try { templateVarsCheck_(); } catch (e) { tplOk = false; tplErr = String(e.message || e); }
  lines.push(ok(tplOk, '메일 템플릿 형식', tplErr));
  lines.push(ok(CONFIG.TEMPLATE_REVIEWED, '메일 문구 확인 (TEMPLATE_REVIEWED)',
    'Config.gs의 팀명·공모전 소개·본문을 고친 뒤 TEMPLATE_REVIEWED를 true로'));

  const auto = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'importNewRows');
  lines.push((auto ? '✅ ' : '➖ ') + '추가분 자동 반영 ' + (auto ? '켜짐 (매시간)' : '꺼짐'));

  const ready = !lines.some(l => l.startsWith('❌'));
  return (ready ? '설정이 끝났습니다. 메일 자동화를 실행할 수 있습니다.\n\n' : '아래 ❌ 항목을 먼저 해결하세요.\n\n') + lines.join('\n');
}

/** 템플릿에 쓰인 {이름}이 허용 목록 안에 있는지 */
function templateVarsCheck_() {
  const allowed = {
    COOP_BODY: ['기업명', '호칭', '팀명', '공모전', '팀원', '팀원연락처', '제안주제', '첨부파일명', '회신기한',
      '팀장이름', '팀장연락처', '팀장이메일', '팀장직함'],
    THANKS_BODY: ['기업명', '호칭', '팀명', '공모전', '팀장이름', '팀장연락처', '팀장이메일', '팀장직함'],
  };
  Object.keys(allowed).forEach(k => {
    const used = (CONFIG[k].join('\n').match(/\{([^{}]+)\}/g) || []).map(x => x.slice(1, -1));
    const bad = used.filter(u => allowed[k].indexOf(u) < 0);
    if (bad.length) throw new Error(`${k}에 쓸 수 없는 이름: {${bad.join('}, {')}}`);
  });
}

/** 실제 실행(초안 생성) 전에 막아야 할 문제 목록 */
function preflight_() {
  const problems = [];
  if (!CONFIG.TEMPLATE_REVIEWED) problems.push('Config.gs의 메일 문구를 우리 팀에 맞게 고친 뒤 TEMPLATE_REVIEWED를 true로 바꾸세요.');
  PROP_FIELDS.filter(f => f.required && !propOpt_(f.key)).forEach(f => problems.push(`${f.label} — [⚙ 초기 설정]에서 입력`));
  if (CONFIG.ATTACH_PROPOSAL) {
    try { DriveApp.getFileById(propOpt_('PROPOSAL_FILE_ID')).getName(); }
    catch (e) { problems.push('제안서 PDF를 열 수 없습니다 — [⚙ 초기 설정]에서 Drive 링크 입력'); }
  }
  try { templateVarsCheck_(); } catch (e) { problems.push(String(e.message || e)); }
  if (!findHeaderRow_(contactSheet_())) problems.push('컨택 탭 머리글이 없습니다 — [⚙ 초기 설정] 실행');
  return problems;
}
