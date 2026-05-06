require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');

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

  // Seed default permissions if none exist
  const existing = await pool.query('SELECT COUNT(*) FROM role_permissions');
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
          'INSERT INTO role_permissions (role, page, allowed) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
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
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google callback
app.get('/auth/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    res.redirect('/'); // Redirect to home after successful login
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
    const result = await pool.query('SELECT role, page, allowed FROM role_permissions ORDER BY role, page');
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
    for (const p of permissions) {
      await pool.query(
        `INSERT INTO role_permissions (role, page, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (role, page) DO UPDATE SET allowed = EXCLUDED.allowed`,
        [p.role, p.page, p.allowed]
      );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST reset permissions to defaults
app.post('/api/admin/permissions/reset', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM role_permissions');
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

// Serve the main site
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
