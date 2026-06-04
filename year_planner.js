function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3);
}

function getPrimaryRole(roles) {
  const priority = ['Admin', 'Lead Teacher', 'Teacher', 'Technician', 'Manager', 'Staff', 'Student'];
  for (const p of priority) {
    if (roles.some(r => r.role === p)) return p;
  }
  return 'Member';
}

function wireDropdowns() {
  document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
    const btn = dropdown.querySelector('.nav-dropdown-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
  });
}

function setStatus(type, message) {
  const status = document.getElementById('plannerStatus');
  status.dataset.type = type;
  status.textContent = message;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TERM_HEADER_ROWS = {
  1: {
    term: '1',
    weeks: '10',
    unitStandard: 'Construct free-hand drawings for use in furniture making',
    unitCode: '14995',
    level: '2',
    version: '3',
    credits: '4',
  },
  2: {
    term: '2 - 3',
    weeks: '20',
    unitStandard: 'Use and maintain hand tools for furniture making',
    unitCode: '2199',
    level: '2',
    version: '4',
    credits: '4',
  },
  4: {
    term: '4',
    weeks: '3',
    unitStandard: 'Set and operate a sanding machine to sand shaped furniture components',
    unitCode: '9786',
    level: '2',
    version: '4',
    credits: '2',
  },
};

const TERM_EXTRA_HEADER_ROWS = {
  2: [
    {
      term: '',
      weeks: '',
      unitStandard: 'Construct hand joints for furniture',
      unitCode: '18917',
      level: '2',
      version: '2',
      credits: '3',
    },
  ],
};

function renderPlanner(terms) {
  const body = document.getElementById('plannerBody');

  if (!Array.isArray(terms) || !terms.length) {
    body.innerHTML = '<tr><td colspan="7" class="planner-empty">No term date data could be parsed from the source page.</td></tr>';
    return;
  }

  const uniqueTerms = [];
  const seen = new Set();
  for (const term of terms) {
    if (seen.has(term.term)) continue;
    seen.add(term.term);
    uniqueTerms.push(term);
  }

  const rows = [];
  for (const term of uniqueTerms) {
    const weeks = Array.isArray(term.weeks) ? term.weeks : [];
    const header = TERM_HEADER_ROWS[term.term] || {
      term: String(term.term),
      weeks: String(weeks.length || ''),
      unitStandard: '',
      unitCode: '',
      level: '',
      version: '',
      credits: '',
    };

    rows.push(`
      <tr class="planner-term-header">
        <td>${esc(header.term)}</td>
        <td>${esc(header.weeks)}</td>
        <td>${esc(header.unitStandard)}</td>
        <td>${esc(header.unitCode)}</td>
        <td>${esc(header.level)}</td>
        <td>${esc(header.version)}</td>
        <td>${esc(header.credits)}</td>
      </tr>
    `);

    const extraHeaderRows = TERM_EXTRA_HEADER_ROWS[term.term] || [];
    for (const extra of extraHeaderRows) {
      rows.push(`
        <tr class="planner-term-header">
          <td>${esc(extra.term)}</td>
          <td>${esc(extra.weeks)}</td>
          <td>${esc(extra.unitStandard)}</td>
          <td>${esc(extra.unitCode)}</td>
          <td>${esc(extra.level)}</td>
          <td>${esc(extra.version)}</td>
          <td>${esc(extra.credits)}</td>
        </tr>
      `);
    }

    if (!weeks.length) {
      rows.push(`
        <tr>
          <td></td>
          <td>Week 1</td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
        </tr>
      `);
      continue;
    }

    weeks.forEach((week) => {
      rows.push(`
        <tr>
          <td></td>
          <td>Week ${esc(week.week)}<br /><span class="week-range">${esc(week.label)}</span></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
          <td contenteditable="true"></td>
        </tr>
      `);
    });
  }

  body.innerHTML = rows.join('');
}

async function loadPlanner() {
  setStatus('saving', 'Loading term dates...');

  try {
    const res = await fetch('/api/planning/term-dates', { cache: 'no-store' });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to load term dates.');
    }

    renderPlanner(data.terms);

    const refreshed = new Date(data.fetchedAt).toLocaleString();
    document.getElementById('plannerMeta').textContent = `Source year: ${data.year} | Last refreshed: ${refreshed}`;
    setStatus('success', 'Year planner updated from latest Ministry term dates.');
  } catch (error) {
    setStatus('error', error.message || 'Failed to load year planner data.');
  }
}

async function hydrateUserState() {
  try {
    const userRes = await fetch('/api/user');
    const user = await userRes.json();

    if (!user) return;

    const signInBtn = document.getElementById('googleSignIn');
    const chip = document.getElementById('userChip');
    if (signInBtn) signInBtn.style.display = 'none';
    if (chip) chip.style.display = 'inline-flex';

    const initialsEl = document.getElementById('userInitials');
    if (initialsEl) initialsEl.textContent = getInitials(user.name);

    try {
      const rolesRes = await fetch('/api/my-roles');
      const roles = await rolesRes.json();
      const roleEl = document.getElementById('userRoleBadge');
      if (roleEl) roleEl.textContent = getPrimaryRole(roles);

      if (roles.some(r => r.role === 'Admin' || r.role === 'Lead Teacher')) {
        const adminMenu = document.getElementById('adminMenu');
        if (adminMenu) adminMenu.style.display = 'flex';
      }
    } catch {
      // no-op
    }
  } catch {
    // no-op
  }
}

document.getElementById('refreshPlannerBtn').addEventListener('click', loadPlanner);
wireDropdowns();
hydrateUserState();
loadPlanner();
