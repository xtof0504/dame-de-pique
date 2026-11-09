const SUITS = ['c', 'd', 'h', 's'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_ORDER = {};
RANKS.forEach((r, i) => { RANK_ORDER[r] = i; });

const SUIT_SYMBOL = { c: '\u2663', d: '\u2666', h: '\u2665', s: '\u2660' };

function cardPoints(card) {
  if (card.suit === 's' && card.rank === 'Q') return 13;
  if (card.suit === 'h' && card.rank === 'J') return -10;
  if (card.suit === 'c' && card.rank === '2') return -20;
  return 0;
}

function cardLabel(card) {
  return card.rank + SUIT_SYMBOL[card.suit];
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  return shuffle(deck);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function legalMoves(hand, trick, spadesBroken) {
  const ledSuit = trick.ledSuit;
  if (ledSuit) {
    const following = hand.filter(c => c.suit === ledSuit);
    if (following.length > 0) return following;
    return hand.slice();
  }
  const nonSpade = hand.filter(c => c.suit !== 's');
  if (nonSpade.length > 0 && !spadesBroken) return nonSpade;
  return hand.slice();
}

function winsTrick(card, trick) {
  if (trick.cards.length === 0) return true;
  const ledSuit = trick.ledSuit;
  if (card.suit !== ledSuit) {
    const followed = trick.cards.some(tc => tc.card.suit === ledSuit);
    return !followed;
  }
  const ledCards = trick.cards.filter(tc => tc.card.suit === ledSuit);
  return ledCards.every(tc => RANK_ORDER[tc.card.rank] <= RANK_ORDER[card.rank]);
}

function chooseMove(game, playerIndex) {
  const player = game.players[playerIndex];
  const moves = legalMoves(player.hand, game.trick, game.spadesBroken);
  let best = null, bestScore = Infinity;
  for (const card of moves) {
    const w = winsTrick(card, game.trick);
    let score = cardPoints(card);
    if (w && score >= 0) score += 0.5;
    if (!w && score < 0) score -= 0.5;
    if (score < bestScore) {
      bestScore = score; best = card;
    } else if (score === bestScore) {
      if (game.trick.cards.length === 0) {
        if (RANK_ORDER[card.rank] > RANK_ORDER[best.rank]) best = card;
      } else {
        if (RANK_ORDER[card.rank] < RANK_ORDER[best.rank]) best = card;
      }
    }
  }
  return best;
}

class Game {
  constructor(players, target) {
    this.players = players.map(p => ({ ...p, hand: [], score: 0 }));
    this.dealerIndex = 0;
    this.target = target || 100;
    this.spadesBroken = false;
    this.trick = { ledSuit: null, cards: [] };
    this.currentPlayerIndex = 0;
    this.roundOver = false;
    this.gameOver = false;
    this.winner = null;
    this.startRound();
  }

  startRound() {
    const deck = createDeck();
    for (let i = 0; i < 13; i++) {
      for (const p of this.players) p.hand.push(deck.pop());
    }
    for (const p of this.players) this.sortHand(p.hand);
    this.spadesBroken = false;
    this.trick = { ledSuit: null, cards: [] };
    this.roundOver = false;
    this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;
  }

  sortHand(hand) {
    hand.sort((a, b) => {
      if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
      return RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
    });
  }

  resolveTrick() {
    const ledSuit = this.trick.ledSuit;
    let best = this.trick.cards[0];
    for (const tc of this.trick.cards) {
      if (tc.card.suit === ledSuit && RANK_ORDER[tc.card.rank] > RANK_ORDER[best.card.rank]) best = tc;
      if (tc.card.suit === ledSuit && best.card.suit !== ledSuit) best = tc;
    }
    return best.playerIndex;
  }

  playCard(playerIndex, card) {
    const player = this.players[playerIndex];
    const idx = player.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (idx < 0) return { error: 'carte non disponible' };
    const moves = legalMoves(player.hand, this.trick, this.spadesBroken);
    if (!moves.some(c => c.suit === card.suit && c.rank === card.rank)) return { error: 'coup illegal' };

    player.hand.splice(idx, 1);
    if (this.trick.ledSuit === null) this.trick.ledSuit = card.suit;
    this.trick.cards.push({ playerIndex, card });
    if (card.suit === 's') this.spadesBroken = true;

    if (this.trick.cards.length === this.players.length) {
      const winner = this.resolveTrick();
      for (const tc of this.trick.cards) this.players[tc.playerIndex].score += cardPoints(tc.card);
      this.trick = { ledSuit: null, cards: [] };
      this.currentPlayerIndex = winner;
      if (player.hand.length === 0) {
        this.roundOver = true;
        if (this.players.some(p => p.score >= this.target)) {
          this.gameOver = true;
          const ranked = this.players.map((p, i) => ({ i, score: p.score })).sort((a, b) => a.score - b.score);
          this.winner = ranked[0].i;
        } else {
          this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
          this.startRound();
        }
      }
    } else {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    }
    return { ok: true };
  }

  serialize() {
    return {
      players: this.players.map(p => ({ id: p.id, nickname: p.nickname, isBot: p.isBot, handSize: p.hand.length, score: p.score })),
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      spadesBroken: this.spadesBroken,
      trick: this.trick,
      roundOver: this.roundOver,
      gameOver: this.gameOver,
      winner: this.winner,
      target: this.target,
    };
  }
}

module.exports = { Game, legalMoves, cardPoints, cardLabel, chooseMove, SUIT_SYMBOL };