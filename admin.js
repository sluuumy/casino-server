/* ===================================================================
   ADMINISTRATION DE CARAT
   Les administrateurs sont désignés par la variable d'environnement
   ADMIN_USERS sur Render (pseudos séparés par des virgules), jamais dans
   le code : le dépôt est public. Chaque action est vérifiée ici, sur le
   serveur, et inscrite dans un journal.
   =================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./regles');

const LOG_FILE = path.join(__dirname, 'adminlog.json');
const LOG_MAX = 500;
const MAX_AMOUNT = 1e15;

module.exports = function setupAdmin(ctx) {
  const { io, accounts, users, getAccount, allAccounts, persist, removeAccount, ensureState, changed, broadcastList, Eco, Seasons } = ctx;
  const lower = s => String(s || '').toLowerCase();
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const r2 = n => Math.round(Number(n) * 100) / 100;
  const adminList = () => String(process.env.ADMIN_USERS || '').split(',').map(s => lower(s.trim())).filter(Boolean);
  const isAdmin = a => !!(a && !a.guest && adminList().includes(a._id));
  if (!adminList().length) console.log('Administration : aucun administrateur (variable ADMIN_USERS vide).');
  else console.log(`Administration : ${adminList().length} administrateur${adminList().length > 1 ? 's' : ''} configuré${adminList().length > 1 ? 's' : ''}.`);

  /* ----- Journal des actions ----- */
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  let logLoaded = false;
  async function loadLog() {
    if (logLoaded) return; logLoaded = true;
    const col = ctx.metaCol();
    if (col) { try { const doc = await col.findOne({ _id: 'adminlog' }); if (doc && Array.isArray(doc.log)) log = doc.log; } catch {} }
  }
  function addLog(admin, action, target, detail) {
    log.unshift({ at: Date.now(), admin, action, target: target || '', detail: detail || '' });
    log.length = Math.min(log.length, LOG_MAX);
    const col = ctx.metaCol();
    if (col) col.replaceOne({ _id: 'adminlog' }, { _id: 'adminlog', log }, { upsert: true }).catch(() => {});
    else fs.writeFile(LOG_FILE, JSON.stringify(log), () => {});
  }

  /* ----- Sanctions ----- */
  function banInfo(a) {
    if (!a || !a.ban) return null;
    if (a.ban.until && a.ban.until <= Date.now()) { delete a.ban; persist(a); return null; }
    return a.ban;
  }
  function muteInfo(a) {
    if (!a || !a.mute) return null;
    if (a.mute.until && a.mute.until <= Date.now()) { delete a.mute; persist(a); return null; }
    return a.mute;
  }
  const dateFr = ts => new Date(ts).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  function banMessage(b) {
    return `Ce compte est suspendu${b.until ? ` jusqu’au ${dateFr(b.until)}` : ' définitivement'}${b.reason ? ` : ${b.reason}` : '.'}`;
  }
  function socketsOf(key) { return [...io.of('/').sockets.values()].filter(s => s.data.account === key); }
  function kick(a, payload) {
    for (const s of socketsOf(a._id)) {
      s.data.active = false;
      s.leave('u:' + a._id);
      delete users[s.id];
      s.emit('kicked', payload);
    }
    broadcastList();
  }
  const online = key => socketsOf(key).some(s => s.data.active);
  function notify(a, text) { io.to('u:' + a._id).emit('admin_notice', { text }); }
  function pushState(a) { if (a.state) io.to('u:' + a._id).emit('eco_state', { st: Eco.snapshot(a.state) }); }

  /* ----- Résumés de comptes ----- */
  function summary(a) {
    const st = a.state || {};
    return {
      key: a._id, username: a.username, guest: !!a.guest, admin: isAdmin(a),
      balance: r2(st.balance || 0), level: Eco.levelOf(Number(st.xp) || 0), games: st.gamesPlayed || 0,
      created: a.created || 0, lastSeen: st.lastSeen || a.savedAt || 0, online: online(a._id),
      ban: banInfo(a), mute: muteInfo(a)
    };
  }
  async function findTarget(name) {
    const key = lower(clean(name, 40));
    const a = key && await getAccount(key);
    if (!a) throw new Error('Compte introuvable.');
    return a;
  }
  const shopAll = () => [...((ctx.seasonCfg() && ctx.seasonCfg().shopTitles) || []), ...R.SHOP];
  const COINS = ['argent', 'onyx', 'emeraude'];

  /* ----- Remises à zéro ----- */
  const RESETS = {
    goals: st => { st.goals = {}; },
    daily: st => { st.daily = { day: '', ids: [], prog: {}, claimed: {} }; Eco.ensureDay(st); },
    pass: st => { Seasons.resetPassState(st); },
    xp: st => { st.xp = 0; st.xpDay = null; },
    clicker: st => { st.clicker = { up: {}, bought: 0, boosts: 0, clickEarned: 0, autoEarned: 0 }; st.boost = null; st.boostItems = {}; },
    arcade: st => { st.arcade = null; },
    stats: st => {
      Object.keys(st.c).forEach(k => { st.c[k] = 0; });
      Object.assign(st, { totalWon: 0, totalLost: 0, gamesPlayed: 0, gamesWon: 0, biggestMult: 1, bestCrash: 0, history: [], plinkoBig: [], seen: {}, totalClicks: 0, achievements: {} });
    },
    inventory: st => { st.inventory = {}; st.equippedBadge = ''; st.theme = 'tapis'; st.coinSkin = 'or'; st.passTitles = []; },
    malus: st => { st.malus = {}; }
  };
  const RESET_NAMES = { goals: 'objectifs permanents', daily: 'objectifs du jour', pass: 'pass de saison', xp: 'XP et niveau', clicker: 'clicker et boosts', arcade: 'mini-jeux du jour', stats: 'statistiques et historique', inventory: 'titres, thèmes et gemmes', malus: 'handicaps reçus', all: 'toute la progression' };

  /* ----- Actions ----- */
  const OPS = {
    async search(me, d) {
      const q = lower(clean(d.q, 30));
      const col = ctx.mongo();
      if (col && q) {
        const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found = await col.find({ _id: { $regex: esc } }).limit(40).toArray();
        found.forEach(a => { if (!accounts.has(a._id)) accounts.set(a._id, a); });
      }
      const list = [...accounts.values()].filter(a => !q || a._id.includes(q)).slice(0, 40);
      return { list: list.map(summary).sort((x, y) => Number(y.online) - Number(x.online) || y.lastSeen - x.lastSeen) };
    },
    async online() {
      const keys = [...new Set(Object.values(users).map(u => u.key).filter(Boolean))];
      return { list: keys.map(k => accounts.get(k)).filter(Boolean).map(summary) };
    },
    async top(me, d) {
      const by = ['balance', 'level', 'games'].includes(d.by) ? d.by : 'balance';
      const list = (await allAccounts()).filter(a => a.state).map(summary).sort((x, y) => y[by] - x[by]).slice(0, 30);
      return { list };
    },
    async banned() {
      return { list: (await allAccounts()).filter(a => banInfo(a) || muteInfo(a)).map(summary) };
    },
    async get(me, d) {
      const a = await findTarget(d.target);
      ensureState(a);
      return { account: { ...summary(a), state: a.state ? Eco.snapshot(a.state) : null, heritage: a.heritage || [], devices: (a.tokens || []).length } };
    },
    async balance(me, d) {
      const a = await findTarget(d.target), st = ensureState(a);
      const amount = r2(d.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) throw new Error('Montant invalide.');
      const before = st.balance;
      if (d.mode === 'set') st.balance = amount;
      else if (d.mode === 'add') st.balance = r2(st.balance + amount);
      else if (d.mode === 'remove') st.balance = Math.max(0, r2(st.balance - amount));
      else throw new Error('Opération inconnue.');
      changed(a, [], true);
      const diff = r2(st.balance - before);
      if (diff) notify(a, diff > 0 ? `Un administrateur vous a crédité ${diff} $.` : `Un administrateur a retiré ${-diff} $ de votre solde.`);
      return { log: [`solde ${before} → ${st.balance}`], a };
    },
    async reset(me, d) {
      const a = await findTarget(d.target), st = ensureState(a);
      const what = d.what;
      if (what === 'all') { a.state = Eco.newState(ctx.startBalance()); a.state.season = st.season; a.priv = {}; }
      else if (RESETS[what]) RESETS[what](st);
      else throw new Error('Remise à zéro inconnue.');
      changed(a, [], true);
      notify(a, `Un administrateur a remis à zéro : ${RESET_NAMES[what]}.`);
      return { log: [RESET_NAMES[what]], a };
    },
    async give(me, d) {
      const a = await findTarget(d.target), st = ensureState(a);
      const take = d.take === true, id = clean(String(d.id ?? ''), 40);
      let label;
      if (d.kind === 'title') {
        const it = shopAll().find(i => i.id === id) || (() => { throw new Error('Titre inconnu.'); })();
        if (take) { delete st.inventory[it.id]; if (st.equippedBadge === it.tag) st.equippedBadge = ''; } else st.inventory[it.id] = true;
        label = `titre ${it.tag}`;
      } else if (d.kind === 'theme') {
        const t = R.THEMES.find(x => x.id === id && x.id !== 'tapis' && x.price !== 0) || (() => { throw new Error('Thème inconnu.'); })();
        if (take) { delete st.inventory['theme_' + t.id]; if (st.theme === t.id) st.theme = 'tapis'; } else st.inventory['theme_' + t.id] = true;
        label = `thème ${t.id}`;
      } else if (d.kind === 'coin') {
        if (!COINS.includes(id)) throw new Error('Gemme inconnue.');
        if (take) { delete st.inventory['coin_' + id]; if (st.coinSkin === id) st.coinSkin = 'or'; } else st.inventory['coin_' + id] = true;
        label = `gemme ${id}`;
      } else if (d.kind === 'boost') {
        const mult = Number(id);
        if (!R.BOOSTS.some(b => b.mult === mult)) throw new Error('Boost inconnu.');
        if (take) { if (st.boostItems[mult] > 1) st.boostItems[mult]--; else delete st.boostItems[mult]; } else st.boostItems[mult] = (st.boostItems[mult] || 0) + 1;
        label = `boost ×${mult}`;
      } else if (d.kind === 'xp') {
        const n = Math.floor(Number(d.amount));
        if (!(n > 0 && n <= 1e7)) throw new Error('Quantité d’XP invalide.');
        st.xp = Math.max(0, (st.xp || 0) + (take ? -n : n));
        label = `${n} XP`;
      } else if (d.kind === 'heritage') {
        const tag = clean(d.tag, 20).toUpperCase(), hl = clean(d.label, 60) || tag;
        if (take) { a.heritage = (a.heritage || []).filter(h => h.tag !== tag); if (st.equippedBadge === tag) st.equippedBadge = ''; }
        else {
          if (!tag) throw new Error('Indiquez le texte du titre.');
          if (tag === 'ADMIN') throw new Error('Ce titre est réservé.');
          a.heritage = (a.heritage || []).filter(h => h.tag !== tag).concat({ id: 'admin-' + crypto.randomBytes(4).toString('hex'), tag, label: hl, season: st.season, at: Date.now() });
        }
        label = `titre d’Héritage ${tag}`;
      } else throw new Error('Type d’objet inconnu.');
      changed(a, [], true);
      io.to('u:' + a._id).emit('heritage', { heritage: a.heritage || [] });
      notify(a, take ? `Un administrateur vous a retiré : ${label}.` : `Un administrateur vous a offert : ${label}.`);
      return { log: [(take ? 'retrait : ' : 'don : ') + label], a };
    },
    async ban(me, d) {
      const a = await findTarget(d.target);
      if (isAdmin(a)) throw new Error('Impossible de bannir un administrateur.');
      const minutes = Math.floor(Number(d.minutes) || 0);
      a.ban = { until: minutes > 0 ? Date.now() + minutes * 60000 : 0, reason: clean(d.reason, 200), by: me.username, at: Date.now() };
      persist(a);
      kick(a, { reason: 'ban', msg: banMessage(a.ban) });
      for (const dl of ctx.openDuelsOf(a._id)) ctx.closeDuel(dl, 'cancelled');
      return { log: [minutes ? `${minutes} min` : 'définitif', a.ban.reason], a };
    },
    async unban(me, d) { const a = await findTarget(d.target); delete a.ban; persist(a); return { log: [], a }; },
    async mute(me, d) {
      const a = await findTarget(d.target);
      if (isAdmin(a)) throw new Error('Impossible de rendre muet un administrateur.');
      const minutes = Math.floor(Number(d.minutes) || 0);
      a.mute = { until: minutes > 0 ? Date.now() + minutes * 60000 : 0, reason: clean(d.reason, 200), by: me.username, at: Date.now() };
      persist(a);
      notify(a, `Vous ne pouvez plus écrire dans le tchat${a.mute.until ? ` jusqu’au ${dateFr(a.mute.until)}` : ''}${a.mute.reason ? ` : ${a.mute.reason}` : '.'}`);
      return { log: [minutes ? `${minutes} min` : 'définitif', a.mute.reason], a };
    },
    async unmute(me, d) { const a = await findTarget(d.target); delete a.mute; persist(a); notify(a, 'Vous pouvez de nouveau écrire dans le tchat.'); return { log: [], a }; },
    async kick(me, d) {
      const a = await findTarget(d.target);
      if (isAdmin(a)) throw new Error('Impossible d’expulser un administrateur.');
      kick(a, { reason: 'kick', msg: `Vous avez été déconnecté par un administrateur${d.reason ? ` : ${clean(d.reason, 200)}` : '.'}` });
      return { log: [clean(d.reason, 200)], a };
    },
    async password(me, d) {
      const a = await findTarget(d.target);
      if (a.guest) throw new Error('Un invité n’a pas de mot de passe.');
      const pw = String(d.password || '');
      if (pw.length < 6 || pw.length > 200) throw new Error('Mot de passe : 6 caractères minimum.');
      a.salt = crypto.randomBytes(16).toString('hex');
      a.hash = await ctx.scryptHash(pw, a.salt);
      a.tokens = [];
      persist(a);
      kick(a, { reason: 'password', msg: 'Votre mot de passe a été changé par un administrateur : reconnectez-vous.' });
      return { log: [], a };
    },
    async delete(me, d) {
      const a = await findTarget(d.target);
      if (isAdmin(a)) throw new Error('Impossible de supprimer un administrateur.');
      if (lower(d.confirm) !== a._id) throw new Error('Recopiez le pseudo pour confirmer.');
      kick(a, { reason: 'delete', msg: 'Ce compte a été supprimé par un administrateur.' });
      for (const dl of ctx.openDuelsOf(a._id)) ctx.closeDuel(dl, 'cancelled');
      removeAccount(a._id);
      return { log: [], a };
    },
    async announce(me, d) {
      const text = clean(d.text, 300);
      if (!text) throw new Error('Message vide.');
      io.emit('announce', { text, from: me.username });
      io.emit('chat_message', { system: true, text: `Annonce : ${text}` });
      return { log: [text] };
    },
    async gift(me, d) {
      const amount = r2(d.amount);
      if (!(amount > 0 && amount <= 1e12)) throw new Error('Montant invalide.');
      const keys = [...new Set(Object.values(users).map(u => u.key).filter(Boolean))];
      let n = 0;
      for (const k of keys) { const a = accounts.get(k); if (a && ensureState(a)) { Eco.credit(a.state, amount); changed(a, [], true); notify(a, `Cadeau des administrateurs : +${amount} $.`); n++; } }
      io.emit('chat_message', { system: true, text: `Cadeau : ${n} joueur${n > 1 ? 's' : ''} connecté${n > 1 ? 's' : ''} reçoi${n > 1 ? 'vent' : 't'} ${amount} $.` });
      return { log: [`${amount} $ à ${n} joueurs`], n };
    },
    async clearchat() { io.emit('chat_clear'); return { log: [] }; },
    async endseason(me, d) {
      if (d.confirm !== 'TERMINER') throw new Error('Tapez TERMINER pour confirmer.');
      await ctx.endSeasonNow();
      return { log: [] };
    },
    async logs() { await loadLog(); return { log: log.slice(0, 200), skipLog: true }; }
  };
  const OP_NAMES = { balance: 'Solde modifié', reset: 'Remise à zéro', give: 'Objet', ban: 'Bannissement', unban: 'Débannissement', mute: 'Rendu muet', unmute: 'Parole rendue', kick: 'Expulsion', password: 'Mot de passe changé', delete: 'Compte supprimé', announce: 'Annonce', gift: 'Cadeau à tous', clearchat: 'Tchat vidé', endseason: 'Fin de saison forcée' };
  const READ_ONLY = ['search', 'online', 'top', 'banned', 'get', 'logs'];

  /* ----- Branchement sur une connexion ----- */
  function attach(socket, acct) {
    socket.on('admin', async (data, ack) => {
      ack = typeof ack === 'function' ? ack : () => {};
      const me = acct();
      if (!isAdmin(me)) return ack({ ok: false, msg: 'Réservé aux administrateurs.' });
      const op = data && data.op;
      if (!OPS[op]) return ack({ ok: false, msg: 'Action inconnue.' });
      try {
        const res = await OPS[op](me, data || {});
        if (!READ_ONLY.includes(op)) {
          await loadLog();
          addLog(me.username, OP_NAMES[op] || op, res.a ? res.a.username : '', (res.log || []).filter(Boolean).join(', '));
        }
        const out = { ok: true, ...res };
        if (res.a) { ensureState(res.a); out.account = op === 'delete' ? null : { ...summary(res.a), state: res.a.state ? Eco.snapshot(res.a.state) : null, heritage: res.a.heritage || [], devices: (res.a.tokens || []).length }; delete out.a; }
        delete out.skipLog;
        if (op !== 'logs') delete out.log;
        ack(out);
      } catch (e) { ack({ ok: false, msg: e.message || 'Erreur.' }); }
    });
  }

  return { isAdmin, banInfo, banMessage, muteInfo, attach };
};
