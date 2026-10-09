const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const COLORS = ['Red', 'Green', 'Yellow', 'Blue'];
const START = [0, 13, 26, 39];
const SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Ludo API is running 🎲', { headers: CORS });
    }

    try {
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      const q = url.searchParams;
      const path = url.pathname.slice(5);

      let out;
      switch (path) {
        case 'create': out = await apiCreate(env, body); break;
        case 'join':   out = await apiJoin(env, body); break;
        case 'state':  out = await apiState(env, q.get('code'), q.get('pid')); break;
        case 'start':  out = await apiStart(env, body); break;
        case 'roll':   out = await apiRoll(env, body); break;
        case 'move':   out = await apiMove(env, body); break;
        case 'tap':    out = await apiTap(env, body); break;
        default: return json({ error: 'unknown endpoint' }, 404);
      }
      return json(out.body, out.status || 200);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, 'content-type': 'application/json' }
  });
}

function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}

function newGame(code) {
  return {
    code, created: Date.now(),
    started: false, over: false, winner: null,
    turn: 0, dice: 0, message: '',
    awaitingMove: false, validMoves: [],
    players: [null, null, null, null],
    tokens: [[-1,-1,-1,-1], [-1,-1,-1,-1], [-1,-1,-1,-1], [-1,-1,-1,-1]],
    taps: {}
  };
}

async function load(KV, code) {
  if (!code) return null;
  return await KV.get('room:' + code.toUpperCase(), 'json');
}
async function save(KV, g) {
  await KV.put('room:' + g.code, JSON.stringify(g), { expirationTtl: 86400 });
}

function pub(g) {
  return {
    code: g.code, started: g.started, over: g.over, winner: g.winner,
    turn: g.turn, dice: g.dice, message: g.message,
    awaitingMove: g.awaitingMove, validMoves: g.validMoves,
    players: g.players.map(p => p ? { name: p.name } : null),
    tokens: g.tokens
  };
}

function nextTurn(g, pi) {
  for (let k = 1; k <= 4; k++) {
    const i = (pi + k) % 4;
    if (g.players[i]) return i;
  }
  return pi;
}

function validMoves(g, pi, value) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const v = g.tokens[pi][i];
    if (v === -1) { if (value === 6) out.push(i); }
    else if (v < 56 && v + value <= 56) out.push(i);
  }
  return out;
}

function wouldCapture(g, pi, np) {
  if (np > 50) return false;
  const ri = (START[pi] + np) % 52;
  if (SAFE.includes(ri)) return false;
  for (let op = 0; op < 4; op++) {
    if (op === pi || !g.players[op]) continue;
    for (let i = 0; i < 4; i++) {
      const ov = g.tokens[op][i];
      if (ov >= 0 && ov <= 50 && (START[op] + ov) % 52 === ri) return true;
    }
  }
  return false;
}

/* ===== CHEAT: weighted dice for lucky player ===== */
function rollValue(g, pi) {
  const player = g.players[pi];
  if (!player || !player.lucky) return 1 + Math.floor(Math.random() * 6);

  const weights = [];
  let total = 0;

  for (let f = 1; f <= 6; f++) {
    let s = 1;
    if (f === 6) s = 4.2;
    const moves = validMoves(g, pi, f);
    if (moves.length === 0) s *= 0.12;
    else {
      for (const t of moves) {
        const cur = g.tokens[pi][t];
        const np = cur === -1 ? 0 : cur + f;
        if (cur === -1) s += 3.5;
        if (np === 56) s += 9;
        if (np > 50 && np < 56) s += 2.2;
        if (wouldCapture(g, pi, np)) s += 6.5;
        s += 0.8;
      }
    }
    weights.push(s);
    total += s;
  }

  let r = Math.random() * total;
  for (let f = 1; f <= 6; f++) {
    r -= weights[f - 1];
    if (r <= 0) return f;
  }
  return 6;
}

/* ===== API HANDLERS ===== */

async function apiCreate(env, body) {
  let code, existing;
  for (let i = 0; i < 6; i++) {
    code = genCode();
    existing = await env.LUDO_KV.get('room:' + code);
    if (!existing) break;
  }
  const g = newGame(code);
  const pid = crypto.randomUUID();
  g.players[0] = { pid, name: (body.name || 'Player').slice(0, 12) };
  await save(env.LUDO_KV, g);
  return { body: { code, pid, color: 0 } };
}

async function apiJoin(env, body) {
  const code = (body.code || '').toUpperCase();
  const g = await load(env.LUDO_KV, code);
  if (!g) return { status: 404, body: { error: 'Room not found' } };

  // reclaim seat
  if (body.pid) {
    const idx = g.players.findIndex(p => p && p.pid === body.pid);
    if (idx >= 0) {
      if (body.name) g.players[idx].name = body.name.slice(0, 12);
      await save(env.LUDO_KV, g);
      return { body: { code, pid: body.pid, color: idx } };
    }
  }

  if (g.started) return { status: 403, body: { error: 'Game already started' } };

  const seat = g.players.findIndex(p => p === null);
  if (seat < 0) return { status: 403, body: { error: 'Room is full (4/4)' } };

  const pid = crypto.randomUUID();
  g.players[seat] = { pid, name: (body.name || 'Player').slice(0, 12) };
  await save(env.LUDO_KV, g);
  return { body: { code, pid, color: seat } };
}

async function apiState(env, code, pid) {
  const g = await load(env.LUDO_KV, code);
  if (!g) return { status: 404, body: { error: 'Room not found' } };
  const out = pub(g);
  if (pid) out.me = g.players.findIndex(p => p && p.pid === pid);
  return { body: out };
}

async function apiStart(env, body) {
  const g = await load(env.LUDO_KV, body.code);
  if (!g) return { status: 404, body: { error: 'Room not found' } };
  const pi = g.players.findIndex(p => p && p.pid === body.pid);
  if (pi < 0) return { status: 403, body: { error: 'Not in room' } };
  if (g.started) return { body: pub(g) };

  const active = g.players.map((p, i) => p ? i : -1).filter(i => i >= 0);
  if (active.length < 2) return { status: 400, body: { error: 'Need 2+ players' } };

  g.started = true;
  g.turn = active[0];
  g.message = 'Game started!';
  await save(env.LUDO_KV, g);
  return { body: pub(g) };
}

async function apiRoll(env, body) {
  const g = await load(env.LUDO_KV, body.code);
  if (!g) return { status: 404, body: { error: 'Room not found' } };
  if (!g.started || g.over) return { status: 400, body: { error: 'Game not active' } };

  const pi = g.players.findIndex(p => p && p.pid === body.pid);
  if (pi < 0) return { status: 403, body: { error: 'Not in room' } };
  if (g.turn !== pi) return { status: 403, body: { error: 'Not your turn' } };
  if (g.awaitingMove) return { status: 400, body: { error: 'Finish your move first' } };

  const dice = rollValue(g, pi);
  g.dice = dice;

  const moves = validMoves(g, pi, dice);
  if (moves.length === 0) {
    g.message = COLORS[pi] + ' rolled ' + dice + ' — no moves';
    g.awaitingMove = false;
    g.validMoves = [];
    g.turn = nextTurn(g, pi);
  } else {
    g.awaitingMove = true;
    g.validMoves = moves;
    g.message = COLORS[pi] + ' rolled ' + dice;
  }

  await save(env.LUDO_KV, g);
  return { body: { dice, state: pub(g) } };
}

async function apiMove(env, body) {
  const g = await load(env.LUDO_KV, body.code);
  if (!g) return { status: 404, body: { error: 'Room not found' } };
  if (!g.started || g.over) return { status: 400, body: { error: 'Game not active' } };

  const pi = g.players.findIndex(p => p && p.pid === body.pid);
  if (pi < 0 || pi !== g.turn) return { status: 403, body: { error: 'Not your turn' } };
  if (!g.awaitingMove) return { status: 400, body: { error: 'Nothing to move' } };
  if (!g.validMoves.includes(body.token)) return { status: 400, body: { error: 'Invalid token' } };

  const value = g.dice;
  const ti = body.token;
  g.awaitingMove = false;
  g.validMoves = [];

  let extra = (value === 6);
  if (g.tokens[pi][ti] === -1) g.tokens[pi][ti] = 0;
  else {
    g.tokens[pi][ti] += value;
    if (g.tokens[pi][ti] === 56) extra = true;
  }

  let captured = false;
  const pos = g.tokens[pi][ti];
  if (pos <= 50) {
    const ri = (START[pi] + pos) % 52;
    if (!SAFE.includes(ri)) {
      for (let op = 0; op < 4; op++) {
        if (op === pi || !g.players[op]) continue;
        for (let i = 0; i < 4; i++) {
          const ov = g.tokens[op][i];
          if (ov >= 0 && ov <= 50 && (START[op] + ov) % 52 === ri) {
            g.tokens[op][i] = -1;
            captured = true;
          }
        }
      }
    }
  }
  if (captured) extra = true;

  if (g.tokens[pi].every(v => v === 56)) {
    g.over = true;
    g.winner = pi;
    g.message = COLORS[pi].toUpperCase() + ' WINS!';
    await save(env.LUDO_KV, g);
    return { body: pub(g) };
  }

  if (!extra) g.turn = nextTurn(g, pi);
  g.dice = 0;
  g.message = captured ? COLORS[pi] + ' captured a token!' : (extra ? COLORS[pi] + ' rolls again' : '');
  await save(env.LUDO_KV, g);
  return { body: pub(g) };
}

async function apiTap(env, body) {
  const g = await load(env.LUDO_KV, body.code);
  if (!g) return { status: 404, body: { error: 'Room not found' } };
  const pi = g.players.findIndex(p => p && p.pid === body.pid);
  if (pi < 0) return { status: 403, body: { error: 'Not in room' } };

  const now = Date.now();
  const key = 'p' + pi;
  if (!g.taps[key]) g.taps[key] = [];
  g.taps[key] = g.taps[key].filter(t => now - t < 3000);
  g.taps[key].push(now);

  let activated = false;
  if (g.taps[key].length >= 10) {
    g.taps[key] = [];
    if (!g.players[pi].lucky) {
      g.players[pi].lucky = true;
      activated = true;
    }
  }
  await save(env.LUDO_KV, g);
  return { body: { activated } };
}