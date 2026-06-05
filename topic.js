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

const TOPICS_STORAGE_KEY = 'whs_topics_data_v1';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadTopicGroupsData() {
  try {
    const raw = localStorage.getItem(TOPICS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
    const subTopics = Array.isArray(parsed.subTopics) ? parsed.subTopics : [];

    return topics.map(topic => {
      const children = subTopics.filter(st => st.parentId === topic.id);
      const streams = [];

      if (topic.details) {
        streams.push({
          year: 'Topic Overview',
          items: [topic.details],
        });
      }

      if (children.length) {
        streams.push({
          year: 'Sub-Topics',
          items: children.map(st => st.details),
        });
      }

      return {
        type: topic.id,
        title: topic.name || 'Untitled Topic',
        plans: [
          {
            name: topic.name || 'Untitled Topic',
            streams,
          },
        ],
      };
    });
  } catch {
    return [];
  }
}

let topicGroupsData = loadTopicGroupsData();

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
          <span class="topic-stream">${esc(stream.year)}</span>
          <ul>
            ${stream.items.map(item => `<li><span class="topic-item">${esc(item)}</span></li>`).join('')}
          </ul>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderTopicTypeButtons() {
  const toggle = document.getElementById('topicTypeToggle');
  if (!toggle) return;

  const buttons = ['<button class="topic-type-btn active" data-type="all" type="button" aria-pressed="true">All topics</button>'];

  for (const group of topicGroupsData) {
    buttons.push(`<button class="topic-type-btn" data-type="${esc(group.type)}" type="button" aria-pressed="false">${esc(group.title)}</button>`);
  }

  toggle.innerHTML = buttons.join('');
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
      <h3>${esc(group.title)}</h3>
      ${group.plans.map(plan => `
        <div class="topic-plan-name">${esc(plan.name)}</div>
        ${plan.streams.length ? renderTopicTree(plan.streams) : '<div class="topic-empty">No details added for this topic yet.</div>'}
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
topicGroupsData = loadTopicGroupsData();
renderTopicTypeButtons();
wireTopicControls();
renderTopicGroups();
