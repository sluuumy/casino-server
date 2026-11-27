/* ===================================================================
   ÉCONOMIE DE CARAT
   Tout ce qui fait gagner ou perdre de l'argent est calculé ici, sur le
   serveur : le site ne fait plus qu'afficher et envoyer des demandes
   (« je mise 10 $ à pile »). Le solde, l'XP, les objectifs, le pass, la
   boutique et les mini-jeux ne peuvent donc plus être modifiés depuis le
   navigateur.

   Deux parties par compte :
   - a.state : la progression, renvoyée au site (rien de secret dedans) ;
   - a.priv  : ce que le joueur ne doit pas voir (mines, code du coffre,
               sabot du blackjack…), jamais envoyé au site.
   =================================================================== */
'use strict';
const crypto = require('crypto');
const R = require('./regles');

/* ----- Outils ----- */
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const floor2 = n => Math.floor(n * 100 + 1e-9) / 100;
const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const rint = n => crypto.randomInt(0, n);
const rfloat = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = rint(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
class Fail extends Error {}
const fail = msg => { throw new Fail(msg); };
const parisDay = (ts = Date.now()) => new Date(ts).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
const isWeekend = (ts = Date.now()) => ['Sat', 'Sun'].includes(new Date(ts).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Europe/Paris' }));
function dayHash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/* Saison en cours : fournie par server.js */
let seasonCfg = () => null;
const setSeasonSource = fn => { seasonCfg = fn; };
const rules = () => (seasonCfg() && seasonCfg().rules) || {};
const seasonNum = () => (seasonCfg() ? seasonCfg().num : 0);

const GOAL_MIN_BET = 10;
const counts = bet => bet >= GOAL_MIN_BET;
const COIN_PAYOUT = 1.95;
const HOUSE = 0.97;
const MAX_LEVEL = 50;
const xpForLevel = L => { if (L <= 1) return 0; const n = L - 1; return 150 * n + 20 * n * (n - 1) + (n - 1) * n * (2 * n - 1) / 2; };
const levelOf = xp => { let L = 1; while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++; return L; };
const XP_WEIGHT = { 'Plinko': 0.3, 'Pile ou face': 0.5, 'Machine à sous': 0.6, 'Roue de la fortune': 0.7, 'Grattage': 0.8, 'Mines': 1, 'Hilo': 1, 'Duel': 1, 'Blackjack': 1.2, 'Aviateur': 1.5, 'Course': 1.5 };
const XP_DAILY_CAP = 4000, XP_OVER_CAP = 0.25, XP_DAILY_MAX = 6000, XP_GOAL = 250, XP_DAILY_GOAL = 400, XP_TICKET = 10;
const PASS_THEMES = ['or_massif', 'banquise', 'magma'];
const ARCADE_RUNS = 5;
const COIN_SKINS = ['or', 'argent', 'onyx', 'emeraude'];
const SUITS = ['♠', '♥', '♦', '♣'];

/* =====================================================================
   ÉTAT D'UN COMPTE
   ===================================================================== */
const C_KEYS = ['minesRun', 'blackjacks', 'coinStreak', 'coinBest', 'wagered', 'minesClear', 'bestWin', 'dailyClaimed', 'boost50', 'chats', 'sabotages', 'games10', 'wins10', 'plinkoEdge', 'hiloBest', 'wheelTop', 'slot7', 'outsider', 'lotoTickets', 'lotoWins', 'duelWins'];
function newState(startBalance) {
  const c = {}; C_KEYS.forEach(k => { c[k] = 0; });
  return {
    rev: 1, balance: startBalance, totalClicks: 0, totalWon: 0, totalLost: 0,
    season: seasonNum(), xp: 0, xpDay: null, passClaimed: {}, passTitles: [], coinSkin: 'or', boostItems: {}, passVersion: 2,
    biggestMult: 1, bestCrash: 0, gamesPlayed: 0, gamesWon: 0,
    achievements: {}, inventory: {}, equippedBadge: '', history: [],
    clicker: { up: {}, bought: 0, boosts: 0, clickEarned: 0, autoEarned: 0 },
    c, seen: {}, loto: {}, plinkoBig: [], fast: false,
    boost: null, malus: {}, goals: {}, daily: { day: '', ids: [], prog: {}, claimed: {} }, theme: 'tapis', lastSeen: Date.now(),
    arcade: null, hiloCard: { r: rint(13) + 1, s: SUITS[rint(4)] }
  };
}
/* Remet en forme une progression enregistrée (les anciennes venaient du navigateur) */
function normalize(raw, startBalance) {
  const d = newState(startBalance);
  if (!raw || typeof raw !== 'object') return d;
  const s = { ...d };
  for (const k of ['balance', 'totalClicks', 'totalWon', 'totalLost', 'biggestMult', 'bestCrash', 'gamesPlayed', 'gamesWon', 'xp', 'rev']) s[k] = raw[k] != null ? num(raw[k]) : d[k];
  s.balance = r2(s.balance);
  s.season = Math.floor(num(raw.season));
  s.passVersion = Math.floor(num(raw.passVersion));
  s.xpDay = raw.xpDay && typeof raw.xpDay.day === 'string' ? { day: raw.xpDay.day, games: num(raw.xpDay.games) } : null;
  s.passClaimed = {}; Object.keys(obj(raw.passClaimed)).forEach(k => { if (/^[fp]\d{1,2}$/.test(k)) s.passClaimed[k] = true; });
  s.passTitles = (Array.isArray(raw.passTitles) ? raw.passTitles : []).filter(t => typeof t === 'string').slice(0, 30);
  s.coinSkin = COIN_SKINS.includes(raw.coinSkin) ? raw.coinSkin : 'or';
  s.boostItems = {}; Object.entries(obj(raw.boostItems)).forEach(([k, v]) => { if (R.BOOSTS.some(b => String(b.mult) === k) && num(v) > 0) s.boostItems[k] = Math.floor(num(v)); });
  s.achievements = {}; Object.keys(obj(raw.achievements)).forEach(k => { if (/^[a-z0-9_]{1,30}$/.test(k)) s.achievements[k] = true; });
  s.inventory = {}; Object.keys(obj(raw.inventory)).forEach(k => { if (/^[a-z0-9_]{1,40}$/.test(k)) s.inventory[k] = true; });
  s.equippedBadge = typeof raw.equippedBadge === 'string' ? raw.equippedBadge.slice(0, 30) : '';
  s.history = (Array.isArray(raw.history) ? raw.history : []).slice(0, 50).map(h => ({ g: String(h && h.g || '').slice(0, 24), bet: num(h && h.bet), win: num(h && h.win), mult: num(h && h.mult), t: num(h && h.t) }));
  const ck = obj(raw.clicker);
  s.clicker = { up: {}, bought: num(ck.bought), boosts: num(ck.boosts), clickEarned: num(ck.clickEarned), autoEarned: num(ck.autoEarned) };
  Object.entries(obj(ck.up)).forEach(([k, v]) => { if (R.UPGRADES.some(u => u.id === k)) s.clicker.up[k] = Math.floor(num(v)); });
  const c = obj(raw.c); s.c = {}; C_KEYS.forEach(k => { s.c[k] = num(c[k]); });
  s.seen = {}; Object.keys(obj(raw.seen)).forEach(k => { if (R.ALL_GAMES.includes(k)) s.seen[k] = 1; });
  s.loto = {}; Object.entries(obj(raw.loto)).forEach(([id, t]) => { if (/^\d{4}-\d{2}-\d{2}(-\w+)?$/.test(id) && t && num(t.n) > 0) s.loto[id] = { n: Math.floor(num(t.n)), paid: num(t.paid) }; });
  s.plinkoBig = (Array.isArray(raw.plinkoBig) ? raw.plinkoBig : []).slice(0, 30).map(x => ({ m: num(x && x.m), rows: Math.floor(num(x && x.rows)), risk: String(x && x.risk || '').slice(0, 10), bet: num(x && x.bet), win: num(x && x.win), t: num(x && x.t) }));
  s.fast = raw.fast === true;
  const b = raw.boost;
  s.boost = b && R.BOOSTS.some(x => x.mult === b.mult) && Number.isFinite(b.until) ? { mult: b.mult, until: b.until, pool: num(b.pool) } : null;
  s.malus = {};
  const ml = obj(raw.malus);
  if (ml.halve && num(ml.halve.games) > 0) s.malus.halve = { games: Math.min(Math.floor(num(ml.halve.games)), R.MALUS_MAX_GAMES), from: String(ml.halve.from || '').slice(0, 24) };
  for (const k of ['clicker', 'noboost']) if (ml[k] && num(ml[k].until) > Date.now()) s.malus[k] = { until: num(ml[k].until), from: String(ml[k].from || '').slice(0, 24) };
  s.goals = {}; Object.keys(obj(raw.goals)).forEach(k => { if (R.GOALS.some(g => g.id === k)) s.goals[k] = true; });
  const dl = obj(raw.daily);
  s.daily = { day: typeof dl.day === 'string' ? dl.day : '', ids: (Array.isArray(dl.ids) ? dl.ids : []).filter(i => R.DAILY_POOL.some(x => x.id === i)).slice(0, R.DAILY_COUNT), prog: {}, claimed: {} };
  Object.entries(obj(dl.prog)).forEach(([k, v]) => { s.daily.prog[k] = num(v); });
  Object.keys(obj(dl.claimed)).forEach(k => { s.daily.claimed[k] = true; });
  s.theme = R.THEMES.some(t => t.id === raw.theme) ? raw.theme : 'tapis';
  s.lastSeen = num(raw.lastSeen) || Date.now();
  s.arcade = null;
  if (raw.arcade && typeof raw.arcade.day === 'string') {
    s.arcade = { day: raw.arcade.day, earned: num(raw.arcade.earned) };
    for (const id of ['tir', 'coffre', 'taquin']) {
      const o = obj(raw.arcade[id]);
      s.arcade[id] = { runs: Math.min(ARCADE_RUNS, Math.floor(num(o.runs))), best: Math.floor(num(o.best)), live: null }; // une partie de logique non terminée est abandonnée
    }
  }
  const hc = obj(raw.hiloCard);
  s.hiloCard = hc.r >= 1 && hc.r <= 13 && SUITS.includes(hc.s) ? { r: Math.floor(hc.r), s: hc.s } : d.hiloCard;
  return s;
}
/* Ce que le site reçoit : toute la progression (aucun secret n'y est rangé) */
function snapshot(st) { return JSON.parse(JSON.stringify(st)); }
const touch = st => { st.rev = (st.rev || 0) + 1; };

/* =====================================================================
   CALCULS DE BASE
   ===================================================================== */
const level = (st, id) => st.clicker.up[id] || 0;
const upCost = (st, u) => r2(u.base * R.GROWTH ** level(st, u.id) * (rules().upgradePrice || 1));
const clickValue = st => r2(R.CLICK_BASE + R.UPGRADES.filter(u => u.kind === 'click').reduce((s, u) => s + u.value * level(st, u.id), 0));
const autoRate = st => Math.round(R.UPGRADES.filter(u => u.kind === 'auto').reduce((s, u) => s + u.value * level(st, u.id), 0) * 100) / 100;
const boostActive = (st, now = Date.now()) => !!(st.boost && st.boost.until > now);
const malusOn = (st, id, now = Date.now()) => { const m = st.malus && st.malus[id]; if (!m) return false; return id === 'halve' ? m.games > 0 : m.until > now; };
const clickerFactor = st => (malusOn(st, 'clicker') ? 0.5 : 1);
const boostMult = st => (boostActive(st) && !malusOn(st, 'noboost') ? st.boost.mult : 1);
const seasonPrice = (kind, base) => r2(base * (rules()[kind] || 1));
const shopAll = () => [...((seasonCfg() && seasonCfg().shopTitles) || []), ...R.SHOP];
const titlesOwned = st => shopAll().filter(i => st.inventory[i.id]).length;
const themesOwned = st => R.THEMES.filter(t => t.price && !t.pass && st.inventory['theme_' + t.id]).length;
Object.assign(R.calc, { clickValue, autoRate, titlesOwned, themesOwned });

function credit(st, amount) { amount = r2(amount); if (amount > 0) st.balance = r2(st.balance + amount); }
function debit(st, amount) {
  amount = r2(amount);
  if (!(amount > 0) || amount > st.balance + 1e-9) fail('Solde insuffisant.');
  st.balance = r2(st.balance - amount);
}
function readBet(st, v, min = 1) {
  const bet = r2(v);
  if (!Number.isFinite(bet) || bet < min) fail(`Mise minimum : ${min} $.`);
  if (bet > 1e15) fail('Mise trop élevée.');
  if (bet > st.balance + 1e-9) fail('Solde insuffisant.');
  return bet;
}

/* =====================================================================
   OBJECTIFS DU JOUR ET XP
   ===================================================================== */
function pickDaily(day) { // les mêmes objectifs pour tout le monde ce jour-là (même calcul que le site)
  let h = 2166136261;
  for (const ch of day) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const ids = R.DAILY_POOL.map(d => d.id);
  for (let i = ids.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const keys = new Set(), out = [];
  for (const id of ids) {
    const k = R.DAILY_POOL.find(d => d.id === id).key;
    if (keys.has(k)) continue;
    keys.add(k); out.push(id);
    if (out.length === R.DAILY_COUNT) break;
  }
  return out;
}
function ensureDay(st) {
  const k = parisDay();
  if (st.daily.day !== k) st.daily = { day: k, ids: pickDaily(k), prog: {}, claimed: {} };
}
function bump(st, key, n) { ensureDay(st); st.daily.prog[key] = r2((st.daily.prog[key] || 0) + n); }
const xpAdd = (st, n) => { if (n > 0) st.xp = (st.xp || 0) + n; };
function xpToday(st) {
  const day = parisDay();
  if (!st.xpDay || st.xpDay.day !== day) st.xpDay = { day, games: 0 };
  return st.xpDay;
}
function xpFromGame(st, game, bet) {
  if (!(bet >= 10)) return;
  const season = (rules().xpGames || {})[game] || 1;
  const xp = Math.min(25, Math.floor(bet / 10) + 1) * (XP_WEIGHT[game] || 1) * season;
  const d = xpToday(st);
  const full = Math.max(0, Math.min(xp, XP_DAILY_CAP - d.games));
  const reduced = Math.max(0, Math.min((xp - full) * XP_OVER_CAP, XP_DAILY_MAX - Math.max(d.games + full, XP_DAILY_CAP)));
  d.games += full + reduced;
  xpAdd(st, full + reduced);
}

/* =====================================================================
   RÈGLEMENT D'UNE PARTIE (boost, bonus de saison, handicap, statistiques)
   ev : liste d'événements que server.js diffuse ensuite (grosses victoires…)
   ===================================================================== */
function settle(st, ev, game, bet, payout, mult, opts = {}) {
  payout = r2(payout);
  const bm = opts.raw ? 1 : boostMult(st);
  if (bm > 1 && payout > bet && st.boost.pool > 0) {
    const bonus = Math.min(r2((payout - bet) * (bm - 1)), st.boost.pool);
    st.boost.pool = r2(st.boost.pool - bonus);
    payout = r2(payout + bonus);
  }
  const gb = rules().gameBonus;
  if (!opts.raw && gb && gb.game === game && payout > bet && (!gb.weekend || isWeekend())) payout = r2(payout + r2((payout - bet) * gb.pct / 100));
  if (!opts.raw && malusOn(st, 'halve') && bet >= 10) {
    if (payout > bet) payout = r2(bet + (payout - bet) / 2);
    st.malus.halve.games--;
    if (st.malus.halve.games <= 0) delete st.malus.halve;
  }
  credit(st, payout);
  const net = r2(payout - bet);
  st.gamesPlayed++;
  if (net > 0) {
    st.totalWon = r2(st.totalWon + net); st.gamesWon++;
    if (mult > st.biggestMult) st.biggestMult = mult;
  } else if (net < 0) st.totalLost = r2(st.totalLost - net);
  st.history.unshift({ g: game, bet, win: payout, mult: mult || 0, t: Date.now() });
  if (st.history.length > 50) st.history.length = 50;
  st.c.wagered = r2(st.c.wagered + bet);
  bump(st, 'wager', bet);
  if (bet >= GOAL_MIN_BET) {
    st.c.games10++; st.seen[game] = 1; bump(st, 'games', 1);
    if (net > 0) { st.c.wins10++; bump(st, 'wins', 1); }
  }
  if (net > 0) { bump(st, 'profit', net); if (net > st.c.bestWin) st.c.bestWin = net; }
  xpFromGame(st, game, bet);
  if (net > 0) ev.push({ type: 'win', game, amount: net, mult: mult || 0 });
  return payout;
}

/* =====================================================================
   JEUX INSTANTANÉS
   ===================================================================== */
function coinPlay(st, priv, d, ev) {
  const bet = readBet(st, d.amount), side = d.side === 'face' ? 'face' : 'pile';
  debit(st, bet); ev.push({ type: 'bet', game: 'Pile ou face', amount: bet });
  const res = rint(2) === 0 ? 'pile' : 'face', win = res === side;
  st.c.coinStreak = win ? st.c.coinStreak + 1 : 0;
  if (st.c.coinStreak > st.c.coinBest) st.c.coinBest = st.c.coinStreak;
  const got = settle(st, ev, 'Pile ou face', bet, win ? r2(bet * COIN_PAYOUT) : 0, win ? COIN_PAYOUT : 0);
  if (win) bump(st, 'coinwins', 1);
  return { res, win, got, bet };
}

function plinkoDrop(st, priv, d, ev) {
  const rows = [8, 12, 16].includes(Number(d.rows)) ? Number(d.rows) : fail('Nombre de rangées invalide.');
  const risk = ['faible', 'moyen', 'eleve'].includes(d.risk) ? d.risk : fail('Risque invalide.');
  const bet = readBet(st, d.amount);
  debit(st, bet); ev.push({ type: 'bet', game: 'Plinko', amount: bet });
  const path = []; let k = 0;
  for (let i = 0; i < rows; i++) { const right = rint(2); path.push(right); k += right; }
  const m = R.PLINKO_TABLES[rows][risk][k];
  if ((k === 0 || k === rows) && counts(bet)) st.c.plinkoEdge++;
  if (counts(bet)) bump(st, 'plinko', 1);
  const got = settle(st, ev, 'Plinko', bet, r2(bet * m), m);
  if (got > bet) {
    st.plinkoBig.unshift({ m, rows, risk, bet, win: r2(got - bet), t: Date.now() });
    st.plinkoBig.length = Math.min(st.plinkoBig.length, 30);
  }
  return { path, k, m, got, bet };
}

function slotsEvaluate(stops) {
  const L = R.SLOT_STRIP.length, wins = [];
  R.SLOT_LINES.forEach((line, li) => {
    const syms = line.map((row, reel) => R.SLOT_STRIP[(stops[reel] + row) % L]);
    if (syms[0] === syms[1] && syms[1] === syms[2]) wins.push({ li, cells: [0, 1, 2], sym: syms[0], m: R.SLOT_PAY[syms[0]] });
    else if (syms[0] === 'cerise' && syms[1] === 'cerise') wins.push({ li, cells: [0, 1], sym: 'cerise', m: R.SLOT_CHERRY2 });
  });
  return wins;
}
function slotsSpin(st, priv, d, ev) {
  const bet = readBet(st, d.amount);
  debit(st, bet); ev.push({ type: 'bet', game: 'Machine à sous', amount: bet });
  const L = R.SLOT_STRIP.length, stops = [0, 1, 2].map(() => rint(L));
  const wins = slotsEvaluate(stops), lineBet = bet / R.SLOT_LINES.length;
  const total = wins.reduce((s, w) => s + w.m, 0), pay = r2(lineBet * total), m = r2(total / R.SLOT_LINES.length);
  if (wins.some(w => w.sym === 'sept' && w.cells.length === 3) && counts(bet)) st.c.slot7++;
  if (counts(bet)) bump(st, 'slots', 1);
  const got = settle(st, ev, 'Machine à sous', bet, pay, m);
  return { stops, got, pay, bet };
}

function wheelLayout(risk) {
  const N = 30, slots = Array(N).fill(null);
  R.WHEEL_RISKS[risk].slice().sort((a, b) => a[1] - b[1]).forEach(([m, c]) => {
    for (let j = 0; j < c; j++) {
      let idx = Math.round(((j + 0.5) * N) / c) % N;
      while (slots[idx] !== null) idx = (idx + 1) % N;
      slots[idx] = m;
    }
  });
  return slots;
}
function wheelSpin(st, priv, d, ev) {
  const risk = R.WHEEL_RISKS[d.risk] ? d.risk : fail('Risque invalide.');
  const bet = readBet(st, d.amount);
  debit(st, bet); ev.push({ type: 'bet', game: 'Roue de la fortune', amount: bet });
  const i = rint(30), m = wheelLayout(risk)[i];
  if (m >= 29 && counts(bet)) st.c.wheelTop++;
  const got = settle(st, ev, 'Roue de la fortune', bet, r2(bet * m), m);
  return { i, m, got, bet };
}

/* ----- Grattage : la carte est tirée à l'achat, le gain versé une fois grattée ----- */
function scratchMake() {
  let x = rfloat(), tier = null;
  for (const t of R.SCRATCH_TIERS) { if (x < t.p) { tier = t; break; } x -= t.p; }
  const syms = R.SCRATCH_TIERS.map(t => t.sym), cells = [], count = {};
  if (tier) { for (let i = 0; i < 3; i++) cells.push(tier.sym); count[tier.sym] = 3; }
  while (cells.length < 9) {
    const s = syms[rint(syms.length)];
    if ((count[s] || 0) >= 2) continue;
    if (tier && s === tier.sym) continue;
    count[s] = (count[s] || 0) + 1; cells.push(s);
  }
  return { cells: shuffle(cells), m: tier ? tier.m : 0, sym: tier ? tier.sym : null };
}
function scratchBuy(st, priv, d, ev) {
  if (!seasonCfg() || !(seasonCfg().seasonGames || []).includes('grattage')) fail('Le Grattage n’est pas disponible cette saison.');
  if (priv.scratch) fail('Grattez d’abord votre carte en cours.');
  const bet = readBet(st, d.amount);
  debit(st, bet); ev.push({ type: 'bet', game: 'Grattage', amount: bet });
  const card = scratchMake();
  priv.scratch = { bet, m: card.m };
  return { cells: card.cells, m: card.m, sym: card.sym, bet };
}
function scratchDone(st, priv, d, ev) {
  const c = priv.scratch;
  if (!c) fail('Aucune carte en cours.');
  priv.scratch = null;
  const got = settle(st, ev, 'Grattage', c.bet, r2(c.bet * c.m), c.m);
  return { got, bet: c.bet, m: c.m };
}

/* =====================================================================
   MINES
   ===================================================================== */
const MINES_COUNTS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 24];
function minesMult(bombs, k) { if (k <= 0) return 1; let m = HOUSE; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - bombs - i); return floor2(m); }
function minesStart(st, priv, d, ev) {
  if (priv.mines) fail('Une partie de Mines est déjà en cours.');
  const bombs = MINES_COUNTS.includes(Number(d.bombs)) ? Number(d.bombs) : fail('Nombre de mines invalide.');
  const bet = readBet(st, d.amount);
  debit(st, bet);
  priv.mines = { bet, bombs, mines: shuffle([...Array(25).keys()]).slice(0, bombs), open: [], found: 0 };
  return { bet, bombs };
}
function minesCash(st, priv, ev) {
  const g = priv.mines;
  if (!g || g.found === 0) fail('Rien à encaisser.');
  const m = minesMult(g.bombs, g.found);
  priv.mines = null;
  const got = settle(st, ev, 'Mines', g.bet, r2(g.bet * m), m);
  bump(st, 'mineswins', 1);
  if (g.found === 25 - g.bombs && g.bombs >= 3 && counts(g.bet)) st.c.minesClear++;
  return { cashed: true, m, got, bet: g.bet, mines: g.mines };
}
function minesPick(st, priv, d, ev) {
  const g = priv.mines;
  if (!g) fail('Aucune partie en cours.');
  const i = Math.floor(Number(d.i));
  if (!(i >= 0 && i < 25) || g.open.includes(i)) fail('Case invalide.');
  g.open.push(i);
  if (g.mines.includes(i)) {
    priv.mines = null;
    settle(st, ev, 'Mines', g.bet, 0, 0);
    return { bomb: true, bet: g.bet, mines: g.mines };
  }
  g.found++;
  if (counts(g.bet)) {
    if (g.bombs >= 3 && g.found > st.c.minesRun) st.c.minesRun = g.found;
    bump(st, 'gems', 1);
  }
  if (g.found === 25 - g.bombs) return { gem: true, ...minesCash(st, priv, ev) };
  return { gem: true, found: g.found };
}

/* =====================================================================
   HILO
   ===================================================================== */
const hiloDraw = () => ({ r: rint(13) + 1, s: SUITS[rint(4)] });
const pHigh = r => (13 - r) / 13, pLow = r => (r - 1) / 13;
const hiloStep = p => (p > 0 ? Math.floor((0.99 / p) * 10000) / 10000 : 0);
function hiloStart(st, priv, d, ev) {
  if (priv.hilo) fail('Une partie de Hilo est déjà en cours.');
  const bet = readBet(st, d.amount);
  debit(st, bet); ev.push({ type: 'bet', game: 'Hilo', amount: bet });
  priv.hilo = { bet, mult: 1, streak: 0 };
  return { bet, card: st.hiloCard };
}
function hiloRecord(st, g) { if (counts(g.bet) && g.streak > st.c.hiloBest) st.c.hiloBest = g.streak; }
function hiloGuess(st, priv, d, ev) {
  const g = priv.hilo;
  if (!g) fail('Aucune partie en cours.');
  const r = st.hiloCard.r, high = d.dir === 'high', p = high ? pHigh(r) : pLow(r);
  if (p <= 0) fail('Choix impossible avec cette carte.');
  const next = hiloDraw(), ok = high ? next.r > r : next.r < r;
  st.hiloCard = next;
  if (!ok) {
    priv.hilo = null; hiloRecord(st, g);
    settle(st, ev, 'Hilo', g.bet, 0, 0);
    return { ok: false, card: next, bet: g.bet };
  }
  g.mult *= hiloStep(p); g.streak++;
  if (counts(g.bet)) bump(st, 'hilo', 1);
  return { ok: true, card: next, mult: g.mult, streak: g.streak };
}
function hiloCash(st, priv, d, ev) {
  const g = priv.hilo;
  if (!g || g.streak === 0) fail('Rien à encaisser.');
  priv.hilo = null; hiloRecord(st, g);
  const m = floor2(g.mult);
  const got = settle(st, ev, 'Hilo', g.bet, r2(g.bet * m), m);
  return { m, got, bet: g.bet };
}

/* =====================================================================
   BLACKJACK : sabot de 6 jeux, croupier reste sur 17, blackjack 3:2
   ===================================================================== */
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const cardVal = c => (c.r === 'A' ? 1 : ['J', 'Q', 'K'].includes(c.r) ? 10 : Number(c.r));
function bjTotal(hand) { let t = 0, aces = 0; for (const c of hand) { t += cardVal(c); if (c.r === 'A') aces++; } return aces > 0 && t + 10 <= 21 ? t + 10 : t; }
const isBJ = hand => hand.length === 2 && bjTotal(hand) === 21;
function bjShoe(priv) {
  const sh = priv.bjShoe;
  if (sh && sh.cards.length >= sh.cut) return sh;
  const s = [];
  for (let d = 0; d < 6; d++) for (const su of SUITS) for (const r of RANKS) s.push({ r, s: su });
  priv.bjShoe = { cards: shuffle(s), cut: 52 + rint(27) };
  return priv.bjShoe;
}
const bjDraw = priv => { if (!priv.bjShoe.cards.length) { priv.bjShoe = null; bjShoe(priv); } return priv.bjShoe.cards.pop(); };
function bjView(st, priv, g, done, extra = {}) {
  st.bjShoeLeft = priv.bjShoe ? priv.bjShoe.cards.length : 312;
  return { player: g.player, dealer: done ? g.dealer : [g.dealer[0], null], done, bet: g.bet, shoe: st.bjShoeLeft, ...extra };
}
function bjFinish(st, priv, ev) {
  const g = priv.bj; priv.bj = null;
  const p = bjTotal(g.player), dt = bjTotal(g.dealer), pBJ = isBJ(g.player), dBJ = isBJ(g.dealer), b = g.bet;
  let pay = 0;
  if (pBJ && dBJ) pay = b;
  else if (pBJ) pay = r2(b * 2.5);
  else if (dBJ || p > 21) pay = 0;
  else if (dt > 21 || p > dt) pay = r2(b * 2);
  else if (p === dt) pay = b;
  const got = settle(st, ev, 'Blackjack', b, pay, pay ? r2(pay / b) : 0);
  if (pBJ) { st.c.blackjacks++; bump(st, 'bjs', 1); }
  if (pay > b) bump(st, 'bjwins', 1);
  return bjView(st, priv, g, true, { pay, got });
}
function bjDealerPlays(priv) { const g = priv.bj; while (bjTotal(g.dealer) < 17) g.dealer.push(bjDraw(priv)); }
function bjDeal(st, priv, d, ev) {
  if (priv.bj) fail('Une main est déjà en cours.');
  const bet = readBet(st, d.amount);
  bjShoe(priv);
  debit(st, bet); ev.push({ type: 'bet', game: 'Blackjack', amount: bet });
  const g = priv.bj = { bet, player: [], dealer: [] };
  g.player.push(bjDraw(priv)); g.dealer.push(bjDraw(priv)); g.player.push(bjDraw(priv)); g.dealer.push(bjDraw(priv));
  const up = cardVal(g.dealer[0]);
  if (isBJ(g.player) || ((up === 1 || up === 10) && isBJ(g.dealer))) return bjFinish(st, priv, ev);
  return bjView(st, priv, g, false);
}
function bjHit(st, priv, d, ev) {
  const g = priv.bj; if (!g) fail('Aucune main en cours.');
  g.player.push(bjDraw(priv));
  const t = bjTotal(g.player);
  if (t > 21) return bjFinish(st, priv, ev);
  if (t === 21) { bjDealerPlays(priv); return bjFinish(st, priv, ev); }
  return bjView(st, priv, g, false);
}
function bjStand(st, priv, d, ev) {
  if (!priv.bj) fail('Aucune main en cours.');
  bjDealerPlays(priv);
  return bjFinish(st, priv, ev);
}
function bjDouble(st, priv, d, ev) {
  const g = priv.bj; if (!g || g.player.length !== 2) fail('Vous ne pouvez plus doubler.');
  debit(st, g.bet);
  g.bet = r2(g.bet * 2);
  g.player.push(bjDraw(priv));
  if (bjTotal(g.player) <= 21) bjDealerPlays(priv);
  return bjFinish(st, priv, ev);
}

/* =====================================================================
   PARTIES INTERROMPUES (fermeture du site, coupure réseau, autre appareil)
   Mines et Hilo sont encaissés s'il y a un gain, sinon la mise est rendue ;
   le blackjack est joué comme si le joueur restait ; la carte à gratter est payée.
   ===================================================================== */
function resolveActive(st, priv, ev) {
  const notes = [];
  if (priv.mines) {
    const g = priv.mines;
    if (g.found > 0) { const r = minesCash(st, priv, ev); notes.push(`Partie de Mines encaissée automatiquement à ${r.m}× : ${r.got} $.`); }
    else { priv.mines = null; credit(st, g.bet); notes.push('Partie de Mines non commencée : mise remboursée.'); }
  }
  if (priv.hilo) {
    const g = priv.hilo;
    if (g.streak > 0) { const r = hiloCash(st, priv, {}, ev); notes.push(`Partie de Hilo encaissée automatiquement à ${r.m}× : ${r.got} $.`); }
    else { priv.hilo = null; credit(st, g.bet); notes.push('Partie de Hilo non commencée : mise remboursée.'); }
  }
  if (priv.bj) { bjDealerPlays(priv); const r = bjFinish(st, priv, ev); notes.push(`Main de blackjack terminée automatiquement : ${r.got} $ rendus.`); }
  if (priv.scratch) { const r = scratchDone(st, priv, {}, ev); if (r.got) notes.push(`Carte à gratter terminée : ${r.got} $.`); }
  priv.tir = null;
  return notes;
}

/* =====================================================================
   CLICKER : clics, revenus automatiques, améliorations, boosts
   ===================================================================== */
const CLICKS_PER_S = 12;
function clicks(st, priv, d, ev, now = Date.now()) {
  const want = Math.max(0, Math.min(60, Math.floor(Number(d.n) || 0)));
  const b = priv.clickBucket || (priv.clickBucket = { tokens: CLICKS_PER_S, at: now });
  b.tokens = Math.min(CLICKS_PER_S * 2, b.tokens + ((now - b.at) / 1000) * CLICKS_PER_S);
  b.at = now;
  const n = Math.min(want, Math.floor(b.tokens));
  b.tokens -= n;
  if (!n) return { accepted: 0 };
  const gain = r2(clickValue(st) * boostMult(st) * clickerFactor(st) * (rules().clickMult || 1));
  const before = st.totalClicks;
  st.totalClicks += n;
  xpAdd(st, 2 * (Math.floor(st.totalClicks / 100) - Math.floor(before / 100)));
  const total = r2(gain * n);
  st.clicker.clickEarned = r2(st.clicker.clickEarned + total);
  credit(st, total);
  bump(st, 'clicks', n);
  return { accepted: n, gain };
}
/* Revenus automatiques depuis le dernier calcul (joueur connecté) */
function accrue(st, priv, now = Date.now()) {
  const from = priv.accAt || now;
  priv.accAt = now;
  const dt = Math.min(now - from, R.OFFLINE_CAP_S * 1000);
  const rate = autoRate(st);
  if (!(rate > 0) || dt <= 0) return 0;
  let boostedMs = 0;
  if (st.boost && st.boost.until > from) boostedMs = Math.min(now, st.boost.until) - from;
  const bm = st.boost && !malusOn(st, 'noboost') ? st.boost.mult : 1;
  const units = (dt - boostedMs) / 1000 + (boostedMs / 1000) * bm;
  const amt = rate * units * clickerFactor(st) + (priv.carry || 0);
  const whole = Math.floor(amt * 100) / 100;
  priv.carry = amt - whole;
  if (whole > 0) { st.clicker.autoEarned = r2(st.clicker.autoEarned + whole); credit(st, whole); }
  return whole;
}
/* Gains pendant l'absence : moitié du rythme, 2 heures au maximum, sans boost */
function offline(st, priv, now = Date.now()) {
  const last = st.lastSeen;
  st.lastSeen = now; priv.accAt = now; priv.carry = 0;
  if (!last || now <= last) return 0;
  const secs = Math.min((now - last) / 1000, R.OFFLINE_CAP_S);
  if (secs < 60) return 0;
  const gain = Math.floor(autoRate(st) * secs * R.OFFLINE_RATE * 100) / 100;
  if (gain > 0) { st.clicker.autoEarned = r2(st.clicker.autoEarned + gain); credit(st, gain); }
  return gain;
}
function upgradeBuy(st, priv, d) {
  const u = R.UPGRADES.find(x => x.id === d.id) || fail('Amélioration inconnue.');
  const cost = upCost(st, u);
  if (cost > st.balance + 1e-9) fail(`Il vous manque ${r2(cost - st.balance)} $.`);
  debit(st, cost);
  st.clicker.up[u.id] = level(st, u.id) + 1;
  st.clicker.bought++;
  bump(st, 'upgrades', 1);
  return { id: u.id, level: st.clicker.up[u.id] };
}
function boostStart(st, mult, now) {
  const b = R.BOOSTS.find(x => x.mult === mult);
  const extend = boostActive(st, now) && st.boost.mult === mult;
  const pool = r2(b.price * R.GAME_BONUS_SHARE + (extend ? st.boost.pool || 0 : 0));
  st.boost = { mult, until: (extend ? st.boost.until : now) + R.BOOST_MS, pool };
  return extend;
}
function boostCheck(st, mult, now) {
  if (!R.BOOSTS.some(x => x.mult === mult)) fail('Boost inconnu.');
  if (boostActive(st, now) && st.boost.mult === mult && st.boost.until - now + R.BOOST_MS > R.BOOST_MAX_MS) fail('Un boost ne peut pas dépasser 30 minutes d’affilée.');
}
function boostBuy(st, priv, d, ev, now = Date.now()) {
  const mult = Number(d.mult); boostCheck(st, mult, now);
  const price = seasonPrice('boostPrice', R.BOOSTS.find(x => x.mult === mult).price);
  if (price > st.balance + 1e-9) fail(`Il vous manque ${r2(price - st.balance)} $ pour ce boost.`);
  debit(st, price);
  const extend = boostStart(st, mult, now);
  st.clicker.boosts++;
  if (mult === 50) st.c.boost50++;
  bump(st, 'boosts', 1);
  return { mult, extend };
}
function boostUse(st, priv, d, ev, now = Date.now()) {
  const mult = Number(d.mult);
  if (!(st.boostItems[mult] > 0)) fail('Aucun boost de ce type en réserve.');
  boostCheck(st, mult, now);
  st.boostItems[mult]--;
  if (!st.boostItems[mult]) delete st.boostItems[mult];
  return { mult, extend: boostStart(st, mult, now) };
}

/* =====================================================================
   OBJECTIFS, PASS, BOUTIQUE
   ===================================================================== */
const dailyItems = st => st.daily.ids.map(id => R.DAILY_POOL.find(d => d.id === id)).filter(Boolean);
const dailyReward = (st, g) => r2(g.reward + Math.round(autoRate(st) * R.DAILY_BONUS_S));
function goalClaim(st, priv, d) {
  const g = R.GOALS.find(x => x.id === d.id) || fail('Objectif inconnu.');
  if (st.goals[g.id]) fail('Déjà récupéré.');
  if (g.val(st) < g.goal) fail('Objectif pas encore atteint.');
  st.goals[g.id] = true; xpAdd(st, XP_GOAL); credit(st, g.reward);
  return { reward: g.reward, title: g.title };
}
function dailyClaim(st, priv, d) {
  ensureDay(st);
  const g = dailyItems(st).find(x => x.id === d.id) || fail('Objectif du jour inconnu.');
  if (st.daily.claimed[g.id]) fail('Déjà récupéré.');
  if ((st.daily.prog[g.key] || 0) < g.goal) fail('Objectif pas encore atteint.');
  const rew = dailyReward(st, g);
  st.daily.claimed[g.id] = true; xpAdd(st, XP_DAILY_GOAL); st.c.dailyClaimed++; credit(st, rew);
  return { reward: rew, title: g.title };
}
function goalsClaimAll(st) {
  ensureDay(st);
  let total = 0, n = 0;
  R.GOALS.forEach(g => { if (!st.goals[g.id] && g.val(st) >= g.goal) { st.goals[g.id] = true; total += g.reward; n++; xpAdd(st, XP_GOAL); } });
  dailyItems(st).forEach(g => {
    if (!st.daily.claimed[g.id] && (st.daily.prog[g.key] || 0) >= g.goal) { total += dailyReward(st, g); st.daily.claimed[g.id] = true; st.c.dailyClaimed++; n++; xpAdd(st, XP_DAILY_GOAL); }
  });
  credit(st, r2(total));
  return { n, total: r2(total) };
}
const passTiers = () => (seasonCfg() && seasonCfg().pass) || [];
const prestigeLevel = () => (seasonCfg() && seasonCfg().prestigeLevel) || 20;
function passGive(st, r) {
  if (r.t === 'money') credit(st, r.v);
  else if (r.t === 'boost') st.boostItems[r.mult] = (st.boostItems[r.mult] || 0) + 1;
  else if (r.t === 'title') { if (!st.passTitles.includes(r.tag)) st.passTitles.push(r.tag); }
  else if (r.t === 'theme') st.inventory['theme_' + r.id] = true;
  else if (r.t === 'coin') { st.inventory['coin_' + r.id] = true; st.coinSkin = r.id; }
}
function passClaimOne(st, track, lvl) {
  const t = passTiers().find(x => x.level === lvl), r = t && (track === 'f' ? t.free : t.prestige);
  const L = levelOf(st.xp);
  if (!r || st.passClaimed[track + lvl] || lvl > L) return null;
  if (track === 'p' && L < prestigeLevel()) return null;
  st.passClaimed[track + lvl] = true;
  passGive(st, r);
  return r;
}
function passClaim(st, priv, d) {
  const track = d.track === 'p' ? 'p' : 'f', lvl = Math.floor(Number(d.level));
  const r = passClaimOne(st, track, lvl) || fail('Récompense indisponible.');
  return { reward: r, level: lvl, track };
}
function passClaimAll(st) {
  let n = 0;
  for (const t of passTiers()) for (const tr of ['f', 'p']) if (passClaimOne(st, tr, t.level)) n++;
  return { n };
}
function shopBuyTitle(st, priv, d) {
  const it = shopAll().find(i => i.id === d.id) || fail('Titre inconnu.');
  if (st.inventory[it.id]) fail('Vous possédez déjà ce titre.');
  debit(st, it.price);
  st.inventory[it.id] = true; st.equippedBadge = it.tag;
  return { tag: it.tag };
}
function shopBuyTheme(st, priv, d) {
  const t = R.THEMES.find(x => x.id === d.id && x.price > 0 && !x.pass) || fail('Thème inconnu.');
  if (st.inventory['theme_' + t.id]) fail('Vous possédez déjà ce thème.');
  debit(st, t.price);
  st.inventory['theme_' + t.id] = true; st.theme = t.id;
  return { id: t.id };
}
/* Réglages d'apparence envoyés par le site : acceptés seulement s'ils sont possédés */
function applyCosmetics(st, data, heritage) {
  const d = obj(data);
  if (typeof d.theme === 'string') { const t = R.THEMES.find(x => x.id === d.theme); if (t && (t.price === 0 || st.inventory['theme_' + t.id])) st.theme = t.id; }
  if (typeof d.coinSkin === 'string' && (d.coinSkin === 'or' || st.inventory['coin_' + d.coinSkin])) st.coinSkin = d.coinSkin;
  if (typeof d.equippedBadge === 'string') {
    const tag = d.equippedBadge, ok = tag === '' || shopAll().some(i => i.tag === tag && st.inventory[i.id]) || st.passTitles.includes(tag) || (heritage || []).some(h => h.tag === tag);
    if (ok) st.equippedBadge = tag;
  }
  if (typeof d.fast === 'boolean') st.fast = d.fast;
  if (d.achievements && typeof d.achievements === 'object') Object.keys(d.achievements).slice(0, 40).forEach(k => { if (/^[a-z0-9_]{1,30}$/.test(k)) st.achievements[k] = true; }); // simples badges, sans récompense
}
function receiveSabotage(st, type, from, now = Date.now()) {
  if (type === 'halve') {
    const cur = st.malus.halve ? st.malus.halve.games : 0;
    st.malus.halve = { games: Math.min(cur + 2, R.MALUS_MAX_GAMES), from };
  } else {
    const cur = Math.max(now, st.malus[type] ? st.malus[type].until : 0);
    st.malus[type] = { until: Math.min(cur + R.MALUS_MS, now + R.MALUS_MAX_MS), from };
  }
}

/* =====================================================================
   MINI-JEUX D'ADRESSE ET DE LOGIQUE
   ===================================================================== */
function arcadeRec(st) {
  const day = parisDay(), old = st.arcade;
  if (!old || old.day !== day) {
    st.arcade = { day, earned: 0 };
    ['tir', 'coffre', 'taquin'].forEach(id => { const o = old && old[id]; st.arcade[id] = { runs: o && o.live ? 1 : 0, best: (o && o.best) || 0, live: (o && o.live) || null }; });
  }
  return st.arcade;
}
const arcadeG = (st, id) => arcadeRec(st)[id];
const logicBase = id => 1500 + (dayHash(id + ':' + parisDay()) % 16) * 100;
const tirValue = () => 25 + (dayHash('tir:' + parisDay()) % 16) * 5;
const arcadeGain = (st, gain, xp) => { if (gain > 0) { credit(st, gain); arcadeRec(st).earned = r2((arcadeRec(st).earned || 0) + gain); } xpAdd(st, xp); };

/* Tir : le score vient forcément du navigateur. Le serveur vérifie qu'il est
   humainement possible (temps minimal par cible) et le plafonne. */
const TIR_MIN_MS = 250, TIR_MAX_HITS = 40;
function tirStart(st, priv) {
  const g = arcadeG(st, 'tir'), paid = g.runs < ARCADE_RUNS;
  if (paid) g.runs++;
  priv.tir = { at: Date.now(), paid, value: tirValue() };
  return { paid, value: priv.tir.value };
}
function tirEnd(st, priv, d) {
  const run = priv.tir || fail('Aucune partie en cours.');
  priv.tir = null;
  const bulls = (Array.isArray(d.bulls) ? d.bulls : []).map(Boolean);
  const elapsed = Date.now() - run.at;
  const hits = Math.min(bulls.length, TIR_MAX_HITS, Math.floor(elapsed / TIR_MIN_MS));
  let earned = 0;
  for (let n = 1; n <= hits; n++) earned = r2(earned + r2(r2(run.value * Math.pow(1.2, n - 1)) * (bulls[n - 1] ? 1.5 : 1)));
  const g = arcadeG(st, 'tir'), record = hits > g.best;
  g.best = Math.max(g.best, hits);
  if (run.paid) arcadeGain(st, earned, hits * 3); else earned = 0;
  return { hits, earned, paid: run.paid, record, capped: hits < bulls.length };
}

const coffreMult = t => (t <= 4 ? 6 : t === 5 ? 5 : t === 6 ? 4 : t === 7 ? 3 : t === 8 ? 2 : t === 9 ? 1.5 : 1);
function coffreScore(guess, code) {
  let exact = 0; const cg = {}, cc = {};
  guess.forEach((v, i) => { if (v === code[i]) exact++; else { cg[v] = (cg[v] || 0) + 1; cc[code[i]] = (cc[code[i]] || 0) + 1; } });
  let near = 0; Object.keys(cg).forEach(k => { near += Math.min(cg[k], cc[k] || 0); });
  return { exact, near };
}
function coffreStart(st, priv) {
  const g = arcadeG(st, 'coffre');
  if (g.live) fail('Un coffre est déjà en cours.');
  const paid = g.runs < ARCADE_RUNS;
  if (paid) g.runs++;
  priv.coffre = { code: Array.from({ length: 4 }, () => rint(6)) };
  g.live = { rows: [], paid, base: logicBase('coffre') };
  return { paid };
}
function coffreFinish(st, priv, win) {
  const g = arcadeG(st, 'coffre'), l = g.live, code = priv.coffre ? priv.coffre.code : [];
  const tries = l.rows.length, gain = win && l.paid ? r2(l.base * coffreMult(tries)) : 0;
  arcadeGain(st, gain, win ? 40 : 0);
  const record = win && (!g.best || tries < g.best);
  if (record) g.best = tries;
  g.live = null; priv.coffre = null;
  return { done: true, win, tries, gain, code, paid: l.paid, record, rows: l.rows };
}
function coffreGuess(st, priv, d) {
  const g = arcadeG(st, 'coffre');
  if (!g.live || !priv.coffre) fail('Aucun coffre en cours.');
  const guess = Array.isArray(d.guess) && d.guess.length === 4 ? d.guess.map(v => Math.floor(Number(v))) : fail('Choisissez 4 gemmes.');
  if (guess.some(v => !(v >= 0 && v < 6))) fail('Gemme inconnue.');
  const fb = coffreScore(guess, priv.coffre.code);
  g.live.rows.push({ g: guess, ...fb });
  if (fb.exact === 4) return coffreFinish(st, priv, true);
  if (g.live.rows.length >= 10) return coffreFinish(st, priv, false);
  return { done: false, ...fb };
}
function coffreGiveUp(st, priv) { if (!arcadeG(st, 'coffre').live) fail('Aucun coffre en cours.'); return coffreFinish(st, priv, false); }

const taquinMult = m => (m <= 50 ? 6 : m <= 70 ? 5 : m <= 90 ? 4 : m <= 120 ? 3 : m <= 160 ? 2 : 1);
const neighbors = i => [i - 3, i + 3, i % 3 ? i - 1 : -1, i % 3 < 2 ? i + 1 : -1].filter(j => j >= 0 && j < 9);
function taquinStart(st) {
  const g = arcadeG(st, 'taquin');
  if (g.live) fail('Un taquin est déjà en cours.');
  const paid = g.runs < ARCADE_RUNS;
  if (paid) g.runs++;
  let b = [1, 2, 3, 4, 5, 6, 7, 8, 0], z = 8, prev = -1;
  do { for (let i = 0; i < 60; i++) { const o = neighbors(z).filter(j => j !== prev); const j = o[rint(o.length)]; [b[z], b[j]] = [b[j], b[z]]; prev = z; z = j; } }
  while (b.join() === '1,2,3,4,5,6,7,8,0');
  g.live = { board: b, moves: 0, paid, base: logicBase('taquin') };
  return { board: b, paid };
}
function taquinFinish(st, win) {
  const g = arcadeG(st, 'taquin'), l = g.live;
  const gain = win && l.paid ? r2(l.base * taquinMult(l.moves)) : 0;
  arcadeGain(st, gain, win ? 40 : 0);
  const record = win && (!g.best || l.moves < g.best);
  if (record) g.best = l.moves;
  g.live = null;
  return { done: true, win, moves: l.moves, gain, paid: l.paid, record, board: l.board };
}
function taquinMove(st, priv, d) {
  const l = arcadeG(st, 'taquin').live || fail('Aucun taquin en cours.');
  const tile = Math.floor(Number(d.tile)), i = l.board.indexOf(tile), z = l.board.indexOf(0);
  if (!(tile >= 1 && tile <= 8) || !neighbors(z).includes(i)) fail('Mouvement impossible.');
  [l.board[i], l.board[z]] = [l.board[z], l.board[i]];
  l.moves++;
  if (l.board.join() === '1,2,3,4,5,6,7,8,0') return taquinFinish(st, true);
  return { done: false, moves: l.moves };
}
function taquinGiveUp(st) { if (!arcadeG(st, 'taquin').live) fail('Aucun taquin en cours.'); return taquinFinish(st, false); }

/* Table des actions que le site peut demander : nom -> fonction(st, priv, data, ev) */
const ACTIONS = {
  coin_play: coinPlay, plinko_drop: plinkoDrop, slots_spin: slotsSpin, wheel_spin: wheelSpin,
  scratch_buy: scratchBuy, scratch_done: scratchDone,
  mines_start: minesStart, mines_pick: minesPick, mines_cash: (st, priv, d, ev) => minesCash(st, priv, ev),
  hilo_start: hiloStart, hilo_guess: hiloGuess, hilo_cash: hiloCash,
  bj_deal: bjDeal, bj_hit: bjHit, bj_stand: bjStand, bj_double: bjDouble,
  clicks, upgrade_buy: upgradeBuy, boost_buy: boostBuy, boost_use: boostUse,
  goal_claim: goalClaim, daily_claim: dailyClaim, goals_claim_all: goalsClaimAll,
  pass_claim: passClaim, pass_claim_all: passClaimAll,
  shop_title: shopBuyTitle, shop_theme: shopBuyTheme,
  tir_start: tirStart, tir_end: tirEnd,
  coffre_start: coffreStart, coffre_guess: coffreGuess, coffre_giveup: coffreGiveUp,
  taquin_start: taquinStart, taquin_move: taquinMove, taquin_giveup: taquinGiveUp
};

module.exports = {
  Fail, fail, r2, ACTIONS, setSeasonSource, newState, normalize, snapshot, touch, ensureDay, arcadeRec,
  settle, credit, debit, readBet, bump, xpAdd, XP_TICKET, counts, accrue, offline, resolveActive,
  receiveSabotage, applyCosmetics, boostActive, malusOn, levelOf, parisDay
};
