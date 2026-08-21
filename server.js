const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // Permite archivos de hasta 10MB

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        bubble_color TEXT DEFAULT '#3a86ff',
        bg_url TEXT DEFAULT '',
        token TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        user_id INTEGER,
        contact_id INTEGER,
        PRIMARY KEY (user_id, contact_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        admin_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER,
        user_id INTEGER,
        PRIMARY KEY (group_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        group_id INTEGER,
        content TEXT,
        media_url TEXT,
        is_read INTEGER DEFAULT 0,
        reactions TEXT DEFAULT '{}',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();

io.on('connection', (socket) => {

    // Login por credenciales o por token (Autologin)
    socket.on('auth:login', ({ username, password, token }) => {
        if (token) {
            db.get(`SELECT * FROM users WHERE token = ?`, [token], (err, user) => {
                if (user) loginSuccess(socket, user);
                else socket.emit('auth:response', { success: false });
            });
        } else {
            db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
                if (!user) {
                    const newToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
                    db.run(`INSERT INTO users (username, password, avatar, token) VALUES (?, ?, '🤖', ?)`, 
                        [username, password, newToken], function() {
                        loginSuccess(socket, { id: this.lastID, username, avatar: '🤖', bubble_color: '#3a86ff', token: newToken });
                    });
                } else if (user.password === password) {
                    loginSuccess(socket, user);
                } else {
                    socket.emit('auth:response', { success: false, message: 'Contraseña incorrecta' });
                }
            });
        }
    });

    function loginSuccess(socket, user) {
        activeSockets.set(socket.id, user);
        socket.emit('auth:response', { success: true, user });
        loadUserData(socket, user.id);
    }

    function loadUserData(socket, userId) {
        db.all(`SELECT u.id, u.username, u.avatar FROM users u JOIN contacts c ON u.id = c.contact_id WHERE c.user_id = ?`, [userId], (e, c) => {
            socket.emit('data:contacts', c || []);
        });

        db.all(`SELECT g.id, g.name, g.admin_id FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [userId], (e, g) => {
            if (g) {
                g.forEach(grp => socket.join(`group_${grp.id}`));
                socket.emit('data:groups', g);
            }
        });
    }

    // Indicador "Escribiendo..."
    socket.on('typing', ({ targetId, isGroup, isTyping }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        if (isGroup) {
            socket.to(`group_${targetId}`).emit('user:typing', { username: u.username, isTyping });
        } else {
            for (let [sId, usr] of activeSockets.entries()) {
                if (usr.id === parseInt(targetId)) {
                    io.to(sId).emit('user:typing', { username: u.username, isTyping });
                    break;
                }
            }
        }
    });

    // Envío de Mensajes
    socket.on('message:send', ({ targetId, isGroup, content, mediaUrl }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        const rId = isGroup ? null : targetId;
        const gId = isGroup ? targetId : null;

        db.run(`INSERT INTO messages (sender_id, receiver_id, group_id, content, media_url) VALUES (?, ?, ?, ?, ?)`,
            [u.id, rId, gId, content, mediaUrl || null], function() {
            const msgData = {
                id: this.lastID, sender_id: u.id, sender_name: u.username,
                bubble_color: u.bubble_color || '#3a86ff', receiver_id: rId, group_id: gId,
                content, media_url: mediaUrl, is_read: 0, reactions: '{}', timestamp: new Date().toISOString()
            };

            if (isGroup) {
                io.to(`group_${gId}`).emit('message:received', msgData);
            } else {
                socket.emit('message:received', msgData);
                for (let [sId, usr] of activeSockets.entries()) {
                    if (usr.id === parseInt(targetId)) {
                        io.to(sId).emit('message:received', msgData);
                        break;
                    }
                }
            }
        });
    });

    // Cargar historial y marcar como LEÍDO
    socket.on('chat:load_messages', ({ targetId, isGroup }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        let q, p;
        if (isGroup) {
            q = `SELECT m.*, usr.username as sender_name, usr.bubble_color FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE m.group_id = ? ORDER BY m.timestamp ASC`;
            p = [targetId];
        } else {
            q = `SELECT m.*, usr.username as sender_name, usr.bubble_color FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?) ORDER BY m.timestamp ASC`;
            p = [u.id, targetId, targetId, u.id];
            
            db.run(`UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?`, [targetId, u.id]);
        }

        db.all(q, p, (err, rows) => {
            socket.emit('chat:history', { targetId, isGroup, messages: rows || [] });
        });
    });

    // Reacciones con Emojis
    socket.on('message:react', ({ messageId, emoji }) => {
        db.get(`SELECT reactions FROM messages WHERE id = ?`, [messageId], (e, row) => {
            if (!row) return;
            let reactions = JSON.parse(row.reactions || '{}');
            reactions[emoji] = (reactions[emoji] || 0) + 1;
            
            db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), messageId], () => {
                io.emit('message:reacted', { messageId, reactions });
            });
        });
    });

    // Actualización de Perfil y Estilos
    socket.on('user:update_settings', (data) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        db.run(`UPDATE users SET username = ?, avatar = ?, bubble_color = ?, bg_url = ? WHERE id = ?`,
            [data.username, data.avatar, data.color, data.bgUrl, u.id], () => {
            Object.assign(u, data);
            socket.emit('user:settings_updated', data);
        });
    });

    socket.on('contact:add', ({ searchName }) => {
        const u = activeSockets.get(socket.id);
        db.get(`SELECT id, username, avatar FROM users WHERE username = ?`, [searchName], (e, target) => {
            if (target && target.id !== u.id) {
                db.run(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`, [u.id, target.id], () => {
                    socket.emit('contact:added', target);
                });
            }
        });
    });

    socket.on('group:create', ({ groupName }) => {
        const u = activeSockets.get(socket.id);
        db.run(`INSERT INTO groups (name, admin_id) VALUES (?, ?)`, [groupName, u.id], function() {
            const gId = this.lastID;
            db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [gId, u.id], () => {
                socket.join(`group_${gId}`);
                socket.emit('group:created', { id: gId, name: groupName, admin_id: u.id });
            });
        });
    });

    socket.on('disconnect', () => activeSockets.delete(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log("Servidor activo en el puerto " + PORT));
