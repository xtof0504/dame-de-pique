const serverUrl = (typeof window.SERVER_URL === 'string' ? window.SERVER_URL : '').replace(/\/$/, '');
const socket = io(serverUrl || undefined, {
  transports: ['websocket', 'polling'],
  upgradeTimeout: 10000,
  timeout: 20000,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  autoConnect: true,
});
socket.on('connect', () => {
  const el = document.getElementById('room-status');
  if (el) el.textContent = 'Connecté au serveur.';
});
socket.on('connect_error', (err) => {
  const el = document.getElementById('room-status');
  if (el) el.textContent = 'Erreur connexion serveur : ' + (err && err.message ? err.message : String(err));
  console.error('Socket.io connect_error', err);
});
socket.on('disconnect', (reason) => {
  const el = document.getElementById('room-status');
  if (el) el.textContent = 'Déconnecté : ' + reason;
});

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
let showingTrickWinner = false;
let playerSeats = {};

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

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function showModal(title, body) {
  setText('modal-title', title);
  setHTML('modal-body', body);
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
    opacity: 1;
    box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.35), 0 0 14px rgba(16, 185, 129, 0.55);
    --lift: 8px;
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
});

socket.on('player_joined', (data) => {
  renderWaitingPlayers(data.players, data.host);
  setText('waiting-msg', data.joined.name + ' a rejoint la salle.');
});

socket.on('player_left', (data) => {
  if (data.replacedByBot) {
    // Partie en cours : le joueur parti est remplacé par un bot
    const old = findPlayer(data.leftId);
    const updated = data.players.find((p) => p.id === data.leftId);
    if (updated) {
      playersById[updated.id] = Object.assign({}, old || {}, updated);
      const seat = playerSeats[updated.id];
      if (seat) setText('name-' + seat, updated.name);
      renderMiniScores();
    }
    setText('game-msg', (old ? old.name : 'Un joueur') + ' a quitté la partie, un bot le remplace.');
    return;
  }
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
  if (data.playRejected && playPending) {
    // Le serveur a refusé ma carte : redonner la main au lieu de rester bloqué
    playPending = false;
    isMyTurn = true;
    enableHand();
    updatePlayableCards();
    setText('game-msg', data.message + ' Jouez une autre carte.');
    return;
  }
  showModal('Erreur', data.message);
});

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
    socket.emit('leave_room', { roomId: currentRoomId });
    show(screens.rooms);
    currentRoomId = null;
  };
}

document.getElementById('btn-leave-waiting').addEventListener('click', () => {
  socket.emit('leave_room', { roomId: currentRoomId });
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
    ledSuit: null,
  };
  myHand = data.hands[myPlayerId] || [];
  preselectedCard = null;
  isMyTurn = false;
  awaitingPassValidation = false;
  renderGame(data);
  renderHand(myHand);
  setText('game-msg', data.passingDirection !== 'none' ? passPrompt(data.passingDirection) : 'La partie commence.');
  setPassDirection(data.passingDirection);
  if (data.passingDirection !== 'none') {
    showPassControls();
  } else {
    gameState.phase = 'playing';
    isMyTurn = data.currentTurn === myPlayerId;
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
  const noPass = data.passingDirection === 'none';
  gameState.round = data.round;
  gameState.heartsBroken = false;
  gameState.ledSuit = null;
  gameState.phase = noPass ? 'playing' : 'passing';
  gameState.passingDirection = data.passingDirection;
  setPassDirection(data.passingDirection);
  setText('round-badge', 'Round ' + data.round);
  myHand = data.hands[myPlayerId] || [];
  passSelection = [];
  selectedCard = null;
  preselectedCard = null;
  isMyTurn = false;
  renderScores(data.scores);
  renderHand(myHand);
  cancelTrickClear();
  showingTrickWinner = false;
  document.getElementById('trick-cards').innerHTML = '';
  if (noPass) {
    // Pas de passe : la manche commence directement (turn_changed suit)
    hidePassControls();
    disableHand();
    setText('game-msg', 'Pas de passe pour cette manche.');
  } else {
    setText('game-msg', passPrompt(data.passingDirection));
    showPassControls();
  }
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
    awaitingPassValidation = true;
    setText('game-msg', 'Vous avez reçu ' + receivedIdxs.length + ' carte(s). Cliquez sur "J\'ai vu les cartes" pour continuer.');
    showPassValidatedButton();
    disableHand();
    hidePlayButton();
  } else {
    setText('game-msg', 'Passage terminé.');
    isMyTurn = data.currentTurn === myPlayerId;
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
  // Un nouveau pli commence : annuler l'effacement différé de l'ancien
  cancelTrickClear();
  showingTrickWinner = false;
  renderTrick(data.trickCards);
  gameState.heartsBroken = data.heartsBroken;
  if (data.trickCards.length === 1) {
    gameState.ledSuit = data.card.suit;
  }
  if (data.playerId === myPlayerId) {
    playPending = false;
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
  // Le serveur peut annoncer deux fois le même tour : si ma carte est déjà
  // partie (en attente de confirmation), ne pas redonner la main.
  if (data.turn === myPlayerId && playPending) return;
  isMyTurn = data.turn === myPlayerId;
  if (data.turn === myPlayerId) {
    setText('turn-name', 'C\'est votre tour');
    setText('game-msg', 'Jouez une carte.');
    enableHand();
    updatePlayableCards();
    if (playPreselectedIfAny()) return;
    showPlayButton();
    startTurnTimerUI(60);
  } else {
    if (!showingTrickWinner) {
      setText('turn-name', 'Tour adverse');
      setText('game-msg', 'En attente...');
    }
    disableHand();
    hidePlayButton();
    document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('playable', 'disabled'));
  }
});

socket.on('trick_ended', (data) => {
  if (data.players) data.players.forEach(p => { playersById[p.id] = p; });
  const p = findPlayer(data.winner);
  const winnerName = p ? p.name : 'Joueur ' + data.winner;
  showingTrickWinner = true;
  setText('game-msg', 'Plis terminé. Gagnant : ' + winnerName);
  setScoresRound(data.roundScores);
  gameState.ledSuit = null;

  // Pause de 1 sec puis les cartes du pli partent vers le siège du gagnant
  cancelTrickClear();
  trickClearTimers.push(setTimeout(() => {
    const winnerSeat = playerSeats[data.winner] || 'bottom';
    document.querySelectorAll('#trick-cards .trick-card').forEach((el) => {
      el.classList.add('trick-won-' + winnerSeat);
    });

    trickClearTimers.push(setTimeout(() => {
      trickClearTimers = [];
      showingTrickWinner = false;
      const container = document.getElementById('trick-cards');
      container.innerHTML = '';
      const placeholder = document.getElementById('trick-area').querySelector('.trick-placeholder');
      if (placeholder) placeholder.style.display = 'block';
      if (data.winner === myPlayerId) setText('game-msg', 'Vous gagnez le pli !');
    }, 700));
  }, 1000));
});

let trickClearTimers = [];
function cancelTrickClear() {
  trickClearTimers.forEach(clearTimeout);
  trickClearTimers = [];
}

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
  let html = '<table class="scores-table"><tr><th>Joueur</th><th>Score</th></tr>';
  for (const [pid, val] of Object.entries(data.scores || {})) {
    const p = findPlayer(pid);
    html += '<tr><td>' + escapeHtml(p ? p.name : pid) + '</td><td>' + val + '</td></tr>';
  }
  html += '</table>';
  showModal('Partie terminée', html);
  document.getElementById('modal-ok').onclick = () => {
    hideModal();
    socket.emit('leave_room', { roomId: currentRoomId });
    show(screens.rooms);
    currentRoomId = null;
    loadRooms();
  };
});

function renderGame(data) {
  setText('round-badge', 'Round ' + (data.round || 1));
  setText('turn-name', 'Vous');
  playerSeats = { [myPlayerId]: 'bottom' };
  renderOpponents(data.players);
  const initialScores = data.scores || (data.players || []).reduce((acc, p) => { acc[p.id] = p.score || 0; return acc; }, {});
  renderScores(initialScores);
  renderTrick([]);
}

// Petit tableau des scores en haut à gauche : total + points de la manche en cours
let miniTotals = {};
let miniRound = {};

function renderMiniScores() {
  const el = document.getElementById('score-mini');
  if (!el) return;
  const seatOrder = ['bottom', 'left', 'top', 'right'];
  const ids = Object.keys(playerSeats).sort((a, b) => seatOrder.indexOf(playerSeats[a]) - seatOrder.indexOf(playerSeats[b]));
  let html = '';
  for (const pid of ids) {
    const p = findPlayer(pid);
    const name = pid === myPlayerId ? 'Vous' : (p ? p.name : 'Joueur');
    const total = miniTotals[pid] || 0;
    const round = miniRound[pid] || 0;
    html += '<div class="score-mini-row' + (pid === myPlayerId ? ' me' : '') + '">' +
      '<span class="score-mini-name">' + escapeHtml(name) + '</span>' +
      '<span class="score-mini-val">' + total + (round ? ' <small>(+' + round + ')</small>' : '') + '</span>' +
      '</div>';
  }
  el.innerHTML = html;
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
  // Totaux à jour : les points de manche repartent de zéro
  miniTotals = Object.assign({}, scores);
  miniRound = {};
  renderMiniScores();
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
  setHTML('modal-body', html);
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('modal').classList.remove('hidden');
}

function setScoresRound(roundScores) {
  miniRound = Object.assign({}, roundScores);
  renderMiniScores();
}

function renderOpponents(players) {
  const seatOrder = ['bottom', 'left', 'top', 'right'];
  const myIdx = players.findIndex(p => p.id === myPlayerId);
  const seats = { top: null, left: null, right: null };
  players.forEach((p, idx) => {
    if (p.id === myPlayerId) return;
    const relativeIdx = (idx - myIdx + 4) % 4;
    const seat = seatOrder[relativeIdx];
    playerSeats[p.id] = seat;
    const nameEl = document.getElementById('name-' + seat);
    const stackEl = document.getElementById('stack-' + seat);
    const countEl = document.getElementById('count-' + seat);
    if (nameEl) nameEl.textContent = escapeHtml(p.name);
    if (stackEl) stackEl.textContent = p.handCount;
    if (countEl) countEl.textContent = p.handCount + ' cartes';
    if (seats[seat] === null) seats[seat] = p;
  });
  // Fill empty seats
  ['top', 'left', 'right'].forEach((seat) => {
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
      const seat = playerSeats[tc.playerId] || 'bottom';
      const div = document.createElement('div');
      div.className = 'trick-card ' + (tc.card.suit === 'hearts' || tc.card.suit === 'diamonds' ? 'red' : 'black') + ' seat-' + seat;
      div.innerHTML = renderCardHtml(tc.card, true);
      container.appendChild(div);
    });
  }
}

function renderHand(hand) {
  myHand = hand;
  const container = document.getElementById('hand-cards');
  container.innerHTML = '';
  const n = hand.length;
  hand.forEach((card, idx) => {
    const div = document.createElement('div');
    div.className = 'game-card ' + (card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black');
    div.dataset.idx = idx;
    div.innerHTML = renderCardHtml(card, true);
    // Calcul de la rotation et de la translation pour l'effet éventail
    const narrow = window.innerWidth <= 480;
    const rotPer = narrow ? 1.8 : 3.5;
    const tyPer = narrow ? 1.2 : 2;
    const offset = idx - (n - 1) / 2;
    const rot = offset * rotPer;
    const ty = Math.abs(offset) * tyPer;
    div.style.setProperty('--rot', rot + 'deg');
    div.style.setProperty('--ty', ty + 'px');
    div.style.setProperty('--sc', '1');
    div.addEventListener('click', () => selectCard(idx));
    container.appendChild(div);
  });
  layoutHand();
  applyPreselect();
  // Recalcul une fois la mise en page appliquée (écran tout juste affiché)
  requestAnimationFrame(layoutHand);
}

// Adapte la taille et le chevauchement des cartes pour que l'éventail
// occupe toute la largeur disponible (en particulier sur téléphone).
function layoutHand() {
  const container = document.getElementById('hand-cards');
  if (!container) return;
  const n = container.children.length;
  if (n === 0) return;
  const narrow = window.innerWidth <= 480;
  const maxRot = ((n - 1) / 2) * (narrow ? 1.8 : 3.5) * Math.PI / 180;
  // Largeur disponible, limitée sur grand écran
  // (si l'écran de jeu n'est pas encore affiché, se baser sur la fenêtre)
  // Ne jamais dépasser la largeur visible de l'écran
  const screenW = document.documentElement.clientWidth - 32;
  const width = Math.min(container.clientWidth || screenW, screenW);
  let avail = Math.min(width, 560);
  // Taille des cartes : proportionnelle à la largeur, bornée
  const w = Math.max(44, Math.min(76, Math.round(avail / 6.2)));
  const h = Math.round(w * 1.48);
  // Marge pour les cartes des bords, inclinées
  avail -= 2 * Math.ceil(h * Math.sin(maxRot)) + 4;
  // Pas entre deux cartes (sans trop les écarter s'il en reste peu)
  const step = n > 1 ? Math.min((avail - w) / (n - 1), w * 0.8) : w;
  const margin = (step - w) / 2;
  container.style.setProperty('--card-w', w + 'px');
  container.style.setProperty('--card-h', h + 'px');
  container.style.setProperty('--card-m', margin.toFixed(1) + 'px');
  container.style.minHeight = (h + 40) + 'px';
}

window.addEventListener('resize', layoutHand);

function rankToFile(rank) {
  const map = { '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', 'J': 'jack', 'Q': 'queen', 'K': 'king', 'A': 'ace' };
  return map[rank] || rank;
}

function renderCardHtml(card, isHand) {
  const file = rankToFile(card.rank) + '_of_' + card.suit + '.png';
  if (isHand) {
    return '<img class="card-img" src="/cards/' + file + '" alt="' + card.rank + card.suit + '">';
  }
  return '<div class="card-back"></div>';
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
  document.querySelectorAll('.game-card').forEach((el) => el.classList.remove('locked', 'disabled'));
}

// Bloque les clics sur la main, sans transparence
function disableHand() {
  document.querySelectorAll('.game-card').forEach((el) => {
    el.classList.remove('disabled');
    el.classList.add('locked');
  });
}

// Nom du joueur qui reçoit mes cartes selon le sens du passage
// (gauche → siège de gauche, droite → siège de droite, en face → siège du haut)
function passTargetName(dir) {
  const seatByDir = { left: 'left', right: 'right', across: 'top' };
  const seat = seatByDir[dir];
  if (!seat) return null;
  const pid = Object.keys(playerSeats).find((id) => playerSeats[id] === seat);
  const p = pid ? findPlayer(pid) : null;
  return p ? p.name : null;
}

function setPassDirection(dir) {
  const labels = { left: 'à gauche', right: 'à droite', across: 'en face' };
  const el = document.getElementById('turn-timer');
  if (dir === 'none') {
    el.textContent = 'Pas de passe';
  } else {
    const name = passTargetName(dir);
    el.textContent = name ? 'Passe à ' + name : 'Passe ' + (labels[dir] || dir);
  }
  el.style.color = 'var(--secondary)';
}

function passPrompt(dir) {
  const name = passTargetName(dir);
  return name ? 'Choisissez 3 cartes à passer à ' + name + '.' : 'Choisissez 3 cartes à passer.';
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
  // Premier coup du round: le 2 de trèfle est obligatoire si détenu
  if (ledSuit === null) {
    const hasTwoClubs = hand.some(c => c.suit === 'clubs' && c.rank === '2');
    if (hasTwoClubs && !(card.suit === 'clubs' && card.rank === '2')) {
      return false;
    }
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
  const ledSuit = gameState.ledSuit || null;
  document.querySelectorAll('.game-card').forEach((el, i) => {
    const card = myHand[i];
    const playable = isValidPlayClient(card, ledSuit, gameState.heartsBroken, myHand);
    el.classList.remove('playable', 'disabled');
    if (playable) {
      el.classList.add('playable');
      el.style.cursor = 'pointer';
    } else {
      el.style.cursor = 'not-allowed';
    }
  });
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
  awaitingPassValidation = false;
  document.querySelectorAll('.game-card.received').forEach((el) => el.classList.remove('received'));
  hidePassValidatedButton();
  isMyTurn = pendingCurrentTurn === myPlayerId;
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
  const idx = parseInt(cardEl.dataset.idx, 10);
  // Pas encore mon tour : choisir une carte à l'avance
  if (gameState.phase === 'playing' && !isMyTurn && !awaitingPassValidation) {
    togglePreselect(idx);
    return;
  }
  if (cardEl.classList.contains('disabled') || cardEl.classList.contains('locked')) return;
  if (gameState.phase === 'passing') {
    togglePassSelection(idx);
  } else if (gameState.phase === 'playing') {
    const reason = whyNotPlayable(myHand[idx]);
    if (reason) {
      // Carte non jouable : ne pas la sélectionner
      deselectCard();
      setText('game-msg', reason);
      return;
    }
    if (selectedCard === idx) {
      playCard();
    } else {
      selectCard(idx);
    }
  }
});

// Raison pour laquelle une carte ne peut pas être jouée maintenant (null si jouable)
function whyNotPlayable(card) {
  if (!card) return 'Carte introuvable.';
  const ledSuit = gameState.ledSuit || null;
  if (isValidPlayClient(card, ledSuit, gameState.heartsBroken, myHand)) return null;
  const suitsFr = { clubs: 'trèfle', diamonds: 'carreau', spades: 'pique', hearts: 'cœur' };
  if (ledSuit && myHand.some((c) => c.suit === ledSuit)) {
    return 'Vous devez jouer du ' + suitsFr[ledSuit] + '.';
  }
  if (!ledSuit && myHand.some((c) => c.suit === 'clubs' && c.rank === '2')) {
    return 'Vous devez ouvrir avec le 2 de trèfle.';
  }
  if (card.suit === 'hearts') return 'Les cœurs ne sont pas encore entamés.';
  return 'Cette carte ne peut pas être jouée.';
}

// Une carte a été envoyée au serveur et on attend sa confirmation
let playPending = false;

// --- Carte choisie à l'avance (jouée automatiquement à mon tour) ---
let preselectedCard = null; // { suit, rank }
let isMyTurn = false;
let awaitingPassValidation = false;

function cardLabel(card) {
  const suitsFr = { clubs: 'trèfle', diamonds: 'carreau', spades: 'pique', hearts: 'cœur' };
  const ranksFr = { J: 'valet', Q: 'dame', K: 'roi', A: 'as' };
  return (ranksFr[card.rank] || card.rank) + ' de ' + (suitsFr[card.suit] || card.suit);
}

function togglePreselect(idx) {
  const card = myHand[idx];
  if (!card) return;
  if (preselectedCard && preselectedCard.suit === card.suit && preselectedCard.rank === card.rank) {
    clearPreselect();
    setText('game-msg', 'Carte choisie à l\'avance annulée.');
    return;
  }
  preselectedCard = { suit: card.suit, rank: card.rank };
  applyPreselect();
  setText('game-msg', 'Le ' + cardLabel(card) + ' sera joué automatiquement à votre tour.');
}

function clearPreselect() {
  preselectedCard = null;
  applyPreselect();
}

function applyPreselect() {
  document.querySelectorAll('#hand-cards .game-card').forEach((el) => {
    const c = myHand[parseInt(el.dataset.idx, 10)];
    const on = !!(preselectedCard && c && c.suit === preselectedCard.suit && c.rank === preselectedCard.rank);
    el.classList.toggle('preselected', on);
  });
}

// À mon tour : jouer la carte choisie à l'avance si elle est encore valide.
// Retourne true si la carte a été jouée.
function playPreselectedIfAny() {
  if (!preselectedCard) return false;
  const idx = myHand.findIndex((c) => c.suit === preselectedCard.suit && c.rank === preselectedCard.rank);
  const card = myHand[idx];
  clearPreselect();
  if (idx === -1) return false;
  if (!isValidPlayClient(card, gameState.ledSuit, gameState.heartsBroken, myHand)) {
    setText('game-msg', 'Le ' + cardLabel(card) + ' ne peut pas être joué maintenant. Jouez une carte.');
    return false;
  }
  selectedCard = idx;
  playCard();
  setText('game-msg', 'Le ' + cardLabel(card) + ' a été joué automatiquement.');
  return true;
}

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
  const reason = whyNotPlayable(card);
  if (reason) {
    deselectCard();
    setText('game-msg', reason);
    return;
  }
  socket.emit('play_card', { roomId: currentRoomId, card: card });
  playPending = true;
  isMyTurn = false;
  deselectCard();
  disableHand();
  hidePlayButton();
}

function showPlayButton() {
  // Aucun bouton en bas: la carte se joue en cliquant directement dessus.
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
