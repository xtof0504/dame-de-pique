const socket = io();

let nickname = '';
let currentRoomId = null;
let myPlayerId = null;
let myHand = [];
let gameState = null;
let selectedCard = null;
let pendingCurrentTurn = null;
let roomsData = [];
let turnTimer = null;
let turnTimeLeft = 0;
let playersById = {};

// Affichage des erreurs JS directement sur la page
window.onerror = (msg, url, line) => {
  const el = document.getElementById('js-error');
  if (el) {
    el.textContent = 'Erreur JS : ' + msg + ' (ligne ' + line + ')';
    el.style.display = 'block';
  }
  console.error(msg, url, line);
  return true;
};

const screens = {
  nickname: 'screen-nickname',
  rooms: 'screen-rooms',
  waiting: 'screen-waiting',
  game: 'screen-game',
};

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  const el = document.getElementById(screenId);
  if (el) {
    el.classList.remove('hidden');
    el.classList.add('active');
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showModal(title, body) {
  setText('modal-title', title);
  setText('modal-body', body);
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('modal').classList.remove('hidden');
}

function hideModal() {
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('modal').classList.add('hidden');
}

document.getElementById('modal-ok').addEventListener('click', hideModal);

// Style visuel pour les cartes reçues lors du passage
const receivedStyle = document.createElement('style');
receivedStyle.textContent = `
  .game-card.received {
    border-color: var(--success);
    background: #d1fae5;
    box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.3);
    transform: translateY(-8px) scale(1.02);
    z-index: 10;
  }
`;
document.head.appendChild(receivedStyle);

// Nickname screen
const nicknameInput = document.getElementById('nickname');
const btnContinue = document.getElementById('btn-continue');

// Charger le surnom précédent
const savedNickname = localStorage.getItem('damepique_nickname');
if (savedNickname) {
  nicknameInput.value = savedNickname;
  nickname = savedNickname;
  btnContinue.disabled = savedNickname.length === 0;
}

nicknameInput.addEventListener('input', () => {
  nickname = nicknameInput.value.trim();
  btnContinue.disabled = nickname.length === 0;
  localStorage.setItem('damepique_nickname', nicknameInput.value.trim());
});

btnContinue.addEventListener('click', () => {
  nickname = nicknameInput.value.trim();
  if (!nickname) return;
  localStorage.setItem('damepique_nickname', nickname);
  show(screens.rooms);
  loadRooms();
});

// Rooms screen
const roomsGrid = document.getElementById('rooms-grid');
const roomStatus = document.getElementById('room-status');
const btnBackRooms = document.getElementById('btn-back-rooms');

btnBackRooms.addEventListener('click', () => {
  show(screens.nickname);
});

function loadRooms() {
  roomsGrid.innerHTML = '';
  roomStatus.textContent = 'Chargement des salles...';
  socket.emit('get_rooms');
}

socket.on('rooms_list', (rooms) => {
  roomsData = rooms;
  roomsGrid.innerHTML = '';
  const now = Date.now();
  rooms.forEach((room) => {
    const btn = document.createElement('button');
    btn.className = 'room-btn';
    const names = (room.playerNames || []).join(', ');
    const onlyBots = !room.hasHumans;
    btn.textContent = 'Salle ' + room.id.replace('room-', '') + (onlyBots ? ' (libre)' : ' - ' + names);
    btn.title = onlyBots ? 'Salle libre (que des bots)' : 'Joueurs : ' + names;
    if (room.started) {
      btn.classList.add('started');
      btn.disabled = true;
      btn.title = 'Partie en cours';
    } else if (room.players.length >= 4) {
      btn.classList.add('full');
      btn.disabled = true;
      btn.title = 'Salle complète';
    } else {
      btn.addEventListener('click', () => joinRoom(room.id));
    }
    roomsGrid.appendChild(btn);
  });
  const humanRooms = rooms.filter(r => !r.started && r.players.length < 4);
  roomStatus.textContent = humanRooms.length + ' salle(s) disponible(s)';
});

function joinRoom(roomId) {
  currentRoomId = roomId;
  socket.emit('join', { name: nickname, roomId: roomId });
}

socket.on('joined', (data) => {
  myPlayerId = data.playerId;
  currentRoomId = data.roomId;
  show(screens.waiting);
  setText('waiting-room-id', currentRoomId.replace('room-', ''));
  setText('waiting-room-title', 'Salle ' + currentRoomId.replace('room-', ''));
  renderWaiting(data);
  startRoomTimer(data.roomId);
});

socket.on('player_joined', (data) => {
  renderWaitingPlayers(data.players, data.host);
  setText('waiting-msg', data.joined.name + ' a rejoint la salle.');
});

socket.on('player_left', (data) => {
  renderWaitingPlayers(data.players, data.host);
  setText('waiting-msg', 'Un joueur a quitté la salle.');
});

socket.on('player_ready', (data) => {
  renderWaitingPlayers(data.players, data.host);
});

socket.on('room_closed', (data) => {
  showModal('Salle ferm&eacute;e', 'La salle a été fermée (inactivité 20 min).');
  show(screens.rooms);
  currentRoomId = null;
});

socket.on('error_msg', (data) => {
  showModal('Erreur', data.message);
});

function startRoomTimer(roomId) {
  const el = document.getElementById('waiting-countdown');
  if (!el) return;
  const startedAt = Date.now();
  const endAt = startedAt + 20 * 60 * 1000;
  const tick = setInterval(() => {
    const left = endAt - Date.now();
    if (left <= 0) {
      el.textContent = '00:00';
      clearInterval(tick);
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }, 1000);
  window._roomTimer = tick;
}

function renderWaiting(data) {
  renderWaitingPlayers(data.players, data.host);
  updateWaitingActions(data.host, data.started);
}

function renderWaitingPlayers(players, hostId) {
  const list = document.getElementById('players-list');
  list.innerHTML = '';
  players.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'player-item' + (p.id === myPlayerId ? ' me' : '') + (p.id === hostId ? ' host' : '');
    const statusSpan = document.createElement('span');
    statusSpan.className = 'player-status ' + (p.ready ? 'ready' : 'notready');
    statusSpan.textContent = p.ready ? 'Prêt' : 'En attente';
    const botTag = p.isBot ? ' [bot]' : '';
    div.innerHTML = '<span>' + escapeHtml(p.name) + botTag + '</span>';
    div.appendChild(statusSpan);
    list.appendChild(div);
  });
}

function updateWaitingActions(hostId, started) {
  const btnReady = document.getElementById('btn-ready');
  const btnStart = document.getElementById('btn-start');
  const btnLeave = document.getElementById('btn-leave-waiting');

  btnReady.classList.toggle('hidden', started || myPlayerId === null);
  btnStart.classList.toggle('hidden', !(hostId === myPlayerId) || started);
  btnLeave.classList.toggle('hidden', started);

  const humans = document.querySelectorAll('.player-item').length;
  const readyCount = document.querySelectorAll('.player-status.ready').length;
  setText('waiting-msg', humans + ' joueur(s) | ' + readyCount + ' prêt(s)');

  btnReady.onclick = () => {
    socket.emit('set_ready', { roomId: currentRoomId, ready: !document.querySelector('.player-item.me .player-status').classList.contains('ready') });
  };

  btnStart.onclick = () => {
    socket.emit('start_game', { roomId: currentRoomId });
  };

  btnLeave.onclick = () => {
    socket.disconnect();
    show(screens.rooms);
    currentRoomId = null;
  };
}

document.getElementById('btn-leave-waiting').addEventListener('click', () => {
  socket.disconnect();
  show(screens.rooms);
  currentRoomId = null;
});

// Game started
socket.on('game_started', (data) => {
  show(screens.game);
  data.players.forEach(p => { playersById[p.id] = p; });
  gameState = {
    scores: {},
    round: data.round || 1,
    heartsBroken: data.heartsBroken,
    passingDirection: data.passingDirection,
    phase: 'passing',
  };
  myHand = data.hands[myPlayerId] || [];
  renderGame(data);
  renderHand(myHand);
  setText('game-msg', data.passingDirection !== 'none' ? 'Choisissez 3 cartes à passer.' : 'La partie commence.');
  setPassDirection(data.passingDirection);
  if (data.passingDirection !== 'none') {
    showPassControls();
  } else {
    gameState.phase = 'playing';
    if (data.currentTurn === myPlayerId) {
      setText('turn-name', 'C\'est votre tour');
      setText('game-msg', 'Jouez une carte.');
      enableHand();
      showPlayButton();
    } else {
      setText('turn-name', 'Tour adverse');
      disableHand();
      hidePlayButton();
    }
  }
});

socket.on('new_round', (data) => {
  gameState.round = data.round;
  gameState.heartsBroken = false;
  gameState.phase = 'passing';
  gameState.passingDirection = data.passingDirection;
  setPassDirection(data.passingDirection);
  setText('round-badge', 'Round ' + data.round);
  myHand = data.hands[myPlayerId] || [];
  renderScores(data.scores);
  renderHand(myHand);
  document.getElementById('trick-cards').innerHTML = '';
  setText('game-msg', 'Choisissez 3 cartes à passer.');
  showPassControls();
});

socket.on('pass_complete', (data) => {
  gameState.phase = 'playing';
  setPassDirection(gameState.passingDirection);
  const oldHand = myHand.slice();
  myHand = data.hands[myPlayerId] || [];
  renderHand(myHand);
  hidePassControls();

  // Détecter et surligner les cartes reçues lors du passage
  const oldCounts = {};
  for (const c of oldHand) {
    const key = c.suit + ':' + c.rank;
    oldCounts[key] = (oldCounts[key] || 0) + 1;
  }
  const receivedIdxs = [];
  for (let i = 0; i < myHand.length; i++) {
    const c = myHand[i];
    const key = c.suit + ':' + c.rank;
    if ((oldCounts[key] || 0) === 0) {
      receivedIdxs.push(i);
    } else {
      oldCounts[key]--;
    }
  }
  receivedIdxs.forEach((idx) => {
    const el = document.querySelector('.game-card[data-idx="' + idx + '"]');
    if (el) el.classList.add('received');
  });

  if (receivedIdxs.length > 0) {
    pendingCurrentTurn = data.currentTurn;
    setText('game-msg', 'Vous avez reçu ' + receivedIdxs.length + ' carte(s). Cliquez sur "J\'ai vu les cartes" pour continuer.');
    showPassValidatedButton();
    disableHand();
    hidePlayButton();
  } else {
    setText('game-msg', 'Passage terminé.');
    if (data.currentTurn === myPlayerId) {
      setText('turn-name', 'C\'est votre tour');
      setText('game-msg', 'Jouez une carte.');
      enableHand();
      showPlayButton();
    } else {
      setText('turn-name', 'Tour adverse');
      setText('game-msg', 'En attente...');
      disableHand();
      hidePlayButton();
    }
  }
});

socket.on('cards_passed', (data) => {
  // opponent passed, just visual could be added
});

socket.on('card_played', (data) => {
  stopTurnTimer();
  renderTrick(data.trickCards);
  gameState.heartsBroken = data.heartsBroken;
  if (data.playerId === myPlayerId) {
    myHand = myHand.filter((c) => !(c.suit === data.card.suit && c.rank === data.card.rank));
    renderHand(myHand);
  }
  if (data.trickCards.length < 4) {
    setText('turn-name', 'Adversaire a joué.');
    disableHand();
    hidePlayButton();
  } else {
    setText('turn-name', 'Résolution du pli...');
    disableHand();
    hidePlayButton();
  }
});

socket.on('turn_changed', (data) => {
  stopTurnTimer();
  if (data.turn === myPlayerId) {
    setText('turn-name', 'C\'est votre tour');
    setText('game-msg', 'Jouez une carte.');
    enableHand();
    updatePlayableCards();
    showPlayButton();
    startTurnTimerUI(60);
  } else {
    setText('turn-name', 'Tour adverse');
    setText('game-msg', 'En attente...');
    disableHand();
    hidePlayButton();
    document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('playable', 'disabled'));
  }
});

socket.on('trick_ended', (data) => {
  const p = findPlayer(data.winner);
  const winnerName = p ? p.name : 'Joueur ' + data.winner;
  setText('game-msg', 'Plis terminé. Gagnant : ' + winnerName);
  setScoresRound(data.roundScores);
  setTimeout(() => {
    if (data.winner === myPlayerId) setText('game-msg', 'Vous gagnez le pli !');
  }, 3000);
});

socket.on('round_ended', (data) => {
  if (data.players) data.players.forEach(p => { playersById[p.id] = p; });
  setText('game-msg', data.moonShot ? 'Lune renversée !' : 'Round terminé.');
  renderScores(data.scores);
  showRoundScoresModal(data.roundScores, data.gameOver, data.scores);
  if (data.gameOver) {
    // le modal est déjà affiché par showRoundScoresModal
  }
});

socket.on('game_over', (data) => {
  setText('game-msg', 'Partie terminée.');
  showModal('Partie terminée', 'Scores : ' + JSON.stringify(data.scores));
});

function renderGame(data) {
  setText('round-badge', 'Round ' + (data.round || 1));
  setText('turn-name', 'Vous');
  renderScores(data.scores || {});
  renderOpponents(data.players);
  renderTrick([]);
}

function findPlayer(pid) {
  return playersById[pid] || null;
}

function renderScores(scores) {
  const container = document.getElementById('scores');
  let html = '<table class="scores-table"><tr><th>Joueur</th><th>Score</th></tr>';
  for (const [pid, val] of Object.entries(scores)) {
    const p = findPlayer(pid);
    html += '<tr><td>' + escapeHtml(p ? p.name : 'Joueur') + '</td><td>' + val + '</td></tr>';
  }
  html += '</table>';
  container.innerHTML = html;
}

function showRoundScoresModal(roundScores, gameOver, finalScores) {
  const title = gameOver ? 'Partie terminée - Scores finaux' : 'Scores du round';
  let html = '<table class="scores-table"><tr><th>Joueur</th><th>Points</th></tr>';
  if (gameOver) {
    for (const [pid, val] of Object.entries(finalScores || {})) {
      const p = findPlayer(pid);
      html += '<tr><td>' + escapeHtml(p ? p.name : 'Joueur') + '</td><td>' + val + '</td></tr>';
    }
  } else {
    for (const [pid, val] of Object.entries(roundScores || {})) {
      const p = findPlayer(pid);
      html += '<tr><td>' + escapeHtml(p ? p.name : 'Joueur') + '</td><td>' + val + '</td></tr>';
    }
  }
  html += '</table>';
  setText('modal-title', title);
  setText('modal-body', html);
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('modal').classList.remove('hidden');
}

function setScoresRound(roundScores) {
  for (const [pid, val] of Object.entries(roundScores)) {
    const p = findPlayer(pid);
    // visual only
  }
}

function renderOpponents(players) {
  const seats = { top: null, left: null, right: null };
  let seatIdx = 0;
  const seatOrder = ['top', 'left', 'right'];
  players.forEach((p) => {
    if (p.id === myPlayerId) return;
    const seat = seatOrder[seatIdx % seatOrder.length];
    seatIdx++;
    const nameEl = document.getElementById('name-' + seat);
    const stackEl = document.getElementById('stack-' + seat);
    const countEl = document.getElementById('count-' + seat);
    if (nameEl) nameEl.textContent = escapeHtml(p.name);
    if (stackEl) stackEl.textContent = p.handCount;
    if (countEl) countEl.textContent = p.handCount + ' cartes';
    if (seats[seat] === null) seats[seat] = p;
  });
  // Fill empty seats
  seatOrder.forEach((seat) => {
    if (!seats[seat]) {
      document.getElementById('name-' + seat).textContent = '';
      document.getElementById('stack-' + seat).textContent = '0';
      document.getElementById('count-' + seat).textContent = '0 cartes';
    }
  });
}

function renderTrick(cards) {
  const container = document.getElementById('trick-cards');
  container.innerHTML = '';
  const placeholder = document.getElementById('trick-area').querySelector('.trick-placeholder');
  if (cards.length === 0) {
    placeholder.style.display = 'block';
  } else {
    placeholder.style.display = 'none';
    cards.forEach((tc) => {
      const div = document.createElement('div');
      div.className = 'trick-card ' + (tc.card.suit === 'hearts' || tc.card.suit === 'diamonds' ? 'red' : 'black');
      div.innerHTML = renderCardHtml(tc.card, false);
      container.appendChild(div);
    });
  }
}

function renderHand(hand) {
  myHand = hand;
  const container = document.getElementById('hand-cards');
  container.innerHTML = '';
  hand.forEach((card, idx) => {
    const div = document.createElement('div');
    div.className = 'game-card ' + (card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black');
    div.dataset.idx = idx;
    div.innerHTML = renderCardHtml(card, true);
    div.addEventListener('click', () => selectCard(idx));
    container.appendChild(div);
  });
}

function renderCardHtml(card, isHand) {
  const suitSymbol = {
    hearts: '♥',
    diamonds: '♦',
    clubs: '♣',
    spades: '♠',
  }[card.suit];
  return '<div class="rank-top">' + card.rank + suitSymbol + '</div><div class="suit-big">' + suitSymbol + '</div>';
}

function selectCard(idx) {
  if (gameState.phase !== 'playing') return;
  document.querySelectorAll('.game-card').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
  selectedCard = idx;
}

function deselectCard() {
  selectedCard = null;
  document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('selected'));
}

function enableHand() {
  document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('disabled'));
}

function disableHand() {
  document.querySelectorAll('.game-card').forEach((el) => el.classList.add('disabled'));
}

function setPassDirection(dir) {
  const labels = { left: 'à gauche', right: 'à droite', across: 'en face', none: 'aucune' };
  const el = document.getElementById('turn-timer');
  el.textContent = 'Passe : ' + (labels[dir] || dir);
  el.style.color = 'var(--secondary)';
}

function startTurnTimerUI(seconds) {
  stopTurnTimer();
  turnTimeLeft = seconds;
  const el = document.getElementById('turn-timer');
  el.textContent = turnTimeLeft + 's';
  el.style.color = 'var(--danger)';
  turnTimer = setInterval(() => {
    turnTimeLeft--;
    if (turnTimeLeft <= 0) {
      el.textContent = '0s';
      stopTurnTimer();
    } else {
      el.textContent = turnTimeLeft + 's';
    }
  }, 1000);
}

function stopTurnTimer() {
  if (turnTimer) {
    clearInterval(turnTimer);
    turnTimer = null;
  }
}

function isValidPlayClient(card, ledSuit, heartsBroken, hand) {
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

function updatePlayableCards() {
  if (!gameState) return;
  const trickContainer = document.getElementById('trick-cards');
  const firstCardEl = trickContainer.querySelector('.trick-card');
  let ledSuit = null;
  if (firstCardEl) {
    const rankTop = firstCardEl.querySelector('.rank-top');
    if (rankTop) {
      const text = rankTop.textContent;
      const suitSymbol = text.replace(/^[2-910JQKA]/, '');
      const suitMap = { '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs', '♠': 'spades' };
      ledSuit = suitMap[suitSymbol] || null;
    }
  }
  document.querySelectorAll('.game-card').forEach((el, i) => {
    const card = myHand[i];
    const playable = isValidPlayClient(card, ledSuit, gameState.heartsBroken, myHand);
    el.classList.remove('disabled');
    if (playable) {
      el.classList.add('playable');
      el.style.cursor = 'pointer';
    } else {
      el.classList.add('disabled');
      el.style.cursor = 'not-allowed';
    }
  });
}

function playCard() {
  if (selectedCard === null) {
    setText('game-msg', 'Sélectionnez une carte à jouer.');
    return;
  }
  const card = myHand[selectedCard];
  socket.emit('play_card', { roomId: currentRoomId, card: card });
  deselectCard();
  disableHand();
  hidePlayButton();
  stopTurnTimer();
  document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('playable'));
}

function showPassControls() {
  const controls = document.getElementById('game-controls');
  controls.innerHTML = '<button id="btn-pass" class="btn btn-primary" disabled>Passer 3 cartes</button>';
  document.getElementById('btn-pass').addEventListener('click', passCards);
}

function hidePassControls() {
  document.getElementById('game-controls').innerHTML = '';
}

function showPassValidatedButton() {
  const controls = document.getElementById('game-controls');
  controls.innerHTML = '<button id="btn-pass-validated" class="btn btn-success">J\'ai vu les cartes</button>';
  document.getElementById('btn-pass-validated').addEventListener('click', validatePassReceived);
}

function hidePassValidatedButton() {
  const btn = document.getElementById('btn-pass-validated');
  if (btn) btn.remove();
}

function validatePassReceived() {
  socket.emit('pass_validated', { roomId: currentRoomId });
  document.querySelectorAll('.game-card.received').forEach((el) => el.classList.remove('received'));
  hidePassValidatedButton();
  if (pendingCurrentTurn === myPlayerId) {
    setText('turn-name', 'C\'est votre tour');
    setText('game-msg', 'Jouez une carte.');
    enableHand();
    updatePlayableCards();
    showPlayButton();
    startTurnTimerUI(60);
  } else {
    setText('turn-name', 'Tour adverse');
    setText('game-msg', 'En attente...');
    disableHand();
    hidePlayButton();
    document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('playable', 'disabled'));
  }
}

let passSelection = [];

function passCards() {
  if (passSelection.length !== 3) {
    setText('game-msg', 'Sélectionnez exactement 3 cartes.');
    return;
  }
  const cards = passSelection.map((idx) => myHand[idx]);
  socket.emit('pass_cards', { roomId: currentRoomId, cards: cards });
  passSelection = [];
  document.getElementById('btn-pass').disabled = true;
  deselectCard();
  setText('game-msg', 'En attente des autres joueurs...');
  disableHand();
}

document.addEventListener('click', (e) => {
  if (!gameState) return;
  const cardEl = e.target.closest('.game-card');
  if (!cardEl) return;
  if (cardEl.classList.contains('disabled')) return;
  const idx = parseInt(cardEl.dataset.idx, 10);
  if (gameState.phase === 'passing') {
    togglePassSelection(idx);
  } else if (gameState.phase === 'playing') {
    if (selectedCard === idx) {
      playCard();
    } else {
      selectCard(idx);
    }
  }
});

function togglePassSelection(idx) {
  const cardEl = document.querySelector('.game-card[data-idx="' + idx + '"]');
  const pos = passSelection.indexOf(idx);
  if (pos !== -1) {
    passSelection.splice(pos, 1);
    cardEl.classList.remove('selected');
  } else {
    if (passSelection.length >= 3) return;
    passSelection.push(idx);
    cardEl.classList.add('selected');
  }
  const btn = document.getElementById('btn-pass');
  if (btn) btn.disabled = passSelection.length !== 3;
}

function playCard() {
  if (selectedCard === null) {
    setText('game-msg', 'Sélectionnez une carte à jouer.');
    return;
  }
  const card = myHand[selectedCard];
  socket.emit('play_card', { roomId: currentRoomId, card: card });
  deselectCard();
  disableHand();
  hidePlayButton();
}

function showPlayButton() {
  const controls = document.getElementById('game-controls');
  if (document.getElementById('btn-play')) return;
  controls.innerHTML = '<button id="btn-play" class="btn btn-primary">Jouer la carte sélectionnée</button>';
  document.getElementById('btn-play').addEventListener('click', playCard);
}

function hidePlayButton() {
  const btn = document.getElementById('btn-play');
  if (btn) btn.remove();
}

// Escape html
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
