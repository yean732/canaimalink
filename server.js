const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e7 }); // 30MB

// Cadena de conexión a Supabase (reemplaza con tu URI exacta de Supabase)
const connectionString = process.env.DATABASE_URL || 'AQUI_VA_TU_URI_DE_SUPABASE';

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

// Inicialización de Tablas en PostgreSQL
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                avatar TEXT,
                bubble_color VARCHAR(20) DEFAULT '#3a86ff',
                bubble_shape VARCHAR(30) DEFAULT 'shape-normal',
                token TEXT
            );

            CREATE TABLE IF NOT EXISTS contacts (
                user_id INTEGER,
                contact_id INTEGER,
                PRIMARY KEY (user_id, contact_id)
            );

            CREATE TABLE IF NOT EXISTS groups (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                admin_id INTEGER,
                avatar TEXT DEFAULT '👥'
            );

            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER,
                user_id INTEGER,
                is_admin INTEGER DEFAULT 0,
                PRIMARY KEY (group_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS group_requests (
                group_id INTEGER,
                user_id INTEGER,
                PRIMARY KEY (group_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER,
                receiver_id INTEGER,
                group_id INTEGER,
                content TEXT,
                media_url TEXT,
                media_type VARCHAR(20),
                poll_data TEXT,
                is_edited INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Base de datos Supabase (PostgreSQL) conectada e inicializada con éxito");
    } catch (err) {
        console.error("❌ Error al inicializar Supabase:", err);
    }
}

initDb();

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();
const onlineUsers = new Map();

io.on('connection', (socket) => {

    socket.on('auth:login', async ({ username, password, token }) => {
        try {
            if (token) {
                const res = await pool.query(`SELECT * FROM users WHERE token = $1`, [token]);
                if (res.rows.length > 0) loginSuccess(socket, res.rows[0]);
                else socket.emit('auth:response', { success: false });
            } else {
                const res = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
                const user = res.rows[0];

                if (!user) {
                    const newToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
                    const newUser = await pool.query(
                        `INSERT INTO users (username, password, avatar, bubble_color, bubble_shape, token) 
                         VALUES ($1, $2, '🤖', '#3a86ff', 'shape-normal', $3) RETURNING *`,
                        [username, password, newToken]
                    );
                    loginSuccess(socket, newUser.rows[0]);
                } else if (user.password === password) {
                    loginSuccess(socket, user);
                } else {
                    socket.emit('auth:response', { success: false, message: 'Contraseña incorrecta' });
                }
            }
        } catch (e) {
            socket.emit('auth:response', { success: false, message: 'Error de conexión con la base de datos' });
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

    async function loadUserData(socket, userId) {
        try {
            const contacts = await pool.query(
                `SELECT u.id, u.username, u.avatar, u.bubble_color, u.bubble_shape 
                 FROM users u JOIN contacts c ON u.id = c.contact_id WHERE c.user_id = $1`,
                [userId]
            );
            socket.emit('data:contacts', contacts.rows || []);

            const groups = await pool.query(
                `SELECT g.id, g.name, g.admin_id, g.avatar 
                 FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = $1`,
                [userId]
            );
            if (groups.rows) {
                groups.rows.forEach(grp => socket.join(`group_${grp.id}`));
                socket.emit('data:groups', groups.rows);
            }
        } catch (e) {
            console.error("Error al cargar datos:", e);
        }
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

    socket.on('message:send', async ({ targetId, isGroup, content, mediaUrl, mediaType, pollData }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        const rId = isGroup ? null : parseInt(targetId);
        const gId = isGroup ? parseInt(targetId) : null;
        const pStr = pollData ? JSON.stringify(pollData) : null;

        try {
            const inserted = await pool.query(
                `INSERT INTO messages (sender_id, receiver_id, group_id, content, media_url, media_type, poll_data) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, timestamp`,
                [u.id, rId, gId, content, mediaUrl || null, mediaType || null, pStr]
            );

            const msgData = {
                id: inserted.rows[0].id, sender_id: u.id, sender_name: u.username, sender_avatar: u.avatar,
                bubble_color: u.bubble_color, bubble_shape: u.bubble_shape, receiver_id: rId, group_id: gId,
                content, media_url: mediaUrl, media_type: mediaType, poll_data: pStr, is_edited: 0, is_deleted: 0,
                timestamp: inserted.rows[0].timestamp
            };

            if (isGroup) {
                io.to(`group_${gId}`).emit('message:received', msgData);
            } else {
                socket.emit('message:received', msgData);
                const targetSockets = onlineUsers.get(parseInt(targetId));
                if (targetSockets) targetSockets.forEach(sId => io.to(sId).emit('message:received', msgData));
            }
        } catch (e) {
            console.error("Error al enviar mensaje:", e);
        }
    });

    socket.on('chat:load_messages', async ({ targetId, isGroup }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        try {
            let res;
            if (isGroup) {
                res = await pool.query(
                    `SELECT m.*, usr.username as sender_name, usr.avatar as sender_avatar, usr.bubble_color, usr.bubble_shape 
                     FROM messages m JOIN users usr ON m.sender_id = usr.id WHERE m.group_id = $1 ORDER BY m.timestamp ASC`,
                    [parseInt(targetId)]
                );
            } else {
                res = await pool.query(
                    `SELECT m.*, usr.username as sender_name, usr.avatar as sender_avatar, usr.bubble_color, usr.bubble_shape 
                     FROM messages m JOIN users usr ON m.sender_id = usr.id 
                     WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1) 
                     ORDER BY m.timestamp ASC`,
                    [u.id, parseInt(targetId)]
                );
            }
            socket.emit('chat:history', { targetId, isGroup, messages: res.rows || [] });
        } catch (e) {
            console.error("Error al cargar historial:", e);
        }
    });

    // SISTEMA DE GRUPOS
    socket.on('group:create', async ({ groupName }) => {
        const u = activeSockets.get(socket.id);
        try {
            const grp = await pool.query(`INSERT INTO groups (name, admin_id, avatar) VALUES ($1, $2, '👥') RETURNING id`, [groupName, u.id]);
            const gId = grp.rows[0].id;
            await pool.query(`INSERT INTO group_members (group_id, user_id, is_admin) VALUES ($1, $2, 1)`, [gId, u.id]);
            socket.join(`group_${gId}`);
            socket.emit('group:created', { id: gId, name: groupName, admin_id: u.id, avatar: '👥' });
        } catch (e) {
            console.error("Error al crear grupo:", e);
        }
    });

    socket.on('group:update_profile', async ({ groupId, name, avatar }) => {
        const u = activeSockets.get(socket.id);
        const check = await pool.query(`SELECT is_admin FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, u.id]);
        if (check.rows.length > 0 && check.rows[0].is_admin === 1) {
            await pool.query(`UPDATE groups SET name = $1, avatar = $2 WHERE id = $3`, [name, avatar, groupId]);
            io.to(`group_${groupId}`).emit('group:profile_updated', { groupId, name, avatar });
        }
    });

    socket.on('group:search', async ({ searchName }) => {
        const res = await pool.query(`SELECT id, name, admin_id, avatar FROM groups WHERE name ILIKE $1`, [`%${searchName}%`]);
        socket.emit('group:search_results', res.rows || []);
    });

    socket.on('group:request_join', async ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        await pool.query(`INSERT INTO group_requests (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, u.id]);
        socket.emit('group:request_sent');
        io.to(`group_${groupId}`).emit('group:member_updated');
    });

    socket.on('group:get_details', async ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        const grpRes = await pool.query(`SELECT g.*, gm.is_admin FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE g.id = $1 AND gm.user_id = $2`, [groupId, u.id]);
        const group = grpRes.rows[0];
        if (!group) return;

        const members = await pool.query(`SELECT u.id, u.username, u.avatar, gm.is_admin FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1`, [groupId]);
        const requests = await pool.query(`SELECT u.id, u.username, u.avatar FROM users u JOIN group_requests gr ON u.id = gr.user_id WHERE gr.group_id = $1`, [groupId]);

        socket.emit('group:details_data', {
            group,
            members: members.rows || [],
            requests: requests.rows || [],
            isCreator: group.admin_id === u.id,
            isAdmin: group.is_admin === 1
        });
    });

    socket.on('group:accept_request', async ({ groupId, userId }) => {
        await pool.query(`INSERT INTO group_members (group_id, user_id, is_admin) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [groupId, userId]);
        await pool.query(`DELETE FROM group_requests WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);

        const targetSockets = onlineUsers.get(parseInt(userId));
        if (targetSockets) {
            targetSockets.forEach(sId => {
                const clientSocket = io.sockets.sockets.get(sId);
                if (clientSocket) clientSocket.join(`group_${groupId}`);
            });
        }
        io.to(`group_${groupId}`).emit('group:member_updated');
    });

    socket.on('group:reject_request', async ({ groupId, userId }) => {
        await pool.query(`DELETE FROM group_requests WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
        socket.emit('group:member_updated');
    });

    socket.on('group:make_admin', async ({ groupId, userId }) => {
        await pool.query(`UPDATE group_members SET is_admin = 1 WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
        io.to(`group_${groupId}`).emit('group:member_updated');
    });

    socket.on('group:kick_member', async ({ groupId, userId }) => {
        await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
        io.to(`group_${groupId}`).emit('group:member_updated');
    });

    socket.on('group:leave', async ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, u.id]);
        socket.leave(`group_${groupId}`);
        socket.emit('group:left', { groupId });
        loadUserData(socket, u.id);
    });

    socket.on('group:delete', async ({ groupId }) => {
        const u = activeSockets.get(socket.id);
        const check = await pool.query(`SELECT admin_id FROM groups WHERE id = $1`, [groupId]);
        if (check.rows.length > 0 && check.rows[0].admin_id === u.id) {
            await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
            await pool.query(`DELETE FROM group_members WHERE group_id = $1`, [groupId]);
            await pool.query(`DELETE FROM group_requests WHERE group_id = $1`, [groupId]);
            await pool.query(`DELETE FROM messages WHERE group_id = $1`, [groupId]);
            io.to(`group_${groupId}`).emit('group:deleted_broadcast', { groupId });
        }
    });

    // Control de Encuestas
    socket.on('poll:vote', async ({ messageId, optionIdx }) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        const res = await pool.query(`SELECT poll_data FROM messages WHERE id = $1`, [messageId]);
        if (res.rows.length === 0 || !res.rows[0].poll_data) return;

        let poll = JSON.parse(res.rows[0].poll_data);
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

        await pool.query(`UPDATE messages SET poll_data = $1 WHERE id = $2`, [JSON.stringify(poll), messageId]);
        io.emit('poll:updated', { messageId, pollData: JSON.stringify(poll) });
    });

    socket.on('message:edit', async ({ messageId, newContent }) => {
        await pool.query(`UPDATE messages SET content = $1, is_edited = 1 WHERE id = $2`, [newContent, messageId]);
        io.emit('message:edited', { messageId, newContent });
    });

    socket.on('message:delete', async ({ messageId }) => {
        await pool.query(`UPDATE messages SET is_deleted = 1, content = 'Mensaje eliminado' WHERE id = $1`, [messageId]);
        io.emit('message:deleted', { messageId });
    });

    socket.on('user:update_settings', async (data) => {
        const u = activeSockets.get(socket.id);
        if (!u) return;

        await pool.query(
            `UPDATE users SET username = $1, avatar = $2, bubble_color = $3, bubble_shape = $4 WHERE id = $5`,
            [data.username, data.avatar, data.color, data.shape, u.id]
        );
        Object.assign(u, data);
        socket.emit('user:settings_updated', data);
        io.emit('user:profile_changed', { userId: u.id, username: data.username, avatar: data.avatar, bubble_color: data.color, bubble_shape: data.shape });
    });

    socket.on('contact:add', async ({ searchName }) => {
        const u = activeSockets.get(socket.id);
        const res = await pool.query(`SELECT id, username, avatar, bubble_color, bubble_shape FROM users WHERE username = $1`, [searchName]);
        const target = res.rows[0];

        if (target && target.id !== u.id) {
            await pool.query(`INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [u.id, target.id]);
            await pool.query(`INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [target.id, u.id]);
            socket.emit('contact:added', target);
        }
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

// Configurar Render para usar la variable de entorno DATABASE_URL
if (process.env.RENDER) {
    // Render asignará DATABASE_URL automáticamente
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log("🚀 Servidor MÁAY corriendo en el puerto " + PORT));
