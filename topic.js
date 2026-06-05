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
      const subTopicsForTopic = children
        .map(st => ({
          name: String(st.name || '').trim() || 'Untitled Sub-Topic',
          details: String(st.details || ''),
        }))
        .filter(st => st.name || st.details);

      return {
        type: topic.id,
        title: topic.name || 'Untitled Topic',
        subTopics: subTopicsForTopic,
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
    ...(group.subTopics || []).map(st => st.name),
    ...(group.subTopics || []).map(st => st.details),
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

function renderSubTopicNameList(subTopicNames) {
  return `
    <ul class="topic-tree">
      ${subTopicNames.map(name => `<li><span class="topic-item">${esc(name)}</span></li>`).join('')}
    </ul>
  `;
}

function parseBulletNodes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const root = [];
  const stack = [{ indent: -1, nodes: root }];
  let colonHeadingNode = null;

  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      // Treat blank lines as section breaks so the next bullet can restart at top level.
      stack.length = 1;
      colonHeadingNode = null;
      continue;
    }

    const match = rawLine.match(/^(\s*)(?:[-*•]|\d+[.)])?\s*(.+)$/);
    if (!match) continue;

    const indentRaw = match[1] || '';
    const content = (match[2] || '').trim();
    if (!content) continue;

    const spaces = indentRaw.replace(/\t/g, '  ').length;
    const indent = Math.floor(spaces / 2);
    const node = { text: content, children: [] };
    const isColonHeading = /:\s*$/.test(content);

    // Heuristic for pasted bullet text: if top-level lines are not indented,
    // treat lines ending with ':' as section headers and nest following peers.
    if (indent === 0) {
      if (isColonHeading) {
        root.push(node);
        colonHeadingNode = node;
        stack.length = 1;
        continue;
      }

      if (colonHeadingNode) {
        colonHeadingNode.children.push(node);
        continue;
      }
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    stack[stack.length - 1].nodes.push(node);
    stack.push({ indent, nodes: node.children });
  }

  return root;
}

function renderBulletNodes(nodes) {
  if (!nodes.length) return '';
  return `<ul class="topic-detail-bullets">${nodes.map(node => `
    <li>
      <span>${esc(node.text)}</span>
      ${node.children.length ? renderBulletNodes(node.children) : ''}
    </li>
  `).join('')}</ul>`;
}

function renderSubTopicDetails(details) {
  const nodes = parseBulletNodes(details);
  if (nodes.length) return renderBulletNodes(nodes);
  if (!details.trim()) return '';
  return `<div class="topic-detail-text">${esc(details).replace(/\n/g, '<br />')}</div>`;
}

function renderSubTopicList(subTopics) {
  return `
    <ul class="topic-tree">
      ${subTopics.map(st => `
        <li>
          <span class="topic-item">${esc(st.name)}</span>
          ${renderSubTopicDetails(st.details)}
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
      ${group.subTopics && group.subTopics.length
        ? renderSubTopicList(group.subTopics)
        : '<div class="topic-empty">No sub-topics added for this topic yet.</div>'}
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
