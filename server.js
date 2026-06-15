const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

// Автоматически создаём папку uploads
const uploadDir = path.join(__dirname, 'uploads');
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch(e) {}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});

// Принимаем ВООБЩЕ ЛЮБЫЕ файлы, без проверок
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// База данных (удали старый файл database.db, если хочешь начать с нуля, но не обязательно)
const db = new sqlite3.Database('database.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    storage_limit INTEGER DEFAULT 3221225472,
    used_storage INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mimetype TEXT NOT NULL,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'secret123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Проверка входа
function auth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Сначала войди' });
}

// Регистрация и вход (как раньше)
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин/пароль обязательны' });
  const hashed = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed], function(err) {
    if (err) return res.status(409).json({ error: 'Логин занят' });
    req.session.userId = this.lastID;
    res.json({ success: true });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    req.session.userId = user.id;
    res.json({ success: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/profile', auth, (req, res) => {
  db.get('SELECT id, username, storage_limit, used_storage FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'Пользователь не найден' });
    db.all('SELECT * FROM files WHERE user_id = ? ORDER BY upload_date DESC', [user.id], (err, files) => {
      res.json({ user, files: files || [] });
    });
  });
});

// ЕДИНСТВЕННАЯ ЗАГРУЗКА – без фильтров, с выводом ошибки в ответ и в консоль
app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, function(err) {
    if (err) {
      console.log('ОШИБКА MULTER:', err.message);
      return res.status(400).json({ error: 'Ошибка загрузки: ' + err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не был отправлен. Выбери файл.' });
    }

    const userId = req.session.userId;
    db.get('SELECT storage_limit, used_storage FROM users WHERE id = ?', [userId], (err, user) => {
      if (err || !user) {
        fs.unlink(req.file.path, () => {});
        return res.status(500).json({ error: 'Пользователь не найден' });
      }

      const newSize = user.used_storage + req.file.size;
      if (newSize > user.storage_limit) {
        fs.unlink(req.file.path, () => {});
        return res.status(413).json({ error: 'Нет места (лимит 3 ГБ)' });
      }

      const fileId = uuidv4();
      db.run('INSERT INTO files (id, user_id, original_name, stored_name, size, mimetype) VALUES (?, ?, ?, ?, ?, ?)',
        [fileId, userId, req.file.originalname, req.file.filename, req.file.size, req.file.mimetype],
        (err) => {
          if (err) {
            fs.unlink(req.file.path, () => {});
            console.log('ОШИБКА SQL:', err.message);
            return res.status(500).json({ error: 'Ошибка базы данных' });
          }
          db.run('UPDATE users SET used_storage = ? WHERE id = ?', [newSize, userId]);
          res.json({ success: true, file: { id: fileId, original_name: req.file.originalname, url: `/file/${fileId}` } });
        }
      );
    });
  });
});

// Отдача файла
app.get('/file/:id', (req, res) => {
  db.get('SELECT stored_name, mimetype, original_name FROM files WHERE id = ?', [req.params.id], (err, file) => {
    if (!file) return res.status(404).send('Файл не найден');
    res.setHeader('Content-Type', file.mimetype);
    res.sendFile(path.join(uploadDir, file.stored_name));
  });
});

// Удаление
app.delete('/api/file/:id', auth, (req, res) => {
  db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, file) => {
    if (!file) return res.status(404).json({ error: 'Файл не найден' });
    fs.unlink(path.join(uploadDir, file.stored_name), () => {});
    db.run('DELETE FROM files WHERE id = ?', [req.params.id]);
    db.run('UPDATE users SET used_storage = used_storage - ? WHERE id = ?', [file.size, req.session.userId]);
    res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}`));