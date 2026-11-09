const Game = require('../game/Game');
const Bot = require('../bots/Bot');

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    for (let i = 1; i <= 8; i++) {
      this.rooms.set(i, { id: i, players: [], game: null, waitStartTime: null, started: false });
    }
    this.botNames = ['Bot Alice', 'Bot Bob', 'Bot Charlie', 'Bot Diana'];
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  getAllRooms() {
    return Array.from(this.rooms.values()).map(r => ({
      id: r.id,
      playerCount: r.players.length,
      started: r.started,
      waitRemaining: r.waitStartTime ? Math.max(0, 1200 - (Date.now() - r.waitStartTime)) : 1200
    }));
  }

  joinRoom(socket, roomId, name, isHuman) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: 'Salle introuvable' };
    if (!name || String(name).trim() === '') return { success: false, error: 'Un pseudo est requis' };
    if (room.started && room.game) return { success: false, error: 'Partie en cours' };
    if (room.players.length >= 4) return { success: false, error: 'Salle pleine' };

    const playerId = socket.id;
    room.players.push({ id: playerId, name: String(name).trim(), isBot: !isHuman, ready: false });
    socket.join(roomId.toString());

    if (!room.waitStartTime) {
      room.waitStartTime = Date.now();
      this.startWaitTimer(roomId);
    }

    return { success: true, playerId, room: this.getRoomState(roomId) };
  }

  leaveRoom(socket, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId.toString());

    if (room.game) {
      room.game.removePlayer(socket.id);
      this.io.to(roomId.toString()).emit('playerLeft', { playerId: socket.id });
      this.io.to(roomId.toString()).emit('roomState', this.getRoomState(roomId));
    } else {
      this.io.to(roomId.toString()).emit('roomState', this.getRoomState(roomId));
    }
  }

  setReady(socket, roomId, ready) {
    const room = this.rooms.get(roomId);
    if (!room || room.started || room.game) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = ready;
    this.io.to(roomId.toString()).emit('roomState', this.getRoomState(roomId));

    if (this.allReady(room) && room.players.length >= 1) {
      const humans = room.players.filter(p => !p.isBot).length;
      const botsNeeded = 4 - humans;
      this.addBots(roomId, botsNeeded);
      this.startGame(socket, roomId);
    }
  }

  allReady(room) {
    return room.players.length > 0 && room.players.every(p => p.ready);
  }

  startGame(socket, roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.started) return { success: false, error: 'Déjà démarré' };

    const humans = room.players.filter(p => !p.isBot).length;
    if (humans < 1) return { success: false, error: 'Au moins un humain requis' };

    const humansReady = room.players.filter(p => !p.isBot).every(p => p.ready);
    if (!humansReady) return { success: false, error: 'Tous les humains doivent être prêts' };

    const botsNeeded = 4 - room.players.length;
    this.addBots(roomId, botsNeeded);

    room.started = true;
    room.game = new Game(roomId, this.io);
    room.players.forEach(p => {
      room.game.addPlayer(p.id, p.name, p.isBot);
    });

    this.io.to(roomId.toString()).emit('gameStarting', {
      players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot })),
      botsAdded: botsNeeded
    });

    setTimeout(() => room.game.startRound(), 1500);
    return { success: true };
  }

  addBots(roomId, count) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (let i = 0; i < count; i++) {
      const botName = this.botNames[i] || `Bot ${i + 1}`;
      const botId = `bot_${roomId}_${i}`;
      room.players.push({ id: botId, name: botName, isBot: true, ready: true });
      if (room.game) {
        room.game.addPlayer(botId, botName, true);
      }
    }
  }

  startWaitTimer(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    setTimeout(() => {
      if (!room.started && room.waitStartTime && Date.now() - room.waitStartTime >= 1200000) {
        this.io.to(roomId.toString()).emit('roomExpired', { roomId });
        room.players = [];
        room.waitStartTime = null;
        this.io.to(roomId.toString()).emit('roomState', this.getRoomState(roomId));
      }
    }, 1200000);
  }

  handleCardPlay(socket, roomId, cardId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.game) return;
    room.game.playCard(socket.id, cardId);
  }

  handlePass(socket, roomId, cardIds) {
    const room = this.rooms.get(roomId);
    if (!room || !room.game) return;
    room.game.requestPass(socket.id, cardIds);
  }

  getRoomState(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      id: room.id,
      players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, ready: p.ready })),
      started: room.started,
      waitRemaining: room.waitStartTime ? Math.max(0, 1200 - (Date.now() - room.waitStartTime)) : 1200
    };
  }
}

module.exports = RoomManager;
