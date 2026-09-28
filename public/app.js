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

async function renderHome() {
  const [published, ranking, sources] = await Promise.all([
    api('/items?status=Published'),
    api('/picks/ranking').catch(() => []),
    api('/sources').catch(() => []),
  ]);
  const recent = published.slice(0, 9);
  const failedSources = sources.filter((s) => s.last_error);
  const warning = failedSources.length
    ? `<div class="section" style="border:1px solid var(--reg);border-radius:8px;padding:12px;margin-bottom:16px;background:#fef2f2">
        <strong class="stale">수집 실패 경고</strong>
        <ul style="margin:8px 0 0;padding-left:18px">
          ${failedSources.map((s) => `<li>${s.name}: ${s.last_error} (${new Date(s.last_error_at).toLocaleString()})</li>`).join('')}
        </ul>
      </div>`
    : '';
  app.innerHTML = `
    <h1>Home</h1>
    ${warning}
    <h2>이번 주 최신 이슈</h2>
    <div class="grid">${recent.map(itemCard).join('') || '<p>발행된 자료가 없습니다.</p>'}</div>
    <h2 style="margin-top:28px">팀 Pick · 많이 본 자료</h2>
    <table><tr><th>제목</th><th>유형</th><th>Pick 수</th></tr>
      ${ranking.map((r) => `<tr><td><a href="#/detail/${r.id}">${r.title}</a></td><td>${r.type}</td><td>${r.pick_count}</td></tr>`).join('') || '<tr><td colspan="3">아직 팀 Pick이 없습니다.</td></tr>'}
    </table>
  `;
}

async function renderArchive(query = {}) {
  const [sectors, usages, items] = await Promise.all([
    api('/sectors'), api('/usages'), api('/items?status=Published' + toQuery(query)),
  ]);
  const sectorOpts = sectors.map((s) => `<option value="${s.id}" ${String(query.sector) === String(s.id) ? 'selected' : ''}>${s.parent_id ? '　' : ''}${s.name}</option>`).join('');
  const usageOpts = usages.map((u) => `<option value="${u.id}" ${String(query.usage) === String(u.id) ? 'selected' : ''}>${u.name}</option>`).join('');
  app.innerHTML = `
    <h1>Archive</h1>
    <div class="filters">
      <input id="f-q" placeholder="검색" value="${query.q || ''}">
      <select id="f-sector"><option value="">섹터 전체</option>${sectorOpts}</select>
      <select id="f-usage"><option value="">활용처 전체</option>${usageOpts}</select>
      <select id="f-type">
        <option value="">유형 전체</option>
        ${['뉴스', '보고서', '통계', '규제'].map((t) => `<option ${query.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <button class="btn" id="f-apply">필터 적용</button>
      <button class="btn" id="f-clear">초기화</button>
    </div>
    <div class="count">${items.length}개 결과</div>
    <div class="grid">${items.map(itemCard).join('') || '<p>결과가 없습니다.</p>'}</div>
  `;
  document.getElementById('f-apply').onclick = () => {
    location.hash = '#/archive?' + toQuery({
      q: document.getElementById('f-q').value,
      sector: document.getElementById('f-sector').value,
      usage: document.getElementById('f-usage').value,
      type: document.getElementById('f-type').value,
    }).slice(1);
  };
  document.getElementById('f-clear').onclick = () => { location.hash = '#/archive'; };
}

function toQuery(obj) {
  const params = Object.entries(obj).filter(([, v]) => v);
  return params.length ? '&' + new URLSearchParams(params).toString() : '';
}

async function renderDetail(id) {
  const item = await api(`/items/${id}`);
  const usageTags = (item.usages || []).map((u) => `<span class="pill">${u.name}</span>`).join('');
  const sectorTags = (item.sectors || []).map((s) => `<span class="pill">${s.name}</span>`).join('');
  const companyTags = (item.companies || []).map((c) => `<span class="pill">🏢 ${c.name}</span>`).join('');
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
      <div class="section">
        <button class="btn primary" id="pick-btn">팀 Pick 저장</button>
      </div>
    </div>
  `;
  document.getElementById('pick-btn').onclick = async () => {
    await api('/picks', { method: 'POST', body: JSON.stringify({ item_id: item.id, kind: 'team' }) });
    alert('Pick 저장됨');
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

async function renderReview() {
  const [drafts, sectors, usages, sources] = await Promise.all([
    api('/items?status=Draft'), api('/sectors'), api('/usages'), api('/sources'),
  ]);
  app.innerHTML = `
    <h1>Review</h1>
    <div class="filters">
      <select id="draft-select">
        ${drafts.map((d) => `<option value="${d.id}">${d.title}</option>`).join('') || '<option>Draft 없음</option>'}
      </select>
      <button class="btn" id="new-draft">새 자료 수동 등록</button>
    </div>
    <div id="review-body"></div>
  `;
  const sourceOpts = sources.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  const sectorChips = sectors.map((s) => `<span class="chip" data-sector="${s.id}">${s.name}</span>`).join('');
  const usageChips = usages.map((u) => `<span class="chip" data-usage="${u.id}">${u.name}</span>`).join('');

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
    document.getElementById('review-body').innerHTML = `
      <div class="review-layout">
        <div class="orig">
          <h2>원문</h2>
          <p><a href="${item.source_url}" target="_blank">${item.source_url}</a></p>
          <p>${item.title}</p>
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
  select.onchange = () => loadDraft(select.value);
  document.getElementById('new-draft').onclick = () => loadDraft(null);
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
    if (path === 'home' || path === '') await renderHome();
    else if (path === 'archive') await renderArchive(query);
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
  if (!location.hash) location.hash = '#/home';
  router();
});
