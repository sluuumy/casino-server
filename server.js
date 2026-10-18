const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

let users = {};

io.on('connection', (socket) => {
    console.log('Un utilisateur est connecté :', socket.id);

    // Quand un joueur rejoint ou met à jour son profil/solde
    socket.on('user_join', (data) => {
        users[socket.id] = {
            username: data.username,
            balance: data.balance,
            badge: data.badge
        };
        // Envoyer la liste mise à jour à TOUS les joueurs
        io.emit('update_online_list', Object.values(users));
    });

    // Événement pour écouter les changements de solde en temps réel
    socket.on('update_balance', (data) => {
        if (users[socket.id]) {
            users[socket.id].balance = data.balance;
            users[socket.id].badge = data.badge;
        } else {
            users[socket.id] = {
                username: data.username,
                balance: data.balance,
                badge: data.badge
            };
        }
        // Diffuser immédiatement le nouveau classement à tout le monde
        io.emit('update_online_list', Object.values(users));
    });

    socket.on('send_message', (data) => {
        io.emit('chat_message', {
            username: users[socket.id]?.username || 'Anonyme',
            text: data.text,
            badge: data.badge
        });
    });

    socket.on('send_money', (data) => {
        // Logique de transfert entre joueurs si vous l'avez configurée
    });

    socket.on('disconnect', () => {
        delete users[socket.id];
        io.emit('update_online_list', Object.values(users));
        console.log('Utilisateur déconnecté :', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
