const API = '';
let currentUser = null;

const mainContent = document.getElementById('mainContent');
const navLinks = document.getElementById('navLinks');
const toast = document.getElementById('toast');
const homeBtn = document.getElementById('homeBtn');

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.style.background = isError ? 'var(--danger)' : 'var(--bg-card)';
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body instanceof FormData ? options.body : JSON.stringify(options.body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('✅ Ссылка скопирована!'))
    .catch(() => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showToast('✅ Ссылка скопирована!');
    });
}

// Авторизация (только логин и пароль)
function renderAuth() {
  mainContent.innerHTML = `
    <div class="auth-container">
      <h2>Вход / Регистрация</h2>
      <div class="form-group">
        <label>Логин</label>
        <input type="text" id="authUsername" placeholder="Минимум 3 символа">
      </div>
      <div class="form-group">
        <label>Пароль</label>
        <input type="password" id="authPassword" placeholder="Минимум 4 символа">
      </div>
      <div style="display:flex; gap:1rem; margin-top:1.5rem;">
        <button class="btn btn-primary" id="loginBtn">Войти</button>
        <button class="btn btn-outline" id="registerBtn">Регистрация</button>
      </div>
    </div>
  `;

  document.getElementById('loginBtn').onclick = async () => {
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!username || !password) return showToast('Заполни поля', true);
    try {
      await api('/api/login', { method: 'POST', body: { username, password } });
      checkAuth();
    } catch (e) { showToast(e.message, true); }
  };

  document.getElementById('registerBtn').onclick = async () => {
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!username || !password) return showToast('Заполни поля', true);
    try {
      await api('/api/register', { method: 'POST', body: { username, password } });
      checkAuth();
    } catch (e) { showToast(e.message, true); }
  };
}

// Навигация
function updateNav() {
  if (currentUser) {
    navLinks.innerHTML = `
      <button class="btn btn-outline" id="uploadNav">Загрузить</button>
      <button class="btn btn-outline" id="profileNav">Мой профиль</button>
      <button class="btn btn-danger" id="logoutNav">Выйти</button>
    `;
    document.getElementById('uploadNav').onclick = renderUpload;
    document.getElementById('profileNav').onclick = renderProfile;
    document.getElementById('logoutNav').onclick = async () => {
      await api('/api/logout', { method: 'POST' });
      currentUser = null;
      updateNav();
      renderAuth();
    };
  } else {
    navLinks.innerHTML = `<button class="btn btn-primary" id="loginNav">Войти</button>`;
    document.getElementById('loginNav').onclick = renderAuth;
  }
}

async function checkAuth() {
  try {
    const data = await api('/api/profile');
    currentUser = data.user;
    updateNav();
    renderUpload();
  } catch {
    currentUser = null;
    updateNav();
    renderAuth();
  }
}

// Загрузка
function renderUpload() {
  mainContent.innerHTML = `
    <div class="upload-zone" id="dropZone">
      <div class="icon">⬆️</div>
      <p>Перетащи файлы сюда или нажми для выбора</p>
      <p style="font-size:0.8rem; color:var(--text-secondary);">Фото и видео до 500 МБ. Несколько файлов = альбом с одной ссылкой.</p>
      <input type="file" id="fileInput" multiple accept="image/*,video/*" hidden>
      <div class="progress-bar hidden" id="progressBar"><div id="progressFill"></div></div>
      <p id="uploadStatus" style="margin-top:0.5rem; font-size:0.9rem;"></p>
    </div>
  `;
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const uploadStatus = document.getElementById('uploadStatus');

  dropZone.onclick = () => fileInput.click();
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = () => dropZone.classList.remove('dragover');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  };
  fileInput.onchange = () => handleFiles(fileInput.files);

  async function handleFiles(files) {
    if (!files.length) return;
    progressBar.classList.remove('hidden');
    uploadStatus.textContent = `Загружается ${files.length} файл(ов)...`;
    const formData = new FormData();
    for (const file of files) formData.append('files', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progressFill.style.width = (e.loaded / e.total) * 100 + '%';
    };
    xhr.onload = () => {
      progressBar.classList.add('hidden');
      progressFill.style.width = '0%';
      if (xhr.status === 200) {
        const resp = JSON.parse(xhr.responseText);
        const link = window.location.origin + resp.url;
        showCopyToast(link, resp.isAlbum ? 'Альбом' : resp.file.original_name);
        uploadStatus.textContent = '';
      } else {
        const err = JSON.parse(xhr.responseText);
        showToast(err.error || 'Ошибка загрузки', true);
        uploadStatus.textContent = 'Ошибка';
      }
    };
    xhr.onerror = () => { progressBar.classList.add('hidden'); showToast('Сетевая ошибка', true); };
    xhr.send(formData);
  }
}

function showCopyToast(link, name) {
  toast.classList.add('hidden');
  toast.innerHTML = `
    <span>✅ ${name} загружен!</span>
    <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
      <input value="${link}" readonly style="flex:1; padding:0.3rem; border-radius:4px; border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:0.8rem; min-width:150px;" onclick="this.select()">
      <button class="btn btn-primary btn-sm" onclick="copyToClipboard('${link}')">📋 Копировать</button>
    </div>
  `;
  toast.style.background = 'var(--bg-card)';
  toast.classList.remove('hidden');
  setTimeout(() => { toast.classList.add('hidden'); toast.textContent = ''; }, 8000);
}

// Профиль
async function renderProfile() {
  try {
    const data = await api('/api/profile');
    const user = data.user;
    const files = data.files || [];
    const albums = data.albums || [];
    const usedGB = (user.used_storage / 1073741824).toFixed(2);
    const totalGB = (user.storage_limit / 1073741824).toFixed(2);
    const percent = (user.used_storage / user.storage_limit) * 100;

    let albumsHtml = '';
    albums.forEach(album => {
      const sizeMB = (album.size / 1048576).toFixed(2);
      const link = `${window.location.origin}/album/${album.id}`;
      albumsHtml += `
        <tr>
          <td>📁 ${album.original_names?.slice(0,2).join(', ')}${album.fileIds.length > 2 ? '…' : ''}</td>
          <td>${sizeMB} МБ</td>
          <td><a href="${link}" target="_blank" class="file-link">Открыть</a>
              <button class="btn btn-outline btn-sm" style="margin-left:0.5rem;" onclick="copyToClipboard('${link}')">📋</button></td>
          <td><button class="btn btn-danger btn-sm" data-id="${album.id}" data-type="album">Удалить</button></td>
        </tr>`;
    });

    let filesHtml = '';
    files.forEach(f => {
      const sizeMB = (f.size / 1048576).toFixed(2);
      const typeIcon = f.mimetype.startsWith('video') ? '🎬' : '🖼️';
      const link = `${window.location.origin}/file/${f.id}`;
      filesHtml += `
        <tr>
          <td>${typeIcon} ${f.original_name}</td>
          <td>${sizeMB} МБ</td>
          <td><a href="${link}" target="_blank" class="file-link">Открыть</a>
              <button class="btn btn-outline btn-sm" style="margin-left:0.5rem;" onclick="copyToClipboard('${link}')">📋</button></td>
          <td><button class="btn btn-danger btn-sm" data-id="${f.id}" data-type="file">Удалить</button></td>
        </tr>`;
    });

    mainContent.innerHTML = `
      <div class="profile-container">
        <h2>Профиль: ${user.username}</h2>
        <div class="storage-info">
          <div style="display:flex; justify-content:space-between;">
            <span>Использовано</span>
            <span>${usedGB} ГБ из ${totalGB} ГБ</span>
          </div>
          <div class="storage-bar"><div class="storage-bar-fill" style="width:${percent}%"></div></div>
        </div>
        ${albums.length ? `<h3>Альбомы (${albums.length})</h3>
          <table class="file-table"><thead><tr><th>Содержимое</th><th>Размер</th><th>Ссылка</th><th></th></tr></thead><tbody>${albumsHtml}</tbody></table>` : ''}
        <h3>Файлы (${files.length})</h3>
        ${files.length ? `<table class="file-table"><thead><tr><th>Файл</th><th>Размер</th><th>Ссылка</th><th></th></tr></thead><tbody>${filesHtml}</tbody></table>` : '<p>Нет загруженных файлов</p>'}
      </div>`;

    document.querySelectorAll('.btn-danger').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const type = btn.dataset.type;
        if (type === 'album') {
          await api(`/api/album/${id}`, { method: 'DELETE' });
        } else {
          await api(`/api/file/${id}`, { method: 'DELETE' });
        }
        renderProfile();
      };
    });
  } catch { /* ошибка уже показана */ }
}

homeBtn.onclick = () => currentUser ? renderUpload() : renderAuth();
checkAuth();
