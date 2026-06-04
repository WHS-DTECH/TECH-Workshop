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

function renderPlanner(terms) {
  const body = document.getElementById('plannerBody');

  if (!Array.isArray(terms) || !terms.length) {
    body.innerHTML = '<tr><td colspan="7" class="planner-empty">No term date data could be parsed from the source page.</td></tr>';
    return;
  }

  const rows = [];
  for (const term of terms) {
    const weeks = Array.isArray(term.weeks) ? term.weeks : [];
    const span = Math.max(1, weeks.length);

    if (!weeks.length) {
      rows.push(`
        <tr>
          <td>${esc(term.term)}</td>
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

    weeks.forEach((week, index) => {
      rows.push(`
        <tr>
          ${index === 0 ? `<td rowspan="${span}">${esc(term.term)}</td>` : ''}
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
