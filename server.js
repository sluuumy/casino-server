const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // Autorise la connexion depuis votre GitHub Pages
});

// Stockage des utilisateurs connectés
const onlineUsers = {}; 

io.on('connection', (socket) => {
  console.log('Un joueur s\'est connecté :', socket.id);

  // 1. Inscription / Connexion du joueur sur le serveur
  socket.on('user_join', (data) => {
    onlineUsers[socket.id] = { username: data.username, balance: data.balance || 0 };
    io.emit('chat_message', { system: true, text: `${data.username} a rejoint le casino !` });
    io.emit('update_online_list', Object.values(onlineUsers));
  });

  // 2. Tchat en direct
  socket.on('send_message', (msg) => {
    const user = onlineUsers[socket.id];
    if (user) {
      io.emit('chat_message', { username: user.username, text: msg });
    }
  });

  // 3. Suivi des paris en direct
  socket.on('place_bet', (betData) => {
    const user = onlineUsers[socket.id];
    if (user) {
      io.emit('live_bet', {
        username: user.username,
        game: betData.game,
        amount: betData.amount,
        win: betData.win,
        payout: betData.payout
      });
    }
  });

  // 4. Donner de l'argent à un autre joueur
  socket.on('send_money', (data) => {
    const sender = onlineUsers[socket.id];
    const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === data.targetUser);

    if (sender && targetSocketId) {
      // Prévenir le destinataire
      io.to(targetSocketId).emit('receive_money', {
        from: sender.username,
        amount: data.amount
      });
      
      // Message public dans le chat
      io.emit('chat_message', {
        system: true,
        text: `🎁 ${sender.username} a donné $${data.amount} à ${data.targetUser} !`
      });
    }
  });

  // Déconnexion
  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) {
      io.emit('chat_message', { system: true, text: `${user.username} a quitté le casino.` });
      delete onlineUsers[socket.id];
      io.emit('update_online_list', Object.values(onlineUsers));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));