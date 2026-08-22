const socket = io();

// Generador Sintético de Notificaciones de Audio (Web Audio API)
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

// Desbloquear audio en navegadores y Canaima al hacer clic
document.addEventListener('click', () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
}, { once: true });

// PWA
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

let currentUser = null;
let activeTarget = null;
let contactsList = [];
let groupsList = [];
let onlineUserIds = new Set();
let currentTab = 'chats';
let selectedAvatar = '🤖';
let selectedColor = '#3a86ff';
let typingTimeout = null;

// Grabación Audio Multiplataforma
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// Cargar UI Guardada
document.body.className = localStorage.getItem('canaima_theme') || 'theme-light';
const savedBg = localStorage.getItem('canaima_custom_bg');
if (savedBg) document.documentElement.style.setProperty('--custom-chat-bg', `url('${savedBg}')`);

// Autologin por Token
const savedToken = localStorage.getItem('canaima_token');
if (savedToken) socket.emit('auth:login', { token: savedToken });

const authModal = document.getElementById('auth-modal');
const settingsModal = document.getElementById('settings-modal');
const pollModal = document.getElementById('poll-modal');
const listContainer = document.getElementById('list-container');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');

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

// Autenticación
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
        if (currentUser.token) localStorage.setItem('canaima_token', currentUser.token);
        
        authModal.classList.add('hidden');
        document.getElementById('current-user-name').innerText = currentUser.username;
        renderAvatarBox(document.getElementById('current-user-avatar'), selectedAvatar);
    } else {
        document.getElementById('auth-error').innerText = res.message || 'Error de autenticación';
    }
});

// Renderizador Seguro de Fotos de Perfil
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

// Lista de Usuarios Conectados
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

// Listas
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
    if (!activeTarget.isGroup && onlineUserIds.has(activeTarget.id)) dot.classList.remove('hidden');
    else dot.classList.add('hidden');

    document.getElementById('chat-header').classList.remove('hidden');
    document.getElementById('chat-footer').classList.remove('hidden');

    // Navegación Celulares
    document.getElementById('app-sidebar').classList.add('mobile-hidden');
    document.getElementById('app-chat-area').classList.remove('mobile-hidden');

    socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
}

document.getElementById('btn-back-chat').addEventListener('click', () => {
    document.getElementById('app-sidebar').classList.remove('mobile-hidden');
    document.getElementById('app-chat-area').classList.add('mobile-hidden');
});

// Eventos de "Escribiendo..."
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

// Enviar Mensaje
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

// Audio Multiplataforma
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
                    socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '🎤 Mensaje de voz', mediaUrl: evt.target.result });
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

// Adjuntar Imagen
document.getElementById('btn-attach').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && activeTarget) {
        const reader = new FileReader();
        reader.onload = (evt) => {
            socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '📷 Foto', mediaUrl: evt.target.result });
        };
        reader.readAsDataURL(file);
    }
});

// Mensajes y Notificaciones
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

function appendMessage(msg) {
    if (!currentUser) return;
    const isMe = msg.sender_id === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isMe ? 'sent' : 'received');
    bubble.id = 'msg-bubble-' + msg.id;

    if (isMe) bubble.style.backgroundColor = currentUser.bubble_color || '#3a86ff';
    else if (msg.bubble_color) bubble.style.backgroundColor = msg.bubble_color;

    let mediaHtml = '';
    if (msg.media_url) {
        if (msg.media_url.startsWith('data:audio')) {
            mediaHtml = '<audio controls src="' + msg.media_url + '"></audio>';
        } else {
            mediaHtml = '<img src="' + msg.media_url + '" style="max-width:220px; border-radius:8px; margin-top:5px;">';
        }
    }

    let pollHtml = '';
    if (msg.poll_data) {
        const p = JSON.parse(msg.poll_data);
        pollHtml = '<div class="poll-card"><strong>📊 ' + p.question + '</strong>';
        p.options.forEach((opt, idx) => {
            const votes = p.votes[idx] || 0;
            pollHtml += '<button class="poll-option-btn" onclick="votePoll(' + msg.id + ',' + idx + ')">' + opt + ' (' + votes + ' votos)</button>';
        });
        pollHtml += '</div>';
    }

    let headerHtml = '';
    if (activeTarget && activeTarget.isGroup && !isMe) {
        let av = msg.sender_avatar || '👤';
        let avTag = av.startsWith('data:image') ? `<span class="msg-avatar"><img src="${av}"></span>` : `<span class="msg-avatar">${av}</span>`;
        headerHtml = '<div class="msg-header-info">' + avTag + '<span class="msg-sender">' + msg.sender_name + '</span></div>';
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

// Editar/Borrar
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

// Encuestas
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
        const pollData = { question: q, options: opts, votes: {} };

        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '📊 Encuesta', pollData });
        pollModal.classList.add('hidden');
    }
});

window.votePoll = (msgId, optIdx) => socket.emit('poll:vote', { messageId: msgId, optionIdx: optIdx });
socket.on('poll:updated', ({ messageId, pollData }) => {
    if (activeTarget) socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
});

// Fotos de Perfil Personalizadas y Selección
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

// Fondo Personalizable del Chat
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

document.getElementById('btn-save-settings').addEventListener('click', () => {
    const username = document.getElementById('settings-username').value.trim() || currentUser.username;
    socket.emit('user:update_settings', { username, color: selectedColor, avatar: selectedAvatar });
});

socket.on('user:settings_updated', (d) => {
    currentUser.username = d.username;
    currentUser.avatar = d.avatar;
    currentUser.bubble_color = d.color;
    
    document.getElementById('current-user-name').innerText = d.username;
    renderAvatarBox(document.getElementById('current-user-avatar'), d.avatar);
    settingsModal.classList.add('hidden');
});

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('canaima_token');
    location.reload();
});

// Contactos y Grupos
document.getElementById('btn-add-contact').addEventListener('click', () => {
    const name = prompt("Apodo exacto:");
    if (name) socket.emit('contact:add', { searchName: name });
});
socket.on('contact:added', (c) => { contactsList.push(c); renderList(); });

document.getElementById('btn-create-group').addEventListener('click', () => {
    const name = prompt("Nombre del grupo:");
    if (name) socket.emit('group:create', { groupName: name });
});
socket.on('group:created', (g) => { groupsList.push(g); renderList(); });
