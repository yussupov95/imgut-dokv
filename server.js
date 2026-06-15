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
  db.data ||= { users: [], files: [] };
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

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (username.length < 3 || password.length < 4) return res.status(400).json({ error: 'Логин мин. 3 символа, пароль мин. 4' });
  const existing = db.data.users.find(u => u.username === username);
  if (existing) return res.status(409).json({ error: 'Логин уже занят' });
  const hashed = bcrypt.hashSync(password, 10);
  const newUser = { id: uuidv4(), username, password: hashed, storage_limit: 3221225472, used_storage: 0 };
  db.data.users.push(newUser);
  await db.write();
  req.session.userId = newUser.id;
  res.json({ success: true, userId: newUser.id });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  const user = db.data.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Неверный логин или пароль' });
  req.session.userId = user.id;
  res.json({ success: true, userId: user.id });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/profile', requireAuth, async (req, res) => {
  const user = db.data.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const files = db.data.files.filter(f => f.user_id === user.id).sort((a, b) => new Date(b.upload_date) - new Date(a.upload_date));
  res.json({ user: { id: user.id, username: user.username, storage_limit: user.storage_limit, used_storage: user.used_storage }, files });
});

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не предоставлен' });
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user) { fs.unlinkSync(req.file.path); return res.status(500).json({ error: 'Пользователь не найден' }); }
    const newSize = user.used_storage + req.file.size;
    if (newSize > user.storage_limit) { fs.unlinkSync(req.file.path); return res.status(413).json({ error: 'Превышен лимит хранилища (3 ГБ)' }); }
    const fileId = uuidv4();
    const fileData = { id: fileId, user_id: user.id, original_name: req.file.originalname, stored_name: req.file.filename, size: req.file.size, mimetype: req.file.mimetype, upload_date: new Date().toISOString() };
    db.data.files.push(fileData);
    user.used_storage = newSize;
    await db.write();
    res.json({ success: true, file: { id: fileId, original_name: fileData.original_name, size: fileData.size, mimetype: fileData.mimetype, url: `/file/${fileId}` } });
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

app.delete('/api/file/:id', requireAuth, async (req, res) => {
  const file = db.data.files.find(f => f.id === req.params.id && f.user_id === req.session.userId);
  if (!file) return res.status(404).json({ error: 'Файл не найден' });
  const filePath = path.join(uploadDir, file.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.data.files = db.data.files.filter(f => f.id !== req.params.id);
  const user = db.data.users.find(u => u.id === req.session.userId);
  user.used_storage -= file.size;
  await db.write();
  res.json({ success: true });
});

async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`IMGUT.DOKV на порту ${PORT}`));
}
start();
