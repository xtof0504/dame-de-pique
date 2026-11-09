const socket = io();
let currentRoomId = null;
let myPlayerId = null;
let myName = '';
let myIsHuman = true;
let gameState = null;
let myHand = [];
let selectedPassCards = [];
let selectedCardId = null;

const screens = {
  login: 'screen-login',
  home: 'screen-home',
  waiting: 'screen-waiting',
  pass: 'screen-pass',
  game: 'screen-game',
  roundOver: 'screen-round-over',
  gameOver: 'screen-game-over'
};

function showScreen(name) {
  Object.values(screens).forEach(s => document.getElementById(s).classList.remove('active'));
  document.getElementById(screens[name]).classList.add('active');
}

function suitClass(card) {
  if (card.suit === 'CŒUR' || card.suit === 'CARREAU') return card.suit.toLowerCase().replace('œ', 'oe');
  return card.suit.toLowerCase();
}

function cardRankLabel(card) {
  const labels = { 'V': 'V', 'D': 'D', 'R': 'R', 'A': 'A' };
  return labels[card.rank] || card.rank;
}

function renderCard(card, selected = false, clickable = true, extraClass = '') {
  const cls = `card ${suitClass(card)} ${selected ? 'selected' : ''} ${clickable ? '' : 'disabled'} ${extraClass}`;
  return `
    <div class="${cls}" data-card="${card.rank}_${card.suit}">
      <div class="rank">${cardRankLabel(card)}</div>
      <div class="suit">${getSuitSymbol(card.suit)}</div>
      <div class="rank" style="transform: rotate(180deg)">${cardRankLabel(card)}</div>
    </div>
  `;
}

function getSuitSymbol(suit) {
  const s = { 'CŒUR': '♥', 'CARREAU': '♦', 'TREFLE': '♣', 'PIQUE': '♠' };
  return s[suit] || suit;
}

function renderHand(containerId, cards, selectedIds = [], clickable = true, onClick = null) {
  const container = document.getElementById(containerId);
  container.innerHTML = cards.map(c => {
    const id = `${c.rank}_${c.suit}`;
    const selected = selectedIds.includes(id);
    const onClickStr = clickable && onClick ? `onclick="onClick('${id}')"` : '';
    return renderCard(c, selected, clickable) + '';
  }).join('');

  if (onClick && clickable) {
    container.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => {
        const cardId = el.dataset.card;
        onClick(cardId, el);
      });
    });
  }
}

// ========== Login ==========
function doLogin() {
  const input = document.getElementById('input-name');
  const name = input.value.trim();
  const error = document.getElementById('login-error');
  if (!name) {
    error.classList.remove('hidden');
    input.focus();
    return;
  }
  error.classList.add('hidden');
  myName = name;
  myIsHuman = true;
  document.getElementById('welcome-name').textContent = `Bienvenue, ${myName}`;
  showScreen('home');
  loadRooms();
}

document.getElementById('btn-login').onclick = doLogin;
document.getElementById('input-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// ========== Home ==========
async function loadRooms() {
  socket.emit('getRooms');
}

socket.on('roomsList', (rooms) => {
  // rooms are static buttons; kept for future dynamic state
});

window.joinRoom = function(roomId) {
  if (!myName) {
    showScreen('login');
    return;
  }
  myPlayerId = null;
  socket.emit('joinRoom', { roomId, name: myName, isHuman: true });
};

socket.on('joined', ({ playerId, room }) => {
  myPlayerId = playerId;
  currentRoomId = room.id;
  renderWaitingRoom(room);
  showScreen('waiting');
  startWaitTimer(room.waitRemaining);
};

socket.on('roomState', (room) => {
  if (currentRoomId && room.id === currentRoomId) {
    renderWaitingRoom(room);
  }
});

function renderWaitingRoom(room) {
  const playersEl = document.getElementById('waiting-players');
  playersEl.innerHTML = room.players.map(p => `
    <div class="player-card ${p.isBot ? 'bot' : ''}">
      <span class="player-name">${p.name} ${p.isBot ? '(Bot)' : ''}</span>
      <span class="ready-badge">${p.ready ? 'Prêt' : 'En attente'}</span>
    </div>
  `).join('');

  const me = room.players.find(p => p.id === myPlayerId);
  const btnReady = document.getElementById('btn-ready');
  const startSection = document.getElementById('start-section');
  const btnStart = document.getElementById('btn-start');

  if (me) {
    btnReady.textContent = me.ready ? 'Annuler' : 'Prêt';
    btnReady.className = me.ready ? 'btn-primary' : 'btn-primary';
  }

  const humans = room.players.filter(p => !p.isBot);
  const allHumansReady = humans.length > 0 && humans.every(p => p.ready);
  const canStart = allHumansReady;

  startSection.classList.toggle('hidden', !canStart);
  btnStart.disabled = !canStart;

  if (!me || !me.isBot) {
    btnReady.onclick = () => {
      const newReady = !(me && me.ready);
      socket.emit('setReady', { roomId: currentRoomId, ready: newReady });
    };
  }

  btnStart.onclick = () => {
    socket.emit('startGame', { roomId: currentRoomId });
  };
}

document.getElementById('btn-refresh').onclick = loadRooms;

function startWaitTimer(seconds) {
  const timerEl = document.getElementById('waiting-timer');
  let remaining = seconds;
  timerEl.textContent = `Temps restant: ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      timerEl.textContent = 'Temps expiré';
    } else {
      timerEl.textContent = `Temps restant: ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
    }
  }, 1000);
}

// ========== Game start ==========
socket.on('gameStarting', ({ players }) => {
  showScreen('waiting');
});

socket.on('roundStarted', ({ roundNumber, passDirection, currentTurn, hands }) => {
  gameState = { roundNumber, passDirection, currentTurn, trick: [], heartsBroken: false };
  const myHandData = hands.find(h => h.id === myPlayerId);
  myHand = myHandData ? myHandData.hand : [];
  selectedPassCards = [];

  const dirLabels = { 0: 'à gauche', 1: 'à droite', 2: 'en face', 3: 'sans passage' };
  const dirBadges = { 0: 'left', 1: 'right', 2: 'across', 3: 'none' };

  document.getElementById('round-title').textContent = `Manche ${roundNumber}`;
  document.getElementById('pass-direction').textContent = `Passage: ${dirLabels[passDirection]}`;
  document.getElementById('pass-direction').className = `badge ${dirBadges[passDirection]}`;

  if (passDirection === 3) {
    setTimeout(() => {
      showScreen('game');
      renderGame();
    }, 1500);
  } else {
    showScreen('pass');
    renderPassHand();
  }
});

function renderPassHand() {
  const handEl = document.getElementById('pass-hand');
  handEl.innerHTML = myHand.map(c => {
    const id = `${c.rank}_${c.suit}`;
    const selected = selectedPassCards.includes(id);
    return renderCard(c, selected, true);
  }).join('');

  handEl.querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => {
      const cardId = el.dataset.card;
      togglePassCard(cardId, el);
    });
  });

  updatePassUI();
}

function togglePassCard(cardId, el) {
  if (selectedPassCards.includes(cardId)) {
    selectedPassCards = selectedPassCards.filter(id => id !== cardId);
    el.classList.remove('selected');
  } else {
    if (selectedPassCards.length >= 3) return;
    selectedPassCards.push(cardId);
    el.classList.add('selected');
  }
  updatePassUI();
}

function updatePassUI() {
  const count = selectedPassCards.length;
  document.getElementById('pass-count').textContent = `${count}/3`;
  const btn = document.getElementById('btn-pass-confirm');
  btn.disabled = count !== 3;
  btn.className = count === 3 ? 'btn-primary' : 'btn-primary disabled';
}

document.getElementById('btn-pass-confirm').onclick = () => {
  socket.emit('submitPass', { roomId: currentRoomId, cardIds: selectedPassCards });
  document.getElementById('btn-pass-confirm').disabled = true;
};

socket.on('passSubmitted', ({ playerId, count }) => {
  if (playerId === myPlayerId) {
    // waiting for others
  }
});

socket.on('passingComplete', ({ currentTurn, hands }) => {
  gameState.currentTurn = currentTurn;
  const myHandData = hands.find(h => h.id === myPlayerId);
  myHand = myHandData ? myHandData.hand : [];
  showScreen('game');
  renderGame();
});

// ========== Game rendering ==========
function renderGame() {
  document.getElementById('trick-cards').innerHTML = '';
  document.getElementById('game-message').textContent = '';

  const positions = ['you', 'opp-1', 'opp-2', 'opp-0'];
  gameState.players.forEach((p, i) => {
    const handEl = document.getElementById(`hand-${positions[i]}`);
    const nameEl = document.getElementById(`hand-${positions[i]}`).previousElementSibling;
    
    if (positions[i] === 'you') {
      renderHand(`hand-${positions[i]}`, myHand, [], true, handleMyCard);
    } else {
      document.getElementById(`hand-${positions[i]}`).innerHTML = Array(p.handCount).fill('').map(() => `
        <div class="card" style="background:#2c3e50; color:transparent; cursor:default;"></div>
      `).join('');
    }

    document.getElementById(`hand-${positions[i]}`).parentElement.querySelector('.player-name').textContent = p.name;
    document.getElementById(`hand-${positions[i]}`).parentElement.querySelector('.score').textContent = `${p.score} pts`;
  });

  const yourTurn = gameState.currentTurn === gameState.players.findIndex(p => p.id === myPlayerId);
  document.getElementById('turn-indicator').textContent = yourTurn ? 'Votre tour !' : 'Tour adverse';
  document.getElementById('turn-indicator').className = `turn-indicator ${yourTurn ? 'your-turn' : ''}`;
}

function handleMyCard(cardId, el) {
  if (gameState.currentTurn !== gameState.players.findIndex(p => p.id === myPlayerId)) return;
  if (selectedCardId === cardId) return;

  document.querySelectorAll('#hand-you .card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedCardId = cardId;

  setTimeout(() => {
    socket.emit('playCard', { roomId: currentRoomId, cardId });
    selectedCardId = null;
    document.querySelectorAll('#hand-you .card').forEach(c => c.classList.remove('selected'));
  }, 300);
}

socket.on('cardPlayed', ({ playerId, card, trick }) => {
  gameState.trick = trick;
  const posIndex = gameState.players.findIndex(p => p.id === playerId);
  const positions = ['you', 'opp-1', 'opp-2', 'opp-0'];
  const pos = positions[posIndex];

  const trickEl = document.getElementById('trick-cards');
  const cardEl = document.createElement('div');
  cardEl.className = `card ${suitClass(card)}`;
  cardEl.innerHTML = `
    <div class="rank">${cardRankLabel(card)}</div>
    <div class="suit">${getSuitSymbol(card.suit)}</div>
  `;
  cardEl.style.position = 'absolute';
  cardEl.style.left = '50%';
  cardEl.style.top = '50%';
  cardEl.style.transform = 'translate(-50%, -50%)';
  cardEl.style.transition = 'all 0.5s ease';

  const offsets = {
    you: { x: 0, y: 80, rot: 0 },
    'opp-1': { x: -110, y: -20, rot: 45 },
    'opp-2': { x: 0, y: -110, rot: 180 },
    'opp-0': { x: 110, y: -20, rot: -45 }
  };

  const off = offsets[pos];
  cardEl.style.left = `calc(50% + ${off.x}px)`;
  cardEl.style.top = `calc(50% + ${off.y}px)`;
  cardEl.style.transform = `translate(-50%, -50%) rotate(${off.rot}deg)`;

  trickEl.appendChild(cardEl);

  // Remove from hand if it was ours
  if (playerId === myPlayerId) {
    myHand = myHand.filter(c => `${c.rank}_${c.suit}` !== `${card.rank}_${card.suit}`);
    renderHand('hand-you', myHand, [], false);
  }

  // Update hand counts
  updateHandCounts();
});

socket.on('trickComplete', ({ winner, points, cards, scores }) => {
  setTimeout(() => {
    document.getElementById('trick-cards').innerHTML = '';
    gameState.trick = [];
    gameState.heartsBroken = cards.some(c => (c.suit === 'CŒUR' || (c.suit === 'PIQUE' && c.rank === 'D')));

    const winnerIdx = gameState.players.findIndex(p => p.id === winner);
    const positions = ['you', 'opp-1', 'opp-2', 'opp-0'];
    const winnerName = gameState.players[winnerIdx].name;
    document.getElementById('game-message').textContent = `${winnerName} remporte le pli (${points} pts)`;

    scores.forEach(s => {
      const idx = gameState.players.findIndex(p => p.id === s.id);
      if (idx !== -1) gameState.players[idx].score = s.score;
    });

    renderGame();

    if (scores.some(s => s.id === myPlayerId)) {
      const myScore = scores.find(s => s.id === myPlayerId);
    }
  }, 1200);
});

socket.on('roundComplete', ({ scores, totalScores, gameOver, winner }) => {
  gameState = null;
  selectedCardId = null;

  const scoresHtml = scores.map(s => {
    const isMe = s.id === myPlayerId;
    return `
      <div class="score-row">
        <span>${s.name}${isMe ? ' (vous)' : ''}</span>
        <span>Manche: ${s.roundScore} pts | Total: ${s.total} pts</span>
      </div>
    `;
  }).join('');

  document.getElementById('round-over-scores').innerHTML = scoresHtml;

  if (gameOver) {
    const winnerName = winner ? winner.name : 'Personne';
    document.getElementById('game-over-title').textContent = `Partie terminée - ${winnerName} gagne !`;
    document.getElementById('game-over-scores').innerHTML = scoresHtml;
    showScreen('gameOver');
  } else {
    document.getElementById('round-over-title').textContent = 'Fin de manche';
    document.getElementById('round-over-scores').innerHTML = scoresHtml;
    showScreen('roundOver');
  }
});

document.getElementById('btn-next-round').onclick = () => {
  showScreen('game');
  renderGame();
};

document.getElementById('btn-play-again').onclick = () => {
  showScreen('home');
  loadRooms();
};

socket.on('shootTheMoon', ({ shooter }) => {
  document.getElementById('game-message').textContent = `Tir de la lune par ${gameState.players.find(p => p.id === shooter).name} !`;
});

socket.on('error', ({ message }) => {
  alert(message);
});

socket.on('disconnect', () => {
  document.getElementById('game-message').textContent = 'Déconnecté du serveur';
});

socket.on('reconnect', () => {
  if (currentRoomId) socket.emit('getRooms');
});

function updateHandCounts() {
  gameState.players.forEach((p, i) => {
    const positions = ['you', 'opp-1', 'opp-2', 'opp-0'];
    const handEl = document.getElementById(`hand-${positions[i]}`);
    if (positions[i] === 'you') return;
    const nameEl = handEl.parentElement.querySelector('.player-name');
    const count = p.handCount || 0;
    handEl.innerHTML = Array(count).fill('').map(() => `
      <div class="card" style="background:#2c3e50; color:transparent; cursor:default;"></div>
    `).join('');
  });
}

// Initialize (show login screen; rooms loaded after login)
showScreen('login');
;
