// 무역통계 대시보드 (관세청 수출입실적). Loaded on demand by app.js; renders with DOM APIs and textContent only (names come from data).
// Layout follows what established trade dashboards share: one filter row (item · period · flow · metric) above everything, a KPI strip, one
// main time series, then breakdowns that drill down (HS levels) and across (countries). All state lives in the URL so a view can be shared.
(function () {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  // plain words for HS levels; the code itself stays secondary
  const LEVEL_LABEL = { 2: '대분류', 4: '품목군', 6: '세부 품목', 8: '세부 품목', 10: '최종 품목' };
  const METRICS = { ton: ['물량', '톤'], usd: ['금액', '달러'], price: ['단가', '달러/톤'] };
  let api = (p) => fetch(`/api${p}`).then((r) => r.json());
  const calm = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shown = new Map(); // last value each KPI showed, so a change counts from there instead of from zero

  // Counts a number to its new value (ease-out, ~0.45 s). Text only changes inside the number span; the unit stays put.
  function countTo(node, key, to, format) {
    const from = shown.has(key) ? shown.get(key) : to * 0.85;
    shown.set(key, to);
    if (calm() || from === to || !Number.isFinite(from)) { node.textContent = format(to); return; }
    const t0 = performance.now(); const dur = 450;
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur); const e = 1 - (1 - k) ** 3;
      node.textContent = format(from + (to - from) * e);
      if (k < 1 && node.isConnected) requestAnimationFrame(tick);
    };
    node.textContent = format(from);
    requestAnimationFrame(tick);
  }
  // number + quieter unit, e.g. 53,647 톤 / $1,156 /톤 / $63.4 M
  function figure(key, kind, v) {
    if (v == null) return el('span', { class: 'tv-fig' }, '–');
    const parts = kind === 'ton' ? ['', (x) => nf(x), '톤'] : kind === 'price' ? ['$', (x) => nf(x), '/톤']
      : v >= 1e6 ? ['$', (x) => nf(x / 1e6, 1), 'M'] : ['$', (x) => nf(x / 1e3), 'K'];
    const num = el('span', { class: 'tv-fig-n' });
    countTo(num, key, v, parts[1]);
    return el('span', { class: 'tv-fig', 'aria-label': fmtOf[kind](v) }, parts[0] ? el('span', { class: 'tv-fig-p' }, parts[0]) : null, num, el('span', { class: 'tv-fig-u' }, parts[2]));
  }
  // first paint: the page's own shape in quiet blocks, so nothing jumps when the numbers arrive
  function skeleton() {
    const b = (cls) => el('div', { class: `tv-skel ${cls}` });
    return el('div', { class: 'tv-skeleton', 'aria-hidden': 'true' },
      b('tv-skel-h1'), b('tv-skel-line'), b('tv-skel-bar'),
      el('div', { class: 'tv-tiles' }, b('tv-skel-tile'), b('tv-skel-tile'), b('tv-skel-tile')),
      b('tv-skel-chart'));
  }

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
    const wrap = el('div', { class: 'tv-seg', role: 'group', 'aria-label': label }, el('span', { class: 'tv-label', 'aria-hidden': 'true' }, label));
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
      nav.append(el('span', { 'aria-hidden': 'true' }, ' › '), el('a', { href: href(state, { hs: c.code }), 'aria-current': c.code === data.hs ? 'page' : null }, c.name || c.code));
    }
    return nav;
  }

  // Search by everyday words (콩기름, 카놀라, 바이오디젤 ...) or a code; arrow keys + Enter; an empty focus shows what people look for most.
  const POPULAR = [['1511', '팜유'], ['1507', '대두유(콩기름)'], ['1514', '유채유(카놀라)'], ['1512', '해바라기유'], ['1502', '우지(소기름)'], ['3826', '바이오디젤']];
  function searchBox(state) {
    const listId = 'tv-suggest-list';
    const input = el('input', { type: 'search', class: 'tv-search', placeholder: '품목 이름으로 찾기 — 예: 팜유, 콩기름, 카놀라, 바이오디젤', 'aria-label': '품목 검색', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list' });
    const list = el('ul', { class: 'tv-suggest', role: 'listbox', id: listId, hidden: true });
    let items = []; let active = -1; let timer; let seq = 0;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const highlight = (i) => {
      items.forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
      active = i;
      if (items[i]) { items[i].scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', items[i].id); }
    };
    const fill = (title, rows) => {
      list.textContent = ''; items = [];
      if (title) list.append(el('li', { class: 'tv-suggest-h', role: 'presentation' }, title));
      rows.forEach((r, k) => {
        const li = el('li', { role: 'option', id: `tv-opt-${k}`, 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); go(state, { hs: r.code }); } },
          el('span', { class: 'tv-opt-name' }, r.name || r.code),
          r.parent ? el('span', { class: 'tv-opt-path' }, r.parent) : null,
          el('span', { class: 'tv-opt-code' }, `${LEVEL_LABEL[r.level || r.code.length] || ''} · ${r.code}`));
        items.push(li); list.append(li);
      });
      if (!rows.length) list.append(el('li', { class: 'tv-suggest-empty', role: 'presentation' }, '찾는 품목이 없습니다. 다른 이름(예: 콩기름 → 대두유)이나 아래 "품목 둘러보기"를 이용해 보세요.'));
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
    };
    const showPopular = () => fill('자주 찾는 품목', POPULAR.map(([code, name]) => ({ code, name, level: code.length })));
    input.addEventListener('focus', () => { if (!input.value.trim()) showPopular(); });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { showPopular(); return; }
      const my = ++seq;
      timer = setTimeout(async () => {
        let res; try { res = await api(`/trade/search?q=${encodeURIComponent(q)}`); } catch (_) { return; }
        if (my !== seq) return; // a newer keystroke already asked
        fill(null, (res && res.results) || []);
      }, 160);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) showPopular(); highlight(Math.min(items.length - 1, active + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
      else if (e.key === 'Enter') { const pick = items[active >= 0 ? active : 0]; if (pick && !list.hidden) { e.preventDefault(); pick.dispatchEvent(new MouseEvent('mousedown')); } }
      else if (e.key === 'Escape') close();
    });
    return el('div', { class: 'tv-searchwrap' }, el('span', { class: 'tv-search-icon', 'aria-hidden': 'true' }, '⌕'), input, list);
  }

  // Browse without knowing any code: plain-language groups -> headings.
  async function browsePanel(state) {
    const box = el('details', { class: 'tv-browse' }, el('summary', {}, '품목 둘러보기'));
    let loaded = false;
    box.addEventListener('toggle', async () => {
      if (!box.open || loaded) return;
      loaded = true;
      let res; try { res = await api('/trade/groups'); } catch (_) { return; }
      const grid = el('div', { class: 'tv-browse-grid' });
      for (const g of (res && res.groups) || []) {
        grid.append(el('div', { class: 'tv-browse-g' }, el('h4', {}, g.name), el('ul', {}, g.items.map((it) => el('li', {}, el('a', { href: href(state, { hs: it.code }), class: it.code === state.hs ? 'is-on' : '' }, it.name))))));
      }
      box.append(grid);
    });
    return box;
  }

  // The picker can only reach months the data covers (min/max); the server clamps too, so a typed or shared bad range still renders.
  function periodControls(data, state) {
    const b = data.bounds || { min: data.from, max: data.latest };
    const toInput = (p) => `${p.slice(0, 4)}-${p.slice(4)}`;
    const clamp = (p) => (p < b.min ? b.min : p > b.max ? b.max : p);
    const set = (f, t) => { f = clamp(f); t = clamp(t); if (f > t) [f, t] = [t, f]; go(state, { from: f, to: t }); };
    const from = el('input', { type: 'month', value: toInput(data.from), min: toInput(b.min), max: toInput(b.max), 'aria-label': '시작월', required: true });
    const to = el('input', { type: 'month', value: toInput(data.to), min: toInput(b.min), max: toInput(b.max), 'aria-label': '종료월', required: true });
    const apply = () => { const f = from.value.replace('-', ''); const t = to.value.replace('-', ''); if (/^\d{6}$/.test(f) && /^\d{6}$/.test(t)) set(f, t); };
    from.addEventListener('change', apply); to.addEventListener('change', apply);
    const latest = b.max;
    const span = (n) => { const f = addMonths(latest, -(n - 1)); return f < b.min ? b.min : f; };
    const year = latest.slice(0, 4); const prevYear = String(Number(year) - 1);
    const opts = [['1년', span(12), latest], ['3년', span(36), latest], ['5년', span(60), latest], ['10년', span(120), latest], ['전체', b.min, latest], [`${year}년`, `${year}01`, latest], [`${prevYear}년`, `${prevYear}01`, `${prevYear}12`]];
    const btns = opts.map(([text, f, t]) => {
      const reachable = t >= b.min && f <= b.max;
      const on = clamp(f) === data.from && clamp(t) === data.to;
      return el('button', { type: 'button', class: `tv-chip ${on ? 'is-on' : ''}`, disabled: !reachable, title: reachable ? null : '이 기간에는 데이터가 없습니다', onclick: () => set(f, t) }, text);
    });
    return el('div', { class: 'tv-period' },
      el('span', { class: 'tv-label' }, '기간'), from, el('span', { 'aria-hidden': 'true' }, '–'), to, el('span', { class: 'tv-presets' }, btns),
      el('span', { class: 'tv-hint' }, `조회 가능: ${ym(b.min)} – ${ym(b.max)}`));
  }

  const ADJUST_TEXT = { to_clamped: '종료월을 최신 자료월로 맞췄습니다', from_clamped: '시작월을 가장 오래된 자료월로 맞췄습니다', swapped: '시작월과 종료월을 바꿨습니다', range_shortened: '조회 기간을 허용 범위로 줄였습니다', from_invalid: '시작월 형식이 올바르지 않아 기본값을 썼습니다', to_invalid: '종료월 형식이 올바르지 않아 기본값을 썼습니다' };

  function delta(v) {
    if (v == null) return el('span', { class: 'tv-delta' }, '–');
    const dir = v > 0.0005 ? '▲' : v < -0.0005 ? '▼' : '■';
    return el('span', { class: 'tv-delta', 'aria-label': `${v > 0 ? '증가' : v < 0 ? '감소' : '변동 없음'} ${fmtPct(v)}` }, el('span', { class: 'tv-arrow', 'aria-hidden': 'true' }, dir), fmtPct(v));
  }
  function tile(label, value, sub) { return el('div', { class: 'tv-tile' }, el('div', { class: 'tv-tile-label' }, label), el('div', { class: 'tv-tile-value' }, value), sub ? el('div', { class: 'tv-tile-sub' }, sub) : null); }

  function kpiStrip(data, state) {
    const k = data.kpis; const m = state.metric; const flowName = state.flow === 'exp' ? '수출' : '수입';
    if (!k) return el('p', { class: 'tv-muted' }, '선택한 기간에 데이터가 없습니다.');
    const cur = { ton: k.ton, usd: k.usd, price: k.price }[m];
    const yoy = { ton: k.yoyTon, usd: k.yoyUsd, price: k.yoyPrice }[m];
    const t12 = k.t12;
    // month-on-month for the chosen metric, from the series itself (latest month vs the one before)
    const i = data.series.findIndex((p) => p.period === k.period);
    const prev = i > 0 ? valueOf(data.series[i - 1], m) : null;
    const mom = cur != null && prev ? (cur - prev) / prev : null;
    return el('div', { class: 'tv-tiles' },
      tile(`${ym(k.period)} ${flowName} ${METRICS[m][0]}`, figure('cur', m, cur),
        el('span', { class: 'tv-subs' }, el('span', {}, '전년 동월 ', delta(yoy)), el('span', {}, '전월 ', delta(mom)))),
      tile(`최근 12개월 ${flowName}량`, figure('t12', 'ton', t12 ? t12.ton : null), t12 ? el('span', {}, '직전 12개월 대비 ', delta(t12.changeTon)) : el('span', { class: 'tv-muted' }, '12개월치 자료가 쌓이면 표시됩니다')),
      tile('최근 12개월 평균 단가', figure('t12p', 'price', t12 ? t12.price : null), el('span', { class: 'tv-muted' }, '금액 ÷ 중량')));
  }

  // The main chart: bars for volume/value, a line for unit price; optional prior-year line; crosshair snaps to the month; tooltip lists both values.
  function trendChart(data, state) {
    const m = state.metric; const pts = data.series; const avail = (document.getElementById('app') || document.body).clientWidth - 76;
    const W = Math.round(Math.max(300, Math.min(1080, avail))); const H = W < 560 ? 200 : 240; const L = W < 560 ? 44 : 58; const R = 8; const T = 10; const B = 26;
    const bars = []; // bar elements by month index, for hover focus
    const vals = pts.map((p) => valueOf(p, m)); const prevs = state.yoy === '1' ? pts.map((p) => valueOf(p, m, true)) : [];
    const finite = [...vals, ...prevs].filter((v) => v != null);
    const wrap = el('div', { class: 'tv-chartwrap' });
    if (!finite.length) { wrap.append(el('p', { class: 'tv-muted' }, '표시할 데이터가 없습니다.')); return wrap; }
    // round tick step (1·2·5 × 10ⁿ) so gridlines land on readable values; 3–5 lines
    const niceStep = (v) => { const e = 10 ** Math.floor(Math.log10(v || 1)); const n = v / e; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * e; };
    const tick = niceStep(Math.max(...finite) / 4); const nTicks = Math.max(1, Math.ceil(Math.max(...finite) / tick)); const max = tick * nTicks; const min = 0;
    const step = (W - L - R) / pts.length; const x = (i) => L + step * (i + 0.5); const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tv-svg', role: 'img', 'aria-label': `${data.name || data.hs} ${state.flow === 'exp' ? '수출' : '수입'} ${METRICS[m][0]} 월별 추이` });
    for (let i = 0; i <= nTicks; i++) {
      const v = tick * i; const yy = y(v);
      svg.append(sv('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'tv-grid' }), sv('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', class: 'tv-axis' }, m === 'usd' ? fmtUsd(v) : v >= 10000 && W < 560 ? `${nf(v / 1000)}k` : nf(v)));
    }
    const k = Math.max(1, Math.ceil(pts.length / Math.max(3, Math.floor((W - L - R) / 64))));
    pts.forEach((p, i) => {
      if ((pts.length - 1 - i) % k !== 0) return;
      const withYear = i < k || p.period.endsWith('01') || pts.slice(Math.max(0, i - k + 1), i).some((q) => q.period.endsWith('01'));
      svg.append(sv('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'tv-axis' }, withYear ? `${p.period.slice(2, 4)}.${p.period.slice(4)}` : p.period.slice(4)));
    });
    if (m === 'price' || pts.length > 60) {
      const path = (arr) => arr.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
      if (prevs.length) svg.append(sv('polyline', { points: path(prevs).join(' '), class: 'tv-line-prev', fill: 'none' }));
      svg.append(sv('polyline', { points: path(vals).join(' '), class: 'tv-line', fill: 'none', pathLength: '1' }));
      vals.forEach((v, i) => { if (v != null && pts.length <= 40) svg.append(sv('circle', { cx: x(i), cy: y(v), r: 3, class: 'tv-dot' })); });
      if (m !== 'price' && vals.some((v) => v != null)) svg.prepend(sv('polygon', { points: `${x(vals.findIndex((v) => v != null))},${y(0)} ${path(vals).join(' ')} ${x(vals.length - 1 - [...vals].reverse().findIndex((v) => v != null))},${y(0)}`, class: 'tv-area' }));
    } else {
      const bw = Math.max(3, Math.min(20, step * 0.5));
      vals.forEach((v, i) => {
        if (v == null) return;
        const h = Math.max(1, y(0) - y(v)); const r = Math.min(3, bw / 2, h); // rounded data end, flat on the baseline
        bars[i] = sv('path', { d: `M${x(i) - bw / 2},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z`, class: 'tv-bar', style: `--d:${Math.min(i * 14, 420)}ms` });
        svg.append(bars[i]);
      });
      if (prevs.length) svg.append(sv('polyline', { points: prevs.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' '), class: 'tv-line-prev', fill: 'none' }));
    }
    const cross = sv('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'tv-cross' });
    const hit = sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: '0', 'aria-label': '월별 값 보기: 방향키로 이동' });
    svg.append(cross, hit);
    const tip = el('div', { class: 'tv-tip', role: 'status' });
    const show = (i) => {
      const p = pts[i]; if (!p) return;
      cross.style.transform = `translateX(${x(i)}px)`; svg.classList.add('is-hover');
      bars.forEach((b, j) => b && b.classList.toggle('is-active', j === i));
      tip.textContent = '';
      tip.append(el('div', { class: 'tv-tip-h' }, ym(p.period)),
        el('div', { class: 'tv-tip-r' }, el('i', { class: 'tv-key' }), el('b', {}, fmtOf[m](valueOf(p, m))), ' ', METRICS[m][0]),
        state.yoy === '1' ? el('div', { class: 'tv-tip-r tv-muted' }, el('i', { class: 'tv-key tv-key-prev' }), fmtOf[m](valueOf(p, m, true)), ' 전년 동월') : null,
        el('div', { class: 'tv-tip-r tv-muted' }, `전년 대비 ${fmtPct(yoyOf(p, m))}`));
      const rect = svg.getBoundingClientRect(); const px = (x(i) / W) * rect.width;
      const left = px + 14 + 170 > rect.width ? px - 14 - 170 : px + 14; // flips to the left near the right edge
      tip.style.transform = `translateX(${Math.max(0, left)}px)`; tip.classList.add('is-on');
    };
    const idxAt = (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; return Math.max(0, Math.min(pts.length - 1, Math.floor((px - L) / step))); };
    let cur = pts.length - 1;
    hit.addEventListener('pointermove', (e) => { cur = idxAt(e); show(cur); });
    const hide = () => { svg.classList.remove('is-hover'); tip.classList.remove('is-on'); };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') cur = Math.max(0, cur - 1); else if (e.key === 'ArrowRight') cur = Math.min(pts.length - 1, cur + 1); else return; e.preventDefault(); show(cur); });
    hit.addEventListener('blur', hide);
    wrap.append(svg, tip);
    return wrap;
  }

  function legend(state) {
    if (state.yoy !== '1') return null; // one series: the card title names it
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
      const label = linkFor && r.code ? el('a', { href: linkFor(r) }, r.name || '이름 없는 품목', ' ', el('small', { class: 'tv-code' }, r.code)) : el('span', { class: r.code ? '' : 'tv-muted' }, r.name || r.code);
      body.append(el('tr', {}, el('th', { scope: 'row' }, label, el('span', { class: 'tv-bar-track' }, el('span', { class: 'tv-bar-fill', style: `width:${Math.max(1, ((r.share || 0) / top) * 100)}%` }))), el('td', { class: 'tv-num' }, r.share == null ? '–' : `${(r.share * 100).toFixed(1)}%`), el('td', { class: 'tv-num' }, nf(r.ton))));
    }
    t.append(body); card.append(t);
    return card;
  }

  // 운영 방침: how the numbers get here and what they do and do not claim (same collapsed-by-default pattern as the other tabs' explainers)
  function policySection(bounds, open) {
    const items = [
      ['출처', '관세청 수출입무역통계를 공공데이터포털 Open API(품목별·품목별 국가별·국가별 수출입실적)로 받습니다. 수치는 공표값 그대로이며, 비어 있는 달을 추정치로 채우지 않습니다.'],
      ['범위', '동식물성 유지 전 품목(HS 15류), 유지종자(대두·유채씨·해바라기씨 등), 유박(대두박 등), 바이오디젤(HS 3826)의 28개 품목군입니다. 국내 수입·수출 통관 기준입니다.'],
      ['갱신 주기', '관세청은 월말 후 약 2주 뒤 전월 실적을 공표합니다. 매월 17일에 자동 동기화하며, 최근 1~2개월은 잠정치라 이후 수정될 수 있습니다. 동기화 때 같은 기간을 다시 받아 수정치를 반영합니다.'],
      ['단위와 계산', '중량은 톤(공표 kg ÷ 1,000), 금액은 미 달러입니다. 단가는 금액 ÷ 중량으로 이 화면에서 계산한 값으로, 품질·조건이 다른 품목이 섞이면 실제 거래가와 다를 수 있습니다.'],
      ['품목 분류', '가장 세부 단위(HS 10자리)로 저장하고 상위 분류는 합계로 계산합니다. 그래서 하위 품목을 모두 더하면 상위 품목과 정확히 같습니다. 국가별 통계는 관세청이 HS 6자리까지만 제공하므로 그보다 세부 품목을 고르면 상위 6자리 기준으로 보여 줍니다.'],
      ['조회 기간', `${bounds ? `현재 ${ym(bounds.min)}부터 ${ym(bounds.max)}까지 조회할 수 있습니다. ` : ''}적재를 시작한 달부터 매월 한 달씩 늘어나며, 기간 입력은 이 범위 안에서만 고를 수 있습니다. 범위를 벗어나거나 시작·종료가 바뀐 주소로 열면 자동으로 범위 안으로 맞추고 그 사실을 화면에 알립니다.`],
      ['장애 시', '화면은 플랫폼 데이터베이스에 저장된 값만 읽습니다. 관세청 API에 장애가 있어도 마지막으로 받은 값은 그대로 보이며, 동기화 실패는 운영 알림으로 확인합니다.'],
      ['예정', '선박 단위 해상 물동량(Kpler, 2017~2026년)을 같은 화면 구조에 추가할 예정입니다. 통관 기준(관세청)과 선적 기준(Kpler)은 시점이 달라 합산하지 않고 나란히 비교합니다.'],
    ];
    return el('details', { class: 'section tv-policy', open: open || null }, el('summary', {}, '무역통계 운영 방침'),
      el('dl', { class: 'tv-policy-list' }, items.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
  }

  // rows under 0.5% become one "기타" row so the list shows who actually matters
  function foldSmall(rows, kind = 'country') {
    const big = rows.filter((r) => (r.share || 0) >= 0.005).slice(0, 8);
    const rest = rows.filter((r) => !big.includes(r));
    if (rest.length <= 1) return [...big, ...rest]; // folding a single row only hides its name
    const name = kind === 'item' ? `그 밖의 ${rest.length}개 품목` : `그 밖의 ${rest.length}개국`;
    return [...big, { name, share: rest.reduce((a, r) => a + (r.share || 0), 0), ton: rest.reduce((a, r) => a + (r.ton || 0), 0) }];
  }

  async function render(app, query, deps) {
    if (deps && deps.api) api = deps.api;
    const state = keep(query);
    const prev = app.querySelector('.tv-root');
    const policyWasOpen = Boolean(prev && prev.querySelector('.tv-policy[open]'));
    if (prev) { prev.classList.add('is-updating'); prev.setAttribute('aria-busy', 'true'); } else { app.textContent = ''; app.append(el('section', { class: 'tv-root' }, skeleton())); }
    const qs = new URLSearchParams({ hs: state.hs, flow: state.flow }); if (state.from) qs.set('from', state.from); if (state.to) qs.set('to', state.to);
    let data; try { data = await api(`/trade/dashboard?${qs}`); } catch (_) { data = { error: 'network' }; }
    const root = el('section', { class: `tv-root ${prev && prev.classList.contains('tv-root') && prev.querySelector('.tv-tiles, .tv-filters') ? 'is-swap' : 'is-enter'}` });
    // built off-page and swapped in whole: attaching it empty would shorten the page and lose the scroll position
    const commit = () => app.replaceChildren(root);
    root.append(el('div', { class: 'tv-head' }, el('h1', {}, '무역통계'), el('p', { class: 'page-lede' }, '유지·원료 품목의 월별 수출입 물량과 가격, 주요 상대국을 확인합니다. 품목은 이름으로 찾고 기간과 지표를 골라 보세요.'), policySection(data && data.bounds, policyWasOpen)));
    if (data.empty) { root.append(el('p', { class: 'tv-muted' }, '아직 적재된 데이터가 없습니다. 첫 동기화 후 표시됩니다.')); commit(); return; }
    if (data.error) { root.append(el('p', { class: 'tv-muted' }, data.error === 'invalid_hs' ? 'HS코드는 2·4·6·8·10자리 숫자여야 합니다.' : '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')); commit(); return; }

    root.append(el('div', { class: 'tv-filters' },
      el('div', { class: 'tv-row tv-row-search' }, searchBox(state), await browsePanel(state)),
      breadcrumb(data, state),
      el('div', { class: 'tv-row' }, periodControls(data, state)),
      el('div', { class: 'tv-row tv-switches' },
        segmented('수입·수출', [['imp', '수입'], ['exp', '수출']], state.flow, (v) => go(state, { flow: v })),
        segmented('지표', [['ton', '물량'], ['usd', '금액'], ['price', '단가']], state.metric, (v) => go(state, { metric: v })))));
    if (data.adjusted && data.adjusted.length) root.append(el('p', { class: 'tv-notice', role: 'status' }, `${data.adjusted.map((a) => ADJUST_TEXT[a] || a).join(' · ')}.`));

    root.append(el('div', { class: 'tv-selected' }, el('h3', {}, data.name || '이름 없는 품목'), el('span', { class: 'tv-badge' }, LEVEL_LABEL[data.hs.length] || ''), el('span', { class: 'tv-code' }, `HS ${data.hs}`)));
    root.append(kpiStrip(data, state));

    const csv = `/api/trade/export.csv?${qs}`;
    root.append(el('section', { class: 'tv-card' },
      el('div', { class: 'tv-card-h' }, el('h3', {}, `월별 ${state.flow === 'exp' ? '수출' : '수입'} ${METRICS[state.metric][0]}`, ' ', el('small', { class: 'tv-code' }, `${ym(data.from)}–${ym(data.to)} · ${METRICS[state.metric][1]}`)),
        el('div', { class: 'tv-tools' },
          el('button', { type: 'button', class: 'tv-chip', 'aria-pressed': String(state.yoy === '1'), onclick: () => go(state, { yoy: state.yoy === '1' ? '0' : '1' }) }, '전년 동월 비교'),
          el('button', { type: 'button', class: 'tv-chip', 'aria-pressed': String(state.view === 'table'), onclick: () => go(state, { view: state.view === 'table' ? 'chart' : 'table' }) }, '표로 보기'),
          el('a', { class: 'tv-chip', href: csv, download: '' }, 'CSV 받기'))),
      state.view === 'table' ? seriesTable(data) : el('div', {}, legend(state), trendChart(data, state))));

    const nl = data.children;
    const nextName = { 4: '품목군', 6: '세부 품목', 10: '최종 품목' }[(data.hs.length < 4 ? 4 : data.hs.length < 6 ? 6 : data.hs.length < 10 ? 10 : 0)];
    const cols = el('div', { class: 'tv-cols' },
      nl.length ? rankList(`구성 — ${nextName}별`, '선택한 품목을 빠짐없이 나눈 구성입니다(합계 100%). 이름을 누르면 한 단계 더 들어갑니다.', foldSmall(nl, 'item'), (r) => href(state, { hs: r.code }))
        : el('section', { class: 'tv-card' }, el('h3', {}, '구성'), el('p', { class: 'tv-muted' }, '가장 세부 단계의 품목입니다.')),
      rankList(`${state.flow === 'exp' ? '수출 상대국' : '수입 원산지'} 비중`,
        data.countryScope !== data.hs ? '국가별 통계는 세부 품목(HS 6자리) 단위까지만 제공되어 상위 세부 품목 기준입니다.' : (data.countryCoverage && (data.countryCoverage.from > data.from || data.countryCoverage.to < data.to) ? `국가별 자료는 ${ym(data.countryCoverage.from)}~${ym(data.countryCoverage.to)}만 포함합니다.` : '선택 기간 기준.'),
        foldSmall(data.countries), null));
    root.append(cols, el('p', { class: 'tv-source' }, '출처: 관세청 수출입무역통계(공공데이터포털). 최근 월은 잠정치이며, 자세한 기준은 위 "무역통계 운영 방침"에 있습니다.'));
    commit();
  }

  window.TradeDashboard = { render };
})();
