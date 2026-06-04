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

function setStatus(alertId, type, message) {
  const alert = document.getElementById(alertId);
  if (!alert) return;
  alert.dataset.type = type;
  alert.textContent = message;
  alert.style.display = message ? 'block' : 'none';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const topicsStore = {
  topics: [],
  subTopics: [],
};

function generateId() {
  return 'topic_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function renderTopics() {
  const container = document.getElementById('topicsDisplay');
  if (!topicsStore.topics.length) {
    container.innerHTML = '<p style="color:#888;font-style:italic;">No topics added yet.</p>';
    return;
  }

  const html = topicsStore.topics.map(topic => `
    <div class="topics-item">
      <div class="topics-item-header">
        <strong>ID:</strong> ${esc(topic.id)}<br />
        <strong>Content:</strong> ${esc(topic.details)}
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteTopic('${esc(topic.id)}')">Delete</button>
    </div>
  `).join('');

  container.innerHTML = html;
}

function renderSubTopics() {
  const container = document.getElementById('subTopicsDisplay');
  if (!topicsStore.subTopics.length) {
    container.innerHTML = '<p style="color:#888;font-style:italic;">No sub-topics added yet.</p>';
    return;
  }

  const html = topicsStore.subTopics.map(st => `
    <div class="topics-item">
      <div class="topics-item-header">
        <strong>Sub-Topic ID:</strong> ${esc(st.id)}<br />
        <strong>Parent ID:</strong> ${esc(st.parentId)}<br />
        <strong>Content:</strong> ${esc(st.details)}
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteSubTopic('${esc(st.id)}')">Delete</button>
    </div>
  `).join('');

  container.innerHTML = html;
}

function deleteTopic(topicId) {
  topicsStore.topics = topicsStore.topics.filter(t => t.id !== topicId);
  topicsStore.subTopics = topicsStore.subTopics.filter(st => st.parentId !== topicId);
  renderTopics();
  renderSubTopics();
  setStatus('topicAlert', 'success', 'Topic deleted.');
}

function deleteSubTopic(subTopicId) {
  topicsStore.subTopics = topicsStore.subTopics.filter(st => st.id !== subTopicId);
  renderSubTopics();
  setStatus('subTopicAlert', 'success', 'Sub-topic deleted.');
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

document.getElementById('topicForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const details = document.getElementById('topicDetails').value.trim();

  if (!details) {
    setStatus('topicAlert', 'error', 'Topic details cannot be empty.');
    return;
  }

  const topicId = generateId();
  topicsStore.topics.push({
    id: topicId,
    details,
    createdAt: new Date().toISOString(),
  });

  document.getElementById('topicForm').reset();
  renderTopics();
  setStatus('topicAlert', 'success', `Topic added with ID: ${topicId}`);
});

document.getElementById('subTopicForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const parentId = document.getElementById('parentTopicId').value.trim();
  const details = document.getElementById('subTopicDetails').value.trim();

  if (!parentId) {
    setStatus('subTopicAlert', 'error', 'Parent Topic ID is required.');
    return;
  }

  if (!details) {
    setStatus('subTopicAlert', 'error', 'Sub-topic details cannot be empty.');
    return;
  }

  if (!topicsStore.topics.some(t => t.id === parentId)) {
    setStatus('subTopicAlert', 'error', `Parent topic ID "${parentId}" not found.`);
    return;
  }

  const subTopicId = generateId();
  topicsStore.subTopics.push({
    id: subTopicId,
    parentId,
    details,
    createdAt: new Date().toISOString(),
  });

  document.getElementById('subTopicForm').reset();
  renderSubTopics();
  setStatus('subTopicAlert', 'success', `Sub-topic added with ID: ${subTopicId}`);
});

wireDropdowns();
hydrateUserState();
renderTopics();
renderSubTopics();
