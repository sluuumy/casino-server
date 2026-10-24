const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.send('Cyber Casino : serveur en ligne'));
app.get('/health', (req, res) => res.json({ ok: true, round: round ? round.id : null }));

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
const sabotageLog = new Map();             // pseudo visé -> dates des handicaps reçus

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
const MIN_BET = 10;

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
   CONNEXIONS
   =================================================================== */
io.on('connection', socket => {
  socket.emit('crash_state', { ...publicRound(), history: history.slice(0, 14) });
  socket.emit('crash_bets', betList());
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

  socket.on('disconnect', () => {
    delete users[socket.id];
    broadcastList();
    // Les mises en cours restent actives : l'encaissement automatique fonctionne même hors ligne.
  });
});

startBetting();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur en écoute sur le port ${PORT}`));
