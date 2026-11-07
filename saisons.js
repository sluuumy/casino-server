/* ===================================================================
   SAISONS DE CARAT
   Chaque saison dure un mois. Pour préparer la suivante, il suffit de
   modifier ou d'ajouter une entrée dans SEASONS ci-dessous.
   Après la dernière saison de la liste, la liste recommence au début
   (avec le bon numéro de saison).

   Ce qu'une saison peut changer :
   - name, tagline, emblem : nom, accroche et emblème (couronne, flocon, flamme, étoile, lune)
   - theme : couleurs du site (variables CSS) ; artFilter : teinte des illustrations
   - rules : règles et bonus des jeux
       startBalance  solde de départ
       xpGames       jeux qui rapportent plus d'XP, ex. { 'Plinko': 2 } = XP doublée
       gameBonus     bonus sur les gains d'un jeu, ex. { game: 'Aviateur', pct: 10, weekend: true }
       clickMult     multiplicateur du clicker
       boostPrice, upgradePrice   multiplicateurs de prix (1 = prix normal)
   - seasonGames : jeux disponibles seulement cette saison (ex. 'grattage')
   - featured    : jeu mis en avant sur l'accueil
   - shopTitles  : titres vendus en boutique pendant la saison
   - pass        : récompenses du pass (voir buildPass plus bas)
   =================================================================== */

const PRESTIGE_LEVEL = 20; // niveau qui débloque la piste Prestige du pass
const MAX_LEVEL = 50;

/* Construit les 50 paliers du pass à partir de quelques récompenses marquantes ;
   les autres paliers donnent de l'argent, de plus en plus. */
function buildPass({ free = {}, prestige = {} }) {
  const tiers = [];
  for (let l = 1; l <= MAX_LEVEL; l++) {
    tiers.push({
      level: l,
      free: free[l] || { t: 'money', v: Math.round(150 * l + 15 * l * l) },
      prestige: l >= PRESTIGE_LEVEL ? (prestige[l] || (l % 2 === 0 ? { t: 'money', v: 2000 * l } : null)) : null
    });
  }
  return tiers;
}

const SEASONS = [
  {
    name: 'Nuit d’or',
    tagline: 'Le club ouvre ses portes : l’or coule à flots.',
    emblem: 'couronne',
    theme: {},                       // thème par défaut du site (noir et or)
    artFilter: 'none',
    rules: {
      startBalance: 150,
      xpGames: { 'Grattage': 2, 'Plinko': 1.5 },
      gameBonus: { game: 'Aviateur', pct: 10, weekend: true },
      clickMult: 1,
      boostPrice: 1,
      upgradePrice: 1
    },
    seasonGames: ['grattage'],
    featured: 'grattage',
    shopTitles: [
      { id: 's1_noctambule', name: 'Noctambule', desc: 'Pour les joueurs de la première nuit.', price: 15000, tag: 'NOCTAMBULE' },
      { id: 's1_lingot', name: 'Lingot', desc: 'Lourd, brillant, rare.', price: 400000, tag: 'LINGOT' }
    ],
    pass: buildPass({
      free: {
        5: { t: 'boost', mult: 2 }, 10: { t: 'coin', id: 'argent', label: 'Gemme saphir' }, 15: { t: 'boost', mult: 5 },
        25: { t: 'title', tag: 'NUIT D’OR', label: 'Titre « Nuit d’or »' }, 35: { t: 'boost', mult: 10 }, 50: { t: 'money', v: 250000 }
      },
      prestige: {
        20: { t: 'theme', id: 'or_massif', label: 'Thème « Or massif »' }, 25: { t: 'boost', mult: 5 },
        30: { t: 'coin', id: 'onyx', label: 'Gemme d’onyx' }, 40: { t: 'boost', mult: 50 },
        45: { t: 'title', tag: 'MÉCÈNE', label: 'Titre « Mécène »' }, 50: { t: 'coin', id: 'emeraude', label: 'Gemme émeraude' }
      }
    })
  },
  {
    name: 'Émeraude glacée',
    tagline: 'L’hiver s’installe : le froid fait monter les mises.',
    emblem: 'flocon',
    theme: { '--brass': '#8FD8E8', '--brass-hi': '#BCEBF5', '--brass-ink': '#05222A', '--jade': '#4FE3B0', '--bg': '#06090D', '--felt': '#0B1117', '--panel': '#0F171E', '--panel-2': '#15202A', '--line': '#24323F', '--line-soft': '#1A2631' },
    artFilter: 'hue-rotate(150deg) saturate(.85)',
    rules: {
      startBalance: 200,
      xpGames: { 'Course': 2, 'Hilo': 1.5 },
      gameBonus: { game: 'Mines', pct: 10, weekend: false },
      clickMult: 1.25,
      boostPrice: 0.9,
      upgradePrice: 1.1
    },
    seasonGames: [],
    featured: 'course',
    shopTitles: [
      { id: 's2_givre', name: 'Givre', desc: 'Sang-froid à toute épreuve.', price: 20000, tag: 'GIVRE' },
      { id: 's2_blizzard', name: 'Blizzard', desc: 'Emporte tout sur son passage.', price: 600000, tag: 'BLIZZARD' }
    ],
    pass: buildPass({
      free: { 5: { t: 'boost', mult: 2 }, 10: { t: 'coin', id: 'argent', label: 'Gemme saphir' }, 25: { t: 'title', tag: 'GLACIER', label: 'Titre « Glacier »' }, 35: { t: 'boost', mult: 10 } },
      prestige: { 20: { t: 'theme', id: 'banquise', label: 'Thème « Banquise »' }, 30: { t: 'coin', id: 'onyx', label: 'Gemme d’onyx' }, 40: { t: 'boost', mult: 50 }, 50: { t: 'coin', id: 'emeraude', label: 'Gemme émeraude' } }
    })
  },
  {
    name: 'Rubis ardent',
    tagline: 'La salle s’embrase : tout pour le gros lot.',
    emblem: 'flamme',
    theme: { '--brass': '#F2A65A', '--brass-hi': '#F8C48E', '--brass-ink': '#2A1205', '--jade': '#46D69A', '--bg': '#0B0607', '--felt': '#140A0C', '--panel': '#190D10', '--panel-2': '#231317', '--line': '#3A2128', '--line-soft': '#2A181D' },
    artFilter: 'hue-rotate(-25deg) saturate(1.15)',
    rules: {
      startBalance: 150,
      xpGames: { 'Machine à sous': 2, 'Blackjack': 1.5 },
      gameBonus: { game: 'Roue de la fortune', pct: 15, weekend: true },
      clickMult: 1,
      boostPrice: 1.2,
      upgradePrice: 0.9
    },
    seasonGames: ['grattage'],
    featured: 'slots',
    shopTitles: [
      { id: 's3_braise', name: 'Braise', desc: 'Toujours chaud.', price: 20000, tag: 'BRAISE' },
      { id: 's3_incendie', name: 'Incendie', desc: 'Rien ne l’arrête.', price: 600000, tag: 'INCENDIE' }
    ],
    pass: buildPass({
      free: { 5: { t: 'boost', mult: 2 }, 10: { t: 'coin', id: 'argent', label: 'Gemme saphir' }, 25: { t: 'title', tag: 'ARDENT', label: 'Titre « Ardent »' }, 35: { t: 'boost', mult: 10 } },
      prestige: { 20: { t: 'theme', id: 'magma', label: 'Thème « Magma »' }, 30: { t: 'coin', id: 'onyx', label: 'Gemme d’onyx' }, 40: { t: 'boost', mult: 50 }, 50: { t: 'coin', id: 'emeraude', label: 'Gemme émeraude' } }
    })
  }
];

/* Configuration de la saison n (1, 2, 3…) */
function seasonConfig(n) {
  const base = SEASONS[(Math.max(1, n) - 1) % SEASONS.length];
  return { ...base, num: n, prestigeLevel: PRESTIGE_LEVEL, maxLevel: MAX_LEVEL };
}

/* Niveaux : XP totale nécessaire pour atteindre le niveau L (même formule sur le site).
   Chaque niveau coûte plus cher que le précédent : 150 XP pour le niveau 2, puis 150 + 40k + 3k²
   (k = niveau actuel - 1). Total : 16 017 XP pour le niveau 20, 168 462 XP pour le niveau 50. */
const xpForLevel = L => { if (L <= 1) return 0; const n = L - 1; return 150 * n + 20 * n * (n - 1) + (n - 1) * n * (2 * n - 1) / 2; };
const levelFromXp = xp => { let L = 1; while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++; return L; };

/* Version du pass : l'augmenter remet le pass de tous les joueurs à zéro
   (XP, paliers récupérés, boosts en réserve, gemmes, thèmes et titres du pass).
   L'argent déjà reçu reste acquis. Même valeur que PASS_VERSION dans index.html. */
const PASS_VERSION = 2;
const PASS_THEMES = ['or_massif', 'banquise', 'magma'];
function resetPassState(st) {
  if (!st || typeof st !== 'object') return st;
  const titles = Array.isArray(st.passTitles) ? st.passTitles : [];
  st.xp = 0; st.xpDay = null; st.passClaimed = {}; st.passTitles = []; st.boostItems = {};
  if (titles.includes(st.equippedBadge)) st.equippedBadge = '';
  st.inventory = st.inventory && typeof st.inventory === 'object' ? st.inventory : {};
  Object.keys(st.inventory).forEach(k => { if (k.startsWith('coin_') || PASS_THEMES.includes(k.replace('theme_', ''))) delete st.inventory[k]; });
  st.coinSkin = 'or';
  if (PASS_THEMES.includes(st.theme)) st.theme = 'tapis';
  st.passVersion = PASS_VERSION;
  return st;
}

module.exports = { SEASONS, seasonConfig, xpForLevel, levelFromXp, PRESTIGE_LEVEL, MAX_LEVEL, PASS_VERSION, resetPassState };
