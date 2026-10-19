const test = require('node:test');
const assert = require('node:assert/strict');
const sq = require('../server/lib/specQuestion');

test('spec questions are recognised', () => {
  assert.ok(sq.isSpecQuestion('SAF 주요 업체별 스펙 정리해줘'));
  assert.ok(sq.isSpecQuestion('Neste, Eni 스펙 비교'));
  assert.ok(!sq.isSpecQuestion('SAF 생산업체 Top10'));
});

test('dropEmptyRows removes rows without any value and the non-producer explanation lines, keeps real rows', () => {
  const t = [
    '| 업체명 | 생산능력 | 원료 |', '| :--- | :--- | :--- |',
    '| Neste | 연간 150만 톤 [1] | UCO |', '| United Airlines | - | 자료에 언급 없음 |', '| Shell | 미공시 | ⚠원문 확인 필요 |', '| Eni | - | 폐식용유 [2] |',
    '', '- 항공사는 생산자가 아닌 구매처라 생산 스펙이 없습니다.', '- Neste는 확대 중입니다.',
  ].join('\n');
  const out = sq.dropEmptyRows(t);
  assert.ok(out.includes('Neste') && out.includes('| Eni |') && out.includes('| 업체명 |'));
  assert.ok(!out.includes('United Airlines') && !out.includes('Shell') && !out.includes('구매처'));
  assert.ok(out.includes('Neste는 확대'));
});

test('normalizeSpecTables: one row per company, tons/year in the capacity column, other values listed as 참고', () => {
  const st = require('../server/lib/specTable');
  assert.deepEqual(st.parseCapacity('150만 톤 [1]'), { tons: 1500000, converted: false });
  assert.equal(Math.round(st.parseCapacity('10,500 bpd').tons), Math.round(10500 * 158.987 * 365 * 0.8 / 1000));
  assert.equal(st.parseCapacity('1,000만 갤런').converted, true);
  assert.equal(st.parseCapacity('자료에 없음'), null);
  const t = [
    '| 업체명 | 생산능력 | 원료 | 상태 | 기준 시점 |', '| :--- | :--- | :--- | :--- | :--- |',
    '| EcoCeres | 45만 톤 | - | 계획 | 2030년 [5] |', '| EcoCeres | 77만 톤 [6] | 폐식용유 | 가동 | 현재 |',
    '| Chevron | 10만 bpd | - | 목표 | 2030년 |', '| Chevron | 3.4억 갤런 | - | 계획 | 2025년 |',
  ].join('\n');
  const out = st.normalizeSpecTables(t, { density: 0.8 });
  const rows = out.split('\n').filter((l) => /^\| (EcoCeres|Chevron)/.test(l));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('770,000') && out.includes('생산능력 (톤/년)'));
  assert.ok(rows[1].includes('※') && out.includes('원문 3.4억 갤런') && out.includes('참고') && out.includes('450,000 톤/년'));
});

test('normalizeSpecTables: running beats a later planned year even without a status column', () => {
  const st = require('../server/lib/specTable');
  const t = ['| 업체 | 생산능력 | 가동 시점 |', '| :-- | :-- | :-- |', '| A | 45만 톤 | 2030년 예정 |', '| A | 77만 톤 | 현재 가동 |'].join('\n');
  const out = st.normalizeSpecTables(t);
  assert.ok(/\| A \| 770,000/.test(out) && out.includes('450,000 톤/년'));
});

test('parseCapacity handles "4만 2,000톤" and drops warning text', () => {
  const st = require('../server/lib/specTable');
  assert.equal(st.parseCapacity('4만 2,000톤').tons, 42000);
  assert.equal(st.parseCapacity('10,500 bpd ⚠원문 수치 확인 필요').converted, true);
});

test('normalizeSpecTables: market-supply targets and feedstock throughput are not capacity rows', () => {
  const st = require('../server/lib/specTable');
  const t = ['| 업체 | 생산능력 | 비고 |', '| :-- | :-- | :-- |', '| Moeve | 250만 톤 | 2030년 이베리아 시장 내 공급 목표 |', '| Moeve | 50만 톤 | La Rábida 공장 |', '| LG-Eni | 40만 톤 | 원료 처리량 |', '| Neste | 150만 톤 | |'].join('\n');
  const out = st.normalizeSpecTables(t);
  assert.ok(/\| Moeve \| 500,000/.test(out) && !out.includes('2,500,000'));
  assert.ok(/\| LG-Eni \| -/.test(out) && !out.includes('400,000'));
  assert.ok(/\| Neste \| 1,500,000/.test(out));
});

test('spec table: classified facts decide the capacity column; unclassified companies fall back to the text', () => {
  const st = require('../server/lib/specTable');
  const facts = st.factIndex([
    { entity: 'Moeve', kind: 'market_target', group: 'mass', amount: 2500000, status: '목표', year: 2030, source: 9 },
    { entity: 'Moeve', kind: 'plant_capacity', group: 'mass', amount: 500000, status: '계획', year: 2027, source: 9, product: 'saf' },
    { entity: 'LG-Eni', kind: 'feed_throughput', group: 'mass', amount: 400000, status: '계획', year: 2027, source: 6 },
    { entity: 'Petrobras', kind: 'plant_capacity', group: 'volume', amount: 10500 * 158.987 * 365, status: '가동', year: 2026, source: 14, original: '10,500 b/d' },
    { entity: 'Unclassified Co', kind: null, group: 'mass', amount: 1, status: '가동' },
  ], { density: 0.8 });
  const t = ['| 업체 | 생산능력 | 가동 시점 |', '| :-- | :-- | :-- |', '| Moeve | 250만 톤 | 2030년 |', '| LG-Eni | 40만 톤 | 2027년 |', '| Petrobras | ⚠원문 확인 | 미공시 |', '| Neste | 150만 톤 | 현재 |'].join('\n');
  const out = st.normalizeSpecTables(t, { density: 0.8, facts });
  assert.ok(/\| Moeve \| 500,000 \[9\]/.test(out) && !out.includes('2,500,000'));
  assert.ok(/\| LG-Eni \| - \|/.test(out));
  assert.ok(/\| Petrobras \| 484,/.test(out) || /\| Petrobras \| 48\d,\d{3} ※/.test(out));
  assert.ok(/\| Neste \| 1,500,000/.test(out));
});

test('recordsForQuestion: a capacity question drops facts classified as throughput / market target', () => {
  const dp = require('../server/lib/datasetPipeline');
  const base = { status: '계획', year: 2030, group: 'mass', site: null, source: 1, pubAt: new Date().toISOString(), metric: '생산능력' };
  const out = dp.recordsForQuestion([{ ...base, entity: 'A', amount: 5, original: '5 톤', kind: 'market_target' }, { ...base, entity: 'B', amount: 6, original: '6 톤', kind: 'plant_capacity' }, { ...base, entity: 'C', amount: 7, original: '7 톤', kind: null }], '업체별 생산능력', null).map((r) => r.entity);
  assert.deepEqual(out, ['B', 'C']);
});

test('normalizeSpecTables: a capacity cell the number check could not ground (⚠) is not shown as a value', () => {
  const st = require('../server/lib/specTable');
  const t = ['| 업체 | 생산능력 |', '| :-- | :-- |', '| Petrobras | ⚠원문 수치 확인 필요 |', '| Neste | 150만 톤 |'].join('\n');
  const out = st.normalizeSpecTables(t);
  assert.ok(/\| Petrobras \| - \|/.test(out) && /\| Neste \| 1,500,000/.test(out));
});

test('feed_throughput: dropped for fuel plants, kept as capacity for refineries / crushers (product other)', () => {
  const dp = require('../server/lib/datasetPipeline');
  const base = { status: '가동', year: 2026, group: 'mass', site: null, source: 1, pubAt: new Date().toISOString(), metric: '처리 용량', kind: 'feed_throughput' };
  const out = dp.recordsForQuestion([{ ...base, entity: 'FuelCo', amount: 5, original: '5 톤', product: 'saf' }, { ...base, entity: 'Taiko', amount: 6, original: '6 톤', product: 'other' }], '업체별 생산능력', null).map((r) => r.entity);
  assert.deepEqual(out, ['Taiko']);
  const st = require('../server/lib/specTable');
  const idx = st.factIndex([{ entity: 'Taiko', kind: 'feed_throughput', product: 'other', group: 'mass', amount: 500000, status: '가동' }]);
  assert.equal(idx.get('taiko').caps.length, 1);
});

test('methodology page and evidence hook exist in the frontend', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'methodology.html'), 'utf8');
  assert.match(page, /데이터 출처·방법론/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(app.includes('aiEvidenceHtml(sources)') && app.includes('methodology.html') && !app.includes('ai-table-csv'));
});

test('archive tab guide covers search, filters and the 전체 / 내 저장 / 팀 Pick views and is wired to the 사용 가이드 link', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(app.includes('ARCHIVE_TOUR_STEPS') && app.includes("path === 'archive'") && app.includes('startArchiveTour(true)'));
  for (const t of ["title: '필터'", "title: '내 저장'", "title: '팀 Pick'", "title: '전체'"]) assert.ok(app.includes(t), t);
});

test('Umami analytics: script in index.html with auto-track off, app.js reports each screen without query strings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /cloud\.umami\.is\/script\.js/);
  assert.match(html, /data-website-id="a67938f9-6234-43bb-9b48-d4e43825b48b"/);
  assert.match(html, /data-auto-track="false"/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(app.includes('function trackPageview') && app.includes('trackPageview(path, param);'));
  assert.ok(!/umami\.track\([^)]*query/.test(app));
});

test('팀 Pick menu is anchored in page coordinates (absolute), not the viewport (fixed)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const rule = css.match(/\.team-pick-menu \{[^}]*\}/)[0];
  assert.match(rule, /position: absolute/);
  assert.ok(!/position: fixed/.test(rule));
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(app.includes('rect.bottom + window.scrollY + 4'));
});

test('a bold label followed by a semicolon becomes a colon (server and client), real semicolons stay', () => {
  const { fixLabelColons } = require('../server/routes/search');
  const raw = '- **합작 법인 및 규모**; LG화학은 합작했다.\n1. **활용 계획**； 생산된 HVO.\n**제목**;내용\n- 문장 안의 세미콜론; 그대로 둔다 **굵게**; 이건 문장 중간\n| a | b; c |';
  const out = fixLabelColons(raw);
  assert.match(out, /- \*\*합작 법인 및 규모\*\*: LG화학은 합작했다\./);
  assert.match(out, /1\. \*\*활용 계획\*\*: 생산된 HVO\./);
  assert.match(out, /\*\*제목\*\*: 내용/);
  assert.match(out, /문장 안의 세미콜론; 그대로 둔다 \*\*굵게\*\*; 이건 문장 중간/);
  assert.match(out, /\| a \| b; c \|/);
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(app.includes("[;；][ \\t]*/g, (m, nl, bullet, label)"));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css.match(/\.team-pick-menu \{[^}]*\}/)[0], /z-index: 9;/);
});
