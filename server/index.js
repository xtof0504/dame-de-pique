const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const RoomManager = require('./rooms/RoomManager');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket']
});

const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
  console.log(`Client connecté: ${socket.id}`);

  socket.on('joinRoom', ({ roomId, name, isHuman }) => {
    const result = roomManager.joinRoom(socket, roomId, name, isHuman);
    if (result.success) {
      socket.emit('joined', { playerId: result.playerId, room: result.room });
      socket.to(roomId.toString()).emit('roomState', roomManager.getRoomState(roomId));
      socket.emit('roomState', roomManager.getRoomState(roomId));
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('leaveRoom', ({ roomId }) => {
    roomManager.leaveRoom(socket, roomId);
  });

  socket.on('setReady', ({ roomId, ready }) => {
    roomManager.setReady(socket, roomId, ready);
  });

  socket.on('startGame', ({ roomId }) => {
    roomManager.startGame(socket, roomId);
  });

  socket.on('playCard', ({ roomId, cardId }) => {
    roomManager.handleCardPlay(socket, roomId, cardId);
  });

  socket.on('submitPass', ({ roomId, cardIds }) => {
    roomManager.handlePass(socket, roomId, cardIds);
  });

  socket.on('getRooms', () => {
    socket.emit('roomsList', roomManager.getAllRooms());
  });

  socket.on('disconnect', () => {
    roomManager.rooms.forEach((room, roomId) => {
      const wasInRoom = room.players.some(p => p.id === socket.id);
      if (wasInRoom) {
        roomManager.leaveRoom(socket, roomId);
        if (room.game) {
          room.game.removePlayer(socket.id);
          roomManager.io.to(roomId.toString()).emit('roomState', roomManager.getRoomState(roomId));
        }
      }
    });
    console.log(`Client déconnecté: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur Dame de Pique démarré sur le port ${PORT}`);
});
