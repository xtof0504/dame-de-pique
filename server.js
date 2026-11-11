const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const NB_ROOMS = 10;
const ROOM_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_PLAYERS = 4;
const MIN_HUMANS = 4;
const MAX_HUMANS = 3;

const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };

function createDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function cardKey(card) {
  return card.suit + ':' + card.rank;
}

function sameCard(a, b) {
  return a.suit === b.suit && a.rank === b.rank;
}

const rooms = {};
const socketsById = {};
const playerSockets = {};

function initRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    players: [],
    started: false,
    game: null,
    createdAt: Date.now(),
    timer: null,
    host: null,
  };
}

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  for (const p of room.players) {
    const sock = socketsById[p.id];
    if (sock) {
      sock.emit('room_closed', { roomId, reason: 'timeout' });
      sock.leave(roomId);
    }
  }
  delete rooms[roomId];
}

for (let i = 1; i <= NB_ROOMS; i++) {
  initRoom('room-' + i);
}

function getRoom(socketId) {
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (room.players.find(p => p.id === socketId)) return room;
  }
  return null;
}

function broadcastRoom(roomId, event, data) {
  const room = rooms[roomId];
  if (!room) return;
  for (const p of room.players) {
    const sock = socketsById[p.id];
    if (sock) sock.emit(event, data);
  }
}

function resetTurnTimers(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
}

io.on('connection', (socket) => {
  socketsById[socket.id] = socket;

  socket.on('get_rooms', () => {
    const list = Object.values(rooms).map((r) => ({
      id: r.id,
      players: r.players.length,
      started: r.started,
      playerNames: r.players.map(p => p.name),
      hasHumans: r.players.some(p => !p.isBot),
    }));
    socket.emit('rooms_list', list);
  });

  socket.on('join', ({ name, roomId }) => {
    if (!name || name.trim() === '') {
      socket.emit('error_msg', { message: 'Veuillez saisir un surnom.' });
      return;
    }
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error_msg', { message: 'Salle introuvable.' });
      return;
    }
    if (room.started) {
      socket.emit('error_msg', { message: 'La partie a déjà commencé dans cette salle.' });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('error_msg', { message: 'Salle complète (4 joueurs).' });
      return;
    }
    if (room.players.find(p => p.name === name.trim())) {
      socket.emit('error_msg', { message: 'Ce surnom est déjà pris dans cette salle.' });
      return;
    }

    const prevRoom = getRoom(socket.id);
    if (prevRoom) {
      leaveRoomInternal(socket.id, prevRoom.id);
    }

    const isBot = false;
    const player = {
      id: socket.id,
      name: name.trim(),
      isBot: false,
      ready: false,
      hand: [],
      score: 0,
      tricksTaken: 0,
      heartsTaken: 0,
      queenSpades: false,
    };
    room.players.push(player);
    playerSockets[socket.id] = player;
    socket.join(roomId);

    if (!room.host) room.host = socket.id;

    socket.emit('joined', {
      playerId: socket.id,
      name: player.name,
      roomId: room.id,
      players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, ready: p.ready })),
      host: room.host,
      started: room.started,
    });
    broadcastRoom(room.id, 'player_joined', {
      players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, ready: p.ready })),
      host: room.host,
      joined: player,
    });
  });

  socket.on('set_ready', ({ roomId, ready }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isBot) return;
    player.ready = ready;
    broadcastRoom(room.id, 'player_ready', {
      players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, ready: p.ready })),
    });
    maybeStartGame(roomId);
  });

  socket.on('start_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.host !== socket.id) {
      socket.emit('error_msg', { message: 'Seul l\'hôte peut démarrer la partie.' });
      return;
    }
    maybeStartGame(roomId, true);
  });

  socket.on('play_card', ({ roomId, card }) => {
    const room = rooms[roomId];
    if (!room || !room.started || !room.game) return;
    const game = room.game;
    if (game.turn !== socket.id) return;
    if (game.phase !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const cardIdx = player.hand.findIndex(c => sameCard(c, card));
    if (cardIdx === -1) return;

    const ledSuit = game.trickCards.length > 0 ? game.trickCards[0].card.suit : null;
    if (!isValidPlay(player.hand, card, ledSuit, game.heartsBroken)) return;
    if (game.mustPass && game.mustPass[socket.id]) {
      socket.emit('error_msg', { message: 'Vous devez passer une carte en premier.' });
      return;
    }

    // Premier coup du round: le joueur doit ouvrir avec le 2 de trèfle s'il le détient
    if (game.trickCards.length === 0) {
      const hasTwoClubs = player.hand.some(c => c.suit === 'clubs' && c.rank === '2');
      if (hasTwoClubs && !(card.suit === 'clubs' && card.rank === '2')) {
        socket.emit('error_msg', { message: 'Vous devez ouvrir le pli avec le 2 de trèfle.' });
        return;
      }
    }

    const playedCard = player.hand.splice(cardIdx, 1)[0];
    game.trickCards.push({ playerId: socket.id, card: playedCard });
    if (playedCard.suit === 'hearts') game.heartsBroken = true;

    resetTurnTimers(room);
    broadcastRoom(room.id, 'card_played', {
      playerId: socket.id,
      card: playedCard,
      trickCards: game.trickCards.map(tc => ({ playerId: tc.playerId, card: tc.card })),
      heartsBroken: game.heartsBroken,
    });

    if (game.trickCards.length === MAX_PLAYERS) {
      resolveTrick(room);
    } else {
      advanceTurn(room);
      startTurnTimer(room);
    }
  });

  socket.on('pass_cards', ({ roomId, cards }) => {
    const room = rooms[roomId];
    if (!room || !room.started || !room.game) return;
    const game = room.game;
    if (game.phase !== 'passing') return;
    if (game.passedCards[socket.id]) return;
    if (cards.length !== 3) {
      socket.emit('error_msg', { message: 'Vous devez passer exactement 3 cartes.' });
      return;
    }
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    for (const c of cards) {
      if (!player.hand.find(h => sameCard(h, c))) {
        socket.emit('error_msg', { message: 'Carte invalide pour la passe.' });
        return;
      }
    }
    game.passedCards[socket.id] = cards;
    broadcastRoom(room.id, 'cards_passed', { playerId: socket.id });

    const allPassed = Object.keys(game.passedCards).length === MAX_PLAYERS;
    if (allPassed) {
      completePass(room);
    } else {
      // Faire passer automatiquement les bots restants
      const remainingBots = room.players.filter(p => !game.passedCards[p.id] && p.isBot);
      for (const bot of remainingBots) {
        const passCards = selectPassCards(bot.hand);
        game.passedCards[bot.id] = passCards;
        for (const c of passCards) {
          const idx = bot.hand.findIndex(h => sameCard(h, c));
          if (idx !== -1) bot.hand.splice(idx, 1);
        }
        broadcastRoom(room.id, 'cards_passed', { playerId: bot.id });
      }
      const allPassedNow = Object.keys(game.passedCards).length === MAX_PLAYERS;
      if (allPassedNow) completePass(room);
    }
  });

  socket.on('pass_validated', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.game) return;
    room.game.passValidations[socket.id] = true;
    const humans = room.players.filter(p => !p.isBot);
    const allValidated = humans.every(p => room.game.passValidations[p.id]);
    if (allValidated) {
      startTurnTimer(room);
    }
  });

  socket.on('leave_room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    leaveRoomInternal(socket.id, roomId);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.id);
    if (room) leaveRoomInternal(socket.id, room.id);
    delete socketsById[socket.id];
    delete playerSockets[socket.id];
  });
});

function leaveRoomInternal(socketId, roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socketId);
  socketLeave(roomId, socketId);
  if (room.players.length === 0) {
    if (room.timer) clearTimeout(room.timer);
    delete rooms[roomId];
    initRoom(roomId);
  } else {
    if (room.host === socketId) room.host = room.players[0].id;
    broadcastRoom(room.id, 'player_left', {
      players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, ready: p.ready })),
      host: room.host,
      leftId: socketId,
    });
    if (room.started && room.game) {
      endGame(room, 'disconnect');
    }
  }
}

function socketLeave(roomId, socketId) {
  const sock = socketsById[socketId];
  if (sock) sock.leave(roomId);
}

function maybeStartGame(roomId, forced) {
  const room = rooms[roomId];
  if (!room || room.started) return;
  const humans = room.players.filter(p => !p.isBot);
  if (!forced && humans.length < MIN_HUMANS) return;
  if (!forced) {
    const allReady = humans.every(p => p.ready);
    if (!allReady) return;
  }
  startGame(roomId);
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.started) return;
  room.started = true;

  const humans = room.players.filter(p => !p.isBot);
  const botsNeeded = MAX_PLAYERS - humans.length;
  const botNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Hugo', 'Iris', 'Jack'];
  let botIdx = 0;
  for (let i = 0; i < botsNeeded; i++) {
    const bot = {
      id: 'bot-' + Date.now() + '-' + i,
      name: botNames[botIdx % botNames.length],
      isBot: true,
      ready: true,
      hand: [],
      score: 0,
      tricksTaken: 0,
      heartsTaken: 0,
      queenSpades: false,
    };
    room.players.push(bot);
    botIdx++;
  }

  dealCards(room);
  shufflePlayers(room);
  initGameState(room);

  broadcastRoom(room.id, 'game_started', {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      handCount: p.hand.length,
      score: p.score,
    })),
    hands: room.players.reduce((acc, p) => {
      acc[p.id] = p.hand;
      return acc;
    }, {}),
    currentTurn: gameCurrentTurn(room.game),
    heartsBroken: room.game.heartsBroken,
    passingDirection: room.game.passingDirection,
  });

  if (room.game.passingDirection !== 'none') {
    startTurnTimer(room);
  } else {
    startTurnTimer(room);
  }
}

function shufflePlayers(room) {
  const order = [...room.players].sort(() => Math.random() - 0.5);
  const twoClubsIdx = order.findIndex(p =>
    p.hand && p.hand.find(c => c.suit === 'clubs' && c.rank === '2')
  );
  if (twoClubsIdx === -1) {
    room.players = order;
  } else {
    room.players = [...order.slice(twoClubsIdx), ...order.slice(0, twoClubsIdx)];
  }
}

function dealCards(room) {
  const deck = shuffle(createDeck());
  let idx = 0;
  for (const p of room.players) {
    p.hand = deck.slice(idx, idx + 13);
    idx += 13;
    p.hand.sort(sortCards);
  }
}

function sortCards(a, b) {
  const suitOrder = { clubs: 0, diamonds: 1, spades: 2, hearts: 3 };
  if (suitOrder[a.suit] !== suitOrder[b.suit]) return suitOrder[a.suit] - suitOrder[b.suit];
  return rankValue[a.rank] - rankValue[b.rank];
}

function initGameState(room) {
  const firstPlayer = room.players.find(p =>
    p.hand.find(c => c.suit === 'clubs' && c.rank === '2')
  );
  room.game = {
    phase: 'passing',
    turn: firstPlayer ? firstPlayer.id : room.players[0].id,
    trickCards: [],
    heartsBroken: false,
    scores: room.players.reduce((acc, p) => { acc[p.id] = 0; return acc; }, {}),
    roundScores: room.players.reduce((acc, p) => { acc[p.id] = 0; return acc; }, {}),
    tricks: room.players.reduce((acc, p) => { acc[p.id] = []; return acc; }, {}),
    currentTrickWinner: null,
    passingDirection: 'left',
    passedCards: {},
    passPhase: true,
    passValidations: {},
    mustPass: {},
    round: 1,
    gameOver: false,
  };
  for (const p of room.players) room.game.mustPass[p.id] = true;
}

function gameCurrentTurn(game) {
  return game.turn;
}

function advanceTurn(room) {
  const game = room.game;
  const idx = room.players.findIndex(p => p.id === game.turn);
  game.turn = room.players[(idx + 1) % MAX_PLAYERS].id;
  notifyTurn(room);
}

function notifyTurn(room) {
  broadcastRoom(room.id, 'turn_changed', { turn: room.game.turn });
}

function isValidPlay(hand, card, ledSuit, heartsBroken) {
  const hasLed = ledSuit ? hand.some(c => c.suit === ledSuit) : false;
  if (ledSuit && hasLed) {
    return card.suit === ledSuit;
  }
  if (ledSuit === 'hearts' && !heartsBroken) {
    const onlyHearts = hand.every(c => c.suit === 'hearts');
    if (!onlyHearts && card.suit === 'hearts') return false;
  }
  if (ledSuit === null && card.suit === 'hearts' && !heartsBroken) {
    const onlyHearts = hand.every(c => c.suit === 'hearts');
    if (!onlyHearts) return false;
  }
  return true;
}

function resolveTrick(room) {
  const game = room.game;
  const trick = game.trickCards;
  const ledSuit = trick[0].card.suit;
  let winner = trick[0];
  let highest = rankValue[winner.card.rank];

  for (let i = 1; i < trick.length; i++) {
    const tc = trick[i];
    if (tc.card.suit === ledSuit && rankValue[tc.card.rank] > highest) {
      highest = rankValue[tc.card.rank];
      winner = tc;
    }
  }

  let points = 0;
  for (const tc of trick) {
    if (tc.card.suit === 'hearts') points += 1;
    if (tc.card.suit === 'spades' && tc.card.rank === 'Q') points += 13;
  }

  game.tricks[winner.playerId].push(...trick.map(tc => tc.card));
  game.roundScores[winner.playerId] += points;
  game.currentTrickWinner = winner.playerId;

  const player = room.players.find(p => p.id === winner.playerId);
  if (player) {
    player.tricksTaken += 1;
    player.heartsTaken += trick.filter(tc => tc.card.suit === 'hearts').length;
    if (trick.some(tc => tc.card.suit === 'spades' && tc.card.rank === 'Q')) player.queenSpades = true;
  }

  broadcastRoom(room.id, 'trick_ended', {
    winner: winner.playerId,
    winnerName: player ? player.name : 'Joueur',
    cards: trick.map(tc => ({ playerId: tc.playerId, card: tc.card })),
    points,
    roundScores: game.roundScores,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
  });

  game.trickCards = [];
  game.turn = winner.playerId;

  const totalCardsPlayed = room.players.reduce((sum, p) => sum + (13 - p.hand.length), 0);
  if (totalCardsPlayed === 52) {
    endRound(room);
  } else {
    startTurnTimer(room);
  }
}

function endRound(room) {
  const game = room.game;
  let moonShot = false;
  for (const p of room.players) {
    if (game.roundScores[p.id] === 26) {
      moonShot = true;
      break;
    }
  }

  if (moonShot) {
    for (const p of room.players) {
      if (game.roundScores[p.id] === 26) {
        game.roundScores[p.id] = 0;
      } else {
        game.roundScores[p.id] = 26;
      }
    }
  }

  for (const p of room.players) {
    game.scores[p.id] += game.roundScores[p.id];
  }

  let gameOver = false;
  let winnerId = null;
  for (const p of room.players) {
    if (game.scores[p.id] >= 100) {
      gameOver = true;
    }
  }
  if (!gameOver) {
    const minScore = Math.min(...Object.values(game.scores));
    winnerId = room.players.find(p => game.scores[p.id] === minScore).id;
  }

  const dirs = ['left', 'across', 'right', 'none'];
  const curIdx = dirs.indexOf(game.passingDirection);
  game.passingDirection = dirs[(curIdx + 1) % dirs.length];

  broadcastRoom(room.id, 'round_ended', {
    scores: game.scores,
    roundScores: game.roundScores,
    moonShot,
    gameOver,
    winnerId,
    passingDirection: game.passingDirection,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
  });

  if (gameOver) {
    endGame(room, 'normal');
  } else {
    game.round += 1;
    game.phase = 'passing';
    game.trickCards = [];
    game.heartsBroken = false;
    game.currentTrickWinner = null;
    game.passedCards = {};
    for (const p of room.players) game.mustPass[p.id] = true;
    dealCards(room);
    const firstPlayer = room.players.find(p =>
      p.hand.find(c => c.suit === 'clubs' && c.rank === '2')
    );
    game.turn = firstPlayer ? firstPlayer.id : room.players[0].id;

    broadcastRoom(room.id, 'new_round', {
      hands: room.players.reduce((acc, p) => { acc[p.id] = p.hand; return acc; }, {}),
      currentTurn: game.turn,
      round: game.round,
      scores: game.scores,
      passingDirection: game.passingDirection,
    });

    startTurnTimer(room);
  }
}

function endGame(room, reason) {
  const game = room.game;
  game.gameOver = true;
  resetTurnTimers(room);
  broadcastRoom(room.id, 'game_over', {
    scores: game.scores,
    reason,
  });
}

function completePass(room) {
  const game = room.game;
  const order = [...room.players];
  const n = order.length;
  const dir = game.passingDirection;

  for (let i = 0; i < n; i++) {
    const giverId = order[i].id;
    let receiverIdx;
    if (dir === 'left') receiverIdx = (i + 1) % n;
    else if (dir === 'right') receiverIdx = (i - 1 + n) % n;
    else if (dir === 'across') receiverIdx = (i + 2) % n;
    else receiverIdx = (i + 1) % n;
    const receiverId = order[receiverIdx].id;
    const cards = game.passedCards[giverId] || [];

    const giver = room.players.find(p => p.id === giverId);
    if (giver) {
      for (const c of cards) {
        const idx = giver.hand.findIndex(h => sameCard(h, c));
        if (idx !== -1) giver.hand.splice(idx, 1);
      }
    }

    const receiver = room.players.find(p => p.id === receiverId);
    if (receiver) {
      receiver.hand.push(...cards);
      receiver.hand.sort(sortCards);
    }
  }

  game.phase = 'playing';
  for (const p of room.players) game.mustPass[p.id] = false;
  for (const p of room.players) game.passValidations[p.id] = false;

  broadcastRoom(room.id, 'pass_complete', {
    hands: room.players.reduce((acc, p) => { acc[p.id] = p.hand; return acc; }, {}),
    currentTurn: game.turn,
  });
  // Le timer est démarré quand tous les joueurs ont validé (socket pass_validated)
}

function cardSortKey(c) {
  let score = 0;
  if (c.suit === 'spades' && c.rank === 'Q') score += 100;
  if (c.suit === 'hearts') {
    score += 50;
    score += rankValue[c.rank] * 2;
  }
  score += rankValue[c.rank];
  if (c.suit === 'spades' && rankValue[c.rank] >= 11) score += 20;
  return score;
}

function selectPassCards(hand) {
  return [...hand].sort((a, b) => cardSortKey(b) - cardSortKey(a)).slice(0, 3);
}

function selectPlayCard(hand, ledSuit, heartsBroken, trickCards) {
  const playable = hand.filter(c => isValidPlay(hand, c, ledSuit, heartsBroken));
  if (playable.length === 0) return hand[0] || null;

  if (ledSuit === null) {
    let candidates = playable;
    if (!heartsBroken) {
      const nonHearts = playable.filter(c => c.suit !== 'hearts');
      if (nonHearts.length > 0) candidates = nonHearts;
    }
    const noQueen = candidates.filter(c => !(c.suit === 'spades' && c.rank === 'Q'));
    if (noQueen.length > 0) candidates = noQueen;
    candidates.sort((a, b) => rankValue[a.rank] - rankValue[b.rank]);
    return candidates[0];
  }

  const sameSuit = playable.filter(c => c.suit === ledSuit);
  if (sameSuit.length > 0) {
    const bestOnTable = trickCards
      .filter(tc => tc.card.suit === ledSuit)
      .map(tc => rankValue[tc.card.rank]);
    const maxTable = bestOnTable.length > 0 ? Math.max(...bestOnTable) : 0;

    const canAvoid = sameSuit.filter(c => rankValue[c.rank] < maxTable);
    if (canAvoid.length > 0) {
      const noQueen = canAvoid.filter(c => !(c.suit === 'spades' && c.rank === 'Q'));
      if (noQueen.length > 0) {
        noQueen.sort((a, b) => rankValue[b.rank] - rankValue[a.rank]);
        return noQueen[0];
      }
      canAvoid.sort((a, b) => rankValue[b.rank] - rankValue[a.rank]);
      return canAvoid[0];
    }
    sameSuit.sort((a, b) => rankValue[a.rank] - rankValue[b.rank]);
    const noQueen = sameSuit.filter(c => !(c.suit === 'spades' && c.rank === 'Q'));
    if (noQueen.length > 0) return noQueen[0];
    return sameSuit[0];
  }

  const noQueen = playable.filter(c => !(c.suit === 'spades' && c.rank === 'Q'));
  if (noQueen.length > 0) {
    noQueen.sort((a, b) => rankValue[a.rank] - rankValue[b.rank]);
    return noQueen[0];
  }
  playable.sort((a, b) => rankValue[a.rank] - rankValue[b.rank]);
  return playable[0];
}

function startTurnTimer(room) {
  resetTurnTimers(room);
  if (!room.started || !room.game) return;
  const game = room.game;
  if (game.gameOver || game.phase === 'passing') return;
  const current = room.players.find(p => p.id === game.turn);
  notifyTurn(room);
  if (!current || current.isBot) {
    room.turnTimer = setTimeout(() => botPlay(room), 1500);
    return;
  }
  room.turnTimer = setTimeout(() => {
    if (!room.game || room.game.turn !== current.id) return;
    const playable = current.hand.filter(c => isValidPlay(current.hand, c, game.trickCards.length > 0 ? game.trickCards[0].card.suit : null, game.heartsBroken));
    const card = selectPlayCard(current.hand, game.trickCards.length > 0 ? game.trickCards[0].card.suit : null, game.heartsBroken, game.trickCards);
    if (card) playCardLogic(room, current.id, card);
  }, 60000);
}

function botPlay(room) {
  const game = room.game;
  if (!room.started || !room.game || game.gameOver) return;
  const current = room.players.find(p => p.id === game.turn);
  if (!current || !current.isBot) return;

  if (game.phase === 'passing') {
    const passCards = selectPassCards(current.hand);
    socketEmitTo(current.id, 'bot_pass', { cards: passCards });
    playCardLogicPass(room, current.id, passCards);
    return;
  }

  const ledSuit = game.trickCards.length > 0 ? game.trickCards[0].card.suit : null;
  const card = selectPlayCard(current.hand, ledSuit, game.heartsBroken, game.trickCards);
  if (card) playCardLogic(room, current.id, card);
}

function playCardLogic(room, socketId, card) {
  const game = room.game;
  const player = room.players.find(p => p.id === socketId);
  if (!player) return;
  const cardIdx = player.hand.findIndex(c => sameCard(c, card));
  if (cardIdx === -1) return;
  const ledSuit = game.trickCards.length > 0 ? game.trickCards[0].card.suit : null;
  if (!isValidPlay(player.hand, card, ledSuit, game.heartsBroken)) return;
  // Premier coup du round: le joueur doit ouvrir avec le 2 de trèfle s'il le détient
  if (game.trickCards.length === 0) {
    const hasTwoClubs = player.hand.some(c => c.suit === 'clubs' && c.rank === '2');
    if (hasTwoClubs && !(card.suit === 'clubs' && card.rank === '2')) {
      socketEmitTo(socketId, 'error_msg', { message: 'Vous devez ouvrir le pli avec le 2 de trèfle.' });
      return;
    }
  }
  const playedCard = player.hand.splice(cardIdx, 1)[0];
  game.trickCards.push({ playerId: socketId, card: playedCard });
  if (playedCard.suit === 'hearts') game.heartsBroken = true;

  resetTurnTimers(room);
  broadcastRoom(room.id, 'card_played', {
    playerId: socketId,
    card: playedCard,
    trickCards: game.trickCards.map(tc => ({ playerId: tc.playerId, card: tc.card })),
    heartsBroken: game.heartsBroken,
  });

  if (game.trickCards.length === MAX_PLAYERS) {
    resolveTrick(room);
  } else {
    advanceTurn(room);
    startTurnTimer(room);
  }
}

function playCardLogicPass(room, socketId, cards) {
  const game = room.game;
  const player = room.players.find(p => p.id === socketId);
  if (!player) return;
  for (const c of cards) {
    const idx = player.hand.findIndex(h => sameCard(h, c));
    if (idx !== -1) player.hand.splice(idx, 1);
  }
  game.passedCards[socketId] = cards;
  broadcastRoom(room.id, 'cards_passed', { playerId: socketId });

  const allPassed = Object.keys(game.passedCards).length === MAX_PLAYERS;
  if (allPassed) completePass(room);
}

function socketEmitTo(socketId, event, data) {
  const sock = socketsById[socketId];
  if (sock) sock.emit(event, data);
}

server.listen(PORT, () => {
  console.log('Serveur Dame de Pique lancé sur le port ' + PORT);
});
