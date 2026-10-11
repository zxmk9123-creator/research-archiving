const TYPE_CLASS = { '뉴스': 'news', '보고서': 'report', '통계': 'stat', '규제': 'reg' };
const app = document.getElementById('app');

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    // Admin write routes (requireAuth in server/lib/auth.js) return a JSON
    // { error } body on 401 — surface that friendly Korean message instead
    // of the raw response text existing callers' alert(`...: ${err.message}`)
    // would otherwise show verbatim.
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) message = parsed.error;
    } catch (err) { /* not JSON — keep raw text */ }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// AI draft generation can legitimately take well over a minute (FreeLLMAPI's
// own cascade budget is up to 135s — see provider.js), which routinely
// outlasts the hosting platform's gateway timeout. The gateway then cuts the
// browser's connection with a 502 ("Application failed to respond") even
// though the server is still running and will finish the generation and
// write it to the item a little later. ai_status flips to 'pending' almost
// immediately (before the slow provider call), so once the POST is fired,
// polling the item directly sidesteps the gateway's timeout entirely — this
// surfaces the real outcome instead of a raw gateway error for what is
// actually still in-progress work.
async function triggerAiDraftAndPoll(id, body) {
  const postPromise = api(`/items/${id}/ai-draft`, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err) => ({ __error: err }));
  const postResult = await postPromise;

  const deadlineAt = Date.now() + 160000;
  let item = await api(`/items/${id}`);
  while (item.ai_status === 'pending' && Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    item = await api(`/items/${id}`);
  }
  if (postResult && postResult.__error && item.ai_status !== 'completed' && item.ai_status !== 'failed') {
    throw postResult.__error;
  }
  return item;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function typeTag(t) {
  return `<span class="tag ${TYPE_CLASS[t] || ''}">${t}</span>`;
}

const { buildSectorMaps, sectorAncestryPath, buildColumns, collectSubtreeIds, getSectorCheckState, setSectorSelection } = SectorTree;
const { classifyEligibilityMatch } = EligibilityMatch;
const { normalizeImportantIds } = CardHelpers;
const { translateSourceError } = SourceErrors;
const { parseSavedIds, serializeSavedIds, toggleSavedId } = PersonalSaves;
const { formatDateOnly } = DateFormat;

const STAR_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.5l2.6 5.5 6 .7-4.4 4.1 1.2 6-5.4-3-5.4 3 1.2-6L1.4 7.7l6-.7z"/></svg>';

// Personal Save ("나중에 다시 볼 자료") lives only in this browser's
// localStorage — no auth exists yet, so it is never tied to an email or
// written to the server (contrast with Team Pick, which stays server-side
// via the existing picks API/kind='team').
const PERSONAL_SAVE_STORAGE_KEY = 'ra_personal_saves';
function getPersonalSaveIds() {
  return parseSavedIds(localStorage.getItem(PERSONAL_SAVE_STORAGE_KEY));
}
function setPersonalSaveIds(ids) {
  localStorage.setItem(PERSONAL_SAVE_STORAGE_KEY, serializeSavedIds(ids));
}
window.toggleSaveFromCard = function toggleSaveFromCard(ev, id) {
  ev.stopPropagation();
  const next = toggleSavedId(getPersonalSaveIds(), id);
  setPersonalSaveIds(next);
  const btn = ev.currentTarget;
  const nowSaved = next.has(id);
  btn.classList.toggle('is-saved', nowSaved);
  btn.textContent = nowSaved ? '★ 저장됨' : '☆ 저장';
};

// "Important" reuses the existing team-pick signal (picks.kind='team',
// surfaced today via GET /api/picks/ranking) rather than any new field or
// an invented scoring algorithm — a team pick is already an explicit human
// judgment that an item matters. importantIds/savedIds are optional and
// always normalized to a Set here at the render boundary — this is what
// fixes "importantIds.has is not a function": one call site passed
// itemCard directly as an Array.map() callback, so map's numeric index
// arrived as importantIds instead of a Set. normalizeImportantIds() makes
// every caller safe regardless of what it actually passed.
//
// Editorial grid module: image (existing thumbnail_url) or, when absent, a
// text-based source-identity module at the same aspect ratio — never a
// generated image. The hover/mobile summary reuses existing ai_summary
// first, then summary, exactly as already stored; no new field.
function itemCard(item, importantIds, savedIds) {
  const sectors = (item.sectors || []).map((s) => s.name).join(', ');
  const important = normalizeImportantIds(importantIds);
  const saved = normalizeImportantIds(savedIds);
  const isImportant = important.has(item.id);
  const isSaved = saved.has(item.id);
  const summaryText = item.ai_summary || item.summary || '';

  const media = item.thumbnail_url
    ? `<img src="${item.thumbnail_url}" alt="" loading="lazy" onerror="this.closest('.card-media').classList.add('is-fallback');this.remove()">`
    : `<div class="card-media-fallback"><span>${item.source_name || item.type || '자료'}</span></div>`;

  return `<div class="card" onclick="location.hash='#/detail/${item.id}'">
    <div class="card-media ${item.thumbnail_url ? '' : 'is-fallback'}">
      ${media}
      ${isImportant ? `<span class="card-priority-star" title="주요 리서치">${STAR_ICON}</span>` : ''}
      ${summaryText ? `<div class="card-hover-summary"><p>${summaryText}</p></div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-eyebrow">${typeTag(item.type)}<span class="pill">${item.trust_grade || 'A'}</span>
        <button type="button" class="card-save-btn ${isSaved ? 'is-saved' : ''}" onclick="toggleSaveFromCard(event, ${item.id})">${isSaved ? '★ 저장됨' : '☆ 저장'}</button>
      </div>
      <h3>${item.title}</h3>
      <div class="meta">${item.source_name || ''} · ${formatDateOnly(item.published_at)}${sectors ? ` · ${sectors}` : ''}</div>
      ${summaryText ? `<p class="card-summary-mobile">${summaryText}</p>` : ''}
    </div>
  </div>`;
}

// Shared, single implementation reused by whichever page currently
// displays it (position-only concern — the data/rendering logic itself
// never duplicates): compact collection-failure summary, collapsed by
// default, expanding to translated per-source messages.
function collectionWarningHtml(sources) {
  const failedSources = sources.filter((s) => s.last_error);
  if (!failedSources.length) return '';
  return `<details class="archive-collection-warning">
      <summary>⚠ ${failedSources.length}개 수집 소스에서 확인이 필요합니다</summary>
      <ul class="collection-warning-list">
        ${failedSources.map((s) => {
          const { message, detail } = translateSourceError(s.last_error);
          const checked = s.last_error_at ? new Date(s.last_error_at).toLocaleString() : '-';
          return `<li>
            <span class="collection-warning-source">${s.name}</span>
            <span class="collection-warning-message">${message}</span>
            <span class="collection-warning-meta">마지막 확인 ${checked}${detail ? ` · ${detail}` : ''}</span>
          </li>`;
        }).join('')}
      </ul>
    </details>`;
}

// Shared, single implementation of the trust-grade explanation — static
// markup, no page-specific data, reused by whichever page currently
// displays it.
const TRUST_GRADE_EXPLANATION_HTML = `<details class="section">
      <summary>신뢰등급(A/B/C)이란?</summary>
      <p class="meta">
        신뢰등급은 별도의 자동 산정 로직 없이, 소스 등록 시 담당자가 발행처의 공신력·정확성 이력을 근거로
        직접 A(가장 신뢰)·B·C 중 하나로 지정합니다. 기본값은 A이며, 이후 자동으로 재계산되지 않습니다.
        수집 성공/실패 이력(위 "상태" 열)은 신뢰등급과 별개로 기록되며, 등급에 영향을 주지 않습니다.
      </p>
    </details>`;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Home carousel auto-advance timers — tracked globally so router() can
// clear them on every navigation (including away from Home), otherwise a
// setInterval from a previous renderHome() call keeps firing against
// detached DOM after app.innerHTML is replaced by whichever page comes
// next.
let homeCarouselIntervals = [];
function clearHomeCarouselIntervals() {
  homeCarouselIntervals.forEach(clearInterval);
  homeCarouselIntervals = [];
}

// Wires prev/next + 10s auto-advance + (when present) pagination dots for
// one Home carousel module. A module with 0 or 1 slides (3 or fewer
// items) has nothing to advance through, so its arrows are simply
// disabled rather than left to no-op, and no dots are rendered for it
// (homeCarouselModule already skips rendering dots when there's only one
// slide, same as the "10 or fewer" cap below).
function initHomeCarousel(containerEl) {
  const track = containerEl.querySelector('.home-carousel-track');
  const slides = track.querySelectorAll('.home-carousel-slide');
  const prevBtn = containerEl.querySelector('.home-carousel-nav.prev');
  const nextBtn = containerEl.querySelector('.home-carousel-nav.next');
  const dots = containerEl.parentElement.querySelectorAll('.home-carousel-dots .home-carousel-dot');
  const total = slides.length;
  if (total <= 1) {
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }
  let index = 0;
  function render() {
    track.style.transform = `translateX(-${index * 100}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
  }
  function startTimer() {
    const timer = setInterval(() => {
      index = (index + 1) % total;
      render();
    }, 10000);
    homeCarouselIntervals.push(timer);
  }
  function resetTimer() {
    clearHomeCarouselIntervals();
    startTimer();
  }
  function go(dir) {
    index = (index + dir + total) % total;
    render();
    resetTimer();
  }
  function goTo(targetIndex) {
    if (targetIndex === index) return;
    index = targetIndex;
    render();
    resetTimer();
  }
  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);
  dots.forEach((dot, i) => { dot.onclick = () => goTo(i); });
  render();
  startTimer();
}

// heading/entry area of each module is clickable (navigates to the
// dedicated full-list page); the grid itself reuses the existing
// itemCard()/Detail-navigation component unchanged.
function homeCarouselModule(heading, moduleItems, targetHash, importantIds, savedIds, moduleAttrs = '') {
  const slides = chunk(moduleItems, 3);
  // moduleAttrs carries the drag-reorder wiring (draggable + data-drag-*)
  // when this module is one of a theme root's reorderable children —
  // empty string elsewhere, so the module is otherwise unaffected.
  const dragHandleHtml = moduleAttrs
    ? '<span class="home-module-drag-handle" aria-hidden="true" title="드래그해서 순서 변경" onclick="event.stopPropagation()">⠿</span>'
    : '';
  const headerHtml = `<div class="home-module-header" onclick="location.hash='${targetHash}'">
    ${dragHandleHtml}<h2>${heading}</h2><span class="home-module-arrow">›</span>
  </div>`;
  if (!slides.length) {
    return `<div class="home-module" ${moduleAttrs}>${headerHtml}<p class="meta">표시할 자료가 없습니다.</p></div>`;
  }
  // One dot per 3-card slide group, for direct navigation — shown whenever
  // there's more than one slide to paginate. No upper cap: a sector with a
  // large item count (e.g. 31 items / 11 slides) wraps onto a second row
  // via .home-carousel-dots' flex-wrap instead of silently losing its dot
  // index — a hidden cap here previously made the module look broken
  // exactly once a popular sector grew past it.
  const showDots = slides.length > 1;
  const dotsHtml = showDots
    ? `<div class="home-carousel-dots">${slides.map((_, i) => `<button type="button" class="home-carousel-dot ${i === 0 ? 'is-active' : ''}" aria-label="${i + 1}번째 그룹으로 이동"></button>`).join('')}</div>`
    : '';

  return `<div class="home-module">
    ${headerHtml}
    <div class="home-carousel">
      <button type="button" class="home-carousel-nav prev" aria-label="이전 자료">‹</button>
      <div class="home-carousel-viewport">
        <div class="home-carousel-track">
          ${slides.map((slide) => `<div class="home-carousel-slide">${slide.map((it) => itemCard(it, importantIds, savedIds)).join('')}</div>`).join('')}
        </div>
      </div>
      <button type="button" class="home-carousel-nav next" aria-label="다음 자료">›</button>
    </div>
    ${dotsHtml}
  </div>`;
}

// Home's top-level theme roots — the two existing root sectors, in the
// fixed display order the milestone specifies. Any other root sector (none
// exist today) is simply not shown on Home, same as before this feature.
const HOME_THEME_ROOT_NAMES = ['식용유지', '비식용유지'];

// Reuses the existing sector taxonomy (GET /api/sectors) as-is — no new
// taxonomy, no DB change. A theme's items are whichever already-fetched
// Published items carry that sector tag (the same {id, name}[] array every
// item already returns), so this is purely a client-side grouping.
function itemsForSector(items, sectorId) {
  return items
    .filter((it) => (it.sectors || []).some((s) => s.id === sectorId))
    .filter((it) => isWithinPastMonth(it.published_at));
}

// Home carousel freshness window — the item's own published_at (never
// created_at/collected_at), within the last 1 calendar month. An item with
// no published_at can't be judged "recent" so it's excluded, not kept.
// Deliberately a filter, not a backfill: if fewer than a full slide's worth
// of items qualify, the carousel just shows fewer slides/cards — it never
// reaches past the window to pad slots with older items.
function isWithinPastMonth(publishedAt) {
  if (!publishedAt) return false;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 1);
  return d >= cutoff;
}

// One top-level theme (식용유지/비식용유지): a clickable heading that opens
// the full-results view filtered to the whole root subtree, followed by one
// compact carousel per child theme (팜유, 대두유, ... / UCO, SAF, ...),
// each reusing homeCarouselModule() unchanged so card/detail behavior and
// visual language stay exactly as they are elsewhere on Home.
function homeThemeRoot(root, byParent, items, importantIds, savedIds) {
  const children = applyHomeCarouselOrder(root.id, byParent.get(root.id) || []);
  const childModulesHtml = children
    .map((child) => homeCarouselModule(
      child.name, itemsForSector(items, child.id), `#/archive?sector=${child.id}`, importantIds, savedIds,
      `draggable="true" data-drag-sector="${child.id}"`
    ))
    .join('');
  // Items are tagged with a leaf/child sector, essentially never the root
  // itself — the root link must filter on the whole subtree (root +
  // every child id), same expansion the Archive page's own sector-tree
  // checkbox already does, or clicking a root would show an empty result.
  const subtreeIds = collectSubtreeIds(byParent, root.id);
  return `<section class="home-theme-root">
    <div class="home-theme-root-header" onclick="location.hash='#/archive?sector=${subtreeIds.join(',')}'">
      <h2>${root.name}</h2><span class="home-module-arrow">›</span>
    </div>
    <div class="home-theme-children" data-drag-root="${root.id}">${childModulesHtml || '<p class="meta">표시할 테마가 없습니다.</p>'}</div>
  </section>`;
}

// Per-browser carousel order (localStorage, same convention as
// personalSaves/onboarding flags) — a display preference, not account
// data, so it needs no backend or auth. Keyed by theme-root id since the
// two roots' children are independent orderings.
const HOME_CAROUSEL_ORDER_KEY = 'ra_home_carousel_order';

function getHomeCarouselOrderMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_CAROUSEL_ORDER_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function saveHomeCarouselOrder(rootId, orderedSectorIds) {
  const map = getHomeCarouselOrderMap();
  map[rootId] = orderedSectorIds;
  try {
    localStorage.setItem(HOME_CAROUSEL_ORDER_KEY, JSON.stringify(map));
  } catch (err) { /* storage unavailable (private mode, quota) — order just resets next load */ }
}

// Applies this browser's saved order, if any, to a root's child sectors.
// A child not present in the saved order (e.g. a sector added after the
// user last reordered) is appended at the end rather than hidden — the
// saved order is a preference over what exists today, never a filter.
function applyHomeCarouselOrder(rootId, children) {
  const saved = getHomeCarouselOrderMap()[rootId];
  if (!Array.isArray(saved) || !saved.length) return children;
  const byId = new Map(children.map((c) => [c.id, c]));
  const ordered = saved.map((id) => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map((c) => c.id));
  return [...ordered, ...children.filter((c) => !orderedIds.has(c.id))];
}

// Drag-and-drop reordering of each theme root's carousels — native HTML5
// drag/drop (no library), scoped per .home-theme-children container so
// dragging within 식용유지 never reorders into 비식용유지's list. Saves
// the new order on drop; the displayed order is only ever re-derived from
// localStorage on the next renderHome(), never mutated in place beyond
// the live DOM move during the drag itself.
function initHomeCarouselDragReorder() {
  document.querySelectorAll('.home-theme-children[data-drag-root]').forEach((container) => {
    const rootId = container.dataset.dragRoot;
    let draggedEl = null;
    container.querySelectorAll('.home-module[data-drag-sector]').forEach((mod) => {
      mod.addEventListener('dragstart', (e) => {
        draggedEl = mod;
        mod.classList.add('is-dragging');
        // Firefox refuses to start a drag unless dataTransfer carries
        // something — the payload itself is never read on drop.
        if (e.dataTransfer) e.dataTransfer.setData('text/plain', '');
      });
      mod.addEventListener('dragend', () => {
        mod.classList.remove('is-dragging');
        draggedEl = null;
        const orderedIds = [...container.querySelectorAll('.home-module[data-drag-sector]')]
          .map((el) => Number(el.dataset.dragSector));
        saveHomeCarouselOrder(rootId, orderedIds);
      });
      mod.addEventListener('dragover', (e) => {
        if (!draggedEl || draggedEl === mod) return;
        e.preventDefault();
        const rect = mod.getBoundingClientRect();
        const insertBefore = (e.clientY - rect.top) < rect.height / 2;
        container.insertBefore(draggedEl, insertBefore ? mod : mod.nextSibling);
      });
    });
  });
}

// Minimum conversation context for AI Research Search follow-ups — kept
// in memory only (module-level, not localStorage/sessionStorage), reset on
// every renderHome() (i.e. every fresh visit to Home). No persistent chat
// history by design.
let aiSearchHistory = [];

function aiSearchHtml() {
  return `<section class="ai-search" id="ai-search">
    <form id="ai-search-form">
      <input id="ai-search-input" type="text" placeholder="What are you researching?" autocomplete="off" required>
      <button type="submit" class="btn">검색</button>
    </form>
    <div id="ai-search-result"></div>
  </section>`;
}

// Controlled Markdown-ish rendering for the model's answer — never raw
// innerHTML of model text. escapeHtml() runs on every text fragment before
// any tag is added, so the model cannot inject HTML of its own; the only
// tags on the page come from this file's own template strings. Also strips
// any citation marker defensively (the system prompt forbids them, but a
// model can still slip one in) so a stray [1]/(1) never reaches the page.
function renderInlineAnswerText(line) {
  const escaped = escapeHtml(line);
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderAnswerBlock(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const headingMatch = lines.length === 1 && lines[0].match(/^#{1,4}\s+(.*)$/);
  if (headingMatch) {
    return `<h3 class="ai-answer-heading">${renderInlineAnswerText(headingMatch[1])}</h3>`;
  }
  if (lines.every((l) => /^[-•]\s+/.test(l))) {
    return `<ul class="ai-answer-list">${lines.map((l) => `<li>${renderInlineAnswerText(l.replace(/^[-•]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
    return `<ol class="ai-answer-list">${lines.map((l) => `<li>${renderInlineAnswerText(l.replace(/^\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
  }
  return `<p class="ai-answer-p">${lines.map(renderInlineAnswerText).join('<br>')}</p>`;
}

function renderAnswerHtml(rawAnswer) {
  const stripped = String(rawAnswer || '')
    .replace(/\[\d{1,2}\]/g, '')
    .replace(/\(\d{1,2}\)/g, '')
    .trim();
  const blocks = stripped.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return `<div class="ai-answer">${blocks.map(renderAnswerBlock).join('')}</div>`;
}

// Compact citation chips — title/link indicator only, no dates/URLs/
// descriptions (those stay one click away on the Detail page). The title
// and the #/detail/<id> href come only from the DB rows the server already
// returned (never parsed out of the model's text) — see
// server/routes/search.js, which builds `sources` from the same retrieved
// rows sent to the LLM. The full title is also set as a `title` attribute
// so truncation never hides it from a hovering/focused user.
//
// `s.source` (the collection-method/source-status label — e.g. "Web
// Discovery: ...", or null rendered as "미확인") deliberately isn't shown
// here: it's an internal ingestion-pipeline label, not something that
// identifies the article/report to a reader, and for Archive Discovery
// queries it can be a long internal query description rather than a
// publisher name. The field itself is untouched server-side (still part
// of the API response) — this is a display-only change.
function aiSearchSourcesHtml(sources) {
  if (!sources || !sources.length) return '';
  return `<div class="ai-search-sources">
    <div class="ai-search-sources-label">SOURCES · ${sources.length}</div>
    <div class="ai-source-chips">${sources.map((s) => `
      <a class="ai-source-chip" href="#/detail/${s.id}" title="${escapeHtml(s.title)}">
        <span class="ai-source-chip-title">${escapeHtml(s.title)}</span>
        <span class="ai-source-chip-link" aria-hidden="true">↗</span>
      </a>`).join('')}</div>
  </div>`;
}

// Rotates through status copy that reflects the actual request lifecycle
// (retrieval -> provider call -> formatting) — no fake percentage/progress
// bar, just what's genuinely happening while the one fetch is in flight.
const AI_SEARCH_STATUS_STEPS = ['Searching Research Archive', 'Analyzing relevant sources', 'Preparing evidence'];
let aiSearchStatusTimer = null;

function startAiSearchStatus(moduleEl, statusEl) {
  let i = 0;
  statusEl.textContent = AI_SEARCH_STATUS_STEPS[0];
  moduleEl.classList.add('is-searching');
  aiSearchStatusTimer = setInterval(() => {
    i = (i + 1) % AI_SEARCH_STATUS_STEPS.length;
    statusEl.textContent = AI_SEARCH_STATUS_STEPS[i];
  }, 1400);
}

function stopAiSearchStatus(moduleEl) {
  clearInterval(aiSearchStatusTimer);
  aiSearchStatusTimer = null;
  moduleEl.classList.remove('is-searching');
}

function bindAiSearchForm() {
  const form = document.getElementById('ai-search-form');
  if (!form) return;
  const moduleEl = document.getElementById('ai-search');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('ai-search-input');
    const resultEl = document.getElementById('ai-search-result');
    const submitBtn = form.querySelector('button[type="submit"]');
    const question = input.value.trim();
    if (!question) return;
    // Disable duplicate submissions while a request is already in flight.
    if (submitBtn.disabled) return;

    // Each question becomes its own turn, appended below any earlier ones —
    // a follow-up's question and answer stay visible alongside the turns
    // before it, instead of each new answer replacing the last one.
    const isFollowup = aiSearchHistory.length > 0;
    const turnEl = document.createElement('div');
    turnEl.className = 'ai-search-turn';
    turnEl.innerHTML = `
      <div class="ai-search-turn-q">${isFollowup ? '<span class="ai-search-turn-followup-tag">follow-up</span>' : '<span class="ai-search-turn-initial-tag">opening</span>'}${escapeHtml(question)}</div>
      <div class="ai-search-turn-body"><p class="ai-search-status"></p></div>
    `;
    resultEl.appendChild(turnEl);
    turnEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Cleared immediately, not just on success — otherwise the same
    // question sits visible twice while the request is in flight: once
    // still in the input box, once in the new turn's question label below.
    input.value = '';
    const bodyEl = turnEl.querySelector('.ai-search-turn-body');
    const statusEl = turnEl.querySelector('.ai-search-status');
    submitBtn.disabled = true;
    startAiSearchStatus(moduleEl, statusEl);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: aiSearchHistory }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        bodyEl.innerHTML = `<p class="meta">${escapeHtml(body.error || 'AI 검색 중 오류가 발생했습니다.')}</p>`;
        return;
      }
      aiSearchHistory.push({ role: 'user', content: question });
      aiSearchHistory.push({ role: 'assistant', content: body.answer });
      bodyEl.innerHTML = `
        ${renderAnswerHtml(body.answer)}
        ${aiSearchSourcesHtml(body.sources)}
      `;
    } catch (err) {
      bodyEl.innerHTML = '<p class="meta">AI 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>';
    } finally {
      stopAiSearchStatus(moduleEl);
      submitBtn.disabled = false;
    }
  };
}

async function renderHome() {
  aiSearchHistory = [];
  const [sectors, items, ranking] = await Promise.all([
    api('/sectors'),
    api('/items?status=Published'),
    api('/picks/ranking').catch(() => []),
  ]);
  const importantIds = new Set(ranking.map((r) => r.id));
  const savedIds = getPersonalSaveIds();
  const { byParent } = buildSectorMaps(sectors);
  const roots = (byParent.get(null) || []).filter((s) => HOME_THEME_ROOT_NAMES.includes(s.name));

  const themesHtml = roots.length
    ? roots.map((root) => homeThemeRoot(root, byParent, items, importantIds, savedIds)).join('')
    : '<p class="meta">표시할 테마가 없습니다.</p>';

  app.innerHTML = `
    <h1>Home</h1>
    <p class="page-lede">최근 유지시장의 주요 이슈를 둘러보세요.</p>
    ${aiSearchHtml()}
    ${themesHtml}
  `;

  document.querySelectorAll('.home-carousel').forEach((el) => initHomeCarousel(el));
  initHomeCarouselDragReorder();
  bindAiSearchForm();
}

async function renderArchive(query = {}) {
  // 최신 자료/전체 결과였던 두 화면을 하나의 "자료" 탭으로 통합했다 — 최신순
  // 정렬은 그대로 서버가 보장하고(items.js의 published_at DESC), 여기서는
  // 연/월 구분선만 추가한다. 뉴스(daily_report)/보고서(archive) 탭은 이
  // 통합 화면 안의 카테고리 필터로 남는다. 기본값은 두 카테고리를 모두
  // 보여주는 "전체" — 명시적으로 탭을 선택해야 좁혀진다.
  const category = query.category === 'archive' || query.category === 'daily_report' ? query.category : null;
  const itemsQuery = category ? { ...query, category } : query;
  const [sectors, usages, sources, items, ranking] = await Promise.all([
    api('/sectors'), api('/usages'), api('/sources'), api('/items?status=Published' + toQuery(itemsQuery)),
    api('/picks/ranking').catch(() => []),
  ]);
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
  // Read-only summary of what's active, shown in the always-visible compact
  // bar so the filter panel itself doesn't need to stay open to see it.
  const activeChips = [];
  if (selectedSectorIds.size) activeChips.push(`섹터 ${selectedSectorIds.size}개`);
  if (query.usage) activeChips.push((usages.find((u) => String(u.id) === String(query.usage)) || {}).name || '활용처');
  if (query.type) activeChips.push(query.type);
  if (query.source_id) activeChips.push((sources.find((s) => String(s.id) === String(query.source_id)) || {}).name || '발행처');
  if (query.from || query.to) activeChips.push(`${query.from || ''}~${query.to || ''}`);
  const activeChipsHtml = activeChips.map((c) => `<span class="pill">${c}</span>`).join('');

  const importantIds = new Set(ranking.map((r) => r.id));
  const savedIds = getPersonalSaveIds();

  // Archive view tabs — a separate axis from the sector taxonomy filters,
  // never mixed into the same query params those use. Purely a client-side
  // filter over the already-fetched Published items: "내 저장" intersects
  // with this browser's localStorage save set, "팀 Pick" intersects with
  // the existing server-side team-pick ranking (importantIds).
  const view = query.view === 'saved' || query.view === 'team' ? query.view : 'all';
  const visibleItems = view === 'saved' ? items.filter((it) => savedIds.has(it.id))
    : view === 'team' ? items.filter((it) => importantIds.has(it.id))
    : items;
  const viewTabs = [
    { key: 'all', label: '전체' },
    { key: 'saved', label: '내 저장' },
    { key: 'team', label: '팀 Pick' },
  ];
  const tabQuery = (key) => toQuery({ ...query, view: key === 'all' ? '' : key }).slice(1);
  const viewTabsHtml = viewTabs.map((t) =>
    `<a class="archive-tab ${view === t.key ? 'active' : ''}" href="#/archive?${tabQuery(t.key)}">${t.label}</a>`
  ).join('');

  const categoryTabs = [
    { key: null, label: '전체' },
    { key: 'daily_report', label: '뉴스' },
    { key: 'archive', label: '보고서' },
  ];
  const categoryTabQuery = (key) => toQuery({ ...query, category: key || '' }).slice(1);
  const categoryTabsHtml = categoryTabs.map((t) =>
    `<a class="archive-tab ${category === t.key ? 'active' : ''}" href="#/archive?${categoryTabQuery(t.key)}">${t.label}</a>`
  ).join('');

  const emptyState = visibleItems.length
    ? ''
    : `<div class="archive-empty">
        <strong>결과가 없습니다</strong>
        ${view === 'saved' ? '아직 저장한 자료가 없습니다.' : view === 'team' ? '아직 팀 Pick이 없습니다.' : hasActiveFilters ? '선택한 필터 조건에 맞는 자료가 아직 없습니다. 필터를 조정해보세요.' : '아직 발행된 자료가 없습니다.'}
      </div>`;

  app.innerHTML = `
    <h1>자료</h1>
    <p class="page-lede">발행된 유지 시장 리서치를 최신순으로 모아봅니다. 뉴스/보고서 탭과 필터로 좁혀볼 수 있습니다.</p>
    ${TRUST_GRADE_EXPLANATION_HTML}
    <div class="archive-tabs category-tabs">${categoryTabsHtml}</div>
    <div class="archive-tabs">${viewTabsHtml}</div>
    <div class="archive">
      <div class="archive-search-bar">
        <input id="f-q" placeholder="검색" value="${query.q || ''}">
        <div class="archive-active-chips">${activeChipsHtml}</div>
        <button class="btn filter-toggle-btn" id="filter-toggle-btn" type="button" aria-expanded="${hasActiveFilters}">
          필터${activeChips.length ? ` <span class="pill">${activeChips.length}</span>` : ''}
        </button>
      </div>
      <div class="archive-filter-panel ${hasActiveFilters ? 'is-open' : ''}" id="filter-panel">
        <div class="filters">
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

      <div class="section">
        <div class="section-header"><h2>자료</h2><span class="count">${visibleItems.length}개</span></div>
        ${emptyState}
        ${groupByMonth(visibleItems).map((g) => `
          <div class="archive-month-divider">${g.label}</div>
          <div class="grid">${g.items.map((it) => itemCard(it, importantIds, savedIds)).join('')}</div>
        `).join('')}
      </div>
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
      // Preserve whichever Archive/Daily Report tab is currently active —
      // applying a sector/date filter must not silently snap back to Archive.
      category: category || '',
    }).slice(1);
  };
  document.getElementById('f-clear').onclick = () => { location.hash = '#/archive'; };

  const filterPanel = document.getElementById('filter-panel');
  const filterToggleBtn = document.getElementById('filter-toggle-btn');
  filterToggleBtn.onclick = () => {
    const willOpen = !filterPanel.classList.contains('is-open');
    filterPanel.classList.toggle('is-open', willOpen);
    filterToggleBtn.setAttribute('aria-expanded', String(willOpen));
  };
  // Enter in the always-visible search box applies immediately, without
  // requiring the detail panel to be open.
  document.getElementById('f-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('f-apply').click();
  });
}

// Groups already-sorted (published_at DESC) items into consecutive
// year-month buckets for the merged 자료 tab's date dividers. Assumes the
// input order from the API is preserved — it only detects where the
// year-month changes, it never re-sorts.
function groupByMonth(items) {
  const groups = [];
  let currentKey = null;
  for (const it of items) {
    const d = it.published_at ? new Date(it.published_at) : null;
    const valid = d && !isNaN(d.getTime());
    const key = valid ? `${d.getFullYear()}-${d.getMonth()}` : 'unknown';
    if (key !== currentKey) {
      groups.push({ label: valid ? `${d.getFullYear()}년 ${d.getMonth() + 1}월` : '날짜 미확인', items: [] });
      currentKey = key;
    }
    groups[groups.length - 1].items.push(it);
  }
  return groups;
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
    email = (prompt('팀 Pick은 이메일로 구분됩니다. 이메일을 입력해주세요:') || '').trim();
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
  const isSaved = getPersonalSaveIds().has(item.id);
  const myTeamPick = myEmail ? picks.find((p) => p.kind === 'team' && p.user_email === myEmail) : null;
  const teamPickCount = picks.filter((p) => p.kind === 'team').length;

  app.innerHTML = `
    <div class="detail">
      <div class="detail-meta-row">
        ${typeTag(item.type)}<span class="pill">${item.trust_grade || 'A'}</span>
        <span class="detail-meta-sep">·</span>
        <span class="meta">${formatDateOnly(item.published_at)} · ${item.source_name || ''}</span>
      </div>
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
        <button class="btn compact-save-btn ${isSaved ? 'is-saved' : ''}" id="personal-pick-btn">${isSaved ? '★ 저장됨' : '☆ 저장'}</button>
        <button class="btn ${myTeamPick ? 'primary' : ''}" id="team-pick-btn">${myTeamPick ? '팀 Pick 취소' : '팀 Pick 저장'}</button>
        <span class="meta">팀 Pick ${teamPickCount}명</span>
        <button class="btn" id="delete-item-btn" style="margin-left:auto;color:#b91c1c">삭제</button>
      </div>
      ${related.length ? `
        <div class="section">
          <h2>관련 자료</h2>
          <div class="grid">${related.map((it) => itemCard(it)).join('')}</div>
        </div>
      ` : ''}
    </div>
  `;

  document.getElementById('personal-pick-btn').onclick = () => {
    setPersonalSaveIds(toggleSavedId(getPersonalSaveIds(), item.id));
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

// Reference Source Library v1: a separate, client-side filtered view over
// the same `sources` table (is_reference=true) — no parallel source system,
// same convention renderArchive() already uses for its 전체/내 저장/팀 Pick
// tabs (a view axis, not a new query param). Reference sources are never
// collected (method stays 'manual'), so this table shows cataloging fields
// instead of ingestion-status ones.
// Each sector_links entry ({sector, label, url}) renders as its own
// clickable link, never collapsed into one generic name->url link — the
// whole point is that a single institution can expose several verified
// sector/commodity-specific pages (MPOB's production vs. export statistics,
// for instance), and a reviewer needs to reach the RIGHT one directly.
function sectorLinksHtml(sectorLinks) {
  if (!sectorLinks || !sectorLinks.length) return '-';
  return sectorLinks.map((l) =>
    `<a class="pill" href="${l.url}" target="_blank" title="${l.sector}">${l.label}</a>`
  ).join(' ');
}

// Distinct 지역/품목 values actually present among Reference Sources —
// drives the filter dropdowns below so they only ever offer choices that
// can return a result, rather than a fixed static list that drifts out of
// sync with what's actually been catalogued.
function referenceFilterOptions(sources) {
  const refs = sources.filter((s) => s.is_reference);
  const regions = Array.from(new Set(refs.map((s) => s.region).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const commodities = Array.from(new Set(refs.flatMap((s) => s.commodities || []))).sort((a, b) => a.localeCompare(b));
  return { regions, commodities };
}

function referenceSourcesTable(sources, filters = {}) {
  let refs = sources.filter((s) => s.is_reference);
  if (filters.region) refs = refs.filter((s) => s.region === filters.region);
  if (filters.commodity) refs = refs.filter((s) => (s.commodities || []).includes(filters.commodity));
  if (!refs.length) return '<p class="meta">조건에 맞는 Reference Source가 없습니다.</p>';
  return `<table class="sources-table">
    <tr><th>이름</th><th>유형</th><th>지역</th><th>품목</th><th>커버리지</th><th>섹터별 링크</th><th>접근형식</th><th>업데이트 주기</th><th>RSS</th><th>최종 검증일</th><th>비고</th><th></th></tr>
    ${refs.map((s) => `<tr>
      <td class="cell-strong">${s.name}</td>
      <td class="cell-muted">${s.source_type || '-'}</td>
      <td class="cell-muted">${s.region || '-'}</td>
      <td class="cell-muted">${(s.commodities || []).join(', ') || '-'}</td>
      <td class="cell-muted">${s.coverage_note || '-'}</td>
      <td class="cell-muted">${sectorLinksHtml(s.sector_links)}</td>
      <td class="cell-muted">${(s.access_format || []).join(', ') || '-'}</td>
      <td class="cell-muted">${s.update_frequency || '-'}</td>
      <td class="cell-muted">${s.rss_available ? '있음' : '없음'}</td>
      <td class="cell-muted">${s.last_verified_at ? new Date(s.last_verified_at).toLocaleDateString() : '-'}</td>
      <td class="cell-muted">${s.usage_note || '-'}</td>
      <td>
        <button class="btn-text-action" data-edit-source="${s.id}">편집</button>
        <button class="btn-text-action" data-delete-source="${s.id}">삭제</button>
      </td>
    </tr>`).join('')}
  </table>`;
}

// One {sector,label,url} row in the add/edit form's dynamic sector-links
// sub-form (see renderSources).
function sectorLinkRowHtml(link = {}) {
  return `<div class="sector-link-row" style="display:flex;gap:6px;margin-bottom:4px">
    <input class="sl-sector" placeholder="섹터 (예: 팜유 생산 통계)" value="${link.sector || ''}" style="flex:1">
    <input class="sl-label" placeholder="라벨 (예: Monthly Production)" value="${link.label || ''}" style="flex:1">
    <input class="sl-url" placeholder="URL (기관 사이트의 해당 섹터 전용 페이지)" value="${link.url || ''}" style="flex:2">
    <button type="button" class="btn-text-action sl-remove">삭제</button>
  </div>`;
}

// Shared by the Sources tab (view='all') and the 레퍼런스 tab
// (view='reference') — both manage rows in the same `sources` table
// (is_reference flag), just scoped to a top-level route each now rather
// than a view-tab switcher within one page.
async function renderSourceManager(view, query = {}) {
  const sources = await api('/sources');

  const refFilterOptions = referenceFilterOptions(sources);
  const refRegionOpts = refFilterOptions.regions.map((r) => `<option value="${r}" ${query.region === r ? 'selected' : ''}>${r}</option>`).join('');
  const refCommodityOpts = refFilterOptions.commodities.map((c) => `<option value="${c}" ${query.commodity === c ? 'selected' : ''}>${c}</option>`).join('');

  app.innerHTML = `
    <h1>${view === 'reference' ? '레퍼런스' : 'Sources'}</h1>
    <p class="page-lede">${view === 'reference' ? '자동 수집 대상이 아니더라도 참고 가치가 높은 유지 시장 리서치/통계 출처를 기록합니다.' : 'RSS 수집 소스 상태를 관리합니다.'}</p>
    ${view === 'all' ? `<button class="btn primary btn-compact" id="collect-all-btn">전체 자료 지금 수집</button>
    <div class="collect-all-result" id="collect-all-result"></div>
    <table class="sources-table">
      <tr><th>이름</th><th>수집방식</th><th>오너</th><th>주기(일)</th><th>신뢰등급</th><th>마지막 수집</th><th>상태</th><th></th></tr>
      ${sources.map((s) => `<tr>
        <td class="cell-strong">${s.name}${s.is_reference ? ' <span class="pill">Reference</span>' : ''}</td><td class="cell-muted">${s.method}</td><td class="cell-muted">${s.owner || '-'}</td><td class="cell-muted">${s.frequency_days}</td>
        <td class="cell-muted">${s.trust_grade}</td><td class="cell-muted">${s.last_collected_at ? new Date(s.last_collected_at).toLocaleDateString() : '-'}</td>
        <td>${s.is_reference ? '<span class="pill">참고용</span>' : (s.last_error ? `<span class="status-fail" title="${s.last_error}">실패</span>` : (s.stale ? '<span class="status-fail">Stale</span>' : '<span class="status-ok">OK</span>'))}</td>
        <td><button class="btn-text-action" data-delete-source="${s.id}">삭제</button></td>
      </tr>`).join('')}
    </table>` : `
    <div class="filters" id="ref-filters">
      <select id="ref-f-region"><option value="">지역 전체</option>${refRegionOpts}</select>
      <select id="ref-f-commodity"><option value="">품목 전체</option>${refCommodityOpts}</select>
      <button class="btn" id="ref-f-clear">초기화</button>
    </div>
    <div id="ref-sources-result">${referenceSourcesTable(sources, { region: query.region, commodity: query.commodity })}</div>
    `}

    <details class="section" id="s-form-section">
      <summary id="s-form-summary">소스 추가</summary>
      <input type="hidden" id="s-edit-id">
      <div class="form-row"><label>이름</label><input id="s-name"></div>
      <div class="form-row"><label>
        <input type="checkbox" id="s-is-reference" ${view === 'reference' ? 'checked' : ''}> Reference Source (자동 수집 없이 참고용으로만 등록)
      </label></div>
      <div class="form-row"><label>수집방식</label>
        <select id="s-method"><option value="manual">manual</option><option value="rss">rss (자동 수집)</option><option value="institution">institution (기관 보고서 PDF 자동 수집)</option><option value="structured">structured (통계 데이터 자동 수집)</option><option value="crawl">crawl</option></select>
      </div>
      <div class="form-row"><label>URL (일반/대표 링크. rss는 피드 URL)</label><input id="s-url"></div>
      <div class="form-row"><label>오너</label><input id="s-owner"></div>
      <div class="form-row"><label>수집 주기(일)</label><input id="s-freq" type="number" value="1"></div>
      <div class="form-row"><label>유형 (예: 정부/국제기구 통계, 거래소/가격데이터)</label><input id="s-type"></div>
      <div class="form-row"><label>지역/국가</label><input id="s-region"></div>
      <div class="form-row"><label>품목 (쉼표 구분, 예: 팜유,대두유)</label><input id="s-commodities"></div>
      <div class="form-row"><label>데이터/보고서 커버리지</label><input id="s-coverage"></div>
      <div class="form-row">
        <label>섹터별 링크 (기관 사이트 내 품목/섹터 전용 페이지 — 홈페이지가 아닌 검증된 세부 페이지)</label>
        <div id="s-sector-links"></div>
        <button type="button" class="btn-text" id="s-sector-link-add">+ 링크 추가</button>
      </div>
      <div class="form-row"><label>접근형식 (쉼표 구분: web,PDF,XLSX,CSV,API,RSS)</label><input id="s-access-format"></div>
      <div class="form-row"><label>업데이트 주기 (예: Monthly, Weekly)</label><input id="s-update-freq"></div>
      <div class="form-row"><label>
        <input type="checkbox" id="s-rss-available"> RSS 제공 여부
      </label></div>
      <div class="form-row"><label>최종 검증일</label><input id="s-last-verified" type="date"></div>
      <div class="form-row"><label>비고 / 활용 노트</label><input id="s-usage-note"></div>
      <button class="btn primary" id="s-add">추가</button>
      <button class="btn" id="s-cancel-edit" style="display:none">취소</button>
    </details>

    ${view === 'all' ? collectionWarningHtml(sources) : ''}
  `;
  const collectAllBtn = document.getElementById('collect-all-btn');
  if (collectAllBtn) {
    collectAllBtn.onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '수집 중...';
      let resultText = '';
      try {
        const { totals } = await api('/sources/collect-all', { method: 'POST' });
        resultText = `수집 완료 — 조회 ${totals.fetched} / 중복 ${totals.duplicates} / 필터됨 ${totals.filtered} / 신규 ${totals.newItems} / 실패 소스 ${totals.failedSources}`;
      } catch (err) {
        alert(`수집 실패: ${err.message}`);
      }
      await renderSourceManager(view, query);
      if (resultText) document.getElementById('collect-all-result').textContent = resultText;
    };
  }
  // Reference Sources 지역/품목 필터 — re-renders only the result table
  // in place (no refetch, no hash navigation) so narrowing down a long
  // list stays instant.
  const refRegionSel = document.getElementById('ref-f-region');
  const refCommoditySel = document.getElementById('ref-f-commodity');
  const refClearBtn = document.getElementById('ref-f-clear');
  if (refRegionSel && refCommoditySel) {
    const applyRefFilters = () => {
      document.getElementById('ref-sources-result').innerHTML = referenceSourcesTable(sources, {
        region: refRegionSel.value,
        commodity: refCommoditySel.value,
      });
      bindReferenceSourceRowActions();
    };
    refRegionSel.onchange = applyRefFilters;
    refCommoditySel.onchange = applyRefFilters;
    if (refClearBtn) {
      refClearBtn.onclick = () => {
        refRegionSel.value = '';
        refCommoditySel.value = '';
        applyRefFilters();
      };
    }
  }
  const sectorLinksContainer = document.getElementById('s-sector-links');
  function addSectorLinkRow(link) {
    sectorLinksContainer.insertAdjacentHTML('beforeend', sectorLinkRowHtml(link));
    const row = sectorLinksContainer.lastElementChild;
    row.querySelector('.sl-remove').onclick = () => row.remove();
  }
  document.getElementById('s-sector-link-add').onclick = () => addSectorLinkRow();

  function collectSectorLinks() {
    return [...sectorLinksContainer.querySelectorAll('.sector-link-row')]
      .map((row) => ({
        sector: row.querySelector('.sl-sector').value.trim(),
        label: row.querySelector('.sl-label').value.trim(),
        url: row.querySelector('.sl-url').value.trim(),
      }))
      .filter((l) => l.sector && l.label && l.url);
  }

  function resetForm() {
    document.getElementById('s-edit-id').value = '';
    document.getElementById('s-form-summary').textContent = '소스 추가';
    document.getElementById('s-add').textContent = '추가';
    document.getElementById('s-cancel-edit').style.display = 'none';
    ['s-name', 's-url', 's-owner', 's-type', 's-region', 's-commodities', 's-coverage',
      's-access-format', 's-update-freq', 's-last-verified', 's-usage-note'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('s-method').value = 'manual';
    document.getElementById('s-freq').value = '1';
    document.getElementById('s-is-reference').checked = view === 'reference';
    document.getElementById('s-rss-available').checked = false;
    sectorLinksContainer.innerHTML = '';
  }

  // Shared between the initial render and the Reference Sources filter's
  // in-place re-render (filtering replaces #ref-sources-result's innerHTML,
  // which drops any listeners bound to the old nodes) — re-wires both
  // 편집/삭제 against whatever [data-edit-source]/[data-delete-source]
  // buttons currently exist in the DOM.
  function bindReferenceSourceRowActions() {
    document.querySelectorAll('[data-delete-source]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('이 소스를 삭제하시겠습니까? 기존에 수집된 자료는 유지됩니다.')) return;
        try {
          await api(`/sources/${btn.dataset.deleteSource}`, { method: 'DELETE' });
        } catch (err) {
          alert(`삭제 실패: ${err.message}`);
          return;
        }
        renderSourceManager(view, query);
      };
    });
    document.querySelectorAll('[data-edit-source]').forEach((btn) => {
      btn.onclick = () => {
        const s = sources.find((row) => String(row.id) === btn.dataset.editSource);
        if (!s) return;
        document.getElementById('s-form-section').open = true;
        document.getElementById('s-edit-id').value = s.id;
        document.getElementById('s-form-summary').textContent = `소스 편집 — ${s.name}`;
        document.getElementById('s-add').textContent = '저장';
        document.getElementById('s-cancel-edit').style.display = '';
        document.getElementById('s-name').value = s.name || '';
        document.getElementById('s-method').value = s.method || 'manual';
        document.getElementById('s-url').value = s.url || '';
        document.getElementById('s-owner').value = s.owner || '';
        document.getElementById('s-freq').value = s.frequency_days || 1;
        document.getElementById('s-is-reference').checked = Boolean(s.is_reference);
        document.getElementById('s-type').value = s.source_type || '';
        document.getElementById('s-region').value = s.region || '';
        document.getElementById('s-commodities').value = (s.commodities || []).join(',');
        document.getElementById('s-coverage').value = s.coverage_note || '';
        document.getElementById('s-access-format').value = (s.access_format || []).join(',');
        document.getElementById('s-update-freq').value = s.update_frequency || '';
        document.getElementById('s-rss-available').checked = Boolean(s.rss_available);
        document.getElementById('s-last-verified').value = s.last_verified_at ? s.last_verified_at.slice(0, 10) : '';
        document.getElementById('s-usage-note').value = s.usage_note || '';
        sectorLinksContainer.innerHTML = '';
        (s.sector_links || []).forEach((link) => addSectorLinkRow(link));
        document.getElementById('s-form-section').scrollIntoView({ behavior: 'smooth' });
      };
    });
  }
  bindReferenceSourceRowActions();
  document.getElementById('s-cancel-edit').onclick = () => resetForm();

  document.getElementById('s-add').onclick = async () => {
    const commodities = document.getElementById('s-commodities').value
      .split(',').map((v) => v.trim()).filter(Boolean);
    const accessFormat = document.getElementById('s-access-format').value
      .split(',').map((v) => v.trim()).filter(Boolean);
    const payload = {
      name: document.getElementById('s-name').value,
      method: document.getElementById('s-method').value,
      url: document.getElementById('s-url').value,
      owner: document.getElementById('s-owner').value,
      frequency_days: Number(document.getElementById('s-freq').value) || 1,
      is_reference: document.getElementById('s-is-reference').checked,
      source_type: document.getElementById('s-type').value || null,
      region: document.getElementById('s-region').value || null,
      commodities,
      coverage_note: document.getElementById('s-coverage').value || null,
      sector_links: collectSectorLinks(),
      access_format: accessFormat,
      update_frequency: document.getElementById('s-update-freq').value || null,
      rss_available: document.getElementById('s-rss-available').checked,
      last_verified_at: document.getElementById('s-last-verified').value || null,
      usage_note: document.getElementById('s-usage-note').value || null,
    };
    const editId = document.getElementById('s-edit-id').value;
    if (editId) {
      await api(`/sources/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/sources', { method: 'POST', body: JSON.stringify(payload) });
    }
    renderSourceManager(view, query);
  };
}

async function renderSources(query = {}) { return renderSourceManager('all', query); }
async function renderReference(query = {}) { return renderSourceManager('reference', query); }

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

// 리뷰어가 아직 적합/비적합을 확정하지 않은 항목 — "판단 미완료" 그룹을
// 상단에 띄우는 기준. reviewer_eligible은 "적합으로 확정"/"비적합으로
// 확정" 버튼을 눌러야만 true/false가 되고, 그 전까지는 null.
function isReviewerPending(d) {
  return d.reviewer_eligible === null || d.reviewer_eligible === undefined;
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

// First-visit-only usage guide card for the Review screen specifically —
// unlike the nav tour (which only names what each top-level tab is), this
// walks through the actual Review workflow once a user has landed here,
// since it's the most operationally involved screen. Shown once per
// browser (localStorage flag), same convention as ONBOARDING_SEEN_KEY, and
// stays dismissible afterward via its own close button rather than
// disappearing automatically.
const REVIEW_TIP_SEEN_KEY = 'ra_review_tip_seen';
function reviewTipCardHtml() {
  if (localStorage.getItem(REVIEW_TIP_SEEN_KEY)) return '';
  return `
    <div class="review-tip-card" id="review-tip-card">
      <button type="button" class="review-tip-close" id="review-tip-close" aria-label="안내 닫기">✕</button>
      <h3>Review 사용 가이드</h3>
      <p class="review-tip-purpose">AI가 자동으로 수집·판단한 초안은 가끔 틀립니다 — Review는 발행 전 사람이 직접 적합성을 검수하는 단계입니다. 내가 AI 판단을 뒤집은 사례는 주제가 비슷한 새 기사를 판단할 때 AI에게 참고 자료로 우선 제공되어, 검수가 쌓일수록 관련 주제의 AI 판단이 점점 보정됩니다.</p>
      <ol>
        <li>상단 드롭다운에서 검토할 Draft를 선택하세요 (판단 미완료가 먼저 보여요).</li>
        <li>AI 판단을 확인하고, "적합으로 확정"/"비적합으로 확정"으로 내 판단을 남기세요 — 같은 버튼을 다시 누르면 선택이 해제됩니다.</li>
        <li>필요하면 요약/인사이트/섹터/활용처를 직접 수정하세요.</li>
        <li>준비되면 "자료 발행"을 눌러 공개합니다.</li>
      </ol>
    </div>
  `;
}

async function renderReview() {
  const [draftsRaw, sectors, usages, sources] = await Promise.all([
    api('/items?status=Draft'), api('/sectors'), api('/usages'), api('/sources'),
  ]);
  const drafts = [...draftsRaw].sort((a, b) => {
    const pendingDiff = (isReviewerPending(a) ? 0 : 1) - (isReviewerPending(b) ? 0 : 1);
    if (pendingDiff !== 0) return pendingDiff;
    return reviewPriority(a) - reviewPriority(b);
  });

  // Comparison view: only Drafts the reviewer has actually confirmed/
  // overridden (reviewer_eligible is not null) are shown — an unreviewed
  // item has nothing to compare yet. Read-only, no new DB columns; purely
  // derived from the existing ai_eligible/reviewer_eligible fields.
  const reviewed = drafts
    .map((d) => ({ ...d, match: classifyEligibilityMatch(d.ai_eligible, d.reviewer_eligible) }))
    .filter((d) => d.match !== null);
  // Collapsed by default via the native <details> element — no extra JS
  // state or event wiring needed, and it degrades to a plain toggle.
  const comparisonSection = reviewed.length
    ? `<details class="section review-comparison">
        <summary>AI vs 리뷰어 적합성 비교</summary>
        <table>
          <tr><th>제목</th><th>AI 판단</th><th>리뷰어 판단</th><th>결과</th></tr>
          ${reviewed.map((d) => `<tr>
            <td><a href="#/detail/${d.id}">${d.title}</a></td>
            <td>${eligibilityLabel(d.ai_eligible)}</td>
            <td>${eligibilityLabel(d.reviewer_eligible)}</td>
            <td>${MATCH_LABELS[d.match]}</td>
          </tr>`).join('')}
        </table>
      </details>`
    : '';

  app.innerHTML = `
    <h1>Review</h1>
    <p class="page-lede">AI가 자동으로 수집·판단한 초안을 발행 전에 사람이 직접 검수해, 적합성 판단의 정확도를 보장하는 화면입니다.<br>내가 AI 판단을 뒤집은 사례는 주제가 비슷한 새 기사를 판단할 때 AI에게 우선 참고 자료로 제공되어, 검수가 쌓일수록 관련 주제의 AI 판단이 보정됩니다.</p>
    ${reviewTipCardHtml()}
    <div class="review-toolbar">
      <select id="draft-select">
        ${(() => {
          const draftOptionHtml = (d) => `<option value="${d.id}">${d.ai_eligible === false ? '⚠ ' : ''}${d.title}</option>`;
          const pendingDrafts = drafts.filter(isReviewerPending);
          const completedDrafts = drafts.filter((d) => !isReviewerPending(d));
          if (!drafts.length) return '<option>Draft 없음</option>';
          return [
            pendingDrafts.length ? `<optgroup label="판단 미완료 (${pendingDrafts.length})">${pendingDrafts.map(draftOptionHtml).join('')}</optgroup>` : '',
            completedDrafts.length ? `<optgroup label="판단 완료 (${completedDrafts.length})">${completedDrafts.map(draftOptionHtml).join('')}</optgroup>` : '',
          ].join('');
        })()}
      </select>
      <button class="btn" id="prev-draft-btn" type="button">← 이전</button>
      <button class="btn" id="next-draft-btn" type="button">다음 →</button>
      <button class="btn" id="new-draft">새 자료 수동 등록</button>
    </div>
    <div id="review-body"></div>
    ${comparisonSection}
  `;
  const reviewTipCloseBtn = document.getElementById('review-tip-close');
  if (reviewTipCloseBtn) {
    reviewTipCloseBtn.onclick = () => {
      localStorage.setItem(REVIEW_TIP_SEEN_KEY, '1');
      document.getElementById('review-tip-card').remove();
    };
  }
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
          <div class="review-pane">
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
          <div class="review-pane">
            <div class="form-row"><label>핵심 요약</label><textarea id="d-summary" rows="4"></textarea></div>
            <div class="form-row"><label>인사이트</label><textarea id="d-insight" rows="4"></textarea></div>
            <div class="form-row"><label>섹터</label><div class="chiplist" id="d-sectors">${sectorChips}</div></div>
            <div class="form-row"><label>활용처</label><div class="chiplist" id="d-usages">${usageChips}</div></div>
            <div style="display:flex;gap:6px">
              <button class="btn" id="d-ai-draft" type="button">AI 초안 작성</button>
              <button class="btn primary" id="d-save">Draft 저장</button>
            </div>
            <div class="meta" id="d-ai-draft-status"></div>
          </div>
        </div>
      `;
      bindChips(document.getElementById('d-sectors'), []);
      bindChips(document.getElementById('d-usages'), []);
      // body_text (article paragraph text, not shown in any field) is kept
      // only so the AI 초안 작성 button below can give the model something
      // more substantial to work from than the often one-line og:description
      // — that thinness was the root cause of weak title/summary/insight
      // output, not the AI prompt itself.
      let extractedBodyText = null;
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
          extractedBodyText = meta.body_text || null;
          status.textContent = '메타데이터를 가져왔습니다. 확인 후 필요하면 수정하세요.';
        } catch (err) {
          status.textContent = `자동 추출 실패: ${err.message} — 직접 입력해주세요.`;
        }
      };
      function currentFormPayload() {
        return {
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
        };
      }
      document.getElementById('d-save').onclick = async () => {
        await api('/items', { method: 'POST', body: JSON.stringify(currentFormPayload()) });
        renderReview();
      };
      // Creates the Draft row (AI generation needs an existing item id),
      // runs AI draft generation against it, then reopens it via loadDraft
      // so the normal AI box renders — then auto-applies the suggestions
      // (same effect as clicking "AI 제안 전체 적용") so summary/insight/
      // sector/usage are filled in from one click, per the requested flow.
      document.getElementById('d-ai-draft').onclick = async () => {
        const btn = document.getElementById('d-ai-draft');
        const status = document.getElementById('d-ai-draft-status');
        if (!document.getElementById('d-title').value || !document.getElementById('d-url').value) {
          status.textContent = '제목과 원문 URL을 먼저 입력하세요.';
          return;
        }
        btn.disabled = true;
        status.textContent = 'AI 초안 작성 중... (최대 2-3분 소요될 수 있습니다)';
        try {
          const created = await api('/items', { method: 'POST', body: JSON.stringify(currentFormPayload()) });
          await triggerAiDraftAndPoll(created.id, { extracted_text: extractedBodyText || undefined });
          await loadDraft(created.id);
          const applyTextBtn = document.getElementById('ai-apply-text-btn');
          if (applyTextBtn) applyTextBtn.click();
          const applyAllBtn = document.getElementById('ai-apply-all-btn');
          if (applyAllBtn) applyAllBtn.click();
        } catch (err) {
          status.textContent = `AI 초안 작성 실패: ${err.message}`;
          btn.disabled = false;
        }
      };
      return;
    }
    const item = await api(`/items/${id}`);

    function renderAiBox() {
      if (item.ai_status === 'pending') {
        return `<div class="review-section"><div class="review-subhead">AI 판단</div><p class="review-status-text">생성 중...</p></div>`;
      }
      if (item.ai_status === 'failed') {
        return `<div class="review-section">
          <div class="review-subhead">AI 판단</div>
          <p class="review-status-text">초안을 생성하지 못했습니다. 원문을 확인해 직접 작성할 수 있습니다.</p>
          <button class="btn-text" id="ai-retry-btn" type="button">다시 시도</button>
        </div>`;
      }
      if (item.ai_status === 'completed') {
        const sectorChipsAi = (item.ai_suggested_sectors || [])
          .map((sid) => sectorById.get(sid))
          .filter(Boolean)
          .map((s) => `<span class="chip ai-suggested" data-apply-sector="${s.id}">${s.name}</span>`)
          .join('') || '<span class="review-status-text">제안 없음</span>';
        const usageChipsAi = (item.ai_suggested_usages || [])
          .map((uid) => usageById.get(uid))
          .filter(Boolean)
          .map((u) => `<span class="chip ai-suggested" data-apply-usage="${u.id}">${u.name}</span>`)
          .join('') || '<span class="review-status-text">제안 없음</span>';
        const verdictClass = item.ai_eligible === false ? 'is-ineligible' : item.ai_eligible === true ? 'is-eligible' : 'is-unknown';
        const verdictLabel = item.ai_eligible === false ? '비적합' : item.ai_eligible === true ? '적합' : '판단 없음';
        const reviewerStatus = item.reviewer_eligible === true
          ? '확인 완료'
          : item.reviewer_eligible === false
            ? '확인 완료'
            : '미확인';
        return `
          <div class="review-section">
            <div class="review-section-title-row">
              <span class="review-subhead">AI 판단</span>
              <button class="btn-text" id="ai-retry-btn" type="button">다시 생성</button>
            </div>
            <div class="verdict-badge ${verdictClass}">${verdictLabel}</div>
            <p class="review-body-text">${item.ai_eligibility_reason || ''}</p>
          </div>
          <div class="review-my-decision">
            <div class="review-subhead">내 판단</div>
            <div class="review-verdict-actions">
              <button class="decision-btn ${item.reviewer_eligible === true ? 'is-selected' : ''}" id="reviewer-eligible-confirm-btn" type="button">적합으로 확정</button>
              <button class="decision-btn ${item.reviewer_eligible === false ? 'is-selected' : ''}" id="reviewer-eligible-override-btn" type="button">비적합으로 확정</button>
              <span class="review-status-text">${reviewerStatus}</span>
            </div>
          </div>
          <div class="review-divider"></div>
          <div class="review-section">
            <div class="review-section-title">AI 요약</div>
            <p class="review-body-text">${item.ai_summary || ''}</p>
          </div>
          <div class="review-divider"></div>
          <div class="review-section">
            <div class="review-section-title">AI 인사이트</div>
            <p class="review-body-text review-insight-text">${item.ai_insight || ''}</p>
            <button class="btn-text" id="ai-apply-text-btn" type="button">핵심요약·인사이트 반영 →</button>
          </div>
          <div class="review-divider"></div>
          <div class="review-section">
            <div class="review-section-title">분류 제안</div>
            <div class="chiplist">${sectorChipsAi}</div>
            <div class="chiplist" style="margin-top:6px">${usageChipsAi}</div>
            <button class="btn-text" id="ai-apply-all-btn" type="button">분류 제안 전체 적용</button>
          </div>`;
      }
      // not_requested
      return `<div class="review-section">
        <div class="review-subhead">AI 판단</div>
        <p class="review-status-text">아직 AI 초안이 생성되지 않았습니다.</p>
        <button class="btn-text" id="ai-retry-btn" type="button">AI 초안 생성</button>
      </div>`;
    }

    document.getElementById('review-body').innerHTML = `
      <div class="review-source">
        <div class="review-meta-row">${item.source_name || ''} · ${formatDateOnly(item.published_at)}${item.trust_grade ? ` · ${item.trust_grade}` : ''}</div>
        <h2 class="review-article-title">${item.title}</h2>
        <a class="btn-text review-source-url" href="${item.source_url}" target="_blank">${item.source_url} ↗</a>
      </div>
      <div class="review-layout">
        <div class="review-pane">
          ${renderAiBox()}
        </div>
        <div class="review-pane">
          <div class="review-section">
            <div class="review-section-title">핵심 요약</div>
            <textarea id="d-summary" rows="4">${item.summary || ''}</textarea>
          </div>
          <div class="review-section">
            <div class="review-section-title">인사이트</div>
            <textarea id="d-insight" rows="3">${item.insight || ''}</textarea>
          </div>
          <div class="review-section">
            <div class="review-section-title">섹터</div>
            <div class="chiplist" id="d-sectors">${sectorChips}</div>
          </div>
          <div class="review-section">
            <div class="review-section-title">활용처</div>
            <div class="chiplist" id="d-usages">${usageChips}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn primary btn-publish" id="d-publish" style="flex:1;width:auto">자료 발행</button>
            <button class="btn" id="d-delete" type="button" style="flex:0 0 auto;white-space:nowrap;height:var(--ctrl-lg);margin-top:var(--sp-4)">삭제</button>
          </div>
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
    // Text (핵심요약/인사이트) and classification (섹터/활용처) are reflected
    // into the right-hand editable pane by two separate buttons — each
    // readable as its own action, and each individually re-runnable (e.g.
    // applying classification without overwriting an already-edited summary).
    const applyTextBtn = document.getElementById('ai-apply-text-btn');
    if (applyTextBtn) {
      applyTextBtn.onclick = () => {
        if (item.ai_summary) document.getElementById('d-summary').value = item.ai_summary;
        if (item.ai_insight) document.getElementById('d-insight').value = item.ai_insight;
      };
    }
    const applyAllBtn = document.getElementById('ai-apply-all-btn');
    if (applyAllBtn) {
      applyAllBtn.onclick = () => {
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
          await triggerAiDraftAndPoll(id);
        } catch (err) {
          // sanitized message already; just surface it and let the reload show state
        }
        loadDraft(id);
      };
    }

    // Updates the verdict buttons/status text in place rather than calling
    // loadDraft(id) — a full reload re-fetches the item and rebuilds the
    // right-hand pane from its (unsaved) server values, wiping out whatever
    // the reviewer had just typed into 핵심 요약/인사이트 or selected in
    // 섹터/활용처 before those are persisted by "자료 발행". This flag is
    // reviewer metadata only; it doesn't need the rest of the form to reload.
    function setReviewerEligibleUi(confirmBtn, overrideBtn, eligible) {
      confirmBtn.classList.toggle('is-selected', eligible === true);
      overrideBtn.classList.toggle('is-selected', eligible === false);
      const statusEl = confirmBtn.parentElement.querySelector('.review-status-text');
      if (statusEl) statusEl.textContent = eligible === null ? '미확인' : '확인 완료';
    }
    // Tracks the currently-saved value so a second click on the same button
    // is recognized as "undo" (-> null) rather than a no-op re-save of the
    // same verdict.
    let reviewerEligible = item.reviewer_eligible;
    const reviewerConfirmBtn = document.getElementById('reviewer-eligible-confirm-btn');
    const reviewerOverrideBtn = document.getElementById('reviewer-eligible-override-btn');
    if (reviewerConfirmBtn && reviewerOverrideBtn) {
      reviewerConfirmBtn.onclick = async () => {
        const next = reviewerEligible === true ? null : true;
        await api(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ reviewer_eligible: next }) });
        reviewerEligible = next;
        setReviewerEligibleUi(reviewerConfirmBtn, reviewerOverrideBtn, next);
      };
      reviewerOverrideBtn.onclick = async () => {
        const next = reviewerEligible === false ? null : false;
        await api(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ reviewer_eligible: next }) });
        reviewerEligible = next;
        setReviewerEligibleUi(reviewerConfirmBtn, reviewerOverrideBtn, next);
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
      advancePastCurrentDraft();
    };

    document.getElementById('d-delete').onclick = async () => {
      if (!confirm('이 Draft를 삭제할까요? 되돌릴 수 없습니다.')) return;
      await api(`/items/${id}`, { method: 'DELETE' });
      advancePastCurrentDraft();
    };

    // Removes the just-published/deleted item from the in-memory drafts
    // list and dropdown, then moves to whichever item now sits at the same
    // position (the "next" item) — rather than renderReview(), which
    // re-fetches the full Draft list and always lands back on the first
    // (highest-priority) one, forcing the reviewer to re-find where they
    // were after every single publish.
    function advancePastCurrentDraft() {
      const idx = drafts.findIndex((d) => String(d.id) === String(id));
      if (idx !== -1) drafts.splice(idx, 1);
      const opt = select.querySelector(`option[value="${id}"]`);
      if (opt) opt.remove();
      if (!drafts.length) {
        renderReview();
        return;
      }
      selectDraftAt(Math.min(idx, drafts.length - 1));
    }
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
  if (drafts[0]) {
    await loadDraft(drafts[0].id);
    startReviewTour();
  }
}

function parseHash() {
  const hash = location.hash.replace(/^#\//, '');
  const [route, qs] = hash.split('?');
  const parts = route.split('/');
  const query = qs ? Object.fromEntries(new URLSearchParams(qs)) : {};
  return { path: parts[0] || 'home', param: parts[1], query };
}

// Active tab is derived straight from the existing hash-route state (no
// separate UI state to keep in sync) — 'detail' has no top-level tab of
// its own, so it maps back to the Archive tab it was reached from.
function updateActiveNavTab(path) {
  // 'detail' has no top-level tab of its own — it's always reached from
  // 자료 (Archive), so it falls back to that tab rather than Home.
  const activeRoute = path === 'archive' || path === 'detail' ? 'archive'
    : path === 'reference' ? 'reference'
    : path === 'sources' ? 'sources' : path === 'review' ? 'review' : 'home';
  document.querySelectorAll('.topbar nav a[data-route]').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === activeRoute);
  });
}

// First-visit-only step-by-step spotlight tour, shared by the nav tour
// (over the top-level tabs) and the Review-page tour (over that page's own
// controls, in the order a reviewer actually uses them): dims the page and
// spotlights the current target (via .onboard-highlight's giant box-shadow
// spread) alongside a small card with a usage tip, "이전"/"다음" to step
// back and forth and "건너뛰기" to exit early. Each step scrolls its target
// into view first (smooth), since Review's controls run down the page and
// aren't all on-screen at once — the card's position then tracks the
// target while that scroll (or any later resize/scroll) is in flight. A
// step whose target isn't in the DOM (e.g. Review has no drafts yet) is
// skipped rather than ending the tour early. Marks `seenKey` once shown or
// skipped so it never reappears in that browser.
function runSpotlightTour(steps, seenKey) {
  if (localStorage.getItem(seenKey)) return;

  let step = 0;
  let highlightedEl = null;
  const card = document.createElement('div');
  card.className = 'onboard-card';
  document.body.appendChild(card);

  function positionCard() {
    if (!highlightedEl) return;
    const r = highlightedEl.getBoundingClientRect();
    card.style.top = `${r.bottom + window.scrollY + 10}px`;
    const cardWidth = Math.min(360, window.innerWidth - 32);
    card.style.left = `${Math.max(8, Math.min(window.innerWidth - cardWidth - 8, r.left + window.scrollX - 20))}px`;
  }
  window.addEventListener('scroll', positionCard, { passive: true });
  window.addEventListener('resize', positionCard);

  function finish() {
    if (highlightedEl) highlightedEl.classList.remove('onboard-highlight');
    window.removeEventListener('scroll', positionCard);
    window.removeEventListener('resize', positionCard);
    card.remove();
    localStorage.setItem(seenKey, '1');
  }

  function renderStep(direction) {
    if (highlightedEl) highlightedEl.classList.remove('onboard-highlight');
    if (step < 0) { finish(); return; }
    if (step >= steps.length) { finish(); return; }
    const s = steps[step];
    const target = document.querySelector(s.selector);
    if (!target) { step += direction < 0 ? -1 : 1; renderStep(direction); return; }
    target.classList.add('onboard-highlight');
    highlightedEl = target;
    const isFirst = step === 0;
    const isLast = step === steps.length - 1;
    card.innerHTML = `
      <h3>${s.title}</h3>
      <p>${s.desc}</p>
      <div class="onboard-card-footer">
        <span class="onboard-step-count">${step + 1} / ${steps.length}</span>
        <div class="onboard-actions">
          <button type="button" class="btn" id="onboard-prev" ${isFirst ? 'disabled' : ''}>이전</button>
          <button type="button" class="btn" id="onboard-skip">건너뛰기</button>
          <button type="button" class="btn primary" id="onboard-next">${isLast ? '시작하기' : '다음'}</button>
        </div>
      </div>
    `;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    positionCard();
    document.getElementById('onboard-prev').onclick = () => {
      if (isFirst) return;
      step -= 1;
      renderStep(-1);
    };
    document.getElementById('onboard-skip').onclick = finish;
    document.getElementById('onboard-next').onclick = () => {
      if (isLast) { finish(); return; }
      step += 1;
      renderStep(1);
    };
  }

  renderStep(1);
}

const ONBOARDING_SEEN_KEY = 'ra_onboarding_seen';
const ONBOARDING_STEPS = [
  { selector: '[data-route="home"]', title: 'Home', desc: '주요 섹터별 최신 이슈를 한눈에 보는 대시보드입니다. 여기서 AI 검색도 할 수 있어요.' },
  { selector: '[data-route="archive"]', title: '자료', desc: '발행된 모든 자료를 최신순으로 모아봅니다. 뉴스/보고서 탭과 필터로 좁혀볼 수 있어요.' },
  { selector: '[data-route="reference"]', title: '레퍼런스', desc: '자동 수집 대상이 아니더라도 참고 가치가 높은 리서치/통계 출처를 모아둔 목록입니다.' },
  { selector: '[data-route="sources"]', title: 'Sources', desc: '자료를 수집하는 RSS·기관 소스를 등록하고 관리하는 운영자용 화면입니다.' },
  { selector: '[data-route="review"]', title: 'Review', desc: 'AI가 자동 채집·판단한 초안을 발행 전에 사람이 검수하는 화면입니다. 검수 결과는 주제가 비슷한 이후 기사 판단에 우선 참고되어 정확도가 보정됩니다.' },
];
function startOnboardingTour() { runSpotlightTour(ONBOARDING_STEPS, ONBOARDING_SEEN_KEY); }

// Review-page tour — spotlights that page's own controls in the order a
// reviewer actually works through them (판단 미완료 draft 고르기 → AI 판단
// 확인 → 내 판단 확정 → 필요시 요약/분류 수정 → 발행), separate from the
// review-tip-card above (a persistent reference card) and from the nav
// tour (which only names the tab). Only fires once a draft is loaded, since
// most of its targets (#d-summary 등) don't exist until then.
const REVIEW_TOUR_SEEN_KEY = 'ra_review_tour_seen';
const REVIEW_TOUR_STEPS = [
  { selector: '#draft-select', title: 'Draft 선택', desc: '검토할 초안을 여기서 고릅니다. "판단 미완료" 그룹이 위에 먼저 보여요.' },
  { selector: '.verdict-badge', title: 'AI 판단', desc: 'AI가 내린 적합/비적합 판단과 그 근거를 먼저 확인하세요.' },
  { selector: '#reviewer-eligible-confirm-btn', title: '내 판단', desc: '적합/비적합으로 직접 확정하세요. 같은 버튼을 한 번 더 누르면 선택이 해제됩니다.' },
  { selector: '#d-summary', title: '요약 · 인사이트', desc: '필요하면 핵심 요약과 인사이트를 직접 수정할 수 있어요.' },
  { selector: '#d-sectors', title: '섹터 · 활용처', desc: '적절한 섹터와 활용처를 선택해 분류하세요.' },
  { selector: '#d-publish', title: '자료 발행', desc: '판단과 분류가 끝나면 발행 버튼을 눌러 공개합니다.' },
];
function startReviewTour() { runSpotlightTour(REVIEW_TOUR_STEPS, REVIEW_TOUR_SEEN_KEY); }

async function router() {
  const { path, param, query } = parseHash();
  updateActiveNavTab(path);
  // Leaving Home (or re-rendering it) must stop its carousels' setInterval
  // timers before the next page's render replaces app.innerHTML — otherwise
  // they keep firing against detached DOM.
  clearHomeCarouselIntervals();
  try {
    if (path === 'home' || path === '') await renderHome();
    else if (path === 'archive') await renderArchive(query);
    else if (path === 'latest') { location.hash = '#/archive'; return; }
    else if (path === 'detail') await renderDetail(param);
    else if (path === 'reference') await renderReference(query);
    else if (path === 'sources') await renderSources(query);
    else if (path === 'review') await renderReview();
    else app.innerHTML = '<p>페이지를 찾을 수 없습니다.</p>';
    // The browser can otherwise preserve/restore the previous page's scroll
    // position across a hash change or back/forward navigation (see the
    // history.scrollRestoration override below) — every route, including
    // switching between Latest and All Results (or returning to a tab left
    // earlier), always opens at its own top instead.
    window.scrollTo(0, 0);
  } catch (err) {
    app.innerHTML = `<p>오류: ${err.message}</p>`;
  }
}

// Without this, the browser restores each history entry's own scroll
// position on back/forward — exactly the preservation this route change
// (router()'s window.scrollTo(0, 0) on every render) is meant to remove.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// Admin login/logout — a single shared password (server/lib/auth.js), no
// accounts. The button lives in the nav's "operate" group since only
// Sources/Review writes and collection triggers require it; reading any
// page (including Sources/Review themselves) stays open to everyone.
async function refreshAdminAuthUi() {
  const btn = document.getElementById('nav-admin-auth');
  if (!btn) return;
  let authenticated = false;
  try {
    const status = await api('/auth/status');
    authenticated = Boolean(status.authenticated);
  } catch (err) { /* treat an unreachable status check as logged out */ }
  btn.textContent = authenticated ? '로그아웃' : '관리자 로그인';
  btn.onclick = authenticated ? adminLogout : adminLogin;
}

async function adminLogin() {
  const password = prompt('관리자 비밀번호를 입력하세요:');
  if (!password) return;
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
  } catch (err) {
    alert(`로그인 실패: ${err.message}`);
    return;
  }
  await refreshAdminAuthUi();
}

async function adminLogout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  await refreshAdminAuthUi();
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) location.hash = '#/home';
  startOnboardingTour();
  refreshAdminAuthUi();
  router();
});
