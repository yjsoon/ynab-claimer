const API_BASE = ''; // Same origin when deployed, or set to worker URL for dev

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const status = document.getElementById('status');
const receiptList = document.getElementById('receiptList');
const countSpan = document.getElementById('count');
const refreshBtn = document.getElementById('refreshBtn');

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
    const response = await fetch(`${API_BASE}/list`);
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

refreshBtn.addEventListener('click', loadReceipts);

// Initial load
loadReceipts();
