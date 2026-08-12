/* ============================================================
   IMVELAPHI LMS — API client
   Only tokens live in the browser (localStorage). All real data
   — users, courses, videos, quiz results, progress — lives in
   MySQL on the server. Access tokens are short-lived; when one
   expires, we silently exchange the refresh token for a new one
   and retry the request once before giving up.
   ============================================================ */

const API_BASE = '/api';
const ACCESS_KEY = 'imv_access_token';
const REFRESH_KEY = 'imv_refresh_token';
const USER_KEY = 'imv_user';

function getAccessToken() { return localStorage.getItem(ACCESS_KEY); }
function getRefreshToken() { return localStorage.getItem(REFRESH_KEY); }
function getCachedUser() { const raw = localStorage.getItem(USER_KEY); return raw ? JSON.parse(raw) : null; }

function storeSession({ accessToken, refreshToken, user }) {
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

async function tryRefresh() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const res = await fetch(API_BASE + '/auth/refresh', {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ refreshToken })
  });
  const data = await res.json().catch(() => null);
  if (data?.success) { localStorage.setItem(ACCESS_KEY, data.accessToken); return true; }
  return false;
}

async function api(path, { method = 'GET', body, isForm = false, _retried = false } = {}) {
  const headers = {};
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(API_BASE + path, {
    method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });

  if (res.status === 401 && !_retried) {
    const refreshed = await tryRefresh();
    if (refreshed) return api(path, { method, body, isForm, _retried: true });
    STORE.logout(false);
  }

  return res.json().catch(() => ({ success:false, message:'Unexpected server response.' }));
}

const STORE = {
  async register(payload) {
    const data = await api('/auth/register', { method:'POST', body: payload });
    if (data.success) storeSession(data);
    return data;
  },
  async login(email, password) {
    const data = await api('/auth/login', { method:'POST', body: { email, password } });
    if (data.success) storeSession(data);
    return data;
  },
  logout(redirect = true) {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    if (redirect) window.location.href = 'index.html';
  },
  currentUser() { return getAccessToken() ? getCachedUser() : null; },

  requireRole(roles) {
    const user = STORE.currentUser();
    if (!user || !roles.includes(user.role)) { window.location.href = 'index.html'; return null; }
    return user;
  },

  getCourses: () => api('/courses'),
  getDashboard: () => api('/courses/me/dashboard'),
  getCourse: (id) => api(`/courses/${id}`),
  submitQuiz: (courseId, videoId, answers) => api(`/courses/${courseId}/videos/${videoId}/quiz`, { method:'POST', body:{ answers } }),
  markWatched: (courseId, videoId) => api(`/courses/${courseId}/videos/${videoId}/watched`, { method:'POST' }),

  lecturerCourses: () => api('/lecturer/courses'),
  lecturerPerformance: () => api('/lecturer/performance'),
  uploadVideo: (courseId, formData) => api(`/lecturer/courses/${courseId}/videos`, { method:'POST', body: formData, isForm:true }),

  adminUsers: () => api('/admin/users'),
  adminCourses: () => api('/admin/courses'),
  adminStats: () => api('/admin/stats'),
  adminLecturers: () => api('/admin/lecturers'),
  adminCreateLecturer: (payload) => api('/admin/lecturers', { method:'POST', body: payload }),
  adminSetCourseLecturer: (courseId, lecturerId) => api(`/admin/courses/${courseId}/lecturer`, { method:'PATCH', body:{ lecturerId } }),

  chatSend: (messages) => api('/chat', { method:'POST', body:{ messages } }),
};

/* ============================================================
   AI chat widget — a floating bubble + panel any page can add
   with a single mountChatWidget() call. Works for logged-in users
   (role-aware answers) and anonymous visitors on the landing page.
   ============================================================ */
function mountChatWidget() {
  if (document.getElementById('imvChatRoot')) return; // already mounted on this page
  const user = STORE.currentUser();
  const history = []; // { role: 'user'|'assistant', content }

  const root = document.createElement('div');
  root.id = 'imvChatRoot';
  root.innerHTML = `
    <button id="imvChatBubble" class="chat-bubble" aria-label="Open assistant">
      <i class="fa-solid fa-comment-dots"></i>
    </button>
    <div id="imvChatPanel" class="chat-panel">
      <div class="chat-head">
        <div>
          <strong>Imvelaphi Assistant</strong>
          <span class="chat-sub">${user ? `Signed in as ${user.role}` : 'Ask me anything about the LMS'}</span>
        </div>
        <button id="imvChatClose" class="chat-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="imvChatMessages" class="chat-messages">
        <div class="chat-msg chat-msg-bot">Hi${user ? ' ' + user.firstName : ''}! I can help with courses, videos, quizzes${user?.role === 'lecturer' ? ' and uploading content' : user?.role === 'admin' ? ' and managing lecturers' : ''}. What do you need?</div>
      </div>
      <form id="imvChatForm" class="chat-form">
        <input id="imvChatInput" type="text" placeholder="Type a message…" autocomplete="off">
        <button type="submit" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button>
      </form>
    </div>`;
  document.body.appendChild(root);

  const panel = document.getElementById('imvChatPanel');
  const messagesEl = document.getElementById('imvChatMessages');
  const form = document.getElementById('imvChatForm');
  const input = document.getElementById('imvChatInput');

  document.getElementById('imvChatBubble').addEventListener('click', () => {
    panel.classList.add('open');
    input.focus();
  });
  document.getElementById('imvChatClose').addEventListener('click', () => panel.classList.remove('open'));

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'chat-msg-user' : 'chat-msg-bot');
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage('user', text);
    history.push({ role:'user', content: text });

    const typing = document.createElement('div');
    typing.className = 'chat-msg chat-msg-bot chat-typing';
    typing.textContent = '…';
    messagesEl.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const res = await STORE.chatSend(history.slice(-10));
    typing.remove();
    const reply = res.success ? res.reply : "Sorry, I couldn't reach the assistant just now.";
    addMessage('assistant', reply);
    history.push({ role:'assistant', content: reply });
  });
}

function renderAppHeader(mountId, activeLabel) {
  const user = STORE.currentUser();
  const mount = document.getElementById(mountId);
  if (!mount || !user) return;
  mount.innerHTML = `
    <a href="index.html" class="logo">
      <div class="mark"><img src="images/logo.png" alt="Imvelaphi Technologies logo"></div>
      <h1>Imvelaphi <span>LMS</span></h1>
    </a>
    <div class="nav-links">
      <span class="chip hide-mobile">${activeLabel}</span>
      <div class="user-chip">
        <span class="dot"></span>
        <span>Signed in as <strong>${user.firstName} ${user.lastName}</strong> · ${user.role}</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="STORE.logout()">Log out</button>
    </div>`;
}
