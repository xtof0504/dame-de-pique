// Intelligence des bots de la Dame de Pique.
//
// Les bots n'utilisent que des informations qu'un joueur humain aurait :
// leur main, les cartes déjà jouées, les couleurs où un adversaire a montré
// qu'il n'avait plus de cartes, et les scores affichés.
//
// Stratégies :
// - Éviter les points : se débarrasser de la dame de pique, des cœurs et des
//   cartes hautes ; jouer juste sous la carte qui gagne le pli.
// - Viser le joueur en tête (score le plus bas) : lui donner la dame de pique
//   et les cœurs quand c'est lui qui va gagner le pli.
// - Prendre tous les points (grand chelem) quand la main le permet, ou quand
//   le bot a déjà pris tous les points sortis en cours de manche.
// - Empêcher un adversaire de faire le grand chelem.

const RANK_VALUE = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS = ['clubs', 'diamonds', 'spades', 'hearts'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const rv = (c) => RANK_VALUE[c.rank];
const isQS = (c) => c.suit === 'spades' && c.rank === 'Q';
const same = (a, b) => a.suit === b.suit && a.rank === b.rank;
const cardPoints = (c) => (c.suit === 'hearts' ? 1 : 0) + (isQS(c) ? 13 : 0);
const bySuit = (cards, suit) => cards.filter((c) => c.suit === suit);
const lowest = (cards) => cards.reduce((a, b) => (rv(b) < rv(a) ? b : a));
const highest = (cards) => cards.reduce((a, b) => (rv(b) > rv(a) ? b : a));

// Règles (identiques à celles du serveur)
function isValidPlay(hand, card, ledSuit, heartsBroken) {
  const hasLed = ledSuit ? hand.some((c) => c.suit === ledSuit) : false;
  if (ledSuit && hasLed) return card.suit === ledSuit;
  if (ledSuit === null) {
    const hasTwoClubs = hand.some((c) => c.suit === 'clubs' && c.rank === '2');
    if (hasTwoClubs) return card.suit === 'clubs' && card.rank === '2';
    if (card.suit === 'hearts' && !heartsBroken && !hand.every((c) => c.suit === 'hearts')) return false;
  }
  return true;
}

function legalCards(ctx) {
  const legal = ctx.hand.filter((c) => isValidPlay(ctx.hand, c, ctx.ledSuit, ctx.heartsBroken));
  return legal.length ? legal : ctx.hand.slice();
}

// Cartes d'une couleur encore chez les adversaires (ni jouées, ni dans ma main)
function outstanding(ctx, suit) {
  const res = [];
  for (const rank of RANKS) {
    const c = { suit, rank };
    if (ctx.hand.some((h) => same(h, c))) continue;
    if (ctx.playedCards.some((p) => same(p, c))) continue;
    if (ctx.trickCards.some((t) => same(t.card, c))) continue;
    res.push(c);
  }
  return res;
}

const queenOut = (ctx) => !ctx.playedCards.some(isQS) && !ctx.trickCards.some((t) => isQS(t.card));

// Carte qui gagne le pli pour l'instant
function currentWinner(ctx) {
  if (!ctx.trickCards.length) return null;
  const led = ctx.trickCards[0].card.suit;
  let best = ctx.trickCards[0];
  for (const tc of ctx.trickCards) {
    if (tc.card.suit === led && rv(tc.card) > rv(best.card)) best = tc;
  }
  return best;
}

const trickPoints = (ctx) => ctx.trickCards.reduce((s, t) => s + cardPoints(t.card), 0);

// Joueur visé : l'adversaire en tête (score total + points de la manche le plus bas)
function targetPlayer(ctx) {
  let target = null;
  let best = Infinity;
  for (const pid of ctx.players) {
    if (pid === ctx.myId) continue;
    const s = (ctx.totalScores[pid] || 0) + (ctx.roundScores[pid] || 0);
    if (s < best) { best = s; target = pid; }
  }
  return target;
}

// Un adversaire est-il en train de prendre tous les points ?
function moonThreat(ctx) {
  const holders = ctx.players.filter((pid) => (ctx.roundScores[pid] || 0) > 0);
  if (holders.length !== 1) return null;
  const pid = holders[0];
  if (pid === ctx.myId) return null;
  // Plus la manche avance, plus on réagit tôt
  const threshold = ctx.hand.length <= 6 ? 4 : 8;
  return ctx.roundScores[pid] >= threshold ? pid : null;
}

// --- Grand chelem (prendre tous les points) ---

// La main est-elle assez forte pour tenter de prendre tous les points ?
function moonHandStrength(hand) {
  const hearts = bySuit(hand, 'hearts');
  const highHearts = hearts.filter((c) => rv(c) >= 11).length;
  const hasAH = hearts.some((c) => c.rank === 'A');
  const spades = bySuit(hand, 'spades');
  const hasQS = spades.some(isQS);
  const spadeControl = hasQS ? spades.some((c) => rv(c) >= 13) || spades.length >= 5 : spades.some((c) => rv(c) >= 13);
  let topCards = 0;
  for (const suit of ['clubs', 'diamonds']) {
    const cs = bySuit(hand, suit);
    if (cs.some((c) => c.rank === 'A')) topCards += 1;
    if (cs.some((c) => c.rank === 'K')) topCards += 0.5;
    if (cs.length === 0) topCards += 0.5; // pouvoir défausser
  }
  return hasAH && highHearts >= 3 && hearts.length >= 6 && spadeControl && topCards >= 1.5;
}

// Le bot vise-t-il tous les points pour cette manche ?
function wantsMoon(ctx) {
  if (ctx.allowMoon === false) return false;
  const others = ctx.players.filter((pid) => pid !== ctx.myId);
  if (others.some((pid) => (ctx.roundScores[pid] || 0) > 0)) return false; // trop tard
  if (ctx.moonPlan) return true;
  // Opportuniste : j'ai pris tous les points sortis, et une bonne partie
  const mine = ctx.roundScores[ctx.myId] || 0;
  if (mine >= 16) {
    const heartsOut = outstanding(ctx, 'hearts');
    const myHearts = bySuit(ctx.hand, 'hearts');
    // Je dois tenir les cœurs restants (mes cœurs dépassent les leurs)
    if (heartsOut.length === 0) return true;
    return myHearts.length > 0 && rv(highest(myHearts)) > rv(highest(heartsOut));
  }
  return false;
}

// Est-ce une carte maîtresse (plus haute que toutes celles qui restent) ?
function isMaster(ctx, card) {
  return outstanding(ctx, card.suit).every((o) => rv(o) < rv(card));
}

function playMoon(ctx, legal) {
  if (!ctx.trickCards.length) {
    // Entame : cartes maîtresses d'abord (hors cœur), puis cœurs maîtres
    const masters = legal.filter((c) => isMaster(ctx, c));
    const nonHeartMasters = masters.filter((c) => c.suit !== 'hearts');
    if (nonHeartMasters.length) return highest(nonHeartMasters);
    if (masters.length) return highest(masters);
    // Sinon, la plus haute carte de la couleur la plus longue
    const longest = SUITS.map((s) => bySuit(legal, s)).filter((cs) => cs.length).sort((a, b) => b.length - a.length)[0];
    return highest(longest);
  }
  const led = ctx.trickCards[0].card.suit;
  const follow = bySuit(legal, led);
  const win = currentWinner(ctx);
  if (follow.length) {
    const beating = follow.filter((c) => rv(c) > rv(win.card));
    if (!beating.length) return lowest(follow);
    // Dernier à jouer : la plus petite qui gagne ; sinon la plus forte
    return ctx.trickCards.length === 3 ? lowest(beating) : highest(beating);
  }
  // Défausse : garder les points et les cartes fortes, jeter la plus faible
  const nonPoints = legal.filter((c) => cardPoints(c) === 0);
  return lowest(nonPoints.length ? nonPoints : legal);
}

// --- Jeu normal : éviter les points et charger le joueur en tête ---

function chooseLead(ctx, legal) {
  const hasQS = ctx.hand.some(isQS);
  const qOut = queenOut(ctx);
  const spades = bySuit(legal, 'spades');

  // « Chasser la dame » : sans la dame ni le roi/as de pique, jouer pique
  // pour forcer celui qui a la dame à la jouer.
  if (qOut && !hasQS && spades.length && !spades.some((c) => rv(c) >= 13)) {
    return highest(spades);
  }

  // Coter chaque entame possible : plus le risque de remporter le pli est
  // faible, mieux c'est. On préfère vider les couleurs courtes.
  let best = null;
  let bestScore = Infinity;
  for (const c of legal) {
    const out = outstanding(ctx, c.suit);
    const lower = out.filter((o) => rv(o) < rv(c)).length;
    const higher = out.length - lower;
    let risk = higher === 0 ? 100 : (lower / Math.max(1, out.length)) * 50;
    if (c.suit === 'spades' && qOut && rv(c) >= 13 && !hasQS) risk += 80; // risque de prendre la dame
    if (isQS(c)) risk += 200;
    if (c.suit === 'spades' && hasQS) risk += 25; // ne pas attirer les piques
    if (c.suit === 'hearts') risk += 10 + rv(c);
    risk += bySuit(ctx.hand, c.suit).length * 2; // préférer les couleurs courtes
    risk += rv(c) * 0.5;
    if (risk < bestScore) { bestScore = risk; best = c; }
  }
  return best;
}

function chooseFollow(ctx, follow) {
  const win = currentWinner(ctx);
  const led = ctx.trickCards[0].card.suit;
  const last = ctx.trickCards.length === 3;
  const threat = moonThreat(ctx);
  const pts = trickPoints(ctx);

  // Contre un grand chelem : prendre un pli avec des points pour le casser
  if (threat && pts > 0 && win.playerId === threat) {
    const beating = follow.filter((c) => rv(c) > rv(win.card) && !isQS(c));
    if (beating.length) return lowest(beating);
  }

  // Dame de pique sous un roi ou un as de pique : la donner
  if (led === 'spades' && rv(win.card) > 12) {
    const q = follow.find(isQS);
    if (q) return q;
  }

  const under = follow.filter((c) => rv(c) < rv(win.card));
  if (under.length) {
    // Jouer la plus haute carte qui perd (sauf la dame si on peut l'éviter)
    const safe = under.filter((c) => !isQS(c));
    return highest(safe.length ? safe : under);
  }

  // Obligé de monter au-dessus
  const noQ = follow.filter((c) => !isQS(c));
  const pool = noQ.length ? noQ : follow;
  if (last) {
    // Je prends le pli de toute façon : me débarrasser de ma plus haute carte
    return highest(pool);
  }
  if (led === 'spades' && queenOut(ctx) && !ctx.hand.some(isQS)) {
    // Ne pas monter As/Roi de pique si la dame peut tomber dessus
    const small = pool.filter((c) => rv(c) < 12);
    if (small.length) return lowest(small);
  }
  // Premier pli (trèfle) : pas de points possibles en pratique, prendre haut
  if (ctx.playedCards.length === 0 && led === 'clubs') return highest(pool);
  return lowest(pool);
}

function chooseDiscard(ctx, legal) {
  const win = currentWinner(ctx);
  const target = targetPlayer(ctx);
  const threat = moonThreat(ctx);
  const winnerIsTarget = win && win.playerId === target;
  const qOut = queenOut(ctx);
  const hasQS = ctx.hand.some(isQS);
  const spadeCount = bySuit(ctx.hand, 'spades').length;

  if (threat && win) {
    if (win.playerId === threat) {
      // Ne pas offrir de points à un joueur qui vise le grand chelem
      const nonPoints = legal.filter((c) => cardPoints(c) === 0);
      if (nonPoints.length) return highest(nonPoints);
    } else {
      // Donner des points à un autre joueur casse son grand chelem
      const pointCards = legal.filter((c) => cardPoints(c) > 0);
      if (pointCards.length) return pointCards.find(isQS) || highest(pointCards);
    }
  }

  // La dame est-elle en danger (risque d'être forcé de la jouer sous un As/Roi) ?
  const bigSpadesOut = outstanding(ctx, 'spades').some((o) => rv(o) >= 13);
  const queenInDanger = (spadeCount <= 2 && bigSpadesOut) || ctx.hand.length <= 4;

  let best = null;
  let bestScore = -Infinity;
  for (const c of legal) {
    let score;
    if (isQS(c)) {
      // Garder la dame pour le joueur en tête, sauf si elle est en danger
      score = winnerIsTarget ? 200 : (queenInDanger ? 120 : 25);
    } else if (c.suit === 'spades' && rv(c) >= 13 && qOut && !hasQS) {
      score = 110; // As/Roi de pique : dangereux tant que la dame n'est pas tombée
    } else if (c.suit === 'hearts') {
      // Cœurs : pour le joueur en tête en priorité ; sinon seulement les gros
      // cœurs dangereux, en gardant les petits pour plus tard
      score = winnerIsTarget ? 90 + rv(c) : rv(c) * 3 + 5;
    } else {
      // Cartes hautes des autres couleurs, et vider les couleurs courtes
      const len = bySuit(ctx.hand, c.suit).length;
      score = rv(c) * 3 + (len <= 2 ? 10 : 0);
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// Choisit la carte à jouer.
// ctx = { hand, ledSuit, heartsBroken, trickCards, myId, players, playedCards,
//         roundScores, totalScores, moonPlan, allowMoon }
function choosePlay(ctx) {
  const legal = legalCards(ctx);
  if (legal.length === 1) return legal[0];
  if (wantsMoon(ctx)) return playMoon(ctx, legal);
  if (!ctx.trickCards.length) return chooseLead(ctx, legal);
  const follow = bySuit(legal, ctx.trickCards[0].card.suit);
  if (follow.length) return chooseFollow(ctx, follow);
  return chooseDiscard(ctx, legal);
}

// Choisit les 3 cartes à passer. Retourne aussi si le bot vise le grand chelem.
function choosePass(hand) {
  if (moonHandStrength(hand)) {
    // Garder les cartes fortes : passer les plus faibles hors cœur
    const nonHearts = hand.filter((c) => c.suit !== 'hearts').sort((a, b) => rv(a) - rv(b));
    const pool = nonHearts.length >= 3 ? nonHearts : [...hand].sort((a, b) => rv(a) - rv(b));
    return { cards: pool.slice(0, 3), moon: true };
  }
  const spades = bySuit(hand, 'spades');
  const lowSpades = spades.filter((c) => rv(c) < 12).length;
  const scored = hand.map((c) => {
    let s;
    if (isQS(c)) s = lowSpades >= 4 ? 20 : 100; // dame protégée par 4 petits piques : la garder
    else if (c.suit === 'spades' && rv(c) >= 13) s = lowSpades >= 4 ? 15 : 90;
    else if (c.suit === 'hearts') s = rv(c) >= 11 ? 50 + rv(c) : rv(c);
    else {
      const len = bySuit(hand, c.suit).length;
      s = rv(c) * 2 + (len <= 3 ? 25 : 0); // vider une couleur courte
    }
    return { c, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return { cards: scored.slice(0, 3).map((x) => x.c), moon: false };
}

// --- Bot très faible (joueur en pause) : coups légaux au hasard ---
const pickRandom = (cards) => cards[Math.floor(Math.random() * cards.length)];

function chooseWeakPlay(ctx) {
  return pickRandom(legalCards(ctx));
}

function chooseWeakPass(hand) {
  const pool = [...hand];
  const cards = [];
  while (cards.length < 3 && pool.length) cards.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return { cards, moon: false };
}

module.exports = { choosePlay, choosePass, chooseWeakPlay, chooseWeakPass, isValidPlay, moonHandStrength };
