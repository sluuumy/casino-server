const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.send('Carat : serveur en ligne'));
app.get('/health', (req, res) => res.json({ ok: true, round: round ? round.id : null, loto: loto ? loto.id : null, season: season ? season.num : null }));

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
const bigWins = [];
const plinkoBig = [];                      // (ancienne version du site, plus utilisé)
const hourWins = [];                       // gains de la dernière heure, tous jeux et tous joueurs
const HOUR_MS = 3600 * 1000;
let lastTopJson = '';
function topHour() {
  const since = Date.now() - HOUR_MS;
  while (hourWins.length && hourWins[0].at < since) hourWins.shift(); // la liste est dans l'ordre d'arrivée
  return hourWins.slice().sort((a, b) => b.amount - a.amount).slice(0, 10);
}
let topTimer = null;
function broadcastTop(force) {
  if (topTimer) return;
  topTimer = setTimeout(() => {
    topTimer = null;
    const top = topHour(), json = JSON.stringify(top);
    if (force || json !== lastTopJson) { lastTopJson = json; io.emit('top_hour', top); }
  }, 800);
}
setInterval(() => broadcastTop(false), 60 * 1000); // les gains de plus d'une heure sortent du classement                       // dernières grosses victoires, pour les nouveaux arrivants             // pseudo visé -> dates des handicaps reçus

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
   DUELS : deux joueurs misent la même somme, le serveur tire le gagnant
   (50/50, aléatoire cryptographique) qui remporte la mise de l'autre.
   =================================================================== */
const DUEL_MIN = 1;
const DUEL_MAX_OPEN = 3;              // défis ouverts au maximum par joueur
const DUEL_TTL = 5 * 60 * 1000;       // un défi non accepté expire après 5 minutes
const duels = new Map();              // id -> défi ouvert
const duelResults = new Map();        // id -> résultat ou annulation, pour reprendre après rechargement
const money2 = n => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\u00a0$';

function duelList() {
  return [...duels.values()].sort((a, b) => b.at - a.at).map(d => ({ id: d.id, from: d.from, to: d.toName || null, amount: d.amount, at: d.at }));
}
let duelTimer = null;
function broadcastDuels() {
  if (duelTimer) return;
  duelTimer = setTimeout(() => { duelTimer = null; io.emit('duel_list', duelList()); }, 150);
}
function closeDuel(id, status) {
  const d = duels.get(id);
  if (!d) return;
  duels.delete(id);
  duelResults.set(id, { id, status, amount: d.amount });
  io.to('u:' + d.fromKey).emit('duel_closed', { id, status, amount: d.amount });
  broadcastDuels();
}
function keepResults() { while (duelResults.size > 3000) duelResults.delete(duelResults.keys().next().value); }
setInterval(() => {
  const now = Date.now();
  for (const d of [...duels.values()]) if (now - d.at > DUEL_TTL) closeDuel(d.id, 'expired');
}, 15000);

/* ===================================================================
   COMPTES EN LIGNE
   Pseudo, mot de passe (haché avec scrypt) et progression complète.
   Stockage : MongoDB Atlas si la variable MONGODB_URI est définie (recommandé,
   permanent), sinon un fichier accounts.json (pratique pour tester, mais effacé
   par Render gratuit à chaque mise en veille).
   =================================================================== */
const NAME_RE = /^[\p{L}\p{N}_.\-]{3,16}$/u;
const MAX_STATE_BYTES = 400 * 1024;
const accounts = new Map();             // pseudo en minuscules -> compte (cache)
let mongo = null;                       // collection MongoDB si configurée
let mongoDb = null;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

async function initAccounts() {
  if (process.env.MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      mongoDb = client.db(process.env.MONGODB_DB || 'emeraude');
      mongo = mongoDb.collection('accounts');
      console.log('Comptes : MongoDB connecté');
      return;
    } catch (e) { console.error('MongoDB indisponible, repli sur le fichier :', e.message); mongo = null; }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const a of saved) accounts.set(a._id, a);
  } catch {}
  console.log(`Comptes : fichier local (${accounts.size} comptes). Définissez MONGODB_URI pour un stockage permanent.`);
}
async function getAccount(key) {
  if (accounts.has(key)) return accounts.get(key);
  if (!mongo) return null;
  const a = await mongo.findOne({ _id: key });
  if (a) accounts.set(key, a);
  return a;
}
// Écriture au plus une fois par seconde, mais toujours effectuée : un joueur qui joue sans arrêt
// ne doit pas repousser indéfiniment la sauvegarde.
const dirty = new Set();
let flushTimer = null;
function persist(a) {
  accounts.set(a._id, a);
  dirty.add(a._id);
  if (!flushTimer) flushTimer = setTimeout(flushAccounts, 1000);
}
function removeAccount(key) { // supprime un compte (invité transformé, ou invité inactif)
  accounts.delete(key);
  dirty.delete(key);
  if (mongo) mongo.deleteOne({ _id: key }).catch(e => console.error('Suppression impossible :', e.message));
  else { if (!flushTimer) flushTimer = setTimeout(flushAccounts, 1000); }
}
async function flushAccounts() {
  flushTimer = null;
  const ids = [...dirty];
  dirty.clear();
  if (!ids.length && mongo) return;
  if (mongo) {
    await Promise.all(ids.map(id => mongo.replaceOne({ _id: id }, accounts.get(id), { upsert: true })
      .catch(e => { console.error('Sauvegarde du compte impossible :', e.message); dirty.add(id); })));
    if (dirty.size && !flushTimer) flushTimer = setTimeout(flushAccounts, 5000); // nouvel essai
  } else {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([...accounts.values()]));
  }
}
// Render arrête le serveur avec SIGTERM (mise en veille, redéploiement) : on enregistre tout avant de partir
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, async () => {
  clearTimeout(flushTimer);
  try { await flushAccounts(); } catch {}
  process.exit(0);
}));
const scryptHash = (pw, salt) => new Promise((res, rej) => crypto.scrypt(String(pw), salt, 32, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
const tokenHash = t => sha256('tok:' + t);
function newToken(a) {
  const t = crypto.randomBytes(32).toString('hex');
  a.tokens = (a.tokens || []).filter(x => Date.now() - x.at < 90 * 24 * 3600 * 1000).slice(-4); // 5 appareils retenus au maximum, 90 jours
  a.tokens.push({ t: tokenHash(t), at: Date.now() });
  return t;
}
function cleanState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const json = JSON.stringify(state);
  return json.length <= MAX_STATE_BYTES ? JSON.parse(json) : null;
}
const loginFails = new Map(); // pseudo -> tentatives ratées récentes (anti force brute)
function tooManyFails(key) {
  const l = (loginFails.get(key) || []).filter(t => Date.now() - t < 10 * 60 * 1000);
  loginFails.set(key, l);
  return l.length >= 8;
}
/* Associe la connexion au compte ; les autres appareils ouverts sur ce compte sont déconnectés */
function bindAccount(socket, a) {
  socket.data.account = a._id;
  socket.data.active = true;
  for (const [id, s] of io.of('/').sockets) {
    if (id !== socket.id && s.data.account === a._id && s.data.active) {
      s.data.active = false;
      s.emit('session_replaced');
    }
  }
}
function publicAccount(a, token) {
  // une progression d'une saison passée n'est jamais renvoyée
  if (a.state && season && Number(a.state.season) !== season.num) { a.state = null; persist(a); }
  return { ok: true, username: a.username, token, state: a.state || null, savedAt: a.savedAt || 0, heritage: a.heritage || [], season: season ? season.num : 0, guest: !!a.guest };
}

/* ===================================================================
   SAISONS (configuration dans saisons.js)
   À la fin d'une saison : classement final archivé dans le Panthéon,
   titres d'Héritage attribués, puis remise à zéro de tous les comptes.
   =================================================================== */
const Seasons = require('./saisons');
const SEASON_FILE = path.join(__dirname, 'season.json');
let metaCol = null;      // collection MongoDB « meta » si configurée
let season = null;       // { num, startAt, endAt }
let hall = [];           // Panthéon : une entrée par saison terminée

function seasonEnd(startAt) { // un mois plus tard, à minuit heure de Paris
  if (process.env.SEASON_TEST_MS) return startAt + Number(process.env.SEASON_TEST_MS); // pour les tests uniquement
  const l = new Date(startAt + parisOffsetMs(new Date(startAt)));
  const guess = Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 1, Math.min(l.getUTCDate(), 28));
  return guess - parisOffsetMs(new Date(guess));
}
function publicSeason() {
  return season && { num: season.num, startAt: season.startAt, endAt: season.endAt, config: Seasons.seasonConfig(season.num), hall: hall.slice(0, 12), serverNow: Date.now() };
}
async function saveMeta() {
  const doc = { _id: 'season', season, hall };
  if (metaCol) await metaCol.replaceOne({ _id: 'season' }, doc, { upsert: true });
  else fs.writeFileSync(SEASON_FILE, JSON.stringify(doc));
}
async function allAccounts() {
  if (mongo) { const list = await mongo.find({}).toArray(); list.forEach(a => { if (!accounts.has(a._id)) accounts.set(a._id, a); }); }
  return [...accounts.values()];
}
const levelOf = state => Seasons.levelFromXp(Number(state && state.xp) || 0);
function addHeritage(a, tag, label, num, id) {
  a.heritage = a.heritage || [];
  if (!a.heritage.some(h => h.id === id)) a.heritage.push({ id, tag, label, season: num, at: Date.now() });
}
/* Clôture une saison (ou la bêta, num = 0) : classement, titres, remise à zéro */
async function closeSeason(num, name) {
  const all = await allAccounts();
  const players = all.filter(a => a.state && (num === 0 || Number(a.state.season) === num) && (Number(a.state.gamesPlayed) > 0 || Number(a.state.totalClicks) > 0));
  const ranked = players.slice().sort((x, y) => (Number(y.state.balance) || 0) - (Number(x.state.balance) || 0));
  const short = num === 0 ? 'BÊTA' : `S${num}`, long = num === 0 ? 'de la bêta' : `de la saison ${num}`;
  ranked.forEach((a, i) => {
    if (num === 0) addHeritage(a, 'PIONNIER BÊTA', 'Pionnier de la bêta', 0, 'beta');
    else addHeritage(a, `JOUEUR ${short}`, `Joueur ${long}`, num, `s${num}-joueur`);
    if (i === 0) addHeritage(a, `CHAMPION ${short}`, `Champion ${long}`, num, `s${num}-champion`);
    else if (i < 3) addHeritage(a, `PODIUM ${short}`, `Podium ${long}`, num, `s${num}-podium`);
    else if (i < 10) addHeritage(a, `TOP 10 ${short}`, `Top 10 ${long}`, num, `s${num}-top10`);
    const lvl = levelOf(a.state);
    if (lvl >= Seasons.MAX_LEVEL) addHeritage(a, `VÉTÉRAN ${short}`, `Niveau ${Seasons.MAX_LEVEL} ${long}`, num, `s${num}-veteran`);
    else if (num > 0 && lvl >= Seasons.PRESTIGE_LEVEL) addHeritage(a, `PRESTIGE ${short}`, `Piste Prestige ${long}`, num, `s${num}-prestige`);
  });
  if (num === 0) all.forEach(a => addHeritage(a, 'PIONNIER BÊTA', 'Pionnier de la bêta', 0, 'beta')); // tous les comptes de la bêta
  hall.unshift({ num, name, endedAt: Date.now(), players: players.length,
    top: ranked.slice(0, 10).map(a => ({ username: a.username, balance: Math.round((Number(a.state.balance) || 0) * 100) / 100, level: levelOf(a.state) })) });
  hall.length = Math.min(hall.length, 36);
  const next = num + 1;
  all.forEach(a => {
    if (a.guest && Date.now() - (a.savedAt || a.created || 0) > 30 * 24 * 3600 * 1000) return removeAccount(a._id);
    a.state = null; a.savedAt = Date.now(); a.season = next; persist(a);
  });
  return next;
}
async function initSeasons() {
  try {
    if (mongoDb) { metaCol = mongoDb.collection('meta'); const doc = await metaCol.findOne({ _id: 'season' }); if (doc) { season = doc.season; hall = doc.hall || []; } }
    else { const doc = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); season = doc.season; hall = doc.hall || []; }
  } catch {}
  if (!season) { // première mise en ligne des saisons : la bêta se termine, la saison 1 commence
    const next = await closeSeason(0, 'Bêta');
    const now = Date.now();
    season = { num: next, startAt: now, endAt: seasonEnd(now) };
    await saveMeta();
    console.log(`Saison ${season.num} lancée : fin le ${new Date(season.endAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  }
  setInterval(checkSeason, process.env.SEASON_TEST_MS ? 2000 : 30000);
  io.emit('season_info', publicSeason());
}
let rolling = false;
async function checkSeason() {
  if (!season || rolling || Date.now() < season.endAt) return;
  rolling = true;
  try {
    const ended = season, cfg = Seasons.seasonConfig(ended.num);
    const next = await closeSeason(ended.num, cfg.name);
    season = { num: next, startAt: ended.endAt, endAt: seasonEnd(Math.max(ended.endAt, Date.now())) };
    await saveMeta();
    console.log(`Saison ${ended.num} terminée, saison ${season.num} lancée`);
    io.emit('season_changed', publicSeason());
  } catch (e) { console.error('Changement de saison impossible :', e.message); }
  rolling = false;
}

/* ===================================================================
   CONNEXIONS
   =================================================================== */
io.on('connection', socket => {
  socket.emit('crash_state', { ...publicRound(), history: history.slice(0, 14) });
  socket.emit('crash_bets', betList());
  socket.emit('race_state', publicRace());
  socket.emit('big_wins', bigWins);
  socket.emit('top_hour', topHour());
  socket.emit('duel_list', duelList());
  if (season) socket.emit('season_info', publicSeason());
  socket.emit('race_bets', raceBetList());
  socket.emit('loto_state', lotoPublic());
  socket.emit('update_online_list', onlineList());

  socket.on('time_sync', (_, ack) => reply(ack)(Date.now()));

  socket.on('user_join', data => {
    const acct = socket.data.account && socket.data.active ? accounts.get(socket.data.account) : null;
    const username = acct ? acct.username : clean(data && data.username, 24);
    if (!acct) return; // tous les joueurs ont un compte sur le serveur (même les invités)
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

  /* ----- Gains de la dernière heure (top 10 de l'accueil) ----- */
  socket.on('game_win', data => {
    const u = users[socket.id];
    if (!u || !allow(socket, 'gamewin', 120)) return;
    const amount = round2(data && data.amount), mult = Math.round(Number(data && data.mult) * 100) / 100;
    if (!(amount > 0 && amount < 1e13)) return;
    hourWins.push({ username: u.username, game: clean(data.game, 24), amount, mult: Number.isFinite(mult) ? mult : 0, at: Date.now() });
    if (hourWins.length > 20000) hourWins.splice(0, hourWins.length - 20000);
    broadcastTop(false);
  });

  /* ----- Gros multiplicateurs du Plinko, partagés ----- */
  socket.on('plinko_big', data => {
    const u = users[socket.id];
    if (!u || !allow(socket, 'plinkobig', 300)) return;
    const mult = Number(data && data.mult), rows = Number(data && data.rows), risk = clean(data && data.risk, 10);
    if (!(mult >= 10 && mult <= 1000) || ![8, 12, 16].includes(rows) || !['faible', 'moyen', 'eleve'].includes(risk)) return;
    const hit = { username: u.username, mult, rows, risk, bet: round2(data.bet), win: round2(data.win), at: Date.now() };
    plinkoBig.unshift(hit);
    plinkoBig.length = Math.min(plinkoBig.length, 20);
    io.emit('plinko_big', hit);
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

  /* ----- Comptes ----- */
  socket.on('account_register', async (data, ack) => {
    ack = reply(ack);
    if (!allow(socket, 'register', 1000)) return ack({ ok: false, msg: 'Doucement : réessayez dans une seconde.' });
    const username = String((data && data.username) || '').replace(/\s+/g, ' ').trim(), pw = String((data && data.password) || '');
    if (!NAME_RE.test(username)) return ack({ ok: false, msg: 'Pseudo invalide : 3 à 16 lettres, chiffres, point, tiret ou tiret bas.' });
    if (/^invit/i.test(username)) return ack({ ok: false, msg: 'Les pseudos commençant par « Invité » sont réservés.' });
    if (pw.length < 6 || pw.length > 200) return ack({ ok: false, msg: 'Mot de passe : 6 caractères minimum.' });
    const key = lower(username);
    if (await getAccount(key)) return ack({ ok: false, code: 'taken', msg: 'Ce pseudo est déjà pris.' });
    const salt = crypto.randomBytes(16).toString('hex');
    if (!season) return ack({ ok: false, msg: 'Le serveur démarre : réessayez dans quelques secondes.' });
    let state = cleanState(data && data.state);
    if (state && Number(state.season) !== season.num) state = null; // progression d'une autre saison : on repart de zéro
    const a = { _id: key, username, salt, hash: await scryptHash(pw, salt), state, savedAt: state ? Number(state.savedAt) || Date.now() : 0,
      created: Date.now(), imported: !!(data && data.imported), tokens: [], heritage: [], season: season.num };
    if (a.imported) addHeritage(a, 'PIONNIER BÊTA', 'Pionnier de la bêta', 0, 'beta');
    const token = newToken(a);
    persist(a);
    bindAccount(socket, a);
    ack(publicAccount(a, token));
  });

  socket.on('account_login', async (data, ack) => {
    ack = reply(ack);
    if (!allow(socket, 'auth', 1000)) return ack({ ok: false, msg: 'Doucement : réessayez dans une seconde.' });
    const key = lower(String((data && data.username) || '').trim()), pw = String((data && data.password) || '');
    if (tooManyFails(key)) return ack({ ok: false, msg: 'Trop de tentatives : réessayez dans quelques minutes.' });
    const a = await getAccount(key);
    if (!a) return ack({ ok: false, code: 'not_found', msg: 'Pseudo ou mot de passe incorrect.' });
    if (a.guest || await scryptHash(pw, a.salt) !== a.hash) { loginFails.get(key).push(Date.now()); return ack({ ok: false, msg: 'Pseudo ou mot de passe incorrect.' }); }
    const token = newToken(a);
    persist(a);
    bindAccount(socket, a);
    ack(publicAccount(a, token));
  });

  socket.on('account_resume', async (data, ack) => { // reconnexion automatique avec le jeton de l'appareil
    ack = reply(ack);
    const key = lower(String((data && data.username) || '')), t = String((data && data.token) || '');
    const a = key && t ? await getAccount(key) : null;
    if (!a || !(a.tokens || []).some(x => x.t === tokenHash(t))) return ack({ ok: false, code: 'invalid', msg: 'Session expirée : reconnectez-vous.' });
    bindAccount(socket, a);
    ack(publicAccount(a, t));
  });

  socket.on('account_save', (data, ack) => {
    ack = reply(ack);
    const a = socket.data.account && accounts.get(socket.data.account);
    if (!a) return ack({ ok: false, code: 'auth' });
    if (!socket.data.active) return ack({ ok: false, code: 'replaced' });
    const state = cleanState(data && data.state);
    if (!state) return ack({ ok: false, msg: 'Sauvegarde trop volumineuse ou invalide.' });
    if (season && Number(state.season) !== season.num) return ack({ ok: false, code: 'season' }); // partie d'une saison terminée
    a.state = state;
    a.savedAt = Number(state.savedAt) || Date.now();
    persist(a);
    ack({ ok: true, savedAt: a.savedAt });
  });

  socket.on('account_logout', (data, ack) => {
    ack = reply(ack);
    const a = socket.data.account && accounts.get(socket.data.account), t = String((data && data.token) || '');
    if (a && t) { a.tokens = (a.tokens || []).filter(x => x.t !== tokenHash(t)); persist(a); }
    socket.data.account = null; socket.data.active = false;
    ack({ ok: true });
  });

  socket.on('account_password', async (data, ack) => {
    ack = reply(ack);
    const a = socket.data.account && accounts.get(socket.data.account);
    if (!a || !socket.data.active) return ack({ ok: false, msg: 'Connectez-vous d’abord.' });
    if (!allow(socket, 'auth', 1000)) return ack({ ok: false, msg: 'Doucement : réessayez dans une seconde.' });
    if (await scryptHash(String((data && data.old) || ''), a.salt) !== a.hash) return ack({ ok: false, msg: 'Mot de passe actuel incorrect.' });
    const pw = String((data && data.password) || '');
    if (pw.length < 6 || pw.length > 200) return ack({ ok: false, msg: 'Nouveau mot de passe : 6 caractères minimum.' });
    a.salt = crypto.randomBytes(16).toString('hex');
    a.hash = await scryptHash(pw, a.salt);
    const token = newToken(a); a.tokens = a.tokens.slice(-1); // les autres appareils devront se reconnecter
    persist(a);
    ack({ ok: true, token });
  });

  /* ----- Invités : comptes temporaires sur le serveur, transformables en vrais comptes ----- */
  socket.on('account_guest', async (data, ack) => {
    ack = reply(ack);
    if (!allow(socket, 'register', 1000)) return ack({ ok: false, msg: 'Doucement : réessayez dans une seconde.' });
    if (!season) return ack({ ok: false, msg: 'Le serveur démarre : réessayez dans quelques secondes.' });
    let username = '', key = '';
    for (let i = 0; i < 20; i++) {
      username = 'Invité_' + crypto.randomInt(100000, 1000000);
      key = lower(username);
      if (!(await getAccount(key))) break;
    }
    const a = { _id: key, username, guest: true, salt: '', hash: '', state: null, savedAt: 0, created: Date.now(), tokens: [], heritage: [], season: season.num };
    const token = newToken(a);
    persist(a);
    bindAccount(socket, a);
    ack(publicAccount(a, token));
  });

  socket.on('account_claim', async (data, ack) => { // un invité choisit un pseudo et un mot de passe : sa partie est conservée
    ack = reply(ack);
    const g = socket.data.account && accounts.get(socket.data.account);
    if (!g || !g.guest || !socket.data.active) return ack({ ok: false, msg: 'Aucune partie invité à transférer.' });
    if (!allow(socket, 'register', 1000)) return ack({ ok: false, msg: 'Doucement : réessayez dans une seconde.' });
    const username = String((data && data.username) || '').replace(/\s+/g, ' ').trim(), pw = String((data && data.password) || '');
    if (!NAME_RE.test(username)) return ack({ ok: false, msg: 'Pseudo invalide : 3 à 16 lettres, chiffres, point, tiret ou tiret bas.' });
    if (/^invit/i.test(username)) return ack({ ok: false, msg: 'Les pseudos commençant par « Invité » sont réservés.' });
    if (pw.length < 6 || pw.length > 200) return ack({ ok: false, msg: 'Mot de passe : 6 caractères minimum.' });
    const key = lower(username);
    if (await getAccount(key)) return ack({ ok: false, code: 'taken', msg: 'Ce pseudo est déjà pris.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const a = { _id: key, username, salt, hash: await scryptHash(pw, salt), state: g.state, savedAt: g.savedAt, created: Date.now(), tokens: [], heritage: g.heritage || [], season: g.season };
    const token = newToken(a);
    persist(a);
    removeAccount(g._id);
    bindAccount(socket, a);
    const u = users[socket.id];
    if (u) { socket.leave('u:' + lower(u.username)); delete users[socket.id]; broadcastList(); }
    ack(publicAccount(a, token));
  });

  /* ----- Duels ----- */
  socket.on('duel_create', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Connectez-vous avant de lancer un duel.' });
    if (!allow(socket, 'duel', 1500)) return ack({ ok: false, msg: 'Attendez un instant entre deux défis.' });
    const amount = round2(data && data.amount), key = lower(u.username);
    if (!Number.isFinite(amount) || amount < DUEL_MIN) return ack({ ok: false, msg: `Mise minimum : ${DUEL_MIN} $.` });
    if (amount > u.balance + 0.001) return ack({ ok: false, msg: 'Solde insuffisant.' });
    if ([...duels.values()].filter(d => d.fromKey === key).length >= DUEL_MAX_OPEN) return ack({ ok: false, msg: `${DUEL_MAX_OPEN} défis ouverts au maximum.` });
    let toKey = null, toName = null;
    const target = clean(data && data.target, 24);
    if (target) {
      const ids = socketIdsOf(target);
      if (!ids.length) return ack({ ok: false, msg: `${target} n’est pas connecté.` });
      if (lower(target) === key) return ack({ ok: false, msg: 'Vous ne pouvez pas vous défier vous-même.' });
      toKey = lower(target); toName = users[ids[0]].username;
    }
    const d = { id: crypto.randomBytes(6).toString('hex'), from: u.username, fromKey: key, toKey, toName, amount, at: Date.now() };
    duels.set(d.id, d);
    u.balance = round2(u.balance - amount);
    broadcastDuels();
    if (toKey) io.to('u:' + toKey).emit('duel_invite', { id: d.id, from: d.from, amount });
    ack({ ok: true, id: d.id, amount });
  });

  socket.on('duel_cancel', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id], d = duels.get(clean(data && data.id, 20));
    if (!u || !d || d.fromKey !== lower(u.username)) return ack({ ok: false, msg: 'Ce défi n’est plus ouvert.' });
    closeDuel(d.id, 'cancelled');
    ack({ ok: true, amount: d.amount });
  });

  socket.on('duel_accept', (data, ack) => {
    ack = reply(ack);
    const u = users[socket.id];
    if (!u) return ack({ ok: false, msg: 'Connectez-vous avant d’accepter un duel.' });
    const d = duels.get(clean(data && data.id, 20)), key = lower(u.username);
    if (!d) return ack({ ok: false, msg: 'Ce duel n’est plus disponible.' });
    if (d.fromKey === key) return ack({ ok: false, msg: 'Vous ne pouvez pas accepter votre propre défi.' });
    if (d.toKey && d.toKey !== key) return ack({ ok: false, msg: `Ce duel est réservé à ${d.toName}.` });
    if (d.amount > u.balance + 0.001) return ack({ ok: false, msg: 'Solde insuffisant pour relever ce défi.' });
    if (!socketIdsOf(d.from).length) { closeDuel(d.id, 'cancelled'); return ack({ ok: false, msg: `${d.from} n’est plus connecté : duel annulé.` }); }
    duels.delete(d.id); // retiré tout de suite : personne d'autre ne peut l'accepter
    const creatorWins = crypto.randomInt(0, 2) === 0;
    const r = { id: d.id, status: 'done', a: d.from, b: u.username, winner: creatorWins ? d.from : u.username, loser: creatorWins ? u.username : d.from, amount: d.amount, at: Date.now() };
    duelResults.set(d.id, r); keepResults();
    u.balance = round2(u.balance - d.amount);
    ack({ ok: true, ...r });
    io.to('u:' + d.fromKey).to('u:' + key).emit('duel_result', r);
    io.emit('chat_message', { system: true, text: `Duel : ${r.winner} bat ${r.loser} et remporte ${money2(r.amount * 2)}.` });
    broadcastDuels();
  });

  socket.on('duel_status', (data, ack) => {
    ack = reply(ack);
    const ids = Array.isArray(data && data.ids) ? data.ids.slice(0, 20).map(x => clean(x, 20)) : [];
    ack({ ok: true, list: ids.map(id => duels.has(id) ? { id, status: 'open' } : duelResults.get(id) || { id, status: 'unknown' }) });
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
    const gone = users[socket.id];
    delete users[socket.id];
    if (gone && !socketIdsOf(gone.username).length) {
      for (const d of [...duels.values()]) if (d.fromKey === lower(gone.username)) closeDuel(d.id, 'cancelled');
    }
    broadcastList();
    // Les mises en cours restent actives : l'encaissement automatique fonctionne même hors ligne.
  });
});

startBetting();
startRaceBetting();
initAccounts().then(initSeasons);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur en écoute sur le port ${PORT}`));
