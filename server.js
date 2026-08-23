const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e7 }); // 30MB

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
        bubble_shape TEXT DEFAULT 'shape-normal',
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
        is_admin INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_requests (
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
        media_type TEXT,
        poll_data TEXT,
        is_edited INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();
const onlineUsers = new Map();

io.on('connection', (socket) => {

    socket.on('auth:login', ({ username, password, token }) => {
        if (token) {
            db.get(`SELECT * FROM users WHERE token = ?`, [token], (err, user) => {
                if (user) loginSuccess(socket, user);
                else socket.emit('auth:response', { success: false, message: 'Sesión inválida' });
            });
        } else {
            db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
                if (!user) {
                    const newToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
                    db.run(`INSERT INTO users (username, password, avatar, bubble_color, bubble_shape, token) VALUES (?, ?, '🤖', '#3a86ff', 'shape-normal', ?)`, 
                        [username, password, newToken], function(err) {
                        if (err) return socket.emit('auth:response', { success: false, message: 'Error al registrar' });
                        loginSuccess(socket, { id: this.lastID, username, avatar: '🤖', bubble_color: '#3a86ff', bubble_shape: 'shape-normal', token: newToken });
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
        if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
        onlineUsers.get(user.id).add(socket.id);

        socket.emit('auth:response', { success: true, user });
        broadcastOnlineState();
        loadUserData(socket, user.id);
    }

    function broadcastOnlineState() {
        io.emit('user:online_list', Array.from(onlineUsers.keys()));
    }

    function loadUserData(socket, userId) {
        db.all(`SELECT u.id, u.username, u.avatar, u.bubble_color, u.bubble_shape FROM users u JOIN contacts c ON u.id = c.contact_id WHERE c.user_id = ?`, [userId], (e, c) => {
            socket.emit('data:contacts', c || []);
        });

        db.all(`SELECT g.id, g.name, g.admin_id FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [userId], (e, g) => {
            if (g) {
                g.forEach(grp => socket.join(`group_${grp.id}`));
                socket.emit('data:groups', g);
            }
        });
    }

    socket.on('typing:start', ({ targetId, isGroup }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        if (isGroup) {
            socket.to(`group_${targetId}`).emit('typing:show', { senderId: u.id, senderName: u.username, targetId, isGroup: true });
        } else {
            const sockets = onlineUsers.get(parseInt(targetId));
            if (sockets) sockets.forEach(sId => io.to(sId).emit('typing:show', { senderId: u.id, senderName: u.username, targetId: u.id, isGroup: false }));
        }
    });

    socket.on('typing:stop', ({ targetId, isGroup }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        if (isGroup) {
            socket.to(`group_${targetId}`).emit('typing:hide', { senderId: u.id, targetId, isGroup: true });
        } else {
            const sockets = onlineUsers.get(parseInt(targetId));
            if (sockets) sockets.forEach(sId => io.to(sId).emit('typing:hide', { senderId: u.id, targetId: u.id, isGroup: false }));
        }
    });

    socket.on('message:send', ({ targetId, isGroup, content, mediaUrl, mediaType, pollData }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        const rId = isGroup ? null : targetId;
        const gId = isGroup ? targetId : null;
        const pStr = pollData ? JSON.stringify(pollData) : null;

        db.run(`INSERT INTO messages (sender_id, receiver_id, group_id, content, media_url, media_type, poll_data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [u.id, rId, gId, content, mediaUrl || null, mediaType || null, pStr], function(err) {
            if (err) return;
            const msgData = {
                id: this.lastID, sender_id: u.id, sender_name: u.username, sender_avatar: u.avatar,
                bubble_color: u.bubble_color, bubble_shape: u.bubble_shape, receiver_id: rId, group_id: gId,
                content, media_url: mediaUrl, media_type: mediaType, poll_data: pStr, is_edited: 0, is_deleted: 0,
                timestamp: new Date().toISOString()
            };

            if (isGroup) {
                io.to(`group_${gId}`).emit('message:received', msgData);
            } else {
                socket.emit('message:received', msgData);
                const targetSockets = onlineUsers.get(parseInt(targetId));
                if (targetSockets) targetSockets.forEach(sId => io.to(sId).emit('message:received', msgData));
            }
        });
    });

    socket.on('chat:load_messages', ({ targetId, isGroup }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        let q, p;
        if (isGroup) {
            q = `SELECT m.*, usr.username as sender_name, usr.avatar as sender_avatar, usr.bubble_color, usr.bubble_shape FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE m.group_id = ? ORDER BY m.timestamp ASC`;
            p = [targetId];
        } else {
            q = `SELECT m.*, usr.username as sender_name, usr.avatar as sender_avatar, usr.bubble_color, usr.bubble_shape FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?) ORDER BY m.timestamp ASC`;
            p = [u.id, targetId, targetId, u.id];
        }

        db.all(q, p, (err, rows) => {
            socket.emit('chat:history', { targetId, isGroup, messages: rows || [] });
        });
    });

    // SISTEMA DE GRUPOS
    socket.on('group:create', ({ groupName }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.run(`INSERT INTO groups (name, admin_id) VALUES (?, ?)`, [groupName, u.id], function() {
            const gId = this.lastID;
            db.run(`INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 1)`, [gId, u.id], () => {
                socket.join(`group_${gId}`);
                socket.emit('group:created', { id: gId, name: groupName, admin_id: u.id });
            });
        });
    });

    socket.on('group:search', ({ searchName }) => {
        db.all(`SELECT id, name, admin_id FROM groups WHERE name LIKE ?`, [`%${searchName}%`], (e, groups) => {
            socket.emit('group:search_results', groups || []);
        });
    });

    socket.on('group:request_join', ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.run(`INSERT OR IGNORE INTO group_requests (group_id, user_id) VALUES (?, ?)`, [groupId, u.id], () => {
            socket.emit('group:request_sent');
        });
    });

    socket.on('group:get_details', ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.get(`SELECT g.*, gm.is_admin FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE g.id = ? AND gm.user_id = ?`, [groupId, u.id], (e, group) => {
            if (!group) return;

            db.all(`SELECT u.id, u.username, u.avatar, gm.is_admin FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = ?`, [groupId], (e, members) => {
                db.all(`SELECT u.id, u.username, u.avatar FROM users u JOIN group_requests gr ON u.id = gr.user_id WHERE gr.group_id = ?`, [groupId], (e, requests) => {
                    socket.emit('group:details_data', {
                        group,
                        members: members || [],
                        requests: requests || [],
                        isCreator: group.admin_id === u.id,
                        isAdmin: group.is_admin === 1
                    });
                });
            });
        });
    });

    socket.on('group:accept_request', ({ groupId, userId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        // Validación de Administrador
        db.get(`SELECT is_admin FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, u.id], (e, res) => {
            if (!res || !res.is_admin) return;

            db.run(`INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)`, [groupId, userId], () => {
                db.run(`DELETE FROM group_requests WHERE group_id = ? AND user_id = ?`, [groupId, userId], () => {
                    const targetSockets = onlineUsers.get(parseInt(userId));
                    if (targetSockets) {
                        targetSockets.forEach(sId => {
                            const clientSocket = io.sockets.sockets.get(sId);
                            if (clientSocket) clientSocket.join(`group_${groupId}`);
                        });
                    }
                    io.to(`group_${groupId}`).emit('group:member_updated');
                });
            });
        });
    });

    socket.on('group:reject_request', ({ groupId, userId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.get(`SELECT is_admin FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, u.id], (e, res) => {
            if (!res || !res.is_admin) return;
            db.run(`DELETE FROM group_requests WHERE group_id = ? AND user_id = ?`, [groupId, userId], () => {
                socket.emit('group:member_updated');
            });
        });
    });

    socket.on('group:make_admin', ({ groupId, userId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.get(`SELECT admin_id FROM groups WHERE id = ?`, [groupId], (e, grp) => {
            if (!grp || grp.admin_id !== u.id) return; // Solo el creador original asigna nuevos admins
            db.run(`UPDATE group_members SET is_admin = 1 WHERE group_id = ? AND user_id = ?`, [groupId, userId], () => {
                io.to(`group_${groupId}`).emit('group:member_updated');
            });
        });
    });

    socket.on('group:kick_member', ({ groupId, userId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.get(`SELECT is_admin FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, u.id], (e, res) => {
            if (!res || !res.is_admin) return;
            db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, userId], () => {
                io.to(`group_${groupId}`).emit('group:member_updated');
            });
        });
    });

    socket.on('group:leave', ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, u.id], () => {
            socket.leave(`group_${groupId}`);
            socket.emit('group:left', { groupId });
            loadUserData(socket, u.id);
        });
    });

    socket.on('group:delete', ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.get(`SELECT admin_id FROM groups WHERE id = ?`, [groupId], (e, grp) => {
            if (grp && grp.admin_id === u.id) {
                db.run(`DELETE FROM groups WHERE id = ?`, [groupId]);
                db.run(`DELETE FROM group_members WHERE group_id = ?`, [groupId]);
                db.run(`DELETE FROM group_requests WHERE group_id = ?`, [groupId]);
                db.run(`DELETE FROM messages WHERE group_id = ?`, [groupId]);
                io.to(`group_${groupId}`).emit('group:deleted_broadcast', { groupId });
            }
        });
    });

    // Control de Encuestas
    socket.on('poll:vote', ({ messageId, optionIdx }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        db.get(`SELECT poll_data FROM messages WHERE id = ?`, [messageId], (e, row) => {
            if (!row || !row.poll_data) return;
            let poll = JSON.parse(row.poll_data);

            if (!poll.voters) poll.voters = {};

            const previousVote = poll.voters[u.id];

            if (previousVote && previousVote.optionIdx === optionIdx) {
                delete poll.voters[u.id];
                poll.votes[optionIdx] = Math.max(0, (poll.votes[optionIdx] || 1) - 1);
            } else {
                if (previousVote !== undefined) {
                    poll.votes[previousVote.optionIdx] = Math.max(0, (poll.votes[previousVote.optionIdx] || 1) - 1);
                }
                poll.voters[u.id] = { optionIdx, username: u.username };
                poll.votes[optionIdx] = (poll.votes[optionIdx] || 0) + 1;
            }

            db.run(`UPDATE messages SET poll_data = ? WHERE id = ?`, [JSON.stringify(poll), messageId], () => {
                io.emit('poll:updated', { messageId, pollData: JSON.stringify(poll) });
            });
        });
    });

    // Edición de Mensajes (con verificación de autor)
    socket.on('message:edit', ({ messageId, newContent }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.run(`UPDATE messages SET content = ?, is_edited = 1 WHERE id = ? AND sender_id = ?`, [newContent, messageId, u.id], function() {
            if (this.changes > 0) {
                io.emit('message:edited', { messageId, newContent });
            }
        });
    });

    // Eliminación de Mensajes (con verificación de autor)
    socket.on('message:delete', ({ messageId }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.run(`UPDATE messages SET is_deleted = 1, content = 'Mensaje eliminado' WHERE id = ? AND sender_id = ?`, [messageId, u.id], function() {
            if (this.changes > 0) {
                io.emit('message:deleted', { messageId });
            }
        });
    });

    socket.on('user:update_settings', (data) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        db.run(`UPDATE users SET username = ?, avatar = ?, bubble_color = ?, bubble_shape = ? WHERE id = ?`,
            [data.username, data.avatar, data.color, data.shape, u.id], () => {
            Object.assign(u, data);
            socket.emit('user:settings_updated', data);
            io.emit('user:profile_changed', { userId: u.id, username: data.username, avatar: data.avatar, bubble_color: data.color, bubble_shape: data.shape });
        });
    });

    socket.on('contact:add', ({ searchName }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;
        db.get(`SELECT id, username, avatar, bubble_color, bubble_shape FROM users WHERE username = ?`, [searchName], (e, target) => {
            if (target && target.id !== u.id) {
                db.run(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`, [u.id, target.id], () => {
                    db.run(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`, [target.id, u.id]);
                    socket.emit('contact:added', target);
                });
            }
        });
    });

    socket.on('disconnect', () => {
        const u = activeSockets.get(socket.id);
        if (u && onlineUsers.has(u.id)) {
            const userSockets = onlineUsers.get(u.id);
            userSockets.delete(socket.id);
            if (userSockets.size === 0) onlineUsers.delete(u.id);
        }
        activeSockets.delete(socket.id);
        broadcastOnlineState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log("Servidor iniciado en puerto " + PORT));
