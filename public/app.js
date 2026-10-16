const TYPE_CLASS = { '뉴스': 'news', '보고서': 'report', '통계': 'stat', '규제': 'reg' };
const app = document.getElementById('app');

async function api(path, opts) {
  const { includeMeta = false, ...requestOptions } = opts || {};
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...requestOptions,
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
  const data = await res.json();
  return includeMeta ? { data, hasMore: res.headers.get('X-Has-More') === 'true' } : data;
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

// Team Pick popover — a single shared element appended to <body> and
// repositioned per click, rather than one hidden menu per card: a page
// can render the same item in several carousels at once, and only ever
// one menu needs to be open. No per-member record, no identity check —
// per the trade-off this feature was built around, anyone can toggle any
// team's pick on any item; the menu just lists the shared roster and
// each team's current on/off state for this item.
let teamPickMenuEl = null;
// Tracks WHICH item's menu is open, so toggleTeamPickMenu can tell "same
// button clicked again" (close, stay closed) apart from "a different
// card's 팀 Pick button clicked" (close the old one, open the new one in
// the same click) — see toggleTeamPickMenu's own comment for why this
// can't just be inferred from teamPickMenuEl alone.
let teamPickMenuItemId = null;
function closeTeamPickMenu() {
  if (!teamPickMenuEl) return;
  teamPickMenuEl.remove();
  teamPickMenuEl = null;
  teamPickMenuItemId = null;
  document.removeEventListener('click', onTeamPickMenuOutsideClick, true);
  document.removeEventListener('keydown', onTeamPickMenuEscape, true);
}
function onTeamPickMenuOutsideClick(ev) {
  // Production bug: this capture-phase listener used to fire BEFORE a 팀
  // Pick button's own onclick (capture always runs ahead of the bubble-
  // phase handler at the target), closing the menu first — then the
  // button's own toggleTeamPickMenu ran immediately after, saw
  // teamPickMenuEl already null, and reopened it. A second click on the
  // same button never actually stayed closed; it just flickered. Ignoring
  // clicks on any 팀 Pick trigger here and letting toggleTeamPickMenu
  // handle its own toggle (including switching to a different item's
  // menu) fixes that race at the source.
  if (ev.target.closest('[data-team-pick-btn]')) return;
  if (teamPickMenuEl && !teamPickMenuEl.contains(ev.target)) closeTeamPickMenu();
}
function onTeamPickMenuEscape(ev) {
  if (ev.key === 'Escape') closeTeamPickMenu();
}

// Refreshes every on-page rendering of this item's team-pick button (the
// same item can appear in more than one carousel/section at once) to the
// current server state, after the popover changes anything.
async function updateCardTeamPickButton(itemId) {
  const picks = await api(`/picks?item_id=${itemId}&kind=team`).catch(() => []);
  const label = picks.length === 0 ? '팀 Pick' : picks.length === 1 ? `팀 Pick · ${picks[0].team}` : `팀 Pick · ${picks.length}팀`;
  document.querySelectorAll(`[data-team-pick-btn="${itemId}"]`).forEach((btn) => {
    btn.textContent = label;
    btn.classList.toggle('is-picked', picks.length > 0);
  });
}

async function renderTeamPickMenuContents(itemId) {
  if (!teamPickMenuEl) return;
  const [teams, currentPicks] = await Promise.all([
    api('/picks/teams').catch(() => []),
    api(`/picks?item_id=${itemId}&kind=team`).catch(() => []),
  ]);
  if (!teamPickMenuEl) return; // closed while the above was in flight
  const pickIdByTeam = new Map(currentPicks.map((p) => [p.team, p.id]));
  teamPickMenuEl.innerHTML = `
    <div class="team-pick-menu-list">
      ${teams.map((t) => `
        <label class="team-pick-menu-row">
          <input type="checkbox" data-team="${t}" ${pickIdByTeam.has(t) ? 'checked' : ''}>
          <span>${t}</span>
        </label>
      `).join('') || '<p class="meta">등록된 팀이 없습니다.</p>'}
    </div>
    <div class="team-pick-menu-add">
      <input type="text" id="team-pick-new-name" placeholder="새 팀 이름" maxlength="40">
      <button type="button" class="btn" id="team-pick-add-btn">추가</button>
    </div>
  `;
  teamPickMenuEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.onchange = async () => {
      const team = cb.dataset.team;
      const wasChecked = !cb.checked; // value before this toggle
      cb.disabled = true;
      try {
        if (!wasChecked) {
          await api('/picks', { method: 'POST', body: JSON.stringify({ item_id: itemId, kind: 'team', team }) });
        } else {
          const pickId = pickIdByTeam.get(team);
          if (pickId) await api(`/picks/${pickId}`, { method: 'DELETE' });
        }
      } catch (err) {
        alert(`변경 실패: ${err.message}`);
      }
      await renderTeamPickMenuContents(itemId);
      await updateCardTeamPickButton(itemId);
    };
  });
  const addBtn = teamPickMenuEl.querySelector('#team-pick-add-btn');
  if (addBtn) {
    addBtn.onclick = async () => {
      const input = teamPickMenuEl.querySelector('#team-pick-new-name');
      const name = input.value.trim();
      if (!name) return;
      addBtn.disabled = true;
      try {
        await api('/picks', { method: 'POST', body: JSON.stringify({ item_id: itemId, kind: 'team', team: name }) });
      } catch (err) {
        alert(`추가 실패: ${err.message}`);
      }
      await renderTeamPickMenuContents(itemId);
      await updateCardTeamPickButton(itemId);
    };
  }
}

window.toggleTeamPickMenu = function toggleTeamPickMenu(ev, itemId) {
  ev.stopPropagation();
  if (teamPickMenuEl) {
    const wasSameItem = teamPickMenuItemId === itemId;
    closeTeamPickMenu();
    // Same button clicked again (second click) — just close, don't
    // immediately reopen. A different card's 팀 Pick button clicked while
    // this one was open — close it and fall through to open the new one,
    // so switching cards still takes one click, not two.
    if (wasSameItem) return;
  }
  const btn = ev.currentTarget;
  const rect = btn.getBoundingClientRect();
  teamPickMenuEl = document.createElement('div');
  teamPickMenuItemId = itemId;
  teamPickMenuEl.className = 'team-pick-menu';
  teamPickMenuEl.style.top = `${rect.bottom + 4}px`;
  teamPickMenuEl.style.left = `${rect.left}px`;
  teamPickMenuEl.innerHTML = '<p class="meta">불러오는 중…</p>';
  document.body.appendChild(teamPickMenuEl);
  // capture phase so this registers before the click that opened the menu
  // finishes bubbling — otherwise the very click that opens it would also
  // immediately close it via the outside-click listener.
  setTimeout(() => {
    document.addEventListener('click', onTeamPickMenuOutsideClick, true);
    document.addEventListener('keydown', onTeamPickMenuEscape, true);
  }, 0);
  renderTeamPickMenuContents(itemId);
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
// Shared by itemCard() and Detail's own action row — a button whose label
// always shows current save state at a glance ("팀 Pick" / "팀 Pick ·
// A팀" / "팀 Pick · 2팀"), per data-team-pick-btn="${itemId}" so
// updateCardTeamPickButton() can refresh every rendering of the same item
// on the page (a card can appear in more than one carousel) after a
// change in the popover.
function teamPickButtonHtml(itemId, teamPicksByItem, extraClass) {
  const teamPicks = (teamPicksByItem instanceof Map ? teamPicksByItem.get(itemId) : null) || [];
  const label = teamPicks.length === 0 ? '팀 Pick'
    : teamPicks.length === 1 ? `팀 Pick · ${teamPicks[0].team}`
    : `팀 Pick · ${teamPicks.length}팀`;
  return `<button type="button" class="${extraClass || ''} card-team-pick-btn ${teamPicks.length ? 'is-picked' : ''}" data-team-pick-btn="${itemId}" onclick="toggleTeamPickMenu(event, ${itemId})">${label}</button>`;
}

function itemCard(item, importantIds, savedIds, teamPicksByItem) {
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
        ${teamPickButtonHtml(item.id, teamPicksByItem)}
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
function homeCarouselModule(heading, moduleItems, targetHash, importantIds, savedIds, teamPicksByItem, moduleAttrs = '') {
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

  return `<div class="home-module" ${moduleAttrs}>
    ${headerHtml}
    <div class="home-carousel">
      <button type="button" class="home-carousel-nav prev" aria-label="이전 자료">‹</button>
      <div class="home-carousel-viewport">
        <div class="home-carousel-track">
          ${slides.map((slide) => `<div class="home-carousel-slide">${slide.map((it) => itemCard(it, importantIds, savedIds, teamPicksByItem)).join('')}</div>`).join('')}
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
function itemsForSector(items, sectorId, windowDays) {
  return items
    .filter((it) => (it.sectors || []).some((s) => s.id === sectorId))
    .filter((it) => isWithinWindow(it.published_at, windowDays));
}

// Home carousel freshness window — the item's own published_at (never
// created_at/collected_at). An item with no published_at can't be judged
// "recent" so it's excluded, not kept. Deliberately a filter, not a
// backfill: if fewer than a full slide's worth of items qualify, the
// carousel just shows fewer slides/cards — it never reaches past the
// window to pad slots with older items.
//
// Window length is per child sector, not per theme root or a single
// fixed value — these specific commodities publish often enough that a
// 1-week window still fills a carousel and reads noticeably fresher;
// every other child sector (the long tail of niche commodities, both
// 식용유지's own less-common ones and 비식용유지's structurally sparse
// ones — CLAUDE.md: "매번 '미확보'가 정상" for several of these) keeps
// the longer 1-month window instead, or it would read empty far more
// often. See the call site in homeThemeRoot().
const HOME_CAROUSEL_MAJOR_SECTOR_NAMES = new Set(['팜유', '대두유', '해바라기유', 'SAF', 'FAME', '기타 비식용유지']);
const HOME_CAROUSEL_MAJOR_WINDOW_DAYS = 7;
const HOME_CAROUSEL_DEFAULT_WINDOW_DAYS = 30;
function homeCarouselWindowDaysFor(sectorName) {
  return HOME_CAROUSEL_MAJOR_SECTOR_NAMES.has(sectorName) ? HOME_CAROUSEL_MAJOR_WINDOW_DAYS : HOME_CAROUSEL_DEFAULT_WINDOW_DAYS;
}

function isWithinWindow(publishedAt, windowDays) {
  if (!publishedAt) return false;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  return d >= cutoff;
}

// Order of the two top-level theme roots (식용유지/비식용유지) themselves.
// Drag-and-drop is the wrong tool for a 2-item list — there's only ever
// one possible move (swap the two), so a single button that performs
// that move directly is faster and more obvious than picking up a card,
// carrying it across the whole page, and dropping it in the only other
// valid slot. Surfaced as a small ⇅ icon beside each root heading
// (home-theme-root-swap-icon) that opens a tiny reorder card rather than
// a standing button on the page — the button read as an extra piece of
// chrome competing with the page's own heading/lede for attention.
// Same localStorage convention as the per-theme carousel order
// (HOME_CAROUSEL_ORDER_KEY) — a per-browser display preference, no
// backend involved.
const HOME_ROOT_ORDER_KEY = 'ra_home_root_order';

function getHomeRootOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_ROOT_ORDER_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveHomeRootOrder(orderedIds) {
  try {
    localStorage.setItem(HOME_ROOT_ORDER_KEY, JSON.stringify(orderedIds));
  } catch (err) { /* storage unavailable (private mode, quota) — order just resets next load */ }
}

// A root not present in the saved order (e.g. a theme root added after the
// user last swapped) is appended at the end rather than hidden — same
// "preference over what exists today, never a filter" rule as
// applyHomeCarouselOrder().
function applyHomeRootOrder(roots) {
  const saved = getHomeRootOrder();
  if (!saved.length) return roots;
  const byId = new Map(roots.map((r) => [r.id, r]));
  const ordered = saved.map((id) => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map((r) => r.id));
  return [...ordered, ...roots.filter((r) => !orderedIds.has(r.id))];
}

// Cached by renderHome() so the reorder card can act without re-fetching
// /api/sectors — it only ever needs the id/name pairs, not fresh data.
let homeThemeRootsCache = [];

// Whether the reorder card is open, and its in-progress (unsaved) order —
// kept separate from the saved order so the carousels behind the card
// stay in their last-saved order while the user is still arranging rows,
// and a Cancel simply drops this draft instead of needing to undo
// anything. Reset to null whenever the card closes (saved or cancelled).
let homeRootReorderCardOpen = false;
let homeRootReorderDraft = null;

function toggleHomeThemeRootReorderCard() {
  homeRootReorderCardOpen = !homeRootReorderCardOpen;
  homeRootReorderDraft = homeRootReorderCardOpen ? homeThemeRootsCache.map((r) => r.id) : null;
  renderHome();
}

// ▲/▼ swap the row at `idx` with its neighbor in the given direction —
// the only two possible moves in a short list, so a full drag-and-drop
// implementation inside a tiny popover card would be overkill.
function moveHomeThemeRootReorderRow(idx, dir) {
  if (!homeRootReorderDraft) return;
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= homeRootReorderDraft.length) return;
  [homeRootReorderDraft[idx], homeRootReorderDraft[swapIdx]] = [homeRootReorderDraft[swapIdx], homeRootReorderDraft[idx]];
  renderHome();
}

function saveHomeThemeRootReorderCard() {
  if (homeRootReorderDraft) saveHomeRootOrder(homeRootReorderDraft);
  homeRootReorderCardOpen = false;
  homeRootReorderDraft = null;
  renderHome();
}

// Rendered once, anchored under the first theme root's heading — both
// roots' ⇅ icons open this same shared card since there's only one order
// to manage between them, not one per root.
function homeThemeRootReorderCardHtml() {
  if (!homeRootReorderCardOpen || !homeRootReorderDraft) return '';
  const byId = new Map(homeThemeRootsCache.map((r) => [r.id, r]));
  const rows = homeRootReorderDraft.map((id, i) => {
    const root = byId.get(id);
    if (!root) return '';
    return `<li class="home-root-reorder-row">
      <span>${root.name}</span>
      <span class="home-root-reorder-controls">
        <button type="button" class="home-root-reorder-move" onclick="moveHomeThemeRootReorderRow(${i}, -1)" ${i === 0 ? 'disabled' : ''} aria-label="위로 이동">▲</button>
        <button type="button" class="home-root-reorder-move" onclick="moveHomeThemeRootReorderRow(${i}, 1)" ${i === homeRootReorderDraft.length - 1 ? 'disabled' : ''} aria-label="아래로 이동">▼</button>
      </span>
    </li>`;
  }).join('');
  return `<div class="home-root-reorder-card">
    <p class="home-root-reorder-title">테마 순서 조정</p>
    <ul class="home-root-reorder-list">${rows}</ul>
    <div class="home-root-reorder-actions">
      <button type="button" class="btn-text-action" onclick="toggleHomeThemeRootReorderCard()">취소</button>
      <button type="button" class="btn" onclick="saveHomeThemeRootReorderCard()">저장</button>
    </div>
  </div>`;
}

// One top-level theme (식용유지/비식용유지): a clickable heading that opens
// the full-results view filtered to the whole root subtree, followed by one
// compact carousel per child theme (팜유, 대두유, ... / UCO, SAF, ...),
// each reusing homeCarouselModule() unchanged so card/detail behavior and
// visual language stay exactly as they are elsewhere on Home.
function homeThemeRoot(root, byParent, items, importantIds, savedIds, teamPicksByItem, isFirstRoot) {
  const children = applyHomeCarouselOrder(root.id, byParent.get(root.id) || []);
  const childModulesHtml = children
    .map((child) => homeCarouselModule(
      child.name, itemsForSector(items, child.id, homeCarouselWindowDaysFor(child.name)), `#/archive?sector=${child.id}`, importantIds, savedIds, teamPicksByItem,
      `draggable="false" data-drag-sector="${child.id}"`
    ))
    .join('');
  // Items are tagged with a leaf/child sector, essentially never the root
  // itself — the root link must filter on the whole subtree (root +
  // every child id), same expansion the Archive page's own sector-tree
  // checkbox already does, or clicking a root would show an empty result.
  const subtreeIds = collectSubtreeIds(byParent, root.id);
  // The swap icon sits only to the left of the heading text — stopping
  // propagation keeps a click on it from also firing the header's own
  // navigate-to-archive handler.
  const swapIconHtml = homeThemeRootsCache.length >= 2
    ? `<button type="button" class="home-theme-root-swap-icon" title="테마 순서 조정" aria-label="테마 순서 조정" onclick="event.stopPropagation(); toggleHomeThemeRootReorderCard()">⇅</button>`
    : '';
  return `<section class="home-theme-root">
    <div class="home-theme-root-header-row">
      <div class="home-theme-root-header" onclick="location.hash='#/archive?sector=${subtreeIds.join(',')}'">
        ${swapIconHtml}<h2>${root.name}</h2><span class="home-module-arrow">›</span>
      </div>
      ${isFirstRoot ? homeThemeRootReorderCardHtml() : ''}
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
// Auto-scroll the page while dragging a carousel near the top/bottom edge
// of the viewport — without this, reordering a theme with more children
// than fit on screen is impossible: the drag can never reach a module
// that's off-screen, since native drag/drop doesn't scroll the page on
// its own the way a text selection does. Speed ramps up the closer the
// cursor gets to the edge, and stops entirely once it's clear of the
// edge band, rather than a fixed-speed scroll that overshoots on a quick
// flick to the very edge.
const HOME_DRAG_SCROLL_EDGE_PX = 120;
const HOME_DRAG_SCROLL_MAX_PX = 22;
let homeDragActive = false;
let homeDragClientY = null;
let homeDragScrollRafId = null;

function homeDragAutoScrollStep() {
  if (!homeDragActive) { homeDragScrollRafId = null; return; }
  if (homeDragClientY != null) {
    const viewportH = window.innerHeight;
    const distFromTop = homeDragClientY;
    const distFromBottom = viewportH - homeDragClientY;
    let delta = 0;
    if (distFromTop < HOME_DRAG_SCROLL_EDGE_PX) {
      delta = -HOME_DRAG_SCROLL_MAX_PX * (1 - distFromTop / HOME_DRAG_SCROLL_EDGE_PX);
    } else if (distFromBottom < HOME_DRAG_SCROLL_EDGE_PX) {
      delta = HOME_DRAG_SCROLL_MAX_PX * (1 - distFromBottom / HOME_DRAG_SCROLL_EDGE_PX);
    }
    if (delta) window.scrollBy(0, delta);
  }
  homeDragScrollRafId = requestAnimationFrame(homeDragAutoScrollStep);
}

function startHomeDragAutoScroll() {
  homeDragActive = true;
  if (!homeDragScrollRafId) homeDragScrollRafId = requestAnimationFrame(homeDragAutoScrollStep);
}

function stopHomeDragAutoScroll() {
  homeDragActive = false;
  homeDragClientY = null;
  if (homeDragScrollRafId) {
    cancelAnimationFrame(homeDragScrollRafId);
    homeDragScrollRafId = null;
  }
}

function initHomeCarouselDragReorder() {
  document.querySelectorAll('.home-theme-children[data-drag-root]').forEach((container) => {
    const rootId = container.dataset.dragRoot;
    let draggedEl = null;
    // Without this, dragover/drop over any point that isn't directly over
    // another .home-module (the gaps between modules, this container's own
    // padding, a module's non-card whitespace) is an illegal drop target by
    // default — the browser cancels it and snaps the dragged element back,
    // which is what "드래그가 안 된다" looks like even though dragstart and
    // the per-module reordering both fired correctly. Every card in a
    // module is also an <a href="#/detail/...">, so an illegal drop can
    // additionally trigger the browser's native "navigate to this link"
    // action instead of just silently failing.
    container.addEventListener('dragover', (e) => { homeDragClientY = e.clientY; e.preventDefault(); });
    container.addEventListener('drop', (e) => e.preventDefault());
    container.querySelectorAll('.home-module[data-drag-sector]').forEach((mod) => {
      // draggable starts false on every module (see homeThemeRoot's
      // moduleAttrs) so that clicking anywhere else on the card — the
      // carousel's own single-card-click navigation — never gets
      // hijacked into a drag. Only arms draggable=true for the brief
      // window between pressing down on the ⠿ handle and releasing (or
      // dragend firing), then disarms it again; mousedown rather than
      // click because dragstart fires before a click would.
      const handle = mod.querySelector('.home-module-drag-handle');
      if (handle) {
        handle.addEventListener('mousedown', () => { mod.draggable = true; });
        handle.addEventListener('touchstart', () => { mod.draggable = true; }, { passive: true });
      }
      mod.addEventListener('dragstart', (e) => {
        draggedEl = mod;
        mod.classList.add('is-dragging');
        // Firefox refuses to start a drag unless dataTransfer carries
        // something — the payload itself is never read on drop.
        if (e.dataTransfer) e.dataTransfer.setData('text/plain', '');
        startHomeDragAutoScroll();
      });
      mod.addEventListener('dragend', () => {
        mod.classList.remove('is-dragging');
        mod.draggable = false;
        draggedEl = null;
        stopHomeDragAutoScroll();
        const orderedIds = [...container.querySelectorAll('.home-module[data-drag-sector]')]
          .map((el) => Number(el.dataset.dragSector));
        saveHomeCarouselOrder(rootId, orderedIds);
      });
      // Pressed the handle down but never actually dragged (e.g. a plain
      // click on it) — dragstart/dragend never fire in that case, so this
      // disarms draggable on its own instead of leaving the whole card
      // draggable until the next unrelated drag elsewhere re-triggers it.
      mod.addEventListener('mouseup', () => { mod.draggable = false; });
      mod.addEventListener('dragover', (e) => {
        homeDragClientY = e.clientY;
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
// in memory only (module-level, not localStorage/sessionStorage), so it
// survives a renderHome() re-render (e.g. Home -> cited article's Detail
// page -> back to Home) rather than resetting on every visit. A hard page
// reload clears it naturally, since module state doesn't survive that.
let aiSearchHistory = [];
// Rendered turn HTML kept alongside aiSearchHistory so the visible Q&A
// thread can be restored on the next renderHome(), not just the history
// array the API call uses for context.
let aiSearchTurnsHtml = [];

// 대화 초기화 버튼: 대화 내역(aiSearchHistory)이 있을 때만 눌러서
// 강제 초기화할 수 있다 — 입력창 가로 길이를 살짝 줄여 그 공간에 둔다
// (입력창은 flex:1이라 같은 행에 버튼을 하나 더 두면 자동으로 줄어든다).
function aiSearchHtml() {
  const hasHistory = aiSearchHistory.length > 0;
  return `<section class="ai-search" id="ai-search">
    <form id="ai-search-form">
      <input id="ai-search-input" type="text" placeholder="What are you researching?" autocomplete="off" required>
      <button type="button" class="ai-search-reset-btn" id="ai-search-reset-btn" title="대화 내역 초기화" aria-label="대화 내역 초기화" ${hasHistory ? '' : 'disabled'}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
      </button>
      <button type="submit" class="btn">검색</button>
    </form>
    <div class="ai-search-result" id="ai-search-result"></div>
  </section>`;
}

// Controlled Markdown-ish rendering for the model's answer — never raw
// innerHTML of model text. escapeHtml() runs on every text fragment before
// any tag is added, so the model cannot inject HTML of its own; the only
// tags on the page come from this file's own template strings.
// `sources` (server/routes/search.js's `sources` array, already remapped
// to [1..k] against the model's own citation markers) turns each [N] into
// a clickable link straight to that source's Detail page — per-claim
// traceability, not just a flat source list at the end of the answer.
// An out-of-range [N] (nothing at that position) is dropped rather than
// left as a dead marker.
function renderInlineAnswerText(line, sources) {
  const escaped = escapeHtml(line);
  const bolded = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return bolded.replace(/\[(\d{1,2})\]/g, (whole, digits) => {
    const src = sources && sources[Number(digits) - 1];
    if (!src) return '';
    return `<a class="ai-citation" href="#/detail/${src.id}" title="${escapeHtml(src.title)}">[${digits}]</a>`;
  });
}

function normalizeAnswerMarkdown(rawAnswer) {
  return LatexText.latexToPlainText(String(rawAnswer || ''))
    // Some model responses escape Markdown markers even though this UI
    // intentionally renders a small, safe Markdown subset.
    .replace(/(^|\n)\\+(?=\s*#{1,6}\s)/g, '$1')
    .replace(/(^|\n)\\+(?=\s*[*•-]\s)/g, '$1')
    .replace(/(^|\n)\\+(?=\s*\d+[.)]\s)/g, '$1')
    // The model sometimes uses a trailing backslash as a hard line break.
    .replace(/\\(?=\s*(?:\n|$))/g, '');
}

// block is {type, lines} (or {type:'ordered-merged', items} — see the
// merge pass in renderAnswerHtml below). Dispatches purely on `type`,
// already determined while chunking — no re-detection from re-joined text.
function renderAnswerBlock(block, sources, orderedStart = 1) {
  if (block.type === 'heading') {
    return block.lines.map((l) => `<h3 class="ai-answer-heading">${renderInlineAnswerText(l.replace(/^#{1,6}\s+/, ''), sources)}</h3>`).join('');
  }
  if (block.type === 'unordered') {
    return renderBulletTree(block.lines, sources);
  }
  // Markdown table: "| 대상 | 적용일 |" style rows the model sometimes
  // produces for comparison data (e.g. a company-size vs. deadline table),
  // even though it's outside the small Markdown subset SYSTEM_PROMPT
  // actually asks for. It used to fall through to the plain-paragraph
  // case below, which just <br>-joined the raw "| ... | ... |" lines
  // verbatim — showing the literal pipe syntax instead of a table. Real
  // Markdown table syntax (a header row + a "|---|---|"-style separator
  // row) now renders as an actual <table>; anything that merely looks
  // like it has pipes but isn't a real table (no valid separator row)
  // still falls back to the plain-paragraph rendering, never broken HTML.
  if (block.type === 'table') {
    const rows = block.lines.map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
    const isSeparatorRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
    if (rows.length >= 2 && isSeparatorRow(rows[1])) {
      const header = rows[0];
      const body = rows.slice(2);
      return `<table class="ai-answer-table"><thead><tr>${header.map((c) => `<th>${renderInlineAnswerText(c, sources)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${renderInlineAnswerText(c, sources)}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
    return `<p class="ai-answer-p">${block.lines.map((l) => renderInlineAnswerText(l, sources)).join('<br>')}</p>`;
  }
  // Production bug: "1. A" / "* detail" / "1. PVOIL" / "* detail" (the model
  // restarting numbering at 1 for every item once its own detail bullet
  // breaks up the list) used to split into four separate single-item
  // blocks — each rendered as its own <ol>, and a lone <ol> always starts
  // at 1 regardless of what digit was in the source text, so every item
  // showed "1." no matter how many there were. The merge pass below folds
  // a whole ordered/unordered-detail run into one 'ordered-merged' block
  // first, so this case is just a single real <ol> that numbers itself
  // correctly, with each item's own detail nested under it instead of
  // floating as an unrelated top-level bullet.
  if (block.type === 'ordered-merged') {
    return `<ol class="ai-answer-list" start="${orderedStart}">${block.items.map((item) => `<li>${renderInlineAnswerText(item.text, sources)}${
      item.subLines.length
        ? renderBulletTree(item.subLines, sources, 'ai-answer-list ai-answer-sublist')
        : ''
    }</li>`).join('')}</ol>`;
  }
  return `<p class="ai-answer-p">${block.lines.map((l) => renderInlineAnswerText(l, sources)).join('<br>')}</p>`;
}

// ```chart {json} ``` blocks -> inline SVG (bar/line). Anything malformed
// is dropped silently so a bad block never breaks the answer.
function renderChartHtml(jsonText) {
  let c;
  try { c = JSON.parse(jsonText); } catch (_) { return ''; }
  const labels = Array.isArray(c.labels) ? c.labels.slice(0, 12).map(String) : [];
  const series = (Array.isArray(c.series) ? c.series : []).slice(0, 4)
    .map((s) => ({ name: String(s.name || ''), data: (Array.isArray(s.data) ? s.data : []).slice(0, labels.length).map(Number) }))
    .filter((s) => s.data.length && s.data.every(Number.isFinite));
  if (labels.length < 2 || !series.length) return '';
  const W = 560, H = 260, L = 48, R = 12, T = 12, B = 56;
  const all = series.flatMap((s) => s.data);
  const max = Math.max(...all, 0), min = Math.min(...all, 0);
  const span = max - min || 1;
  const y = (v) => T + (H - T - B) * (1 - (v - min) / span);
  const step = (W - L - R) / labels.length;
  const colors = ['#2f6fed', '#e8833a', '#2f9e6f', '#9b59b6'];
  const isLine = c.type === 'line';
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = min + (span * i) / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" opacity=".12"/><text x="${L - 6}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="currentColor">${escapeHtml(String(Math.round(v * 100) / 100))}</text>`;
  }
  labels.forEach((l, i) => {
    const x = L + step * (i + 0.5);
    const t = l.length > 10 ? `${l.slice(0, 9)}…` : l;
    g += `<text x="${x}" y="${H - B + 14}" font-size="10" text-anchor="middle" fill="currentColor" transform="rotate(${labels.length > 6 ? 30 : 0} ${x} ${H - B + 14})">${escapeHtml(t)}</text>`;
  });
  series.forEach((s, si) => {
    const col = colors[si % colors.length];
    if (isLine) {
      const pts = s.data.map((v, i) => `${L + step * (i + 0.5)},${y(v)}`);
      g += `<polyline fill="none" stroke="${col}" stroke-width="2" points="${pts.join(' ')}"/>` + s.data.map((v, i) => `<circle cx="${L + step * (i + 0.5)}" cy="${y(v)}" r="3" fill="${col}"><title>${escapeHtml(labels[i])}: ${v}</title></circle>`).join('');
    } else {
      const bw = (step * 0.7) / series.length;
      g += s.data.map((v, i) => {
        const x = L + step * (i + 0.15) + bw * si;
        const y0 = y(Math.max(0, min)), y1 = y(v);
        return `<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.abs(y0 - y1)}" fill="${col}"><title>${escapeHtml(labels[i])}: ${v}</title></rect>`;
      }).join('');
    }
  });
  const legend = series.length > 1 ? `<div class="ai-chart-legend">${series.map((s, i) => `<span><i style="background:${colors[i % colors.length]}"></i>${escapeHtml(s.name)}</span>`).join('')}</div>` : '';
  return `<figure class="ai-chart"><figcaption>${escapeHtml(String(c.title || ''))}${c.unit ? ` <small>(${escapeHtml(String(c.unit))})</small>` : ''}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(String(c.title || '차트'))}">${g}</svg>${legend}</figure>`;
}

// Bullet lines keep their leading indentation; deeper indent => nested <ul>,
// so the model's visual hierarchy (group -> item -> detail) is preserved.
function renderBulletTree(lines, sources, rootClass = 'ai-answer-list') {
  const items = lines.map((l) => ({
    d: l.match(/^\s*/)[0].replace(/\t/g, '    ').length,
    t: l.trim().replace(/^[-*•]\s+/, ''),
  }));
  const build = (start, indent, depth) => {
    let out = `<ul class="${rootClass}${depth ? ` ai-answer-sublist ai-depth-${Math.min(depth, 3)}` : ''}">`;
    let i = start;
    while (i < items.length && items[i].d >= indent) {
      const cur = items[i++];
      let child = '';
      if (i < items.length && items[i].d > cur.d) [child, i] = build(i, items[i].d, depth + 1);
      out += `<li>${renderInlineAnswerText(cur.t, sources)}${child}</li>`;
    }
    return [`${out}</ul>`, i];
  };
  let html = '';
  let i = 0;
  while (i < items.length) {
    const [h, next] = build(i, Math.min(...items.slice(i).map((x) => x.d)), 0);
    html += h; i = next;
  }
  return html;
}

function renderAnswerHtml(rawAnswer, sources) {
  // Split out chart fences first; an unfinished fence (mid-stream) is hidden.
  const text = String(rawAnswer || '').replace(/```chart[^\n]*\n?(?![\s\S]*```)[\s\S]*$/, '');
  if (/```chart/.test(text)) {
    const parts = text.split(/```chart[^\n]*\n?([\s\S]*?)```/);
    return parts.map((p, i) => (i % 2 ? renderChartHtml(p) : (p.trim() ? renderAnswerHtml(p, sources) : ''))).join('');
  }
  const normalized = normalizeAnswerMarkdown(text).trim();
  const lines = normalized.split('\n');
  const rawBlocks = [];
  let current = [];
  let currentType = null;

  const flush = () => {
    if (current.length) rawBlocks.push({ type: currentType, lines: current });
    current = [];
    currentType = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const type = /^#{1,6}\s+/.test(line)
      ? 'heading'
      : /^[-*•]\s+/.test(line)
        ? 'unordered'
        : /^\d+[.)]\s+/.test(line)
          ? 'ordered'
          : /^\|.*\|$/.test(line)
            ? 'table'
            : 'paragraph';

    if (type === 'paragraph') {
      if (currentType && currentType !== 'paragraph') flush();
      currentType = 'paragraph';
      current.push(line);
      continue;
    }

    if (type !== currentType) flush();
    currentType = type;
    current.push(type === 'unordered' ? rawLine.replace(/\s+$/, '') : line);
  }
  flush();

  // Merge pass: a run of ordered-list blocks, each possibly followed by one
  // unordered block that's really THAT item's own detail (not a separate
  // top-level bullet list), becomes one 'ordered-merged' block — see
  // renderAnswerBlock's own comment for the exact incident this fixes.
  const blocks = [];
  let i = 0;
  while (i < rawBlocks.length) {
    const b = rawBlocks[i];
    if (b.type !== 'ordered') { blocks.push(b); i++; continue; }
    const items = [];
    while (i < rawBlocks.length && rawBlocks[i].type === 'ordered') {
      const orderedLines = rawBlocks[i].lines;
      i++;
      let subLines = [];
      if (i < rawBlocks.length && rawBlocks[i].type === 'unordered') {
        subLines = rawBlocks[i].lines;
        i++;
      }
      orderedLines.forEach((line, idx) => {
        const isLast = idx === orderedLines.length - 1;
        items.push({ text: line.replace(/^\d+[.)]\s+/, ''), subLines: isLast ? subLines : [] });
      });
    }
    blocks.push({ type: 'ordered-merged', items });
  }

  // Separate ordered-list blocks can be created by blank lines, headings,
  // or intervening prose. Keep their visible numbering continuous across
  // this answer while leaving nested unordered detail lists untouched.
  let nextOrderedStart = 1;
  const renderedBlocks = blocks.map((block) => {
    const html = renderAnswerBlock(block, sources, nextOrderedStart);
    if (block.type === 'ordered-merged') nextOrderedStart += block.items.length;
    return html;
  });

  return `<div class="ai-answer">${renderedBlocks.join('')}</div>`;
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
// `s` here is positioned so its index+1 matches the [N] markers
// renderInlineAnswerText() just linked inline — the leading number chip
// is the same [N], so a reader can match an inline citation back to this
// list (or just click the inline [N] itself) without guessing.
function aiSearchSourcesHtml(sources) {
  if (!sources || !sources.length) return '';
  return `<div class="ai-search-sources">
    <div class="ai-search-sources-label">SOURCES · ${sources.length}</div>
    <div class="ai-source-chips">${sources.map((s, i) => `
      <a class="ai-source-chip" href="#/detail/${s.id}" title="${escapeHtml(s.title)}">
        <span class="ai-source-chip-num">[${i + 1}]</span>
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

// Runs (or re-runs, via the error state's "재검색" button) one turn's
// search request against `question`, rendering into `turnEl`'s body.
// Pulled out of the form's submit handler so a failed turn can retry
// itself in place — same turn element, same question — without the user
// having to retype it into the input box.
// Records a successful turn and flips the module into its "answered"
// state — shared by both the non-streaming JSON branch (insufficient-
// evidence, or a client too old/odd to get a stream) and the streaming
// branch's `done` event, so the two paths never duplicate this bookkeeping.
function finishAiSearchTurn(turnEl, bodyEl, question, answer, sources) {
  aiSearchHistory.push({ role: 'user', content: question });
  aiSearchHistory.push({ role: 'assistant', content: answer });
  bodyEl.innerHTML = `
    ${renderAnswerHtml(answer, sources)}
    <button type="button" class="ai-copy-btn" title="답변 복사" aria-label="답변 복사" data-answer="${escapeHtml(String(answer || '').replace(/```chart[\s\S]*?```/g, '').trim())}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    ${aiSearchSourcesHtml(sources)}
  `;
  // On a retry, this turn wasn't recorded the first time around (only a
  // successful turn gets persisted) — push now, and only now, so a
  // Home re-render replays exactly the turns that actually succeeded.
  aiSearchTurnsHtml.push(turnEl.outerHTML);
  const resetBtn = document.getElementById('ai-search-reset-btn');
  if (resetBtn) resetBtn.disabled = false;
}

// Runs (or re-runs, via the error state's "재검색" button) one turn's
// search request against `question`, rendering into `turnEl`'s body.
// Pulled out of the form's submit handler so a failed turn can retry
// itself in place — same turn element, same question — without the user
// having to retype it into the input box.
//
// Requests streaming (Accept: text/event-stream) so the model's own
// tokens render as they arrive instead of waiting for the full answer
// AND the citation-verification pass on top of it — see
// server/routes/search.js's wantsStream()/finalizeAnswer(). A response
// whose content-type comes back as JSON anyway (the insufficient-
// evidence case, or a 4xx/5xx before any stream could start) is handled
// exactly like before streaming existed; this is purely additive.
async function runAiSearchTurn(turnEl, question, submitBtn) {
  const moduleEl = document.getElementById('ai-search');
  const bodyEl = turnEl.querySelector('.ai-search-turn-body');
  bodyEl.innerHTML = '<p class="ai-search-status"></p>';
  const statusEl = bodyEl.querySelector('.ai-search-status');
  if (submitBtn) submitBtn.disabled = true;
  startAiSearchStatus(moduleEl, statusEl);
  // Follow-up questions only — the opening question's turn sits right
  // where the user already is (just below the search box they typed
  // into), so it needs no scroll at all; forcing one there was pure
  // unwanted motion. aiSearchHistory only gains entries once a turn
  // actually finishes (see finishAiSearchTurn), so checking its length
  // here — before this turn's own outcome is known — correctly reflects
  // whether an earlier turn already completed, including on a retry of
  // this exact turn.
  const isFollowup = aiSearchHistory.length > 0;
  // Follows the growing answer down the page as it streams in — a long
  // follow-up answer otherwise scrolls past the bottom of the viewport
  // with nothing bringing it back into view until streaming finishes.
  // Throttled rather than called on every token: scrollIntoView's smooth
  // animation re-targeting dozens of times a second (token arrival rate)
  // is unnecessary work and reads as jitter rather than a smooth follow.
  //
  // Production bug: block: 'end' aligns the element's BOTTOM edge to the
  // viewport's bottom edge — for an answer taller than one screen, that
  // pushes its TOP (the question itself) up above the visible area
  // entirely, which is exactly the "even the question got covered" report.
  // window.scrollBy only ever advances by the actual overflow amount
  // instead of re-aligning the whole element, so each call moves the view
  // exactly as far as the newly-streamed content actually grew — it can
  // still scroll the question off the top for a genuinely long answer
  // (unavoidable once content exceeds one screen), but never overshoots
  // past what the content growth itself justifies.
  let lastFollowAt = 0;
  const followGrowingAnswer = () => {
    if (!isFollowup) return;
    const now = Date.now();
    if (now - lastFollowAt < 150) return;
    lastFollowAt = now;
    const overflow = turnEl.getBoundingClientRect().bottom - window.innerHeight;
    if (overflow > 0) {
      window.scrollBy({ top: overflow, behavior: 'smooth' });
    }
  };
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ question, history: aiSearchHistory }),
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        bodyEl.innerHTML = aiSearchErrorHtml(body.error || 'AI 검색 중 오류가 발생했습니다.');
        return;
      }
      finishAiSearchTurn(turnEl, bodyEl, question, body.answer, body.sources);
      return;
    }

    // Streaming: raw model tokens (including their own un-remapped [N]
    // markers) render as plain text the instant they arrive — correctness
    // (citation verification/remapping) only ever delays the swap to the
    // polished version on `done`, never the first visible output.
    bodyEl.innerHTML = '<div class="ai-search-streaming-text"></div>';
    const streamEl = bodyEl.querySelector('.ai-search-streaming-text');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let rawText = '';
    let firstTokenSeen = false;
    let finished = false;
    while (!finished) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();
      for (const block of blocks) {
        const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!eventLine || !dataLine) continue;
        let data;
        try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        const eventName = eventLine.slice(6).trim();
        if (eventName === 'token') {
          if (!firstTokenSeen) { firstTokenSeen = true; stopAiSearchStatus(moduleEl); }
          rawText += data.delta;
          // Reuses the exact same Markdown-ish renderer the final polished
          // answer uses (renderAnswerHtml), with no `sources` — so **bold**
          // actually renders instead of showing literal asterisks while
          // streaming, and [N] citation markers are simply dropped (not
          // shown as dangling brackets) until the done event supplies real
          // source links for them. It also trims each block's own leading/
          // trailing whitespace already, so the stray leading newline a
          // model's completion commonly opens with never shows as a blank
          // line pushing the answer away from the question above it, the
          // same gap the final render never had.
          streamEl.innerHTML = renderAnswerHtml(rawText, null);
          followGrowingAnswer();
        } else if (eventName === 'done') {
          finishAiSearchTurn(turnEl, bodyEl, question, data.answer, data.sources);
          // Bypasses the throttle for this last call — the polished swap
          // can change the answer's final height, so this makes sure its
          // actual end is what's left in view, not wherever the last
          // throttled mid-stream check happened to land.
          lastFollowAt = 0;
          followGrowingAnswer();
          finished = true;
        } else if (eventName === 'error') {
          bodyEl.innerHTML = aiSearchErrorHtml(data.message || 'AI 검색 중 오류가 발생했습니다.');
          finished = true;
        }
        if (finished) break;
      }
    }
  } catch (err) {
    bodyEl.innerHTML = aiSearchErrorHtml('AI 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    stopAiSearchStatus(moduleEl);
    if (submitBtn) submitBtn.disabled = false;
  }
}

function aiSearchErrorHtml(message) {
  return `<p class="meta">${escapeHtml(message)}</p>
    <button type="button" class="btn ai-search-retry-btn">재검색</button>`;
}

function bindAiSearchForm() {
  const form = document.getElementById('ai-search-form');
  if (!form) return;
  const resultEl = document.getElementById('ai-search-result');
  const submitBtn = form.querySelector('button[type="submit"]');
  const resetBtn = document.getElementById('ai-search-reset-btn');
  if (resetBtn) {
    resetBtn.onclick = () => {
      aiSearchHistory = [];
      aiSearchTurnsHtml = [];
      resultEl.innerHTML = '';
      resetBtn.disabled = true;
    };
  }

  // Delegated once on the result container — covers every turn's retry
  // button, including ones added after this bind (each new turn's button
  // is a fresh element, but the listener lives on their shared ancestor).
  resultEl.onclick = (e) => {
    const btn = e.target.closest('.ai-search-retry-btn');
    if (!btn || submitBtn.disabled) return;
    const turnEl = btn.closest('.ai-search-turn');
    // Not parsed from the turn-q line's textContent — it's the tag label
    // ("opening"/"follow-up") and the question concatenated with no
    // separator, so a straight textContent read would retry with the
    // wrong string. The original question is kept verbatim in a data
    // attribute set when the turn was created instead.
    runAiSearchTurn(turnEl, turnEl.dataset.question, submitBtn);
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('ai-search-input');
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
    turnEl.dataset.question = question;
    turnEl.innerHTML = `
      <div class="ai-search-turn-q">${isFollowup ? '<span class="ai-search-turn-followup-tag">follow-up</span>' : '<span class="ai-search-turn-initial-tag">opening</span>'}${escapeHtml(question)}</div>
      <div class="ai-search-turn-body"><p class="ai-search-status"></p></div>
    `;
    resultEl.appendChild(turnEl);
    // The opening question's turn appears right where the user already
    // is — no scroll needed, and forcing one there was unwanted motion
    // (reported: it could scroll clear past the search module into page
    // content further down, like the Home carousels). Only a follow-up's
    // new question/answer needs to jump to the TOP of the viewport — it
    // appears below whatever earlier turn(s) are already on screen, often
    // out of view entirely. block: 'start' (not 'nearest') so it lands at
    // the top, not just barely scrolled into view at the bottom edge.
    // runAiSearchTurn's own followGrowingAnswer() then keeps the view
    // tracking downward as the streamed answer grows past one screen.
    if (isFollowup) turnEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Cleared immediately, not just on success — otherwise the same
    // question sits visible twice while the request is in flight: once
    // still in the input box, once in the new turn's question label below.
    input.value = '';
    await runAiSearchTurn(turnEl, question, submitBtn);
  };
}

// Groups the flat picks list (kind='team') by item_id so card rendering
// can look up "which team(s) picked this item" with one Map.get() instead
// of filtering the whole list per card. Shared by every page that renders
// itemCard() so the lookup/display logic never duplicates.
function buildTeamPicksMap(teamPicks) {
  const map = new Map();
  for (const p of teamPicks) {
    if (!map.has(p.item_id)) map.set(p.item_id, []);
    map.get(p.item_id).push(p);
  }
  return map;
}

async function renderHome() {
  const [sectors, items, ranking, teamPicks] = await Promise.all([
    api('/sectors'),
    api('/items?status=Published&limit=100'),
    api('/picks/ranking').catch(() => []),
    api('/picks?kind=team').catch(() => []),
  ]);
  const importantIds = new Set(ranking.map((r) => r.id));
  const savedIds = getPersonalSaveIds();
  const teamPicksByItem = buildTeamPicksMap(teamPicks);
  const { byParent } = buildSectorMaps(sectors);
  const roots = applyHomeRootOrder((byParent.get(null) || []).filter((s) => HOME_THEME_ROOT_NAMES.includes(s.name)));
  homeThemeRootsCache = roots;

  const themesHtml = roots.length
    ? roots.map((root, i) => homeThemeRoot(root, byParent, items, importantIds, savedIds, teamPicksByItem, i === 0)).join('')
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
  if (aiSearchTurnsHtml.length) {
    document.getElementById('ai-search-result').innerHTML = aiSearchTurnsHtml.join('');
  }
  renderDailyStatusBar();
}

// Green/red light + today's (KST) Daily Discovery log, just under the
// topbar — Home only (hidden on every other route by router()). A failed
// status fetch leaves the bar hidden rather than showing a false red
// light, since "couldn't check" and "collection didn't run" are different
// things.
async function renderDailyStatusBar() {
  const bar = document.getElementById('daily-status-bar');
  if (!bar) return;
  try {
    const status = await api('/sources/daily-discovery-status');
    const dotClass = status.completedToday ? 'ok' : 'pending';
    const text = status.completedToday ? '오늘 기사 수집 완료' : '오늘 기사 수집 미완료';
    bar.innerHTML = `<span class="daily-status-dot ${dotClass}"></span><span>${text}</span>`;
    bar.hidden = false;
  } catch (err) {
    bar.hidden = true;
  }
}

async function renderArchive(query = {}) {
  // scrollTo is a transient hash param (set by the month sidebar below, see
  // its own comment) meaning "scroll to this month after this render" — it
  // must never leak into itemsQuery/month-counts API calls or into other
  // derived hrefs (tab links, filter apply, etc.), so it's stripped from
  // `query` immediately rather than threaded through every ...query spread.
  const scrollToMonth = query.scrollTo;
  if (scrollToMonth) { query = { ...query }; delete query.scrollTo; }

  // 최신 자료/전체 결과였던 두 화면을 하나의 "자료" 탭으로 통합했다 — 최신순
  // 정렬은 그대로 서버가 보장하고(items.js의 published_at DESC), 여기서는
  // 연/월 구분선만 추가한다. 뉴스(daily_report)/보고서(archive) 탭은 이
  // 통합 화면 안의 카테고리 필터로 남는다. 기본값은 두 카테고리를 모두
  // 보여주는 "전체" — 명시적으로 탭을 선택해야 좁혀진다.
  const category = query.category === 'archive' || query.category === 'daily_report' ? query.category : null;
  const itemsQuery = category ? { ...query, category } : query;
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
  const [sectors, usages, sources, itemsPage, ranking, teamPicks, monthCounts] = await Promise.all([
    api('/sectors'), api('/usages'), api('/sources'), api('/items?status=Published' + toQuery({ ...itemsQuery, limit: 100, offset }), { includeMeta: true }),
    api('/picks/ranking').catch(() => []),
    api('/picks?kind=team').catch(() => []),
    // Independent of this page's limit/offset — see month-counts' own
    // comment in items.js for why the sidebar can't be built from
    // `items` alone (a month before the current 100-item page would
    // otherwise look like it had vanished rather than just being on a
    // later page).
    api('/items/month-counts?status=Published' + toQuery(itemsQuery)).catch(() => []),
  ]);
  const items = itemsPage.data;
  const teamPicksByItem = buildTeamPicksMap(teamPicks);
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

  // Month-divider list for whichever page is currently loaded (purely a
  // display grouping of the already-fetched `visibleItems`).
  const monthGroups = groupByMonth(visibleItems);
  // Year-month jump sidebar — the ORIGINAL behavior was a smooth in-page
  // scroll to that month's divider, never a filter; restoring that, but
  // still built from the server's full month-counts (independent of this
  // page's limit/offset) so a month outside the currently loaded page is
  // still listed. For a month already on this page, the link just scrolls
  // (via scrollTo + the effect below) at the current offset. For a month
  // on a DIFFERENT page, clicking first jumps to the page that contains
  // it (computed from the cumulative counts, same ORDER BY the list query
  // itself uses) and then scrolls once that page has rendered.
  let cumulativeBeforeThisMonth = 0;
  const monthNavHtml = monthCounts.length
    ? `<nav class="archive-month-nav" aria-label="연-월 바로가기">${monthCounts.map((r) => {
        // Matches groupByMonth()'s own key scheme (0-based month, 'unknown'
        // for a NULL published_at) below, so the divider id this links to
        // and the id groupByMonth gives that divider are always the same
        // string. NULLS LAST in the list query's own ORDER BY means the
        // unknown bucket sorts last here too, so the same cumulative-offset
        // math still lands on the right page for it.
        const [y, m] = r.month_key ? r.month_key.split('-').map(Number) : [null, null];
        const groupKey = r.month_key ? `${y}-${m - 1}` : 'unknown';
        const label = r.month_key ? `${y}년 ${m}월` : '날짜 미확인';
        const targetOffset = Math.floor(cumulativeBeforeThisMonth / 100) * 100;
        cumulativeBeforeThisMonth += r.count;
        const href = '#/archive?' + toQuery({ ...query, offset: targetOffset || '', scrollTo: groupKey }).slice(1);
        return `<a class="archive-month-nav-item" href="${href}">
          <span class="archive-month-nav-label">${label}</span>
          <span class="archive-month-nav-count">${r.count}</span>
        </a>`;
      }).join('')}</nav>`
    : '';

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
       <div class="archive-filter-panel-inner">
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
      </div>

      <div class="archive-layout">
        ${monthNavHtml}
        <div class="section archive-main">
          <div class="section-header"><h2>자료</h2><span class="count">${
            // visibleItems.length is only this one page's count (limit=100) —
            // showing it as "전체" undercounted every filtered result past
            // the first page. monthCounts (already fetched for the sidebar,
            // same filters, independent of limit/offset — see its own
            // comment in items.js) gives the real total for the 전체 view.
            // 내 저장/팀 Pick views stay page-local counts: they're a
            // client-side filter over whatever page happens to be loaded,
            // so there's no cheap way to get their true cross-page total
            // without fetching every page.
            view === 'all'
              ? monthCounts.reduce((sum, r) => sum + Number(r.count), 0)
              : visibleItems.length
          }개</span></div>
          ${emptyState}
          ${monthGroups.map((g) => `
            <div class="archive-month-divider" id="archive-month-${g.key}">${g.label}</div>
            <div class="grid">${g.items.map((it) => itemCard(it, importantIds, savedIds, teamPicksByItem)).join('')}</div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  // The month sidebar's smooth-scroll landing: the link already navigated
  // to whichever page/offset actually contains this month (see monthNavHtml
  // above), so by the time this render runs the divider is on the page —
  // just scroll to it. replaceState (not location.hash=) strips the
  // one-shot scrollTo param afterward without firing another hashchange/
  // re-render.
  //
  // skipNextScrollReset (declared with router() further down) tells
  // router() to skip its own window.scrollTo(0, 0) for this one render —
  // without it, that reset runs right after this function returns and
  // instantly snaps to the top BEFORE this scrollIntoView gets a chance to
  // animate, so the visible result was always "jump to the very top, then
  // smooth-scroll back down" no matter where the click happened from.
  // Skipping it lets the animation start from wherever the user actually
  // was.
  if (scrollToMonth) {
    skipNextScrollReset = true;
    document.getElementById(`archive-month-${scrollToMonth}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', '#/archive?' + toQuery(query).slice(1));
  }

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
  // The panel's open/close animation is pure CSS now (grid-template-rows
  // 0fr <-> 1fr on .archive-filter-panel — see style.css), which always
  // matches the content's real height exactly at every point in the
  // transition, so no JS height measurement is needed here at all.
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
      // `key` doubles as this group's divider element id (prefixed
      // archive-month- below) so the year-month sidebar can scroll straight
      // to it — kept on the group itself rather than re-derived from the
      // label string, which isn't a safe DOM id (contains 년/월/공백).
      groups.push({ key, label: valid ? `${d.getFullYear()}년 ${d.getMonth() + 1}월` : '날짜 미확인', items: [] });
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
async function renderDetail(id) {
  const [item, picks, related, isAdmin] = await Promise.all([
    api(`/items/${id}`),
    api(`/picks?item_id=${id}`).catch(() => []),
    api(`/items/${id}/related`).catch(() => []),
    isAdminAuthenticated(),
  ]);
  const usageTags = (item.usages || []).map((u) => `<span class="pill">${u.name}</span>`).join('');
  const sectorTags = (item.sectors || []).map((s) => `<span class="pill">${s.name}</span>`).join('');
  const companyTags = (item.companies || []).map((c) => `<span class="pill">🏢 ${c.name}</span>`).join('');

  const isSaved = getPersonalSaveIds().has(item.id);
  const teamPicksByItem = buildTeamPicksMap(picks.filter((p) => p.kind === 'team'));

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
        ${teamPickButtonHtml(item.id, teamPicksByItem, 'btn')}
        ${isAdmin ? '<button class="btn" id="delete-item-btn" style="margin-left:auto;color:#b91c1c">삭제</button>' : ''}
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
  const deleteItemBtn = document.getElementById('delete-item-btn');
  if (deleteItemBtn) {
    deleteItemBtn.onclick = async () => {
      if (!confirm('이 자료를 영구적으로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
      try {
        await api(`/items/${id}`, { method: 'DELETE' });
      } catch (err) {
        alert(`삭제 실패: ${err.message}`);
        return;
      }
      location.hash = '#/archive';
    };
  }
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
// Per-link sector_links pills used to link straight to each institution's
// own sector-specific page, but most of those individual URLs have since
// broken (site restructuring, paywalls, etc.), leaving this column blank
// for most rows — a per-row fallback would leave the column inconsistent
// row to row. Unified instead: every row links to a Google search for
// that institution's name, which always resolves to something useful
// even when the institution's own site has moved or reorganized.
function sectorLinksHtml(sourceName) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(sourceName)}`;
  return `<a class="pill" href="${url}" target="_blank" rel="noopener" title="${sourceName} 구글 검색">구글 검색</a>`;
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
    <tr><th>이름</th><th>유형</th><th>지역</th><th>품목</th><th>커버리지</th><th>섹터별 링크</th><th>접근형식</th><th>업데이트 주기</th><th>비고</th><th></th></tr>
    ${refs.map((s) => `<tr>
      <td class="cell-strong">${s.name}</td>
      <td class="cell-muted">${s.source_type || '-'}</td>
      <td class="cell-muted">${s.region || '-'}</td>
      <td class="cell-muted">${(s.commodities || []).join(', ') || '-'}</td>
      <td class="cell-muted">${s.coverage_note || '-'}</td>
      <td class="cell-muted">${sectorLinksHtml(s.name)}</td>
      <td class="cell-muted">${(s.access_format || []).join(', ') || '-'}</td>
      <td class="cell-muted">${s.update_frequency || '-'}</td>
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

// The add/edit form's fields, shared verbatim by both the Sources tab's
// bottom-of-page placement and the Reference tab's top-right popover
// (see renderSourceManager below) — only the surrounding <details>
// wrapper's position/styling differs between the two.
//
// "대표 링크로 메타데이터 자동 채우기": same idea as Review's AI draft
// generation (paste a link, let AI fill the blanks), applied to this
// form's own fields instead of an article's summary/insight — see
// bindSourceExtractButton() below for the fetch + fill logic.
function sourceFormFieldsHtml(view) {
  return `
    <input type="hidden" id="s-edit-id">
    <div class="form-row s-extract-row">
      <label>대표 링크로 메타데이터 자동 채우기</label>
      <div class="s-extract-controls">
        <input id="s-extract-url" placeholder="기관 사이트 대표 URL (예: https://...)">
        <button type="button" class="btn" id="s-extract-btn">메타데이터 추출</button>
      </div>
      <p class="meta" id="s-extract-status"></p>
    </div>
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
  `;
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

  // Sources(전체) 탭은 이제 자동 수집원만 보여준다 — 참고용(is_reference) 소스는
  // 레퍼런스 탭에 이미 전용 목록이 있고, 활성/일시중지 토글 대상도 아니라서
  // 여기 같이 섞여 있으면 "이 화면은 무엇을 운영 중인가"를 한눈에 보기 어려웠다
  // (피드백의 1차 "용도 분리" 항목 — 기존 is_reference 필드만으로 반영 가능,
  // 스키마/API 변경 없음).
  const autoSources = view === 'all' ? sources.filter((s) => !s.is_reference) : [];
  const sourceStatusOf = (s) => (s.is_active === false ? 'paused' : s.last_error ? 'error' : s.stale ? 'stale' : 'ok');
  const statusFilter = ['paused', 'error', 'stale', 'ok'].includes(query.status) ? query.status : '';
  const statusLabel = { paused: '일시중지', error: '오류', stale: 'Stale', ok: '정상' };
  const statusCounts = autoSources.reduce((acc, s) => {
    const k = sourceStatusOf(s);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const visibleAutoSources = statusFilter ? autoSources.filter((s) => sourceStatusOf(s) === statusFilter) : autoSources;

  app.innerHTML = `
    <h1>${view === 'reference' ? '레퍼런스' : 'Sources'}</h1>
    <p class="page-lede">${view === 'reference' ? '자동 수집 대상이 아니더라도 참고 가치가 높은 유지 시장 리서치/통계 출처를 기록합니다.' : 'RSS 등 자동 수집 소스의 상태를 관리합니다. (참고용 출처는 레퍼런스 탭에서 관리)'}</p>
    ${view === 'all' ? `<button class="btn primary btn-compact" id="collect-all-btn">전체 자료 지금 수집</button>
    <div class="collect-all-result" id="collect-all-result"></div>
    <div class="filters" id="source-status-filter">
      <select id="s-f-status">
        <option value="">상태 전체 (${autoSources.length})</option>
        ${['error', 'paused', 'stale', 'ok'].map((k) => `<option value="${k}" ${statusFilter === k ? 'selected' : ''}>${statusLabel[k]} (${statusCounts[k] || 0})</option>`).join('')}
      </select>
    </div>
    <table class="sources-table">
      <tr><th>이름</th><th>수집방식</th><th>오너</th><th>주기(일)</th><th>신뢰등급</th><th>마지막 수집</th><th>상태</th><th></th></tr>
      ${visibleAutoSources.map((s) => `<tr class="${s.is_active === false ? 'source-row-inactive' : ''}">
        <td class="cell-strong">${s.name}</td><td class="cell-muted">${s.method}</td><td class="cell-muted">${s.owner || '-'}</td><td class="cell-muted">${s.frequency_days}</td>
        <td class="cell-muted">${s.trust_grade}</td><td class="cell-muted">${s.last_collected_at ? new Date(s.last_collected_at).toLocaleDateString() : '-'}</td>
        <td>${s.is_active === false
          ? `<span class="pill"${s.last_error ? ` title="일시중지 전 마지막 오류: ${s.last_error}"` : ''}>일시중지됨</span>`
          : (s.last_error ? `<span class="status-fail" title="${s.last_error}">오류</span>` : (s.stale ? '<span class="status-fail">Stale</span>' : '<span class="status-ok">정상</span>'))}</td>
        <td>
          <button class="btn-text-action" data-toggle-active-source="${s.id}">${s.is_active === false ? '활성화' : '일시중지'}</button>
          <button class="btn-text-action" data-delete-source="${s.id}">삭제</button>
        </td>
      </tr>`).join('')}
    </table>
    <details class="section" id="s-form-section">
      <summary id="s-form-summary">소스 추가</summary>
      ${sourceFormFieldsHtml(view)}
    </details>
    ${collectionWarningHtml(sources)}` : `
    <div class="ref-toolbar">
      <div class="filters" id="ref-filters">
        <select id="ref-f-region"><option value="">지역 전체</option>${refRegionOpts}</select>
        <select id="ref-f-commodity"><option value="">품목 전체</option>${refCommodityOpts}</select>
        <button class="btn" id="ref-f-clear">초기화</button>
      </div>
      <details class="ref-add-details" id="s-form-section">
        <summary id="s-form-summary" class="btn primary">+ 소스 추가</summary>
      </details>
    </div>
    <div class="ref-add-form-wrap" id="ref-add-form-wrap" hidden>${sourceFormFieldsHtml(view)}</div>
    <div id="ref-sources-result">${referenceSourcesTable(sources, { region: query.region, commodity: query.commodity })}</div>
    `}
  `;
  // Sources(전체) 상태 필터 — 해시 쿼리(?status=)를 바꿔 같은 route를 다시
  // 그린다. ref-f-region/commodity처럼 제자리 재렌더만 해도 되지만, 이
  // 필터는 브라우저 뒤로가기로 이전 상태를 복원할 수 있는 편이 운영자가
  // "오류만 보던 중" 다른 탭에 갔다와도 맥락을 잃지 않아 더 낫다.
  document.getElementById('s-f-status')?.addEventListener('change', (e) => {
    location.hash = '#/sources' + toQuery({ status: e.target.value }).replace(/^&/, '?');
  });
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
  // Reference tab only: the "+ 소스 추가" <details> holds just the summary
  // button (see the template above) — the actual form fields live in a
  // separate full-width wrapper right after .ref-toolbar so opening it
  // pushes the results table down the page, rather than revealing the
  // form squeezed inside the toolbar's flex row next to the filters.
  // Mirrors the <details> element's native open/closed state via its
  // 'toggle' event, which also fires on the programmatic `.open = true`
  // the edit-row handler below uses.
  const refAddDetails = document.getElementById('s-form-section');
  const refAddFormWrap = document.getElementById('ref-add-form-wrap');
  if (refAddDetails && refAddFormWrap) {
    refAddDetails.addEventListener('toggle', () => {
      refAddFormWrap.hidden = !refAddDetails.open;
    });
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
    document.getElementById('s-extract-url').value = '';
    document.getElementById('s-extract-status').textContent = '';
  }

  // Shared between the initial render and the Reference Sources filter's
  // in-place re-render (filtering replaces #ref-sources-result's innerHTML,
  // which drops any listeners bound to the old nodes) — re-wires both
  // 편집/삭제 against whatever [data-edit-source]/[data-delete-source]
  // buttons currently exist in the DOM.
  function bindReferenceSourceRowActions() {
    document.querySelectorAll('[data-toggle-active-source]').forEach((btn) => {
      btn.onclick = async () => {
        const s = sources.find((row) => String(row.id) === btn.dataset.toggleActiveSource);
        if (!s) return;
        const nextActive = s.is_active === false;
        try {
          await api(`/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: nextActive }) });
        } catch (err) {
          alert(`변경 실패: ${err.message}`);
          return;
        }
        renderSourceManager(view, query);
      };
    });
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
        document.getElementById('s-extract-url').value = s.url || '';
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
        (refAddFormWrap || document.getElementById('s-form-section')).scrollIntoView({ behavior: 'smooth' });
      };
    });
  }
  bindReferenceSourceRowActions();
  document.getElementById('s-cancel-edit').onclick = () => resetForm();

  // Only fills a field that's currently blank — a value the reviewer has
  // already typed (including while re-running extraction after editing
  // the URL) is never silently overwritten.
  function fillIfBlank(id, value) {
    const el = document.getElementById(id);
    if (!el.value && value) el.value = value;
  }

  document.getElementById('s-extract-btn').onclick = async () => {
    const url = document.getElementById('s-extract-url').value.trim();
    const statusEl = document.getElementById('s-extract-status');
    if (!url) { statusEl.textContent = '대표 URL을 먼저 입력하세요.'; return; }
    const btn = document.getElementById('s-extract-btn');
    btn.disabled = true;
    statusEl.textContent = '추출 중...';
    try {
      const meta = await api('/sources/extract-metadata', { method: 'POST', body: JSON.stringify({ url }) });
      fillIfBlank('s-url', url);
      const sug = meta.suggested;
      fillIfBlank('s-name', (sug && sug.name) || meta.title);
      fillIfBlank('s-coverage', (sug && sug.coverage_note) || meta.summary);
      if (sug) {
        fillIfBlank('s-type', sug.source_type);
        fillIfBlank('s-region', sug.region);
        if (sug.commodities.length) fillIfBlank('s-commodities', sug.commodities.join(','));
        if (sug.access_format.length) fillIfBlank('s-access-format', sug.access_format.join(','));
        fillIfBlank('s-update-freq', sug.update_frequency);
        fillIfBlank('s-usage-note', sug.usage_note);
        statusEl.textContent = '메타데이터를 반영했습니다. 추정이 어려운 항목은 직접 입력해 주세요.';
      } else {
        statusEl.textContent = '페이지 정보는 가져왔지만 AI 분류에는 실패했습니다 — 유형/지역/품목 등은 직접 입력해 주세요.';
      }
    } catch (err) {
      statusEl.textContent = `추출 실패: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  };

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

  if (view === 'reference') startReferenceTour();
}

async function renderSources(query = {}) { return renderSourceManager('all', query); }
async function renderReference(query = {}) { return renderSourceManager('reference', query); }

// 운영 가시성 대시보드: 실패 원인, 소스별 수집량/품질, 미검수 적체량을
// 한 화면에 모아 보여준다. 숫자마다 집계 기준(기간/정의)을 함께 표시해,
// "지금 세고 있는 게 정확히 뭔지" 숫자만 봐서는 알 수 없는 상태를 피한다.
// Shared by Review's gate-hold notice below — human-readable labels for
// the machine reasons aiDraft.js's applyAiDraftIfEligible() persists to
// gate_hold_reason, so a reviewer sees plain language, not an enum value.
const GATE_HOLD_LABELS = {
  no_sector_or_usage_tag: 'AI가 섹터/용도 분류를 제시하지 않았습니다.',
  invalid_source_url: '원문 URL이 올바르지 않습니다.',
  implausible_published_at: '발행일이 비정상적입니다(미래 날짜 등).',
  unusable_ai_summary: 'AI 요약 생성에 실패했거나 내용이 비정상적입니다.',
  bot_block_or_empty_title: '제목이 비었거나 봇 차단 페이지로 추정됩니다.',
  no_grounded_sector: 'AI가 제시한 섹터가 본문 내용과 연결되지 않습니다.',
};

// Mirrors the exact failureType strings provider.js's markFallback()/
// inline classification actually assign (timeout, network, rate_limit,
// server_error, auth, empty_response, degenerate_output,
// first_token_timeout) plus 'unclassified' (stats.js's label for a NULL
// ai_failure_type — an application-level failure, e.g. invalid JSON from
// the model, never gets a transport-level failureType at all). Any value
// outside this set (a future provider.js addition this list hasn't
// caught up with yet) still shows as its own raw string rather than
// disappearing, so nothing is ever silently unlabeled.
function opsFailureLabel(failureType) {
  const LABELS = {
    timeout: 'AI 응답 시간 초과', network: '네트워크 오류',
    rate_limit: 'AI 호출 제한(rate limit)', server_error: 'AI 제공처 서버 오류',
    auth: 'AI 제공처 인증 실패', empty_response: 'AI 응답 없음(빈 응답)',
    degenerate_output: 'AI 응답 반복 오류', first_token_timeout: '첫 토큰 응답 지연',
    unclassified: '미분류 (원인 기록 없음)',
  };
  return LABELS[failureType] || failureType;
}

const OPS_LAST_SNAPSHOT_KEY = 'ra_ops_last_snapshot';
let opsTriageOffset = 0;
let opsTriageShowClosed = false;
let opsTriageExpanded = false;
const OPS_TRIAGE_STATUS_LABELS = {
  open: '확인 필요', investigating: '분석 중', retry_planned: '재시도 예정',
  resolved: '해결', dismissed: '제외',
};
const OPS_TRIAGE_REASON_LABELS = {
  ai_failed: 'AI 생성 실패', gate_held: '자동 발행 보류',
  stale_pending: 'AI 처리 장기 대기', aged_draft: '24시간 이상 미검수',
};

// A section-level fetch failure (reported by the server as {ok:false,
// error}) renders this row instead of silently showing an empty table —
// "집계 실패" must never look the same as "집계 결과 0건".
function opsSectionErrorRow(colspan, error) {
  return `<tr><td colspan="${colspan}" class="stale">집계 실패: ${error}</td></tr>`;
}

function renderOpsTriageHtml(triage) {
  if (!triage?.ok) {
    return `<div class="section ops-triage"><div class="section-header"><h2>Draft 실패·적체 트리아지</h2></div><p class="stale">목록을 불러오지 못했습니다: ${escapeHtml(triage?.error || '응답이 없습니다.')}</p></div>`;
  }
  const rows = triage.rows.map((item) => {
    const reason = OPS_TRIAGE_REASON_LABELS[item.triage_reason] || item.triage_reason;
    const detail = item.gate_hold_reason
      ? (GATE_HOLD_LABELS[item.gate_hold_reason] || item.gate_hold_reason)
      : item.ai_error || opsFailureLabel(item.ai_failure_type);
    const sourceUrl = /^https?:\/\//i.test(item.source_url || '')
      ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">원문</a>` : '';
    return `<tr data-ops-triage-id="${item.id}">
      <td><span class="ops-triage-reason">${escapeHtml(reason)}</span><div class="meta">${escapeHtml(detail || '추가 사유 없음')}</div></td>
      <td><strong>${escapeHtml(item.title || '(제목 없음)')}</strong><div class="meta">${escapeHtml(item.source_name || '출처 미상')} · ${formatDateOnly(item.collected_at)} · ${sourceUrl}</div></td>
      <td><select class="ops-triage-status" aria-label="트리아지 상태">${Object.entries(OPS_TRIAGE_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${item.triage_status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></td>
      <td><textarea class="ops-triage-note" rows="2" maxlength="2000" placeholder="확인 내용 또는 후속 조치 메모">${escapeHtml(item.triage_note || '')}</textarea></td>
      <td><button class="btn ops-triage-save" type="button" onclick="saveOpsDraftTriage(${item.id}, this)">저장</button><span class="ops-triage-saved" aria-live="polite"></span></td>
    </tr>`;
  }).join('');
  const first = triage.total ? triage.offset + 1 : 0;
  const last = triage.offset + triage.rows.length;
  return `<div class="section ops-triage">
    <div class="section-header"><h2>Draft 실패·적체 트리아지</h2><div class="ops-triage-tools"><span class="meta">${first}–${last} / ${triage.total}건</span><button class="btn" type="button" onclick="toggleOpsTriageClosed()">${triage.includeClosed ? '미해결만 보기' : '해결·제외 포함'}</button></div></div>
    <p class="ops-triage-note-help">실패·자동 발행 보류·15분 이상 처리 대기·24시간 이상 미검수 Draft를 우선 표시합니다. 상태와 메모만 기록하며, AI 재시도·자료 발행 상태에는 영향을 주지 않습니다.</p>
    <details class="ops-triage-details" ${opsTriageExpanded ? 'open' : ''} ontoggle="setOpsTriageExpanded(this.open)">
      <summary>상세 테이블 · ${triage.total}건</summary>
      ${triage.rows.length ? `<div class="ops-triage-table-wrap"><table class="ops-triage-table"><thead><tr><th>분류 / 사유</th><th>자료</th><th>조치 상태</th><th>운영 메모</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="ops-triage-empty">현재 트리아지 대상 Draft가 없습니다.</p>'}
      <div class="ops-triage-pagination">${triage.offset > 0 ? `<button class="btn" type="button" onclick="changeOpsTriagePage(-1)">이전</button>` : ''}${triage.hasMore ? `<button class="btn" type="button" onclick="changeOpsTriagePage(1)">다음 100건</button>` : ''}</div>
    </details>
  </div>`;
}

window.changeOpsTriagePage = function changeOpsTriagePage(direction) {
  opsTriageOffset = Math.max(0, opsTriageOffset + direction * 100);
  renderOps();
};

window.setOpsTriageExpanded = function setOpsTriageExpanded(isExpanded) {
  opsTriageExpanded = Boolean(isExpanded);
};

window.toggleOpsTriageClosed = function toggleOpsTriageClosed() {
  opsTriageShowClosed = !opsTriageShowClosed;
  opsTriageOffset = 0;
  renderOps();
};

window.saveOpsDraftTriage = async function saveOpsDraftTriage(id, button) {
  const row = button.closest('[data-ops-triage-id]');
  if (!row) return;
  const status = row.querySelector('.ops-triage-status').value;
  const note = row.querySelector('.ops-triage-note').value;
  const saved = row.querySelector('.ops-triage-saved');
  button.disabled = true;
  saved.textContent = '저장 중…';
  try {
    await api(`/stats/draft-triage/${id}`, { method: 'PATCH', body: JSON.stringify({ status, note }) });
    saved.textContent = '저장됨';
  } catch (err) {
    saved.textContent = `저장 실패: ${err.message}`;
  } finally {
    button.disabled = false;
  }
};

const SCOPE_KIND_LABELS = { expand_scope: '범위 확장', narrow_scope: '범위 축소', add_query: '검색어 추가' };

function renderScopeProposalsHtml(data, isAdmin) {
  if (!data) {
    return '<div class="section ops-scope"><div class="section-header"><h2>범위 조정 제안 (주간 분석)</h2></div><p class="stale">제안 목록을 불러오지 못했습니다.</p></div>';
  }
  const cards = data.proposals.map((p) => {
    const evidence = (Array.isArray(p.evidence) ? p.evidence : []).slice(0, 3).map((e) => (
      e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title || e.url)}</a>` : escapeHtml(e.title || '')
    )).join(' · ');
    const buttons = isAdmin
      ? `<div class="ops-scope-actions"><button class="btn" type="button" onclick="decideScopeProposal(${p.id}, 'approve', this)">승인</button><button class="btn" type="button" onclick="decideScopeProposal(${p.id}, 'reject', this)">거절</button></div>`
      : '';
    return `<div class="ops-scope-card"><div><span class="ops-scope-kind">${SCOPE_KIND_LABELS[p.kind] || escapeHtml(p.kind)}</span> <strong>${escapeHtml(p.term)}</strong></div>
      <p class="ops-scope-rationale">${escapeHtml(p.rationale || '')}</p>${evidence ? `<p class="meta">근거: ${evidence}</p>` : ''}${buttons}</div>`;
  }).join('');
  const active = data.activeTerms.length
    ? `<div class="ops-scope-active"><span class="meta">적용 중인 조정</span>${data.activeTerms.map((t) => `<span class="ops-scope-term">${t.mode === 'include' ? '＋' : '－'}${escapeHtml(t.term)}${isAdmin ? `<button type="button" class="ops-scope-revoke" title="이 조정 해제" aria-label="${escapeHtml(t.term)} 해제" onclick="revokeScopeTerm(${t.id}, this)">×</button>` : ''}</span>`).join('')}</div>` : '';
  const runButton = isAdmin
    ? `<button class="btn" type="button" onclick="runScopeAnalysisNow(this)" ${data.analysisRunning ? 'disabled' : ''}>${data.analysisRunning ? '분석 중…' : '지금 분석 실행'}</button>` : '';
  return `<div class="section ops-scope">
    <div class="section-header"><h2>범위 조정 제안 (주간 분석)</h2>${runButton}</div>
    <p class="ops-triage-note-help">매주 월요일 제외된 후보·발행 자료·부적합 자료를 분석해 수집 범위 조정과 새 검색어를 제안합니다. 승인한 항목만 적용되며, 제외 후보가 ${data.minExclusions}건 이상 쌓여야 분석합니다.</p>
    ${cards || '<p class="ops-triage-empty">대기 중인 제안이 없습니다.</p>'}${active}
  </div>`;
}

window.decideScopeProposal = async function decideScopeProposal(id, action, button) {
  button.disabled = true;
  try {
    await api(`/scope-proposals/${id}/${action}`, { method: 'POST' });
    renderOps();
  } catch (err) {
    button.disabled = false;
    alert(`처리 실패: ${err.message}`);
  }
};

window.revokeScopeTerm = async function revokeScopeTerm(id, button) {
  if (!confirm('이 범위 조정을 해제할까요? 즉시 수집 필터에서 빠집니다.')) return;
  button.disabled = true;
  try {
    await api(`/scope-proposals/terms/${id}`, { method: 'DELETE' });
    renderOps();
  } catch (err) {
    button.disabled = false;
    alert(`해제 실패: ${err.message}`);
  }
};

window.runScopeAnalysisNow = async function runScopeAnalysisNow(button) {
  button.disabled = true;
  try {
    await api('/scope-proposals/run', { method: 'POST' });
    button.textContent = '분석 시작됨 — 잠시 후 새로고침';
  } catch (err) {
    button.disabled = false;
    alert(`실행 실패: ${err.message}`);
  }
};

function renderOpsHtml(stats, triage, scope, isAdmin) {
  const { basis, backlog, aiFailureReasons, sourceErrors, perSource, today } = stats;

  const backlogRows = backlog.ok
    ? Object.entries(backlog.byAiStatus).map(([k, v]) => `<tr><td>${k === 'null' ? '요청 안 함' : k}</td><td>${v}</td></tr>`).join('')
    : opsSectionErrorRow(2, backlog.error);

  const failureRows = !aiFailureReasons.ok ? opsSectionErrorRow(2, aiFailureReasons.error)
    : aiFailureReasons.rows.length
      ? aiFailureReasons.rows.map((r) => `<tr><td>${opsFailureLabel(r.ai_failure_type)}</td><td>${r.cnt}</td></tr>`).join('')
      : '<tr><td colspan="2">현재 실패 상태인 Draft 없음</td></tr>';

  const sourceErrorRows = !sourceErrors.ok ? opsSectionErrorRow(3, sourceErrors.error)
    : sourceErrors.rows.length
      ? sourceErrors.rows.map((s) => {
          const { message, detail } = SourceErrors.translateSourceError(s.last_error);
          return `<tr><td>${s.name}</td><td>${message}${detail ? ` (${detail})` : ''}</td><td>${formatDateOnly(s.last_error_at)}</td></tr>`;
        }).join('')
      : '<tr><td colspan="3">현재 오류 상태인 소스 없음 (성공 시 자동 초기화됨)</td></tr>';

  const perSourceRows = !perSource.ok ? opsSectionErrorRow(6, perSource.error)
    : perSource.rows.map((s) => `<tr>
      <td>${s.name}</td>
      <td>${s.method}</td>
      <td>${s.collected}</td>
      <td>${s.published}</td>
      <td>${s.collected ? Math.round((s.published / s.collected) * 100) : 0}%</td>
      <td>${s.ai_failed}</td>
    </tr>`).join('');

  const windowCollected = perSource.ok ? perSource.rows.reduce((sum, s) => sum + s.collected, 0) : '-';
  const sourceErrorCount = sourceErrors.ok ? sourceErrors.rows.length : '-';

  return `
    <h1>운영 현황</h1>
    <p class="page-lede">파이프라인의 실패 원인, 소스별 수집량·품질, 미검수(Draft) 적체량을 한눈에 봅니다. (생성 시각: ${formatDateOnly(basis.generatedAt)})</p>
    <details class="ops-basis-details">
      <summary>숫자 집계 기준 자세히 보기</summary>
      <p>
        미검수 적체량은 <code>${basis.backlogDefinition}</code> 전체를 ai_status별로 나눈 것(상호 배타적, 합계=적체량 총수)이고,
        AI 실패 원인은 그중 <code>${basis.aiFailureReasonsScope}</code>만 셉니다.<br>
        소스별 수집량·품질은 ${basis.collectionWindow.start} ~ ${basis.collectionWindow.end} (UTC 기준 ${basis.collectionWindow.days}×24시간, 현지 날짜·시간대 아님) 동안 실제로 저장된(중복 제거 후) 건수입니다.<br>
        금일 수집량은 ${basis.todayWindow.start} ~ ${basis.todayWindow.end} (KST 00:00~24:00 달력일 기준 — UTC 날짜 아님, Daily Discovery의 "오늘"과 동일 기준) 동안 실제로 저장된(중복 제거 후) 건수입니다.<br>
        소스 오류는 각 소스의 가장 최근 실행 결과만 반영하며, 다음 성공 시 자동으로 지워집니다.
      </p>
    </details>

    <div class="ops-stats-row">
      <div class="ops-stat"><span class="ops-stat-value">${backlog.ok ? backlog.total : '-'}</span><span class="ops-stat-label">미검수(Draft) 적체량</span></div>
      <div class="ops-stat"><span class="ops-stat-value">${sourceErrorCount}</span><span class="ops-stat-label">현재 오류 상태 소스</span></div>
      <div class="ops-stat"><span class="ops-stat-value">${windowCollected}</span><span class="ops-stat-label">최근 ${basis.collectionWindow.days}일 수집량</span></div>
      <div class="ops-stat"><span class="ops-stat-value">${today.ok ? today.collected : '-'}</span><span class="ops-stat-label">금일 수집량 (KST)</span></div>
    </div>

    <div class="section">
      <div class="section-header"><h2>미검수 적체량 (ai_status별, 상호 배타적)</h2></div>
      <table><tr><th>AI 처리 상태</th><th>건수</th></tr>${backlogRows}</table>
    </div>

    <div class="section">
      <div class="section-header"><h2>AI 생성 실패 원인 (현재 Draft+failed만)</h2></div>
      <table><tr><th>원인</th><th>건수</th></tr>${failureRows}</table>
    </div>

    ${renderOpsTriageHtml(triage)}
    ${renderScopeProposalsHtml(scope, isAdmin)}

    <div class="section">
      <div class="section-header"><h2>수집 오류 중인 소스 (최근 실행 기준)</h2></div>
      <table><tr><th>소스</th><th>오류</th><th>발생 시각</th></tr>${sourceErrorRows}</table>
    </div>

    <div class="section">
      <div class="section-header"><h2>소스별 수집량·품질 (최근 ${basis.collectionWindow.days}일, 중복 제거 후 저장분 기준)</h2></div>
      <table><tr><th>소스</th><th>방식</th><th>수집</th><th>발행</th><th>발행률</th><th>AI 실패</th></tr>${perSourceRows}</table>
    </div>
  `;
}

// Resilient against a total fetch failure (network down, 500, etc.) —
// never lets the router's generic app-wide error page replace this whole
// screen. Falls back to the last successfully rendered snapshot (cached
// per-browser in localStorage) with a clearly dated "갱신 실패" banner,
// rather than showing nothing or a crash message.
async function renderOps() {
  let stats;
  let banner = '';
  try {
    stats = await api('/stats/overview');
  } catch (err) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(OPS_LAST_SNAPSHOT_KEY) || 'null'); } catch { /* ignore corrupt cache */ }
    stats = cached;
    banner = `<p class="stale">갱신 실패: ${escapeHtml(err.message)}${cached ? ` — 아래는 마지막 갱신 시각(${formatDateOnly(cached.basis.generatedAt)})의 자료입니다.` : ' — 표시할 이전 자료가 없습니다.'}</p>`;
  }
  if (stats && !banner) try { localStorage.setItem(OPS_LAST_SNAPSHOT_KEY, JSON.stringify(stats)); } catch { /* storage full/blocked — not fatal */ }
  let triage;
  try {
    triage = { ...(await api(`/stats/draft-triage?limit=100&offset=${opsTriageOffset}&includeClosed=${opsTriageShowClosed}`)), ok: true };
  } catch (err) {
    triage = { ok: false, error: err.message, rows: [], total: 0, offset: opsTriageOffset };
  }
  const [scope, isAdmin] = await Promise.all([
    api('/scope-proposals?status=pending').catch(() => null),
    isAdminAuthenticated(),
  ]);
  const body = stats ? renderOpsHtml(stats, triage, scope, isAdmin) : `<h1>운영 현황</h1>${renderOpsTriageHtml(triage)}`;
  app.innerHTML = banner + body;
}


function renderHeadlineBrief(data) {
  const date = escapeHtml(String(data.brief_date || '').slice(0, 10));
  const brief = data.brief || {};
  const evidenceIds = new Set((Array.isArray(data.source_item_ids) ? data.source_item_ids : []).map(Number));
  const developments = (Array.isArray(brief.developments) ? brief.developments : []).filter((entry) => evidenceIds.has(Number(entry.item_id)));
  const sourceById = new Map((Array.isArray(data.sources) ? data.sources : []).map((source) => [Number(source.item_id), source]));
  const stories = developments.map((entry, index) => {
    const source = sourceById.get(Number(entry.item_id));
    const detailLink = `#/detail/${encodeURIComponent(String(entry.item_id))}`;
    return `<article class="headline-story">
    <span class="headline-story-index">${index + 1}</span><div>
      <p><a class="headline-story-title" href="${detailLink}">${escapeHtml(source?.title || '자료 상세 보기 →')}</a></p>
      <p class="headline-story-summary">&quot;${escapeHtml(entry.summary || '')}&quot;</p><p class="headline-significance">${escapeHtml(entry.significance || '')}</p>
    </div>
  </article>`;
  }).join('');
  const watchpoints = (Array.isArray(brief.watchpoints) ? brief.watchpoints : []).map((point) => `<li>${escapeHtml(point)}</li>`).join('');
  return `<div class="headlines-page">
    <header class="headlines-header"><div><h1>헤드라인</h1><p class="headlines-subtitle">금일 아카이빙된 기사와 보고서에서 시장 판단에 필요한 변화를 추렸습니다.</p></div><span class="headlines-date">${date}</span></header>
    <p class="page-lede headlines-basis">오늘 수집된 기사와 최근 7일 이내 발행된 신규 소식 중 주목할 변화를 요약합니다. · ${Number(data.item_count) || 0}건</p>
    <section class="headline-lead"><h2>${escapeHtml(brief.lead || '')}</h2><p>${escapeHtml(brief.market_summary || '')}</p></section>
    <div class="headlines-columns">
      <section class="section headline-panel"><div class="section-header headline-panel-heading"><h2>주목할 자료</h2><span>${developments.length}건</span></div>${stories || '<p class="headline-empty">표시할 주요 자료가 없습니다.</p>'}</section>
      <aside class="section headline-panel headline-watchpoints"><div class="section-header headline-panel-heading"><h2>후속 확인</h2></div>${watchpoints ? `<ul>${watchpoints}</ul>` : '<p class="headline-empty">추가로 지정된 후속 확인 사항이 없습니다.</p>'}<div class="headline-coverage"><strong>이번 브리프의 근거</strong><span>${Number(data.item_count) || 0}건의 선별 자료</span><a href="#/archive">자료 전체 보기 →</a></div></aside>
    </div>
    ${renderHeadlineMarketLinks()}
  </div>`;
}

function renderHeadlineMarketLinks() {
  const references = [
    { label: '팜유 선물', role: '말레이시아', url: 'https://www.tradingview.com/symbols/MYX-FCPO1%21/' },
    { label: '대두유 선물', role: '미국', url: 'https://www.tradingview.com/symbols/CBOT-ZL1%21/' },
    { label: '브렌트유', role: '에너지 참고', url: 'https://www.tradingview.com/symbols/UKOIL/?exchange=TVC' },
  ];
  return `<section class="headline-market" aria-labelledby="headline-market-title">
    <div><h2 id="headline-market-title">시장 지표 확인</h2><p>가격 데이터는 원천 화면에서 확인합니다. 종목을 눌러 해당 선물·지표로 이동하세요.</p></div>
    <nav class="headline-market-links" aria-label="시장 지표 원천 링크">${references.map((item) => `<a href="${item.url}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.role)} · TradingView ↗</small></a>`).join('')}</nav>
  </section>`;
}

async function renderHeadlines() {
  app.innerHTML = '<div class="headlines-page"><p class="headlines-loading">헤드라인을 불러오는 중입니다…</p></div>';
  try {
    const data = await api('/headlines/latest');
    if (!data) {
      app.innerHTML = `<div class="headlines-page"><header class="headlines-header"><div><h1>헤드라인</h1><p class="headlines-subtitle">금일 수집 기사와 최근 7일 이내 신규 소식을 선별해 요약합니다.</p></div></header><section class="headline-state"><h2>아직 생성된 브리프가 없습니다</h2><p>일일 수집 완료 후 선별된 신규 소식으로 생성됩니다.</p></section>${renderHeadlineMarketLinks()}</div>`;
      return;
    }
    if (data.status === 'ready') {
      app.innerHTML = renderHeadlineBrief(data);
      if (data.refresh_status === 'generating') {
        setTimeout(() => { if (parseHash().path === 'headlines') renderHeadlines(); }, 15000);
      }
      return;
    }
    const states = {
      generating: ['브리프를 만들고 있습니다', '수집 자료를 정리 중입니다. 잠시 후 자동으로 다시 확인합니다.'],
      empty: ['오늘 아카이브된 자료가 없습니다', '오늘 자료가 추가됐다면 관리자 인증 후 브리프를 다시 만들 수 있습니다.'],
      failed: ['브리프 생성에 실패했습니다', '수집 자료는 보존되어 있습니다. 관리자 인증 후 생성 재시도를 할 수 있습니다.'],
    };
    const [title, description] = states[data.status] || ['브리프 상태 확인 중', '잠시 후 다시 확인해 주세요.'];
    app.innerHTML = `<div class="headlines-page"><header class="headlines-header"><div><h1>헤드라인</h1></div><span class="headlines-date">${escapeHtml(String(data.brief_date || '').slice(0, 10))}</span></header><section class="headline-state"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></section>${renderHeadlineMarketLinks()}</div>`;
    if (data.status === 'generating') setTimeout(() => { if (parseHash().path === 'headlines') renderHeadlines(); }, 15000);
  } catch (err) {
    app.innerHTML = `<div class="headlines-page"><h1>헤드라인</h1><p class="headlines-error">브리프를 불러오지 못했습니다: ${escapeHtml(err.message)}</p><button class="btn" type="button" onclick="renderHeadlines()">다시 불러오기</button></div>`;
  }
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
        <li>상단 드롭다운에서 검토할 Draft를 선택하세요 (판단 미완료가 먼저 보이고, 그 안에서 ⚠ 비적합 판정 → 표시 없음(적합 판정) → ✕ 초안 미생성 순으로 정렬돼요).</li>
        <li>AI 판단을 확인하고, "적합으로 확정"/"비적합으로 확정"으로 내 판단을 남기세요 — 같은 버튼을 다시 누르면 선택이 해제됩니다.</li>
        <li>필요하면 요약/인사이트/섹터/활용처를 직접 수정하세요.</li>
        <li>준비되면 "자료 발행"을 눌러 공개합니다.</li>
      </ol>
    </div>
  `;
}

// /api/items caps limit at 100 per request (see server/routes/items.js) —
// a deliberate bound against sending the whole table to one query, not a
// UI pagination choice. Review used to expose that cap directly as its own
// "이전/다음 100개" paging, which meant the dropdown (and prev/next-draft
// navigation, which walks the SAME `drafts` array) only ever covered
// whichever 100-item page was currently loaded. Fetching every page here
// instead keeps the dropdown showing the full Draft backlog while leaving
// the server's own per-request cap untouched.
async function fetchAllDrafts() {
  const limit = 100;
  let offset = 0;
  let all = [];
  while (true) {
    const page = await api('/items?status=Draft' + toQuery({ limit, offset }), { includeMeta: true });
    all = all.concat(page.data);
    if (!page.hasMore) break;
    offset += limit;
  }
  return all;
}

async function renderReview() {
  const [draftsRaw, sectors, usages, sources] = await Promise.all([
    fetchAllDrafts(), api('/sectors'), api('/usages'), api('/sources'),
  ]);
  // 판단 미완료 그룹이 먼저, 판단 완료 그룹은 제목 기준 a-z/가나다 순
  // (localeCompare('ko')가 로마자와 한글을 한 기준으로 같이 정렬해준다).
  // 판단 미완료 그룹 안에서는 AI 판정 상태로 한 번 더 나눈다 — 비적합
  // 판정(검토가 가장 급함) → 적합 판정 → 초안 미생성(아직 AI 판정조차
  // 없음) 순, 각 구간 안에서는 다시 제목순.
  const titleCompare = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ko');
  // Production bug: ai_eligible is only ever written alongside
  // ai_status='completed' (see aiDraft.js's success path) — a regeneration
  // that later FAILS or is still 'pending' never resets ai_eligible, so an
  // item that previously had a successful draft keeps its old true/false
  // verdict even though there is currently no valid draft for it. Checking
  // ai_eligible alone made a "초안 미생성" item (one with no CURRENT draft)
  // look like a settled 적합 판정 whenever a stale `ai_eligible=true` from
  // an earlier run was still sitting on the row. ai_status is the
  // authoritative "is there a draft right now" signal — ai_eligible only
  // means anything when ai_status is actually 'completed'.
  const aiEligibilityOrder = (d) => {
    if (d.ai_status !== 'completed') return 2;
    return d.ai_eligible === false ? 0 : d.ai_eligible === true ? 1 : 2;
  };
  const drafts = [...draftsRaw].sort((a, b) => {
    const pendingDiff = (isReviewerPending(a) ? 0 : 1) - (isReviewerPending(b) ? 0 : 1);
    if (pendingDiff !== 0) return pendingDiff;
    if (isReviewerPending(a)) {
      const eligDiff = aiEligibilityOrder(a) - aiEligibilityOrder(b);
      if (eligDiff !== 0) return eligDiff;
    }
    return titleCompare(a, b);
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
          // Same ai_status-first rule as aiEligibilityOrder above — a
          // stale ai_eligible from a prior completed run must not mark an
          // item that currently has no draft (failed/pending/not_requested)
          // as if it were a settled 적합 판정.
          const draftOptionMark = (d) => {
            if (d.ai_status !== 'completed') return '✕ ';
            return d.ai_eligible === false ? '⚠ ' : d.ai_eligible === true ? '' : '✕ ';
          };
          const draftOptionHtml = (d) => `<option value="${d.id}">${draftOptionMark(d)}${d.title}</option>`;
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
          status.textContent = meta.metadata_warning || '메타데이터를 가져왔습니다. 확인 후 필요하면 수정하세요.';
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
    // Production bug: an exception anywhere in this whole function — the
    // fetch (transient 502/503, server momentarily overloaded) or
    // anything in the rendering/event-binding below it — threw unhandled,
    // leaving #review-body showing whatever draft was on screen before
    // (already published, in next/prev's case), with no error. Publishing
    // genuinely worked; the screen just never moved on to show the next
    // one. Wrapping the whole thing, not just the fetch, means ANY such
    // failure now surfaces instead of failing silently partway through.
    try {
    const [item, isAdmin] = await Promise.all([api(`/items/${id}`), isAdminAuthenticated()]);

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
          ${item.gate_hold_reason ? `
          <div class="review-section gate-hold-notice">
            <span class="review-subhead">자동 발행 보류됨</span>
            <p class="review-body-text">AI는 이 자료를 적합 판단했지만, 별도의 자동 점검에서 발행을 보류했습니다: ${GATE_HOLD_LABELS[item.gate_hold_reason] || item.gate_hold_reason}<br>
            아래에서 직접 확인 후 "자료 발행"을 누르면 수동으로 발행할 수 있습니다. (판정 규칙: ${item.gate_hold_rule_version || '-'})</p>
          </div>` : ''}
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
          <div class="review-section" id="d-published-at-section">
            <div class="review-section-title">발행일</div>
            <input id="d-published-at" type="date">
          </div>
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
            ${isAdmin ? '<button class="btn" id="d-delete" type="button" style="flex:0 0 auto;white-space:nowrap;height:var(--ctrl-lg);margin-top:var(--sp-4)">삭제</button>' : ''}
          </div>
        </div>
      </div>
    `;
    document.getElementById('d-published-at').value = item.published_at ? String(item.published_at).slice(0, 10) : '';
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

    const publishBtn = document.getElementById('d-publish');
    publishBtn.onclick = async () => {
      // Without this, the previous silent-failure symptom could also happen
      // the other way: a slow PATCH + an impatient double-click fired two
      // publishes, the second landing on an item that was no longer Draft.
      if (publishBtn.disabled) return;
      publishBtn.disabled = true;
      try {
        await api(`/items/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            published_at: document.getElementById('d-published-at').value || null,
            summary: document.getElementById('d-summary').value,
            insight: document.getElementById('d-insight').value,
            sector_ids: getActive(document.getElementById('d-sectors'), 'sector'),
            usage_ids: getActive(document.getElementById('d-usages'), 'usage'),
            status: 'Published',
          }),
        });
        advancePastCurrentDraft();
      } catch (err) {
        // The PATCH's own failure wasn't the reported bug (that was the
        // NEXT draft's fetch failing silently, fixed above) — but it had
        // the same silent-failure shape, so it gets the same visible
        // treatment rather than only a console error.
        alert(`발행에 실패했습니다: ${err.message}`);
        publishBtn.disabled = false;
      }
    };

    const dDeleteBtn = document.getElementById('d-delete');
    if (dDeleteBtn) {
      dDeleteBtn.onclick = async () => {
        if (!confirm('이 Draft를 삭제할까요? 되돌릴 수 없습니다.')) return;
        try {
          await api(`/items/${id}`, { method: 'DELETE' });
          advancePastCurrentDraft();
        } catch (err) {
          alert(`삭제에 실패했습니다: ${err.message}`);
        }
      };
    }

    // Removes the just-published/deleted item from the in-memory drafts
    // list and dropdown, then moves to whichever item now sits at the same
    // position (the "next" item) — rather than renderReview(), which
    // re-fetches the full Draft list and always lands back on the first
    // (highest-priority) one, forcing the reviewer to re-find where they
    // were after every single publish.
    function advancePastCurrentDraft() {
      const idx = drafts.findIndex((d) => String(d.id) === String(id));
      // idx === -1 shouldn't happen (this item came from `drafts` in the
      // first place) but was previously a silent no-op if it ever did —
      // selectDraftAt(-1) fails its own bounds check and returns without
      // the screen changing at all, no error, same symptom as the bug
      // above. A full reload is the safe fallback instead of a dead end.
      if (idx === -1) { renderReview(); return; }
      drafts.splice(idx, 1);
      const opt = select.querySelector(`option[value="${id}"]`);
      if (opt) opt.remove();
      if (!drafts.length) {
        renderReview();
        return;
      }
      selectDraftAt(Math.min(idx, drafts.length - 1));
    }
    } catch (err) {
      console.error('Review tab: failed to load/render draft', id, err);
      document.getElementById('review-body').innerHTML = `
        <p class="meta">자료를 불러오지 못했습니다: ${escapeHtml(err.message)}</p>
        <button class="btn" id="d-load-retry-btn" type="button">다시 시도</button>
      `;
      document.getElementById('d-load-retry-btn').onclick = () => loadDraft(id);
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
    : path === 'headlines' ? 'headlines'
    : path === 'reference' ? 'reference'
    : path === 'sources' ? 'sources' : path === 'review' ? 'review'
    : path === 'ops' ? 'ops' : 'home';
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
// skipped so it never reappears in that browser. `onDone`, if given, fires
// once — whether the tour actually ran to the end, was skipped, or never
// ran at all because `seenKey` was already set — so callers can chain a
// next tour onto this one unconditionally (see startHomeTour below)
// without caring which of those three happened.
let activeSpotlightTourCancel = null;
function cancelActiveSpotlightTour() {
  if (!activeSpotlightTourCancel) return;
  const cancel = activeSpotlightTourCancel;
  activeSpotlightTourCancel = null;
  cancel();
}

function runSpotlightTour(steps, seenKey, onDone) {
  if (activeSpotlightTourCancel) {
    activeSpotlightTourCancel();
    activeSpotlightTourCancel = null;
  }
  if (localStorage.getItem(seenKey)) { if (onDone) onDone(); return; }

  let step = 0;
  let highlightedEl = null;
  let finished = false;
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

  function cleanup() {
    if (highlightedEl) highlightedEl.classList.remove('onboard-highlight');
    window.removeEventListener('scroll', positionCard);
    window.removeEventListener('resize', positionCard);
    card.remove();
  }

  function cancel() {
    if (finished) return;
    finished = true;
    cleanup();
    if (activeSpotlightTourCancel === cancel) activeSpotlightTourCancel = null;
  }

  function finish() {
    if (finished) return;
    finished = true;
    cleanup();
    if (activeSpotlightTourCancel === cancel) activeSpotlightTourCancel = null;
    localStorage.setItem(seenKey, '1');
    if (onDone) onDone();
  }
  activeSpotlightTourCancel = cancel;

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
    // A single-step "tour" (e.g. the 자료/Sources tab info card — see
    // nav-guide-btn's click handler) is really just a description
    // popover, not a walkthrough — 이전/건너뛰기/단계 카운터 all imply
    // there's more than one step to move through, which reads as
    // confusing chrome around a single sentence. One "확인" button only.
    card.innerHTML = steps.length === 1 ? `
      <h3>${s.title}</h3>
      <p>${s.desc}</p>
      <div class="onboard-card-footer onboard-card-footer-single">
        <button type="button" class="btn primary" id="onboard-next">확인</button>
      </div>
    ` : `
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
    document.getElementById('onboard-prev')?.addEventListener('click', () => {
      if (isFirst) return;
      step -= 1;
      renderStep(-1);
    });
    document.getElementById('onboard-skip')?.addEventListener('click', finish);
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
  { selector: '[data-route="headlines"]', title: '헤드라인', desc: '오늘 수집·최근 7일 내 발행된 자료 중 주목할 변화를 헤드메시지부터 자료별 인사이트까지 순서대로 확인합니다.' },
  { selector: '[data-route="archive"]', title: '자료', desc: '발행된 모든 자료를 최신순으로 모아봅니다. 뉴스/보고서 탭과 필터로 좁혀볼 수 있어요.' },
  { selector: '[data-route="reference"]', title: '레퍼런스', desc: '자동 수집 대상이 아니더라도 참고 가치가 높은 리서치/통계 출처를 모아둔 목록입니다.' },
  { selector: '[data-route="sources"]', title: 'Sources', desc: '자료를 수집하는 RSS·기관 소스를 등록하고 관리하는 운영자용 화면입니다.' },
  { selector: '[data-route="review"]', title: 'Review', desc: 'AI가 자동 채집·판단한 초안을 발행 전에 사람이 검수하는 화면입니다. 검수 결과는 주제가 비슷한 이후 기사 판단에 우선 참고되어 정확도가 보정됩니다.' },
  { selector: '[data-route="ops"]', title: '운영 현황', desc: '파이프라인의 실패 원인, 소스별 수집량·품질, 미검수(Draft) 적체량을 한눈에 보는 운영자용 대시보드입니다.' },
];
function startOnboardingTour(onDone) { runSpotlightTour(ONBOARDING_STEPS, ONBOARDING_SEEN_KEY, onDone); }

const HEADLINES_TOUR_SEEN_KEY = 'ra_headlines_tour_seen';
const HEADLINES_TOUR_STEPS = [
  { selector: '.headline-lead h2', title: '헤드메시지', desc: '오늘 자료에서 가장 중요한 시장 변화를 한 문장으로 먼저 파악합니다.' },
  { selector: '.headline-lead > p', title: '상세내용 압축', desc: '여러 자료에서 확인된 변화와 시장 맥락을 짧게 이어서 읽습니다.' },
  { selector: '.headline-story-title', title: '자료 원문 제목', desc: '주목 자료의 원문 제목입니다. 제목을 누르면 아카이브 상세 화면에서 원문 링크와 자료 정보를 확인할 수 있습니다.' },
  { selector: '.headline-story-summary', title: '본문 발췌', desc: '자료에서 확인된 핵심 사실을 인용문으로 보여줍니다.' },
  { selector: '.headline-significance', title: '인사이트', desc: '해당 사실이 시장이나 공급망 판단에 주는 의미를 확인합니다.' },
];
function startHeadlinesTour(replay = false) {
  if (replay) localStorage.removeItem(HEADLINES_TOUR_SEEN_KEY);
  if (!document.querySelector('.headline-lead h2') || !document.querySelector('.headline-story-title')) return false;
  runSpotlightTour(HEADLINES_TOUR_STEPS, HEADLINES_TOUR_SEEN_KEY);
  return true;
}

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

// Reference-page tour — walks through adding a new Reference Source: open
// the add form, paste a representative link, run AI metadata extraction,
// then submit. The form's fields live in #ref-add-form-wrap, hidden by
// default (see renderSourceManager/sourceFormFieldsHtml) — opening it
// before the tour starts is what actually makes steps 2-4's targets
// visible to spotlight; without that, every step after the first would
// find its selector in the DOM (so it wouldn't get silently skipped) but
// nothing would visibly highlight, since a hidden element still matches
// a CSS selector.
const REFERENCE_TOUR_SEEN_KEY = 'ra_reference_tour_seen';
const REFERENCE_TOUR_STEPS = [
  { selector: '#s-form-summary', title: '소스 추가', desc: '여기를 눌러 새 레퍼런스 소스를 추가하는 입력란을 열 수 있어요.' },
  { selector: '#s-extract-url', title: '대표 링크 입력', desc: '추가하려는 기관의 대표 URL을 붙여넣으세요.' },
  { selector: '#s-extract-btn', title: '메타데이터 추출', desc: '이 버튼을 누르면 페이지 정보를 가져오고, AI가 유형·지역·품목 등 가능한 항목을 자동으로 채워줍니다. 비어있는 칸만 채워지니 직접 입력한 값은 유지돼요.' },
  { selector: '#s-add', title: '추가', desc: '자동으로 채워지지 않은 항목은 직접 입력한 뒤 이 버튼을 눌러 저장하세요.' },
];
function startReferenceTour() {
  // Only force the add panel open for a first-ever visit — on every later
  // visit (seenKey already set), runSpotlightTour would no-op anyway, but
  // opening the panel here regardless would still pop it open unprompted
  // on every single Reference page load from then on.
  if (localStorage.getItem(REFERENCE_TOUR_SEEN_KEY)) return;
  const details = document.getElementById('s-form-section');
  const formWrap = document.getElementById('ref-add-form-wrap');
  if (details) details.open = true;
  if (formWrap) formWrap.hidden = false;
  runSpotlightTour(REFERENCE_TOUR_STEPS, REFERENCE_TOUR_SEEN_KEY);
}

// Home-page tour — runs immediately after the top-bar nav tour finishes
// (chained via startOnboardingTour's onDone, see DOMContentLoaded below),
// not in parallel with it, so the two never visually overlap. Targets
// Home's own first-visit-worthy features in the order a new user would
// actually want them explained: how to use the AI search, what a
// carousel's 1-month archive window means, how to reorder the two theme
// roots, and how to reorder a theme's own child carousels. Separate
// seenKey from the nav tour so it only ever shows once regardless of how
// many times the nav tour itself has already run in this browser.
const HOME_TOUR_SEEN_KEY = 'ra_home_tour_seen';
const HOME_TOUR_STEPS = [
  { selector: '#ai-search', title: 'AI 검색', desc: '여기에 궁금한 점을 질문하면 아카이빙된 자료를 근거로 AI가 답변해 드립니다. 답변의 [번호]를 누르면 해당 자료로 바로 이동해요.' },
  { selector: '.home-module', title: '테마별 캐러셀', desc: '각 테마의 최근 발행 자료만 모아 보여줍니다 (팜유·대두유·해바라기유·SAF·FAME·기타 비식용유지는 최근 1주일 기준). 그보다 오래된 자료는 "자료" 탭에서 확인할 수 있어요.' },
  { selector: '.home-theme-root-swap-icon', title: '테마 순서 조정', desc: '이 아이콘을 누르면 식용유지/비식용유지 순서를 바꿀 수 있는 카드가 뜹니다. 조정 후 저장을 눌러야 반영돼요.' },
  { selector: '.home-module-drag-handle', title: '소주제 순서 변경', desc: '이 점 모양 핸들을 눌러서 끌면 테마 안 소주제(캐러셀) 순서를 원하는 대로 바꿀 수 있어요.' },
];
function startHomeTour() { runSpotlightTour(HOME_TOUR_STEPS, HOME_TOUR_SEEN_KEY); }

// Set by renderArchive() just before it returns, only when this render is a
// month-sidebar jump: suppresses router()'s own scrollTo(0,0) below for
// that one render, so the month-sidebar's own scrollIntoView animates from
// wherever the user already is, instead of being preceded by an instant
// snap to the top that the smooth scroll then has to climb back down from.
let skipNextScrollReset = false;
let initialRouteToursReady = false;

async function router() {
  const { path, param, query } = parseHash();
  cancelActiveSpotlightTour();
  updateActiveNavTab(path);
  // Leaving Home (or re-rendering it) must stop its carousels' setInterval
  // timers before the next page's render replaces app.innerHTML — otherwise
  // they keep firing against detached DOM.
  clearHomeCarouselIntervals();
  const statusBar = document.getElementById('daily-status-bar');
  if (statusBar && path !== 'home' && path !== '') statusBar.hidden = true;
  try {
    if (path === 'home' || path === '') await renderHome();
    else if (path === 'headlines') {
      await renderHeadlines();
      if (initialRouteToursReady && !localStorage.getItem(HEADLINES_TOUR_SEEN_KEY)) startHeadlinesTour();
    }
    else if (path === 'archive') await renderArchive(query);
    else if (path === 'latest') { location.hash = '#/archive'; return; }
    else if (path === 'detail') await renderDetail(param);
    else if (path === 'reference') await renderReference(query);
    else if (path === 'sources') await renderSources(query);
    else if (path === 'review') await renderReview();
    else if (path === 'ops') await renderOps();
    else app.innerHTML = '<p>페이지를 찾을 수 없습니다.</p>';
    // The browser can otherwise preserve/restore the previous page's scroll
    // position across a hash change or back/forward navigation (see the
    // history.scrollRestoration override below) — every route, including
    // switching between Latest and All Results (or returning to a tab left
    // earlier), always opens at its own top instead. Suppressed just this
    // once for a month-sidebar jump — see skipNextScrollReset above.
    if (skipNextScrollReset) skipNextScrollReset = false;
    else window.scrollTo(0, 0);
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
// Shared by refreshAdminAuthUi() (the nav button) and every page that
// needs to gate a destructive action (item delete on Detail/Review) on
// whether an admin is actually logged in client-side, not just rely on
// the server's requireAuth to reject an unauthenticated attempt after
// the fact — a delete button visible to everyone but silently 401ing
// for a logged-out visitor is a worse experience than not offering it.
async function isAdminAuthenticated() {
  try {
    const status = await api('/auth/status');
    return Boolean(status.authenticated);
  } catch (err) {
    return false; // treat an unreachable status check as logged out
  }
}

async function refreshAdminAuthUi() {
  const btn = document.getElementById('nav-admin-auth');
  if (!btn) return;
  const authenticated = await isAdminAuthenticated();
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

// Page-wide safety net for the Home carousel drag-reorder feature: a fast
// drag can momentarily overshoot .home-theme-children's own bounds (e.g.
// crossing into the gap between the two theme sections), where nothing
// else calls preventDefault — without this, that split-second illegal
// drop target is enough for the browser to reject the whole drop.
app.addEventListener('dragover', (e) => { homeDragClientY = e.clientY; e.preventDefault(); });
app.addEventListener('drop', (e) => e.preventDefault());

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', async () => {
  if (!location.hash) location.hash = '#/home';
  refreshAdminAuthUi();
  // Home's own tour targets elements that only exist once renderHome()
  // has actually composed the DOM (AI search form, carousels, the theme
  // swap icon, a carousel's drag handle) — starting it before router()
  // resolves would find none of them and silently mark it "seen" without
  // ever showing a single step. Awaiting router() first guarantees Home
  // is rendered before either tour's first spotlight is attempted, and
  // chaining startHomeTour as the nav tour's onDone keeps the two from
  // ever appearing at the same time.
  await router();
  initialRouteToursReady = true;
  // Guards against a deep link landing on a non-Home route on first
  // visit: none of HOME_TOUR_STEPS' selectors would exist there, which
  // would otherwise mark HOME_TOUR_SEEN_KEY as seen without ever showing
  // it. Skipping it here just leaves it unseen for the next visit that
  // actually lands on Home, rather than burning it on a page it can't
  // run on.
  startOnboardingTour(() => {
    const path = parseHash().path || 'home';
    if (path === 'home') startHomeTour();
    else if (path === 'headlines') startHeadlinesTour();
  });

  // "사용 가이드" link (top-right of the topbar): replays whichever tour
  // belongs to the tab the visitor is currently on — NOT a fixed
  // "always jump to Home" action, and NOT the full multi-tab nav tour for
  // a tab that has no dedicated one of its own (자료/Sources) — playing
  // the whole nav tour there would walk through every OTHER tab too,
  // which reads as the wrong tab's info when the visitor asked about
  // this one specifically. For those, it reuses that tab's own
  // description text already written for ONBOARDING_STEPS and shows it
  // as a single spotlight card on just that tab's nav link — one step,
  // not a walkthrough. Stays on the current page throughout — none of
  // this navigates away, so every target it spotlights is already in
  // the DOM.
  document.getElementById('nav-guide-btn').onclick = () => {
    const path = parseHash().path || 'home';
    if (path === 'home') {
      localStorage.removeItem(HOME_TOUR_SEEN_KEY);
      startHomeTour();
    } else if (path === 'headlines') {
      if (!startHeadlinesTour(true)) {
        const step = ONBOARDING_STEPS.find((item) => item.selector === '[data-route="headlines"]');
        runSpotlightTour([step], 'ra_tab_info_seen_headlines');
      }
    } else if (path === 'review') {
      localStorage.removeItem(REVIEW_TOUR_SEEN_KEY);
      startReviewTour();
    } else if (path === 'reference') {
      localStorage.removeItem(REFERENCE_TOUR_SEEN_KEY);
      startReferenceTour();
    } else {
      const step = ONBOARDING_STEPS.find((s) => s.selector === `[data-route="${path}"]`);
      if (step) {
        const seenKey = `ra_tab_info_seen_${path}`;
        localStorage.removeItem(seenKey);
        runSpotlightTour([step], seenKey);
      }
    }
  };
});

// Delegated: works for freshly rendered and replayed (outerHTML) turns.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('.ai-copy-btn');
  if (!btn) return;
  const text = btn.dataset.answer || '';
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (__) { /* ignore */ }
    ta.remove();
  }
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1500);
});
