const socket = io();

let currentUser = null;
let activeTarget = null;
let contactsList = [];
let groupsList = [];
let currentTab = 'chats';

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
        authModal.classList.add('hidden');
        document.getElementById('current-user-name').innerText = currentUser.username;
        document.getElementById('current-user-avatar').innerText = currentUser.avatar;
    } else {
        document.getElementById('auth-error').innerText = res.message;
    }
});

socket.on('data:contacts', (data) => { contactsList = data; if (currentTab === 'chats') renderList(); });
socket.on('data:groups', (data) => { groupsList = data; if (currentTab === 'groups') renderList(); });

document.getElementById('tab-chats').addEventListener('click', (e) => {
    currentTab = 'chats';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    renderList();
});

document.getElementById('tab-groups').addEventListener('click', (e) => {
    currentTab = 'groups';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    renderList();
});

function renderList(filter) {
    const searchTerm = filter || '';
    listContainer.innerHTML = '';
    const items = currentTab === 'chats' ? contactsList : groupsList;
    const filtered = items.filter(i => (i.username || i.name).toLowerCase().includes(searchTerm.toLowerCase()));

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="avatar-box">' + (item.avatar || '👤') + '</span><strong>' + (item.username || item.name) + '</strong>';
        div.addEventListener('click', () => selectChat(item));
        listContainer.appendChild(div);
    });
}

document.getElementById('search-input').addEventListener('input', (e) => renderList(e.target.value));

function selectChat(item) {
    const isGroup = currentTab === 'groups';
    activeTarget = { id: item.id, name: item.username || item.name, isGroup: isGroup, adminId: item.admin_id || null };

    document.getElementById('chat-target-avatar').innerText = item.avatar || '👥';
    document.getElementById('chat-target-name').innerText = activeTarget.name;
    document.getElementById('chat-target-subtitle').innerText = isGroup ? 'Grupo' : 'Chat Privado';

    chatHeader.classList.remove('hidden');
    chatFooter.classList.remove('hidden');

    const btnAdd = document.getElementById('btn-add-group-member');
    const btnLeave = document.getElementById('btn-leave-group');

    if (isGroup) {
        btnLeave.classList.remove('hidden');
        if (activeTarget.adminId === currentUser.id) btnAdd.classList.remove('hidden');
        else btnAdd.classList.add('hidden');
    } else {
        btnAdd.classList.add('hidden');
        btnLeave.classList.add('hidden');
    }

    socket.emit('chat:load_messages', { targetId: activeTarget.id, isGroup: isGroup });
}

document.getElementById('btn-send').addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
    const content = messageInput.value.trim();
    if (content && activeTarget) {
        socket.emit('message:send', { targetId: activeTarget.id, isGroup: activeTarget.isGroup, content: content });
        messageInput.value = '';
    }
}

socket.on('chat:history', ({ targetId, isGroup, messages }) => {
    if (!activeTarget || activeTarget.id !== targetId || activeTarget.isGroup !== isGroup) return;
    messagesContainer.innerHTML = '';
    messages.forEach(appendMessage);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
});

socket.on('message:received', (msg) => {
    if (!activeTarget) return;
    const isGroup = activeTarget.isGroup && msg.group_id === activeTarget.id;
    const isPrivate = !activeTarget.isGroup && (msg.sender_id === activeTarget.id || (msg.sender_id === currentUser.id && msg.receiver_id === activeTarget.id));

    if (isGroup || isPrivate) {
        appendMessage(msg);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
});

function appendMessage(msg) {
    const isMe = msg.sender_id === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isMe ? 'sent' : 'received') + ' font-' + (msg.font || 'sans');
    bubble.id = 'msg-' + msg.id;

    let actions = (isMe && !msg.is_deleted) ? '<div class="msg-actions"><button onclick="editMsg(' + msg.id + ')">✏️</button><button onclick="deleteMsg(' + msg.id + ')">🗑️</button></div>' : '';

    bubble.innerHTML = actions +
        (activeTarget.isGroup && !isMe ? '<div class="msg-sender">' + msg.sender_name + '</div>' : '') +
        '<div class="msg-text">' + msg.content + '</div>' +
        '<div class="msg-meta">' + (msg.is_edited ? '(editado) ' : '') + new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + '</div>';
    
    messagesContainer.appendChild(bubble);
}

window.editMsg = (id) => {
    const newContent = prompt("Nuevo mensaje:");
    if (newContent) socket.emit('message:edit', { messageId: id, newContent: newContent });
};

window.deleteMsg = (id) => {
    if (confirm("¿Eliminar este mensaje?")) socket.emit('message:delete', { messageId: id });
};

socket.on('message:updated', ({ messageId, newContent }) => {
    const el = document.getElementById('msg-' + messageId);
    if (el) el.querySelector('.msg-text').innerText = newContent;
});

socket.on('message:deleted', ({ messageId }) => {
    const el = document.getElementById('msg-' + messageId);
    if (el) {
        el.querySelector('.msg-text').innerText = '🚫 Este mensaje fue eliminado';
        const actions = el.querySelector('.msg-actions');
        if (actions) actions.remove();
    }
});

document.getElementById('btn-add-contact').addEventListener('click', () => {
    const name = prompt("Nombre de usuario exacto:");
    if (name) socket.emit('contact:add', { searchName: name });
});

socket.on('contact:added', (c) => { contactsList.push(c); if (currentTab === 'chats') renderList(); });

document.getElementById('btn-create-group').addEventListener('click', () => {
    const groupName = prompt("Nombre del grupo:");
    if (groupName) socket.emit('group:create', { groupName: groupName });
});

socket.on('group:created', (g) => { groupsList.push(g); if (currentTab === 'groups') renderList(); });

document.getElementById('btn-add-group-member').addEventListener('click', () => {
    const username = prompt("Apodo a añadir:");
    if (username && activeTarget) socket.emit('group:add_member', { groupId: activeTarget.id, username: username });
});

document.getElementById('btn-leave-group').addEventListener('click', () => {
    if (activeTarget && confirm("¿Salir del grupo?")) socket.emit('group:leave', { groupId: activeTarget.id });
});

socket.on('group:left', ({ groupId }) => {
    groupsList = groupsList.filter(g => g.id !== groupId);
    if (currentTab === 'groups') renderList();
    chatHeader.classList.add('hidden');
    chatFooter.classList.add('hidden');
    messagesContainer.innerHTML = '';
});

document.getElementById('btn-clear-chat').addEventListener('click', () => {
    if (activeTarget && confirm("¿Vaciar chat?")) socket.emit('chat:clear_local', { targetId: activeTarget.id, isGroup: activeTarget.isGroup });
});

socket.on('chat:cleared', () => messagesContainer.innerHTML = '');

// Ajustes
document.getElementById('btn-open-settings').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.getElementById('btn-close-settings').addEventListener('click', () => settingsModal.classList.add('hidden'));

document.getElementById('btn-theme-light').addEventListener('click', () => document.body.className = 'theme-light');
document.getElementById('btn-theme-dark').addEventListener('click', () => document.body.className = 'theme-dark');

document.querySelectorAll('.avatar-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
        document.querySelectorAll('.avatar-option').forEach(o => o.classList.remove('selected'));
        e.target.classList.add('selected');
    });
});

document.getElementById('btn-save-settings').addEventListener('click', () => {
    const selected = document.querySelector('.avatar-option.selected');
    const avatar = selected ? selected.innerText : currentUser.avatar;
    const font = document.getElementById('font-selector').value;
    const password = document.getElementById('settings-password').value;

    socket.emit('user:update_settings', { avatar: avatar, font: font, password: password });
});

socket.on('user:settings_updated', ({ avatar, font }) => {
    currentUser.avatar = avatar;
    currentUser.font_family = font;
    document.getElementById('current-user-avatar').innerText = avatar;
    settingsModal.classList.add('hidden');
});

// Emojis
document.getElementById('btn-emoji').addEventListener('click', () => {
    document.getElementById('emoji-dropdown').classList.toggle('hidden');
});

document.querySelectorAll('#emoji-dropdown span').forEach(e => {
    e.addEventListener('click', (evt) => {
        messageInput.value += evt.target.innerText;
        document.getElementById('emoji-dropdown').classList.add('hidden');
    });
});

socket.on('notification', (data) => alert(data.message));
