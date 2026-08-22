const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7 }); // 20MB para fotos/audios

// Base de datos persistente
const dbDir = process.env.RENDER ? '/tmp' : '.';
const dbPath = path.join(dbDir, 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        bubble_color TEXT DEFAULT '#3a86ff',
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
        poll_data TEXT,
        is_edited INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();

io.on('connection', (socket) => {

    // Login y Autologin mediante Token
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
                    db.run(`INSERT INTO users (username, password, avatar, bubble_color, token) VALUES (?, ?, '🤖', '#3a86ff', ?)`, 
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
        db.all(`SELECT u.id, u.username, u.avatar, u.bubble_color FROM users u JOIN contacts c ON u.id = c.contact_id WHERE c.user_id = ?`, [userId], (e, c) => {
            socket.emit('data:contacts', c || []);
        });

        db.all(`SELECT g.id, g.name, g.admin_id FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [userId], (e, g) => {
            if (g) {
                g.forEach(grp => socket.join(`group_${grp.id}`));
                socket.emit('data:groups', g);
            }
        });
    }

    // Mensajes y Audios
    socket.on('message:send', ({ targetId, isGroup, content, mediaUrl, pollData }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        const rId = isGroup ? null : targetId;
        const gId = isGroup ? targetId : null;
        const pStr = pollData ? JSON.stringify(pollData) : null;

        db.run(`INSERT INTO messages (sender_id, receiver_id, group_id, content, media_url, poll_data) VALUES (?, ?, ?, ?, ?, ?)`,
            [u.id, rId, gId, content, mediaUrl || null, pStr], function() {
            const msgData = {
                id: this.lastID, sender_id: u.id, sender_name: u.username, sender_avatar: u.avatar,
                bubble_color: u.bubble_color, receiver_id: rId, group_id: gId,
                content, media_url: mediaUrl, poll_data: pStr, is_edited: 0, is_deleted: 0,
                timestamp: new Date().toISOString()
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

    // Cargar Historial
    socket.on('chat:load_messages', ({ targetId, isGroup }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        let q, p;
        if (isGroup) {
            q = `SELECT m.*, usr.username as sender_name, usr.avatar as sender_avatar, usr.bubble_color FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE m.group_id = ? ORDER BY m.timestamp ASC`;
            p = [targetId];
        } else {
            q = `SELECT m.*, usr.username as sender_name, usr.avatar as sender_avatar, usr.bubble_color FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?) ORDER BY m.timestamp ASC`;
            p = [u.id, targetId, targetId, u.id];
        }

        db.all(q, p, (err, rows) => {
            socket.emit('chat:history', { targetId, isGroup, messages: rows || [] });
        });
    });

    // Editar Mensaje
    socket.on('message:edit', ({ messageId, newContent }) => {
        db.run(`UPDATE messages SET content = ?, is_edited = 1 WHERE id = ?`, [newContent, messageId], () => {
            io.emit('message:edited', { messageId, newContent });
        });
    });

    // Borrar Mensaje
    socket.on('message:delete', ({ messageId }) => {
        db.run(`UPDATE messages SET is_deleted = 1, content = 'Mensaje eliminado' WHERE id = ?`, [messageId], () => {
            io.emit('message:deleted', { messageId });
        });
    });

    // Votar en Encuestas
    socket.on('poll:vote', ({ messageId, optionIdx }) => {
        db.get(`SELECT poll_data FROM messages WHERE id = ?`, [messageId], (e, row) => {
            if (!row || !row.poll_data) return;
            let poll = JSON.parse(row.poll_data);
            poll.votes[optionIdx] = (poll.votes[optionIdx] || 0) + 1;
            
            db.run(`UPDATE messages SET poll_data = ? WHERE id = ?`, [JSON.stringify(poll), messageId], () => {
                io.emit('poll:updated', { messageId, pollData: JSON.stringify(poll) });
            });
        });
    });

    // Actualizar Ajustes
    socket.on('user:update_settings', (data) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        db.run(`UPDATE users SET username = ?, avatar = ?, bubble_color = ? WHERE id = ?`,
            [data.username, data.avatar, data.color, u.id], () => {
            Object.assign(u, data);
            socket.emit('user:settings_updated', data);
        });
    });

    // Contactos y Grupos
    socket.on('contact:add', ({ searchName }) => {
        const u = activeSockets.get(socket.id);
        db.get(`SELECT id, username, avatar, bubble_color FROM users WHERE username = ?`, [searchName], (e, target) => {
            if (target && target.id !== u.id) {
                db.run(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`, [u.id, target.id], () => {
                    db.run(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`, [target.id, u.id]);
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
server.listen(PORT, '0.0.0.0', () => console.log("Servidor iniciado en puerto " + PORT));
