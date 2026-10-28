const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.send('Cyber Casino : serveur en ligne'));
app.get('/health', (req, res) => res.json({ ok: true, round: round ? round.id : null, loto: loto ? loto.id : null }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ===================================================================
   OUTILS
   =================================================================== */
const round2 = n => Math.round(Number(n) * 100) / 100;
const floor2 = n => Math.floor(n * 100 + 1e-9) / 100;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const lower = s => String(s || '').toLowerCase();
const reply = ack => (typeof ack === 'function' ? ack : () => {});

/* Limiteur simple : true si l'action est autorisée */
function allow(socket, key, ms) {
  const now = Date.now();
  socket.data.last = socket.data.last || {};
  if (now - (socket.data.last[key] || 0) < ms) return false;
  socket.data.last[key] = now;
  return true;
}

/* ===================================================================
   JOUEURS CONNECTÉS
   =================================================================== */
const users = {}; // socket.id -> { username, balance, badge }

function onlineList() {
  const byName = new Map();
  for (const u of Object.values(users)) if (u.username) byName.set(lower(u.username), u);
  return [...byName.values()];
}
let listTimer = null;
function broadcastList() {
  if (listTimer) return;
  listTimer = setTimeout(() => { listTimer = null; io.emit('update_online_list', onlineList()); }, 250);
}
function socketIdsOf(name) {
  const n = lower(name);
  return Object.keys(users).filter(id => lower(users[id].username) === n);
}

/* ===================================================================
   HANDICAPS (les prix doivent correspondre à ceux du site)
   =================================================================== */
const SABOTAGES = { halve: { price: 100000 }, clicker: { price: 125000 }, noboost: { price: 150000 } };
const SABOTAGE_MAX = 3;                    // handicaps reçus au maximum par un même joueur…
const SABOTAGE_WINDOW_MS = 10 * 60 * 1000; // …sur 10 minutes
const sabotageLog = new Map();
const bigWins = [];                       // dernières grosses victoires, pour les nouveaux arrivants             // pseudo visé -> dates des handicaps reçus

/* ===================================================================
   AVIATEUR PARTAGÉ
   Le point de crash est tiré par le serveur à partir d'une graine secrète.
   L'empreinte SHA-256 de la graine est publiée avant la manche, la graine
   est révélée après le crash : chacun peut vérifier qu'elle n'a pas changé.
   =================================================================== */
const K = 0.09;          // vitesse de montée : multiplicateur = e^(K * secondes)
const BET_MS = 6000;     // durée des mises
const PAUSE_MS = 3000;   // pause après le crash
const TICK_MS = 50;
const HOUSE = 0.97;      // 3 % d'avantage maison
const MIN_BET = 1;

function pointFromSeed(seed) {
  const h = sha256('point:' + seed);
  const r = parseInt(h.slice(0, 13), 16) / 2 ** 52; // 52 bits -> [0, 1)
  return Math.min(10000, Math.max(1, Math.floor((100 * HOUSE) / (1 - r)) / 100));
}

let round = null;
let tickTimer = null;
const history = [];          // 20 dernières manches terminées
const results = new Map();   // "roundId:pseudo" -> résultat final, pour reprendre après rechargement

function publicRound() {
  return {
    id: round.id,
    hash: round.hash,
    phase: round.phase,
    betEndsAt: round.betEndsAt,
    startedAt: round.startedAt,
    point: round.phase === 'crashed' ? round.point : null,
    seed: round.phase === 'crashed' ? round.seed : null,
    serverNow: Date.now()
  };
}
function betList() {
  return [...round.bets.values()]
    .map(b => ({ username: b.username, amount: b.amount, cashedAt: b.cashedAt }))
    .sort((a, b) => b.amount - a.amount);
}
let betsTimer = null;
function broadcastBets() {
  if (betsTimer) return;
  betsTimer = setTimeout(() => { betsTimer = null; io.emit('crash_bets', betList()); }, 120);
}

function startBetting() {
  const seed = crypto.randomBytes(32).toString('hex');
  round = {
    id: crypto.randomBytes(5).toString('hex'),
    seed,
    hash: sha256(seed),
    point: pointFromSeed(seed),
    phase: 'betting',
    betEndsAt: Date.now() + BET_MS,
    startedAt: 0,
    bets: new Map() // pseudo en minuscules -> mise
  };
  io.emit('crash_betting', publicRound());
  io.emit('crash_bets', []);
  setTimeout(startRun, BET_MS);
}

function startRun() {
  round.phase = 'running';
  round.startedAt = Date.now();
  io.emit('crash_start', publicRound());
  tickTimer = setInterval(tick, TICK_MS);
}

const multAt = now => floor2(Math.exp((K * (now - round.startedAt)) / 1000));

function tick() {
  const m = multAt(Date.now());
  for (const b of round.bets.values()) {
    if (b.cashedAt == null && b.auto && b.auto <= round.point && m >= b.auto) cashout(b, b.auto);
  }
  if (m >= round.point) endRound();
}

function cashout(bet, mult) {
  bet.cashedAt = mult;
  bet.payout = round2(bet.amount * mult);
  io.to('u:' + lower(bet.username)).emit('crash_cashed', { roundId: round.id, mult, payout: bet.payout });
  broadcastBets();
}

function endRound() {
  clearInterval(tickTimer);
  round.phase = 'crashed';
  for (const [key, b] of round.bets) {
    results.set(`${round.id}:${key}`, b.cashedAt != null
      ? { status: 'cashed', mult: b.cashedAt, payout: b.payout }
      : { status: 'lost', point: round.point });
  }
  while (results.size > 5000) results.delete(results.keys().next().value);
  history.unshift({ id: round.id, point: round.point, seed: round.seed, hash: round.hash });
  history.length = Math.min(history.length, 20);
  io.emit('crash_end', publicRound());
  broadcastBets();
  setTimeout(startBetting, PAUSE_MS);
}

/* ===================================================================
   COURSE DE CHEVAUX PARTAGÉE
   Le serveur fixe les cotes, tire le gagnant et prépare le déroulé de la
   course (temps d'arrivée et accélérations), puis l'envoie à tout le monde :
   chaque joueur voit exactement la même course.
   =================================================================== */
const RACE_HORSES = 6;
const RACE_PROBS = [0.30, 0.22, 0.17, 0.13, 0.10, 0.08];
const RACE_EDGE = 0.96;          // 4 % d'avantage maison
const RACE_BET_MS = 20000;       // durée des paris
const RACE_RUN_MS = 9000;        // temps du gagnant
const RACE_PAUSE_MS = 7000;      // pause après l'arrivée
const RACE_MIN_BET = 1;
const rand = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48; // [0, 1) sur 48 bits

let race = null;
const raceHistory = [];          // derniers gagnants
const raceResults = new Map();   // "raceId:pseudo" -> résultat, pour reprendre après rechargement

function raceOdds(p) { return Math.floor((RACE_EDGE / p) * 10) / 10; }
function publicRace() {
  return {
    id: race.id, phase: race.phase, betEndsAt: race.betEndsAt, startedAt: race.startedAt,
    p: race.p, odds: race.odds, plan: race.phase === 'betting' ? null : race.plan,
    winner: race.phase === 'finished' ? race.winner : null,
    history: raceHistory.slice(0, 10), serverNow: Date.now()
  };
}
function raceBetList() {
  return [...race.bets.values()].map(b => ({ username: b.username, horse: b.horse, amount: b.amount })).sort((a, b) => b.amount - a.amount);
}
let raceBetsTimer = null;
function broadcastRaceBets() {
  if (raceBetsTimer) return;
  raceBetsTimer = setTimeout(() => { raceBetsTimer = null; io.emit('race_bets', raceBetList()); }, 150);
}
function startRaceBetting() {
  const perm = [0, 1, 2, 3, 4, 5];
  for (let i = perm.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const p = perm.map(i => RACE_PROBS[i]);
  race = {
    id: crypto.randomBytes(5).toString('hex'), phase: 'betting', betEndsAt: Date.now() + RACE_BET_MS, startedAt: 0,
    p, odds: p.map(raceOdds), bets: new Map(), plan: null, winner: null
  };
  io.emit('race_state', publicRace());
  io.emit('race_bets', []);
  setTimeout(startRaceRun, RACE_BET_MS);
}
function startRaceRun() {
  let x = rand(), winner = 0;
  while (winner < RACE_HORSES - 1 && x >= race.p[winner]) { x -= race.p[winner]; winner++; }
  race.winner = winner;
  race.plan = race.p.map((_, i) => {
    const finish = Math.round(i === winner ? RACE_RUN_MS : RACE_RUN_MS * (1.04 + rand() * 0.22));
    const w = Array.from({ length: 10 }, () => 0.55 + rand() * 0.9), sum = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    return { finish, marks: [0, ...w.map(v => Math.round((acc += v / sum) * 10000) / 10000)] };
  });
  race.plan.forEach(pl => { pl.marks[10] = 1; });
  race.phase = 'running';
  race.startedAt = Date.now();
  io.emit('race_state', publicRace());
  setTimeout(endRace, Math.max(...race.plan.map(pl => pl.finish)) + 300);
}
function endRace() {
  race.phase = 'finished';
  for (const [key, b] of race.bets) {
    const won = b.horse === race.winner;
    raceResults.set(`${race.id}:${key}`, { status: won ? 'won' : 'lost', horse: b.horse, amount: b.amount, odds: race.odds[b.horse], payout: won ? Math.round(b.amount * race.odds[b.horse] * 100) / 100 : 0, winner: race.winner });
  }
  while (raceResults.size > 5000) raceResults.delete(raceResults.keys().next().value);
  raceHistory.unshift(race.winner);
  raceHistory.length = Math.min(raceHistory.length, 20);
  io.emit('race_state', publicRace());
  setTimeout(startRaceBetting, RACE_PAUSE_MS);
}

/* ===================================================================
   LOTO QUOTIDIEN (tirage chaque soir à 21 h, heure de Paris)
   La cagnotte réunit 90 % des tickets et 1 000 $ offerts par le casino.
   Trois tickets sont tirés : 60 %, 25 % et 15 % de la cagnotte. Les parts
   non attribuées (moins de 3 tickets) sont reportées au tirage suivant.
   L'état est aussi écrit dans loto.json pour survivre à un redémarrage.
   =================================================================== */
const LOTO_PRICE = 100;
const LOTO_MAX_TICKETS = 20;      // par joueur et par tirage
const LOTO_SEED = 1000;           // offert par le casino à chaque tirage
const LOTO_SHARE = 0.9;           // part du prix des tickets reversée
const LOTO_PRIZES = [0.6, 0.25, 0.15];
const LOTO_HOUR = 21;             // heure du tirage, à Paris
const LOTO_FILE = path.join(__dirname, 'loto.json');

function parisOffsetMs(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
function parisDay(ts) {
  const l = new Date(ts + parisOffsetMs(new Date(ts)));
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}-${String(l.getUTCDate()).padStart(2, '0')}`;
}
function nextDrawAt(now = Date.now()) {
  if (process.env.LOTO_TEST_MS) return now + Number(process.env.LOTO_TEST_MS); // pour les tests uniquement
  const off = parisOffsetMs(new Date(now)), l = new Date(now + off);
  let t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), LOTO_HOUR) - off;
  if (t <= now) t += 24 * 3600 * 1000;
  return t;
}

let loto = null, lotoLast = null, lotoClaims = {};
function saveLoto() {
  fs.writeFile(LOTO_FILE, JSON.stringify({ loto, lotoLast, lotoClaims }), () => {});
}
function newLoto(carry) {
  const drawAt = nextDrawAt();
  // identifiant = date du tirage (un tirage par jour) ; en mode test, plusieurs tirages par jour
  const id = process.env.LOTO_TEST_MS ? `${parisDay(drawAt)}-${drawAt.toString(36)}` : parisDay(drawAt);
  loto = { id, drawAt, carry: round2(carry || 0), tickets: {} };
  saveLoto();
}
const lotoCount = () => Object.values(loto.tickets).reduce((s, t) => s + t.n, 0);
const lotoPot = () => round2(LOTO_SEED + loto.carry + lotoCount() * LOTO_PRICE * LOTO_SHARE);
function lotoPublic() {
  return {
    id: loto.id, drawAt: loto.drawAt, pot: lotoPot(), tickets: lotoCount(), price: LOTO_PRICE, max: LOTO_MAX_TICKETS,
    players: Object.values(loto.tickets).sort((a, b) => b.n - a.n).slice(0, 40).map(t => ({ username: t.username, n: t.n })),
    last: lotoLast, serverNow: Date.now()
  };
}
let lotoTimer = null;
function broadcastLoto() {
  if (lotoTimer) return;
  lotoTimer = setTimeout(() => { lotoTimer = null; io.emit('loto_state', lotoPublic()); }, 300);
}
function runDraw() {
  const entries = [];
  for (const [key, t] of Object.entries(loto.tickets)) for (let i = 0; i < t.n; i++) entries.push(key);
  for (let i = entries.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [entries[i], entries[j]] = [entries[j], entries[i]]; }
  const pot = lotoPot(), winners = [], results = {};
  let given = 0;
  for (const [key, t] of Object.entries(loto.tickets)) results[key] = { tickets: t.n, win: 0, claimed: false };
  LOTO_PRIZES.forEach((share, i) => {
    if (i >= entries.length) return;
    const key = entries[i], amount = round2(pot * share);
    given += amount;
    results[key].win = round2(results[key].win + amount);
    winners.push({ rank: i + 1, username: loto.tickets[key].username, amount });
  });
  lotoClaims[loto.id] = results;
  const ids = Object.keys(lotoClaims).sort();
  while (ids.length > 14) delete lotoClaims[ids.shift()];
  lotoLast = { id: loto.id, pot, tickets: entries.length, winners };
  const carry = entries.length ? round2(pot - given) : loto.carry; // sans ticket, les 1 000 $ offerts ne s'accumulent pas
  io.emit('loto_drawn', lotoLast);
  newLoto(carry);
  io.emit('loto_state', lotoPublic());
}
try {
  const saved = JSON.parse(fs.readFileSync(LOTO_FILE, 'utf8'));
  if (saved && saved.loto && saved.loto.id) { loto = saved.loto; lotoLast = saved.lotoLast || null; lotoClaims = saved.lotoClaims || {}; }
} catch {}
if (!loto) newLoto(0);
setInterval(() => { if (Date.now() >= loto.drawAt) runDraw(); }, 10000);

/* ===================================================================
   CONNEXIONS
   =================================================================== */
io.on('connection', socket => {
  socket.emit('crash_state', { ...publicRound(), history: history.slice(0, 14) });
  socket.emit('crash_bets', betList());
  socket.emit('race_state', publicRace());
  socket.emit('big_wins', bigWins);
  socket.emit('race_bets', raceBetList());
  socket.emit('loto_state', lotoPublic());
  socket.emit('update_online_list', onlineList());

  socket.on('time_sync', (_, ack) => reply(ack)(Date.now()));

  socket.on('user_join', data => {
    const username = clean(data && data.username, 24);
    if (!username) return;
    const prev = users[socket.id];
    if (prev && lower(prev.username) !== lower(username)) socket.leave('u:' + lower(prev.username));
    users[socket.id] = {
      username,
      balance: Math.max(0, Number(data.balance) || 0),
      badge: clean(data.badge, 20)
    };
    socket.join('u:' + lower(username));
    broadcastList();
  });

  socket.on('update_balance', data => {
    const u = users[socket.id];
    if (!u) return;
    u.balance = Math.max(0, Number(data && data.balance) || 0);
    u.badge = clean(data && data.badge, 20);
    broadcastList();
  });

  socket.on('send_message', data => {
    const u = users[socket.id];
    const text = clean(data && data.text, 200);
    if (!u || !text || !allow(socket, 'chat', 700)) return;
    io.emit('chat_message', { username: u.username, text, badge: u.badge });
  });

  socket.on('send_money', (data, ack) => {
    ack = reply(ack);
    const from = users[socket.id];
    if (!from) return ack({ ok: false, msg: 'Connectez-vous avant d’envoyer de l’argent.' });
    if (!allow(socket, 'money', 1500)) return ack({ ok: false, msg: 'Attendez un instant entre deux transferts.' });
    const amount = round2(data && data.amount);
    if (!Number.isFinite(amount) || amount < 1) return ack({ ok: false, msg: 'Montant minimum : 1,00 $.' });
    if (amount > from.balance + 0.001) return ack({ ok: false, msg: 'Solde insuffisant.' });
    const target = clean(data && data.targetUser, 24);
    if (lower(target) === lower(from.username)) return ack({ ok: false, msg: 'Vous ne pouvez pas vous envoyer de l’argent à vous-même.' });
    const ids = socketIdsOf(target);
    if (!ids.length) return ack({ ok: false, msg: `${target} n’est pas connecté.` });
    // Un seul onglet du destinataire reçoit l'argent, pour ne pas le créditer plusieurs fois
    io.to(ids[0]).emit('receive_money', { amount, from: from.username });
    from.balance = round2(from.balance - amount);
    broadcastList();
    ack({ ok: true, amount, to: users[ids[0]].username });
  });

  /* ----- Handicaps : un joueur en ralentit un autre ----- */
  socket.on('sabotage', (data, ack) => {
    ack = reply(ack);
    const from = users[socket.id];
    if (!from) return ack({ ok: false, msg: 'Connectez-vous avant d’envoyer un handicap.' });
    const item = SABOTAGES[clean(data && data.type, 20)];
    if (!item) return ack({ ok: false, msg: 'Handicap inconnu.' });
    if (!allow(socket, 'sabotage', 3000)) return ack({ ok: false, msg: 'Attendez quelques secondes entre deux handicaps.' });
    if (from.balance + 0.001 < item.price) return ack({ ok: false, msg: 'Solde insuffisant.' });
    const target = clean(data && data.targetUser, 24);
    if (!target || lower(target) === lower(from.username)) return ack({ ok: false, msg: 'Choisissez un autre joueur que vous-même.' });
    const ids = socketIdsOf(target);
    if (!ids.length) return ack({ ok: false, msg: `${target} n’est plus connecté.` });
    const key = lower(target), now = Date.now();
    const log = (sabotageLog.get(key) || []).filter(t => now - t < SABOTAGE_WINDOW_MS);
    if (log.length >= SABOTAGE_MAX) {
      const wait = Math.ceil((SABOTAGE_WINDOW_MS - (now - log[0])) / 60000);
      return ack({ ok: false, msg: `${users[ids[0]].username} a déjà reçu ${SABOTAGE_MAX} handicaps récemment. Réessayez dans ${wait} min.` });
    }
    log.push(now);
    sabotageLog.set(key, log);
    // Un seul onglet du joueur visé reçoit le handicap, pour ne pas l'appliquer plusieurs fois
    io.to(ids[0]).emit('sabotaged', { type: data.type, from: from.username });
    from.balance = round2(from.balance - item.price);
    broadcastList();
    ack({ ok: true, to: users[ids[0]].username });
  });

  /* ----- Grosses victoires annoncées à tout le monde ----- */
  socket.on('big_win', data => {
    const u = users[socket.id];
    if (!u || !allow(socket, 'bigwin', 4000)) return;
    const amount = round2(data && data.amount), mult = Math.round(Number(data && data.mult) * 100) / 100;
    if (!(amount >= 500) || !(amount < 1e13)) return;
    const win = { username: u.username, game: clean(data.game, 24), amount, mult: Number.isFinite(mult) ? mult : 0, at: Date.now() };
    bigWins.unshift(win);
    bigWins.length = Math.min(bigWins.length, 10);
    io.emit('big_win', win);
  });

  socket.on('place_bet', data => {
    const u = users[socket.id];
    if (!u || !allow(socket, 'bet', 300)) return;
    const amount = round2(data && data.amount);
    if (!(amount > 0)) return;
    io.emit('live_bet', { username: u.username, game: clean(data.game, 20), amount });
  });

  /* ----- Aviateur ----- */
  socket.on('crash_bet', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Connectez-vous avant de miser.' });
    if (round.phase !== 'betting') return ack({ ok: false, msg: 'Les mises sont fermées pour cette manche.' });
    const key = lower(u.username);
    if (round.bets.has(key)) return ack({ ok: false, msg: 'Vous avez déjà misé sur cette manche.' });
    const amount = round2(data && data.amount);
    if (!Number.isFinite(amount) || amount < MIN_BET) return ack({ ok: false, msg: `Mise minimum : ${MIN_BET} $.` });
    if (amount > u.balance + 0.001) return ack({ ok: false, msg: 'Solde insuffisant.' });
    let auto = Number(data && data.auto);
    auto = Number.isFinite(auto) && auto >= 1.01 ? floor2(Math.min(auto, 10000)) : 0;
    round.bets.set(key, { username: u.username, amount, auto, cashedAt: null, payout: 0 });
    broadcastBets();
    ack({ ok: true, roundId: round.id, amount, auto });
  });

  socket.on('crash_cancel', (_, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Non connecté.' });
    if (round.phase !== 'betting') return ack({ ok: false, msg: 'Trop tard : l’avion a décollé.' });
    const key = lower(u.username), b = round.bets.get(key);
    if (!b) return ack({ ok: false, msg: 'Aucune mise à annuler.' });
    round.bets.delete(key);
    broadcastBets();
    ack({ ok: true, amount: b.amount });
  });

  socket.on('crash_cashout', (_, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Non connecté.' });
    if (round.phase !== 'running') return ack({ ok: false, msg: 'Trop tard : l’avion a crashé.' });
    const b = round.bets.get(lower(u.username));
    if (!b || b.cashedAt != null) return ack({ ok: false, msg: 'Aucune mise en vol.' });
    const m = multAt(Date.now());
    if (m >= round.point) return ack({ ok: false, msg: 'Trop tard : l’avion a crashé.' });
    cashout(b, m);
    ack({ ok: true, mult: m, payout: b.payout });
  });

  // Après un rechargement de page : que s'est-il passé pour ma mise ?
  socket.on('crash_result', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ status: 'unknown' });
    const roundId = clean(data && data.roundId, 20), key = lower(u.username);
    if (round.id === roundId && round.bets.has(key) && round.phase !== 'crashed') {
      const b = round.bets.get(key);
      if (b.cashedAt != null) return ack({ status: 'cashed', mult: b.cashedAt, payout: b.payout });
      return ack({ status: 'active', amount: b.amount, auto: b.auto });
    }
    ack(results.get(`${roundId}:${key}`) || { status: 'unknown' });
  });

  /* ----- Loto quotidien ----- */
  socket.on('loto_buy', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Connectez-vous avant d’acheter des tickets.' });
    if (!allow(socket, 'loto', 800)) return ack({ ok: false, msg: 'Doucement : un achat à la fois.' });
    const count = Math.floor(Number(data && data.count));
    if (!(count >= 1 && count <= LOTO_MAX_TICKETS)) return ack({ ok: false, msg: 'Nombre de tickets invalide.' });
    const key = lower(u.username), cur = loto.tickets[key] ? loto.tickets[key].n : 0;
    if (cur + count > LOTO_MAX_TICKETS) return ack({ ok: false, msg: `${LOTO_MAX_TICKETS} tickets au maximum par tirage (vous en avez ${cur}).` });
    const cost = count * LOTO_PRICE;
    if (cost > u.balance + 0.001) return ack({ ok: false, msg: 'Solde insuffisant.' });
    loto.tickets[key] = { username: u.username, n: cur + count };
    u.balance = round2(u.balance - cost);
    saveLoto();
    broadcastLoto();
    ack({ ok: true, drawId: loto.id, count, total: cur + count, cost });
  });

  socket.on('loto_result', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false });
    const id = clean(data && data.drawId, 24), key = lower(u.username);
    if (id === loto.id) return ack({ status: 'open' });
    const r = lotoClaims[id] && lotoClaims[id][key];
    if (!r) return ack({ status: 'unknown' });
    if (r.claimed) return ack({ status: 'claimed' });
    r.claimed = true;
    saveLoto();
    ack({ status: 'drawn', win: r.win, tickets: r.tickets });
  });

  /* ----- Course de chevaux ----- */
  socket.on('race_bet', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Connectez-vous avant de parier.' });
    if (race.phase !== 'betting') return ack({ ok: false, msg: 'Les paris sont fermés pour cette course.' });
    const key = lower(u.username);
    if (race.bets.has(key)) return ack({ ok: false, msg: 'Vous avez déjà parié sur cette course.' });
    const horse = Number(data && data.horse);
    if (!Number.isInteger(horse) || horse < 0 || horse >= RACE_HORSES) return ack({ ok: false, msg: 'Cheval inconnu.' });
    const amount = round2(data && data.amount);
    if (!Number.isFinite(amount) || amount < RACE_MIN_BET) return ack({ ok: false, msg: `Mise minimum : ${RACE_MIN_BET} $.` });
    if (amount > u.balance + 0.001) return ack({ ok: false, msg: 'Solde insuffisant.' });
    race.bets.set(key, { username: u.username, horse, amount });
    broadcastRaceBets();
    ack({ ok: true, raceId: race.id, horse, amount, odds: race.odds[horse] });
  });

  socket.on('race_cancel', (_, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Non connecté.' });
    if (race.phase !== 'betting') return ack({ ok: false, msg: 'Trop tard : la course est partie.' });
    const key = lower(u.username), b = race.bets.get(key);
    if (!b) return ack({ ok: false, msg: 'Aucun pari à annuler.' });
    race.bets.delete(key);
    broadcastRaceBets();
    ack({ ok: true, amount: b.amount });
  });

  socket.on('race_result', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ status: 'unknown' });
    const raceId = clean(data && data.raceId, 20), key = lower(u.username);
    if (race.id === raceId && race.bets.has(key) && race.phase !== 'finished') {
      const b = race.bets.get(key);
      return ack({ status: 'active', horse: b.horse, amount: b.amount, odds: race.odds[b.horse] });
    }
    ack(raceResults.get(`${raceId}:${key}`) || { status: 'unknown' });
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    broadcastList();
    // Les mises en cours restent actives : l'encaissement automatique fonctionne même hors ligne.
  });
});

startBetting();
startRaceBetting();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur en écoute sur le port ${PORT}`));
