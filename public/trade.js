// 무역통계 대시보드 (관세청 수출입실적). Loaded on demand by app.js; renders with DOM APIs and textContent only (names come from data).
// Layout follows what established trade dashboards share: one filter row (item · period · flow · metric) above everything, a KPI strip, one
// main time series, then breakdowns that drill down (HS levels) and across (countries). All state lives in the URL so a view can be shared.
(function () {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const PRESETS = [['15', '유지 전체'], ['1511', '팜유'], ['1507', '대두유'], ['1514', '유채유'], ['1512', '해바라기유'], ['1513', '야자·팜핵유'], ['3826', '바이오디젤']];
  const LEVEL_LABEL = { 2: '류(2자리)', 4: '호(4자리)', 6: '소호(6자리)', 8: '8자리', 10: '품목(10자리)' };
  const METRICS = { ton: ['물량', '톤'], usd: ['금액', '달러'], price: ['단가', '달러/톤'] };
  let api = (p) => fetch(`/api${p}`).then((r) => r.json());

  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const sv = (tag, attrs, ...kids) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  // ---- formatting ----
  const nf = (v, d = 0) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const fmtTon = (v) => (v == null ? '–' : `${nf(v)}톤`);
  const fmtUsd = (v) => (v == null ? '–' : v >= 1e8 ? `$${nf(v / 1e6)}M` : v >= 1e6 ? `$${nf(v / 1e6, 1)}M` : `$${nf(v / 1e3, 0)}K`);
  const fmtPrice = (v) => (v == null ? '–' : `$${nf(v)}/톤`);
  const fmtOf = { ton: fmtTon, usd: fmtUsd, price: fmtPrice };
  const fmtPct = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  const ym = (p) => `${p.slice(0, 4)}.${p.slice(4)}`;
  const valueOf = (p, metric, prev) => (prev ? { ton: p.prevTon, usd: p.prevUsd, price: p.prevPrice }[metric] : { ton: p.ton, usd: p.usd, price: p.price }[metric]);
  const yoyOf = (p, metric) => ({ ton: p.yoyTon, usd: p.yoyUsd, price: p.yoyPrice }[metric]);
  const addMonths = (period, n) => { const y = Number(period.slice(0, 4)); const m = Number(period.slice(4)) - 1 + n; return `${y + Math.floor(m / 12)}${String(((m % 12) + 12) % 12 + 1).padStart(2, '0')}`; };

  // ---- state in the URL ----
  const keep = (q) => ({ hs: q.hs || '15', from: q.from || '', to: q.to || '', flow: q.flow === 'exp' ? 'exp' : 'imp', metric: ['ton', 'usd', 'price'].includes(q.metric) ? q.metric : 'ton', yoy: q.yoy === '0' ? '0' : '1', view: q.view === 'table' ? 'table' : 'chart' });
  const href = (state, over) => {
    const s = { ...state, ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(s)) if (v !== '' && v != null) p.set(k, v);
    return `#/trade?${p}`;
  };
  const go = (state, over) => { location.hash = href(state, over); };

  // ---- pieces ----
  function segmented(label, options, current, onPick) {
    const wrap = el('div', { class: 'tv-seg', role: 'group', 'aria-label': label });
    for (const [value, text] of options) {
      wrap.append(el('button', { type: 'button', class: value === current ? 'is-on' : '', 'aria-pressed': String(value === current), onclick: () => onPick(value) }, text));
    }
    return wrap;
  }

  function breadcrumb(data, state) {
    const nav = el('nav', { class: 'tv-crumbs', 'aria-label': '품목 위치' });
    nav.append(el('a', { href: href(state, { hs: '15' }) }, '유지 전체'));
    for (const c of data.breadcrumb) {
      if (c.code === '15') continue;
      nav.append(el('span', { 'aria-hidden': 'true' }, ' › '), el('a', { href: href(state, { hs: c.code }), 'aria-current': c.code === data.hs ? 'page' : null }, c.name ? `${c.name} ` : '', el('small', {}, c.code)));
    }
    return nav;
  }

  function searchBox(state) {
    const input = el('input', { type: 'search', class: 'tv-search', placeholder: 'HS코드 또는 품목명 검색 (예: 1511, 대두)', 'aria-label': '품목 검색', autocomplete: 'off' });
    const list = el('ul', { class: 'tv-suggest', role: 'listbox', hidden: true });
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        let res; try { res = await api(`/trade/search?q=${encodeURIComponent(q)}`); } catch (_) { return; }
        list.textContent = '';
        const rows = (res && res.results) || [];
        for (const r of rows) {
          list.append(el('li', { role: 'option' }, el('a', { href: href(state, { hs: r.code }) }, el('b', {}, r.code), ' ', r.name, ' ', el('small', {}, LEVEL_LABEL[r.level] || ''))));
        }
        if (!rows.length) list.append(el('li', { class: 'tv-muted' }, '검색 결과가 없습니다'));
        list.hidden = false;
      }, 200);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.hidden = true; });
    return el('div', { class: 'tv-searchwrap' }, input, list);
  }

  function periodControls(data, state) {
    const latest = data.latest;
    const set = (from, to) => go(state, { from, to });
    const from = el('input', { type: 'month', value: `${data.from.slice(0, 4)}-${data.from.slice(4)}`, max: `${latest.slice(0, 4)}-${latest.slice(4)}`, 'aria-label': '시작월' });
    const to = el('input', { type: 'month', value: `${data.to.slice(0, 4)}-${data.to.slice(4)}`, max: `${latest.slice(0, 4)}-${latest.slice(4)}`, 'aria-label': '종료월' });
    const apply = () => { const f = from.value.replace('-', ''); const t = to.value.replace('-', ''); if (/^\d{6}$/.test(f) && /^\d{6}$/.test(t) && f <= t) set(f, t); };
    from.addEventListener('change', apply); to.addEventListener('change', apply);
    const btn = (text, f, t) => el('button', { type: 'button', class: 'tv-chip', onclick: () => set(f, t) }, text);
    const wrap = el('div', { class: 'tv-period' },
      el('label', {}, '기간 ', from, ' ~ ', to),
      el('span', { class: 'tv-presets' },
        btn('12개월', addMonths(latest, -11), latest), btn('24개월', addMonths(latest, -23), latest), btn('36개월', addMonths(latest, -35), latest),
        btn('올해', `${latest.slice(0, 4)}01`, latest), btn('전년', `${Number(latest.slice(0, 4)) - 1}01`, `${Number(latest.slice(0, 4)) - 1}12`)));
    return wrap;
  }

  function delta(v) {
    if (v == null) return el('span', { class: 'tv-delta' }, '–');
    const dir = v > 0.0005 ? '▲' : v < -0.0005 ? '▼' : '■';
    return el('span', { class: 'tv-delta', 'aria-label': `${v > 0 ? '증가' : v < 0 ? '감소' : '변동 없음'} ${fmtPct(v)}` }, `${dir} ${fmtPct(v)}`);
  }
  function tile(label, value, sub) { return el('div', { class: 'tv-tile' }, el('div', { class: 'tv-tile-label' }, label), el('div', { class: 'tv-tile-value' }, value), sub ? el('div', { class: 'tv-tile-sub' }, sub) : null); }

  function kpiStrip(data, state) {
    const k = data.kpis; const m = state.metric; const flowName = state.flow === 'exp' ? '수출' : '수입';
    if (!k) return el('p', { class: 'tv-muted' }, '선택한 기간에 데이터가 없습니다.');
    const cur = { ton: k.ton, usd: k.usd, price: k.price }[m];
    const yoy = { ton: k.yoyTon, usd: k.yoyUsd, price: k.yoyPrice }[m];
    const t12 = k.t12;
    return el('div', { class: 'tv-tiles' },
      tile(`${ym(k.period)} ${flowName}${METRICS[m][0]}`, fmtOf[m](cur), el('span', {}, '전년 동월 ', delta(yoy))),
      tile('직전 월 대비 (물량)', delta(k.momTon), el('span', { class: 'tv-muted' }, '월별 계절성이 커서 전년 동월 비교를 함께 보세요')),
      tile(`최근 12개월 ${flowName}량`, t12 ? fmtTon(t12.ton) : '–', t12 ? el('span', {}, '직전 12개월 대비 ', delta(t12.changeTon)) : el('span', { class: 'tv-muted' }, '12개월치 데이터가 부족합니다')),
      tile('최근 12개월 평균 단가', t12 ? fmtPrice(t12.price) : '–', el('span', { class: 'tv-muted' }, '금액÷중량')));
  }

  // The main chart: bars for volume/value, a line for unit price; optional prior-year line; crosshair snaps to the month; tooltip lists both values.
  function trendChart(data, state) {
    const m = state.metric; const pts = data.series; const W = 760; const H = 320; const L = 62; const R = 14; const T = 14; const B = 30;
    const vals = pts.map((p) => valueOf(p, m)); const prevs = state.yoy === '1' ? pts.map((p) => valueOf(p, m, true)) : [];
    const finite = [...vals, ...prevs].filter((v) => v != null);
    const wrap = el('div', { class: 'tv-chartwrap' });
    if (!finite.length) { wrap.append(el('p', { class: 'tv-muted' }, '표시할 데이터가 없습니다.')); return wrap; }
    const niceMax = (v) => { const e = 10 ** Math.floor(Math.log10(v || 1)); const n = v / e; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * e; };
    const max = niceMax(Math.max(...finite)); const min = m === 'price' ? 0 : 0;
    const step = (W - L - R) / pts.length; const x = (i) => L + step * (i + 0.5); const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tv-svg', role: 'img', 'aria-label': `${data.name || data.hs} ${state.flow === 'exp' ? '수출' : '수입'} ${METRICS[m][0]} 월별 추이` });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i; const yy = y(v);
      svg.append(sv('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'tv-grid' }), sv('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', class: 'tv-axis' }, m === 'usd' ? fmtUsd(v) : nf(v)));
    }
    pts.forEach((p, i) => { if (pts.length <= 18 || i % Math.ceil(pts.length / 12) === 0 || p.period.endsWith('01')) svg.append(sv('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'tv-axis' }, p.period.endsWith('01') || i === 0 ? ym(p.period) : p.period.slice(4))); });
    if (m === 'price') {
      const path = (arr) => arr.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
      if (prevs.length) svg.append(sv('polyline', { points: path(prevs).join(' '), class: 'tv-line-prev', fill: 'none' }));
      svg.append(sv('polyline', { points: path(vals).join(' '), class: 'tv-line', fill: 'none' }));
      vals.forEach((v, i) => { if (v != null && pts.length <= 40) svg.append(sv('circle', { cx: x(i), cy: y(v), r: 3, class: 'tv-dot' })); });
    } else {
      const bw = Math.max(3, Math.min(34, step * 0.7));
      vals.forEach((v, i) => { if (v == null) return; const h = Math.max(1, y(0) - y(v)); svg.append(sv('path', { d: `M${x(i) - bw / 2},${y(0)} v${-(h - 3)} q0,-3 3,-3 h${bw - 6} q3,0 3,3 v${h - 3} z`, class: 'tv-bar' })); });
      if (prevs.length) svg.append(sv('polyline', { points: prevs.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' '), class: 'tv-line-prev', fill: 'none' }));
    }
    const cross = sv('line', { y1: T, y2: H - B, class: 'tv-cross', visibility: 'hidden' });
    const hit = sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: '0', 'aria-label': '월별 값 보기: 방향키로 이동' });
    svg.append(cross, hit);
    const tip = el('div', { class: 'tv-tip', hidden: true, role: 'status' });
    const show = (i) => {
      const p = pts[i]; if (!p) return;
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      tip.append(el('div', { class: 'tv-tip-h' }, ym(p.period)),
        el('div', { class: 'tv-tip-r' }, el('i', { class: 'tv-key' }), el('b', {}, fmtOf[m](valueOf(p, m))), ' ', METRICS[m][0]),
        state.yoy === '1' ? el('div', { class: 'tv-tip-r tv-muted' }, el('i', { class: 'tv-key tv-key-prev' }), fmtOf[m](valueOf(p, m, true)), ' 전년 동월') : null,
        el('div', { class: 'tv-tip-r tv-muted' }, `전년 대비 ${fmtPct(yoyOf(p, m))}`));
      tip.hidden = false;
      const rect = svg.getBoundingClientRect(); const px = (x(i) / W) * rect.width;
      tip.style.left = `${Math.min(rect.width - 170, Math.max(4, px + 10))}px`;
    };
    const idxAt = (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; return Math.max(0, Math.min(pts.length - 1, Math.floor((px - L) / step))); };
    let cur = pts.length - 1;
    hit.addEventListener('pointermove', (e) => { cur = idxAt(e); show(cur); });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') cur = Math.max(0, cur - 1); else if (e.key === 'ArrowRight') cur = Math.min(pts.length - 1, cur + 1); else return; e.preventDefault(); show(cur); });
    hit.addEventListener('blur', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    wrap.append(svg, tip);
    return wrap;
  }

  function legend(state) {
    const items = [el('span', { class: 'tv-legend-i' }, el('i', { class: 'tv-key' }), `${METRICS[state.metric][0]} (${METRICS[state.metric][1]})`)];
    if (state.yoy === '1') items.push(el('span', { class: 'tv-legend-i' }, el('i', { class: 'tv-key tv-key-prev' }), '전년 동월'));
    return el('div', { class: 'tv-legend' }, items);
  }

  function seriesTable(data) {
    const t = el('table', { class: 'tv-table' }, el('thead', {}, el('tr', {}, ['월', '물량(톤)', '금액(USD)', '단가(USD/톤)', '물량 전년비', '단가 전년비'].map((h) => el('th', { scope: 'col' }, h)))));
    const body = el('tbody');
    for (const p of data.series) body.append(el('tr', {}, el('th', { scope: 'row' }, ym(p.period)), el('td', {}, p.ton == null ? '–' : nf(p.ton)), el('td', {}, p.usd == null ? '–' : nf(p.usd)), el('td', {}, p.price == null ? '–' : nf(p.price)), el('td', {}, fmtPct(p.yoyTon)), el('td', {}, fmtPct(p.yoyPrice))));
    t.append(body);
    return el('div', { class: 'tv-tablewrap' }, t);
  }

  // ranked list with an inline bar: the share is the number, the bar is only a visual aid
  function rankList(title, note, rows, linkFor) {
    const card = el('section', { class: 'tv-card' }, el('h3', {}, title), note ? el('p', { class: 'tv-muted tv-note' }, note) : null);
    if (!rows.length) { card.append(el('p', { class: 'tv-muted' }, '데이터가 없습니다.')); return card; }
    const top = Math.max(...rows.map((r) => r.share || 0)) || 1;
    const t = el('table', { class: 'tv-table tv-rank' }, el('thead', {}, el('tr', {}, ['', '비중', '물량(톤)'].map((h, i) => el('th', { scope: 'col', class: i ? 'tv-num' : '' }, h)))));
    const body = el('tbody');
    for (const r of rows) {
      const label = linkFor ? el('a', { href: linkFor(r) }, r.code ? el('b', {}, r.code) : null, ' ', r.name || '') : el('span', {}, r.name || r.code);
      body.append(el('tr', {}, el('th', { scope: 'row' }, label, el('span', { class: 'tv-bar-track' }, el('span', { class: 'tv-bar-fill', style: `width:${Math.max(1, ((r.share || 0) / top) * 100)}%` }))), el('td', { class: 'tv-num' }, r.share == null ? '–' : `${(r.share * 100).toFixed(1)}%`), el('td', { class: 'tv-num' }, nf(r.ton))));
    }
    t.append(body); card.append(t);
    return card;
  }

  async function render(app, query, deps) {
    if (deps && deps.api) api = deps.api;
    const state = keep(query);
    app.textContent = '';
    app.append(el('p', { class: 'tv-muted' }, '무역통계를 불러오는 중…'));
    const qs = new URLSearchParams({ hs: state.hs, flow: state.flow }); if (state.from) qs.set('from', state.from); if (state.to) qs.set('to', state.to);
    let data; try { data = await api(`/trade/dashboard?${qs}`); } catch (_) { data = { error: 'network' }; }
    app.textContent = '';
    const root = el('section', { class: 'tv-root' });
    app.append(root);
    root.append(el('div', { class: 'tv-head' }, el('h2', {}, '무역통계'), el('p', { class: 'tv-muted' }, '관세청 수출입무역통계(공공데이터포털). 중량은 톤, 금액은 달러이며 단가는 금액÷중량입니다. 최근 월은 잠정치일 수 있습니다.')));
    if (data.empty) { root.append(el('p', { class: 'tv-muted' }, '아직 적재된 데이터가 없습니다. 첫 동기화 후 표시됩니다.')); return; }
    if (data.error) { root.append(el('p', { class: 'tv-muted' }, data.error === 'invalid_hs' ? 'HS코드는 2·4·6·8·10자리 숫자여야 합니다.' : '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')); return; }

    const chips = el('div', { class: 'tv-presets' }, PRESETS.map(([hs, name]) => el('a', { class: `tv-chip ${state.hs === hs ? 'is-on' : ''}`, href: href(state, { hs }) }, name)));
    root.append(el('div', { class: 'tv-filters' },
      el('div', { class: 'tv-row' }, searchBox(state), chips),
      breadcrumb(data, state),
      el('div', { class: 'tv-row' }, periodControls(data, state),
        segmented('수입·수출', [['imp', '수입'], ['exp', '수출']], state.flow, (v) => go(state, { flow: v })),
        segmented('지표', [['ton', '물량'], ['usd', '금액'], ['price', '단가']], state.metric, (v) => go(state, { metric: v })))));

    root.append(el('h3', { class: 'tv-selected' }, data.name || data.hs, ' ', el('small', {}, `${data.hs} · ${LEVEL_LABEL[data.hs.length] || ''}`)));
    root.append(kpiStrip(data, state));

    const csv = `/api/trade/export.csv?${qs}`;
    root.append(el('section', { class: 'tv-card' },
      el('div', { class: 'tv-card-h' }, el('h3', {}, `${ym(data.from)} ~ ${ym(data.to)} 월별 ${state.flow === 'exp' ? '수출' : '수입'} ${METRICS[state.metric][0]}`),
        el('div', { class: 'tv-tools' },
          el('button', { type: 'button', class: 'tv-chip', 'aria-pressed': String(state.yoy === '1'), onclick: () => go(state, { yoy: state.yoy === '1' ? '0' : '1' }) }, '전년 동월 비교'),
          el('button', { type: 'button', class: 'tv-chip', 'aria-pressed': String(state.view === 'table'), onclick: () => go(state, { view: state.view === 'table' ? 'chart' : 'table' }) }, '표로 보기'),
          el('a', { class: 'tv-chip', href: csv, download: '' }, 'CSV 받기'))),
      state.view === 'table' ? seriesTable(data) : el('div', {}, legend(state), trendChart(data, state))));

    const nl = data.children;
    const nextName = { 4: '호(4자리)', 6: '소호(6자리)', 10: '품목(10자리)' }[(data.hs.length < 4 ? 4 : data.hs.length < 6 ? 6 : data.hs.length < 10 ? 10 : 0)];
    root.append(el('div', { class: 'tv-cols' },
      nl.length ? rankList(`하위 분류 — ${nextName}`, `선택한 품목을 빠짐없이 나눈 구성입니다(합계 100%). 클릭하면 더 세부로 들어갑니다. 선택 기간 기준.`, nl, (r) => href(state, { hs: r.code }))
        : el('section', { class: 'tv-card' }, el('h3', {}, '하위 분류'), el('p', { class: 'tv-muted' }, '가장 세부 단계(10자리)입니다.')),
      rankList(`${state.flow === 'exp' ? '수출 상대국' : '수입 원산지'} 비중`,
        data.countryScope !== data.hs ? `국가별 통계는 HS 6자리까지 제공되어 ${data.countryScope} 기준입니다.` : (data.countryCoverage && (data.countryCoverage.from > data.from || data.countryCoverage.to < data.to) ? `국가별 자료는 ${ym(data.countryCoverage.from)}~${ym(data.countryCoverage.to)}만 포함합니다.` : '선택 기간 기준.'),
        data.countries.slice(0, 10), null)));
  }

  window.TradeDashboard = { render };
})();
