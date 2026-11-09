const SUITS = ['CŒUR', 'CARREAU', 'TREFLE', 'PIQUE'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];

const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'V': 11, 'D': 12, 'R': 13, 'A': 14
};

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUE[rank] });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function cardPoints(card) {
  if (card.suit === 'CŒUR') return 1;
  if (card.suit === 'PIQUE' && card.rank === 'D') return 13;
  return 0;
}

function cardId(card) {
  return `${card.rank}_${card.suit}`;
}

function cardLabel(card) {
  const labels = { 'V': 'Valet', 'D': 'Dame', 'R': 'Roi', 'A': 'As' };
  const rankLabel = labels[card.rank] || card.rank;
  return `${rankLabel} de ${card.suit}`;
}

module.exports = { SUITS, RANKS, RANK_VALUE, createDeck, shuffleDeck, cardPoints, cardId, cardLabel };
