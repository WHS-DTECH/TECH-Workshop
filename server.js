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
const JSZip = require('jszip');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Nodemailer transporter — uses EMAIL_USER + EMAIL_PASS from .env
// Set EMAIL_USER to your Gmail address and EMAIL_PASS to a Gmail App Password
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const hasMailerConfig = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
if (hasMailerConfig) {
  mailer.verify().then(() => {
    console.log('Email transporter is ready.');
  }).catch((error) => {
    console.error('Email transporter verification failed:', error.message);
  });
} else {
  console.warn('Email transporter is not fully configured. Set EMAIL_USER and EMAIL_PASS.');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normaliseHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

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

const uploadPlannerDocx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isDocx = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || String(file.originalname || '').toLowerCase().endsWith('.docx');
    if (isDocx) cb(null, true);
    else cb(new Error('Only DOCX files are allowed'));
  }
});

const uploadTopicsDocx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isDocx = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || String(file.originalname || '').toLowerCase().endsWith('.docx');
    if (isDocx) cb(null, true);
    else cb(new Error('Only DOCX files are allowed'));
  }
});

const uploadWorksheetFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const allowedMimeTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];

    const allowedExtension = name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc');
    if (allowedMimeTypes.includes(file.mimetype) || allowedExtension) {
      cb(null, true);
      return;
    }

    cb(new Error('Only PDF and Word files are allowed for worksheets.'));
  }
});

const uploadWorksheetFiles = uploadWorksheetFile.fields([
  { name: 'worksheet_files', maxCount: 40 },
  { name: 'worksheet_file', maxCount: 1 },
]);

function inferWorksheetCategory(sourceText) {
  const text = String(sourceText || '').toLowerCase();

  if (/safety|safe\b/.test(text)) return 'Safety';
  if (/hand\s*tools?|tools?\s*hand/.test(text)) return 'Hand tools';
  if (/abrasive|abrasives|sandpaper|sanding/.test(text)) return 'Abrasives';
  if (/joint|joints|process|processes/.test(text)) return 'Joints and Processes';
  if (/finish|finishes|finishing|stain|varnish|polyurethane|oil\b|wax|lacquer/.test(text)) return 'Type of wood finishes';

  return 'Uncategorized';
}

function normaliseSyncText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function worksheetSyncKey(entry) {
  const title = normaliseSyncText(entry.worksheetTitle ?? entry.worksheet_title);
  const strandTitle = normaliseSyncText(entry.strandTitle ?? entry.strand_title);
  const strandNumber = Number.isInteger(entry.strandNumber)
    ? entry.strandNumber
    : (Number.isInteger(entry.strand_number) ? entry.strand_number : null);
  const strandPart = strandNumber === null ? 'no-strand' : `strand-${strandNumber}`;
  return `${strandPart}|strand-title-${strandTitle || 'none'}|${title}`;
}

function lessonNoteSyncKey(entry) {
  const title = normaliseSyncText(entry.lessonNoteTitle ?? entry.lesson_note_title);
  const strandTitle = normaliseSyncText(entry.strandTitle ?? entry.strand_title);
  const strandNumber = Number.isInteger(entry.strandNumber)
    ? entry.strandNumber
    : (Number.isInteger(entry.strand_number) ? entry.strand_number : null);
  const strandPart = strandNumber === null ? 'no-strand' : `strand-${strandNumber}`;
  return `${strandPart}|strand-title-${strandTitle || 'none'}|${title}`;
}

async function extractWorksheetTitlesFromDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) return [];

  const documentXml = await documentEntry.async('string');
  const paragraphMatches = [...String(documentXml || '').matchAll(/<w:p(?:\s|>)[\s\S]*?<\/w:p>/gi)];

  const paragraphs = paragraphMatches.map((paragraphMatch) => {
    const paragraphXml = paragraphMatch[0];
    const textMatches = [...paragraphXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)];
    const text = textMatches.map(match => match[1]).join(' ');
    return String(text || '').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  const worksheetTitles = paragraphs.filter((paragraph) => {
    if (!/worksheet\b/i.test(paragraph)) return false;
    if (/strand\s*\d+/i.test(paragraph)) return false;
    if (/lesson\s*notes?/i.test(paragraph)) return false;
    return true;
  });

  return [...new Set(worksheetTitles)];
}

async function extractWorksheetStructureFromDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) {
    return { lessonNotes: [], worksheets: [] };
  }

  const documentXml = await documentEntry.async('string');
  const paragraphMatches = [...String(documentXml || '').matchAll(/<w:p(?:\s|>)[\s\S]*?<\/w:p>/gi)];
  const paragraphs = paragraphMatches.map((paragraphMatch) => {
    const paragraphXml = paragraphMatch[0];
    const textMatches = [...paragraphXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)];
    const text = textMatches.map(match => match[1]).join(' ');
    return String(text || '').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  const lessonNotes = [];
  const worksheets = [];
  let currentStrand = null;

  for (const paragraph of paragraphs) {
    const genericResourcesMatch = paragraph.match(/^(.+?)\s+Resources?$/i);
    if (
      genericResourcesMatch
      && !/^Strand\s*\d+/i.test(paragraph)
      && !/worksheet\b/i.test(paragraph)
      && !/lesson\s*notes?/i.test(paragraph)
    ) {
      const baseTitle = String(genericResourcesMatch[1] || '').trim();
      const strandTitle = /\bdvc\b/i.test(baseTitle)
        ? 'DVC'
        : baseTitle;
      currentStrand = {
        strandNumber: null,
        strandTitle: strandTitle || null,
      };
      continue;
    }

    const combinedStrandLessonMatch = paragraph.match(/^Strand\s*(\d+)\s*[-:]\s*(.+?)\s*Lesson\s*Notes?$/i);
    if (combinedStrandLessonMatch) {
      const strandNumber = Number.parseInt(combinedStrandLessonMatch[1], 10);
      const strandTitle = String(combinedStrandLessonMatch[2] || '').trim() || null;
      currentStrand = { strandNumber, strandTitle };

      lessonNotes.push({
        lessonNoteTitle: paragraph,
        strandNumber,
        strandTitle,
      });
      continue;
    }

    const strandOnlyMatch = paragraph.match(/^Strand\s*(\d+)\b(?:\s*[-:]\s*(.+))?$/i);
    if (strandOnlyMatch) {
      const strandNumber = Number.parseInt(strandOnlyMatch[1], 10);
      const strandTitle = String(strandOnlyMatch[2] || '').trim() || null;
      currentStrand = { strandNumber, strandTitle };
      continue;
    }

    const isLessonNoteLine = /lesson\s*notes?/i.test(paragraph);
    if (isLessonNoteLine) {
      const notesAfterPrefix = paragraph.match(/^Lesson\s*Notes?\s*[-:]\s*(.+)$/i);
      const notesBeforeSuffix = paragraph.match(/^(.+?)\s*[-:]?\s*Lesson\s*Notes?$/i);

      const extractedStrandTitle = String(
        (notesAfterPrefix && notesAfterPrefix[1])
        || (notesBeforeSuffix && notesBeforeSuffix[1])
        || ''
      ).trim() || null;

      const strandNumber = currentStrand && Number.isInteger(currentStrand.strandNumber)
        ? currentStrand.strandNumber
        : null;

      const strandTitle = strandNumber === null
        ? ((currentStrand && currentStrand.strandTitle) || extractedStrandTitle || null)
        : (extractedStrandTitle || (currentStrand ? currentStrand.strandTitle : null));

      if (currentStrand && !currentStrand.strandTitle && strandTitle) {
        currentStrand.strandTitle = strandTitle;
      }

      const lessonNoteTitle = strandNumber !== null
        ? `Strand ${strandNumber}${strandTitle ? ` - ${strandTitle}` : ''} Lesson Notes`
        : ((currentStrand && currentStrand.strandTitle)
          ? `${currentStrand.strandTitle} Lesson Notes${extractedStrandTitle && extractedStrandTitle.toLowerCase() !== currentStrand.strandTitle.toLowerCase() ? ` - ${extractedStrandTitle}` : ''}`
          : paragraph);

      lessonNotes.push({
        lessonNoteTitle,
        strandNumber,
        strandTitle,
      });
      continue;
    }

    if (/worksheet\b/i.test(paragraph) && !/lesson\s*notes?/i.test(paragraph)) {
      worksheets.push({
        worksheetTitle: paragraph,
        strandNumber: currentStrand ? currentStrand.strandNumber : null,
        strandTitle: currentStrand ? currentStrand.strandTitle : null,
      });
    }
  }

  const dedupedLessonNotes = lessonNotes.filter((note, index, list) => {
    const key = `${note.strandNumber || ''}|${String(note.strandTitle || '').toLowerCase()}|${String(note.lessonNoteTitle || '').toLowerCase()}`;
    return list.findIndex(item => `${item.strandNumber || ''}|${String(item.strandTitle || '').toLowerCase()}|${String(item.lessonNoteTitle || '').toLowerCase()}` === key) === index;
  });

  return {
    lessonNotes: dedupedLessonNotes,
    worksheets,
  };
}

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
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const configuredSessionSecret = String(process.env.SESSION_SECRET || '');
const sessionSecret = configuredSessionSecret.length >= 32
  ? configuredSessionSecret
  : crypto.randomBytes(48).toString('hex');

if (configuredSessionSecret.length < 32) {
  const note = isProduction
    ? 'Using a temporary generated secret in production; sessions will reset on restart. Set SESSION_SECRET (32+ chars).'
    : 'Using a temporary generated secret. Set SESSION_SECRET (32+ chars) for stable sessions.';
  console.warn(note);
}

const configuredAllowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',')
  .map(domain => domain.trim().toLowerCase())
  .filter(Boolean);
const fallbackAllowedDomain = ((process.env.EMAIL_USER || '').split('@')[1] || '').trim().toLowerCase();
const allowedEmailDomains = new Set(configuredAllowedDomains.length ? configuredAllowedDomains : (fallbackAllowedDomain ? [fallbackAllowedDomain] : []));
if (configuredAllowedDomains.length === 0) {
  if (fallbackAllowedDomain) {
    console.warn(`ALLOWED_EMAIL_DOMAINS not set; falling back to EMAIL_USER domain: ${fallbackAllowedDomain}`);
  } else {
    console.warn('ALLOWED_EMAIL_DOMAINS not set and EMAIL_USER fallback unavailable. Domain restriction is disabled.');
  }
}

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
  const configured = String(callbackUrl || siteUrl || '').trim();
  if (!configured) {
    if (req && req.get('host')) {
      return `${req.protocol}://${req.get('host')}/auth/callback`;
    }

    const localFallback = `http://localhost:${PORT}/auth/callback`;
    console.warn(`CALLBACK_URL/SITE_URL not set. Falling back to ${localFallback}`);
    return localFallback;
  }

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    if (req && req.get('host')) {
      return `${req.protocol}://${req.get('host')}/auth/callback`;
    }
    throw new Error('CALLBACK_URL or SITE_URL must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('CALLBACK_URL or SITE_URL must use http or https.');
  }

  return `${parsed.protocol}//${parsed.host}/auth/callback`;
}

function ensureSessionCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS year_planner_templates (
      year_level VARCHAR(50) PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      planner JSONB NOT NULL,
      imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_lesson_notes (
      id SERIAL PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      lesson_note_title VARCHAR(255) NOT NULL,
      year_level VARCHAR(50) NOT NULL,
      strand_number INTEGER,
      strand_title VARCHAR(255),
      source_file_name VARCHAR(255),
      source_file_mime VARCHAR(120),
      source_file_size INTEGER,
      source_file_data BYTEA,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_worksheets (
      id SERIAL PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      worksheet_title VARCHAR(255) NOT NULL,
      year_level VARCHAR(50) NOT NULL,
      worksheet_category VARCHAR(120),
      strand_number INTEGER,
      strand_title VARCHAR(255),
      lesson_note_id INTEGER REFERENCES uploaded_lesson_notes(id) ON DELETE SET NULL,
      file_name VARCHAR(255) NOT NULL,
      file_mime VARCHAR(120),
      file_size INTEGER,
      file_data BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE uploaded_worksheets
    ADD COLUMN IF NOT EXISTS worksheet_category VARCHAR(120);
  `);

  await pool.query(`
    ALTER TABLE uploaded_worksheets
    ADD COLUMN IF NOT EXISTS strand_number INTEGER;
  `);

  await pool.query(`
    ALTER TABLE uploaded_worksheets
    ADD COLUMN IF NOT EXISTS strand_title VARCHAR(255);
  `);

  await pool.query(`
    ALTER TABLE uploaded_worksheets
    ADD COLUMN IF NOT EXISTS lesson_note_id INTEGER REFERENCES uploaded_lesson_notes(id) ON DELETE SET NULL;
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
  secret: sessionSecret,
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
  callbackURL: buildOAuthCallbackUrl(),
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
  if (typeof returnTo === 'string' && /^\/(?!\/)/.test(returnTo)) {
    req.session.returnTo = returnTo;
  }
  ensureSessionCsrfToken(req);
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: true,
    callbackURL: buildOAuthCallbackUrl(),
    hd: allowedEmailDomains.size === 1 ? [...allowedEmailDomains][0] : undefined,
  })(req, res, next);
});

// Google callback
app.get('/auth/callback',
  (req, res, next) => {
    passport.authenticate('google', {
      failureRedirect: '/?error=auth_failed',
      callbackURL: buildOAuthCallbackUrl(),
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

// Logout requires POST + CSRF token.
app.post('/auth/logout', requireAuth, (req, res) => {
  const expectedToken = ensureSessionCsrfToken(req);
  const providedToken = String(req.get('x-csrf-token') || req.body?.csrfToken || '').trim();

  if (!providedToken || providedToken !== expectedToken) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }

  req.logout((logoutError) => {
    if (logoutError) {
      return res.status(500).json({ error: 'Failed to log out.' });
    }

    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });
});

app.get('/auth/logout', (req, res) => {
  res.status(405).json({ error: 'Use POST /auth/logout' });
});

// Get current logged-in user (used by frontend)
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    const { id, name, email, picture } = req.user;
    res.json({ id, name, email, picture, csrfToken: ensureSessionCsrfToken(req) });
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

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractDocxTableRows(documentXml) {
  const tableMatch = String(documentXml || '').match(/<w:tbl(?:\s|>)[\s\S]*?<\/w:tbl>/i);
  if (!tableMatch) return [];

  const tableXml = tableMatch[0];
  const rowMatches = [...tableXml.matchAll(/<w:tr(?:\s|>)[\s\S]*?<\/w:tr>/gi)];

  return rowMatches.map((rowMatch) => {
    const rowXml = rowMatch[0];
    const cellMatches = [...rowXml.matchAll(/<w:tc(?:\s|>)[\s\S]*?<\/w:tc>/gi)];

    return cellMatches.map((cellMatch) => {
      const cellXml = cellMatch[0];
      const textMatches = [...cellXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)];
      const text = textMatches.length
        ? textMatches.map(match => match[1]).join(' ')
        : cellXml;

      return decodeXmlEntities(text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    });
  });
}

  function extractDocxParagraphTexts(documentXml) {
    const paragraphMatches = [...String(documentXml || '').matchAll(/<w:p(?:\s|>)[\s\S]*?<\/w:p>/gi)];

    return paragraphMatches.map((paragraphMatch) => {
      const paragraphXml = paragraphMatch[0];
      const textMatches = [...paragraphXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)];
      const text = textMatches.map(match => match[1]).join(' ');

      return decodeXmlEntities(text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }).filter(Boolean);
  }

  function deriveTopicTitle(paragraphs) {
    const heading = paragraphs.find(paragraph => /^Unit Standard Topic:\s*(.+)$/i.test(paragraph));
    if (heading) {
      return heading.replace(/^Unit Standard Topic:\s*/i, '').trim();
    }

    return paragraphs[0] || 'Imported Topic';
  }

  function deriveYearLevelFromParagraphs(paragraphs, fallbackYearLevel = '') {
    const text = paragraphs.join(' ');
    const match = text.match(/\bYear\s*(\d{1,2})\b/i);
    return (fallbackYearLevel || (match ? `Year ${match[1]}` : '') || '').trim();
  }

  async function parseTopicDocx(buffer, fallbackYearLevel = '') {
    const zip = await JSZip.loadAsync(buffer);
    const documentEntry = zip.file('word/document.xml');
    if (!documentEntry) {
      throw new Error('DOCX file is missing document.xml');
    }

    const documentXml = await documentEntry.async('string');
    const paragraphs = extractDocxParagraphTexts(documentXml);

    if (!paragraphs.length) {
      throw new Error('The DOCX file does not contain readable topic text.');
    }

    const topicName = deriveTopicTitle(paragraphs);
    const yearLevel = deriveYearLevelFromParagraphs(paragraphs, fallbackYearLevel);
    const titleIndex = paragraphs.findIndex(paragraph => /^Unit Standard Topic:\s*(.+)$/i.test(paragraph));
    const contentParagraphs = paragraphs.slice(titleIndex >= 0 ? titleIndex + 1 : 1);
    const sectionPattern = /^(?:Week|Weeks|Sub[-\s]*Topic|Subtopic)\s*(?:\d+(?:\s*[-–]\s*\d+)?)?\b\s*(.*)$/i;
    const sections = [];
    const introLines = [];
    let currentSection = null;

    for (const paragraph of contentParagraphs) {
      const sectionMatch = paragraph.match(sectionPattern);
      if (sectionMatch) {
        if (currentSection) {
          sections.push(currentSection);
        }

        currentSection = {
          name: paragraph.trim(),
          detailsLines: [],
        };
        continue;
      }

      if (!currentSection) {
        introLines.push(paragraph);
        continue;
      }

      currentSection.detailsLines.push(paragraph);
    }

    if (currentSection) {
      sections.push(currentSection);
    }

    const topicDetails = introLines.length
      ? introLines.join('\n')
      : `Imported from ${topicName}${yearLevel ? ` (${yearLevel})` : ''}.`;

    return {
      topicName,
      yearLevel,
      topicDetails,
      subTopics: sections.map(section => ({
        name: section.name,
        details: section.detailsLines.join('\n').trim(),
      })).filter(section => section.name),
    };
  }

async function upsertYearPlannerTemplate(yearLevel, fileName, planner, importedBy) {
  const result = await pool.query(
    `INSERT INTO year_planner_templates (year_level, file_name, planner, imported_by, imported_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (year_level)
     DO UPDATE SET file_name = EXCLUDED.file_name,
                   planner = EXCLUDED.planner,
                   imported_by = EXCLUDED.imported_by,
                   imported_at = CURRENT_TIMESTAMP
     RETURNING year_level, file_name, planner, imported_at`,
    [yearLevel, fileName, planner, importedBy || null]
  );

  return result.rows[0];
}

async function getYearPlannerTemplates() {
  const result = await pool.query(
    `SELECT year_level, file_name, planner, imported_at
     FROM year_planner_templates
     ORDER BY year_level`
  );

  return result.rows;
}

async function parsePlannerDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) {
    throw new Error('DOCX file is missing document.xml');
  }

  const documentXml = await documentEntry.async('string');
  const tableRows = extractDocxTableRows(documentXml);

  if (tableRows.length < 2) {
    throw new Error('Planner table was not found in the DOCX file.');
  }

  const headerRow = tableRows[0];
  if (!headerRow.length || !String(headerRow[0] || '').toLowerCase().includes('term')) {
    throw new Error('The first table in the DOCX does not look like a planner table.');
  }

  const rows = tableRows.slice(1).map((cells) => ({
    term: cells[0] || '',
    weeks: cells[1] || '',
    unitStandard: cells[2] || '',
    unitCode: cells[3] || '',
    level: cells[4] || '',
    version: cells[5] || '',
    credits: cells[6] || '',
  })).filter(row => Object.values(row).some(Boolean));

  return {
    headerRow,
    rows,
  };
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

  // Keep only one block per term number (the first parsed block for that term).
  const uniqueTerms = [];
  const seenTerms = new Set();
  for (const t of terms) {
    if (seenTerms.has(t.term)) continue;
    seenTerms.add(t.term);
    uniqueTerms.push(t);
  }

  return { year: targetYear, terms: uniqueTerms };
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

app.get('/api/planning/year-planner-templates', async (req, res) => {
  try {
    const templates = await getYearPlannerTemplates();
    res.json({ templates });
  } catch (error) {
    console.error('Year planner templates fetch error:', error);
    res.status(500).json({ error: 'Failed to load planner templates.' });
  }
});

app.post('/api/planning/import-year-planner', requireAuth, requireAdminOrLead, uploadPlannerDocx.single('planner_docx'), async (req, res) => {
  try {
    const yearLevel = String(req.body.year_level || '').trim();
    if (!yearLevel) {
      return res.status(400).json({ error: 'Year level is required.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Please choose a DOCX file to upload.' });
    }

    const planner = await parsePlannerDocx(req.file.buffer);
    const stored = await upsertYearPlannerTemplate(yearLevel, req.file.originalname, planner, req.user.id);

    res.json({
      success: true,
      yearLevel,
      fileName: req.file.originalname,
      importedAt: stored.imported_at,
      planner: stored.planner,
    });
  } catch (error) {
    console.error('Year planner import error:', error);
    res.status(400).json({ error: error.message || 'Failed to import planner document.' });
  }
});

app.post('/api/topics/import-docx', requireAuth, requireAdminOrLead, uploadTopicsDocx.single('topic_docx'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose a DOCX file to upload.' });
    }

    const fallbackYearLevel = String(req.body.year_level || '').trim();
    const parsed = await parseTopicDocx(req.file.buffer, fallbackYearLevel);

    res.json({
      success: true,
      fileName: req.file.originalname || 'topic-import.docx',
      ...parsed,
    });
  } catch (error) {
    console.error('Topic DOCX import error:', error);
    res.status(400).json({ error: error.message || 'Failed to import topic document.' });
  }
});

app.post('/api/worksheets/upload', requireAuth, requireAdminOrLead, uploadWorksheetFiles, async (req, res) => {
  try {
    const files = [
      ...((req.files && req.files.worksheet_files) || []),
      ...((req.files && req.files.worksheet_file) || []),
    ];

    if (!files.length) {
      return res.status(400).json({ error: 'Please choose one or more worksheet files to upload.' });
    }

    const worksheetTitleInput = String(req.body.worksheet_title || '').trim();
    const worksheetCategoryInput = String(req.body.worksheet_category || '').trim();
    const yearLevel = String(req.body.year_level || '').trim();
    const splitDocxList = ['1', 'true', 'on', 'yes'].includes(String(req.body.split_docx_list || '').toLowerCase());

    if (!yearLevel) {
      return res.status(400).json({ error: 'Year level is required.' });
    }

    const uploadedRows = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const lowerName = String(file.originalname || '').toLowerCase();

      if (splitDocxList && files.length === 1 && lowerName.endsWith('.docx')) {
        const parsedStructure = await extractWorksheetStructureFromDocx(file.buffer);
        const parsedWorksheets = (parsedStructure.worksheets || []).filter(item => String(item.worksheetTitle || '').trim());

        if (parsedWorksheets.length) {
          const uniqueNotes = [];
          const noteSeenKeys = new Set();
          for (const note of (parsedStructure.lessonNotes || [])) {
            const key = lessonNoteSyncKey(note);
            if (!noteSeenKeys.has(key)) {
              noteSeenKeys.add(key);
              uniqueNotes.push(note);
            }
          }

          const lessonNoteIdByStrand = new Map();
          const lessonNoteIdByStrandTitle = new Map();
          const keptLessonNoteIds = new Set();
          const existingLessonNotesResult = await pool.query(
            `SELECT id, lesson_note_title, strand_number, strand_title
             FROM uploaded_lesson_notes
             WHERE year_level = $1
               AND source_file_name = $2`,
            [yearLevel, file.originalname]
          );
          const existingLessonNotes = existingLessonNotesResult.rows;
          const existingLessonNoteByKey = new Map(existingLessonNotes.map(note => [lessonNoteSyncKey(note), note]));

          for (const note of uniqueNotes) {
            const key = lessonNoteSyncKey(note);
            const matched = existingLessonNoteByKey.get(key);
            let syncedNote;

            if (matched) {
              const updated = await pool.query(
                `UPDATE uploaded_lesson_notes
                 SET created_by = $2,
                     lesson_note_title = $3,
                     strand_number = $4,
                     strand_title = $5,
                     source_file_mime = $6,
                     source_file_size = $7,
                     source_file_data = $8
                 WHERE id = $1
                 RETURNING id, strand_number`,
                [
                  matched.id,
                  req.user.id,
                  note.lessonNoteTitle,
                  Number.isInteger(note.strandNumber) ? note.strandNumber : null,
                  note.strandTitle || null,
                  file.mimetype || null,
                  file.size || null,
                  file.buffer,
                ]
              );
              syncedNote = updated.rows[0];
            } else {
              const inserted = await pool.query(
                `INSERT INTO uploaded_lesson_notes (
                  created_by, lesson_note_title, year_level, strand_number, strand_title,
                  source_file_name, source_file_mime, source_file_size, source_file_data
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id, strand_number`,
                [
                  req.user.id,
                  note.lessonNoteTitle,
                  yearLevel,
                  Number.isInteger(note.strandNumber) ? note.strandNumber : null,
                  note.strandTitle || null,
                  file.originalname,
                  file.mimetype || null,
                  file.size || null,
                  file.buffer,
                ]
              );
              syncedNote = inserted.rows[0];
            }

            keptLessonNoteIds.add(syncedNote.id);
            if (syncedNote && Number.isInteger(syncedNote.strand_number)) {
              lessonNoteIdByStrand.set(syncedNote.strand_number, syncedNote.id);
            }
            if (syncedNote && syncedNote.strand_title) {
              lessonNoteIdByStrandTitle.set(normaliseSyncText(syncedNote.strand_title), syncedNote.id);
            }
          }

          for (const existingNote of existingLessonNotes) {
            if (!keptLessonNoteIds.has(existingNote.id)) {
              await pool.query('DELETE FROM uploaded_lesson_notes WHERE id = $1', [existingNote.id]);
            }
          }

          const uniqueWorksheets = [];
          const worksheetSeenKeys = new Set();
          for (const worksheet of parsedWorksheets) {
            const key = worksheetSyncKey(worksheet);
            if (!worksheetSeenKeys.has(key)) {
              worksheetSeenKeys.add(key);
              uniqueWorksheets.push(worksheet);
            }
          }

          const keptWorksheetIds = new Set();
          const existingWorksheetsResult = await pool.query(
            `SELECT id, worksheet_title, strand_number
             FROM uploaded_worksheets
             WHERE year_level = $1
               AND file_name = $2`,
            [yearLevel, file.originalname]
          );
          const existingWorksheets = existingWorksheetsResult.rows;
          const existingWorksheetByKey = new Map(existingWorksheets.map(row => [worksheetSyncKey(row), row]));

          for (const worksheetMeta of uniqueWorksheets) {
            const worksheetTitle = worksheetMeta.worksheetTitle;
            const strandNumber = Number.isInteger(worksheetMeta.strandNumber) ? worksheetMeta.strandNumber : null;
            const strandTitle = worksheetMeta.strandTitle || null;
            const linkedByNumber = strandNumber !== null && lessonNoteIdByStrand.has(strandNumber)
              ? lessonNoteIdByStrand.get(strandNumber)
              : null;
            const linkedByTitle = strandTitle && lessonNoteIdByStrandTitle.has(normaliseSyncText(strandTitle))
              ? lessonNoteIdByStrandTitle.get(normaliseSyncText(strandTitle))
              : null;
            const linkedLessonNoteId = linkedByNumber || linkedByTitle || null;
            const worksheetCategory = worksheetCategoryInput && worksheetCategoryInput !== 'Auto-detect'
              ? worksheetCategoryInput
              : inferWorksheetCategory(worksheetTitle);

            const key = worksheetSyncKey(worksheetMeta);
            const matched = existingWorksheetByKey.get(key);
            let syncedWorksheet;

            if (matched) {
              const updated = await pool.query(
                `UPDATE uploaded_worksheets
                 SET created_by = $2,
                     worksheet_title = $3,
                     worksheet_category = $4,
                     strand_number = $5,
                     strand_title = $6,
                     lesson_note_id = $7,
                     file_mime = $8,
                     file_size = $9,
                     file_data = $10
                 WHERE id = $1
                 RETURNING id, worksheet_title, year_level, worksheet_category, strand_number, strand_title, lesson_note_id,
                           file_name, file_mime, file_size, created_at`,
                [
                  matched.id,
                  req.user.id,
                  worksheetTitle,
                  worksheetCategory,
                  strandNumber,
                  strandTitle,
                  linkedLessonNoteId,
                  file.mimetype || null,
                  file.size || null,
                  file.buffer,
                ]
              );
              syncedWorksheet = updated.rows[0];
            } else {
              const inserted = await pool.query(
                `INSERT INTO uploaded_worksheets (
                  created_by, worksheet_title, year_level, worksheet_category, strand_number, strand_title,
                  lesson_note_id, file_name, file_mime, file_size, file_data
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id, worksheet_title, year_level, worksheet_category, strand_number, strand_title, lesson_note_id,
                          file_name, file_mime, file_size, created_at`,
                [
                  req.user.id,
                  worksheetTitle,
                  yearLevel,
                  worksheetCategory,
                  strandNumber,
                  strandTitle,
                  linkedLessonNoteId,
                  file.originalname,
                  file.mimetype || null,
                  file.size || null,
                  file.buffer,
                ]
              );
              syncedWorksheet = inserted.rows[0];
            }

            keptWorksheetIds.add(syncedWorksheet.id);
            uploadedRows.push(syncedWorksheet);
          }

          for (const existingWorksheet of existingWorksheets) {
            if (!keptWorksheetIds.has(existingWorksheet.id)) {
              await pool.query('DELETE FROM uploaded_worksheets WHERE id = $1', [existingWorksheet.id]);
            }
          }

          continue;
        }
      }

      const fallbackTitle = String(file.originalname || '').replace(/\.[^.]+$/, '');
      const worksheetTitle = files.length === 1 && worksheetTitleInput
        ? worksheetTitleInput
        : fallbackTitle;

      const worksheetCategory = worksheetCategoryInput && worksheetCategoryInput !== 'Auto-detect'
        ? worksheetCategoryInput
        : inferWorksheetCategory(`${worksheetTitle} ${file.originalname || ''}`);

      const existingWorksheetResult = await pool.query(
        `SELECT id
         FROM uploaded_worksheets
         WHERE year_level = $1
           AND worksheet_title = $2
           AND file_name = $3
         LIMIT 1`,
        [yearLevel, worksheetTitle, file.originalname]
      );

      let result;
      if (existingWorksheetResult.rows.length) {
        result = await pool.query(
          `UPDATE uploaded_worksheets
           SET created_by = $2,
               worksheet_category = $3,
               file_mime = $4,
               file_size = $5,
               file_data = $6
           WHERE id = $1
           RETURNING id, worksheet_title, year_level, worksheet_category, strand_number, strand_title, lesson_note_id,
                     file_name, file_mime, file_size, created_at`,
          [
            existingWorksheetResult.rows[0].id,
            req.user.id,
            worksheetCategory,
            file.mimetype || null,
            file.size || null,
            file.buffer,
          ]
        );
      } else {
        result = await pool.query(
          `INSERT INTO uploaded_worksheets (
            created_by, worksheet_title, year_level, worksheet_category, strand_number, strand_title,
            lesson_note_id, file_name, file_mime, file_size, file_data
          )
          VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5, $6, $7, $8)
          RETURNING id, worksheet_title, year_level, worksheet_category, strand_number, strand_title, lesson_note_id,
                    file_name, file_mime, file_size, created_at`,
          [
            req.user.id,
            worksheetTitle,
            yearLevel,
            worksheetCategory,
            file.originalname,
            file.mimetype || null,
            file.size || null,
            file.buffer,
          ]
        );
      }

      uploadedRows.push(result.rows[0]);
    }

    res.json({
      success: true,
      uploadedCount: uploadedRows.length,
      worksheets: uploadedRows,
      worksheet: uploadedRows[0],
    });
  } catch (error) {
    console.error('Worksheet upload error:', error);
    res.status(400).json({ error: error.message || 'Failed to upload worksheet.' });
  }
});

app.get('/api/worksheets', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.id, w.worksheet_title, w.year_level, w.worksheet_category, w.strand_number, w.strand_title,
              w.lesson_note_id, w.file_name, w.file_mime, w.file_size, w.created_at,
              ln.lesson_note_title
       FROM uploaded_worksheets w
       LEFT JOIN uploaded_lesson_notes ln ON ln.id = w.lesson_note_id
       ORDER BY w.created_at DESC, w.id DESC`
    );

    res.json({ worksheets: result.rows });
  } catch (error) {
    console.error('Worksheets fetch error:', error);
    res.status(500).json({ error: 'Failed to load worksheets.' });
  }
});

app.post('/api/lesson-notes/upload', requireAuth, requireAdminOrLead, uploadWorksheetFile.single('lesson_note_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose a lesson note file to upload.' });
    }

    const splitDocxLessonList = ['1', 'true', 'on', 'yes'].includes(String(req.body.split_docx_lesson_list || '').toLowerCase());
    const lessonNoteTitle = String(req.body.lesson_note_title || '').trim() || String(req.file.originalname || '').replace(/\.[^.]+$/, '');
    const yearLevel = String(req.body.year_level || '').trim();
    const strandNumberRaw = String(req.body.strand_number || '').trim();
    const strandNumber = strandNumberRaw ? Number.parseInt(strandNumberRaw, 10) : null;
    const strandTitle = String(req.body.strand_title || '').trim() || null;

    if (!yearLevel) {
      return res.status(400).json({ error: 'Year level is required.' });
    }

    if (!lessonNoteTitle) {
      return res.status(400).json({ error: 'Lesson note title is required.' });
    }

    if (splitDocxLessonList) {
      const lowerName = String(req.file.originalname || '').toLowerCase();
      if (!lowerName.endsWith('.docx')) {
        return res.status(400).json({ error: 'Lesson Note DOCX Split Mode only works with a single DOCX file.' });
      }

      const parsedStructure = await extractWorksheetStructureFromDocx(req.file.buffer);
      const parsedLessonNotes = parsedStructure.lessonNotes || [];

      if (!parsedLessonNotes.length) {
        return res.status(400).json({ error: 'No individual lesson notes were detected in this DOCX file.' });
      }

      const uniqueParsedLessonNotes = [];
      const seenKeys = new Set();
      for (const note of parsedLessonNotes) {
        const key = lessonNoteSyncKey(note);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          uniqueParsedLessonNotes.push(note);
        }
      }

      const existingResult = await pool.query(
        `SELECT id, lesson_note_title, strand_number, strand_title
         FROM uploaded_lesson_notes
         WHERE year_level = $1
           AND source_file_name = $2`,
        [yearLevel, req.file.originalname]
      );
      const existing = existingResult.rows;
      const existingByKey = new Map(existing.map(item => [lessonNoteSyncKey(item), item]));
      const keptIds = new Set();
      const syncedRows = [];

      for (const note of uniqueParsedLessonNotes) {
        const key = lessonNoteSyncKey(note);
        const matched = existingByKey.get(key);
        let synced;

        if (matched) {
          const updated = await pool.query(
            `UPDATE uploaded_lesson_notes
             SET created_by = $2,
                 lesson_note_title = $3,
                 strand_number = $4,
                 strand_title = $5,
                 source_file_mime = $6,
                 source_file_size = $7,
                 source_file_data = $8
             WHERE id = $1
             RETURNING id, lesson_note_title, year_level, strand_number, strand_title, source_file_name, created_at`,
            [
              matched.id,
              req.user.id,
              note.lessonNoteTitle,
              Number.isInteger(note.strandNumber) ? note.strandNumber : null,
              note.strandTitle || null,
              req.file.mimetype || null,
              req.file.size || null,
              req.file.buffer,
            ]
          );
          synced = updated.rows[0];
        } else {
          const inserted = await pool.query(
            `INSERT INTO uploaded_lesson_notes (
              created_by, lesson_note_title, year_level, strand_number, strand_title,
              source_file_name, source_file_mime, source_file_size, source_file_data
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, lesson_note_title, year_level, strand_number, strand_title, source_file_name, created_at`,
            [
              req.user.id,
              note.lessonNoteTitle,
              yearLevel,
              Number.isInteger(note.strandNumber) ? note.strandNumber : null,
              note.strandTitle || null,
              req.file.originalname,
              req.file.mimetype || null,
              req.file.size || null,
              req.file.buffer,
            ]
          );
          synced = inserted.rows[0];
        }

        keptIds.add(synced.id);
        syncedRows.push(synced);

        if (Number.isInteger(synced.strand_number)) {
          await pool.query(
            `UPDATE uploaded_worksheets
             SET lesson_note_id = $1
             WHERE year_level = $2
               AND strand_number = $3
               AND (lesson_note_id IS NULL OR file_name = $4)`,
            [synced.id, synced.year_level, synced.strand_number, req.file.originalname]
          );
        } else if (synced.strand_title) {
          await pool.query(
            `UPDATE uploaded_worksheets
             SET lesson_note_id = $1
             WHERE year_level = $2
               AND LOWER(COALESCE(strand_title, '')) = LOWER($3)
               AND (lesson_note_id IS NULL OR file_name = $4)`,
            [synced.id, synced.year_level, synced.strand_title, req.file.originalname]
          );
        }
      }

      for (const existingRow of existing) {
        if (!keptIds.has(existingRow.id)) {
          await pool.query('DELETE FROM uploaded_lesson_notes WHERE id = $1', [existingRow.id]);
        }
      }

      return res.json({
        success: true,
        uploadedCount: syncedRows.length,
        lessonNotes: syncedRows,
        lessonNote: syncedRows[0],
      });
    }

    const existingSingleResult = await pool.query(
      `SELECT id
       FROM uploaded_lesson_notes
       WHERE year_level = $1
         AND lesson_note_title = $2
         AND COALESCE(strand_number, -1) = COALESCE($3, -1)
         AND COALESCE(source_file_name, '') = COALESCE($4, '')
       LIMIT 1`,
      [
        yearLevel,
        lessonNoteTitle,
        Number.isInteger(strandNumber) ? strandNumber : null,
        req.file.originalname || null,
      ]
    );

    let result;
    if (existingSingleResult.rows.length) {
      result = await pool.query(
        `UPDATE uploaded_lesson_notes
         SET created_by = $2,
             strand_title = $3,
             source_file_mime = $4,
             source_file_size = $5,
             source_file_data = $6
         WHERE id = $1
         RETURNING id, lesson_note_title, year_level, strand_number, strand_title, source_file_name, created_at`,
        [
          existingSingleResult.rows[0].id,
          req.user.id,
          strandTitle,
          req.file.mimetype || null,
          req.file.size || null,
          req.file.buffer,
        ]
      );
    } else {
      result = await pool.query(
        `INSERT INTO uploaded_lesson_notes (
          created_by, lesson_note_title, year_level, strand_number, strand_title,
          source_file_name, source_file_mime, source_file_size, source_file_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, lesson_note_title, year_level, strand_number, strand_title, source_file_name, created_at`,
        [
          req.user.id,
          lessonNoteTitle,
          yearLevel,
          Number.isInteger(strandNumber) ? strandNumber : null,
          strandTitle,
          req.file.originalname,
          req.file.mimetype || null,
          req.file.size || null,
          req.file.buffer,
        ]
      );
    }

    res.json({ success: true, uploadedCount: 1, lessonNotes: result.rows, lessonNote: result.rows[0] });
  } catch (error) {
    console.error('Lesson note upload error:', error);
    res.status(400).json({ error: error.message || 'Failed to upload lesson note.' });
  }
});

app.delete('/api/worksheets/:id', requireAuth, requireAdminOrLead, async (req, res) => {
  try {
    const worksheetId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(worksheetId) || worksheetId <= 0) {
      return res.status(400).json({ error: 'Invalid worksheet ID.' });
    }

    const result = await pool.query(
      `DELETE FROM uploaded_worksheets
       WHERE id = $1
       RETURNING id, worksheet_title`,
      [worksheetId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Worksheet not found.' });
    }

    res.json({ success: true, worksheet: result.rows[0] });
  } catch (error) {
    console.error('Worksheet delete error:', error);
    res.status(500).json({ error: 'Failed to delete worksheet.' });
  }
});

app.delete('/api/lesson-notes/:id', requireAuth, requireAdminOrLead, async (req, res) => {
  try {
    const lessonNoteId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(lessonNoteId) || lessonNoteId <= 0) {
      return res.status(400).json({ error: 'Invalid lesson note ID.' });
    }

    const result = await pool.query(
      `DELETE FROM uploaded_lesson_notes
       WHERE id = $1
       RETURNING id, lesson_note_title`,
      [lessonNoteId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Lesson note not found.' });
    }

    res.json({ success: true, lessonNote: result.rows[0] });
  } catch (error) {
    console.error('Lesson note delete error:', error);
    res.status(500).json({ error: 'Failed to delete lesson note.' });
  }
});

app.get('/api/lesson-notes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ln.id, ln.lesson_note_title, ln.year_level, ln.strand_number, ln.strand_title,
              ln.source_file_name, ln.created_at,
              COUNT(w.id)::INTEGER AS linked_worksheet_count
       FROM uploaded_lesson_notes ln
       LEFT JOIN uploaded_worksheets w ON w.lesson_note_id = ln.id
       GROUP BY ln.id
       ORDER BY ln.created_at DESC, ln.id DESC`
    );

    res.json({ lessonNotes: result.rows });
  } catch (error) {
    console.error('Lesson notes fetch error:', error);
    res.status(500).json({ error: 'Failed to load lesson notes.' });
  }
});

app.get('/api/lesson-notes/:id/file', requireAuth, async (req, res) => {
  try {
    const lessonNoteId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(lessonNoteId) || lessonNoteId <= 0) {
      return res.status(400).json({ error: 'Invalid lesson note ID.' });
    }

    const result = await pool.query(
      `SELECT source_file_data, source_file_name, source_file_mime
       FROM uploaded_lesson_notes
       WHERE id = $1`,
      [lessonNoteId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Lesson note not found.' });
    }

    const row = result.rows[0];
    if (!row.source_file_data) {
      return res.status(404).json({ error: 'No lesson note file is stored for this record.' });
    }

    const mime = row.source_file_mime || 'application/octet-stream';
    const fileName = row.source_file_name || `lesson-note-${lessonNoteId}`;
    const download = String(req.query.download || '').toLowerCase() === '1';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`);
    res.send(row.source_file_data);
  } catch (error) {
    console.error('Lesson note file fetch error:', error);
    res.status(500).json({ error: 'Failed to load lesson note file.' });
  }
});

app.get('/api/worksheets/:id/file', requireAuth, async (req, res) => {
  try {
    const worksheetId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(worksheetId) || worksheetId <= 0) {
      return res.status(400).json({ error: 'Invalid worksheet ID.' });
    }

    const result = await pool.query(
      `SELECT file_data, file_name, file_mime
       FROM uploaded_worksheets
       WHERE id = $1`,
      [worksheetId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Worksheet not found.' });
    }

    const row = result.rows[0];
    const mime = row.file_mime || 'application/octet-stream';
    const fileName = row.file_name || `worksheet-${worksheetId}`;
    const download = String(req.query.download || '').toLowerCase() === '1';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`);
    res.send(row.file_data);
  } catch (error) {
    console.error('Worksheet file fetch error:', error);
    res.status(500).json({ error: 'Failed to load worksheet file.' });
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
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const normalizedActivityUrl = activity_url?.trim()
      ? normaliseHttpUrl(activity_url)
      : null;
    if (activity_url?.trim() && !normalizedActivityUrl) {
      return res.status(400).json({ error: 'Activity URL must be a valid http/https address.' });
    }

    const pdfData = req.file ? req.file.buffer : null;
    const pdfFilename = req.file ? req.file.originalname : null;
    const insertResult = await pool.query(
      `INSERT INTO activity_suggestions (submitter_name, submitter_email, activity_name, activity_url, reason, pdf_data, pdf_filename)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, submitted_at`,
      [name.trim(), email.trim(), activity_name.trim(), normalizedActivityUrl, reason?.trim() || null, pdfData, pdfFilename]
    );

    let emailNotificationSent = false;

    // Send notification email to all Admins and Lead Teachers
    try {
      const adminRes = await pool.query(
        `SELECT DISTINCT u.email, u.name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         WHERE ur.role IN ('Admin', 'Lead Teacher') AND u.email IS NOT NULL`
      );
      if (adminRes.rows.length && hasMailerConfig) {
        const bccList = adminRes.rows.map(r => String(r.email || '').trim()).filter(Boolean);
        const submittedAt = insertResult.rows[0].submitted_at;
        const dateStr = new Date(submittedAt).toISOString().slice(0, 10);
        const siteUrl = process.env.SITE_URL || 'https://tech-wworkshop.onrender.com';
        const safeName = escapeHtml(name.trim());
        const safeEmail = escapeHtml(email.trim());
        const safeActivityName = escapeHtml(activity_name.trim());
        const safePdfFilename = pdfFilename ? escapeHtml(pdfFilename) : null;
        const safeReason = reason?.trim() ? escapeHtml(reason.trim()) : '';
        const safeSiteUrl = escapeHtml(siteUrl);
        const safeSuggestionsUrl = `${siteUrl}/admin_suggestions.html`;
        const safeSuggestionsUrlEscaped = escapeHtml(safeSuggestionsUrl);
        const safeUrlCell = normalizedActivityUrl
          ? `<a href="${escapeHtml(normalizedActivityUrl)}" style="color:#1c74b9">${escapeHtml(normalizedActivityUrl)}</a>`
          : 'N/A';

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
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fafcff">Activity</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fafcff">${safeActivityName}</td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fff">Suggested By</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fff">${safeName}</td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fafcff">Email</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fafcff"><a href="mailto:${safeEmail}" style="color:#1c74b9">${safeEmail}</a></td></tr>
      <tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fff">URL</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fff">${safeUrlCell}</td></tr>
      ${safePdfFilename ? `<tr><td style="padding:9px 12px;border:1px solid #e0e8f0;font-weight:700;background:#fafcff">PDF</td><td style="padding:9px 12px;border:1px solid #e0e8f0;background:#fafcff">${safePdfFilename} <em style="color:#888">(download from Suggestions page)</em></td></tr>` : ''}
    </table>
    ${safeReason ? `
    <p style="font-weight:700;color:#1a2a3a;margin:18px 0 6px">Reason</p>
    <div style="background:#fff;border:1px solid #e0e8f0;border-radius:6px;padding:12px 14px;color:#444;font-size:14px">${safeReason}</div>` : ''}
    <div style="margin-top:24px">
      <a href="${safeSuggestionsUrlEscaped}" style="display:inline-block;background:#1c74b9;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:700;font-size:14px">Open Suggestions List</a>
    </div>
    <p style="margin:14px 0 0;font-size:12px;color:#888">Direct link: <a href="${safeSuggestionsUrlEscaped}" style="color:#1c74b9">${safeSuggestionsUrlEscaped}</a></p>
  </div>
</div>`;

        await mailer.sendMail({
          from: `"Workshop Hub" <${process.env.EMAIL_USER}>`,
          to: process.env.EMAIL_USER,
          bcc: bccList,
          subject: `[Activity Suggestion] ${activity_name.trim()}`,
          html: htmlBody
        });
        emailNotificationSent = true;
      }
    } catch (emailErr) {
      // Don't fail the request if email fails — just log it
      console.error('Email notification failed:', emailErr.message);
    }

    res.json({ success: true, emailNotificationSent });
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
