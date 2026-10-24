/**
 * 추가분 자동 반영
 *
 *  - 추가분 폴더(초기 설정에서 만든 Drive 폴더)에서 이름이 CONFIG.IMPORT.FILE_PREFIX로 시작하는 Google 시트를 찾아
 *  - 첫 번째 탭의 행을 컨택 시트 맨 아래에 붙이고
 *  - 번호(A열)는 컨택 시트의 마지막 번호 다음부터 다시 매기며
 *  - 이미 있는 기업명은 건너뛰고
 *  - 반영이 끝난 파일은 '반영완료' 하위 폴더로 옮깁니다.
 *
 *  발굴 파이프라인의 .xlsx는 Google 시트로 변환된 상태여야 읽힙니다.
 *  (Drive에 올린 뒤 '연결 앱 → Google 스프레드시트'로 열면 변환본이 같은 폴더에 생깁니다)
 *
 *  메뉴: [🤖 컨택 자동화 → 📥 추가분 지금 반영] / [⏰ 추가분 자동 반영 켜기(매시간)]
 */

function importNewRows() {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = contactSheet_();
    const N = CONFIG.IMPORT.NUM_COLS;

    // 기존 기업명·마지막 번호 읽기 (A열 번호, D열 기업명)
    const headerRow = findHeaderRow_(sh);
    if (!headerRow) throw new Error("컨택 시트에서 머리글('팀원명'이 있는 행)을 찾지 못했습니다. 초기 설정을 먼저 실행하세요.");
    const lastRow = sh.getLastRow();
    const existingVals = lastRow > headerRow
      ? sh.getRange(headerRow + 1, 1, lastRow - headerRow, 4).getValues()
      : [];
    const existing = new Set(existingVals.map(r => normName_(r[3])).filter(Boolean));
    let lastNo = existingVals.reduce((m, r) => Math.max(m, Number(r[0]) || 0), 0);

    // 추가분 파일 찾기 (이름순)
    const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
    const doneFolder = getOrCreateFolder_(folder, CONFIG.IMPORT.DONE_FOLDER_NAME);
    const files = [];
    const it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (it.hasNext()) {
      const f = it.next();
      if (f.getName().indexOf(CONFIG.IMPORT.FILE_PREFIX) === 0) files.push(f);
    }
    files.sort((a, b) => a.getName().localeCompare(b.getName()));
    if (files.length === 0) {
      const xlsx = folder.getFilesByType(MimeType.MICROSOFT_EXCEL);
      Logger.log(xlsx.hasNext()
        ? '새 추가분 Google 시트 없음 (.xlsx 파일은 있음 — Google 시트로 변환해야 반영됩니다)'
        : '새 추가분 파일 없음');
      return { added: 0, skipped: 0, files: 0 };
    }

    let added = 0, skipped = 0;
    files.forEach(f => {
      const rows = SpreadsheetApp.openById(f.getId()).getSheets()[0].getDataRange().getValues();
      const out = [];
      rows.forEach(r => {
        if (String(r[0]).trim() === '번호') return;          // 헤더 건너뜀
        const name = String(r[3] || '').trim();
        if (!name) return;
        const key = normName_(name);
        if (existing.has(key)) { skipped++; return; }        // 중복 건너뜀
        existing.add(key);
        const row = r.slice(0, N);
        while (row.length < N) row.push('');
        row[0] = ++lastNo;                                    // 번호 재부여
        out.push(row);
      });
      if (out.length) {
        sh.getRange(sh.getLastRow() + 1, 1, out.length, N).setValues(out);
        added += out.length;
      }
      f.moveTo(doneFolder);                                   // 반영 완료 표시
    });
    Logger.log('추가 ' + added + '행, 중복 건너뜀 ' + skipped + '행, 파일 ' + files.length + '개 처리');
    return { added, skipped, files: files.length };
  } finally {
    lock.releaseLock();
  }
}

/** 메뉴에서 실행: 결과를 알림창으로 */
function importNewRowsNow() {
  const r = importNewRows();
  notify_(`추가분 반영: ${r.added}행 추가, 중복 ${r.skipped}행 건너뜀, 파일 ${r.files}개 처리`);
}

/** 매시간 자동 반영 켜기 */
function enableAutoImport() {
  disableAutoImport_();
  ScriptApp.newTrigger('importNewRows').timeBased().everyHours(1).create();
  notify_('추가분 자동 반영을 켰습니다. 매시간 폴더를 확인합니다.');
}

function disableAutoImport() {
  disableAutoImport_();
  notify_('추가분 자동 반영을 껐습니다.');
}

function disableAutoImport_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'importNewRows')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** 기업명 비교용 정규화: 법인 표기·공백·구두점 제거 */
function normName_(s) {
  return String(s).replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(쥬\)|\s|\.|,/g, '').toLowerCase();
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
