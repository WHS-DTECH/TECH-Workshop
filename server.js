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

// Upload image for activity cards (PNG/JPG/JPEG only)
const uploadOutcomeImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG and JPG images are allowed'));
  }
});

// Upload supporting assessment images (up to 5 PNG/JPG files)
const uploadAssessmentImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG and JPG images are allowed'));
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const appDatabaseUrl = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
const sessionDatabaseUrl = process.env.SESSION_DATABASE_URL || appDatabaseUrl;
if (!appDatabaseUrl) {
  throw new Error('Missing database URL. Set APP_DATABASE_URL or DATABASE_URL.');
}
const siteUrl = process.env.SITE_URL || '';
const callbackUrl = process.env.CALLBACK_URL || '';
const isSecureDeployment = /^https:\/\//i.test(siteUrl) || /^https:\/\//i.test(callbackUrl);
const configuredAllowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',')
  .map(domain => domain.trim().toLowerCase())
  .filter(Boolean);
const fallbackAllowedDomain = ((process.env.EMAIL_USER || '').split('@')[1] || '').trim().toLowerCase();
const allowedEmailDomains = new Set(configuredAllowedDomains.length ? configuredAllowedDomains : (fallbackAllowedDomain ? [fallbackAllowedDomain] : []));

// Neon database connection
const pool = new Pool({
  connectionString: appDatabaseUrl,
  ssl: { rejectUnauthorized: false }
});

// Optional separate database for session storage.
const sessionPool = new Pool({
  connectionString: sessionDatabaseUrl,
  ssl: { rejectUnauthorized: false }
});

const ROLE_TITLE_TO_SLUG = {
  'Admin': 'admin',
  'Lead Teacher': 'lead_teacher',
  'Teacher': 'teacher',
  'Technician': 'technician',
  'Staff': 'staff',
  'Student': 'student',
  'Public Access': 'public_access'
};

const ROLE_SLUG_TO_TITLE = Object.fromEntries(
  Object.entries(ROLE_TITLE_TO_SLUG).map(([title, slug]) => [slug, title])
);

function buildOAuthCallbackUrl(req) {
  // Prefer explicit env callback, but normalize to the active host to avoid
  // session/state mismatches when multiple domains are used.
  const configured = String(process.env.CALLBACK_URL || '').trim();
  const activeOrigin = `${req.protocol}://${req.get('host')}`;

  if (!configured) {
    return `${activeOrigin}/auth/callback`;
  }

  try {
    const parsed = new URL(configured);
    parsed.protocol = req.protocol;
    parsed.host = req.get('host');
    return parsed.toString();
  } catch {
    return `${activeOrigin}/auth/callback`;
  }
}

function toRoleTitle(slugOrTitle) {
  return ROLE_SLUG_TO_TITLE[slugOrTitle] || slugOrTitle;
}

function toRoleSlug(titleOrSlug) {
  return ROLE_TITLE_TO_SLUG[titleOrSlug] || String(titleOrSlug || '').toLowerCase().replace(/\s+/g, '_');
}

async function isLegacyRolePermissionsSchema() {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'role_permissions'
  `);
  const cols = new Set(result.rows.map(r => r.column_name));
  return cols.has('role_name') && cols.has('recipes') && cols.has('add_recipes');
}

function buildDefaultPermissions() {
  return [
    ['Admin',         true,  true,  true,  true,  true ],
    ['Lead Teacher',  true,  true,  true,  true,  false],
    ['Teacher',       true,  false, true,  true,  false],
    ['Technician',    true,  false, true,  false, false],
    ['Staff',         true,  false, true,  false, false],
    ['Student',       true,  false, true,  false, false],
    ['Public Access', true,  false, false, false, false],
  ];
}

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_activities (
      id SERIAL PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      activity_name VARCHAR(255) NOT NULL,
      card_url TEXT,
      year_level VARCHAR(50),
      activity_type VARCHAR(100),
      activity_category VARCHAR(100),
      duration_minutes INTEGER,
      difficulty VARCHAR(100),
      card_color VARCHAR(50),
      subject_stream VARCHAR(100),
      outcome_image_url TEXT,
      outcome_image_data BYTEA,
      outcome_image_mime VARCHAR(100),
      outcome_image_filename VARCHAR(255),
      short_description TEXT,
      resources_text TEXT,
      equipment_text TEXT,
      instructions_text TEXT,
      management_notes TEXT,
      class_preparation TEXT,
      assessment_focus TEXT,
      common_resources TEXT[] DEFAULT '{}',
      show_this_week BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_url_ideas (
      id SERIAL PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      activity_name VARCHAR(255) NOT NULL,
      activity_type VARCHAR(150),
      card_color VARCHAR(50),
      idea_url TEXT NOT NULL,
      short_description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_assessment_tasks (
      id SERIAL PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assessment_task_name VARCHAR(255) NOT NULL,
      year_level VARCHAR(50),
      task_type VARCHAR(100),
      activity_category VARCHAR(120),
      difficulty VARCHAR(100),
      subject_stream VARCHAR(120),
      duration_hours VARCHAR(50),
      card_color VARCHAR(50),
      short_description TEXT,
      task_list TEXT,
      selected_standard VARCHAR(40),
      standard_details TEXT,
      req_achieved TEXT,
      req_merit TEXT,
      req_excellence TEXT,
      submit_requirements TEXT,
      relevant_implications TEXT,
      progress_record TEXT,
      feedback_training TEXT,
      supporting_files JSONB DEFAULT '[]'::jsonb,
      show_this_week BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default permissions if none exist
  const legacy = await isLegacyRolePermissionsSchema();
  if (!legacy) {
    const existing = await pool.query('SELECT COUNT(*) FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL');
    if (parseInt(existing.rows[0].count) === 0) {
      const defaults = buildDefaultPermissions();
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
  }

  console.log('Database tables ready.');
}

initDB().catch(console.error);

// Middleware
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Session stored in Neon database
app.use(session({
  store: new pgSession({ pool: sessionPool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureDeployment,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }
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
    const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').trim().toLowerCase();
    const name = String(profile.displayName || '').trim() || email;
    const picture = (profile.photos && profile.photos[0] && profile.photos[0].value) || null;
    const hostedDomain = String(profile._json && profile._json.hd || '').trim().toLowerCase();
    const emailVerified = Boolean(profile._json && profile._json.email_verified);
    const emailDomain = email.includes('@') ? email.split('@')[1] : '';

    if (!email || !emailVerified) {
      return done(null, false, { message: 'Google account email must be verified.' });
    }

    if (allowedEmailDomains.size > 0) {
      const allowed = allowedEmailDomains.has(emailDomain) || (hostedDomain && allowedEmailDomains.has(hostedDomain));
      if (!allowed) {
        return done(null, false, { message: 'Please sign in with an approved school account.' });
      }
    }

    // Resolve existing account by either Google ID or email to avoid unique-email conflicts.
    let result = await pool.query(
      'SELECT * FROM users WHERE google_id = $1 OR email = $2 LIMIT 1',
      [googleId, email]
    );

    if (result.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO users (google_id, email, name, picture) VALUES ($1, $2, $3, $4) RETURNING *',
        [googleId, email, name, picture]
      );
    } else {
      const existing = result.rows[0];
      result = await pool.query(
        `UPDATE users
         SET google_id = $1,
             email = $2,
             name = $3,
             picture = $4
         WHERE id = $5
         RETURNING *`,
        [googleId, email, name, picture, existing.id]
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

async function requireAdminOrLead(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1",
      [req.user.id, ['Admin', 'Lead Teacher']]
    );
    if (result.rows.length > 0) return next();
    return res.status(403).json({ error: 'Admin or Lead Teacher access required' });
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
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: true,
    callbackURL: buildOAuthCallbackUrl(req),
    hd: allowedEmailDomains.size === 1 ? [...allowedEmailDomains][0] : undefined,
  })(req, res, next);
});

// Google callback
app.get('/auth/callback',
  (req, res, next) => {
    passport.authenticate('google', {
      failureRedirect: '/?error=auth_failed',
      callbackURL: buildOAuthCallbackUrl(req),
    })(req, res, next);
  },
  (req, res) => {
    const returnTo = req.session && req.session.returnTo;
    if (req.session) delete req.session.returnTo;
    res.redirect(returnTo || '/');
  }
);

// Convert unexpected OAuth errors to a controlled redirect instead of a 500 page.
app.use((err, req, res, next) => {
  if (req.path === '/auth/callback') {
    console.error('OAuth callback error:', err && err.message ? err.message : err);
    return res.redirect('/?error=auth_callback');
  }
  next(err);
});

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

const SCHOOL_TERMS_SOURCE_URL = 'https://www.education.govt.nz/school-terms-and-holidays-dates';

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBasicEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function sanitizeMinistryHtml(rawHtml) {
  const mainMatch = rawHtml.match(/<main[\s\S]*?<\/main>/i)
    || rawHtml.match(/<article[\s\S]*?<\/article>/i)
    || rawHtml.match(/<body[\s\S]*?<\/body>/i);

  let contentHtml = mainMatch ? mainMatch[0] : rawHtml;

  contentHtml = contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  return contentHtml
    .replace(/href="\/(?!\/)/gi, 'href="https://www.education.govt.nz/')
    .replace(/src="\/(?!\/)/gi, 'src="https://www.education.govt.nz/');
}

async function fetchMinistryTermsRawHtml() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(SCHOOL_TERMS_SOURCE_URL, {
      signal: controller.signal,
      headers: {
        'user-agent': 'WHS-Workshop-TermsFetcher/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Source responded with ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseMinistryTermDates(rawHtml) {
  const monthIndex = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  const cleanText = decodeBasicEntities(stripHtmlTags(rawHtml));
  const yearMatch = cleanText.match(/school terms and holidays[^0-9]*(20\d{2})/i);
  const targetYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : new Date().getFullYear();

  function buildDate(day, monthName, explicitYear) {
    const month = monthIndex[String(monthName || '').toLowerCase()];
    if (Number.isNaN(day) || month === undefined) return null;
    const year = explicitYear ? Number.parseInt(explicitYear, 10) : targetYear;
    const dt = new Date(Date.UTC(year, month, day));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function toIso(dt) {
    return dt.toISOString().slice(0, 10);
  }

  function formatWeekRange(start, end) {
    const fmt = new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', day: 'numeric', month: 'short' });
    return `Mon ${fmt.format(start)} - Fri ${fmt.format(end)}`;
  }

  const terms = [];

  // Split content into per-term sections so dates from other terms do not leak in.
  const headingRegex = /Term\s*(\d)\s*\(([^)]*)\)/gi;
  const headings = [];
  let hm;
  while ((hm = headingRegex.exec(cleanText)) !== null) {
    headings.push({
      term: Number.parseInt(hm[1], 10),
      meta: hm[2] || '',
      index: hm.index,
      headingEnd: headingRegex.lastIndex,
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    const next = headings[i + 1];
    const sectionText = cleanText.slice(current.headingEnd, next ? next.index : cleanText.length);

    const sectionDateRegex = /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(20\d{2}))?/gi;
    const foundDates = [];
    let dm;
    while ((dm = sectionDateRegex.exec(sectionText)) !== null) {
      const day = Number.parseInt(dm[1], 10);
      const dt = buildDate(day, dm[2], dm[3]);
      if (dt) foundDates.push(dt);
    }

    const uniqueDates = [...new Map(foundDates.map(d => [toIso(d), d])).values()]
      .sort((a, b) => a - b);

    if (!uniqueDates.length) continue;

    const startDate = uniqueDates[0];
    const endDate = uniqueDates[uniqueDates.length - 1];
    const weekCountMatch = String(current.meta || '').match(/(\d+)\s*weeks?/i);
    const explicitWeekCount = weekCountMatch ? Number.parseInt(weekCountMatch[1], 10) : null;

    const weeks = [];
    const weekLimit = explicitWeekCount && explicitWeekCount > 0 ? explicitWeekCount : 20;
    let cursor = new Date(startDate.getTime());

    for (let w = 0; w < weekLimit; w++) {
      const weekStart = new Date(cursor.getTime());
      const weekEnd = new Date(cursor.getTime());
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 4);

      if (!explicitWeekCount && weekStart > endDate) break;

      weeks.push({
        week: w + 1,
        startDate: toIso(weekStart),
        endDate: toIso(weekEnd),
        label: formatWeekRange(weekStart, weekEnd),
      });

      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    terms.push({
      term: current.term,
      startDate: toIso(startDate),
      endDate: toIso(endDate),
      weeks,
    });
  }

  terms.sort((a, b) => a.term - b.term);

  return { year: targetYear, terms };
}

app.get('/api/admin/school-terms', requireAuth, requireAdminOrLead, async (req, res) => {
  try {
    const rawHtml = await fetchMinistryTermsRawHtml();
    const contentHtml = sanitizeMinistryHtml(rawHtml);

    res.json({
      sourceUrl: SCHOOL_TERMS_SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      html: contentHtml,
    });
  } catch (error) {
    console.error('School terms fetch error:', error);
    res.status(502).json({ error: 'Failed to load school terms from the Ministry website.' });
  }
});

app.get('/api/planning/term-dates', async (req, res) => {
  try {
    const rawHtml = await fetchMinistryTermsRawHtml();
    const parsed = parseMinistryTermDates(rawHtml);

    res.json({
      sourceUrl: SCHOOL_TERMS_SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      ...parsed,
    });
  } catch (error) {
    console.error('Term dates parse error:', error);
    res.status(502).json({ error: 'Failed to fetch term dates.' });
  }
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
    const legacy = await isLegacyRolePermissionsSchema();
    if (legacy) {
      const rows = await pool.query(
        `SELECT role_name, recipes, add_recipes, planning, admin
         FROM role_permissions
         WHERE role_name IS NOT NULL
         ORDER BY role_name`
      );

      if (!rows.rows.length) {
        const defaults = buildDefaultPermissions();
        for (const [role, homepage, addProjects, viewProjects, planning, admin] of defaults) {
          const roleSlug = toRoleSlug(role);
          const recipes = !!(homepage || viewProjects);
          await pool.query(
            `INSERT INTO role_permissions (role_name, recipes, add_recipes, planning, admin)
             VALUES ($1, $2, $3, $4, $5)`,
            [roleSlug, recipes, !!addProjects, !!planning, !!admin]
          );
        }
      }

      const normalized = [];
      const legacyRows = (await pool.query(
        `SELECT role_name, recipes, add_recipes, planning, admin
         FROM role_permissions
         WHERE role_name IS NOT NULL
         ORDER BY role_name`
      )).rows;
      for (const r of legacyRows) {
        const role = toRoleTitle(r.role_name);
        normalized.push({ role, page: 'homepage', allowed: !!r.recipes });
        normalized.push({ role, page: 'add_projects', allowed: !!r.add_recipes });
        normalized.push({ role, page: 'view_projects', allowed: !!r.recipes });
        normalized.push({ role, page: 'planning', allowed: !!r.planning });
        normalized.push({ role, page: 'admin', allowed: !!r.admin });
      }
      return res.json(normalized);
    }

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
    const legacy = await isLegacyRolePermissionsSchema();
    if (legacy) {
      const byRole = new Map();
      for (const p of permissions) {
        const role = p.role;
        if (!byRole.has(role)) byRole.set(role, {});
        byRole.get(role)[p.page] = !!p.allowed;
      }

      for (const [roleTitle, pages] of byRole.entries()) {
        const roleSlug = toRoleSlug(roleTitle);
        const recipes = !!(pages.homepage || pages.view_projects);
        const addRecipes = !!pages.add_projects;
        const planning = !!pages.planning;
        const admin = !!pages.admin;

        const updateResult = await pool.query(
          `UPDATE role_permissions
           SET recipes = $2, add_recipes = $3, planning = $4, admin = $5
           WHERE role_name = $1`,
          [roleSlug, recipes, addRecipes, planning, admin]
        );

        if (updateResult.rowCount === 0) {
          await pool.query(
            `INSERT INTO role_permissions (role_name, recipes, add_recipes, planning, admin)
             VALUES ($1, $2, $3, $4, $5)`,
            [roleSlug, recipes, addRecipes, planning, admin]
          );
        }
      }
      return res.json({ success: true });
    }

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
    const legacy = await isLegacyRolePermissionsSchema();
    if (legacy) {
      const defaults = buildDefaultPermissions();
      for (const [role, homepage, addProjects, viewProjects, planning, admin] of defaults) {
        const roleSlug = toRoleSlug(role);
        const recipes = !!(homepage || viewProjects);
        const updateResult = await pool.query(
          `UPDATE role_permissions
           SET recipes = $2, add_recipes = $3, planning = $4, admin = $5
           WHERE role_name = $1`,
          [roleSlug, recipes, !!addProjects, !!planning, !!admin]
        );
        if (updateResult.rowCount === 0) {
          await pool.query(
            `INSERT INTO role_permissions (role_name, recipes, add_recipes, planning, admin)
             VALUES ($1, $2, $3, $4, $5)`,
            [roleSlug, recipes, !!addProjects, !!planning, !!admin]
          );
        }
      }
      return res.json({ success: true });
    }

    await pool.query('DELETE FROM role_permissions WHERE role IS NOT NULL AND page IS NOT NULL');
    const defaults = buildDefaultPermissions();
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
app.post('/api/upload-activity', requireAuth, uploadOutcomeImage.single('outcome_image_file'), async (req, res) => {
  try {
    const activityName = String(req.body.activity_name || '').trim();
    if (!activityName) {
      return res.status(400).json({ error: 'Activity name is required.' });
    }

    const durationRaw = String(req.body.duration_minutes || '').trim();
    const durationMinutes = durationRaw ? Number.parseInt(durationRaw, 10) : null;
    if (durationRaw && Number.isNaN(durationMinutes)) {
      return res.status(400).json({ error: 'Duration must be a number of minutes.' });
    }

    const commonResourcesRaw = req.body.common_resources;
    const commonResources = Array.isArray(commonResourcesRaw)
      ? commonResourcesRaw.filter(Boolean)
      : (commonResourcesRaw ? [commonResourcesRaw] : []);

    const showThisWeek = req.body.show_this_week === 'on' || req.body.show_this_week === 'true';

    const file = req.file;
    const insert = await pool.query(
      `INSERT INTO uploaded_activities
      (created_by, activity_name, card_url, year_level, activity_type, activity_category, duration_minutes,
       difficulty, card_color, subject_stream, outcome_image_url, outcome_image_data, outcome_image_mime,
       outcome_image_filename, short_description, resources_text, equipment_text, instructions_text,
       management_notes, class_preparation, assessment_focus, common_resources, show_this_week)
      VALUES
      ($1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23)
      RETURNING id, created_at`,
      [
        req.user.id,
        activityName,
        String(req.body.card_url || '').trim() || null,
        String(req.body.year_level || '').trim() || null,
        String(req.body.activity_type || '').trim() || null,
        String(req.body.activity_category || '').trim() || null,
        durationMinutes,
        String(req.body.difficulty || '').trim() || null,
        String(req.body.card_color || '').trim() || null,
        String(req.body.subject_stream || '').trim() || null,
        String(req.body.outcome_image_url || '').trim() || null,
        file ? file.buffer : null,
        file ? file.mimetype : null,
        file ? file.originalname : null,
        String(req.body.short_description || '').trim() || null,
        String(req.body.resources_text || '').trim() || null,
        String(req.body.equipment_text || '').trim() || null,
        String(req.body.instructions_text || '').trim() || null,
        String(req.body.management_notes || '').trim() || null,
        String(req.body.class_preparation || '').trim() || null,
        String(req.body.assessment_focus || '').trim() || null,
        commonResources,
        showThisWeek
      ]
    );

    res.json({ success: true, id: insert.rows[0].id, created_at: insert.rows[0].created_at });
  } catch (e) {
    console.error('Upload activity error:', e);
    res.status(500).json({ error: 'Failed to save activity.' });
  }
});

app.post('/api/upload-url-idea', requireAuth, async (req, res) => {
  try {
    const activityName = String(req.body.activity_name || '').trim();
    const ideaUrl = String(req.body.idea_url || '').trim();
    const activityType = String(req.body.activity_type || '').trim();
    const cardColor = String(req.body.card_color || '').trim() || 'Teal';
    const shortDescription = String(req.body.short_description || '').trim();

    if (!activityName || !ideaUrl) {
      return res.status(400).json({ error: 'Activity name and URL are required.' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(ideaUrl);
    } catch {
      return res.status(400).json({ error: 'Please enter a valid URL starting with http:// or https://.' });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http and https URLs are allowed.' });
    }

    const result = await pool.query(
      `INSERT INTO uploaded_url_ideas
        (created_by, activity_name, activity_type, card_color, idea_url, short_description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [req.user.id, activityName, activityType || null, cardColor, ideaUrl, shortDescription || null]
    );

    res.json({ success: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (e) {
    console.error('Upload URL idea error:', e);
    res.status(500).json({ error: 'Failed to save URL idea.' });
  }
});

app.post('/api/upload-assessment-task', requireAuth, uploadAssessmentImages.array('supporting_images', 5), async (req, res) => {
  try {
    const taskName = String(req.body.assessment_task_name || '').trim();
    if (!taskName) {
      return res.status(400).json({ error: 'Assessment task name is required.' });
    }

    const selectedStandard = String(req.body.selected_standard || '').trim();
    const filesMeta = (req.files || []).map(file => ({
      name: file.originalname,
      mime: file.mimetype,
      size: file.size,
    }));

    const showThisWeek = req.body.show_this_week === 'on' || req.body.show_this_week === 'true';

    const result = await pool.query(
      `INSERT INTO uploaded_assessment_tasks
      (created_by, assessment_task_name, year_level, task_type, activity_category, difficulty, subject_stream,
       duration_hours, card_color, short_description, task_list, selected_standard, standard_details,
       req_achieved, req_merit, req_excellence, submit_requirements, relevant_implications,
       progress_record, feedback_training, supporting_files, show_this_week)
      VALUES
      ($1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22)
      RETURNING id, created_at`,
      [
        req.user.id,
        taskName,
        String(req.body.year_level || '').trim() || null,
        String(req.body.task_type || '').trim() || null,
        String(req.body.activity_category || '').trim() || null,
        String(req.body.difficulty || '').trim() || null,
        String(req.body.subject_stream || '').trim() || null,
        String(req.body.duration_hours || '').trim() || null,
        String(req.body.card_color || '').trim() || null,
        String(req.body.short_description || '').trim() || null,
        String(req.body.task_list || '').trim() || null,
        selectedStandard || null,
        String(req.body.standard_details || '').trim() || null,
        String(req.body.req_achieved || '').trim() || null,
        String(req.body.req_merit || '').trim() || null,
        String(req.body.req_excellence || '').trim() || null,
        String(req.body.submit_requirements || '').trim() || null,
        String(req.body.relevant_implications || '').trim() || null,
        String(req.body.progress_record || '').trim() || null,
        String(req.body.feedback_training || '').trim() || null,
        JSON.stringify(filesMeta),
        showThisWeek,
      ]
    );

    res.json({ success: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (e) {
    console.error('Upload assessment task error:', e);
    res.status(500).json({ error: 'Failed to save assessment task.' });
  }
});

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
