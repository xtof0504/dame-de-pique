const { createDeck, shuffleDeck, cardPoints, cardId, cardLabel, SUITS } = require('./cards');

class Game {
  constructor(roomId, io) {
    this.roomId = roomId;
    this.io = io;
    this.players = []; // { id, name, isBot, hand: [], score: 0, ready: false }
    this.state = 'WAITING'; // WAITING, PASSING, PLAYING, ROUND_OVER, GAME_OVER
    this.currentTurn = 0;
    this.leadingSuit = null;
    this.trick = []; // { playerId, card }
    this.trickWinner = null;
    this.heartsBroken = false;
    this.roundNumber = 0;
    this.scores = {}; // playerId -> total score
    this.passDirection = 0; // 0=left, 1=right, 2=across, 3=none
    this.passedCards = {}; // playerId -> [cards]
    this.timer = null;
    this.waitStartTime = null;
  }

  addPlayer(playerId, name, isBot = false) {
    if (this.players.length >= 4) return false;
    this.players.push({ id: playerId, name, isBot, hand: [], score: 0, ready: false });
    this.scores[playerId] = 0;
    return true;
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex(p => p.id === playerId);
    if (idx !== -1) {
      this.players.splice(idx, 1);
      delete this.scores[playerId];
    }
  }

  getPlayer(playerId) {
    return this.players.find(p => p.id === playerId);
  }

  getPlayerIndex(playerId) {
    return this.players.findIndex(p => p.id === playerId);
  }

  startRound() {
    this.roundNumber++;
    this.state = 'PASSING';
    this.heartsBroken = false;
    this.trick = [];
    this.trickWinner = null;
    this.leadingSuit = null;
    this.passedCards = {};
    this.passDirection = (this.roundNumber - 1) % 4;

    const deck = shuffleDeck(createDeck());
    const handSize = 13;
    this.players.forEach((p, i) => {
      p.hand = deck.slice(i * handSize, (i + 1) * handSize);
      p.score = 0;
    });

    this.currentTurn = this.findPlayerWithTwoClubs();

    this.io.to(this.roomId).emit('roundStarted', {
      roundNumber: this.roundNumber,
      passDirection: this.passDirection,
      currentTurn: this.currentTurn,
      hands: this.players.map(p => ({ id: p.id, hand: p.hand, isBot: p.isBot }))
    });

    if (this.passDirection === 3) {
      setTimeout(() => this.completePassing(), 1000);
    }
  }

  findPlayerWithTwoClubs() {
    return this.players.findIndex(p => p.hand.some(c => cardId(c) === '2_TREFLE'));
  }

  requestPass(playerId, cardIds) {
    const player = this.getPlayer(playerId);
    if (!player || this.state !== 'PASSING') return false;
    if (cardIds.length !== 3) return false;

    const cards = cardIds.map(id => player.hand.find(c => cardId(c) === id));
    if (cards.some(c => !c)) return false;

    this.passedCards[playerId] = cards;
    player.hand = player.hand.filter(c => !cardIds.includes(cardId(c)));

    this.io.to(this.roomId).emit('passSubmitted', { playerId, count: cards.length });

    const allPassed = this.players.every(p => this.passedCards[p.id]);
    if (allPassed) this.completePassing();

    return true;
  }

  completePassing() {
    const n = this.players.length;
    const targets = this.players.map((p, i) => {
      if (this.passDirection === 0) return this.players[(i + 1) % n]; // left
      if (this.passDirection === 1) return this.players[(i + n - 1) % n]; // right
      if (this.passDirection === 2) return this.players[(i + n / 2) % n]; // across
      return p; // none
    });

    this.players.forEach((p, i) => {
      const received = this.passedCards[targets[i].id] || [];
      p.hand = [...p.hand, ...received];
    });

    this.passedCards = {};
    this.state = 'PLAYING';
    this.trick = [];
    this.leadingSuit = null;

    this.io.to(this.roomId).emit('passingComplete', {
      currentTurn: this.currentTurn,
      hands: this.players.map(p => ({ id: p.id, hand: p.hand, isBot: p.isBot }))
    });

    this.startTurnTimer();
    this.triggerBotIfNeeded();
  }

  playCard(playerId, cardId) {
    if (this.state !== 'PLAYING') return { success: false, error: 'Game not playing' };
    const player = this.getPlayer(playerId);
    if (!player) return { success: false, error: 'Player not found' };
    if (this.currentTurn !== this.getPlayerIndex(playerId)) {
      return { success: false, error: 'Not your turn' };
    }

    const cardIdx = player.hand.findIndex(c => cardId(c) === cardId);
    if (cardIdx === -1) return { success: false, error: 'Card not in hand' };

    const card = player.hand[cardIdx];

    // Must follow suit
    if (this.leadingSuit && player.hand.some(c => c.suit === this.leadingSuit && c !== card)) {
      if (card.suit !== this.leadingSuit) {
        return { success: false, error: 'Must follow suit' };
      }
    }

    // Hearts cannot be led unless broken
    if (this.trick.length === 0 && card.suit === 'CŒUR' && !this.heartsBroken) {
      if (player.hand.some(c => c.suit !== 'CŒUR')) {
        return { success: false, error: 'Hearts not broken yet' };
      }
    }

    player.hand.splice(cardIdx, 1);
    this.trick.push({ playerId, card });

    if (this.trick.length === 1) {
      this.leadingSuit = card.suit;
    }

    this.io.to(this.roomId).emit('cardPlayed', { playerId, card, trick: this.trick });

    if (this.trick.length === this.players.length) {
      this.completeTrick();
    } else {
      this.currentTurn = (this.currentTurn + 1) % this.players.length;
      this.startTurnTimer();
      this.triggerBotIfNeeded();
    }

    return { success: true, card };
  }

  completeTrick() {
    const trick = this.trick;
    const leadingSuit = this.leadingSuit;

    let winnerIdx = 0;
    let highestValue = 0;
    for (let i = 0; i < trick.length; i++) {
      const c = trick[i].card;
      if (c.suit === leadingSuit && c.value > highestValue) {
        highestValue = c.value;
        winnerIdx = i;
      }
    }

    const winner = trick[winnerIdx];
    this.trickWinner = winner.playerId;
    const points = trick.reduce((sum, t) => sum + cardPoints(t.card), 0);
    const winnerPlayer = this.getPlayer(winner.playerId);
    winnerPlayer.score += points;

    if (trick.some(t => cardPoints(t.card) > 0)) {
      this.heartsBroken = true;
    }

    this.io.to(this.roomId).emit('trickComplete', {
      winner: winner.playerId,
      points,
      cards: trick,
      scores: this.players.map(p => ({ id: p.id, score: p.score }))
    });

    this.trick = [];
    this.leadingSuit = null;

    const allEmpty = this.players.every(p => p.hand.length === 0);
    if (allEmpty) {
      this.endRound();
    } else {
      this.currentTurn = this.getPlayerIndex(winner.playerId);
      setTimeout(() => {
        this.startTurnTimer();
        this.triggerBotIfNeeded();
      }, 1500);
    }
  }

  endRound() {
    // Check shoot the moon
    const maxPoints = Math.max(...this.players.map(p => p.score));
    if (maxPoints === 26) {
      const shooter = this.players.find(p => p.score === 26);
      this.players.forEach(p => {
        if (p.id === shooter.id) p.score = 0;
        else p.score = 26;
      });
      this.io.to(this.roomId).emit('shootTheMoon', { shooter: shooter.id });
    }

    this.players.forEach(p => {
      this.scores[p.id] += p.score;
    });

    const gameOver = this.players.some(p => this.scores[p.id] >= 100);
    this.state = gameOver ? 'GAME_OVER' : 'ROUND_OVER';

    this.io.to(this.roomId).emit('roundComplete', {
      scores: this.players.map(p => ({ id: p.id, name: p.name, roundScore: p.score, total: this.scores[p.id] })),
      totalScores: this.scores,
      gameOver,
      winner: gameOver ? this.players.reduce((a, b) => this.scores[a.id] < this.scores[b.id] ? a : b) : null
    });

    if (!gameOver) {
      setTimeout(() => this.startRound(), 3000);
    }
  }

  startTurnTimer() {
    this.stopTurnTimer();
    this.timer = setTimeout(() => {
      this.autoPlayCurrentPlayer();
    }, 15000);
  }

  stopTurnTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  autoPlayCurrentPlayer() {
    const player = this.players[this.currentTurn];
    if (!player) return;

    const playable = this.getPlayableCards(player);
    const card = playable[Math.floor(Math.random() * playable.length)];
    this.playCard(player.id, cardId(card));
  }

  getPlayableCards(player) {
    if (this.trick.length === 0) {
      if (!this.heartsBroken && player.hand.some(c => c.suit !== 'CŒUR')) {
        return player.hand.filter(c => c.suit !== 'CŒUR');
      }
      return player.hand;
    }
    const follow = player.hand.filter(c => c.suit === this.leadingSuit);
    return follow.length > 0 ? follow : player.hand;
  }

  triggerBotIfNeeded() {
    const player = this.players[this.currentTurn];
    if (player && player.isBot && this.state === 'PLAYING') {
      setTimeout(() => this.autoPlayCurrentPlayer(), 1000);
    }
  }

  getState() {
    return {
      roomId: this.roomId,
      state: this.state,
      players: this.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, handCount: p.hand.length, score: p.score, ready: p.ready })),
      currentTurn: this.currentTurn,
      roundNumber: this.roundNumber,
      heartsBroken: this.heartsBroken,
      scores: this.scores,
      passDirection: this.passDirection
    };
  }

  setReady(playerId, ready) {
    const player = this.getPlayer(playerId);
    if (player) player.ready = ready;
  }

  allReady() {
    return this.players.length === 4 && this.players.every(p => p.ready);
  }
}

module.exports = Game;
