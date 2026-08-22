const socket = io();

// Sonidos para mensajes
const chatSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
const groupSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');

// PWA Support
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

let currentUser = null;
let activeTarget = null;
let contactsList = [];
let groupsList = [];
let currentTab = 'chats';
let selectedAvatar = '🤖';
let selectedColor = '#3a86ff';

// Grabador de voz
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// Cargar UI guardada
document.body.className = localStorage.getItem('canaima_theme') || 'theme-light';
document.documentElement.style.setProperty('--chat-font-size', localStorage.getItem('canaima_font_size') || '0.95rem');
document.documentElement.style.setProperty('--msg-gap', localStorage.getItem('canaima_msg_gap') || '10px');

// Autologin por Token
const savedToken = localStorage.getItem('canaima_token');
if (savedToken) socket.emit('auth:login', { token: savedToken });

const authModal = document.getElementById('auth-modal');
const settingsModal = document.getElementById('settings-modal');
const pollModal = document.getElementById('poll-modal');
const listContainer = document.getElementById('list-container');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');

// Pestañas abajo
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

function renderAvatarBox(container, avatarStr) {
    if (avatarStr && avatarStr.startsWith('data:image')) {
        container.innerHTML = '<img src="' + avatarStr + '" class="avatar-box">';
    } else {
        container.innerText = avatarStr || '👤';
    }
}

// Listas
socket.on('data:contacts', (d) => { contactsList = d; if (currentTab === 'chats') renderList(); });
socket.on('data:groups', (d) => { groupsList = d; if (currentTab === 'groups') renderList(); });

function renderList() {
    listContainer.innerHTML = '';
    const items = currentTab === 'chats' ? contactsList : groupsList;
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item';
        let av = item.avatar || '👤';
        let avHtml = av.startsWith('data:image') ? '<img src="' + av + '" class="avatar-box">' : '<span class="avatar-box">' + av + '</span>';
        div.innerHTML = avHtml + '<strong>' + (item.username || item.name) + '</strong>';
        div.addEventListener('click', () => selectChat(item));
        listContainer.appendChild(div);
    });
}

function selectChat(item) {
    activeTarget = { id: item.id, name: item.username || item.name, isGroup: currentTab === 'groups' };

    renderAvatarBox(document.getElementById('chat-target-avatar'), item.avatar || '👥');
    document.getElementById('chat-target-name').innerText = activeTarget.name;
    document.getElementById('chat-header').classList.remove('hidden');
    document.getElementById('chat-footer').classList.remove('hidden');

    // WhatsApp Navigation en Celulares
    document.getElementById('app-sidebar').classList.add('mobile-hidden');
    document.getElementById('app-chat-area').classList.remove('mobile-hidden');

    socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
}

document.getElementById('btn-back-chat').addEventListener('click', () => {
    document.getElementById('app-sidebar').classList.remove('mobile-hidden');
    document.getElementById('app-chat-area').classList.add('mobile-hidden');
});

// Enviar Mensaje
document.getElementById('btn-send').addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
    const content = messageInput.value.trim();
    if (content && activeTarget) {
        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content });
        messageInput.value = '';
    }
}

// Grabación de Audios
const btnRecord = document.getElementById('btn-record-audio');
btnRecord.addEventListener('click', async () => {
    if (!isRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onload = (evt) => {
                    socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '🎤 Mensaje de voz', mediaUrl: evt.target.result });
                };
                reader.readAsDataURL(audioBlob);
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

// Enviar Imagen
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

// Historial y Recepción de Mensajes con Sonido
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

    // Sonidos diferenciados
    if (currentUser && msg.sender_id !== currentUser.id) {
        if (msg.group_id) groupSound.play().catch(()=>{});
        else chatSound.play().catch(()=>{});
    }
});

function appendMessage(msg) {
    if (!currentUser) return;
    const isMe = msg.sender_id === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isMe ? 'sent' : 'received');
    bubble.id = 'msg-bubble-' + msg.id;

    // Color de burbuja asignado por el emisor (visible para todos)
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

    // Encuesta UI
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

    // Header para grupos (Avatar + Nombre)
    let headerHtml = '';
    if (activeTarget && activeTarget.isGroup && !isMe) {
        let av = msg.sender_avatar || '👤';
        let avTag = av.startsWith('data:image') ? '<img src="' + av + '" class="msg-avatar">' : '<span class="msg-avatar">' + av + '</span>';
        headerHtml = '<div class="msg-header-info">' + avTag + '<span class="msg-sender">' + msg.sender_name + '</span></div>';
    }

    // Acciones de Borrar y Editar (Solo mensajes propios)
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

// Editar y Borrar
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

// Foto de Perfil personalizada
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

// Guardar Ajustes
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
    const fontSize = document.getElementById('font-size-selector').value;
    const msgGap = document.getElementById('msg-gap-selector').value;
    const username = document.getElementById('settings-username').value.trim() || currentUser.username;

    document.documentElement.style.setProperty('--chat-font-size', fontSize);
    document.documentElement.style.setProperty('--msg-gap', msgGap);
    
    localStorage.setItem('canaima_font_size', fontSize);
    localStorage.setItem('canaima_msg_gap', msgGap);

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
