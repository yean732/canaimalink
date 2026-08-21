const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static('public'));

// Evento de conexión al chat
io.on('connection', (socket) => {
  console.log('Un usuario se ha conectado');

  // Recibir mensaje y reenviarlo a todos los conectados
  socket.on('chat message', (msg) => {
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('Un usuario se ha desconectado');
  });
});

// Iniciar servidor en el puerto 3000
http.listen(3000, () => {
  console.log('Servidor ejecutándose en http://localhost:3000');
});
