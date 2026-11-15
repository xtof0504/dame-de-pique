const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const botAI = require('./server/bot-ai');
const cors = require('cors');

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
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
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1000000,
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

// Remet une salle à zéro : arrête ses minuteurs (y compris ceux des bots)
// et la rend de nouveau disponible dans la liste.
function resetRoom(roomId) {
  const room = rooms[roomId];
  if (room) {
    if (room.timer) clearTimeout(room.timer);
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.started = false;
    room.game = null;
  }
  initRoom(roomId);
}

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  for (const p of room.players) {
    const sock = socketsById[p.id];
    if (sock) {
      sock.emit('room_closed', { roomId, reason: 'timeout' });
      sock.leave(roomId);
    }
  }
  resetRoom(roomId);
}

for (let i = 1; i <= NB_ROOMS; i++) {
  initRoom('room-' + i);
}

function getRoom(socketId) {
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    // Un joueur remplacé par un bot n'appartient plus à la salle
    if (room.players.find(p => p.id === socketId && !p.isBot)) return room;
  }
  return null;
}

function broadcastRoom(roomId, event, data) {
  const room = rooms[roomId];
  if (!room) return;
  for (const p of room.players) {
    // Les bots n'ont pas de connexion (un humain remplacé par un bot garde
    // son identifiant, mais ne doit plus recevoir les événements de la salle)
    if (p.isBot) continue;
    const sock = socketsById[p.id];
    if (sock) sock.emit(event, data);
  }
}

// Durée d'affichage d'un pli terminé (doit correspondre à l'animation côté client)
const TRICK_PAUSE_MS = 1700; // 1 s d'affichage + 0,7 s d'animation

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

  socket.on('get_hall_of_fame', () => {
    socket.emit('hall_of_fame', { players: hallOfFameRanking() });
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

    // Refus d'une carte : prévenir le joueur pour qu'il puisse en jouer une autre
    const reject = (message) => socket.emit('error_msg', { message, playRejected: true });

    const cardIdx = player.hand.findIndex(c => sameCard(c, card));
    if (cardIdx === -1) return reject('Cette carte n\'est pas dans votre main.');

    const ledSuit = game.trickCards.length > 0 ? game.trickCards[0].card.suit : null;
    if (!isValidPlay(player.hand, card, ledSuit, game.heartsBroken)) return reject('Cette carte ne peut pas être jouée.');
    if (game.mustPass && game.mustPass[socket.id]) {
      return reject('Vous devez passer une carte en premier.');
    }

    // Premier coup du round: le joueur doit ouvrir avec le 2 de trèfle s'il le détient
    if (game.trickCards.length === 0) {
      const hasTwoClubs = player.hand.some(c => c.suit === 'clubs' && c.rank === '2');
      if (hasTwoClubs && !(card.suit === 'clubs' && card.rank === '2')) {
        return reject('Vous devez ouvrir le pli avec le 2 de trèfle.');
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
        const passCards = selectPassCardsFor(room, bot);
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
  const leaver = room.players.find(p => p.id === socketId && !p.isBot);
  if (!leaver) return;
  socketLeave(roomId, socketId);

  const gameInProgress = room.started && room.game && !room.game.gameOver;
  if (gameInProgress) {
    // Partie en cours : un bot remplace le joueur (même main, même score)
    leaver.isBot = true;
    leaver.name = leaver.name + ' (bot)';
  } else {
    room.players = room.players.filter(p => p.id !== socketId);
  }

  // Plus aucun humain (seulement des bots, ou personne) : libérer la salle
  const humans = room.players.filter(p => !p.isBot);
  if (humans.length === 0) {
    resetRoom(roomId);
    return;
  }

  if (room.host === socketId) room.host = humans[0].id;
  broadcastRoom(room.id, 'player_left', {
    players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, ready: p.ready })),
    host: room.host,
    leftId: socketId,
    replacedByBot: gameInProgress,
  });

  if (gameInProgress) resumeAfterReplacement(room, leaver);
}

// Après le remplacement d'un humain par un bot, débloquer la partie
// si elle attendait une action de ce joueur.
function resumeAfterReplacement(room, bot) {
  const game = room.game;
  if (game.phase === 'passing') {
    // Le bot passe ses cartes s'il ne l'avait pas encore fait
    if (!game.passedCards[bot.id]) {
      const passCards = selectPassCardsFor(room, bot);
      game.passedCards[bot.id] = passCards;
      for (const c of passCards) {
        const idx = bot.hand.findIndex(h => sameCard(h, c));
        if (idx !== -1) bot.hand.splice(idx, 1);
      }
      broadcastRoom(room.id, 'cards_passed', { playerId: bot.id });
      if (Object.keys(game.passedCards).length === MAX_PLAYERS) completePass(room);
    }
    return;
  }
  // Phase de jeu : on attendait peut-être sa validation des cartes reçues
  const waitingForBot = !game.passValidations[bot.id];
  game.passValidations[bot.id] = true;
  const humans = room.players.filter(p => !p.isBot);
  const allValidated = humans.every(p => game.passValidations[p.id]);
  if (waitingForBot && allValidated) {
    startTurnTimer(room);
  } else if (game.turn === bot.id) {
    // C'était son tour : le bot joue à sa place
    startTurnTimer(room);
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
    playedCards: [], // cartes des plis terminés de la manche (mémoire des bots)
    botMoon: {},     // bots qui visent tous les points cette manche
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
  // L'annonce du tour est faite par startTurnTimer (appelé juste après)
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
  game.playedCards.push(...trick.map(tc => tc.card));
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
    // Laisser le temps aux clients d'afficher le pli terminé avant le suivant
    resetTurnTimers(room);
    const currentGame = room.game;
    room.turnTimer = setTimeout(() => {
      if (room.game !== currentGame) return;
      startTurnTimer(room);
    }, TRICK_PAUSE_MS);
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
    // Manche sans passe (1 manche sur 4) : on joue directement
    const noPass = game.passingDirection === 'none';
    game.phase = noPass ? 'playing' : 'passing';
    game.trickCards = [];
    game.heartsBroken = false;
    game.currentTrickWinner = null;
    game.passedCards = {};
    // Les points de manche repartent de zéro
    for (const p of room.players) game.roundScores[p.id] = 0;
    game.playedCards = [];
    game.botMoon = {};
    for (const p of room.players) game.mustPass[p.id] = !noPass;
    for (const p of room.players) game.passValidations[p.id] = noPass;
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

// --- Hall of Fame : statistiques des joueurs humains, conservées dans un fichier ---
const HALL_OF_FAME_FILE = path.join(__dirname, 'data', 'hall-of-fame.json');
let hallOfFame = { players: {} };
try {
  hallOfFame = JSON.parse(fs.readFileSync(HALL_OF_FAME_FILE, 'utf8'));
  if (!hallOfFame.players) hallOfFame.players = {};
} catch (e) {
  // Pas encore de fichier : on part d'un classement vide
}

function saveHallOfFame() {
  fs.mkdir(path.dirname(HALL_OF_FAME_FILE), { recursive: true }, (err) => {
    if (err) return console.error('Hall of Fame : dossier impossible à créer', err);
    fs.writeFile(HALL_OF_FAME_FILE, JSON.stringify(hallOfFame, null, 2), (err2) => {
      if (err2) console.error('Hall of Fame : sauvegarde impossible', err2);
    });
  });
}

// Points du classement selon la place parmi les humains de la partie.
// n humains, place r (1 = meilleur) : (n+1)/2 - r, arrondi en s'éloignant de zéro.
//   2 humains : +1 / -1        3 humains : +1 / 0 / -1
//   4 humains : +2 / +1 / -1 / -2
// En cas d'égalité de score, les joueurs ex aequo se partagent les points de leurs places.
function rankPoints(n, r) {
  const v = (n + 1) / 2 - r;
  return Math.sign(v) * Math.ceil(Math.abs(v));
}

function computeHumanPoints(results) {
  // results : [{ name, score }] ; score le plus bas = meilleure place
  const sorted = [...results].sort((a, b) => a.score - b.score);
  const n = sorted.length;
  const points = {};
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1].score === sorted[i].score) j++;
    let sum = 0;
    for (let r = i + 1; r <= j + 1; r++) sum += rankPoints(n, r);
    const share = sum / (j - i + 1);
    for (let k = i; k <= j; k++) points[sorted[k].name] = share;
    i = j + 1;
  }
  return points;
}

// Enregistre une partie terminée normalement.
// Seules les parties avec au moins 2 humains comptent (contre des bots seulement :
// les statistiques ne changent pas).
function recordGameResult(room) {
  const game = room.game;
  const humans = room.players.filter(p => !p.isBot);
  if (humans.length < 2) return;
  const results = humans.map(p => ({ name: p.name, score: game.scores[p.id] }));
  const points = computeHumanPoints(results);
  const bestHumanScore = Math.min(...results.map(r => r.score));
  for (const r of results) {
    const stats = hallOfFame.players[r.name] || { name: r.name };
    stats.points = (stats.points || 0) + points[r.name];
    stats.games = (stats.games || 0) + 1;
    stats.wins = (stats.wins || 0) + (r.score === bestHumanScore ? 1 : 0);
    if (stats.bestScore === undefined || stats.bestScore === null || r.score < stats.bestScore) stats.bestScore = r.score;
    stats.lastPlayed = new Date().toISOString();
    hallOfFame.players[r.name] = stats;
  }
  saveHallOfFame();
}

// Classement : points, puis victoires, puis moins de parties jouées
function hallOfFameRanking() {
  return Object.values(hallOfFame.players)
    .map(p => ({ name: p.name, points: p.points || 0, games: p.games || 0, wins: p.wins || 0, bestScore: p.bestScore ?? null }))
    .sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (a.games - b.games));
}

function endGame(room, reason) {
  const game = room.game;
  if (game.gameOver) return;
  game.gameOver = true;
  resetTurnTimers(room);
  if (reason === 'normal') recordGameResult(room);
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

// --- Choix des bots (voir server/bot-ai.js) ---

function botContext(room, player, allowMoon) {
  const game = room.game;
  return {
    hand: player.hand,
    ledSuit: game.trickCards.length > 0 ? game.trickCards[0].card.suit : null,
    heartsBroken: game.heartsBroken,
    trickCards: game.trickCards,
    myId: player.id,
    players: room.players.map(p => p.id),
    playedCards: game.playedCards || [],
    roundScores: game.roundScores,
    totalScores: game.scores,
    moonPlan: allowMoon && !!(game.botMoon && game.botMoon[player.id]),
    allowMoon,
  };
}

// allowMoon = false pour un humain dont le temps est écoulé (on joue prudemment pour lui)
function selectPlayCardFor(room, player, allowMoon = true) {
  return botAI.choosePlay(botContext(room, player, allowMoon));
}

function selectPassCardsFor(room, player) {
  const { cards, moon } = botAI.choosePass(player.hand);
  if (!room.game.botMoon) room.game.botMoon = {};
  room.game.botMoon[player.id] = moon;
  return cards;
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
    const card = selectPlayCardFor(room, current, false);
    if (card) playCardLogic(room, current.id, card);
  }, 60000);
}

function botPlay(room) {
  const game = room.game;
  if (!room.started || !room.game || game.gameOver) return;
  const current = room.players.find(p => p.id === game.turn);
  if (!current || !current.isBot) return;

  if (game.phase === 'passing') {
    const passCards = selectPassCardsFor(room, current);
    playCardLogicPass(room, current.id, passCards);
    return;
  }

  const card = selectPlayCardFor(room, current);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('Serveur Dame de Pique lancé sur le port ' + PORT);
});
