const socket = io();

// Notificaciones de Sonido
function playTone(freq, duration) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + duration);
        osc.stop(ctx.currentTime + duration);
    } catch(e) {}
}

function playChatSound() { playTone(800, 0.15); }
function playGroupSound() { playTone(500, 0.25); }

document.addEventListener('click', () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
}, { once: true });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

let currentUser = null;
let activeTarget = null;
let contactsList = [];
let groupsList = [];
let onlineUserIds = new Set();
let currentTab = 'chats';
let selectedAvatar = '🤖';
let selectedColor = '#3a86ff';
let selectedShape = 'shape-normal';
let typingTimeout = null;

// Grabación Audio
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// Cargar UI Guardada
document.body.className = localStorage.getItem('canaima_theme') || 'theme-light';
const savedFontSize = localStorage.getItem('canaima_font_size') || '0.95rem';
const savedMsgGap = localStorage.getItem('canaima_msg_gap') || '10px';
const savedBg = localStorage.getItem('canaima_custom_bg');

document.documentElement.style.setProperty('--chat-font-size', savedFontSize);
document.documentElement.style.setProperty('--msg-gap', savedMsgGap);
if (savedBg) document.documentElement.style.setProperty('--custom-chat-bg', `url('${savedBg}')`);

// Autologin
const savedToken = localStorage.getItem('canaima_token');
if (savedToken) socket.emit('auth:login', { token: savedToken });

const authModal = document.getElementById('auth-modal');
const settingsModal = document.getElementById('settings-modal');
const pollModal = document.getElementById('poll-modal');
const groupInfoModal = document.getElementById('group-info-modal');
const listContainer = document.getElementById('list-container');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');

// Emojis
const emojiPicker = document.getElementById('emoji-picker');
document.getElementById('btn-toggle-emojis').addEventListener('click', () => emojiPicker.classList.toggle('hidden'));
emojiPicker.querySelectorAll('span').forEach(sp => {
    sp.addEventListener('click', () => {
        messageInput.value += sp.innerText;
        emojiPicker.classList.add('hidden');
        messageInput.focus();
    });
});

// Pestañas
const tabChats = document.getElementById('tab-chats');
const tabGroups = document.getElementById('tab-groups');

tabChats.addEventListener('click', () => {
    currentTab = 'chats';
    tabChats.classList.add('active');
    tabGroups.classList.remove('active');
    renderList();
});

tabGroups.addEventListener('click', () => {
    currentTab = 'groups';
    tabGroups.classList.add('active');
    tabChats.classList.remove('active');
    renderList();
});

// Login
document.getElementById('btn-login').addEventListener('click', () => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    if (username && password) socket.emit('auth:login', { username, password });
});

socket.on('auth:response', (res) => {
    if (res.success) {
        currentUser = res.user;
        selectedAvatar = currentUser.avatar || '🤖';
        selectedColor = currentUser.bubble_color || '#3a86ff';
        selectedShape = currentUser.bubble_shape || 'shape-normal';

        if (currentUser.token) localStorage.setItem('canaima_token', currentUser.token);
        
        authModal.classList.add('hidden');
        document.getElementById('current-user-name').innerText = currentUser.username;
        renderAvatarBox(document.getElementById('current-user-avatar'), selectedAvatar);
    } else {
        document.getElementById('auth-error').innerText = res.message || 'Error de autenticación';
    }
});

function renderAvatarBox(container, avatarStr) {
    container.innerHTML = '';
    if (avatarStr && avatarStr.startsWith('data:image')) {
        const img = document.createElement('img');
        img.src = avatarStr;
        container.appendChild(img);
    } else {
        container.innerText = avatarStr || '👤';
    }
}

// Online List
socket.on('user:online_list', (ids) => {
    onlineUserIds = new Set(ids);
    renderList();
    if (activeTarget && !activeTarget.isGroup) {
        const isOnline = onlineUserIds.has(activeTarget.id);
        const dot = document.getElementById('chat-target-status-dot');
        if (isOnline) dot.classList.remove('hidden');
        else dot.classList.add('hidden');
    }
});

socket.on('data:contacts', (d) => { contactsList = d; if (currentTab === 'chats') renderList(); });
socket.on('data:groups', (d) => { groupsList = d; if (currentTab === 'groups') renderList(); });

function renderList() {
    listContainer.innerHTML = '';
    const items = currentTab === 'chats' ? contactsList : groupsList;
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item';
        
        const wrapper = document.createElement('div');
        wrapper.className = 'avatar-wrapper';
        
        const avBox = document.createElement('div');
        avBox.className = 'avatar-box';
        renderAvatarBox(avBox, item.avatar || (currentTab === 'groups' ? '👥' : '👤'));
        
        wrapper.appendChild(avBox);
        if (currentTab === 'chats' && onlineUserIds.has(item.id)) {
            const dot = document.createElement('div');
            dot.className = 'online-dot';
            wrapper.appendChild(dot);
        }

        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = 'bold';
        nameSpan.innerText = item.username || item.name;

        div.appendChild(wrapper);
        div.appendChild(nameSpan);
        div.addEventListener('click', () => selectChat(item));
        listContainer.appendChild(div);
    });
}

function selectChat(item) {
    activeTarget = { id: item.id, name: item.username || item.name, isGroup: currentTab === 'groups' };

    renderAvatarBox(document.getElementById('chat-target-avatar'), item.avatar || (activeTarget.isGroup ? '👥' : '👤'));
    document.getElementById('chat-target-name').innerText = activeTarget.name;
    
    const dot = document.getElementById('chat-target-status-dot');
    const btnGroupConfig = document.getElementById('btn-group-config');

    if (activeTarget.isGroup) {
        dot.classList.add('hidden');
        btnGroupConfig.classList.remove('hidden');
    } else {
        btnGroupConfig.classList.add('hidden');
        if (onlineUserIds.has(activeTarget.id)) dot.classList.remove('hidden');
        else dot.classList.add('hidden');
    }

    document.getElementById('chat-header').classList.remove('hidden');
    document.getElementById('chat-footer').classList.remove('hidden');

    // Navegación Celular
    document.getElementById('app-sidebar').classList.add('mobile-hidden');
    document.getElementById('app-chat-area').classList.remove('mobile-hidden');

    socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
}

document.getElementById('btn-back-chat').addEventListener('click', () => {
    document.getElementById('app-sidebar').classList.remove('mobile-hidden');
    document.getElementById('app-chat-area').classList.add('mobile-hidden');
});

// Escribiendo...
messageInput.addEventListener('input', () => {
    if (!activeTarget) return;
    socket.emit('typing:start', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing:stop', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
    }, 2000);
});

socket.on('typing:show', ({ senderId, senderName, targetId, isGroup }) => {
    if (activeTarget && ((isGroup && activeTarget.isGroup && activeTarget.id === targetId) || (!isGroup && !activeTarget.isGroup && activeTarget.id === senderId))) {
        const label = isGroup ? `${senderName} está escribiendo` : 'Escribiendo';
        document.getElementById('typing-indicator').innerHTML = `${label} <span class="typing-dots"><span></span><span></span><span></span></span>`;
    }
});

socket.on('typing:hide', ({ senderId, targetId, isGroup }) => {
    if (activeTarget && ((isGroup && activeTarget.isGroup && activeTarget.id === targetId) || (!isGroup && !activeTarget.isGroup && activeTarget.id === senderId))) {
        document.getElementById('typing-indicator').innerHTML = '';
    }
});

// Enviar Mensajes
document.getElementById('btn-send').addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
    const content = messageInput.value.trim();
    if (content && activeTarget) {
        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content });
        messageInput.value = '';
        socket.emit('typing:stop', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
    }
}

// Audio Micrófono
function getSupportedMimeType() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/aac'];
    for (let type of types) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
}

const btnRecord = document.getElementById('btn-record-audio');
btnRecord.addEventListener('click', async () => {
    if (!isRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = getSupportedMimeType();
            mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
            audioChunks = [];
            
            mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                const finalMime = mediaRecorder.mimeType || 'audio/webm';
                const audioBlob = new Blob(audioChunks, { type: finalMime });
                const reader = new FileReader();
                reader.onload = (evt) => {
                    socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '🎤 Mensaje de voz', mediaUrl: evt.target.result, mediaType: 'audio' });
                };
                reader.readAsDataURL(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            isRecording = true;
            btnRecord.classList.add('btn-recording');
        } catch(err) { alert('Permiso de micrófono denegado'); }
    } else {
        mediaRecorder.stop();
        isRecording = false;
        btnRecord.classList.remove('btn-recording');
    }
});

// Adjuntar Archivos
document.getElementById('btn-attach').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && activeTarget) {
        let type = 'image';
        if (file.type.includes('pdf')) type = 'pdf';
        else if (file.type.includes('audio')) type = 'audio';

        const reader = new FileReader();
        reader.onload = (evt) => {
            socket.emit('message:send', { 
                targetId: activeTarget.id, 
                isGroup: activeTarget.isGroup, 
                content: file.name, 
                mediaUrl: evt.target.result,
                mediaType: type
            });
        };
        reader.readAsDataURL(file);
    }
});

// Cargar Mensajes
socket.on('chat:history', ({ messages }) => {
    messagesContainer.innerHTML = '';
    messages.forEach(appendMessage);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
});

socket.on('message:received', (msg) => {
    if (activeTarget && ((msg.group_id && msg.group_id === activeTarget.id) || (!msg.group_id && (msg.sender_id === activeTarget.id || msg.sender_id === currentUser.id)))) {
        appendMessage(msg);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    if (currentUser && msg.sender_id !== currentUser.id) {
        if (msg.group_id) playGroupSound();
        else playChatSound();
    }
});

// Iconos de Animales
const animalIcons = {
    'shape-perro': '🐶', 'shape-gato': '🐱', 'shape-rana': '🐸', 'shape-serpiente': '🐍',
    'shape-buho': '🦉', 'shape-pajaro': '🐦', 'shape-cuervo': '🦅'
};

function appendMessage(msg) {
    if (!currentUser) return;
    const isMe = msg.sender_id === currentUser.id;
    const bubble = document.createElement('div');
    
    const shapeClass = (isMe ? currentUser.bubble_shape : msg.bubble_shape) || 'shape-normal';
    bubble.className = `message-bubble ${isMe ? 'sent' : 'received'} ${shapeClass}`;
    bubble.id = 'msg-bubble-' + msg.id;

    if (isMe) bubble.style.backgroundColor = currentUser.bubble_color || '#3a86ff';
    else if (msg.bubble_color) bubble.style.backgroundColor = msg.bubble_color;

    let mediaHtml = '';
    if (msg.media_url) {
        if (msg.media_type === 'pdf' || msg.media_url.startsWith('data:application/pdf')) {
            mediaHtml = `<a href="${msg.media_url}" download="${msg.content || 'documento.pdf'}" class="pdf-attachment">📄 <span>${msg.content || 'Ver PDF'}</span></a>`;
        } else if (msg.media_type === 'audio' || msg.media_url.startsWith('data:audio')) {
            mediaHtml = `<audio controls src="${msg.media_url}"></audio>`;
        } else {
            mediaHtml = `<img src="${msg.media_url}" style="max-width:220px; border-radius:8px; margin-top:5px;">`;
        }
    }

    // Encuestas
    let pollHtml = '';
    if (msg.poll_data) {
        const p = JSON.parse(msg.poll_data);
        const votersMap = p.voters || {};
        const myVote = votersMap[currentUser.id];

        pollHtml = '<div class="poll-card"><strong>📊 ' + p.question + '</strong>';
        p.options.forEach((opt, idx) => {
            const votesCount = p.votes ? (p.votes[idx] || 0) : 0;
            const isMySelected = myVote && myVote.optionIdx === idx;
            
            let votedNames = Object.values(votersMap)
                .filter(v => v.optionIdx === idx)
                .map(v => v.username)
                .join(', ');

            pollHtml += `
                <div>
                    <button class="poll-option-btn ${isMySelected ? 'voted' : ''}" onclick="votePoll(${msg.id}, ${idx})">
                        <span>${opt} ${isMySelected ? '✔' : ''}</span>
                        <span>${votesCount} votos</span>
                    </button>
                    ${votedNames ? `<div class="voters-list">Votaron: ${votedNames}</div>` : ''}
                </div>`;
        });
        pollHtml += '</div>';
    }

    // NOMBRES VISIBLES EN GRUPOS
    let headerHtml = '';
    const animalTag = animalIcons[shapeClass] ? `<span class="animal-badge">${animalIcons[shapeClass]}</span>` : '';

    if (activeTarget && activeTarget.isGroup && !isMe) {
        let av = msg.sender_avatar || '👤';
        let avTag = av.startsWith('data:image') ? `<span class="msg-avatar"><img src="${av}"></span>` : `<span class="msg-avatar">${av}</span>`;
        headerHtml = `<div class="msg-header-info">${avTag}<span class="msg-sender">${msg.sender_name}</span> ${animalTag}</div>`;
    } else if (animalTag) {
        headerHtml = `<div class="msg-header-info">${animalTag}</div>`;
    }

    let actionsHtml = isMe && !msg.is_deleted ? 
        '<div class="msg-actions"><button onclick="editMsg(' + msg.id + ')">✏️</button><button onclick="deleteMsg(' + msg.id + ')">🗑️</button></div>' : '';

    let textContent = msg.is_deleted ? '<em>Mensaje eliminado</em>' : msg.content;
    let editTag = msg.is_edited && !msg.is_deleted ? '<span class="edited-tag">(editado)</span>' : '';

    bubble.innerHTML = actionsHtml + headerHtml + 
        '<div class="msg-text ' + (msg.is_deleted ? 'deleted' : '') + '" id="msg-text-' + msg.id + '">' + textContent + editTag + '</div>' + 
        mediaHtml + pollHtml +
        '<div class="msg-meta">' + new Date(msg.timestamp || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + '</div>';

    messagesContainer.appendChild(bubble);
}

// Editar / Eliminar
window.editMsg = (id) => {
    const newText = prompt("Editar mensaje:");
    if (newText) socket.emit('message:edit', { messageId: id, newContent: newText });
};

window.deleteMsg = (id) => {
    if (confirm("¿Borrar este mensaje?")) socket.emit('message:delete', { messageId: id });
};

socket.on('message:edited', ({ messageId, newContent }) => {
    const el = document.getElementById('msg-text-' + messageId);
    if (el) el.innerHTML = newContent + ' <span class="edited-tag">(editado)</span>';
});

socket.on('message:deleted', ({ messageId }) => {
    const el = document.getElementById('msg-text-' + messageId);
    if (el) { el.innerHTML = '<em>Mensaje eliminado</em>'; el.classList.add('deleted'); }
});

// Voto Encuesta
window.votePoll = (msgId, optIdx) => socket.emit('poll:vote', { messageId: msgId, optionIdx: optIdx });
socket.on('poll:updated', () => {
    if (activeTarget) socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
});

// Crear Encuestas
document.getElementById('btn-create-poll').addEventListener('click', () => pollModal.classList.remove('hidden'));
document.getElementById('btn-close-poll').addEventListener('click', () => pollModal.classList.add('hidden'));

document.getElementById('btn-send-poll').addEventListener('click', () => {
    const q = document.getElementById('poll-question').value.trim();
    const o1 = document.getElementById('poll-opt1').value.trim();
    const o2 = document.getElementById('poll-opt2').value.trim();
    const o3 = document.getElementById('poll-opt3').value.trim();

    if (q && o1 && o2 && activeTarget) {
        const opts = [o1, o2];
        if (o3) opts.push(o3);
        const pollData = { question: q, options: opts, votes: {}, voters: {} };

        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '📊 Encuesta', pollData });
        pollModal.classList.add('hidden');
    }
});

// GESTIÓN DE CONFIGURACIÓN Y ADMINISTRACIÓN DE GRUPO
document.getElementById('btn-group-config').addEventListener('click', () => {
    if (activeTarget && activeTarget.isGroup) {
        socket.emit('group:get_details', { groupId: activeTarget.id });
    }
});

socket.on('group:details_data', ({ group, members, requests, isCreator, isAdmin }) => {
    document.getElementById('group-info-title').innerText = group.name;
    const reqSection = document.getElementById('admin-requests-section');
    const reqList = document.getElementById('group-requests-list');
    const membersList = document.getElementById('group-members-list');
    const btnDelete = document.getElementById('btn-delete-group');

    // Solicitudes
    if (isAdmin && requests.length > 0) {
        reqSection.classList.remove('hidden');
        reqList.innerHTML = '';
        requests.forEach(r => {
            const d = document.createElement('div');
            d.className = 'group-member-item';
            d.innerHTML = `<span>${r.username}</span>
                <div>
                    <button class="action-btn" style="background:#22c55e;" onclick="acceptReq(${group.id}, ${r.id})">Aceptar</button>
                    <button class="action-btn" style="background:#ef4444;" onclick="rejectReq(${group.id}, ${r.id})">Rechazar</button>
                </div>`;
            reqList.appendChild(d);
        });
    } else {
        reqSection.classList.add('hidden');
    }

    // Lista de Miembros
    membersList.innerHTML = '';
    members.forEach(m => {
        const d = document.createElement('div');
        d.className = 'group-member-item';
        let roleBadge = m.is_admin ? '<span class="role-badge admin">Admin</span>' : '<span class="role-badge">Miembro</span>';
        
        let actions = '';
        if (isAdmin && m.id !== currentUser.id) {
            if (!m.is_admin) actions += `<button class="action-btn" style="background:#f59e0b; padding:2px 6px; font-size:0.65rem;" onclick="makeAdmin(${group.id}, ${m.id})">+ Admin</button> `;
            actions += `<button class="action-btn" style="background:#ef4444; padding:2px 6px; font-size:0.65rem;" onclick="kickMember(${group.id}, ${m.id})">Sacar</button>`;
        }

        d.innerHTML = `<div class="group-member-info"><span>${m.username}</span> ${roleBadge}</div><div>${actions}</div>`;
        membersList.appendChild(d);
    });

    if (isCreator) btnDelete.classList.remove('hidden');
    else btnDelete.classList.add('hidden');

    groupInfoModal.classList.remove('hidden');
});

document.getElementById('btn-close-group-info').addEventListener('click', () => groupInfoModal.classList.add('hidden'));

window.acceptReq = (gId, uId) => socket.emit('group:accept_request', { groupId: gId, userId: uId });
window.rejectReq = (gId, uId) => socket.emit('group:reject_request', { groupId: gId, userId: uId });
window.makeAdmin = (gId, uId) => socket.emit('group:make_admin', { groupId: gId, userId: uId });
window.kickMember = (gId, uId) => socket.emit('group:kick_member', { groupId: gId, userId: uId });

socket.on('group:member_updated', () => {
    if (activeTarget && activeTarget.isGroup) socket.emit('group:get_details', { groupId: activeTarget.id });
});

document.getElementById('btn-leave-group').addEventListener('click', () => {
    if (confirm("¿Deseas salir del grupo?")) {
        socket.emit('group:leave', { groupId: activeTarget.id });
        groupInfoModal.classList.add('hidden');
    }
});

document.getElementById('btn-delete-group').addEventListener('click', () => {
    if (confirm("¿ELIMINAR GRUPO PARA TODOS? Esta acción no se puede deshacer.")) {
        socket.emit('group:delete', { groupId: activeTarget.id });
        groupInfoModal.classList.add('hidden');
    }
});

socket.on('group:left', ({ groupId }) => {
    groupsList = groupsList.filter(g => g.id !== groupId);
    renderList();
    document.getElementById('chat-header').classList.add('hidden');
    document.getElementById('chat-footer').classList.add('hidden');
    messagesContainer.innerHTML = '<div class="placeholder-chat">Has salido del grupo</div>';
});

socket.on('group:deleted_broadcast', ({ groupId }) => {
    groupsList = groupsList.filter(g => g.id !== groupId);
    renderList();
    if (activeTarget && activeTarget.isGroup && activeTarget.id === groupId) {
        document.getElementById('chat-header').classList.add('hidden');
        document.getElementById('chat-footer').classList.add('hidden');
        messagesContainer.innerHTML = '<div class="placeholder-chat">Este grupo ha sido eliminado por el administrador</div>';
    }
});

// Fotos y Selección
document.getElementById('profile-img-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => { selectedAvatar = evt.target.result; };
        reader.readAsDataURL(file);
    }
});

document.querySelectorAll('.avatar-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
        document.querySelectorAll('.avatar-option').forEach(x => x.classList.remove('selected'));
        e.target.classList.add('selected');
        selectedAvatar = e.target.innerText;
    });
});

document.querySelectorAll('.color-circle').forEach(circle => {
    circle.addEventListener('click', (e) => {
        document.querySelectorAll('.color-circle').forEach(x => x.classList.remove('selected'));
        e.target.classList.add('selected');
        selectedColor = e.target.dataset.color;
    });
});

// Fondo del Chat
document.getElementById('bg-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
            const bgUrl = evt.target.result;
            document.documentElement.style.setProperty('--custom-chat-bg', `url('${bgUrl}')`);
            localStorage.setItem('canaima_custom_bg', bgUrl);
        };
        reader.readAsDataURL(file);
    }
});

document.getElementById('btn-reset-bg').addEventListener('click', () => {
    document.documentElement.style.setProperty('--custom-chat-bg', 'none');
    localStorage.removeItem('canaima_custom_bg');
});

// Ajustes
document.getElementById('btn-open-settings').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.classList.add('hidden'));

document.getElementById('btn-theme-light').addEventListener('click', () => {
    document.body.className = 'theme-light';
    localStorage.setItem('canaima_theme', 'theme-light');
});

document.getElementById('btn-theme-dark').addEventListener('click', () => {
    document.body.className = 'theme-dark';
    localStorage.setItem('canaima_theme', 'theme-dark');
});

document.getElementById('select-font-size').addEventListener('change', (e) => {
    document.documentElement.style.setProperty('--chat-font-size', e.target.value);
    localStorage.setItem('canaima_font_size', e.target.value);
});

document.getElementById('select-msg-gap').addEventListener('change', (e) => {
    document.documentElement.style.setProperty('--msg-gap', e.target.value);
    localStorage.setItem('canaima_msg_gap', e.target.value);
});

document.getElementById('btn-save-settings').addEventListener('click', () => {
    const username = document.getElementById('settings-username').value.trim() || currentUser.username;
    selectedShape = document.getElementById('select-bubble-shape').value;
    
    socket.emit('user:update_settings', { 
        username, 
        color: selectedColor, 
        avatar: selectedAvatar, 
        shape: selectedShape 
    });
});

socket.on('user:settings_updated', (d) => {
    currentUser.username = d.username;
    currentUser.avatar = d.avatar;
    currentUser.bubble_color = d.color;
    currentUser.bubble_shape = d.shape;
    
    document.getElementById('current-user-name').innerText = d.username;
    renderAvatarBox(document.getElementById('current-user-avatar'), d.avatar);
    settingsModal.classList.add('hidden');

    if (activeTarget) socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
});

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('canaima_token');
    location.reload();
});

// Contactos, Crear Grupos y BUSCAR Grupos
document.getElementById('btn-add-contact').addEventListener('click', () => {
    const name = prompt("Apodo exacto del contacto:");
    if (name) socket.emit('contact:add', { searchName: name });
});
socket.on('contact:added', (c) => { contactsList.push(c); renderList(); });

document.getElementById('btn-create-group').addEventListener('click', () => {
    const name = prompt("Nombre del NUEVO grupo a crear:");
    if (name) socket.emit('group:create', { groupName: name });
});
socket.on('group:created', (g) => { groupsList.push(g); renderList(); selectChat(g); });

// Buscar Grupos Existentes
document.getElementById('btn-search-group').addEventListener('click', () => {
    const name = prompt("Escribe el nombre del grupo que deseas BUSCAR:");
    if (name) socket.emit('group:search', { searchName: name });
});

socket.on('group:search_results', (results) => {
    if (results.length === 0) {
        alert("No se encontraron grupos con ese nombre.");
        return;
    }
    
    let text = "Grupos encontrados:\n";
    results.forEach((g, i) => { text += `${i + 1}. ${g.name} (ID: ${g.id})\n`; });
    text += "\nIngresa el ID del grupo al que quieres enviar solicitud para unirte:";
    
    const chosenId = prompt(text);
    if (chosenId) {
        socket.emit('group:request_join', { groupId: parseInt(chosenId) });
    }
});

socket.on('group:request_sent', () => alert("Solicitud de ingreso enviada al administrador del grupo."));
