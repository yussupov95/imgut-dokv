const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

let db;
async function initDB() {
  db = new Low(new JSONFile('database.json'), {});
  await db.read();
  db.data ||= { users: [], files: [], albums: [], pendingCodes: [] };
  await db.write();
}

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'uploads');
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch(e) {}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'imgut-dokv-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Требуется авторизация' });
}

// Запрос кода на Email (без реальной отправки)
app.post('/api/register/request-code', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  if (db.data.users.find(u => u.email === email)) return res.status(409).json({ error: 'Email занят' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  db.data.pendingCodes = db.data.pendingCodes.filter(p => p.email !== email);
  db.data.pendingCodes.push({ email, phone: null, password, code, createdAt: Date.now() });
  await db.write();
  // Код показывается на сайте (заглушка)
  console.log(`[EMAIL] Код для ${email}: ${code}`);
  res.json({ success: true, message: 'Код отправлен (для теста)', debugCode: code });
});

// Запрос кода на телефон (заглушка)
app.post('/api/register/request-phone-code', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Телефон и пароль обязательны' });
  if (db.data.users.find(u => u.phone === phone)) return res.status(409).json({ error: 'Телефон уже используется' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  db.data.pendingCodes = db.data.pendingCodes.filter(p => p.phone === phone);
  db.data.pendingCodes.push({ email: null, phone, password, code, createdAt: Date.now() });
  await db.write();
  console.log(`[SMS] Код для ${phone}: ${code}`);
  res.json({ success: true, message: 'Код отправлен (для теста)', debugCode: code });
});

// Подтверждение Email
app.post('/api/register/verify-code', async (req, res) => {
  const { email, code } = req.body;
  const pending = db.data.pendingCodes.find(p => p.email === email && p.code === code);
  if (!pending) return res.status(400).json({ error: 'Неверный код' });
  if (Date.now() - pending.createdAt > 10*60*1000) return res.status(410).json({ error: 'Код истёк' });
  const hashed = bcrypt.hashSync(pending.password, 10);
  const user = { id: uuidv4(), email, phone: null, password: hashed, storage_limit: 3221225472, used_storage: 0 };
  db.data.users.push(user);
  db.data.pendingCodes = db.data.pendingCodes.filter(p => p.email !== email);
  await db.write();
  req.session.userId = user.id;
  res.json({ success: true });
});

// Подтверждение телефона
app.post('/api/register/verify-phone-code', async (req, res) => {
  const { phone, code } = req.body;
  const pending = db.data.pendingCodes.find(p => p.phone === phone && p.code === code);
  if (!pending) return res.status(400).json({ error: 'Неверный код' });
  if (Date.now() - pending.createdAt > 10*60*1000) return res.status(410).json({ error: 'Код истёк' });
  const hashed = bcrypt.hashSync(pending.password, 10);
  const user = { id: uuidv4(), email: null, phone, password: hashed, storage_limit: 3221225472, used_storage: 0 };
  db.data.users.push(user);
  db.data.pendingCodes = db.data.pendingCodes.filter(p => p.phone === phone);
  await db.write();
  req.session.userId = user.id;
  res.json({ success: true });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { contact, password } = req.body;
  if (!contact || !password) return res.status(400).json({ error: 'Контакт и пароль обязательны' });
  const user = db.data.users.find(u => u.email === contact || u.phone === contact);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Неверные данные' });
  req.session.userId = user.id;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/profile', requireAuth, async (req, res) => {
  const user = db.data.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const files = db.data.files.filter(f => f.user_id === user.id).sort((a,b) => new Date(b.upload_date) - new Date(a.upload_date));
  const albums = db.data.albums.filter(a => a.user_id === user.id).sort((a,b) => new Date(b.upload_date) - new Date(a.upload_date));
  res.json({ user: { id: user.id, email: user.email, phone: user.phone, storage_limit: user.storage_limit, used_storage: user.used_storage }, files, albums });
});

// Загрузка (альбомы)
app.post('/api/upload', requireAuth, (req, res) => {
  upload.array('files', 10)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Файлы не получены' });

    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user) {
      req.files.forEach(f => fs.unlinkSync(f.path));
      return res.status(500).json({ error: 'Пользователь не найден' });
    }

    const totalSize = req.files.reduce((s, f) => s + f.size, 0);
    if (user.used_storage + totalSize > user.storage_limit) {
      req.files.forEach(f => fs.unlinkSync(f.path));
      return res.status(413).json({ error: 'Превышен лимит (3 ГБ)' });
    }

    const fileRecords = req.files.map(f => ({
      id: uuidv4(),
      user_id: user.id,
      original_name: f.originalname,
      stored_name: f.filename,
      size: f.size,
      mimetype: f.mimetype,
      upload_date: new Date().toISOString()
    }));
    db.data.files.push(...fileRecords);

    if (req.files.length > 1) {
      const albumId = uuidv4();
      const album = {
        id: albumId,
        user_id: user.id,
        fileIds: fileRecords.map(f => f.id),
        original_names: fileRecords.map(f => f.original_name),
        size: totalSize,
        upload_date: new Date().toISOString()
      };
      db.data.albums.push(album);
      user.used_storage += totalSize;
      await db.write();
      return res.json({ success: true, isAlbum: true, url: `/album/${albumId}` });
    } else {
      const file = fileRecords[0];
      user.used_storage += file.size;
      await db.write();
      return res.json({ success: true, isAlbum: false, file: { id: file.id, original_name: file.original_name, url: `/file/${file.id}` } });
    }
  });
});

app.get('/file/:id', async (req, res) => {
  const file = db.data.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).send('Файл не найден');
  const filePath = path.join(uploadDir, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Файл удалён');
  res.setHeader('Content-Type', file.mimetype);
  res.sendFile(filePath);
});

app.get('/album/:id', async (req, res) => {
  const album = db.data.albums.find(a => a.id === req.params.id);
  if (!album) return res.status(404).send('Альбом не найден');
  const files = db.data.files.filter(f => album.fileIds.includes(f.id));
  const items = files.map(f => {
    const url = `/file/${f.id}`;
    if (f.mimetype.startsWith('video')) {
      return `<video src="${url}" controls style="width:100%;border-radius:0.5rem;"></video>`;
    } else {
      return `<img src="${url}" alt="${f.original_name}" style="width:100%;border-radius:0.5rem;cursor:pointer;" onclick="window.open('${url}')">`;
    }
  }).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Альбом</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet"><style>body { background: #0a0f1f; color: #f1f5f9; font-family: 'Inter', sans-serif; padding: 1rem; } .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem; }</style></head><body><h2>Альбом</h2><div class="grid">${items}</div></body></html>`);
});

app.delete('/api/file/:id', requireAuth, async (req, res) => {
  const file = db.data.files.find(f => f.id === req.params.id && f.user_id === req.session.userId);
  if (!file) return res.status(404).json({ error: 'Файл не найден' });
  const filePath = path.join(uploadDir, file.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.data.files = db.data.files.filter(f => f.id !== req.params.id);
  const user = db.data.users.find(u => u.id === req.session.userId);
  user.used_storage -= file.size;
  db.data.albums.forEach(album => {
    album.fileIds = album.fileIds.filter(id => id !== req.params.id);
    if (album.fileIds.length === 0) album._deleted = true;
  });
  db.data.albums = db.data.albums.filter(a => !a._deleted);
  await db.write();
  res.json({ success: true });
});

app.delete('/api/album/:id', requireAuth, async (req, res) => {
  const album = db.data.albums.find(a => a.id === req.params.id && a.user_id === req.session.userId);
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });
  for (const fileId of album.fileIds) {
    const file = db.data.files.find(f => f.id === fileId);
    if (file) {
      const filePath = path.join(uploadDir, file.stored_name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      db.data.files = db.data.files.filter(f => f.id !== fileId);
      const user = db.data.users.find(u => u.id === req.session.userId);
      user.used_storage -= file.size;
    }
  }
  db.data.albums = db.data.albums.filter(a => a.id !== req.params.id);
  await db.write();
  res.json({ success: true });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Глобальная ошибка:', err);
  if (req.path.startsWith('/api') || req.path.startsWith('/file') || req.path.startsWith('/album')) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  } else {
    next(err);
  }
});

async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`IMGUT.DOKV на порту ${PORT}`));
}
start();
