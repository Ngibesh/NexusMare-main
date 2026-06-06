require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure required directories exist (Railway may not have them)
const uploadDir = path.join(__dirname, 'uploads');
const dbDir = path.join(__dirname, 'data'); // separate folder for database
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'database.sqlite');

// Multer config (same as before)
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  if (extname && mimetype) cb(null, true);
  else cb(new Error('Only image files are allowed'));
};

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 3600000 } // secure: true if using HTTPS
}));

// Serve static files (frontend + uploads)
app.use(express.static(path.join(__dirname, '/')));
app.use('/uploads', express.static(uploadDir));

// ---------- Database setup ----------
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fullName TEXT,
    email TEXT,
    transactionId TEXT,
    screenshotPath TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS affiliates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    social TEXT,
    status TEXT,
    code TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliateCode TEXT,
    amount INTEGER,
    status TEXT,
    transactionId TEXT,
    buyerEmail TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliateCode TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Helper: generate affiliate code
function generateAffiliateCode(name, email) {
  const base = (name.split(' ')[0] + email.substring(0,4)).replace(/[^a-z0-9]/gi, '').toUpperCase();
  return base + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ---------- API Routes ----------

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ admin: !!req.session.admin });
});

// Payment submission (file required)
app.post('/api/payments', upload.single('screenshot'), (req, res) => {
  const { fullName, email, transactionId } = req.body;
  if (!fullName || !email || !transactionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Screenshot is required' });
  }
  const screenshotPath = `/uploads/${req.file.filename}`;
  db.run(`INSERT INTO payments (fullName, email, transactionId, screenshotPath) VALUES (?, ?, ?, ?)`,
    [fullName, email, transactionId, screenshotPath], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

// Get all payments (admin only)
app.get('/api/payments', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Unauthorized' });
  db.all(`SELECT * FROM payments ORDER BY timestamp DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Affiliate apply
app.post('/api/affiliate/apply', (req, res) => {
  const { name, email, social } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  db.get(`SELECT * FROM affiliates WHERE email = ?`, [email], (err, existing) => {
    if (existing) {
      return res.json({ success: true, status: existing.status, code: existing.code });
    }
    db.run(`INSERT INTO affiliates (name, email, social, status, code) VALUES (?, ?, ?, 'pending', NULL)`,
      [name, email, social], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, status: 'pending' });
      });
  });
});

// Affiliate dashboard
app.post('/api/affiliate/dashboard', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  db.get(`SELECT * FROM affiliates WHERE email = ?`, [email], (err, aff) => {
    if (err || !aff) return res.json({ exists: false });
    if (aff.status !== 'approved') return res.json({ exists: true, status: aff.status });
    db.get(`SELECT COUNT(*) as clicks FROM clicks WHERE affiliateCode = ?`, [aff.code], (err, clickRow) => {
      db.get(`SELECT COUNT(*) as sales, COALESCE(SUM(amount),0) as earnings FROM commissions WHERE affiliateCode = ? AND status = 'approved'`, [aff.code], (err, saleRow) => {
        res.json({
          exists: true,
          status: aff.status,
          code: aff.code,
          clicks: clickRow ? clickRow.clicks : 0,
          sales: saleRow ? saleRow.sales : 0,
          earnings: saleRow ? saleRow.earnings : 0
        });
      });
    });
  });
});

// Track affiliate click
app.post('/api/affiliate/click', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  db.run(`INSERT INTO clicks (affiliateCode) VALUES (?)`, [code]);
  res.json({ success: true });
});

// Record commission
app.post('/api/commission', (req, res) => {
  const { affiliateCode, transactionId, buyerEmail, amount } = req.body;
  if (!affiliateCode || !transactionId) return res.status(400).json({ error: 'Missing data' });
  db.run(`INSERT INTO commissions (affiliateCode, amount, status, transactionId, buyerEmail) VALUES (?, ?, 'approved', ?, ?)`,
    [affiliateCode, amount || 1500, transactionId, buyerEmail], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// Admin: get all affiliates
app.get('/api/admin/affiliates', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Unauthorized' });
  db.all(`SELECT * FROM affiliates ORDER BY createdAt DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin: approve affiliate
app.post('/api/admin/affiliate/approve', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Unauthorized' });
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  db.get(`SELECT * FROM affiliates WHERE id = ?`, [id], (err, aff) => {
    if (err || !aff) return res.status(404).json({ error: 'Not found' });
    const code = generateAffiliateCode(aff.name, aff.email);
    db.run(`UPDATE affiliates SET status = 'approved', code = ? WHERE id = ?`, [code, id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, code });
    });
  });
});

// Admin: reject affiliate
app.post('/api/admin/affiliate/reject', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Unauthorized' });
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  db.run(`UPDATE affiliates SET status = 'rejected' WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Admin: get all commissions
app.get('/api/admin/commissions', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Unauthorized' });
  db.all(`SELECT * FROM commissions ORDER BY timestamp DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Serve frontend (must be after API routes)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Secure server running on http://localhost:${PORT}`);
});