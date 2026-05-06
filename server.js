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

// Serve the main site
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
