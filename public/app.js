const TYPE_CLASS = { '뉴스': 'news', '보고서': 'report', '통계': 'stat', '규제': 'reg' };
const app = document.getElementById('app');

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

function typeTag(t) {
  return `<span class="tag ${TYPE_CLASS[t] || ''}">${t}</span>`;
}

const { buildSectorMaps, sectorAncestryPath, buildColumns, getSectorCheckState, setSectorSelection } = SectorTree;
const { classifyEligibilityMatch } = EligibilityMatch;

function itemCard(item) {
  const sectors = (item.sectors || []).map((s) => s.name).join(', ');
  return `<div class="card" onclick="location.hash='#/detail/${item.id}'">
    ${item.thumbnail_url ? `<img src="${item.thumbnail_url}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:6px;margin-bottom:8px" onerror="this.remove()">` : ''}
    ${typeTag(item.type)}<span class="pill">${item.trust_grade || 'A'}</span>
    <h3>${item.title}</h3>
    <p>${item.summary || ''}</p>
    <div class="meta">${item.source_name || ''} · ${item.published_at || ''} · ${sectors}</div>
  </div>`;
}

async function renderArchive(query = {}) {
  const [sectors, usages, sources, items, ranking] = await Promise.all([
    api('/sectors'), api('/usages'), api('/sources'), api('/items?status=Published' + toQuery(query)),
    api('/picks/ranking').catch(() => []),
  ]);
  const failedSources = sources.filter((s) => s.last_error);
  const warning = failedSources.length
    ? `<div class="section" style="border:1px solid var(--reg);border-radius:8px;padding:12px;margin-bottom:16px;background:#fef2f2">
        <strong class="stale">수집 실패 경고</strong>
        <ul style="margin:8px 0 0;padding-left:18px">
          ${failedSources.map((s) => `<li>${s.name}: ${s.last_error} (${new Date(s.last_error_at).toLocaleString()})</li>`).join('')}
        </ul>
      </div>`
    : '';
  const latest = items.slice(0, 9);
  const usageOpts = usages.map((u) => `<option value="${u.id}" ${String(query.usage) === String(u.id) ? 'selected' : ''}>${u.name}</option>`).join('');
  const sourceOpts = sources.map((s) => `<option value="${s.id}" ${String(query.source_id) === String(s.id) ? 'selected' : ''}>${s.name}</option>`).join('');

  const { byParent, byId } = buildSectorMaps(sectors);
  const selectedSectorIds = new Set(
    (query.sector ? String(query.sector).split(',') : []).filter(Boolean).map(Number)
  );
  // Pre-open the branch leading to the first selected sector, if any, so it's visible on load.
  let activePath = selectedSectorIds.size
    ? sectorAncestryPath(byId, [...selectedSectorIds][0]).slice(0, -1)
    : [];

  const hasActiveFilters = Boolean(
    query.q || query.usage || query.type || query.source_id || query.from || query.to || selectedSectorIds.size
  );
  const emptyState = items.length
    ? ''
    : `<div class="archive-empty">
        <strong>결과가 없습니다</strong>
        ${hasActiveFilters ? '선택한 필터 조건에 맞는 자료가 아직 없습니다. 필터를 조정해보세요.' : '아직 발행된 자료가 없습니다.'}
      </div>`;

  app.innerHTML = `
    <h1>Research Archive</h1>
    ${warning}
    <div class="archive">
      <div class="archive-filter-panel">
        <div class="filters">
          <input id="f-q" placeholder="검색" value="${query.q || ''}">
          <select id="f-usage"><option value="">활용처 전체</option>${usageOpts}</select>
          <select id="f-type">
            <option value="">유형 전체</option>
            ${['뉴스', '보고서', '통계', '규제'].map((t) => `<option ${query.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <select id="f-source"><option value="">발행처 전체</option>${sourceOpts}</select>
          <input id="f-from" type="date" value="${query.from || ''}" title="시작일">
          <input id="f-to" type="date" value="${query.to || ''}" title="종료일">
          <button class="btn" id="f-clear">초기화</button>
          <button class="btn primary" id="f-apply">필터 적용</button>
        </div>
        <div class="archive-hierarchy">
          <div class="archive-hierarchy-title">섹터 (다중 선택 가능)</div>
          <div class="sector-tree" id="sector-tree"></div>
          <div class="archive-chip-row" id="sector-chips"></div>
        </div>
      </div>
      <h2>최신 자료</h2>
      <div class="grid">${latest.map(itemCard).join('') || '<p>발행된 자료가 없습니다.</p>'}</div>
      <h2 style="margin-top:28px">팀 Pick · 많이 본 자료</h2>
      <table><tr><th>제목</th><th>유형</th><th>Pick 수</th></tr>
        ${ranking.map((r) => `<tr><td><a href="#/detail/${r.id}">${r.title}</a></td><td>${r.type}</td><td>${r.pick_count}</td></tr>`).join('') || '<tr><td colspan="3">아직 팀 Pick이 없습니다.</td></tr>'}
      </table>
      <h2 style="margin-top:28px">전체 결과 (${items.length}개)</h2>
      ${emptyState}
      <div class="grid">${items.map(itemCard).join('')}</div>
    </div>
  `;

  const treeEl = document.getElementById('sector-tree');
  const chipsEl = document.getElementById('sector-chips');

  function renderChips() {
    const ids = [...selectedSectorIds];
    chipsEl.innerHTML = ids.length
      ? ids.map((id) => `<button type="button" class="chip active" data-remove-sector="${id}">${(byId.get(id) || {}).name || id} <span aria-hidden="true">✕</span></button>`).join('')
      : '<span class="chip-empty">선택된 섹터 없음</span>';
    chipsEl.querySelectorAll('[data-remove-sector]').forEach((el) => {
      el.onclick = () => {
        selectedSectorIds.delete(Number(el.dataset.removeSector));
        renderTree();
        renderChips();
      };
    });
  }

  function renderTree() {
    const columns = buildColumns(byParent, activePath);

    treeEl.innerHTML = columns.map((col) => `
      <div class="sector-col">
        ${col.nodes.map((s) => {
          const hasChildren = (byParent.get(s.id) || []).length > 0;
          const isActiveBranch = activePath[col.level] === s.id;
          const checkState = getSectorCheckState(byParent, s.id, selectedSectorIds);
          return `<div class="sector-node ${isActiveBranch ? 'active' : ''}">
            <label class="sector-node-check">
              <input type="checkbox" data-check="${s.id}" data-check-state="${checkState}" ${checkState === 'checked' ? 'checked' : ''} aria-label="${s.name} 필터로 선택 (하위 항목 포함)">
            </label>
            <button type="button" class="sector-node-label" data-nav="${s.id}" data-level="${col.level}">${s.name}</button>
            <span class="sector-node-arrow" aria-hidden="true">${hasChildren ? '›' : ''}</span>
          </div>`;
        }).join('')}
      </div>
    `).join('');

    treeEl.querySelectorAll('[data-nav]').forEach((el) => {
      el.onclick = () => {
        const id = Number(el.dataset.nav);
        const lvl = Number(el.dataset.level);
        activePath = activePath.slice(0, lvl);
        activePath[lvl] = id;
        renderTree();
      };
    });
    treeEl.querySelectorAll('[data-check]').forEach((el) => {
      // checkbox.indeterminate is a DOM property, not an HTML attribute —
      // must be set imperatively after the element exists.
      el.indeterminate = el.dataset.checkState === 'indeterminate';
      el.onchange = () => {
        const id = Number(el.dataset.check);
        setSectorSelection(byParent, selectedSectorIds, id, el.checked);
        renderTree();
        renderChips();
      };
    });
  }

  renderTree();
  renderChips();

  document.getElementById('f-apply').onclick = () => {
    location.hash = '#/archive?' + toQuery({
      q: document.getElementById('f-q').value,
      sector: [...selectedSectorIds].join(','),
      usage: document.getElementById('f-usage').value,
      type: document.getElementById('f-type').value,
      source_id: document.getElementById('f-source').value,
      from: document.getElementById('f-from').value,
      to: document.getElementById('f-to').value,
    }).slice(1);
  };
  document.getElementById('f-clear').onclick = () => { location.hash = '#/archive'; };
}

function toQuery(obj) {
  const params = Object.entries(obj).filter(([, v]) => v);
  return params.length ? '&' + new URLSearchParams(params).toString() : '';
}

// Lightweight per-browser identity (no auth system) used only to tell "my"
// personal saves / team picks apart from everyone else's, and to avoid
// double-counting the same person's team pick in the ranking.
function getUserEmail(promptIfMissing) {
  let email = localStorage.getItem('ra_user_email');
  if (!email && promptIfMissing) {
    email = (prompt('개인 저장 / 팀 Pick은 이메일로 구분됩니다. 이메일을 입력해주세요:') || '').trim();
    if (email) localStorage.setItem('ra_user_email', email);
  }
  return email || null;
}

async function renderDetail(id) {
  const [item, picks, related] = await Promise.all([
    api(`/items/${id}`),
    api(`/picks?item_id=${id}`).catch(() => []),
    api(`/items/${id}/related`).catch(() => []),
  ]);
  const usageTags = (item.usages || []).map((u) => `<span class="pill">${u.name}</span>`).join('');
  const sectorTags = (item.sectors || []).map((s) => `<span class="pill">${s.name}</span>`).join('');
  const companyTags = (item.companies || []).map((c) => `<span class="pill">🏢 ${c.name}</span>`).join('');

  const myEmail = getUserEmail(false);
  const myPersonalPick = myEmail ? picks.find((p) => p.kind === 'personal' && p.user_email === myEmail) : null;
  const myTeamPick = myEmail ? picks.find((p) => p.kind === 'team' && p.user_email === myEmail) : null;
  const teamPickCount = picks.filter((p) => p.kind === 'team').length;

  app.innerHTML = `
    <div class="detail">
      ${typeTag(item.type)}<span class="pill">${item.trust_grade || 'A'}</span>
      <span class="meta">${item.published_at || ''} · ${item.source_name || ''}</span>
      <h1>${item.title}</h1>
      <div><a href="${item.source_url}" target="_blank">원문 링크</a>${item.pdf_url ? ` · <a href="${item.pdf_url}" target="_blank">PDF</a>` : ''}</div>
      <div class="section"><h2>핵심 요약</h2><p>${item.summary || '(미작성)'}</p></div>
      <div class="section"><h2>인사이트</h2><p>${item.insight || '(미작성)'}</p></div>
      <div class="section"><h2>섹터</h2>${sectorTags || '-'}</div>
      <div class="section"><h2>활용처</h2>${usageTags || '-'}</div>
      ${companyTags ? `<div class="section"><h2>관련 기업 (자동 아카이빙)</h2>${companyTags}</div>` : ''}
      <div class="section"><h2>출처 표기</h2><code id="attr">${item.attribution || item.source_url}</code>
        <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('attr').textContent)">복사</button>
      </div>
      <div class="section" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="btn ${myPersonalPick ? 'primary' : ''}" id="personal-pick-btn">${myPersonalPick ? '개인 저장됨 (취소)' : '개인 저장'}</button>
        <button class="btn ${myTeamPick ? 'primary' : ''}" id="team-pick-btn">${myTeamPick ? '팀 Pick 취소' : '팀 Pick 저장'}</button>
        <span class="meta">팀 Pick ${teamPickCount}명</span>
        <button class="btn" id="delete-item-btn" style="margin-left:auto;color:#b91c1c">삭제</button>
      </div>
      ${related.length ? `
        <div class="section">
          <h2>관련 자료</h2>
          <div class="grid">${related.map(itemCard).join('')}</div>
        </div>
      ` : ''}
    </div>
  `;

  document.getElementById('personal-pick-btn').onclick = async () => {
    if (myPersonalPick) {
      await api(`/picks/${myPersonalPick.id}`, { method: 'DELETE' });
    } else {
      const email = getUserEmail(true);
      if (!email) return;
      await api('/picks', { method: 'POST', body: JSON.stringify({ item_id: item.id, kind: 'personal', user_email: email }) });
    }
    renderDetail(id);
  };
  document.getElementById('team-pick-btn').onclick = async () => {
    if (myTeamPick) {
      await api(`/picks/${myTeamPick.id}`, { method: 'DELETE' });
    } else {
      const email = getUserEmail(true);
      if (!email) return;
      await api('/picks', { method: 'POST', body: JSON.stringify({ item_id: item.id, kind: 'team', user_email: email }) });
    }
    renderDetail(id);
  };
  document.getElementById('delete-item-btn').onclick = async () => {
    if (!confirm('이 자료를 영구적으로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    await api(`/items/${id}`, { method: 'DELETE' });
    location.hash = '#/archive';
  };
}

async function renderSources() {
  const sources = await api('/sources');
  app.innerHTML = `
    <h1>Sources</h1>
    <table>
      <tr><th>이름</th><th>수집방식</th><th>오너</th><th>주기(일)</th><th>신뢰등급</th><th>마지막 수집</th><th>상태</th><th></th></tr>
      ${sources.map((s) => `<tr>
        <td>${s.name}</td><td>${s.method}</td><td>${s.owner || '-'}</td><td>${s.frequency_days}</td>
        <td>${s.trust_grade}</td><td>${s.last_collected_at ? new Date(s.last_collected_at).toLocaleDateString() : '-'}</td>
        <td>${s.last_error ? `<span class="stale" title="${s.last_error}">실패</span>` : (s.stale ? '<span class="stale">Stale</span>' : 'OK')}</td>
        <td>${s.method === 'rss' ? `<button class="btn" data-collect="${s.id}">지금 수집</button>` : ''}</td>
      </tr>`).join('')}
    </table>
    <h2 style="margin-top:24px">소스 추가</h2>
    <div class="form-row"><label>이름</label><input id="s-name"></div>
    <div class="form-row"><label>수집방식</label>
      <select id="s-method"><option value="manual">manual</option><option value="rss">rss (자동 수집)</option><option value="crawl">crawl</option></select>
    </div>
    <div class="form-row"><label>URL (rss는 피드 URL)</label><input id="s-url"></div>
    <div class="form-row"><label>오너</label><input id="s-owner"></div>
    <div class="form-row"><label>수집 주기(일)</label><input id="s-freq" type="number" value="1"></div>
    <button class="btn primary" id="s-add">추가</button>
  `;
  document.querySelectorAll('[data-collect]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '수집 중...';
      try {
        await api(`/sources/${btn.dataset.collect}/collect`, { method: 'POST' });
      } catch (err) {
        alert(`수집 실패: ${err.message}`);
      }
      renderSources();
    };
  });
  document.getElementById('s-add').onclick = async () => {
    await api('/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('s-name').value,
        method: document.getElementById('s-method').value,
        url: document.getElementById('s-url').value,
        owner: document.getElementById('s-owner').value,
        frequency_days: Number(document.getElementById('s-freq').value) || 1,
      }),
    });
    renderSources();
  };
}

// AI eligibility=false is a reviewer signal, not a filter — every Draft item
// stays in the dropdown and reviewable, just reordered so items the AI
// flagged as questionable surface first. eligible === null means "no AI
// recommendation yet" (draft/failed/not requested), sorted after false but
// before true so it's still seen ahead of items the AI is fine with.
function reviewPriority(d) {
  if (d.ai_eligible === false) return 0;
  if (d.ai_eligible === null || d.ai_eligible === undefined) return 1;
  return 2;
}

const MATCH_LABELS = {
  match: '<span class="pill" style="background:#f0fdf4;color:#15803d">일치</span>',
  ai_false_positive: '<span class="pill" style="background:#fef2f2;color:#b91c1c">AI 오탐 (적합→비적합)</span>',
  ai_false_negative: '<span class="pill" style="background:#fef2f2;color:#b91c1c">AI 누락 (비적합→적합)</span>',
};

function eligibilityLabel(v) {
  if (v === true) return '적합';
  if (v === false) return '비적합';
  return '-';
}

async function renderReview() {
  const [draftsRaw, sectors, usages, sources] = await Promise.all([
    api('/items?status=Draft'), api('/sectors'), api('/usages'), api('/sources'),
  ]);
  const drafts = [...draftsRaw].sort((a, b) => reviewPriority(a) - reviewPriority(b));

  // Comparison view: only Drafts the reviewer has actually confirmed/
  // overridden (reviewer_eligible is not null) are shown — an unreviewed
  // item has nothing to compare yet. Read-only, no new DB columns; purely
  // derived from the existing ai_eligible/reviewer_eligible fields.
  const reviewed = drafts
    .map((d) => ({ ...d, match: classifyEligibilityMatch(d.ai_eligible, d.reviewer_eligible) }))
    .filter((d) => d.match !== null);
  const comparisonSection = reviewed.length
    ? `<div class="section">
        <h2>AI vs 리뷰어 적합성 비교</h2>
        <table>
          <tr><th>제목</th><th>AI 판단</th><th>리뷰어 판단</th><th>결과</th></tr>
          ${reviewed.map((d) => `<tr>
            <td><a href="#/detail/${d.id}">${d.title}</a></td>
            <td>${eligibilityLabel(d.ai_eligible)}</td>
            <td>${eligibilityLabel(d.reviewer_eligible)}</td>
            <td>${MATCH_LABELS[d.match]}</td>
          </tr>`).join('')}
        </table>
      </div>`
    : '';

  app.innerHTML = `
    <h1>Review</h1>
    ${comparisonSection}
    <div class="filters">
      <select id="draft-select">
        ${drafts.map((d) => `<option value="${d.id}">${d.ai_eligible === false ? '⚠ ' : ''}${d.title}</option>`).join('') || '<option>Draft 없음</option>'}
      </select>
      <button class="btn" id="prev-draft-btn" type="button">← 이전</button>
      <button class="btn" id="next-draft-btn" type="button">다음 →</button>
      <button class="btn" id="new-draft">새 자료 수동 등록</button>
    </div>
    <div id="review-body"></div>
  `;
  const sourceOpts = sources.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  const sectorChips = sectors.map((s) => `<span class="chip" data-sector="${s.id}">${s.name}</span>`).join('');
  const usageChips = usages.map((u) => `<span class="chip" data-usage="${u.id}">${u.name}</span>`).join('');
  const sectorById = new Map(sectors.map((s) => [s.id, s]));
  const usageById = new Map(usages.map((u) => [u.id, u]));

  function bindChips(container, selectedIds) {
    container.querySelectorAll('.chip').forEach((chip) => {
      const id = chip.dataset.sector || chip.dataset.usage;
      if (selectedIds.includes(Number(id))) chip.classList.add('active');
      chip.onclick = () => chip.classList.toggle('active');
    });
  }

  function getActive(container, attr) {
    return [...container.querySelectorAll(`.chip.active`)].map((c) => Number(c.dataset[attr]));
  }

  async function loadDraft(id) {
    if (!id) {
      document.getElementById('review-body').innerHTML = `
        <div class="review-layout">
          <div class="orig">
            <div class="form-row"><label>원문 URL</label>
              <div style="display:flex;gap:6px">
                <input id="d-url" style="flex:1">
                <button class="btn" id="d-extract" type="button">메타데이터 가져오기</button>
              </div>
              <div class="meta" id="d-extract-status"></div>
            </div>
            <div class="form-row"><label>제목</label><input id="d-title"></div>
            <div class="form-row"><label>썸네일 URL</label><input id="d-thumb"></div>
            <div class="form-row"><label>유형</label>
              <select id="d-type">${['뉴스', '보고서', '통계', '규제'].map((t) => `<option>${t}</option>`).join('')}</select>
            </div>
            <div class="form-row"><label>소스</label><select id="d-source"><option value="">-</option>${sourceOpts}</select></div>
            <div class="form-row"><label>발행일</label><input id="d-date" type="date"></div>
          </div>
          <div class="orig">
            <div class="form-row"><label>핵심 요약</label><textarea id="d-summary" rows="4"></textarea></div>
            <div class="form-row"><label>인사이트</label><textarea id="d-insight" rows="4"></textarea></div>
            <div class="form-row"><label>섹터</label><div class="chiplist" id="d-sectors">${sectorChips}</div></div>
            <div class="form-row"><label>활용처</label><div class="chiplist" id="d-usages">${usageChips}</div></div>
            <button class="btn primary" id="d-save">Draft 저장</button>
          </div>
        </div>
      `;
      bindChips(document.getElementById('d-sectors'), []);
      bindChips(document.getElementById('d-usages'), []);
      document.getElementById('d-extract').onclick = async () => {
        const url = document.getElementById('d-url').value;
        if (!url) return;
        const status = document.getElementById('d-extract-status');
        status.textContent = '가져오는 중...';
        try {
          const meta = await api('/items/extract-metadata', { method: 'POST', body: JSON.stringify({ url }) });
          if (meta.title) document.getElementById('d-title').value = meta.title;
          if (meta.summary) document.getElementById('d-summary').value = meta.summary;
          if (meta.thumbnail_url) document.getElementById('d-thumb').value = meta.thumbnail_url;
          if (meta.published_at) document.getElementById('d-date').value = meta.published_at;
          status.textContent = '메타데이터를 가져왔습니다. 확인 후 필요하면 수정하세요.';
        } catch (err) {
          status.textContent = `자동 추출 실패: ${err.message} — 직접 입력해주세요.`;
        }
      };
      document.getElementById('d-save').onclick = async () => {
        await api('/items', {
          method: 'POST',
          body: JSON.stringify({
            title: document.getElementById('d-title').value,
            source_url: document.getElementById('d-url').value,
            thumbnail_url: document.getElementById('d-thumb').value || null,
            type: document.getElementById('d-type').value,
            source_id: document.getElementById('d-source').value || null,
            published_at: document.getElementById('d-date').value || null,
            summary: document.getElementById('d-summary').value,
            insight: document.getElementById('d-insight').value,
            sector_ids: getActive(document.getElementById('d-sectors'), 'sector'),
            usage_ids: getActive(document.getElementById('d-usages'), 'usage'),
          }),
        });
        renderReview();
      };
      return;
    }
    const item = await api(`/items/${id}`);

    function renderAiBox() {
      if (item.ai_status === 'pending') {
        return `<div class="ai-box"><h3>AI 초안</h3><p class="meta">AI 초안 생성 중...</p></div>`;
      }
      if (item.ai_status === 'failed') {
        return `<div class="ai-box">
          <h3>AI 초안</h3>
          <p class="meta">AI 초안을 생성하지 못했습니다. 원문을 확인해 직접 작성할 수 있습니다.</p>
          <button class="btn" id="ai-retry-btn" type="button">다시 시도</button>
        </div>`;
      }
      if (item.ai_status === 'completed') {
        const sectorChipsAi = (item.ai_suggested_sectors || [])
          .map((sid) => sectorById.get(sid))
          .filter(Boolean)
          .map((s) => `<span class="chip ai-suggested" data-apply-sector="${s.id}">${s.name}</span>`)
          .join('') || '<span class="meta">제안 없음</span>';
        const usageChipsAi = (item.ai_suggested_usages || [])
          .map((uid) => usageById.get(uid))
          .filter(Boolean)
          .map((u) => `<span class="chip ai-suggested" data-apply-usage="${u.id}">${u.name}</span>`)
          .join('') || '<span class="meta">제안 없음</span>';
        const eligibilityBadge = item.ai_eligible === false
          ? '<span class="pill" style="background:#fef2f2;color:#b91c1c">⚠ 아카이빙 비적합 추정</span>'
          : item.ai_eligible === true
            ? '<span class="pill" style="background:#f0fdf4;color:#15803d">아카이빙 적합 추정</span>'
            : '<span class="pill">AI 판단 없음</span>';
        const reviewerBadge = item.reviewer_eligible === true
          ? '<span class="pill" style="background:#f0fdf4;color:#15803d">✓ 리뷰어 확인: 적합</span>'
          : item.reviewer_eligible === false
            ? '<span class="pill" style="background:#fef2f2;color:#b91c1c">✓ 리뷰어 확인: 비적합</span>'
            : '<span class="pill">리뷰어 미확인</span>';
        return `<div class="ai-box">
          <h3>AI 초안 <button class="btn" id="ai-retry-btn" type="button" style="margin-left:8px">다시 생성</button></h3>
          <p class="meta">AI는 제목/원문 요약만을 근거로 초안을 작성했습니다. 전체 본문을 검토한 것은 아니니 반드시 확인 후 사용하세요.</p>
          <div class="form-row"><label>아카이빙 적합성 (AI 추천, 최종 판단은 리뷰어)</label>
            ${eligibilityBadge}
            <p class="meta">${item.ai_eligibility_reason || ''}</p>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
              ${reviewerBadge}
              <button class="btn" id="reviewer-eligible-confirm-btn" type="button">적합으로 확정</button>
              <button class="btn" id="reviewer-eligible-override-btn" type="button">비적합으로 확정</button>
            </div>
          </div>
          <div class="form-row"><label>AI 요약 (사실, 확인 필요)</label><p>${item.ai_summary || ''}</p></div>
          <div class="form-row"><label>AI 인사이트 (추론 — 사실 아님)</label><p style="color:#6b21a8">${item.ai_insight || ''}</p></div>
          <div class="form-row"><label>핵심 내용</label><p>${item.ai_key_takeaway || ''}</p></div>
          <div class="form-row"><label>추천 섹터 (클릭하여 적용)</label><div class="chiplist">${sectorChipsAi}</div></div>
          <div class="form-row"><label>추천 활용처 (클릭하여 적용)</label><div class="chiplist">${usageChipsAi}</div></div>
          <button class="btn primary" id="ai-apply-all-btn" type="button">AI 제안 전체 적용</button>
        </div>`;
      }
      // not_requested
      return `<div class="ai-box">
        <h3>AI 초안</h3>
        <p class="meta">아직 AI 초안이 생성되지 않았습니다.</p>
        <button class="btn" id="ai-retry-btn" type="button">AI 초안 생성</button>
      </div>`;
    }

    document.getElementById('review-body').innerHTML = `
      <div class="review-layout">
        <div class="orig">
          <h2>원문</h2>
          <p><a href="${item.source_url}" target="_blank">${item.source_url}</a></p>
          <p>${item.title}</p>
          ${renderAiBox()}
        </div>
        <div class="orig">
          <div class="form-row"><label>핵심 요약</label><textarea id="d-summary" rows="4">${item.summary || ''}</textarea></div>
          <div class="form-row"><label>인사이트</label><textarea id="d-insight" rows="4">${item.insight || ''}</textarea></div>
          <div class="form-row"><label>섹터</label><div class="chiplist" id="d-sectors">${sectorChips}</div></div>
          <div class="form-row"><label>활용처</label><div class="chiplist" id="d-usages">${usageChips}</div></div>
          <button class="btn primary" id="d-publish">발행</button>
        </div>
      </div>
    `;
    bindChips(document.getElementById('d-sectors'), (item.sectors || []).map((s) => s.id));
    bindChips(document.getElementById('d-usages'), (item.usages || []).map((u) => u.id));

    // AI suggestion chips activate the corresponding real chip; they never
    // write to the server directly — only "발행" persists anything.
    document.querySelectorAll('[data-apply-sector]').forEach((el) => {
      el.onclick = () => {
        const chip = document.querySelector(`#d-sectors [data-sector="${el.dataset.applySector}"]`);
        if (chip) chip.classList.add('active');
      };
    });
    document.querySelectorAll('[data-apply-usage]').forEach((el) => {
      el.onclick = () => {
        const chip = document.querySelector(`#d-usages [data-usage="${el.dataset.applyUsage}"]`);
        if (chip) chip.classList.add('active');
      };
    });
    const applyAllBtn = document.getElementById('ai-apply-all-btn');
    if (applyAllBtn) {
      applyAllBtn.onclick = () => {
        if (item.ai_summary) document.getElementById('d-summary').value = item.ai_summary;
        if (item.ai_key_takeaway) document.getElementById('d-insight').value = item.ai_key_takeaway;
        (item.ai_suggested_sectors || []).forEach((sid) => {
          const chip = document.querySelector(`#d-sectors [data-sector="${sid}"]`);
          if (chip) chip.classList.add('active');
        });
        (item.ai_suggested_usages || []).forEach((uid) => {
          const chip = document.querySelector(`#d-usages [data-usage="${uid}"]`);
          if (chip) chip.classList.add('active');
        });
      };
    }
    const aiRetryBtn = document.getElementById('ai-retry-btn');
    if (aiRetryBtn) {
      aiRetryBtn.onclick = async () => {
        aiRetryBtn.disabled = true;
        aiRetryBtn.textContent = '생성 중...';
        try {
          await api(`/items/${id}/ai-draft`, { method: 'POST' });
        } catch (err) {
          // sanitized message already; just surface it and let the reload show state
        }
        loadDraft(id);
      };
    }

    const reviewerConfirmBtn = document.getElementById('reviewer-eligible-confirm-btn');
    if (reviewerConfirmBtn) {
      reviewerConfirmBtn.onclick = async () => {
        await api(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ reviewer_eligible: true }) });
        loadDraft(id);
      };
    }
    const reviewerOverrideBtn = document.getElementById('reviewer-eligible-override-btn');
    if (reviewerOverrideBtn) {
      reviewerOverrideBtn.onclick = async () => {
        await api(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ reviewer_eligible: false }) });
        loadDraft(id);
      };
    }

    document.getElementById('d-publish').onclick = async () => {
      await api(`/items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          summary: document.getElementById('d-summary').value,
          insight: document.getElementById('d-insight').value,
          sector_ids: getActive(document.getElementById('d-sectors'), 'sector'),
          usage_ids: getActive(document.getElementById('d-usages'), 'usage'),
          status: 'Published',
        }),
      });
      renderReview();
    };
  }

  const select = document.getElementById('draft-select');
  const prevBtn = document.getElementById('prev-draft-btn');
  const nextBtn = document.getElementById('next-draft-btn');
  let currentIndex = drafts.length ? 0 : -1;

  function syncNavButtons() {
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex < 0 || currentIndex >= drafts.length - 1;
  }

  function selectDraftAt(index) {
    if (index < 0 || index >= drafts.length) return;
    currentIndex = index;
    select.value = String(drafts[index].id);
    syncNavButtons();
    loadDraft(drafts[index].id);
  }

  select.onchange = () => {
    currentIndex = drafts.findIndex((d) => String(d.id) === select.value);
    syncNavButtons();
    loadDraft(select.value);
  };
  prevBtn.onclick = () => selectDraftAt(currentIndex - 1);
  nextBtn.onclick = () => selectDraftAt(currentIndex + 1);
  document.getElementById('new-draft').onclick = () => loadDraft(null);

  syncNavButtons();
  if (drafts[0]) loadDraft(drafts[0].id);
}

function parseHash() {
  const hash = location.hash.replace(/^#\//, '');
  const [route, qs] = hash.split('?');
  const parts = route.split('/');
  const query = qs ? Object.fromEntries(new URLSearchParams(qs)) : {};
  return { path: parts[0] || 'home', param: parts[1], query };
}

async function router() {
  const { path, param, query } = parseHash();
  try {
    if (path === 'home' || path === '' || path === 'archive') await renderArchive(query);
    else if (path === 'detail') await renderDetail(param);
    else if (path === 'sources') await renderSources();
    else if (path === 'review') await renderReview();
    else app.innerHTML = '<p>페이지를 찾을 수 없습니다.</p>';
  } catch (err) {
    app.innerHTML = `<p>오류: ${err.message}</p>`;
  }
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) location.hash = '#/archive';
  router();
});
