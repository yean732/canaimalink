const socket = io();

// Registro de PWA (App Instalable)
let deferredPrompt;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('btn-install-pwa').classList.remove('hidden');
});
document.getElementById('btn-install-pwa').addEventListener('click', () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt = null;
    }
});

let currentUser = null;
let activeTarget = null;
let contactsList = [];
let groupsList = [];
let currentTab = 'chats';
let typingTimeout = null;

// Cargar ajustes guardados
document.body.className = localStorage.getItem('canaima_theme') || 'theme-light';

// Autologin por Token
const savedToken = localStorage.getItem('canaima_token');
if (savedToken) {
    socket.emit('auth:login', { token: savedToken });
}

const authModal = document.getElementById('auth-modal');
const settingsModal = document.getElementById('settings-modal');
const listContainer = document.getElementById('list-container');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const chatHeader = document.getElementById('chat-header');
const chatFooter = document.getElementById('chat-footer');

document.getElementById('btn-login').addEventListener('click', () => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    if (username && password) socket.emit('auth:login', { username, password });
});

socket.on('auth:response', (res) => {
    if (res.success) {
        currentUser = res.user;
        localStorage.setItem('canaima_token', currentUser.token);
        authModal.classList.add('hidden');
        document.getElementById('current-user-name').innerText = currentUser.username;
        document.getElementById('current-user-avatar').innerText = currentUser.avatar;
    } else {
        document.getElementById('auth-error').innerText = res.message || 'Error de sesión';
    }
});

socket.on('data:contacts', (d) => { contactsList = d; if (currentTab === 'chats') renderList(); });
socket.on('data:groups', (d) => { groupsList = d; if (currentTab === 'groups') renderList(); });

document.getElementById('tab-chats').addEventListener('click', () => { currentTab = 'chats'; renderList(); });
document.getElementById('tab-groups').addEventListener('click', () => { currentTab = 'groups'; renderList(); });

function renderList() {
    listContainer.innerHTML = '';
    const items = currentTab === 'chats' ? contactsList : groupsList;
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="avatar-box">' + (item.avatar || '👤') + '</span><strong>' + (item.username || item.name) + '</strong>';
        div.addEventListener('click', () => selectChat(item));
        listContainer.appendChild(div);
    });
}

function selectChat(item) {
    activeTarget = { id: item.id, name: item.username || item.name, isGroup: currentTab === 'groups' };

    document.getElementById('chat-target-avatar').innerText = item.avatar || '👥';
    document.getElementById('chat-target-name').innerText = activeTarget.name;
    chatHeader.classList.remove('hidden');
    chatFooter.classList.remove('hidden');

    // Recuperar borrador si existe
    messageInput.value = localStorage.getItem('draft_' + activeTarget.id) || '';

    // Manejo Responsivo Pantalla Móvil
    document.getElementById('app-sidebar').classList.add('mobile-hidden');
    document.getElementById('app-chat-area').classList.remove('mobile-hidden');

    socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
}

document.getElementById('btn-back-chat').addEventListener('click', () => {
    document.getElementById('app-sidebar').classList.remove('mobile-hidden');
    document.getElementById('app-chat-area').classList.add('mobile-hidden');
});

// Guardado de Borradores automáticos e Indicador "Escribiendo..."
messageInput.addEventListener('input', (e) => {
    if (activeTarget) {
        localStorage.setItem('draft_' + activeTarget.id, e.target.value);
        socket.emit('typing', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, isTyping: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit('typing', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, isTyping: false });
        }, 1500);
    }
    
    // Menciones @
    if (e.target.value.endsWith('@') && activeTarget && activeTarget.isGroup) {
        showMentionsMenu();
    } else {
        document.getElementById('mentions-dropdown').classList.add('hidden');
    }
});

function showMentionsMenu() {
    const dropdown = document.getElementById('mentions-dropdown');
    dropdown.innerHTML = '';
    contactsList.forEach(c => {
        const item = document.createElement('div');
        item.className = 'mention-item';
        item.innerText = '@' + c.username;
        item.addEventListener('click', () => {
            messageInput.value = messageInput.value.slice(0, -1) + '@' + c.username + ' ';
            dropdown.classList.add('hidden');
        });
        dropdown.appendChild(item);
    });
    dropdown.classList.remove('hidden');
}

socket.on('user:typing', ({ username, isTyping }) => {
    document.getElementById('typing-indicator').innerText = isTyping ? username + ' está escribiendo...' : '';
});

// Envío de Mensajes
document.getElementById('btn-send').addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
    const content = messageInput.value.trim();
    if (content && activeTarget) {
        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content });
        messageInput.value = '';
        localStorage.removeItem('draft_' + activeTarget.id);
    }
}

// Envío de Archivos / Fotos
document.getElementById('btn-attach').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && activeTarget) {
        const reader = new FileReader();
        reader.onload = (evt) => {
            socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '📷 Imagen', mediaUrl: evt.target.result });
        };
        reader.readAsDataURL(file);
    }
});

socket.on('chat:history', ({ messages }) => {
    messagesContainer.innerHTML = '';
    messages.forEach(appendMessage);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
});

socket.on('message:received', (msg) => {
    appendMessage(msg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
});

function appendMessage(msg) {
    const isMe = msg.sender_id === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isMe ? 'sent' : 'received');
    if (isMe) bubble.style.backgroundColor = msg.bubble_color || '#3a86ff';

    let mediaHtml = msg.media_url ? '<img src="' + msg.media_url + '" class="media-preview-img" onclick="openLightbox(\'' + msg.media_url + '\')">' : '';
    let readStatus = isMe ? (msg.is_read ? ' double-check' : '✓') : '';

    bubble.innerHTML = 
        '<div class="msg-actions"><button onclick="reactMsg(' + msg.id + ', \'❤️\')">❤️</button><button onclick="reactMsg(' + msg.id + ', \'👍\')">👍</button><button onclick="translateMsg(' + msg.id + ')">🌐</button></div>' +
        (activeTarget.isGroup && !isMe ? '<div class="msg-sender">' + msg.sender_name + '</div>' : '') +
        '<div class="msg-text" id="text-' + msg.id + '">' + msg.content + '</div>' + mediaHtml +
        '<div id="reacts-' + msg.id + '" class="reactions-row"></div>' +
        '<div class="msg-meta">' + new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + ' ' + readStatus + '</div>';

    messagesContainer.appendChild(bubble);
}

// Galería Flotante (Lightbox)
window.openLightbox = (url) => {
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox-download').href = url;
    document.getElementById('lightbox-modal').classList.remove('hidden');
};
document.getElementById('btn-close-lightbox').addEventListener('click', () => document.getElementById('lightbox-modal').classList.add('hidden'));

// Reacciones
window.reactMsg = (id, emoji) => socket.emit('message:react', { messageId: id, emoji });
socket.on('message:reacted', ({ messageId, reactions }) => {
    const box = document.getElementById('reacts-' + messageId);
    if (box) {
        box.innerHTML = Object.entries(reactions).map(([e, c]) => '<span class="reaction-badge">' + e + ' ' + c + '</span>').join('');
    }
});

// Traductor Básico integrado
window.translateMsg = (id) => {
    const el = document.getElementById('text-' + id);
    el.innerText = '🌐 [Traducción]: ' + el.innerText;
};

// Encuesta rápida en grupo
document.getElementById('btn-poll').addEventListener('click', () => {
    const q = prompt("Pregunta de la encuesta:");
    if (q && activeTarget) {
        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: '📊 ENCUESTA: ' + q + '\n1. Sí 👍\n2. No 👎' });
    }
});

// Selector de colores y Ajustes
document.querySelectorAll('.color-circle').forEach(c => {
    c.addEventListener('click', (e) => {
        document.querySelectorAll('.color-circle').forEach(x => x.classList.remove('selected'));
        e.target.classList.add('selected');
    });
});

document.getElementById('btn-open-settings').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.classList.add('hidden'));

document.getElementById('btn-save-settings').addEventListener('click', () => {
    const color = document.querySelector('.color-circle.selected').dataset.color;
    const bgUrl = document.getElementById('bg-url-input').value;
    const username = document.getElementById('settings-username').value.trim() || currentUser.username;
    
    if (bgUrl) document.getElementById('app-chat-area').style.backgroundImage = 'url(' + bgUrl + ')';

    socket.emit('user:update_settings', { username, color, bgUrl, avatar: currentUser.avatar });
});

socket.on('user:settings_updated', (d) => {
    currentUser.username = d.username;
    currentUser.bubble_color = d.color;
    document.getElementById('current-user-name').innerText = d.username;
    settingsModal.classList.add('hidden');
});

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('canaima_token');
    location.reload();
});

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
