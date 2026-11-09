const { cardPoints, cardId } = require('../game/cards');

class Bot {
  constructor(playerId, name, difficulty = 'medium') {
    this.playerId = playerId;
    this.name = name;
    this.difficulty = difficulty;
  }

  choosePass(playerHand, passDirection) {
    const hearts = playerHand.filter(c => c.suit === 'CŒUR');
    const spades = playerHand.filter(c => c.suit === 'PIQUE');
    const queenSpade = spades.find(c => c.rank === 'D');

    let toPass = [];

    if (passDirection === 3) return [];

    // Pass high hearts
    const highHearts = hearts.filter(c => c.value >= 10).sort((a, b) => b.value - a.value);
    toPass = toPass.concat(highHearts.slice(0, 3));

    if (toPass.length < 3 && queenSpade) {
      toPass.push(queenSpade);
    }

    if (toPass.length < 3) {
      const highSpades = spades.filter(c => c !== queenSpade).sort((a, b) => b.value - a.value);
      toPass = toPass.concat(highSpades.slice(0, 3 - toPass.length));
    }

    if (toPass.length < 3) {
      const others = playerHand.filter(c => !toPass.includes(c)).sort((a, b) => b.value - a.value);
      toPass = toPass.concat(others.slice(0, 3 - toPass.length));
    }

    return toPass.slice(0, 3).map(c => cardId(c));
  }

  chooseCard(playerHand, gameState) {
    const playable = this.getPlayableCards(playerHand, gameState);

    if (this.difficulty === 'easy') {
      return playable[Math.floor(Math.random() * playable.length)];
    }

    if (gameState.trick.length === 0) {
      return this.chooseLead(playable, playerHand);
    }

    return this.chooseFollow(playable, gameState);
  }

  getPlayableCards(playerHand, gameState) {
    if (gameState.trick.length === 0) {
      if (!gameState.heartsBroken && playerHand.some(c => c.suit !== 'CŒUR')) {
        return playerHand.filter(c => c.suit !== 'CŒUR');
      }
      return playerHand;
    }
    const follow = playerHand.filter(c => c.suit === gameState.leadingSuit);
    return follow.length > 0 ? follow : playerHand;
  }

  chooseLead(playable, playerHand) {
    // Lead low non-heart cards if possible
    const nonHearts = playable.filter(c => c.suit !== 'CŒUR');
    if (nonHearts.length > 0) {
      return nonHearts.sort((a, b) => a.value - b.value)[0];
    }
    return playable.sort((a, b) => a.value - b.value)[0];
  }

  chooseFollow(playable, gameState) {
    const leadingSuit = gameState.leadingSuit;
    const currentHighest = gameState.trick
      .filter(t => t.card.suit === leadingSuit)
      .reduce((max, t) => (t.card.value > max ? t.card.value : max), 0);

    // Try to win if we can and it's safe, or dump high cards
    const canWin = playable.filter(c => c.suit === leadingSuit && c.value > currentHighest);

    if (canWin.length > 0) {
      // If we can win, check if taking points is bad
      const trickPoints = gameState.trick.reduce((sum, t) => sum + cardPoints(t.card), 0);
      if (trickPoints === 0) {
        return canWin.sort((a, b) => a.value - b.value)[0]; // win cheaply
      }
      // Don't take points if we can avoid
      const safe = playable.filter(c => !(c.suit === 'CŒUR' || (c.suit === 'PIQUE' && c.rank === 'D')));
      if (safe.length > 0) {
        return safe.sort((a, b) => b.value - a.value)[0]; // dump high safe card
      }
    }

    // Dump highest card of leading suit, or highest heart/queen if void
    return playable.sort((a, b) => b.value - a.value)[0];
  }
}

module.exports = Bot;
