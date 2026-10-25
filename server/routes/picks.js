const express = require('express');
const pool = require('../db/pool');
const rateLimit = require('../lib/rateLimit');

const router = express.Router();

// Seeded so the team picker always offers these even before anyone has
// picked anything yet — the actual roster (GET /teams) is just "these
// plus whatever distinct team names already exist in picks.team", so
// adding a new team later is just picking it once, no admin screen.
const SEEDED_TEAM_NAMES = ['유지Trading팀', '유지투자팀'];

router.get('/', async (req, res) => {
  const { item_id, user_email, kind } = req.query;
  const clauses = [];
  const params = [];
  if (item_id) { params.push(item_id); clauses.push(`item_id = $${params.length}`); }
  if (user_email) { params.push(user_email); clauses.push(`user_email = $${params.length}`); }
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM picks ${where} ORDER BY created_at DESC`, params);
  res.json(rows);
});

// Team-pick ranking: most-saved items.
router.get('/ranking', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT i.id, i.title, i.type, COUNT(p.id) AS pick_count
    FROM picks p JOIN items i ON i.id = p.item_id
    WHERE p.kind = 'team'
    GROUP BY i.id ORDER BY pick_count DESC LIMIT 20
  `);
  res.json(rows);
});

// Known team roster for the "팀 Pick" picker: the seeded defaults plus
// any distinct team name already in use, so a team added ad-hoc (POST
// with a brand-new `team` value) shows up here from then on.
router.get('/teams', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT team FROM picks WHERE kind = 'team' AND team IS NOT NULL AND team <> ''`
  );
  const teams = new Set(SEEDED_TEAM_NAMES);
  rows.forEach((r) => teams.add(r.team));
  res.json([...teams].sort((a, b) => a.localeCompare(b, 'ko')));
});

const picksLimiter = rateLimit.limitMiddleware(rateLimit.createWindowCounter({ windowMs: 10 * 60 * 1000, max: 120 }));
router.post('/', picksLimiter, async (req, res) => {
  const { item_id, user_email, kind, memo, team } = req.body;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const resolvedKind = kind || 'personal';
  if (resolvedKind === 'team' && !(team || '').trim()) {
    return res.status(400).json({ error: 'team required for a team pick' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO picks (item_id, user_email, kind, memo, team) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [item_id, user_email || null, resolvedKind, memo || null, resolvedKind === 'team' ? team.trim() : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // 23505 = unique_violation on idx_picks_team_item_unique — this team
    // already picked this item. Not a real failure: the UI's own job is
    // to show that state, not retry; this is the backstop against a
    // double-click/race creating a second identical row.
    if (err.code === '23505') return res.status(409).json({ error: '이미 해당 팀에서 Pick한 자료입니다.' });
    throw err;
  }
});

router.delete('/:id', picksLimiter, async (req, res) => {
  await pool.query('DELETE FROM picks WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
