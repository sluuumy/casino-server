/* Règles des jeux, recopiées du site (index.html) : toute modification ici doit aussi être faite là-bas. */
'use strict';
const calc = {}; // fonctions de calcul fournies par economie.js
const SHOP = [
  { id: 'badge_lucky', name: 'Chanceux', desc: 'Pour ceux qui y croient.', price: 2500, tag: 'CHANCEUX' },
  { id: 'badge_pro', name: 'Joueur régulier', desc: 'Pour ceux qui reviennent tous les jours.', price: 10000, tag: 'PRO' },
  { id: 'badge_clicker', name: 'Cliqueur fou', desc: 'Pour les doigts qui ne s’arrêtent jamais.', price: 25000, tag: 'CLIQUEUR' },
  { id: 'badge_elite', name: 'Élite', desc: 'Un titre de prestige intermédiaire.', price: 50000, tag: 'ÉLITE' },
  { id: 'badge_vip', name: 'VIP', desc: 'Le haut du panier.', price: 100000, tag: 'VIP' },
  { id: 'badge_highroller', name: 'High roller', desc: 'Les grosses mises ne vous font pas peur.', price: 500000, tag: 'HIGH ROLLER' },
  { id: 'badge_millionaire', name: 'Millionnaire', desc: 'Le premier million, affiché dans le tchat.', price: 1000000, tag: 'MILLIONNAIRE' },
  { id: 'badge_whale', name: 'Baleine', desc: 'Pour les poches sans fond.', price: 5000000, tag: 'BALEINE' },
  { id: 'badge_tycoon', name: 'Magnat', desc: 'Réservé aux vrais maîtres du capital.', price: 25000000, tag: 'TYCOON' },
  { id: 'badge_billionaire', name: 'Milliardaire', desc: 'Le sommet de la richesse virtuelle.', price: 100000000, tag: 'BILLIONNAIRE' },
  { id: 'badge_legend', name: 'Légende', desc: 'Presque personne ne l’aura jamais.', price: 1000000000, tag: 'LÉGENDE' }
];
const PLINKO_TABLES = {"8": {"faible": [7.24, 2.53, 1.2, 0.76, 0.66, 0.76, 1.2, 2.53, 7.24], "moyen": [26.7, 4.19, 1.07, 0.45, 0.33, 0.45, 1.07, 4.19, 26.7], "eleve": [87.8, 3.16, 0.29, 0.07, 0.04, 0.07, 0.29, 3.16, 87.8]}, "12": {"faible": [14.3, 5.72, 2.7, 1.51, 0.99, 0.77, 0.71, 0.77, 0.99, 1.51, 2.7, 5.72, 14.3], "moyen": [98.7, 19.7, 5.14, 1.76, 0.8, 0.48, 0.4, 0.48, 0.8, 1.76, 5.14, 19.7, 98.7], "eleve": [848, 46.5, 4.33, 0.68, 0.18, 0.08, 0.06, 0.08, 0.18, 0.68, 4.33, 46.5, 848]}, "16": {"faible": [25.1, 11, 5.4, 2.95, 1.8, 1.23, 0.93, 0.79, 0.75, 0.79, 0.93, 1.23, 1.8, 2.95, 5.4, 11, 25.1], "moyen": [291, 68.7, 19.3, 6.48, 2.6, 1.26, 0.74, 0.52, 0.46, 0.52, 0.74, 1.26, 2.6, 6.48, 19.3, 68.7, 291], "eleve": [1000, 578, 60.3, 8.91, 1.86, 0.55, 0.23, 0.14, 0.12, 0.14, 0.23, 0.55, 1.86, 8.91, 60.3, 578, 1000]}};
const ALL_GAMES = ['Aviateur', 'Machine à sous', 'Course', 'Plinko', 'Mines', 'Blackjack', 'Hilo', 'Roue de la fortune', 'Pile ou face'];
const SLOT_STRIP = ["raisin","cerise","citron","raisin","citron","citron","cerise","etoile","diamant","citron","cerise","citron","citron","cloche","cerise","cloche","etoile","citron","raisin","cerise","sept","cloche","raisin","etoile","cerise","raisin","cloche","cerise","raisin","cerise","cloche","diamant"];
const SLOT_PAY = { cerise: 8, citron: 16, raisin: 25, cloche: 40, etoile: 125, diamant: 400, sept: 2000 };
const SLOT_CHERRY2 = 2;
const SLOT_LINES = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [2, 1, 0]];
const WHEEL_RISKS = {
  faible: [[1.5, 10], [1.2, 12], [0, 8]],
  moyen: [[4, 1], [3, 2], [2, 5], [1.5, 6], [0, 16]],
  eleve: [[29.4, 1], [0, 29]]
};
const SCRATCH_TIERS = [ // multiplicateur, probabilité : 95 % de taux de retour
  { m: 500, p: 0.0001, sym: 'couronne' }, { m: 50, p: 0.002, sym: 'diamant' }, { m: 10, p: 0.015, sym: 'sept' },
  { m: 5, p: 0.04, sym: 'cloche' }, { m: 2, p: 0.1, sym: 'etoile' }, { m: 1, p: 0.25, sym: 'cerise' }
];
const CLICK_BASE = 0.1;
const GROWTH = 1.18;
const UPGRADES = [
  { id: 'gants', kind: 'click', name: 'Gants de croupier', desc: '+0,05 $ par clic', value: 0.05, base: 60 },
  { id: 'jetons', kind: 'click', name: 'Jetons gravés', desc: '+0,50 $ par clic', value: 0.5, base: 3000 },
  { id: 'mallette', kind: 'click', name: 'Mallette de billets', desc: '+5 $ par clic', value: 5, base: 150000 },
  { id: 'coffre', kind: 'click', name: 'Clé du coffre-fort', desc: '+50 $ par clic', value: 50, base: 7500000 },
  { id: 'tirelire', kind: 'auto', name: 'Tirelire', desc: '+0,10 $ par seconde', value: 0.1, base: 150 },
  { id: 'distrib', kind: 'auto', name: 'Distributeur de jetons', desc: '+1 $ par seconde', value: 1, base: 4000 },
  { id: 'bandit', kind: 'auto', name: 'Bandit manchot', desc: '+8 $ par seconde', value: 8, base: 65000 },
  { id: 'poker', kind: 'auto', name: 'Table de poker privée', desc: '+60 $ par seconde', value: 60, base: 1000000 },
  { id: 'robot', kind: 'auto', name: 'Croupier robot', desc: '+400 $ par seconde', value: 400, base: 15000000 },
  { id: 'yacht', kind: 'auto', name: 'Casino flottant', desc: '+3 000 $ par seconde', value: 3000, base: 225000000 }
];
const BOOSTS = [
  { mult: 2, price: 5000 },
  { mult: 5, price: 40000 },
  { mult: 10, price: 150000 },
  { mult: 50, price: 2500000 }
];
const BOOST_MS = 5 * 60 * 1000, BOOST_MAX_MS = 30 * 60 * 1000;
const GAME_BONUS_SHARE = 0.5; // bonus de jeux maximal par boost : la moitié de son prix
const OFFLINE_CAP_S = 2 * 3600, OFFLINE_RATE = 0.5;
const GOALS = [
  // ----- Clicker -----
  { id: 'c100', cat: 'clicker', title: 'Premiers pas', desc: 'Cliquer 100 fois', goal: 100, val: st => st.totalClicks, reward: 10 },
  { id: 'c5000', cat: 'clicker', title: 'Infatigable', desc: 'Cliquer 5 000 fois', goal: 5000, val: st => st.totalClicks, reward: 600 },
  { id: 'c25k', cat: 'clicker', title: 'Machine humaine', desc: 'Cliquer 25 000 fois', goal: 25000, val: st => st.totalClicks, reward: 6000 },
  { id: 'c100k', cat: 'clicker', title: 'Légende du clic', desc: 'Cliquer 100 000 fois', goal: 100000, val: st => st.totalClicks, reward: 60000 },
  { id: 'up1', cat: 'clicker', title: 'Premier investissement', desc: 'Acheter une amélioration du clicker', goal: 1, val: st => st.clicker.bought, reward: 10 },
  { id: 'up10', cat: 'clicker', title: 'Collectionneur de machines', desc: 'Acheter 10 améliorations', goal: 10, val: st => st.clicker.bought, reward: 200 },
  { id: 'up50', cat: 'clicker', title: 'Industriel', desc: 'Acheter 50 améliorations', goal: 50, val: st => st.clicker.bought, reward: 10000 },
  { id: 'up150', cat: 'clicker', title: 'Conglomérat', desc: 'Acheter 150 améliorations', goal: 150, val: st => st.clicker.bought, reward: 400000 },
  { id: 'cv1', cat: 'clicker', title: 'Clic en or', desc: 'Gagner 1 $ par clic, sans boost', goal: 1, val: st => calc.clickValue(st), reward: 200, fmt: 'money' },
  { id: 'cv25', cat: 'clicker', title: 'Clic en diamant', desc: 'Gagner 25 $ par clic, sans boost', goal: 25, val: st => calc.clickValue(st), reward: 20000, fmt: 'money' },
  { id: 'auto1', cat: 'clicker', title: 'Ça tourne tout seul', desc: 'Atteindre 1 $ par seconde de revenus automatiques', goal: 1, val: st => calc.autoRate(st), reward: 100, fmt: 'rate' },
  { id: 'auto10', cat: 'clicker', title: 'Petit rentier', desc: 'Atteindre 10 $ par seconde', goal: 10, val: st => calc.autoRate(st), reward: 1200, fmt: 'rate' },
  { id: 'auto50', cat: 'clicker', title: 'Rentier', desc: 'Atteindre 50 $ par seconde', goal: 50, val: st => calc.autoRate(st), reward: 8000, fmt: 'rate' },
  { id: 'auto500', cat: 'clicker', title: 'Empire', desc: 'Atteindre 500 $ par seconde', goal: 500, val: st => calc.autoRate(st), reward: 100000, fmt: 'rate' },
  { id: 'auto5000', cat: 'clicker', title: 'Empire mondial', desc: 'Atteindre 5 000 $ par seconde', goal: 5000, val: st => calc.autoRate(st), reward: 2000000, fmt: 'rate' },
  { id: 'boost', cat: 'clicker', title: 'Coup de fouet', desc: 'Acheter un boost', goal: 1, val: st => st.clicker.boosts, reward: 400 },
  { id: 'boost10', cat: 'clicker', title: 'Accro à la vitesse', desc: 'Acheter 10 boosts', goal: 10, val: st => st.clicker.boosts, reward: 20000 },
  { id: 'boost50', cat: 'clicker', title: 'Turbo', desc: 'Acheter un boost ×50', goal: 1, val: st => st.c.boost50, reward: 100000 },
  // ----- Jeux -----
  { id: 'g25', cat: 'jeux', title: 'Habitué', desc: 'Jouer 25 parties', goal: 25, val: st => st.c.games10, reward: 60 },
  { id: 'g100', cat: 'jeux', title: 'Pilier de Carat', desc: 'Jouer 100 parties', goal: 100, val: st => st.c.games10, reward: 400 },
  { id: 'g1000', cat: 'jeux', title: 'Résident', desc: 'Jouer 1 000 parties', goal: 1000, val: st => st.c.games10, reward: 8000 },
  { id: 'w10', cat: 'jeux', title: 'Main chaude', desc: 'Gagner 10 parties', goal: 10, val: st => st.c.wins10, reward: 80 },
  { id: 'w50', cat: 'jeux', title: 'En veine', desc: 'Gagner 50 parties', goal: 50, val: st => st.c.wins10, reward: 800 },
  { id: 'w250', cat: 'jeux', title: 'Intouchable', desc: 'Gagner 250 parties', goal: 250, val: st => st.c.wins10, reward: 6000 },
  { id: 'x3', cat: 'jeux', title: 'Décollage', desc: 'Encaisser à 3× ou plus à l’Aviateur', goal: 3, val: st => st.bestCrash, reward: 120, fmt: 'x' },
  { id: 'x10', cat: 'jeux', title: 'Haute altitude', desc: 'Encaisser à 10× ou plus à l’Aviateur', goal: 10, val: st => st.bestCrash, reward: 1000, fmt: 'x' },
  { id: 'x100', cat: 'jeux', title: 'Stratosphère', desc: 'Encaisser à 100× ou plus à l’Aviateur', goal: 100, val: st => st.bestCrash, reward: 40000, fmt: 'x' },
  { id: 'mines8', cat: 'jeux', title: 'Démineur', desc: 'Trouver 8 diamants dans une partie de Mines à 3 mines ou plus', goal: 8, val: st => st.c.minesRun, reward: 200 },
  { id: 'mines15', cat: 'jeux', title: 'Expert en déminage', desc: 'Trouver 15 diamants dans une partie de Mines à 3 mines ou plus', goal: 15, val: st => st.c.minesRun, reward: 4000 },
  { id: 'minesClear', cat: 'jeux', title: 'Sans faute', desc: 'Trouver tous les diamants d’une partie de Mines à 3 mines ou plus', goal: 1, val: st => st.c.minesClear, reward: 2000 },
  { id: 'bj', cat: 'jeux', title: 'Vingt-et-un', desc: 'Obtenir un blackjack', goal: 1, val: st => st.c.blackjacks, reward: 100 },
  { id: 'bj10', cat: 'jeux', title: 'Croupier en sueur', desc: 'Obtenir 10 blackjacks', goal: 10, val: st => st.c.blackjacks, reward: 1200 },
  { id: 'coin5', cat: 'jeux', title: 'Pile poil', desc: 'Gagner 5 lancers de suite à pile ou face', goal: 5, val: st => st.c.coinBest, reward: 320 },
  { id: 'coin10', cat: 'jeux', title: 'Insolent', desc: 'Gagner 10 lancers de suite à pile ou face', goal: 10, val: st => st.c.coinBest, reward: 10000 },
  { id: 'win10k', cat: 'jeux', title: 'Coup de maître', desc: 'Gagner 10 000 $ de bénéfice en une seule partie', goal: 10000, val: st => st.c.bestWin, reward: 2000, fmt: 'money' },
  { id: 'win1m', cat: 'jeux', title: 'Jackpot', desc: 'Gagner 1 000 000 $ de bénéfice en une seule partie', goal: 1000000, val: st => st.c.bestWin, reward: 40000, fmt: 'money' },
  { id: 'explore', cat: 'jeux', title: 'Explorateur', desc: 'Jouer aux 9 jeux de Carat', goal: 9, val: st => ALL_GAMES.filter(g => st.seen[g]).length, reward: 2000 },
  { id: 'slot7', cat: 'jeux', title: 'Triple sept', desc: 'Aligner trois 7 à la machine à sous', goal: 1, val: st => st.c.slot7, reward: 5000 },
  { id: 'outsider', cat: 'jeux', title: 'Coup de l’outsider', desc: 'Gagner une course sur un cheval coté ×9 ou plus', goal: 1, val: st => st.c.outsider, reward: 1500 },
  { id: 'duel1', cat: 'jeux', title: 'Premier sang', desc: 'Gagner un duel contre un autre joueur', goal: 1, val: st => st.c.duelWins, reward: 300 },
  { id: 'duel10', cat: 'jeux', title: 'Fine lame', desc: 'Gagner 10 duels', goal: 10, val: st => st.c.duelWins, reward: 3000 },
  { id: 'plinkoEdge', cat: 'jeux', title: 'Tout au bord', desc: 'Faire tomber une bille dans une case du bord au Plinko', goal: 1, val: st => st.c.plinkoEdge, reward: 1000 },
  { id: 'hilo8', cat: 'jeux', title: 'Devin', desc: 'Réussir 8 prédictions de suite au Hilo', goal: 8, val: st => st.c.hiloBest, reward: 1500 },
  { id: 'wheelTop', cat: 'jeux', title: 'Gros lot', desc: 'Toucher le ×29,4 à la Roue de la fortune', goal: 1, val: st => st.c.wheelTop, reward: 1500 },
  // ----- Richesse -----
  { id: 'bal100k', cat: 'richesse', title: 'Six chiffres', desc: 'Avoir 100 000 $ de solde', goal: 100000, val: st => st.balance, reward: 2000, fmt: 'money' },
  { id: 'bal10m', cat: 'richesse', title: 'Magnat', desc: 'Avoir 10 000 000 $ de solde', goal: 10000000, val: st => st.balance, reward: 200000, fmt: 'money' },
  { id: 'bal1b', cat: 'richesse', title: 'Milliardaire', desc: 'Avoir 1 000 000 000 $ de solde', goal: 1000000000, val: st => st.balance, reward: 10000000, fmt: 'money' },
  { id: 'won1m', cat: 'richesse', title: 'Fortune de jeu', desc: 'Cumuler 1 000 000 $ de gains aux jeux', goal: 1000000, val: st => st.totalWon, reward: 20000, fmt: 'money' },
  { id: 'wager1m', cat: 'richesse', title: 'Gros joueur', desc: 'Miser 1 000 000 $ au total', goal: 1000000, val: st => st.c.wagered, reward: 10000, fmt: 'money' },
  { id: 'wager100m', cat: 'richesse', title: 'Baleine', desc: 'Miser 100 000 000 $ au total', goal: 100000000, val: st => st.c.wagered, reward: 800000, fmt: 'money' },
  // ----- Collection -----
  { id: 'daily10', cat: 'collection', title: 'Fidèle', desc: 'Récupérer 10 objectifs du jour', goal: 10, val: st => st.c.dailyClaimed, reward: 2000 },
  { id: 'daily50', cat: 'collection', title: 'Assidu', desc: 'Récupérer 50 objectifs du jour', goal: 50, val: st => st.c.dailyClaimed, reward: 20000 },
  { id: 'theme1', cat: 'collection', title: 'Décorateur', desc: 'Acheter un thème', goal: 1, val: st => calc.themesOwned(st), reward: 800 },
  { id: 'themeAll', cat: 'collection', title: 'Nuancier', desc: 'Posséder tous les thèmes', goal: 4, val: st => calc.themesOwned(st), reward: 200000 },
  { id: 'title1', cat: 'collection', title: 'Premier titre', desc: 'Acheter un titre', goal: 1, val: st => calc.titlesOwned(st), reward: 400 },
  { id: 'title5', cat: 'collection', title: 'Collection de titres', desc: 'Posséder 5 titres', goal: 5, val: st => calc.titlesOwned(st), reward: 40000 },
  { id: 'loto1', cat: 'collection', title: 'Tenter sa chance', desc: 'Acheter un ticket de loto', goal: 1, val: st => st.c.lotoTickets, reward: 50 },
  { id: 'lotoWin', cat: 'collection', title: 'Main heureuse', desc: 'Remporter un lot au loto du jour', goal: 1, val: st => st.c.lotoWins, reward: 2000 },
  { id: 'chat20', cat: 'collection', title: 'Bavard', desc: 'Envoyer 20 messages dans le tchat', goal: 20, val: st => st.c.chats, reward: 120 }
];
const DAILY_COUNT = 4;
const DAILY_POOL = [
  { id: 'd_clicks', title: 'Doigts agiles', desc: 'Cliquer 400 fois', key: 'clicks', goal: 400, reward: 50 },
  { id: 'd_clicks2', title: 'Marathon du clic', desc: 'Cliquer 1 500 fois', key: 'clicks', goal: 1500, reward: 200 },
  { id: 'd_upgrades', title: 'Investisseur du jour', desc: 'Acheter 3 améliorations du clicker', key: 'upgrades', goal: 3, reward: 120 },
  { id: 'd_boost', title: 'Accélération', desc: 'Acheter un boost', key: 'boosts', goal: 1, reward: 250 },
  { id: 'd_games', title: 'Tour de salle', desc: 'Jouer 15 parties', key: 'games', goal: 15, reward: 75 },
  { id: 'd_wins', title: 'Série gagnante', desc: 'Gagner 6 parties', key: 'wins', goal: 6, reward: 100 },
  { id: 'd_profit', title: 'Bonne journée', desc: 'Gagner 1 000 $ de bénéfice aux jeux', key: 'profit', goal: 1000, reward: 150, fmt: 'money' },
  { id: 'd_wager', title: 'Mise du jour', desc: 'Miser 2 000 $ au total', key: 'wager', goal: 2000, reward: 150, fmt: 'money' },
  { id: 'd_crash2', title: 'Plein ciel', desc: 'Encaisser 3 fois à 2× ou plus à l’Aviateur', key: 'crash2', goal: 3, reward: 150 },
  { id: 'd_crash5', title: 'Haut vol', desc: 'Encaisser une fois à 5× ou plus à l’Aviateur', key: 'crash5', goal: 1, reward: 200 },
  { id: 'd_gems', title: 'Chercheur de diamants', desc: 'Trouver 15 diamants aux Mines', key: 'gems', goal: 15, reward: 100 },
  { id: 'd_mineswins', title: 'Prudence', desc: 'Encaisser 3 parties de Mines', key: 'mineswins', goal: 3, reward: 120 },
  { id: 'd_bj', title: 'Croupier battu', desc: 'Gagner 3 mains de blackjack', key: 'bjwins', goal: 3, reward: 120 },
  { id: 'd_bjbj', title: 'Blackjack !', desc: 'Obtenir un blackjack', key: 'bjs', goal: 1, reward: 150 },
  { id: 'd_coin', title: 'Bonne pioche', desc: 'Gagner 4 lancers de pièce', key: 'coinwins', goal: 4, reward: 75 },
  { id: 'd_plinko', title: 'Pluie de billes', desc: 'Lâcher 30 billes au Plinko', key: 'plinko', goal: 30, reward: 150 },
  { id: 'd_hilo', title: 'Intuition', desc: 'Réussir 10 prédictions au Hilo', key: 'hilo', goal: 10, reward: 125 },
  { id: 'd_slots', title: 'Bandit manchot', desc: 'Faire 20 tours de machine à sous', key: 'slots', goal: 20, reward: 100 },
  { id: 'd_race', title: 'Jour de course', desc: 'Parier sur 5 courses de chevaux', key: 'races', goal: 5, reward: 100 }
];
const DAILY_BONUS_S = 180;
const THEMES = [{ id: 'tapis', price: 0 }, { id: 'or_massif', price: null, pass: true }, { id: 'banquise', price: null, pass: true }, { id: 'magma', price: null, pass: true }, { id: 'vert', price: 0 }, { id: 'velours', price: 20000 }, { id: 'minuit', price: 20000 }, { id: 'ebene', price: 300000 }, { id: 'neon', price: 2000000 }];
const SAB_PRICES = { halve: 100000, clicker: 125000, noboost: 150000 };
const MALUS_MS = 5 * 60 * 1000, MALUS_MAX_MS = 15 * 60 * 1000, MALUS_MAX_GAMES = 6;

module.exports = { calc, SHOP, PLINKO_TABLES, ALL_GAMES, SLOT_STRIP, SLOT_PAY, SLOT_CHERRY2, SLOT_LINES, WHEEL_RISKS, SCRATCH_TIERS, CLICK_BASE, GROWTH, UPGRADES, BOOSTS, BOOST_MS, BOOST_MAX_MS, GAME_BONUS_SHARE, OFFLINE_CAP_S, OFFLINE_RATE, GOALS, DAILY_COUNT, DAILY_POOL, DAILY_BONUS_S, THEMES, SAB_PRICES, MALUS_MS, MALUS_MAX_MS, MALUS_MAX_GAMES };
