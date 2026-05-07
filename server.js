require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');

// Nodemailer transporter — uses EMAIL_USER + EMAIL_PASS from .env
// Set EMAIL_USER to your Gmail address and EMAIL_PASS to a Gmail App Password
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Multer — memory storage (keeps PDF in RAM, stores in DB as buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

// Neon database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialise database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      picture VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(100) NOT NULL,
      user_type VARCHAR(50) DEFAULT 'Staff',
      assigned_by INTEGER REFERENCES users(id),
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, role)
    );
  `);

  // Role permissions table — which pages each role can access
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role VARCHAR(100) NOT NULL,
      page VARCHAR(100) NOT NULL,
      allowed BOOLEAN DEFAULT true,
      UNIQUE(role, page)
    );
  `);

  // Legacy compatibility: some databases already have role_permissions in an older wide-column format.
  // Add the normalized columns expected by this app if they are missing.
  await pool.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS role VARCHAR(100);`);
  await pool.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS page VARCHAR(100);`);
  await pool.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS allowed BOOLEAN DEFAULT true;`);

  // Activity suggestions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_suggestions (
      id SERIAL PRIMARY KEY,
      submitter_name VARCHAR(255) NOT NULL,
      submitter_email VARCHAR(255) NOT NULL,
      activity_name VARCHAR(255) NOT NULL,
      activity_url TEXT,
      reason TEXT,
      pdf_data BYTEA,
      pdf_filename VARCHAR(255),
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default permissions if none exist
  const existing = await pool.query('SELECT COUNT(*) FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL');
  if (parseInt(existing.rows[0].count) === 0) {
    const defaults = [
      // [role, homepage, add_projects, view_projects, planning, admin]
      ['Admin',         true,  true,  true,  true,  true ],
      ['Lead Teacher',  true,  true,  true,  true,  false],
      ['Teacher',       true,  false, true,  true,  false],
      ['Technician',    true,  false, true,  false, false],
      ['Staff',         true,  false, true,  false, false],
      ['Student',       true,  false, true,  false, false],
      ['Public Access', true,  false, false, false, false],
    ];
    const pages = ['homepage', 'add_projects', 'view_projects', 'planning', 'admin'];
    for (const [role, ...perms] of defaults) {
      for (let i = 0; i < pages.length; i++) {
        await pool.query(
          'INSERT INTO role_permissions (role, page, allowed) VALUES ($1, $2, $3)',
          [role, pages[i], perms[i]]
        );
      }
    }
    console.log('Default permissions seeded.');
  }

  console.log('Database tables ready.');
}

initDB().catch(console.error);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Session stored in Neon database
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const googleId = profile.id;
    const email = profile.emails[0].value;
    const name = profile.displayName;
    const picture = profile.photos[0].value;

    // Check if user already exists
    let result = await pool.query(
      'SELECT * FROM users WHERE google_id = $1',
      [googleId]
    );

    if (result.rows.length === 0) {
      // New user — insert into database
      result = await pool.query(
        'INSERT INTO users (google_id, email, name, picture) VALUES ($1, $2, $3, $4) RETURNING *',
        [googleId, email, name, picture]
      );
    }

    return done(null, result.rows[0]);
  } catch (error) {
    return done(error, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0]);
  } catch (error) {
    done(error, null);
  }
});

// Auth middleware — protects routes that require login
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// Admin middleware — only users with 'Admin' role
async function requireAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'Admin'",
      [req.user.id]
    );
    if (result.rows.length > 0) return next();
    return res.status(403).json({ error: 'Admin access required' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Start Google login
app.get('/auth/google', (req, res, next) => {
  const { returnTo } = req.query;
  // Only allow internal relative paths to prevent open redirects
  if (typeof returnTo === 'string' && returnTo.startsWith('/')) {
    req.session.returnTo = returnTo;
  }
  next();
}, passport.authenticate('google', { scope: ['profile', 'email'] }));

// Google callback
app.get('/auth/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    const returnTo = req.session.returnTo;
    delete req.session.returnTo;
    res.redirect(returnTo || '/');
  }
);

// Logout
app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// Get current logged-in user (used by frontend)
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    const { id, name, email, picture } = req.user;
    res.json({ id, name, email, picture });
  } else {
    res.json(null);
  }
});

// Protected example route
app.get('/api/protected', requireAuth, (req, res) => {
  res.json({ message: `Welcome, ${req.user.name}!` });
});

// ─── Admin: Role Management ──────────────────────────────────────────────────

// GET all users with their roles
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.created_at,
        COALESCE(
          json_agg(json_build_object('role', ur.role, 'user_type', ur.user_type, 'id', ur.id))
          FILTER (WHERE ur.id IS NOT NULL), '[]'
        ) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET users that have at least one additional role
app.get('/api/admin/users-with-roles', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email,
        json_agg(json_build_object('id', ur.id, 'role', ur.role, 'user_type', ur.user_type)) AS roles
      FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST add a role to a user
app.post('/api/admin/user-roles', requireAdmin, async (req, res) => {
  const { user_id, role, user_type } = req.body;
  if (!user_id || !role) return res.status(400).json({ error: 'user_id and role required' });
  try {
    await pool.query(
      'INSERT INTO user_roles (user_id, role, user_type, assigned_by) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, role) DO NOTHING',
      [user_id, role, user_type || 'Staff', req.user.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE remove all additional roles from a user
app.delete('/api/admin/user-roles/:userId', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [req.params.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE remove a single role from a user
app.delete('/api/admin/user-roles/:userId/:roleId', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND id = $2', [req.params.userId, req.params.roleId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET current user's roles
app.get('/api/my-roles', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT role, user_type FROM user_roles WHERE user_id = $1',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: Role Permissions ──────────────────────────────────────────────

// GET all role permissions
app.get('/api/admin/permissions', requireAdmin, async (req, res) => {
  try {
    let result = await pool.query(
      'SELECT role, page, allowed FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL ORDER BY role, page'
    );

    // Self-heal old databases that had only legacy columns populated.
    if (!result.rows.length) {
      const defaults = [
        ['Admin',         true,  true,  true,  true,  true ],
        ['Lead Teacher',  true,  true,  true,  true,  false],
        ['Teacher',       true,  false, true,  true,  false],
        ['Technician',    true,  false, true,  false, false],
        ['Staff',         true,  false, true,  false, false],
        ['Student',       true,  false, true,  false, false],
        ['Public Access', true,  false, false, false, false],
      ];
      const pages = ['homepage', 'add_projects', 'view_projects', 'planning', 'admin'];
      for (const [role, ...perms] of defaults) {
        for (let i = 0; i < pages.length; i++) {
          await pool.query(
            'INSERT INTO role_permissions (role, page, allowed) VALUES ($1, $2, $3)',
            [role, pages[i], perms[i]]
          );
        }
      }
      result = await pool.query(
        'SELECT role, page, allowed FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL ORDER BY role, page'
      );
    }

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST save all permissions (full replace)
app.post('/api/admin/permissions', requireAdmin, async (req, res) => {
  const { permissions } = req.body; // [{ role, page, allowed }]
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions array required' });
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL');
    for (const p of permissions) {
      await pool.query(
        'INSERT INTO role_permissions (role, page, allowed) VALUES ($1, $2, $3)',
        [p.role, p.page, p.allowed]
      );
    }
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

// POST reset permissions to defaults
app.post('/api/admin/permissions/reset', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL');
    const defaults = [
      ['Admin',         true,  true,  true,  true,  true ],
      ['Lead Teacher',  true,  true,  true,  true,  false],
      ['Teacher',       true,  false, true,  true,  false],
      ['Technician',    true,  false, true,  false, false],
      ['Staff',         true,  false, true,  false, false],
      ['Student',       true,  false, true,  false, false],
      ['Public Access', true,  false, false, false, false],
    ];
    const pages = ['homepage', 'add_projects', 'view_projects', 'planning', 'admin'];
    for (const [role, ...perms] of defaults) {
      for (let i = 0; i < pages.length; i++) {
        await pool.query(
          'INSERT INTO role_permissions (role, page, allowed) VALUES ($1, $2, $3)',
          [role, pages[i], perms[i]]
        );
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Activity Suggestion ───────────────────────────────────────────
app.post('/api/suggest-activity', upload.single('pdf'), async (req, res) => {
  try {
    const { name, email, activity_name, activity_url, reason } = req.body;
    if (!name || !email || !activity_name) {
      return res.status(400).json({ error: 'Name, email, and activity name are required.' });
    }
    const pdfData = req.file ? req.file.buffer : null;
    const pdfFilename = req.file ? req.file.originalname : null;
    const insertResult = await pool.query(
      `INSERT INTO activity_suggestions (submitter_name, submitter_email, activity_name, activity_url, reason, pdf_data, pdf_filename)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, submitted_at`,
      [name.trim(), email.trim(), activity_name.trim(), activity_url?.trim() || null, reason?.trim() || null, pdfData, pdfFilename]
    );

    // Send notification email to all Admins and Lead Teachers
    try {
      const adminRes = await pool.query(
        `SELECT DISTINCT u.email, u.name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         WHERE ur.role IN ('Admin', 'Lead Teacher') AND u.email IS NOT NULL`
      );
      if (adminRes.rows.length && process.env.EMAIL_USER) {
        const toList = adminRes.rows.map(r => r.email).join(', ');
        const submittedAt = insertResult.rows[0].submitted_at;
        const dateStr = new Date(submittedAt).toISOString().slice(0, 10);
        const siteUrl = process.env.SITE_URL || 'https://tech-wworkshop.onrender.com';
        const urlCell = activity_url?.trim() ? activity_url.trim() : 'N/A';

        const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1c74b9;padding:22px 28px;border-radius:8px 8px 0 0">
    <p style="color:rgba(255,255,255,0.75);font-size:11px;letter-spacing:1px;text-transform:uppercase;margin:0 0 4px">WORKSHOP</p>
    <h2 style="color:#fff;margin:0;font-size:22px">New Activity Suggestion</h2>
  </div>
  <div style="background:#f8fbff;padding:24px 28px;border:1px solid #d6e4f0;border-top:none;border-radius:0 0 8px 8px">
    <p style="color:#444;margin:0 0 18px">A new suggestion has been submitted for review.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fff;width:130px">Date</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fff">${dateStr}</td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fafcff">Activity</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fafcff">${activity_name.trim()}</td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fff">Suggested By</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fff">${name.trim()}</td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fafcff">Email</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fafcff"><a href="mailto:${email.trim()}" style="color:#1c74b9">${email.trim()}</a></td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fff">URL</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fff">${urlCell}</td></tr>
      ${pdfFilename ? `<tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fafcff">PDF</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fafcff">${pdfFilename} <em style="color:#888">(download from Suggestions page)</em></td></tr>` : ''}
    </table>
    ${reason?.trim() ? `
    <p style="font-weight:700;color:#1a2a3a;margin:18px 0 6px">Reason</p>
    <div style="background:#fff;border:1px solid #e0e8f0;border-radius:6px;padding:12px 14px;color:#444;font-size:14px">${reason.trim()}</div>` : ''}
    <div style="margin-top:24px">
      <a href="${siteUrl}/admin_suggestions.html" style="display:inline-block;background:#1c74b9;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:700;font-size:14px">Open Suggestions List</a>
    </div>
    <p style="margin:14px 0 0;font-size:12px;color:#888">Direct link: <a href="${siteUrl}/admin_suggestions.html" style="color:#1c74b9">${siteUrl}/admin_suggestions.html</a></p>
  </div>
</div>`;

        await mailer.sendMail({
          from: `"Workshop Hub" <${process.env.EMAIL_USER}>`,
          to: toList,
          subject: `[Activity Suggestion] ${activity_name.trim()}`,
          html: htmlBody,
          attachments: pdfData ? [{ filename: pdfFilename, content: pdfData }] : []
        });
      }
    } catch (emailErr) {
      // Don't fail the request if email fails — just log it
      console.error('Email notification failed:', emailErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Suggestion error:', e);
    res.status(500).json({ error: 'Failed to save suggestion.' });
  }
});

// Admin: view all suggestions
app.get('/api/admin/suggestions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, submitter_name, submitter_email, activity_name, activity_url, reason, pdf_filename, submitted_at
       FROM activity_suggestions ORDER BY submitted_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: download PDF for a suggestion
app.get('/api/admin/suggestions/:id/pdf', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT pdf_data, pdf_filename FROM activity_suggestions WHERE id = $1',
      [parseInt(req.params.id)]
    );
    if (!result.rows.length || !result.rows[0].pdf_data) {
      return res.status(404).json({ error: 'No PDF found.' });
    }
    const { pdf_data, pdf_filename } = result.rows[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf_filename || 'suggestion.pdf'}"`);
    res.send(pdf_data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve the main site
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
