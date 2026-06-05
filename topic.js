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

const topicGroupsData = [
  {
    type: 'electronics',
    title: 'Electronics',
    plans: [
      {
        name: 'Electronics (Juniors)',
        streams: [
          { year: 'Juniors', items: ['Breadboard', 'Micro:bit'] },
          { year: 'Middle', items: ['Soldering', 'Printed Circuit Boards (PCB)', 'Arduino'] },
          { year: 'Senior', items: ['Assessment'] },
        ],
      },
    ],
  },
  {
    type: 'programming',
    title: 'Programming',
    plans: [
      {
        name: 'Programming (Middle)',
        streams: [
          { year: 'Juniors', items: ['Binary', 'Block Programming'] },
          { year: 'Middle', items: ['Tutorial Programming', 'Project Programming'] },
          { year: 'Senior', items: ['Assessment'] },
        ],
      },
    ],
  },
];

const topicState = {
  search: '',
  type: 'all',
};

function matchesSearch(group) {
  const q = topicState.search.trim().toLowerCase();
  if (!q) return true;

  const haystack = [
    group.title,
    group.type,
    ...group.plans.map(plan => plan.name),
    ...group.plans.flatMap(plan => plan.streams.map(stream => stream.year)),
    ...group.plans.flatMap(plan => plan.streams.flatMap(stream => stream.items)),
  ].join(' ').toLowerCase();

  return haystack.includes(q);
}

function matchesType(group) {
  if (topicState.type === 'all') return true;
  return group.type === topicState.type;
}

function renderTopicTree(streams) {
  return `
    <ul class="topic-tree">
      ${streams.map(stream => `
        <li>
          <span class="topic-stream">${stream.year}</span>
          <ul>
            ${stream.items.map(item => `<li><span class="topic-item">${item}</span></li>`).join('')}
          </ul>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderTopicGroups() {
  const container = document.getElementById('topicGroups');
  if (!container) return;

  const visibleGroups = topicGroupsData.filter(group => matchesType(group) && matchesSearch(group));

  if (!visibleGroups.length) {
    container.innerHTML = '<div class="topic-empty">No topics matched this filter. Try a different search or choose All topics.</div>';
    return;
  }

  container.innerHTML = visibleGroups.map(group => `
    <article class="topic-group">
      <h3>${group.title}</h3>
      ${group.plans.map(plan => `
        <div class="topic-plan-name">${plan.name}</div>
        ${renderTopicTree(plan.streams)}
      `).join('')}
    </article>
  `).join('');
}

function setActiveType(nextType) {
  topicState.type = nextType;

  document.querySelectorAll('.topic-type-btn').forEach(btn => {
    const isActive = btn.dataset.type === nextType;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  renderTopicGroups();
}

function wireTopicControls() {
  const searchInput = document.getElementById('topicSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      topicState.search = e.target.value || '';
      renderTopicGroups();
    });
  }

  document.querySelectorAll('.topic-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveType(btn.dataset.type || 'all'));
  });
}

wireDropdowns();
hydrateUserState();
wireTopicControls();
renderTopicGroups();
