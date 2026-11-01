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
    // the sign leads (−$2.6M, −149,193톤); the magnitude counts, so an animation never shows a misplaced minus
    const sign = v < 0 ? '−' : ''; const a = Math.abs(v);
    const parts = kind === 'ton' ? [sign, (x) => nf(Math.abs(x)), '톤'] : kind === 'price' ? [`${sign}$`, (x) => nf(Math.abs(x)), '/톤']
      : a >= 1e6 ? [`${sign}$`, (x) => nf(Math.abs(x) / 1e6, 1), 'M'] : [`${sign}$`, (x) => nf(Math.abs(x) / 1e3), 'K'];
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
  const signed = (v, unit) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf(Math.abs(v))}${unit}`);
  const fmtSigned = { ton: (v) => signed(v, '톤'), usd: (v) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtUsd(Math.abs(v))}`), price: fmtPrice };
  const compactTon = (v) => (v == null ? '–' : Math.abs(v) >= 10000 ? `${nf(v / 10000, 1)}만 톤` : `${nf(v)}톤`);
  const pc = (a, b) => (a == null || b == null || b === 0 || a * b < 0 ? null : (a - b) / Math.abs(b));

  // Month → quarter / year buckets. A bucket missing months (range edge, not yet published) is flagged partial, and its year-over-year
  // compares the same months only (each month already carries its own prior-year value), so it is still like-for-like.
  function aggregate(series, grain, net) {
    if (grain === 'month') return series.map((p) => ({ ...p, key: p.period, months: p.ton == null ? 0 : 1, expected: 1, partial: false }));
    const keyOf = (p) => (grain === 'year' ? p.period.slice(0, 4) : `${p.period.slice(0, 4)}Q${Math.ceil(Number(p.period.slice(4)) / 3)}`);
    const add = (a, b) => (b == null ? a : (a || 0) + b);
    const map = new Map();
    for (const p of series) {
      const k = keyOf(p);
      const b = map.get(k) || { key: k, period: p.period, ton: null, usd: null, prevTon: null, prevUsd: null, months: 0, expected: grain === 'year' ? 12 : 3 };
      b.ton = add(b.ton, p.ton); b.usd = add(b.usd, p.usd); b.prevTon = add(b.prevTon, p.prevTon); b.prevUsd = add(b.prevUsd, p.prevUsd);
      if (p.ton != null) b.months += 1;
      map.set(k, b);
    }
    return [...map.values()].map((b) => {
      const price = !net && b.ton ? b.usd / b.ton : null; const prevPrice = !net && b.prevTon ? b.prevUsd / b.prevTon : null;
      return { ...b, price, prevPrice, yoyTon: pc(b.ton, b.prevTon), yoyUsd: pc(b.usd, b.prevUsd), yoyPrice: pc(price, prevPrice), partial: b.months > 0 && b.months < b.expected };
    });
  }
  const bucketLabel = (b, grain, long) => (grain === 'year' ? b.key : grain === 'quarter' ? `${long ? b.key.slice(0, 4) : `'${b.key.slice(2, 4)}`} ${b.key.slice(4)}` : long ? ym(b.key) : null);

  const addMonths = (period, n) => { const y = Number(period.slice(0, 4)); const m = Number(period.slice(4)) - 1 + n; return `${y + Math.floor(m / 12)}${String(((m % 12) + 12) % 12 + 1).padStart(2, '0')}`; };

  // ---- state in the URL ----
  const keep = (q) => {
    const flow = q.mode === 'pair' ? 'pair' : ['imp', 'exp', 'net'].includes(q.flow) ? q.flow : 'imp';
    const metric = ['ton', 'usd', 'price'].includes(q.metric) && !(flow === 'net' && q.metric === 'price') ? q.metric : 'ton'; // no unit price of a balance
    const pair = q.mode === 'pair';
    return { mode: pair ? 'pair' : 'kr', ex: /^\d{1,4}$/.test(q.ex || '') ? q.ex : '360', im: /^\d{1,4}$/.test(q.im || '') ? q.im : '699', hs: q.hs || '15', country: /^[A-Z]{2}$/.test(q.country || '') ? q.country : '', from: q.from || '', to: q.to || '', flow, metric, grain: ['month', 'quarter', 'year'].includes(q.grain) ? q.grain : 'month', yoy: q.yoy === '0' ? '0' : '1', view: q.view === 'table' ? 'table' : 'chart' };
  };
  const FLOW_NAME = { imp: '수입', exp: '수출', net: '순수출', pair: '교역' };
  const GRAIN_NAME = { month: '월별', quarter: '분기별', year: '연도별' };
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
    for (const [value, text, disabledWhy] of options) {
      wrap.append(el('button', { type: 'button', class: value === current ? 'is-on' : '', 'aria-pressed': String(value === current), disabled: Boolean(disabledWhy), title: disabledWhy || null, onclick: () => onPick(value) }, text));
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

  // Browse without knowing any code: a two-pane popover — plain-language groups on the left, the group's items on the right with their
  // last-12-month import volume, a 12-month import trail and a net-exporter mark. Arrow keys move between groups; Esc or a click outside closes.
  function sparkline(trail) {
    const vals = (trail || []).map((v) => (v == null ? null : Number(v)));
    const fin = vals.filter((v) => v != null);
    if (fin.length < 2) return el('span', { class: 'tv-spark tv-spark-empty', 'aria-hidden': 'true' });
    const W = 72; const H = 22; const max = Math.max(...fin) || 1; const min = Math.min(...fin);
    const xs = (i) => (i / (vals.length - 1)) * W; const ys = (v) => H - 2 - ((v - min) / (max - min || 1)) * (H - 4);
    const pts = vals.map((v, i) => (v == null ? null : `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`)).filter(Boolean).join(' ');
    const last = vals.length - 1 - [...vals].reverse().findIndex((v) => v != null);
    return sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tv-spark', 'aria-hidden': 'true' }, sv('polyline', { points: pts, fill: 'none' }), sv('circle', { cx: xs(last), cy: ys(vals[last]), r: 2 }));
  }
  function groupItems(g, state) {
    return el('ul', { class: 'tv-browse-items' }, g.items.map((it) => el('li', {},
      el('a', { href: href(state, { hs: it.code }), class: state.hs === it.code || state.hs.startsWith(it.code) ? 'is-on' : '' },
        el('span', { class: 'tv-bi-top' }, el('span', { class: 'tv-bi-name' }, it.name), it.expTon > it.impTon && it.expTon > 0 ? el('span', { class: 'tv-side' }, '순수출') : null),
        el('span', { class: 'tv-bi-bottom' }, el('span', { class: 'tv-bi-vol' }, it.impTon == null ? '자료 없음' : `수입 ${compactTon(it.impTon)}`), sparkline(it.trail))))));
  }
  async function browsePanel(state) {
    const box = el('details', { class: 'tv-browse' }, el('summary', {}, '품목 둘러보기'));
    const summary = box.firstChild;
    let built = false;
    const onDoc = (e) => { if (!box.contains(e.target)) box.open = false; };
    const onKey = (e) => { if (e.key === 'Escape') { box.open = false; summary.focus(); } };
    box.addEventListener('toggle', async () => {
      if (!box.open) { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); return; }
      document.addEventListener('pointerdown', onDoc); document.addEventListener('keydown', onKey);
      if (built) return;
      built = true;
      const panel = el('div', { class: 'tv-browse-panel' }, el('p', { class: 'tv-muted tv-browse-loading' }, '품목을 불러오는 중…'));
      box.append(panel);
      let res; try { res = await api('/trade/groups'); } catch (_) { res = null; }
      const groups = (res && res.groups) || [];
      if (!groups.length) { panel.replaceChildren(el('p', { class: 'tv-muted' }, '목록을 불러오지 못했습니다.')); return; }
      const nav = el('div', { class: 'tv-browse-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': '품목 분류' });
      const body = el('div', { class: 'tv-browse-body', role: 'tabpanel' });
      const select = (gi, focus) => {
        [...nav.children].forEach((b, k) => { b.setAttribute('aria-selected', String(k === gi)); b.tabIndex = k === gi ? 0 : -1; });
        body.replaceChildren(el('h4', {}, groups[gi].name), groupItems(groups[gi], state));
        if (focus) nav.children[gi].focus();
      };
      groups.forEach((g, gi) => nav.append(el('button', {
        type: 'button', role: 'tab', onclick: () => select(gi),
        onkeydown: (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); select((gi + (e.key === 'ArrowDown' ? 1 : -1) + groups.length) % groups.length, true); } },
      }, el('span', {}, g.name), el('span', { class: 'tv-browse-count' }, String(g.items.length)))));
      const start = Math.max(0, groups.findIndex((g) => g.items.some((it) => state.hs.startsWith(it.code))));
      panel.replaceChildren(nav, body, el('p', { class: 'tv-browse-foot' }, `수입량·추세선은 최근 12개월 기준${res.through ? ` (${ym(res.through)}까지)` : ''} · "순수출"은 수출이 수입보다 많은 품목`));
      select(start);
    });
    return box;
  }

  function modeSwitch(state) {
    const about = state.mode === 'pair' ? '전 세계 국가 사이의 교역 · HS 6자리까지 · 신고 시점이 늦을 수 있음' : '한국의 수출입 · HS 10자리까지 · 월별 · 상대국별 상세';
    return el('div', { class: 'tv-row tv-modes' }, segmented('자료 출처', [['kr', '관세청'], ['pair', 'UN Comtrade']], state.mode, (v) => go(state, { mode: v, flow: v === 'pair' ? 'pair' : 'imp', country: '' })),
      el('span', { class: 'tv-hint' }, about));
  }

  // Two-country mode: exporter and importer from the fixed country list (native selects), with a swap button.
  function pairPickers(state, countries) {
    const opt = (c, cur) => el('option', { value: String(c.code), selected: String(c.code) === cur || null }, c.name);
    const all = { code: 0, name: '전체 국가' };
    // choosing the other side's value swaps them; "전체 국가" on both sides is refused by moving the other side back to what this one had
    const pick = (label, key, other) => el('label', { class: 'tv-seg tv-partner' }, el('span', { class: 'tv-label' }, label),
      el('select', { class: 'tv-select', 'aria-label': label, onchange: (e) => {
        const v = e.target.value;
        go(state, { [key]: v, ...((v === state[other] || (v === '0' && state[other] === '0')) ? { [other]: state[key] === '0' ? (key === 'ex' ? '360' : '699') : state[key] } : {}) });
      } }, [opt(all, state[key]), ...countries.map((c) => opt(c, state[key]))]));
    return el('div', { class: 'tv-row tv-pair-row' }, pick('수출국', 'ex', 'im'),
      el('button', { type: 'button', class: 'tv-swap', 'aria-label': '수출국과 수입국 바꾸기', title: '수출국과 수입국 바꾸기', onclick: () => go(state, { ex: state.im, im: state.ex }) }, '⇄'),
      pick('수입국', 'im', 'ex'));
  }

  // Partner country: a native select (keyboard and screen-reader friendly, like the other tabs' filters), largest partners first.
  function partnerPicker(state, partners) {
    const sel = el('select', { class: 'tv-select', 'aria-label': '상대국', onchange: (e) => go(state, { country: e.target.value }) },
      el('option', { value: '' }, '전체 국가'),
      partners.map((p) => el('option', { value: p.code, selected: p.code === state.country || null }, `${p.name}${p.impTon >= 1 || p.expTon >= 1 ? ` · ${p.impTon >= p.expTon ? `수입 ${compactTon(p.impTon)}` : `수출 ${compactTon(p.expTon)}`}` : ''}`)));
    if (state.country && !partners.some((p) => p.code === state.country)) sel.append(el('option', { value: state.country, selected: true }, state.country));
    return el('label', { class: 'tv-seg tv-partner' }, el('span', { class: 'tv-label' }, '상대국'), sel);
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
  function absDelta(v, unitFmt) {
    if (v == null) return el('span', { class: 'tv-delta' }, '–');
    const dir = v > 0 ? '▲' : v < 0 ? '▼' : '■';
    return el('span', { class: 'tv-delta' }, el('span', { class: 'tv-arrow', 'aria-hidden': 'true' }, dir), unitFmt(v));
  }
  function tile(label, value, sub) { return el('div', { class: 'tv-tile' }, el('div', { class: 'tv-tile-label' }, label), el('div', { class: 'tv-tile-value' }, value), sub ? el('div', { class: 'tv-tile-sub' }, sub) : null); }

  function kpiStrip(data, state) {
    const k = data.kpis; const m = state.metric; const net = state.flow === 'net'; const flowName = FLOW_NAME[state.flow];
    if (!k) return el('p', { class: 'tv-muted' }, '선택한 기간에 데이터가 없습니다.');
    const cur = { ton: k.ton, usd: k.usd, price: k.price }[m];
    const t12 = k.t12;
    const i = data.series.findIndex((p) => p.period === k.period);
    const prevMonth = i > 0 ? valueOf(data.series[i - 1], m) : null;
    const sameMonthLastYear = i >= 0 ? valueOf(data.series[i], m, true) : null;
    const fmtD = (v) => (m === 'usd' ? fmtSigned.usd(v) : signed(v, m === 'price' ? '$/톤' : '톤'));
    // for a balance the change is shown in tons/dollars: a % change of a number that can cross zero misleads
    const dYoY = net ? absDelta(cur != null && sameMonthLastYear != null ? cur - sameMonthLastYear : null, fmtD) : delta(pc(cur, sameMonthLastYear));
    const dMoM = net ? absDelta(cur != null && prevMonth != null ? cur - prevMonth : null, fmtD) : delta(pc(cur, prevMonth));
    const side = (v) => (net && v != null ? el('span', { class: 'tv-side' }, v >= 0 ? '순수출' : '순수입') : null);
    const tiles = [
      tile(el('span', {}, `${ym(k.period)} ${flowName} ${METRICS[m][0]} `, side(cur)), figure('cur', m, cur),
        el('span', { class: 'tv-subs' }, el('span', {}, '전년 동월 ', dYoY), el('span', {}, '전월 ', dMoM))),
      tile(el('span', {}, `최근 12개월 ${flowName}${net ? ' 물량' : '량'} `, side(t12 && t12.ton)), figure('t12', 'ton', t12 ? t12.ton : null),
        t12 ? el('span', {}, '직전 12개월 대비 ', net ? absDelta(t12.prevTon != null ? t12.ton - t12.prevTon : null, (v) => signed(v, '톤')) : delta(t12.changeTon))
          : el('span', { class: 'tv-muted' }, '12개월치 자료가 쌓이면 표시됩니다')),
      net ? tile(el('span', {}, '최근 12개월 순수출액 ', side(t12 && t12.usd)), figure('t12u', 'usd', t12 ? t12.usd : null), el('span', { class: 'tv-muted' }, '수출액 − 수입액'))
        : tile('최근 12개월 평균 단가', figure('t12p', 'price', t12 ? t12.price : null), el('span', { class: 'tv-muted' }, '금액 ÷ 중량')),
    ];
    return el('div', { class: 'tv-tiles' }, tiles);
  }

  // The main chart over month / quarter / year buckets. Bars (or a line for long ranges and unit prices) start at zero and go below it for a
  // net-import balance, in the second hue so the sign never rests on position alone; partial buckets are drawn lighter and say so on hover.
  function trendChart(data, state, pts) {
    const m = state.metric; const net = state.flow === 'net'; const grain = state.grain;
    const avail = (document.getElementById('app') || document.body).clientWidth - 76;
    const W = Math.round(Math.max(300, Math.min(1080, avail))); const H = W < 560 ? 200 : 240; const L = W < 560 ? 48 : 62; const R = 8; const T = 10; const B = 26;
    const bars = [];
    const vals = pts.map((p) => valueOf(p, m)); const prevs = state.yoy === '1' ? pts.map((p) => valueOf(p, m, true)) : [];
    const finite = [...vals, ...prevs].filter((v) => v != null);
    const wrap = el('div', { class: 'tv-chartwrap' });
    if (!finite.length) { wrap.append(el('p', { class: 'tv-muted' }, '표시할 데이터가 없습니다.')); return wrap; }
    const niceStep = (v) => { const e = 10 ** Math.floor(Math.log10(v || 1)); const n = v / e; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * e; };
    const hi = Math.max(0, ...finite); const lo = Math.min(0, ...finite);
    const tick = niceStep((hi - lo) / 4 || 1); const top = Math.ceil(hi / tick) * tick || tick; const bottom = Math.floor(lo / tick) * tick;
    const step = (W - L - R) / pts.length; const x = (i) => L + step * (i + 0.5); const y = (v) => T + (H - T - B) * ((top - v) / (top - bottom));
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tv-svg', role: 'img', 'aria-label': `${data.name || data.hs} ${FLOW_NAME[state.flow]} ${METRICS[m][0]} ${GRAIN_NAME[grain]} 추이` });
    const axisFmt = (v) => (m === 'usd' ? (v < 0 ? `−${fmtUsd(-v)}` : fmtUsd(v)) : Math.abs(v) >= 10000 && W < 560 ? `${nf(v / 1000)}k` : nf(v));
    for (let v = bottom; v <= top + tick / 2; v += tick) {
      const yy = y(v);
      svg.append(sv('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: Math.abs(v) < tick / 2 ? 'tv-grid tv-zero' : 'tv-grid' }), sv('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', class: 'tv-axis' }, axisFmt(v)));
    }
    const k = Math.max(1, Math.ceil(pts.length / Math.max(3, Math.floor((W - L - R) / (grain === 'month' ? 64 : 56)))));
    pts.forEach((p, i) => {
      if ((pts.length - 1 - i) % k !== 0) return;
      let text = bucketLabel(p, grain, false);
      if (grain === 'month') {
        const withYear = i < k || p.period.endsWith('01') || pts.slice(Math.max(0, i - k + 1), i).some((q) => q.period.endsWith('01'));
        text = withYear ? `${p.period.slice(2, 4)}.${p.period.slice(4)}` : p.period.slice(4);
      }
      svg.append(sv('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'tv-axis' }, text));
    });
    const path = (arr) => arr.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
    if (m === 'price' || pts.length > 60) {
      if (prevs.length) svg.append(sv('polyline', { points: path(prevs).join(' '), class: 'tv-line-prev', fill: 'none' }));
      // drawn once per half: above the zero line in the series hue, below it in the net-import hue, so the area and the line change color where they cross
      const halves = net && m !== 'price' ? [['pos', T, y(0), ''], ['neg', y(0), H - B, ' tv-neg']] : [['all', T, H - B, '']];
      const uid = `tvclip${Math.random().toString(36).slice(2, 7)}`;
      const defs = sv('defs');
      halves.forEach(([id, y1, y2]) => defs.append(sv('clipPath', { id: `${uid}${id}` }, sv('rect', { x: 0, y: y1, width: W, height: Math.max(0, y2 - y1) }))));
      svg.append(defs);
      const first = vals.findIndex((v) => v != null); const last = vals.length - 1 - [...vals].reverse().findIndex((v) => v != null);
      halves.forEach(([id, , , neg]) => {
        const g = sv('g', { 'clip-path': `url(#${uid}${id})`, class: neg.trim() });
        if (m !== 'price' && first >= 0) g.append(sv('polygon', { points: `${x(first)},${y(0)} ${path(vals).join(' ')} ${x(last)},${y(0)}`, class: 'tv-area' }));
        g.append(sv('polyline', { points: path(vals).join(' '), class: 'tv-line', fill: 'none', pathLength: '1' }));
        svg.append(g);
      });
      vals.forEach((v, i) => { if (v != null && pts.length <= 40) svg.append(sv('circle', { cx: x(i), cy: y(v), r: 3, class: `tv-dot${net && v < 0 ? ' tv-dot-neg' : ''}${pts[i].partial ? ' is-partial' : ''}` })); });
    } else {
      const bw = Math.max(3, Math.min(grain === 'month' ? 20 : 36, step * 0.5));
      vals.forEach((v, i) => {
        if (v == null) return;
        const h = Math.max(1, Math.abs(y(0) - y(v))); const r = Math.min(3, bw / 2, h); const x0 = x(i) - bw / 2; const y0 = y(0);
        const d = v >= 0 // rounded data end, flat on the zero line, either direction
          ? `M${x0},${y0} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z`
          : `M${x0},${y0} v${h - r} q0,${r} ${r},${r} h${bw - 2 * r} q${r},0 ${r},${-r} v${-(h - r)} z`;
        bars[i] = sv('path', { d, class: `tv-bar${v < 0 ? ' tv-bar-neg' : ''}${pts[i].partial ? ' is-partial' : ''}`, style: `--d:${Math.min(i * 14, 420)}ms` });
        svg.append(bars[i]);
      });
      if (prevs.length) svg.append(sv('polyline', { points: path(prevs).join(' '), class: 'tv-line-prev', fill: 'none' }));
    }
    const cross = sv('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'tv-cross' });
    const hit = sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: '0', 'aria-label': '기간별 값 보기: 방향키로 이동' });
    svg.append(cross, hit);
    const tip = el('div', { class: 'tv-tip', role: 'status' });
    const fmtV = net ? fmtSigned[m] : fmtOf[m];
    const show = (i) => {
      const p = pts[i]; if (!p) return;
      cross.style.transform = `translateX(${x(i)}px)`; svg.classList.add('is-hover');
      bars.forEach((b, j) => b && b.classList.toggle('is-active', j === i));
      const v = valueOf(p, m); const pv = valueOf(p, m, true);
      tip.textContent = '';
      tip.append(el('div', { class: 'tv-tip-h' }, bucketLabel(p, grain, true) || ym(p.period), p.partial ? el('span', { class: 'tv-tip-note' }, ` ${p.months}개월 집계`) : null),
        el('div', { class: 'tv-tip-r' }, el('i', { class: `tv-key${net && v < 0 ? ' tv-key-neg' : ''}` }), el('b', {}, fmtV(v)), ' ', net && v != null ? (v >= 0 ? '순수출' : '순수입') : METRICS[m][0]),
        state.yoy === '1' ? el('div', { class: 'tv-tip-r tv-muted' }, el('i', { class: 'tv-key tv-key-prev' }), fmtV(pv), grain === 'year' ? ' 전년' : ' 전년 동기') : null,
        el('div', { class: 'tv-tip-r tv-muted' }, net ? `전년 대비 ${v != null && pv != null ? fmtV(v - pv) : '–'}` : `전년 대비 ${fmtPct(yoyOf(p, m))}`));
      const rect = svg.getBoundingClientRect(); const px = (x(i) / W) * rect.width;
      const left = px + 14 + 180 > rect.width ? px - 14 - 180 : px + 14;
      tip.style.transform = `translateX(${Math.max(0, left)}px)`; tip.classList.add('is-on');
    };
    const idxAt = (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; return Math.max(0, Math.min(pts.length - 1, Math.floor((px - L) / step))); };
    let cur = pts.length - 1;
    const hide = () => { svg.classList.remove('is-hover'); tip.classList.remove('is-on'); };
    hit.addEventListener('pointermove', (e) => { cur = idxAt(e); show(cur); });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') cur = Math.max(0, cur - 1); else if (e.key === 'ArrowRight') cur = Math.min(pts.length - 1, cur + 1); else return; e.preventDefault(); show(cur); });
    hit.addEventListener('blur', hide);
    wrap.append(svg, tip);
    return wrap;
  }

  function legend(state) {
    const net = state.flow === 'net';
    const items = [];
    if (net) items.push(el('span', { class: 'tv-legend-i' }, el('i', { class: 'tv-key' }), '순수출(＋)'), el('span', { class: 'tv-legend-i' }, el('i', { class: 'tv-key tv-key-neg' }), '순수입(−)'));
    else if (state.yoy === '1') items.push(el('span', { class: 'tv-legend-i' }, el('i', { class: 'tv-key' }), `${METRICS[state.metric][0]} (${METRICS[state.metric][1]})`));
    if (state.yoy === '1') items.push(el('span', { class: 'tv-legend-i' }, el('i', { class: 'tv-key tv-key-prev' }), state.grain === 'year' ? '전년' : '전년 동기'));
    if (!items.length) return null; // one series: the card title names it
    return el('div', { class: 'tv-legend' }, items);
  }

  function seriesTable(pts, state) {
    const net = state.flow === 'net';
    const heads = [state.grain === 'month' ? '월' : state.grain === 'quarter' ? '분기' : '연도', `${net ? '순수출 ' : ''}물량(톤)`, `${net ? '순수출 ' : ''}금액(USD)`, ...(net ? [] : ['단가(USD/톤)']), net ? '물량 전년 대비(톤)' : '물량 전년비', ...(net ? [] : ['단가 전년비'])];
    const t = el('table', { class: 'tv-table' }, el('thead', {}, el('tr', {}, heads.map((h, i) => el('th', { scope: 'col', class: i ? 'tv-num' : '' }, h)))));
    const body = el('tbody');
    const n0 = (v) => (v == null ? '–' : net ? signed(v, '') : nf(v));
    for (const p of pts) {
      const cells = [n0(p.ton), n0(p.usd), ...(net ? [] : [p.price == null ? '–' : nf(p.price)]), net ? (p.ton != null && p.prevTon != null ? signed(p.ton - p.prevTon, '') : '–') : fmtPct(p.yoyTon), ...(net ? [] : [fmtPct(p.yoyPrice)])];
      body.append(el('tr', { class: p.partial ? 'is-partial' : null }, el('th', { scope: 'row' }, bucketLabel(p, state.grain, true) || ym(p.period), p.partial ? el('small', { class: 'tv-code' }, ` ${p.months}개월`) : null), cells.map((c) => el('td', { class: 'tv-num' }, c))));
    }
    t.append(body);
    return el('div', { class: 'tv-tablewrap' }, t);
  }

  // ranked list with an inline bar: the share is the number, the bar is only a visual aid
  function rankList(title, note, rows, linkFor, net = false) {
    const card = el('section', { class: 'tv-card' }, el('h3', {}, title), note ? el('p', { class: 'tv-muted tv-note' }, note) : null);
    if (!rows.length) { card.append(el('p', { class: 'tv-muted' }, '데이터가 없습니다.')); return card; }
    const top = Math.max(...rows.map((r) => r.share || 0)) || 1;
    const t = el('table', { class: 'tv-table tv-rank' }, el('thead', {}, el('tr', {}, ['', '비중', net ? '순수출(톤)' : '물량(톤)'].map((h, i) => el('th', { scope: 'col', class: i ? 'tv-num' : '' }, h)))));
    const body = el('tbody');
    for (const r of rows) {
      const label = linkFor && r.code ? el('a', { href: linkFor(r) }, r.name || '이름 없는 품목', ' ', el('small', { class: 'tv-code' }, r.code)) : el('span', { class: r.code ? '' : 'tv-muted' }, r.name || r.code);
      body.append(el('tr', { class: r.selected ? 'is-selected' : null }, el('th', { scope: 'row' }, label, el('span', { class: 'tv-bar-track' }, el('span', { class: `tv-bar-fill${net && r.ton < 0 ? ' tv-bar-fill-neg' : ''}`, style: `width:${Math.max(1, ((r.share || 0) / top) * 100)}%` }))), el('td', { class: 'tv-num' }, r.share == null ? '–' : `${(r.share * 100).toFixed(1)}%`), el('td', { class: 'tv-num' }, net ? signed(r.ton, '') : nf(r.ton))));
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
      ['집계 단위', '관세청은 월 단위로 공표하므로 기본은 월별이고, 분기·연도별은 그 달들의 합계입니다. 일별 자료는 공표되지 않아 제공하지 않습니다. 자료가 다 차지 않은 분기·연도는 옅게 표시하고 몇 개월 합계인지 함께 보여 줍니다.'],
      ['순수출', '순수출 = 수출 − 수입(같은 품목·같은 기간)입니다. ＋면 수출이 많은 순수출, −면 수입이 많은 순수입이며, 부호가 바뀔 수 있어 증감은 %가 아니라 톤·달러 차이로 보여 줍니다. 차이 값의 단가는 의미가 없어 계산하지 않습니다.'],
      ['단위와 계산', '중량은 톤(공표 kg ÷ 1,000), 금액은 미 달러입니다. 단가는 금액 ÷ 중량으로 이 화면에서 계산한 값으로, 품질·조건이 다른 품목이 섞이면 실제 거래가와 다를 수 있습니다.'],
      ['품목 분류', '가장 세부 단위(HS 10자리)로 저장하고 상위 분류는 합계로 계산합니다. 그래서 하위 품목을 모두 더하면 상위 품목과 정확히 같습니다. 국가별 통계는 관세청이 HS 6자리까지만 제공하므로 그보다 세부 품목을 고르면 상위 6자리 기준으로 보여 줍니다.'],
      ['조회 기간', `${bounds ? `현재 ${ym(bounds.min)}부터 ${ym(bounds.max)}까지 조회할 수 있습니다. ` : ''}적재를 시작한 달부터 매월 한 달씩 늘어나며, 기간 입력은 이 범위 안에서만 고를 수 있습니다. 범위를 벗어나거나 시작·종료가 바뀐 주소로 열면 자동으로 범위 안으로 맞추고 그 사실을 화면에 알립니다.`],
      ['장애 시', '화면은 플랫폼 데이터베이스에 저장된 값만 읽습니다. 관세청 API에 장애가 있어도 마지막으로 받은 값은 그대로 보이며, 동기화 실패는 운영 알림으로 확인합니다.'],
      ['UN Comtrade', 'UN Comtrade(유엔 공공 무역통계)로 한국이 끼지 않는 교역도 볼 수 있습니다. 수출국과 수입국을 각각 고르며, 한쪽을 "전체 국가"로 두면 그 나라의 총 수출(또는 총 수입)을 모든 상대국 합계로 봅니다. 두 나라를 모두 고르면 수출국이 신고한 수출 통계를 먼저 쓰고, 신고가 없을 때만 수입국이 신고한 수입 통계로 대체하며 어느 쪽인지 화면에 표시합니다(총량은 그 나라 자신의 신고만 씁니다). 수출은 FOB, 수입은 CIF 기준이라 두 값이 다를 수 있습니다. 처음 조회하는 조합은 그때 받아 저장하므로 첫 로딩이 느리고, 국가별 신고가 늦어 최근 몇 달은 비어 있을 수 있습니다. HS 6자리까지 지원합니다.'],
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
    const pairMode = state.mode === 'pair';
    const prev = app.querySelector('.tv-root');
    const policyWasOpen = Boolean(prev && prev.querySelector('.tv-policy[open]'));
    if (prev) { prev.classList.add('is-updating'); prev.setAttribute('aria-busy', 'true'); } else { app.textContent = ''; app.append(el('section', { class: 'tv-root' }, skeleton())); }
    const qs = new URLSearchParams({ hs: state.hs, flow: state.flow }); if (state.from) qs.set('from', state.from); if (state.to) qs.set('to', state.to);
    if (state.country) qs.set('country', state.country);
    let data; let partners; let countryList = [];
    try {
      if (pairMode) {
        const pq = new URLSearchParams({ hs: state.hs, ex: state.ex, im: state.im }); if (state.from) pq.set('from', state.from); if (state.to) pq.set('to', state.to);
        const [d, c] = await Promise.all([api(`/trade/pair?${pq}`), api('/trade/countries-list').catch(() => ({ countries: [] }))]);
        data = d; countryList = (c && c.countries) || [];
      } else {
        [data, partners] = await Promise.all([api(`/trade/dashboard?${qs}`), api(`/trade/partners?hs=${state.hs}`).catch(() => ({ partners: [] }))]);
      }
    } catch (_) { data = { error: 'network' }; }
    partners = (partners && partners.partners) || [];
    const root = el('section', { class: `tv-root ${prev && prev.classList.contains('tv-root') && prev.querySelector('.tv-tiles, .tv-filters') ? 'is-swap' : 'is-enter'}` });
    // built off-page and swapped in whole: attaching it empty would shorten the page and lose the scroll position
    const commit = () => app.replaceChildren(root);
    root.append(el('div', { class: 'tv-head' }, el('h1', {}, '무역통계'), el('p', { class: 'page-lede' }, '유지·원료 품목의 월별 수출입 물량과 가격, 주요 상대국을 확인합니다. 품목은 이름으로 찾고 기간과 지표를 골라 보세요.'), policySection(data && data.bounds, policyWasOpen)));
    if (data.empty) { root.append(el('p', { class: 'tv-muted' }, '아직 적재된 데이터가 없습니다. 첫 동기화 후 표시됩니다.')); commit(); return; }
    if (pairMode && data.disabled) { root.append(el('div', { class: 'tv-filters' }, modeSwitch(state)), el('p', { class: 'tv-muted' }, '두 나라 조회는 UN Comtrade 인증 키(UN_CONTRADE)가 설정되면 사용할 수 있습니다.')); commit(); return; }
    if (pairMode && data.scope) FLOW_NAME.pair = { exporter_total: '수출', importer_total: '수입' }[data.scope] || '교역'; // tiles and chart titles say 수출/수입/교역
    if (data.error) { root.append(el('p', { class: 'tv-muted' }, data.error === 'invalid_hs' ? 'HS코드는 2·4·6·8·10자리 숫자여야 합니다.' : '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')); commit(); return; }

    root.append(el('div', { class: 'tv-filters' },
      modeSwitch(state),
      el('div', { class: 'tv-row tv-row-search' }, searchBox(state), await browsePanel(state)),
      pairMode ? pairPickers(state, countryList) : null,
      breadcrumb(data, state),
      el('div', { class: 'tv-row' }, periodControls(data, state)),
      el('div', { class: 'tv-row tv-switches' },
        pairMode ? null : segmented('구분', [['imp', '수입'], ['exp', '수출'], ['net', '순수출']], state.flow, (v) => go(state, { flow: v })),
        segmented('지표', [['ton', '물량'], ['usd', '금액'], ['price', '단가', state.flow === 'net' ? '순수출(수출−수입)에는 단가를 계산하지 않습니다' : null]], state.metric, (v) => go(state, { metric: v })),
        pairMode ? null : partnerPicker(state, partners))));
    if (data.adjusted && data.adjusted.length) root.append(el('p', { class: 'tv-notice', role: 'status' }, `${data.adjusted.map((a) => ADJUST_TEXT[a] || a).join(' · ')}.`));

    root.append(el('div', { class: 'tv-selected' }, el('h3', {}, data.name || '이름 없는 품목'), el('span', { class: 'tv-badge' }, LEVEL_LABEL[data.hs.length] || ''), el('span', { class: 'tv-code' }, `HS ${data.hs}`),
      pairMode ? el('span', { class: 'tv-route' }, data.exporter.name, el('span', { class: 'tv-route-arrow', 'aria-hidden': 'true' }, '→'), data.importer.name) : null,
      data.country ? el('a', { class: 'tv-country-chip', href: href(state, { country: '' }), title: '전체 국가로 돌아가기' }, el('span', { class: 'tv-muted' }, '상대국 '), data.countryName || data.country, el('span', { class: 'tv-x', 'aria-hidden': 'true' }, '×'), el('span', { class: 'tv-sr' }, ' 해제')) : null));
    if (pairMode) {
      const ex = data.exporter.name; const im = data.importer.name;
      const src = data.scope === 'exporter_total' ? `${ex}가 신고한 전체 수출(모든 상대국 합계)`
        : data.scope === 'importer_total' ? `${im}가 신고한 전체 수입(모든 상대국 합계)`
          : data.source === 'importer_report' ? `${im}가 신고한 수입 통계(${ex}의 수출 신고가 없어 대체)` : `${ex}가 신고한 수출 통계`;
      const none = data.scope === 'pair' ? '선택한 기간에 두 나라의 신고 자료가 없습니다.' : `선택한 기간에 ${data.scope === 'exporter_total' ? ex : im}의 신고 자료가 없습니다.`;
      root.append(el('p', { class: 'tv-context' }, data.source === 'none' ? none : `${src} 기준입니다.${data.seriesHs !== data.hs ? ` UN Comtrade는 HS 6자리까지 지원하여 상위 품목 HS ${data.seriesHs} 기준으로 보여 줍니다.` : ''}`));
      if (data.incomplete) root.append(el('p', { class: 'tv-notice', role: 'status' }, data.apiError ? `UN Comtrade에서 일부 기간을 받지 못했습니다(${data.apiError.code}). 받은 기간까지만 표시하며, 잠시 후 다시 열면 이어서 받습니다.` : '처음 조회하는 조합이라 일부 기간을 아직 받는 중입니다. 잠시 후 다시 열면 나머지가 채워집니다.'));
    }
    if (data.country) {
      const what = { imp: `${data.countryName}에서 들여온 수입`, exp: `${data.countryName}(으)로 보낸 수출`, net: `${data.countryName}와(과)의 수출 − 수입` }[state.flow];
      root.append(el('p', { class: 'tv-context' }, `${what} 기준입니다.${data.seriesHs !== data.hs ? ` 국가별 통계는 세부 품목(HS 6자리)까지 제공되어 상위 품목 HS ${data.seriesHs} 기준으로 보여 줍니다.` : ''}`));
    }
    root.append(kpiStrip(data, state));

    const csv = `/api/trade/export.csv?${qs}`;
    const net = state.flow === 'net';
    const pts = aggregate(data.series, state.grain, net);
    root.append(el('section', { class: 'tv-card' },
      el('div', { class: 'tv-card-h' }, el('h3', {}, `${GRAIN_NAME[state.grain]} ${FLOW_NAME[state.flow]} ${METRICS[state.metric][0]}`, ' ', el('small', { class: 'tv-code' }, `${ym(data.from)}–${ym(data.to)} · ${METRICS[state.metric][1]}`)),
        el('div', { class: 'tv-tools' },
          segmented('집계 단위', [['day', '일', '관세청 통계는 월 단위로만 공표되어 일별 자료는 없습니다'], ['month', '월'], ['quarter', '분기'], ['year', '연']], state.grain, (v) => go(state, { grain: v })),
          el('span', { class: 'tv-tools-sep', 'aria-hidden': 'true' }),
          el('button', { type: 'button', class: 'tv-chip', 'aria-pressed': String(state.yoy === '1'), onclick: () => go(state, { yoy: state.yoy === '1' ? '0' : '1' }) }, state.grain === 'year' ? '전년 비교' : '전년 동기 비교'),
          el('button', { type: 'button', class: 'tv-chip', 'aria-pressed': String(state.view === 'table'), onclick: () => go(state, { view: state.view === 'table' ? 'chart' : 'table' }) }, '표로 보기'),
          pairMode ? null : el('a', { class: 'tv-chip', href: csv, download: '' }, 'CSV 받기'))),
      state.view === 'table' ? seriesTable(pts, state) : el('div', {}, legend(state), trendChart(data, state, pts)),
      pts.some((p) => p.partial) ? el('p', { class: 'tv-note tv-muted' }, '옅은 막대는 자료가 다 차지 않은 기간(조회 범위의 앞뒤 또는 아직 공표 전)입니다. 전년 비교는 같은 달끼리만 합니다.') : null));

    if (pairMode) { root.append(el('p', { class: 'tv-source' }, '출처: UN Comtrade. 수출국이 신고한 수출은 FOB, 수입국이 신고한 수입은 CIF 기준이라 같은 교역도 두 값이 다를 수 있으며, 국가별 신고 시점에 따라 최근 월이 비어 있을 수 있습니다. 자세한 기준은 위 "무역통계 운영 방침"에 있습니다.')); commit(); return; }
    const nl = data.children;
    const nextName = { 4: '품목군', 6: '세부 품목', 10: '최종 품목' }[(data.hs.length < 4 ? 4 : data.hs.length < 6 ? 6 : data.hs.length < 10 ? 10 : 0)];
    const cols = el('div', { class: 'tv-cols' },
      nl.length ? rankList(`구성 — ${nextName}별`, net ? '하위 품목별 순수출(＋)·순수입(−)입니다. 비중은 무역수지 규모 기준이며, 이름을 누르면 한 단계 더 들어갑니다.' : '선택한 품목을 빠짐없이 나눈 구성입니다(합계 100%). 이름을 누르면 한 단계 더 들어갑니다.', foldSmall(nl, 'item'), (r) => href(state, { hs: r.code }), net)
        : el('section', { class: 'tv-card' }, el('h3', {}, '구성'), el('p', { class: 'tv-muted' }, data.country ? '국가별 통계는 세부 품목(HS 6자리)까지만 나눠 볼 수 있습니다.' : '가장 세부 단계의 품목입니다.')),
      rankList(net ? '상대국별 순수출' : `${state.flow === 'exp' ? '수출 상대국' : '수입 원산지'} 비중`,
        data.countryScope !== data.hs ? '국가별 통계는 세부 품목(HS 6자리) 단위까지만 제공되어 상위 세부 품목 기준입니다. 국가를 누르면 그 나라와의 교역만 봅니다.' : (data.countryCoverage && (data.countryCoverage.from > data.from || data.countryCoverage.to < data.to) ? `국가별 자료는 ${ym(data.countryCoverage.from)}~${ym(data.countryCoverage.to)}만 포함합니다. 국가를 누르면 그 나라와의 교역만 봅니다.` : '국가를 누르면 그 나라와의 교역만 봅니다.'),
        foldSmall(data.countries.map((c) => ({ ...c, selected: c.code === data.country }))), (r) => href(state, { country: r.code === data.country ? '' : r.code }), net));
    root.append(cols, el('p', { class: 'tv-source' }, '출처: 관세청 수출입무역통계(공공데이터포털). 최근 월은 잠정치이며, 자세한 기준은 위 "무역통계 운영 방침"에 있습니다.'));
    commit();
  }

  window.TradeDashboard = { render };
})();
