const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Conexión a la base de datos
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Error BD:", err.message);
    else console.log("Base de datos SQLite activa.");
});

// Tablas
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        font_family TEXT DEFAULT 'sans'
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
        font TEXT,
        is_edited INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();

io.on('connection', (socket) => {

    // Registro e Inicio de sesión
    socket.on('auth:login', ({ username, password }) => {
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
            if (err) return socket.emit('auth:response', { success: false, message: 'Error en servidor' });
            
            if (!user) {
                const defaultAvatar = '🤖';
                db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
                    [username, password, defaultAvatar], 
                    function(err) {
                        if (err) return socket.emit('auth:response', { success: false, message: 'Error al registrar' });
                        const newUser = { id: this.lastID, username, avatar: defaultAvatar, font_family: 'sans' };
                        activeSockets.set(socket.id, newUser);
                        socket.emit('auth:response', { success: true, user: newUser });
                        loadUserData(socket, newUser.id);
                    }
                );
            } else {
                if (user.password !== password) {
                    return socket.emit('auth:response', { success: false, message: 'Contraseña incorrecta' });
                }
                const userData = { id: user.id, username: user.username, avatar: user.avatar, font_family: user.font_family };
                activeSockets.set(socket.id, userData);
                socket.emit('auth:response', { success: true, user: userData });
                loadUserData(socket, user.id);
            }
        });
    });

    function loadUserData(socket, userId) {
        db.all(`SELECT u.id, u.username, u.avatar FROM users u 
                JOIN contacts c ON u.id = c.contact_id WHERE c.user_id = ?`, [userId], (err, contacts) => {
            socket.emit('data:contacts', contacts || []);
        });

        db.all(`SELECT g.id, g.name, g.admin_id FROM groups g 
                JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [userId], (err, groups) => {
            if (groups) {
                groups.forEach(g => socket.join(`group_${g.id}`));
                socket.emit('data:groups', groups);
            }
        });
    }

    // Perfil y Configuración
    socket.on('user:update_settings', ({ avatar, font, password }) => {
        const currentUser = activeSockets.get(socket.id);
        if (!currentUser) return;

        let query = `UPDATE users SET avatar = ?, font_family = ?`;
        let params = [avatar, font];

        if (password && password.trim() !== "") {
            query += `, password = ?`;
            params.push(password);
        }

        query += ` WHERE id = ?`;
        params.push(currentUser.id);

        db.run(query, params, (err) => {
            if (!err) {
                currentUser.avatar = avatar;
                currentUser.font_family = font;
                activeSockets.set(socket.id, currentUser);
                socket.emit('user:settings_updated', { avatar, font });
            }
        });
    });

    // Añadir Contacto
    socket.on('contact:add', ({ searchName }) => {
        const currentUser = activeSockets.get(socket.id);
        if (!currentUser) return;

        db.get(`SELECT id, username, avatar FROM users WHERE username = ?`, [searchName], (err, targetUser) => {
            if (!targetUser) return socket.emit('notification', { message: 'Usuario no encontrado' });
            if (targetUser.id === currentUser.id) return socket.emit('notification', { message: 'No puedes agregarte a ti mismo' });

            db.run(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`, 
                [currentUser.id, targetUser.id], (err) => {
                if (!err) socket.emit('contact:added', targetUser);
            });
        });
    });

    // Grupos
    socket.on('group:create', ({ groupName }) => {
        const currentUser = activeSockets.get(socket.id);
        if (!currentUser) return;

        db.run(`INSERT INTO groups (name, admin_id) VALUES (?, ?)`, [groupName, currentUser.id], function(err) {
            if (err) return;
            const groupId = this.lastID;
            db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, currentUser.id], () => {
                socket.join(`group_${groupId}`);
                socket.emit('group:created', { id: groupId, name: groupName, admin_id: currentUser.id });
            });
        });
    });

    socket.on('group:add_member', ({ groupId, username }) => {
        const currentUser = activeSockets.get(socket.id);
        db.get(`SELECT admin_id FROM groups WHERE id = ?`, [groupId], (err, group) => {
            if (!group || group.admin_id !== currentUser.id) {
                return socket.emit('notification', { message: 'Solo el admin puede añadir personas' });
            }
            db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, userToAdd) => {
                if (!userToAdd) return socket.emit('notification', { message: 'Usuario no encontrado' });
                db.run(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, userToAdd.id], () => {
                    socket.emit('notification', { message: `Añadido ${username} al grupo` });
                });
            });
        });
    });

    socket.on('group:leave', ({ groupId }) => {
        const currentUser = activeSockets.get(socket.id);
        db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, currentUser.id], () => {
            socket.leave(`group_${groupId}`);
            socket.emit('group:left', { groupId });
        });
    });

    // Historial y Mensajes
    socket.on('chat:load_messages', ({ targetId, isGroup }) => {
        const currentUser = activeSockets.get(socket.id);
        if (!currentUser) return;

        let query, params;
        if (isGroup) {
            query = `SELECT m.*, u.username as sender_name FROM messages m 
                     JOIN users u ON m.sender_id = u.id 
                     WHERE m.group_id = ? ORDER BY m.timestamp ASC`;
            params = [targetId];
        } else {
            query = `SELECT m.*, u.username as sender_name FROM messages m 
                     JOIN users u ON m.sender_id = u.id 
                     WHERE (m.sender_id = ? AND m.receiver_id = ?) 
                        OR (m.sender_id = ? AND m.receiver_id = ?) ORDER BY m.timestamp ASC`;
            params = [currentUser.id, targetId, targetId, currentUser.id];
        }

        db.all(query, params, (err, rows) => {
            socket.emit('chat:history', { targetId, isGroup, messages: rows || [] });
        });
    });

    socket.on('message:send', ({ targetId, isGroup, content }) => {
        const currentUser = activeSockets.get(socket.id);
        if (!currentUser) return;

        const font = currentUser.font_family || 'sans';
        const receiverId = isGroup ? null : targetId;
        const groupId = isGroup ? targetId : null;

        db.run(`INSERT INTO messages (sender_id, receiver_id, group_id, content, font) VALUES (?, ?, ?, ?, ?)`,
            [currentUser.id, receiverId, groupId, content, font],
            function(err) {
                if (err) return;
                const msgData = {
                    id: this.lastID,
                    sender_id: currentUser.id,
                    sender_name: currentUser.username,
                    receiver_id: receiverId,
                    group_id: groupId,
                    content,
                    font,
                    is_edited: 0,
                    is_deleted: 0,
                    timestamp: new Date().toISOString()
                };

                if (isGroup) {
                    io.to(`group_${groupId}`).emit('message:received', msgData);
                } else {
                    socket.emit('message:received', msgData);
                    for (let [sId, uData] of activeSockets.entries()) {
                        if (uData.id === parseInt(targetId)) {
                            io.to(sId).emit('message:received', msgData);
                            break;
                        }
                    }
                }
            }
        );
    });

    socket.on('message:edit', ({ messageId, newContent }) => {
        const currentUser = activeSockets.get(socket.id);
        db.run(`UPDATE messages SET content = ?, is_edited = 1 WHERE id = ? AND sender_id = ?`, 
            [newContent, messageId, currentUser.id], function() {
            if (this.changes > 0) {
                io.emit('message:updated', { messageId, newContent });
            }
        });
    });

    socket.on('message:delete', ({ messageId }) => {
        const currentUser = activeSockets.get(socket.id);
        db.run(`UPDATE messages SET is_deleted = 1, content = '🚫 Este mensaje fue eliminado' WHERE id = ? AND sender_id = ?`, 
            [messageId, currentUser.id], function() {
            if (this.changes > 0) {
                io.emit('message:deleted', { messageId });
            }
        });
    });

    socket.on('chat:clear_local', ({ targetId, isGroup }) => {
        const currentUser = activeSockets.get(socket.id);
        if (isGroup) {
            db.run(`DELETE FROM messages WHERE group_id = ?`, [targetId]);
        } else {
            db.run(`DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)`,
                [currentUser.id, targetId, targetId, currentUser.id]);
        }
        socket.emit('chat:cleared', { targetId, isGroup });
    });

    socket.on('disconnect', () => activeSockets.delete(socket.id));
});

server.listen(3000, '0.0.0.0', () => {
    console.log("CanaimaLink listo en red local");
});
