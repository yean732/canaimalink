const socket = io();

// Registro de PWA (App Instalable)
let deferredPrompt;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW error:', err));
}
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btnPwa = document.getElementById('btn-install-pwa');
    if (btnPwa) btnPwa.classList.remove('hidden');
});

const btnInstall = document.getElementById('btn-install-pwa');
if (btnInstall) {
    btnInstall.addEventListener('click', () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            deferredPrompt = null;
        }
    });
}

let currentUser = null;
let activeTarget = null;
let contactsList = [];
let groupsList = [];
let currentTab = 'chats';
let typingTimeout = null;

// Cargar tema guardado
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

// Login
document.getElementById('btn-login').addEventListener('click', () => {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    if (username && password) socket.emit('auth:login', { username, password });
});

socket.on('auth:response', (res) => {
    if (res.success) {
        currentUser = res.user;
        if (currentUser.token) localStorage.setItem('canaima_token', currentUser.token);
        authModal.classList.add('hidden');
        document.getElementById('current-user-name').innerText = currentUser.username;
        document.getElementById('current-user-avatar').innerText = currentUser.avatar || '🤖';
    } else {
        document.getElementById('auth-error').innerText = res.message || 'Error al iniciar sesión';
    }
});

// Cargar listas
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

    messageInput.value = localStorage.getItem('draft_' + activeTarget.id) || '';

    document.getElementById('app-sidebar').classList.add('mobile-hidden');
    document.getElementById('app-chat-area').classList.remove('mobile-hidden');

    socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
}

document.getElementById('btn-back-chat').addEventListener('click', () => {
    document.getElementById('app-sidebar').classList.remove('mobile-hidden');
    document.getElementById('app-chat-area').classList.add('mobile-hidden');
});

// Indicador Escribiendo
messageInput.addEventListener('input', (e) => {
    if (activeTarget) {
        localStorage.setItem('draft_' + activeTarget.id, e.target.value);
        socket.emit('typing', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, isTyping: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit('typing', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, isTyping: false });
        }, 1500);
    }
});

socket.on('user:typing', ({ username, isTyping }) => {
    document.getElementById('typing-indicator').innerText = isTyping ? username + ' está escribiendo...' : '';
});

// Enviar Mensaje
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

// Menú Emojis
const btnEmoji = document.getElementById('btn-emoji');
const emojiDropdown = document.getElementById('emoji-dropdown');

if (btnEmoji && emojiDropdown) {
    btnEmoji.addEventListener('click', (e) => {
        e.stopPropagation();
        emojiDropdown.classList.toggle('hidden');
    });

    document.querySelectorAll('#emoji-dropdown span').forEach(el => {
        el.addEventListener('click', (evt) => {
            messageInput.value += evt.target.innerText;
            emojiDropdown.classList.add('hidden');
            messageInput.focus();
        });
    });
}

// Adjuntar Imagen
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

// Recibir Mensajes e Historial
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
    if (!currentUser) return;
    const isMe = msg.sender_id === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isMe ? 'sent' : 'received');
    if (isMe) bubble.style.backgroundColor = msg.bubble_color || '#3a86ff';

    let mediaHtml = msg.media_url ? '<img src="' + msg.media_url + '" class="media-preview-img" onclick="openLightbox(\'' + msg.media_url + '\')">' : '';

    bubble.innerHTML = 
        (activeTarget && activeTarget.isGroup && !isMe ? '<div class="msg-sender">' + (msg.sender_name || 'Usuario') + '</div>' : '') +
        '<div class="msg-text">' + msg.content + '</div>' + mediaHtml +
        '<div class="msg-meta">' + new Date(msg.timestamp || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + '</div>';

    messagesContainer.appendChild(bubble);
}

// Galería Flotante (Lightbox)
window.openLightbox = (url) => {
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox-download').href = url;
    document.getElementById('lightbox-modal').classList.remove('hidden');
};
document.getElementById('btn-close-lightbox').addEventListener('click', () => document.getElementById('lightbox-modal').classList.add('hidden'));

// Modal Ajustes
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

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('canaima_token');
    location.reload();
});

// Contactos y Grupos
document.getElementById('btn-add-contact').addEventListener('click', () => {
    const name = prompt("Apodo exacto del amigo:");
    if (name) socket.emit('contact:add', { searchName: name });
});
socket.on('contact:added', (c) => { contactsList.push(c); renderList(); });

document.getElementById('btn-create-group').addEventListener('click', () => {
    const name = prompt("Nombre del grupo:");
    if (name) socket.emit('group:create', { groupName: name });
});
socket.on('group:created', (g) => { groupsList.push(g); renderList(); });

socket.on('notification', (data) => alert(data.message));
