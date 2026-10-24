/**
 * 컨택 메일 자동화
 *  Phase 1: Gmail 발송/회신 내역 → 시트 반영 + 거절 기업 감사 답장 초안
 *  Phase 2: 초안 미작성 행 전수 → 협력 요청 초안 (BATCH_SIZE건 단위 반복)
 *  Phase 3: 최종 보고 ('자동화_실행로그' 탭 + 알림창)
 *
 *  ※ 메일은 절대 발송하지 않습니다. 모두 Gmail 임시보관함(초안)에만 저장합니다.
 *  ※ Apps Script는 1회 실행이 6분으로 제한됩니다. 4분 30초가 지나면 진행 위치를 저장하고
 *    1분 뒤 자동으로 이어서 실행합니다. 잔여 대상이 0이 될 때까지 멈추지 않습니다.
 *  ※ 문구·날짜 등 팀별 값은 Config.gs, 연락처·파일 ID는 초기 설정(스크립트 속성)에 있습니다.
 */

const ST = {
  REJECT: '거절', ACCEPT: '수락', DELAY: '지연', AUTO: '지연(부재중)',
  BOUNCE: '반송', BOUNCE_PART: '반송(일부)', CHECK: '회신(확인필요)',
};
const AUTO_VALUES = new Set(Object.keys(ST).map(k => ST[k]).concat(['O', 'X', 'o', 'x', '○', '×']));
const STATE_KEY = 'CONTACT_AUTOMATION_STATE';
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'naver.com', 'hanmail.net', 'daum.net', 'nate.com', 'hotmail.com',
  'outlook.com', 'outlook.kr', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.kr', 'kakao.com',
  'icloud.com', 'me.com', 'korea.com', 'empal.com', 'paran.com', 'dreamwiz.com', 'hanafos.com',
  'chol.com', 'lycos.co.kr', 'hitel.net', 'unitel.co.kr', 'freechal.com', 'netian.com', 'hanmir.com',
]);

// ============================== 진입점 (메뉴는 Setup.gs) ==============================
function startAutomation() { startRun_(false); }
function startDryRun() { startRun_(true); }
function resumeAutomation() { runEngine_(); }   // 시간 트리거가 호출

function resetAutomation() {
  deleteResumeTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
  notify_('진행 상태를 초기화했습니다. 다음 실행은 처음부터 시작합니다.');
}

function showStatus() {
  const st = loadState_();
  if (st && st.phase !== 'DONE') {
    notify_(`진행 중: ${st.phase} (${st.dryRun ? '테스트' : '실제'} 실행, ${st.executions}회차)\n` +
      `Phase1 대조 ${st.c.p1Rows}행 / Phase2 초안 ${st.c.p2Created}건\n자세한 내용은 '${CONFIG.LOG_SHEET_NAME}' 탭 참고`);
    return;
  }
  notify_(PropertiesService.getScriptProperties().getProperty('LAST_REPORT') || '아직 완료된 실행이 없습니다.');
}

function startRun_(dryRun) {
  if (!dryRun) {
    const problems = preflight_();
    if (problems.length) {
      notify_('실제 실행 전에 아래를 먼저 해결하세요.\n\n- ' + problems.join('\n- ') +
        '\n\n문구 확인 없이 결과만 보려면 [🧪 테스트 실행]을 쓰세요.');
      return;
    }
  }
  const cur = loadState_();
  if (cur && cur.phase !== 'DONE') {
    notify_('이전 실행이 아직 끝나지 않아 이어서 진행합니다. 처음부터 하려면 [진행 중인 작업 중단·초기화] 후 다시 실행하세요.');
  } else {
    saveState_(newState_(dryRun));
  }
  runEngine_();
}

function newState_(dryRun) {
  return {
    dryRun: !!dryRun, phase: 'P1', p1NextRow: 0, executions: 0, resumes: 0, errors: 0,
    startedAt: new Date().toISOString(),
    c: {
      p1Rows: 0, p1Batches: 0, p1SentRows: 0, p1DateFilled: 0, p1FlagFilled: 0,
      p1ReplyUpdated: 0, p1ReplyByStatus: {}, p1ReplyKeptManual: 0, p1Thanks: 0, p1ThanksSkipped: 0,
      p2Batches: 0, p2Created: 0, p2Existing: 0, p2Errors: 0, p2NoPhone: 0, p2Unparsed: 0,
    },
  };
}

// ============================== 실행 엔진 ==============================
function runEngine_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) { console.log('다른 실행이 진행 중이어서 종료합니다.'); return; }
  const ctx = { t0: Date.now(), logs: [] };
  let st = loadState_();
  try {
    deleteResumeTriggers_();
    if (!st || st.phase === 'DONE') { console.log('진행할 작업이 없습니다.'); return; }
    st.executions++;
    initContext_(ctx, st);

    if (st.phase === 'P1') {
      if (!runPhase1_(ctx, st)) return pause_(ctx, st);
      st.phase = 'P2';
      saveState_(st);
    }
    if (st.phase === 'P2') {
      if (!runPhase2_(ctx, st)) return pause_(ctx, st);
      st.phase = 'DONE';
    }
    finalize_(ctx, st);
  } catch (err) {
    st.errors = (st.errors || 0) + 1;
    log_(ctx, st.phase, '', '', '', '오류', (err && err.stack) || String(err));
    saveState_(st);
    if (st.errors <= 3) {
      scheduleResume_();
      log_(ctx, st.phase, '', '', '', '재시도 예약', `1분 뒤 이어서 재시도 (${st.errors}/3)`);
    } else {
      log_(ctx, st.phase, '', '', '', '중단', '연속 오류 3회 — 로그 확인 후 [전체 실행]을 다시 누르면 이어서 진행');
    }
  } finally {
    flushLogs_(ctx);
    lock.releaseLock();
  }
}

function pause_(ctx, st) {
  st.resumes++;
  saveState_(st);
  if (st.resumes > CONFIG.MAX_RESUMES) {
    log_(ctx, st.phase, '', '', '', '중단', '자동 이어하기 최대 횟수 초과');
    return;
  }
  scheduleResume_();
  log_(ctx, st.phase, '', '', '', '일시정지', `실행 시간 한도 도달 → 1분 뒤 자동 이어하기 (${st.resumes}회차)`);
}

function initContext_(ctx, st) {
  ctx.dry = st.dryRun;
  ctx.sheet = contactSheet_();
  ctx.ss = ctx.sheet.getParent();
  ctx.me = new Set([Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases())
    .map(s => String(s || '').toLowerCase()).filter(Boolean));
  ctx.drafts = buildDraftIndex_();
  ctx.holidays = loadHolidays_();
  ctx.deadlineText = formatDeadline_(addBusinessDays_(new Date(), CONFIG.REPLY_BUSINESS_DAYS, ctx.holidays));
}

const timeUp_ = ctx => Date.now() - ctx.t0 > CONFIG.MAX_EXEC_MS;

// ============================== 시트 읽기 ==============================
function readSheet_(ctx) {
  const sh = ctx.sheet;
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  let h = -1;
  for (let i = 0; i < Math.min(10, values.length); i++) {
    if (values[i].some(v => norm_(v).startsWith('팀원명'))) { h = i; break; }
  }
  if (h < 0) throw new Error("헤더 행('팀원명')을 찾지 못했습니다.");
  const col = mapColumns_(values[h]);
  const get = (v, i) => (i >= 0 ? String(v[i] || '').trim() : '');
  const rows = [];
  for (let i = h + 1; i < values.length; i++) {
    const v = values[i];
    const contactRaw = col.email >= 0 ? get(v, col.email) : get(v, col.contact);
    rows.push({
      rowNum: i + 1,
      team: get(v, col.team), phone: get(v, col.phone), company: get(v, col.company),
      reply: get(v, col.reply), date: get(v, col.date), topic: get(v, col.topic),
      manager: get(v, col.manager), flag: get(v, col.flag),
      contactRaw, emails: extractEmails_(contactRaw),
    });
  }
  return { headerRow: h + 1, col, rows };
}

function mapColumns_(header) {
  const H = header.map(norm_);
  const find = (pred, required, label) => {
    const i = H.findIndex(pred);
    if (i < 0 && required) throw new Error(`'${label}' 열을 찾지 못했습니다.`);
    return i;
  };
  const col = {
    team: find(h => h.startsWith('팀원명'), true, '팀원명'),
    phone: find(h => h.startsWith('팀원연락처'), true, '팀원연락처'),
    company: find(h => h.startsWith('기업명'), true, '기업명'),
    reply: find(h => (h.includes('메일답장') || h.includes('메일답변')) && !h.includes('전화'), true, '메일답장여부'),
    contact: find(h => h.includes('담당자연락처'), false),
    email: find(h => h.includes('담당자') && h.includes('이메일') && !h.includes('연락처'), false),
    date: find(h => h.includes('컨택일자'), true, '컨택일자'),
    topic: find(h => h.includes('제안주제'), false),
    manager: find(h => h.includes('담당자명'), false),
    flag: find(h => h.includes('초안작성'), true, '초안작성여부'),
  };
  if (col.contact < 0 && col.email < 0) throw new Error('담당자 이메일이 들어 있는 열을 찾지 못했습니다.');
  // 안전장치: 쓰기 대상 3개 열이 전화 관련 열이면 즉시 중단
  ['reply', 'date', 'flag'].forEach(k => {
    if (H[col[k]].includes('전화')) throw new Error('쓰기 대상 열이 전화 관련 열과 겹칩니다: ' + header[col[k]]);
  });
  return col;
}

// ============================== Phase 1 ==============================
function runPhase1_(ctx, st) {
  const data = readSheet_(ctx);
  ctx.data = data;
  if (!st.p1NextRow) st.p1NextRow = data.headerRow + 1;

  while (true) {
    let i = data.rows.findIndex(r => r.rowNum >= st.p1NextRow);
    if (i < 0) break;
    const batch = [];
    let lastRowNum = st.p1NextRow;
    for (; i < data.rows.length && batch.length < CONFIG.BATCH_SIZE; i++) {
      lastRowNum = data.rows[i].rowNum;
      if (data.rows[i].emails.length) batch.push(data.rows[i]);
    }
    if (!batch.length) { st.p1NextRow = lastRowNum + 1; break; }
    if (timeUp_(ctx)) return false;

    processPhase1Batch_(ctx, st, batch);
    st.p1NextRow = lastRowNum + 1;
    st.c.p1Batches++;
    st.c.p1Rows += batch.length;
    st.errors = 0;
    saveState_(st);
  }
  log_(ctx, 'P1', '', '', '', 'Phase1 완료', `이메일 등록 ${st.c.p1Rows}행 대조 (${st.c.p1Batches}개 묶음)`);
  return true;
}

function processPhase1Batch_(ctx, st, batch) {
  const emailToRows = new Map();
  const domainToEmails = new Map();
  batch.forEach(r => r.emails.forEach(e => {
    if (!emailToRows.has(e)) emailToRows.set(e, []);
    emailToRows.get(e).push(r);
    const d = domainOf_(e);
    if (d && !GENERIC_DOMAINS.has(d)) {
      if (!domainToEmails.has(d)) domainToEmails.set(d, new Set());
      domainToEmails.get(d).add(e);
    }
  }));

  // 1) 보낸편지함·받은편지함 통합 검색 (10개 주소씩 OR)
  const threads = new Map();
  chunk_([...emailToRows.keys()], 10).forEach(ch =>
    searchAll_(buildQuery_(ch)).forEach(t => threads.set(t.getId(), t)));

  // 2) 메시지 단위로 행에 귀속 (Gmail이 제목이 같은 메일을 한 스레드로 묶는 경우가 있어 스레드 단위 판정 금지)
  const ev = new Map();
  batch.forEach(r => ev.set(r.rowNum, { sent: [], replies: [], bounced: new Set(), seen: new Set() }));
  const sentToAll = new Map();  // 내가 보낸 메일의 모든 수신자 → 날짜들 (감사 메일 중복 방지용)
  const tl = [...threads.values()];
  for (let k = 0; k < tl.length; k += 50) {
    GmailApp.getMessagesForThreads(tl.slice(k, k + 50))
      .forEach(msgs => collectThread_(ctx, msgs, emailToRows, domainToEmails, ev, sentToAll));
  }

  // 3) 행별 판정 → 시트 반영
  const col = ctx.data.col;
  const wDate = [], wFlag = [], wReply = [], notes = [];
  batch.forEach(r => {
    const E = ev.get(r.rowNum);
    const d = decideRow_(r, E);

    if (d.firstSent) {
      const changed = [];
      if (!r.date) {
        const v = fmtDate_(d.firstSent, 'yyyy.MM.dd');
        wDate.push({ row: r.rowNum, value: v }); r.date = v; st.c.p1DateFilled++; changed.push('컨택일자 ' + v);
      }
      if (!r.flag) {
        wFlag.push({ row: r.rowNum, value: 'O' }); r.flag = 'O'; st.c.p1FlagFilled++; changed.push('초안작성여부 O');
      }
      if (changed.length) { st.c.p1SentRows++; log_(ctx, 'P1', r.rowNum, r.company, r.emails, '발송 내역 반영', changed.join(', ')); }
    }

    if (d.status && r.reply !== d.status) {
      if (canOverwriteReply_(r.reply)) {
        wReply.push({ row: r.rowNum, value: d.status });
        notes.push({ row: r.rowNum, note: d.note });
        log_(ctx, 'P1', r.rowNum, r.company, r.emails, '회신 상태 → ' + d.status, d.note);
        r.reply = d.status;
        st.c.p1ReplyUpdated++;
        st.c.p1ReplyByStatus[d.status] = (st.c.p1ReplyByStatus[d.status] || 0) + 1;
      } else {
        st.c.p1ReplyKeptManual++;
        log_(ctx, 'P1', r.rowNum, r.company, r.emails, '수기 기재 유지', `기존 "${r.reply}" / 자동판정 ${d.status}`);
      }
    }

    if (d.status === ST.REJECT && d.reply) maybeCreateThanks_(ctx, st, r, E, d.reply, sentToAll);
  });

  writeCells_(ctx, col.date, wDate);
  writeCells_(ctx, col.flag, wFlag);
  writeCells_(ctx, col.reply, wReply);
  if (!ctx.dry) {
    notes.forEach(n => ctx.sheet.getRange(n.row, col.reply + 1).setNote(n.note));
    SpreadsheetApp.flush();
  }
}

function buildQuery_(emails) {
  const keys = new Set();
  emails.forEach(e => {
    const d = domainOf_(e);
    keys.add(d && !GENERIC_DOMAINS.has(d) ? d : e);   // 회사 도메인은 도메인 전체로 검색 (다른 직원 회신 포착)
  });
  const terms = [];
  keys.forEach(k => terms.push('from:' + k, 'to:' + k));
  return `after:${CONFIG.SEARCH_AFTER} {${terms.join(' ')}}`;
}

function collectThread_(ctx, msgs, emailToRows, domainToEmails, ev, sentToAll) {
  const metas = [];
  msgs.forEach(m => {
    if (m.isDraft()) return;
    const from = m.getFrom();
    const fromEmail = extractEmails_(from)[0] || '';
    metas.push({ m, id: m.getId(), from, fromEmail, mine: ctx.me.has(fromEmail), date: m.getDate(), subject: m.getSubject() || '' });
  });
  const threadHasMine = metas.some(x => x.mine);

  let idMap = null;
  const sentIdMap = () => {
    if (idMap) return idMap;
    idMap = new Map();
    metas.forEach(x => {
      if (!x.mine) return;
      const mid = normMid_(x.m.getHeader('Message-ID') || x.m.getHeader('Message-Id'));
      if (mid) idMap.set(mid, x.rcpts || extractEmails_(x.m.getTo() + ',' + x.m.getCc()));
    });
    return idMap;
  };
  const rowsOf = emails => {
    const out = new Map();
    emails.forEach(e => (emailToRows.get(e) || []).forEach(r => out.set(r.rowNum, r)));
    return [...out.values()];
  };

  metas.forEach(x => {
    // (a) 내가 보낸 메일 → 발송 내역
    if (x.mine) {
      x.rcpts = extractEmails_(x.m.getTo() + ',' + x.m.getCc());
      x.rcpts.forEach(e => { if (!sentToAll.has(e)) sentToAll.set(e, []); sentToAll.get(e).push(x.date); });
      rowsOf(x.rcpts.filter(e => emailToRows.has(e))).forEach(r => {
        const E = ev.get(r.rowNum);
        if (!E.seen.has(x.id)) { E.seen.add(x.id); E.sent.push({ date: x.date }); }
      });
      return;
    }
    const fe = x.fromEmail;

    // (b) 반송 메일
    if (isBounce_(fe, x.subject)) {
      if (/\(delay\)|delayed|지연/i.test(x.subject)) return;
      let failed = extractEmails_(cutBounceBody_(x.m.getPlainBody())).filter(e => emailToRows.has(e));
      if (!failed.length) failed = refTargets_(x.m, sentIdMap(), emailToRows);
      if (!failed.length) {
        const d = domainOf_(fe);
        if (domainToEmails.has(d)) failed = [...domainToEmails.get(d)];
      }
      failed.forEach(e => (emailToRows.get(e) || []).forEach(r => ev.get(r.rowNum).bounced.add(e)));
      return;
    }

    // (c) 기업 회신 → 어느 기업의 회신인지 판정 (정확한 주소 > 원본 메일 참조 > 같은 회사 도메인)
    let targets = emailToRows.has(fe) ? [fe] : [];
    if (!targets.length) targets = refTargets_(x.m, sentIdMap(), emailToRows);
    if (!targets.length) {
      const d = domainOf_(fe);
      if (d && !GENERIC_DOMAINS.has(d) && domainToEmails.has(d)) targets = [...domainToEmails.get(d)];
    }
    if (!targets.length) return;
    if (!threadHasMine && !relevantRe_().test(x.subject)) return;

    const clean = cleanReply_(x.m.getPlainBody());
    const rec = {
      id: x.id, date: x.date, fromEmail: fe, fromName: displayName_(x.from),
      status: isAutoReply_(x.subject, clean) ? ST.AUTO : classifyReply_(clean),
      snippet: clean.replace(/\s+/g, ' ').slice(0, 200),
    };
    rowsOf(targets).forEach(r => {
      const E = ev.get(r.rowNum);
      if (!E.seen.has(x.id)) { E.seen.add(x.id); E.replies.push(rec); }
    });
  });
}

function refTargets_(m, idMap, emailToRows) {
  if (!idMap.size) return [];
  const refs = ((m.getHeader('References') || '') + ' ' + (m.getHeader('In-Reply-To') || '')).match(/<[^>]+>/g) || [];
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = idMap.get(refs[i].toLowerCase());
    if (r) {
      const hit = r.filter(e => emailToRows.has(e));
      if (hit.length) return hit;
    }
  }
  return [];
}

function decideRow_(r, E) {
  const out = {};
  if (E.sent.length) out.firstSent = new Date(Math.min.apply(null, E.sent.map(s => s.date.getTime())));
  const byDate = (a, b) => a.date - b.date;
  const human = E.replies.filter(x => x.status !== ST.AUTO).sort(byDate);
  const autos = E.replies.filter(x => x.status === ST.AUTO).sort(byDate);
  const noteOf = x => `[자동판정 ${fmtDate_(x.date, 'MM/dd HH:mm')}] ${x.status}\n보낸 사람: ${x.fromEmail}\n${x.snippet}`;

  if (human.length) {
    const decisive = human.filter(x => x.status === ST.REJECT || x.status === ST.ACCEPT);
    out.reply = decisive.length ? decisive[decisive.length - 1] : human[human.length - 1];
    out.status = out.reply.status;
    out.note = noteOf(out.reply);
  } else if (E.bounced.size) {
    out.status = r.emails.every(e => E.bounced.has(e)) ? ST.BOUNCE : ST.BOUNCE_PART;
    out.note = `[자동판정] ${out.status}\n반송 주소: ${[...E.bounced].join(', ')}`;
  } else if (autos.length) {
    out.reply = autos[autos.length - 1];
    out.status = ST.AUTO;
    out.note = noteOf(out.reply);
  }
  return out;
}

function maybeCreateThanks_(ctx, st, r, E, rj, sentToAll) {
  const to = rj.fromEmail;
  const after = t => t.getTime() > rj.date.getTime();
  const repliedAlready = E.sent.some(s => after(s.date)) || (sentToAll.get(to) || []).some(after);
  if (repliedAlready) {
    st.c.p1ThanksSkipped++;
    log_(ctx, 'P1', r.rowNum, r.company, to, '감사 초안 건너뜀', '거절 회신 이후 이미 답장을 보냄');
    return;
  }
  if (ctx.drafts.thanks.has(to)) {
    st.c.p1ThanksSkipped++;
    log_(ctx, 'P1', r.rowNum, r.company, to, '감사 초안 건너뜀', '임시보관함에 감사 초안이 이미 있음');
    return;
  }
  if (!ctx.dry) GmailApp.createDraft(to, CONFIG.THANKS_SUBJECT, buildThanksBody_(r, rj), ccOpts_());
  ctx.drafts.thanks.add(to);
  st.c.p1Thanks++;
  log_(ctx, 'P1', r.rowNum, r.company, to, ctx.dry ? '[테스트] 감사 초안 대상' : '감사 초안 생성', `호칭: ${honorific_(r.manager, rj.fromName)}님`);
}

// ============================== Phase 2 ==============================
function runPhase2_(ctx, st) {
  loadAttachment_(ctx);
  const isTarget = r => !r.flag && r.team && r.emails.length && r.company;

  if (ctx.dry) {   // 테스트: 시트를 바꾸지 않으므로 한 번만 훑고 끝냄
    const data = readSheet_(ctx); ctx.data = data;
    data.rows.filter(isTarget).forEach(r => {
      st.c.p2Created++;
      if (!r.phone) st.c.p2NoPhone++;
      log_(ctx, 'P2', r.rowNum, r.company, r.emails, '[테스트] 협력 요청 초안 대상', `작성자 ${r.team} / 호칭 ${honorific_(r.manager, '')}님`);
    });
    reportUnparsed_(ctx, st, data);
    return true;
  }

  while (true) {
    const data = readSheet_(ctx); ctx.data = data;         // 매 묶음마다 조건 재확인
    const targets = data.rows.filter(isTarget);
    if (!targets.length) break;
    const batch = targets.slice(0, CONFIG.BATCH_SIZE);
    const done = [], errs = [];

    for (const r of batch) {
      if (timeUp_(ctx)) { commitPhase2_(ctx, done, errs); saveState_(st); return false; }
      if (r.emails.some(e => ctx.drafts.coop.has(e))) {
        done.push({ row: r.rowNum, value: 'O' });
        st.c.p2Existing++;
        log_(ctx, 'P2', r.rowNum, r.company, r.emails, '기존 초안 확인', '임시보관함에 이미 있어 O만 기록');
        continue;
      }
      try {
        const opts = ccOpts_();
        if (ctx.attachment) opts.attachments = [ctx.attachment];
        GmailApp.createDraft(r.emails.join(','), CONFIG.COOP_SUBJECT, buildCoopBody_(ctx, r), opts);
        r.emails.forEach(e => ctx.drafts.coop.add(e));
        done.push({ row: r.rowNum, value: 'O' });
        st.c.p2Created++;
        if (!r.phone) st.c.p2NoPhone++;
        log_(ctx, 'P2', r.rowNum, r.company, r.emails, '협력 요청 초안 생성', `작성자 ${r.team}`);
      } catch (err) {
        errs.push({ row: r.rowNum, note: String(err) });
        st.c.p2Errors++;
        log_(ctx, 'P2', r.rowNum, r.company, r.emails, '초안 생성 오류', String(err));
      }
    }
    commitPhase2_(ctx, done, errs);
    st.c.p2Batches++;
    st.errors = 0;
    saveState_(st);
  }
  reportUnparsed_(ctx, st, ctx.data);
  log_(ctx, 'P2', '', '', '', 'Phase2 완료', '조건에 맞는 잔여 행 0개');
  return true;
}

/** 팀원명은 있는데 연락처 칸에서 이메일을 인식하지 못한 행 → 누락되지 않도록 로그로 알림 */
function reportUnparsed_(ctx, st, data) {
  data.rows.filter(r => !r.flag && r.team && r.company && r.contactRaw && !r.emails.length).forEach(r => {
    st.c.p2Unparsed++;
    log_(ctx, 'P2', r.rowNum, r.company, '', '이메일 인식 불가', `연락처 칸: ${r.contactRaw}`);
  });
}

function commitPhase2_(ctx, done, errs) {
  const col = ctx.data.col;
  writeCells_(ctx, col.flag, done);
  // 오류 행은 '오류'로 표시해 무한 반복을 막고, 사유는 메모로 남김
  writeCells_(ctx, col.flag, errs.map(e => ({ row: e.row, value: '오류' })));
  errs.forEach(e => ctx.sheet.getRange(e.row, col.flag + 1).setNote(e.note));
  SpreadsheetApp.flush();
}

function loadAttachment_(ctx) {
  ctx.attachment = null;
  ctx.attachmentLabel = '';
  if (!CONFIG.ATTACH_PROPOSAL) return;
  const f = DriveApp.getFileById(CONFIG.PROPOSAL_FILE_ID);
  ctx.attachment = f.getBlob();
  ctx.attachmentLabel = f.getName();
}

// ============================== 메일 본문 ==============================
function buildCoopBody_(ctx, r) {
  const L = CONFIG.LEADER;
  return render_(CONFIG.COOP_BODY, {
    기업명: r.company, 호칭: honorific_(r.manager, ''), 팀명: CONFIG.TEAM_NAME, 공모전: CONFIG.CONTEST_NAME,
    팀원: r.team, 팀원연락처: r.phone, 제안주제: CONFIG.INCLUDE_TOPIC_LINE ? r.topic : '',
    첨부파일명: ctx.attachmentLabel, 회신기한: ctx.deadlineText,
    팀장이름: L.name, 팀장연락처: L.phone, 팀장이메일: L.email, 팀장직함: L.title,
  });
}

function buildThanksBody_(r, rj) {
  const L = CONFIG.LEADER;
  return render_(CONFIG.THANKS_BODY, {
    기업명: r.company, 호칭: honorific_(r.manager, rj.fromName), 팀명: CONFIG.TEAM_NAME, 공모전: CONFIG.CONTEST_NAME,
    팀장이름: L.name, 팀장연락처: L.phone, 팀장이메일: L.email, 팀장직함: L.title,
  });
}

/**
 * 템플릿 줄 목록을 본문으로 만든다. {이름}은 vars 값으로 바꾸고,
 * 값이 비어 있는 {이름}이 들어 있는 줄은 통째로 뺀다. 모르는 이름이 있으면 오류.
 */
function render_(lines, vars) {
  const out = [];
  lines.forEach(line => {
    const keys = (String(line).match(/\{([^{}]+)\}/g) || []).map(k => k.slice(1, -1));
    const unknown = keys.filter(k => !(k in vars));
    if (unknown.length) throw new Error(`메일 템플릿에 모르는 이름이 있습니다: {${unknown.join('}, {')}} — Config.gs를 확인하세요.`);
    if (keys.some(k => vars[k] == null || String(vars[k]).trim() === '')) return;
    out.push(String(line).replace(/\{([^{}]+)\}/g, (_, k) => String(vars[k])));
  });
  return out.join('\n');
}

const RANK_RE = /^(?:대표이사|대표|사장|부사장|회장|전무|상무|이사|본부장|부장|차장|과장|대리|주임|사원|팀장|실장|소장|센터장|공장장|연구원|선임|책임|수석|매니저|담당자?)$/;

function parseManager_(v) {
  const first = String(v || '').split(/[,\n]/)[0].replace(/님/g, '').trim();
  const parts = first.split(/[\/\s()·]+/).filter(Boolean);
  if (!parts.length) return { name: '', rank: '' };
  if (/^[가-힣]{2,4}$/.test(parts[0]) && !RANK_RE.test(parts[0])) {
    return { name: parts[0], rank: parts.slice(1).filter(p => /^[가-힣]+$/.test(p)).join(' ') };
  }
  if (RANK_RE.test(parts[0])) return { name: '', rank: parts[0] };
  return { name: '', rank: '' };
}

/** 인사말 호칭: 회신자 한글 이름 > 시트 '담당자명/직급' > '담당자' */
function honorific_(managerCell, replyName) {
  const m = parseManager_(managerCell);
  const rn = String(replyName || '').replace(/\s+/g, '');
  if (/^[가-힣]{2,4}$/.test(rn) && !RANK_RE.test(rn)) return rn + ' ' + (rn === m.name && m.rank ? m.rank : '담당자');
  if (m.name) return m.name + ' ' + (m.rank || '담당자');
  if (m.rank) return m.rank;
  return '담당자';
}

// ============================== 회신 분류 ==============================
const HARD = '(?:어렵|어려[운울워웠])';
const RULES = {
  reject: [
    [/거절|사양(?:하|드리|합)|고사(?:하|드리)|불가(?!피)|곤란/, 2],
    [/적합하지\s*않|맞지\s*않|부합하지\s*않|참여하지\s*않|진행하지\s*않|해당\s*사항이?\s*없|여력이\s*없|계획이\s*없|관심이\s*없|필요성이\s*없/, 2],
    [new RegExp('(?:참여|협조|협력|진행|참가|수용|협업|응하기|함께하기|지원)[^.\\n]{0,15}' + HARD), 2],
    [/아쉽(?:지만|게도|습니다)|양해\s*(?:바랍|부탁)|긍정적인\s*(?:답변|회신)을?\s*드리지/, 1],
    [new RegExp(HARD), 1],
  ],
  accept: [
    [/참여\s*(?:하겠|할게|가능|의사|희망|하고\s*싶)|진행\s*(?:하겠|하시죠|해\s*보시죠|해\s*봅시다|하고\s*싶)|협력\s*하겠|함께\s*하겠|수락/, 2],
    [/미팅[^.\n]{0,20}(?:가능|편하|좋|하시죠|잡|진행|확정)|방문[^.\n]{0,15}(?:가능|하셔도|해\s*주|주시면|환영)|일정[^.\n]{0,10}(?:조율|확정|잡)|뵙겠|편할\s*것\s*같|편하실\s*것|참석이?\s*가능/, 2],
    [/긍정적으로|관심\s*있|환영/, 1],
  ],
  delay: [
    [/검토\s*(?:후|중|하여|해\s*보|하겠|해서|해\s*드리)|내부\s*(?:검토|논의|협의|보고|결재)|추후\s*(?:회신|연락|답변)|(?:회신|답변|연락)\s*(?:을|를)?\s*드리(?:겠|도록)|전달\s*(?:하겠|드리겠|했|하였|해\s*드리|드렸)|확인\s*후|시간이\s*(?:조금\s*)?필요/, 1],
  ],
};

function score_(text, rules) { return rules.reduce((s, rw) => s + (rw[0].test(text) ? rw[1] : 0), 0); }

function classifyReply_(text) {
  const t = String(text || '');
  const rj = score_(t, RULES.reject), ac = score_(t, RULES.accept), dl = score_(t, RULES.delay);
  if (rj >= 2 && rj > ac) return ST.REJECT;
  if (ac >= 2 && ac > rj) return ST.ACCEPT;
  if (dl >= 1) return ST.DELAY;
  return ST.CHECK;
}

function isAutoReply_(subject, body) {
  if (/^\s*(?:out of office|automatic reply|auto[- ]?reply|autoreply|자동\s*(?:회신|응답)|\[?부재\s*중\]?)/i.test(subject || '')) return true;
  const b = String(body || '');
  return b.length < 800 && /out of office|부재\s*중(?:입니다|이오니|으로)|자동\s*(?:회신|응답)(?:입니다|\s*메일)|휴가\s*중(?:입니다|이오니)/i.test(b.slice(0, 300));
}

function isBounce_(fromEmail, subject) {
  return /^(?:mailer-daemon|postmaster|mail-daemon|maildaemon)@/i.test(fromEmail || '') ||
    /delivery status notification|undeliver|mail delivery (?:failed|failure)|returned mail|delivery failure|failure notice|전송\s*실패|배달\s*실패|반송/i.test(subject || '');
}

function cutBounceBody_(body) {
  const s = String(body || '');
  const i = s.search(/-{2,}\s*(?:original message|원본\s*메(?:일|시지)|forwarded message)|original message headers|^received:\s*from/im);
  return i > 0 ? s.slice(0, i) : s;
}

const QUOTE_CUT = [
  /^-{2,}\s*(?:original message|원본\s*메(?:시지|일)|forwarded message|전달된\s*메(?:시지|일))/im,
  /^\s*(?:from|보낸\s*사람|sent)\s*:/im,
  /^\s*on\s.{3,200}wrote:\s*$/im,
  /님이\s*작성:/,
  /^\s*20\d{2}[.\-\/년]\s*\d{1,2}[.\-\/월]\s*\d{1,2}.{0,80}(?:작성|wrote)/im,
  /^_{8,}/m,
];
let templateNoise_ = null;
/** 회신에 인용된 우리 메일 문장을 걸러낼 정규식: COOP_BODY의 고정 문장 + EXTRA_TEMPLATE_NOISE */
function templateNoiseRe_() {
  if (templateNoise_) return templateNoise_;
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phrases = [];
  CONFIG.COOP_BODY.forEach(line => {
    // {이름} 사이의 고정 문구를 문장 부호로 나누고, 10자 이상인 조각의 앞 15자·뒤 15자를 사용
    // (회신 메일에서 인용문이 중간에 줄바꿈돼도 앞이나 뒤 조각은 남아 있도록)
    String(line).split(/\{[^{}]+\}/).forEach(part => {
      part.split(/[.!?()]/).map(t => t.trim()).filter(t => t.length >= 10).forEach(t => {
        phrases.push(t.slice(0, 15));
        if (t.length > 15) phrases.push(t.slice(-15));
      });
    });
  });
  (CONFIG.EXTRA_TEMPLATE_NOISE || []).forEach(p => p && phrases.push(p));
  templateNoise_ = phrases.length ? new RegExp(phrases.map(esc).join('|')) : /$^/;
  return templateNoise_;
}

/** 관련 메일 판별: RELEVANT_KEYWORDS 중 하나라도 포함 (키워드 안의 공백은 있어도 없어도 됨) */
function relevantRe_() {
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(CONFIG.RELEVANT_KEYWORDS.map(k => esc(k).replace(/\s+/g, '\\s*')).join('|'));
}

function ccOpts_() {
  const cc = CONFIG.CC;
  return cc ? { cc } : {};
}

/** 회신 본문에서 인용된 원문(우리가 보낸 메일)을 잘라내고 새로 쓴 내용만 남김 */
function cleanReply_(body) {
  let s = String(body || '').replace(/\r/g, '');
  let cut = s.length;
  QUOTE_CUT.forEach(re => { const m = re.exec(s); if (m && m.index > 0 && m.index < cut) cut = m.index; });
  s = s.slice(0, cut);
  return s.split('\n').filter(l => !/^\s*>/.test(l) && !templateNoiseRe_().test(l)).join('\n').trim();
}

// ============================== Gmail / 캘린더 도우미 ==============================
function searchAll_(q) {
  const out = [];
  const PAGE = 100;
  for (let start = 0; ; start += PAGE) {
    const t = GmailApp.search(q, start, PAGE);
    out.push.apply(out, t);
    if (t.length < PAGE) break;
  }
  return out;
}

/** 임시보관함의 기존 초안 수신자 목록 (중복 초안 방지) */
function buildDraftIndex_() {
  const idx = { coop: new Set(), thanks: new Set() };
  GmailApp.getDraftMessages().forEach(m => {
    const subj = m.getSubject() || '';
    if (!relevantRe_().test(subj)) return;
    const isRe = /^\s*(?:\[\s*re\s*\]|re\s*:|회신\s*:)/i.test(subj);
    extractEmails_(m.getTo()).forEach(e => (isRe ? idx.thanks : idx.coop).add(e));
  });
  return idx;
}

function loadHolidays_() {
  const set = new Set(CONFIG.EXTRA_HOLIDAYS);
  try {
    const cal = CalendarApp.getCalendarById(CONFIG.HOLIDAY_CALENDAR_ID);
    if (!cal) throw new Error('공휴일 캘린더에 접근할 수 없음');
    const start = new Date(), end = new Date(start.getTime() + 60 * 86400000);
    cal.getEvents(start, end).forEach(ev => {
      if (!ev.isAllDayEvent() || /기념일|observance/i.test(ev.getDescription() || '')) return;
      let d = ev.getAllDayStartDate();
      const e = ev.getAllDayEndDate();
      while (d < e) { set.add(fmtDate_(d, 'yyyy-MM-dd')); d = new Date(d.getTime() + 86400000); }
    });
  } catch (err) {
    console.log('공휴일 캘린더 조회 실패, EXTRA_HOLIDAYS만 사용: ' + err);
  }
  return set;
}

function addBusinessDays_(from, n, holidays) {
  let d = new Date(from.getTime());
  let cnt = 0;
  while (cnt < n) {
    d = new Date(d.getTime() + 86400000);
    if (Number(fmtDate_(d, 'u')) >= 6 || holidays.has(fmtDate_(d, 'yyyy-MM-dd'))) continue;
    cnt++;
  }
  return d;
}

function formatDeadline_(d) {
  const w = '월화수목금토일'[Number(fmtDate_(d, 'u')) - 1];
  return `${Number(fmtDate_(d, 'M'))}월 ${Number(fmtDate_(d, 'd'))}일(${w})`;
}

// ============================== 공통 도우미 ==============================
function extractEmails_(text) {
  if (!text) return [];
  let s = String(text).replace(/＠/g, '@').replace(/\s*@\s*/g, '@').replace(/mailto:/gi, ' ');
  s = s.replace(/(\d{2,4}[-.)]\s?\d{3,4}[-.]\d{4})(?=[A-Za-z])/g, '$1 ');   // 02-123-4567abc@.. 처럼 붙은 경우 분리
  const re = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
  const out = [];
  (s.match(re) || []).forEach(e => {
    e = e.toLowerCase().replace(/\.+$/, '');
    if (out.indexOf(e) < 0) out.push(e);
  });
  return out;
}

function displayName_(from) {
  const s = String(from || '');
  const i = s.indexOf('<');
  return i > 0 ? s.slice(0, i).replace(/["']/g, '').trim() : '';
}

function canOverwriteReply_(v) {
  const s = String(v || '').trim();
  return !s || CONFIG.OVERWRITE_MANUAL_REPLY || AUTO_VALUES.has(s);
}

function writeCells_(ctx, colIdx0, cells) {
  if (ctx.dry || !cells.length) return;
  const byVal = new Map();
  cells.forEach(c => {
    if (!byVal.has(c.value)) byVal.set(c.value, []);
    byVal.get(c.value).push(colLetter_(colIdx0 + 1) + c.row);
  });
  byVal.forEach((a1s, value) => {
    for (let i = 0; i < a1s.length; i += 200) ctx.sheet.getRangeList(a1s.slice(i, i + 200)).setValue(value);
  });
}

function finalize_(ctx, st) {
  const c = st.c;
  const byStatus = Object.keys(c.p1ReplyByStatus).map(k => `${k} ${c.p1ReplyByStatus[k]}`).join(', ') || '없음';
  const report = [
    st.dryRun ? '[테스트 실행 — 시트 기록·초안 생성은 하지 않았습니다]' : '',
    '■ 기업컨택 자동화 실행 결과',
    `· 기간: ${fmtDate_(new Date(st.startedAt), 'MM/dd HH:mm')} ~ ${fmtDate_(new Date(), 'MM/dd HH:mm')} (자동 이어하기 포함 ${st.executions}회 실행)`,
    `· [Phase 1] 이메일 등록 행 대조: ${c.p1Rows}행 (20행 단위 ${c.p1Batches}회)`,
    `· [Phase 1] 발송 상태 업데이트: ${c.p1SentRows}행 (컨택일자 ${c.p1DateFilled}건, 초안작성여부 O ${c.p1FlagFilled}건)`,
    `· [Phase 1] 수신 상태 업데이트: ${c.p1ReplyUpdated}건 (${byStatus})`,
    `· [Phase 1] 수기 기재가 있어 덮어쓰지 않은 행: ${c.p1ReplyKeptManual}건`,
    `· [Phase 1] 거절 감사 답장 초안: ${c.p1Thanks}건 (이미 답장했거나 초안이 있어 건너뜀 ${c.p1ThanksSkipped}건)`,
    `· [Phase 2] 협력 요청 초안: ${c.p2Created}건 (20건 단위 ${c.p2Batches}회 / 기존 초안 확인 후 O만 기록 ${c.p2Existing}건 / 오류 ${c.p2Errors}건 / 팀원연락처 없음 ${c.p2NoPhone}건)`,
    c.p2Unparsed ? `· [확인 필요] 팀원명은 있으나 이메일 형식을 인식하지 못한 행: ${c.p2Unparsed}건 (로그 탭 참고)` : '',
    `· 본문 회신 기한: ${ctx.deadlineText}`,
  ].filter(Boolean).join('\n');
  PropertiesService.getScriptProperties().setProperty('LAST_REPORT', report);
  log_(ctx, 'P3', '', '', '', '최종 보고', report);
  console.log(report);
  saveState_(st);
  notify_(report);
}

function flushLogs_(ctx) {
  if (!ctx.logs.length) return;
  try {
    const ss = ctx.ss || contactSheet_().getParent();
    let sh = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
    if (!sh) {
      sh = ss.insertSheet(CONFIG.LOG_SHEET_NAME);
      sh.appendRow(['시각', '단계', '행', '기업명', '이메일', '처리', '상세']);
      sh.setFrozenRows(1);
    }
    sh.getRange(sh.getLastRow() + 1, 1, ctx.logs.length, 7).setValues(ctx.logs);
  } catch (e) {
    console.log('로그 기록 실패: ' + e);
  }
  ctx.logs = [];
}

function log_(ctx, phase, row, company, emails, action, detail) {
  const safe = v => { const s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? "'" + s : s; };
  ctx.logs.push([fmtDate_(new Date(), 'yyyy-MM-dd HH:mm:ss'), phase, row, company,
    Array.isArray(emails) ? emails.join(', ') : emails, action, String(detail || '').slice(0, 1000)].map(safe));
}

function scheduleResume_() {
  deleteResumeTriggers_();
  ScriptApp.newTrigger('resumeAutomation').timeBased().after(CONFIG.RESUME_DELAY_MS).create();
}

function deleteResumeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'resumeAutomation') ScriptApp.deleteTrigger(t);
  });
}

function loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  return s ? JSON.parse(s) : null;
}
function saveState_(st) { PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(st)); }
function notify_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); } }
function norm_(s) { return String(s || '').replace(/\s+/g, ''); }
function domainOf_(e) { const i = String(e).lastIndexOf('@'); return i > 0 ? e.slice(i + 1).toLowerCase() : ''; }
function normMid_(s) { s = String(s || '').trim().toLowerCase(); return !s ? '' : (s[0] === '<' ? s : '<' + s + '>'); }
function fmtDate_(d, p) { return Utilities.formatDate(d, 'Asia/Seoul', p); }
function chunk_(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }