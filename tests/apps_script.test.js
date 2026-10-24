/**
 * Apps Script 순수 함수 테스트 (Google 서비스 없이 Node에서 실행)
 *   node --test tests/
 *
 * apps-script/*.gs 를 Apps Script처럼 한 전역 범위에 순서대로 불러온 뒤,
 * 메일 템플릿 렌더링·회신 분류·인용문 제거·설정 검사 같은 순수 함수만 확인한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'apps-script');
const FILES = ['Config.gs', 'Setup.gs', 'ImportRows.gs', 'ContactAutomation.gs'];

function load(props = {}) {
  const store = { ...props };
  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null }) },
  };
  vm.createContext(ctx);
  // const/let 선언을 테스트에서 꺼내 쓸 수 있도록 한 스크립트로 이어 붙여 실행
  const src = FILES.map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n') +
    '\n;globalThis.__t = { CONFIG, CONTACT_HEADERS, render_, templateNoiseRe_, relevantRe_, cleanReply_, ' +
    'classifyReply_, isAutoReply_, honorific_, extractFileId_, normName_, templateVarsCheck_, ST, ' +
    'buildCoopBody_, buildThanksBody_, extractEmails_ };';
  vm.runInContext(src, ctx, { filename: 'apps-script.js' });
  return ctx.__t;
}

const LEADER = { LEADER_NAME: '홍길동', LEADER_PHONE: '010-0000-0000', LEADER_EMAIL: 'lead@example.com', LEADER_TITLE: '예시팀 팀장' };

test('파일 간 함수 이름이 겹치지 않는다', () => {
  const names = {};
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of src.matchAll(/^function\s+([\w$]+)/gm)) {
      assert.ok(!names[m[1]], `${m[1]}: ${names[m[1]]} 와 ${f}에 중복`);
      names[m[1]] = f;
    }
  }
});

test('컨택 시트 머리글이 Python 스키마와 같다', () => {
  const t = load();
  const py = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.py'), 'utf8');
  const block = py.match(/CONTACT_HEADERS = \[([\s\S]*?)\]/)[1];
  const pyHeaders = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual([...t.CONTACT_HEADERS], pyHeaders);
});

test('템플릿: 값이 빈 줄은 빠지고 나머지는 치환된다', () => {
  const t = load();
  const body = t.render_(['안녕 {기업명}', 'Phone : {팀원연락처}', '', '끝'], { 기업명: '가나정밀', 팀원연락처: '' });
  assert.strictEqual(body, '안녕 가나정밀\n\n끝');
  assert.throws(() => t.render_(['{없는이름}'], {}), /모르는 이름/);
});

test('협력 요청·감사 본문이 설정값으로 만들어진다', () => {
  const t = load(LEADER);
  const ctx = { attachmentLabel: '제안서.pdf', deadlineText: '1월 2일(금)' };
  const coop = t.buildCoopBody_(ctx, { company: '가나정밀', manager: '김철수 과장', team: '이영희', phone: '', topic: '불량 개선' });
  assert.match(coop, /^가나정밀 김철수 과장님, 안녕하세요\./);
  assert.match(coop, /1월 2일\(금\)까지 회신/);
  assert.match(coop, /첨부파일: 제안서\.pdf 1부/);
  assert.doesNotMatch(coop, /Phone : \n|Phone : $/m);          // 팀원연락처 없으면 줄 삭제
  assert.doesNotMatch(coop, /불량 개선/);                     // INCLUDE_TOPIC_LINE=false
  assert.match(coop, /팀장 홍길동\nPhone : 010-0000-0000\nE-mail : lead@example.com$/);
  assert.doesNotMatch(coop, /\{|\}/);

  const thanks = t.buildThanksBody_({ company: '가나정밀', manager: '' }, { fromName: '박민수' });
  assert.match(thanks, /^가나정밀 박민수 담당자님/);
  assert.match(thanks, /예시팀 팀장/);
});

test('템플릿 변수 검사: 허용되지 않은 이름을 잡는다', () => {
  const t = load();
  t.templateVarsCheck_();
  t.CONFIG.THANKS_BODY.push('{팀원}');   // 감사 메일에는 팀원 정보가 없음
  assert.throws(() => t.templateVarsCheck_(), /THANKS_BODY.*\{팀원\}/);
});

test('회신 분류', () => {
  const t = load();
  assert.strictEqual(t.classifyReply_('내부 사정으로 이번에는 참여가 어렵습니다. 양해 부탁드립니다.'), t.ST.REJECT);
  assert.strictEqual(t.classifyReply_('좋은 제안 감사합니다. 다음 주 미팅 가능합니다.'), t.ST.ACCEPT);
  assert.strictEqual(t.classifyReply_('내부 검토 후 회신 드리겠습니다.'), t.ST.DELAY);
  assert.strictEqual(t.classifyReply_('자료 잘 받았습니다.'), t.ST.CHECK);
  assert.ok(t.isAutoReply_('[부재중] 휴가 안내', ''));
});

test('회신에서 인용된 우리 메일 문장을 지운다', () => {
  const t = load();
  const reply = [
    '검토 후 연락드리겠습니다.',
    '',
    '> 관련 제안서를 첨부하오니 적극적인 검토를 정중히 요청드립니다.',
    "본 공모전은 전문 멘토와 학생, 기업이 함께 기업의 실무 과제를",   // '>' 없이 인용된 줄
  ].join('\n');
  const clean = t.cleanReply_(reply);
  assert.strictEqual(clean, '검토 후 연락드리겠습니다.');
  assert.ok(t.templateNoiseRe_().test('진행 기간이 9주로 정해져 있어'));
});

test('관련 메일 판별: 키워드 안 공백은 있어도 없어도 된다', () => {
  const t = load();
  assert.ok(t.relevantRe_().test('[회신] 협력요청 건'));
  assert.ok(t.relevantRe_().test('협력 요청'));
  assert.ok(!t.relevantRe_().test('세금계산서 발행 안내'));
});

test('기타 도우미', () => {
  const t = load();
  assert.strictEqual(t.extractFileId_('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view'), '1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  assert.strictEqual(t.extractFileId_('아무 글자'), '');
  assert.strictEqual(t.normName_('(주) 가나정밀'), t.normName_('가나정밀 주식회사'));
  assert.strictEqual(t.honorific_('', ''), '담당자');
  assert.strictEqual(t.honorific_('김철수/차장', ''), '김철수 차장');
  assert.strictEqual(t.honorific_('과장', ''), '과장');
  assert.deepStrictEqual([...t.extractEmails_('031-000-0000 / Info@Example.com')], ['info@example.com']);
});
