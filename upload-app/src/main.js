const API_BASE = ''; // Same origin when deployed, or set to worker URL for dev
const AUTH_KEY = 'claim_manager_auth';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const status = document.getElementById('status');
const receiptList = document.getElementById('receiptList');
const countSpan = document.getElementById('count');
const refreshBtn = document.getElementById('refreshBtn');
const todoList = document.getElementById('todoList');
const todoCount = document.getElementById('todoCount');
const authOverlay = document.getElementById('authOverlay');
const passwordInput = document.getElementById('passwordInput');
const authSubmit = document.getElementById('authSubmit');

// Auth token management
function getAuthToken() {
  return localStorage.getItem(AUTH_KEY);
}

function setAuthToken(token) {
  localStorage.setItem(AUTH_KEY, token);
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_KEY);
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { 'X-Auth-Token': token } : {};
}

// Auth UI
function showPasswordPrompt() {
  authOverlay.style.display = 'flex';
  passwordInput.focus();
}

function hidePasswordPrompt() {
  authOverlay.style.display = 'none';
}

async function checkAuth() {
  const token = getAuthToken();
  if (!token) {
    showPasswordPrompt();
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/list`, {
      headers: authHeaders(),
    });
    if (response.status === 401) {
      clearAuthToken();
      showPasswordPrompt();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function handlePasswordSubmit() {
  const password = passwordInput.value.trim();
  if (!password) return;

  setAuthToken(password);

  try {
    const response = await fetch(`${API_BASE}/list`, {
      headers: authHeaders(),
    });
    if (response.status === 401) {
      clearAuthToken();
      showStatus('error', 'Invalid password');
      passwordInput.value = '';
      return;
    }
    hidePasswordPrompt();
    loadReceipts();
    loadYnabTodos();
  } catch {
    showStatus('error', 'Connection failed');
  }
}

// Upload files
async function uploadFiles(files) {
  if (files.length === 0) return;

  showStatus('uploading', `Uploading ${files.length} file(s)...`);

  let successCount = 0;
  let errorCount = 0;

  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      });

      if (response.ok) {
        successCount++;
      } else {
        errorCount++;
      }
    } catch (err) {
      console.error('Upload error:', err);
      errorCount++;
    }
  }

  if (errorCount === 0) {
    showStatus('success', `Uploaded ${successCount} receipt(s)`);
  } else {
    showStatus('error', `${successCount} uploaded, ${errorCount} failed`);
  }

  // Refresh list after upload
  loadReceipts();
}

// Load receipt list
async function loadReceipts() {
  try {
    const response = await fetch(`${API_BASE}/list`, {
      headers: authHeaders(),
    });

    if (response.status === 401) {
      showPasswordPrompt();
      return;
    }

    const data = await response.json();

    countSpan.textContent = `(${data.receipts.length})`;

    if (data.receipts.length === 0) {
      receiptList.innerHTML = '<li class="empty-state">No pending receipts</li>';
      return;
    }

    receiptList.innerHTML = data.receipts
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
      .map(r => {
        const date = new Date(r.uploaded).toLocaleDateString();
        const name = r.key.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, '');
        return `
          <li>
            <span class="receipt-name">${escapeHtml(name)}</span>
            <span class="receipt-date">${date}</span>
          </li>
        `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load receipts:', err);
    receiptList.innerHTML = '<li class="empty-state">Failed to load receipts</li>';
  }
}

// Show status message
function showStatus(type, message) {
  status.className = `status ${type}`;
  status.textContent = message;

  if (type === 'success') {
    setTimeout(() => {
      status.className = 'status';
    }, 3000);
  }
}

// Escape HTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Event listeners
fileInput.addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = ''; // Reset for re-upload
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  uploadFiles(e.dataTransfer.files);
});

// Load YNAB TODOs
async function loadYnabTodos() {
  try {
    const response = await fetch(`${API_BASE}/ynab/todos`, {
      headers: authHeaders(),
    });

    if (response.status === 401) {
      showPasswordPrompt();
      return;
    }

    const data = await response.json();

    if (data.error) {
      todoList.innerHTML = `<li class="empty-state">Error: ${escapeHtml(data.error)}</li>`;
      todoCount.textContent = '(error)';
      return;
    }

    todoCount.textContent = `(${data.todos.length})`;

    if (data.todos.length === 0) {
      todoList.innerHTML = '<li class="empty-state">No pending claims</li>';
      return;
    }

    todoList.innerHTML = data.todos
      .map(
        (t) => `
        <li class="todo-item">
          <div class="todo-main">
            <span class="todo-payee">${escapeHtml(t.payee)}</span>
            <span class="todo-amount">$${t.amount.toFixed(2)}</span>
          </div>
          <div class="todo-details">
            <span class="todo-desc">${escapeHtml(t.description)}</span>
            <span class="todo-date">${new Date(t.date).toLocaleDateString()}</span>
          </div>
        </li>
      `
      )
      .join('');
  } catch (err) {
    console.error('Failed to load YNAB todos:', err);
    todoList.innerHTML = '<li class="empty-state">Failed to load claims</li>';
  }
}

refreshBtn.addEventListener('click', () => {
  loadReceipts();
  loadYnabTodos();
});

authSubmit.addEventListener('click', handlePasswordSubmit);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handlePasswordSubmit();
});

// Initial load with auth check
async function init() {
  if (await checkAuth()) {
    loadReceipts();
    loadYnabTodos();
  }
}

init();
