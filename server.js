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
  db.data ||= { users: [], files: [], albums: [] };
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

// Регистрация по логину и паролю
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  const existing = db.data.users.find(u => u.username === username);
  if (existing) return res.status(409).json({ error: 'Логин уже занят' });

  const hashed = bcrypt.hashSync(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    password: hashed,
    storage_limit: 3221225472, // 3 ГБ
    used_storage: 0
  };
  db.data.users.push(newUser);
  await db.write();
  req.session.userId = newUser.id;
  res.json({ success: true });
});

// Вход по логину и паролю
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  const user = db.data.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
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
  res.json({
    user: {
      id: user.id,
      username: user.username,
      storage_limit: user.storage_limit,
      used_storage: user.used_storage
    },
    files,
    albums
  });
});

// Загрузка файлов (альбомы)
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
      db.data.albums.push({
        id: albumId,
        user_id: user.id,
        fileIds: fileRecords.map(f => f.id),
        original_names: fileRecords.map(f => f.original_name),
        size: totalSize,
        upload_date: new Date().toISOString()
      });
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
    return f.mimetype.startsWith('video')
      ? `<video src="${url}" controls style="width:100%;border-radius:0.5rem;"></video>`
      : `<img src="${url}" alt="${f.original_name}" style="width:100%;border-radius:0.5rem;cursor:pointer;" onclick="window.open('${url}')">`;
  }).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Альбом</title><style>body{background:#0a0f1f;color:#f1f5f9;font-family:Inter,sans-serif;padding:1rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1rem}</style></head><body><h2>Альбом</h2><div class="grid">${items}</div></body></html>`);
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
