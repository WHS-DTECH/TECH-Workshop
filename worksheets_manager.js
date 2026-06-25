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

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const form = document.getElementById('worksheetUploadForm');
const uploadBtn = document.getElementById('uploadWorksheetBtn');
const alertBox = document.getElementById('worksheetUploadAlert');
const worksheetListBody = document.getElementById('worksheetListBody');
let canManageWorksheets = false;

function setAlert(type, message) {
  alertBox.dataset.type = type;
  alertBox.textContent = message;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Unknown';
  }
}

function renderWorksheetRows(items) {
  if (!Array.isArray(items) || !items.length) {
    worksheetListBody.innerHTML = '<tr><td colspan="6" class="planner-empty">No worksheets uploaded yet.</td></tr>';
    return;
  }

  worksheetListBody.innerHTML = items.map(item => {
    const reviewHref = `/api/worksheets/${encodeURIComponent(item.id)}/file`;
    return `
      <tr>
        <td>${esc(item.worksheet_title || 'Untitled')}</td>
        <td>${esc(item.year_level || 'Not set')}</td>
        <td>${esc(item.worksheet_category || 'Uncategorized')}</td>
        <td>${esc(item.file_name || 'Unknown file')}</td>
        <td>${esc(formatDate(item.created_at))}</td>
        <td>
          <a class="btn btn-secondary btn-sm" href="${reviewHref}" target="_blank" rel="noopener">Review</a>
        </td>
      </tr>
    `;
  }).join('');
}

async function loadWorksheets() {
  try {
    const res = await fetch('/api/worksheets', { cache: 'no-store' });
    const json = await res.json();

    if (!res.ok) {
      throw new Error(json.error || 'Failed to load worksheets.');
    }

    renderWorksheetRows(Array.isArray(json.worksheets) ? json.worksheets : []);
  } catch (error) {
    worksheetListBody.innerHTML = `<tr><td colspan="6" class="planner-empty">${esc(error.message || 'Failed to load worksheets.')}</td></tr>`;
  }
}

function validateForm() {
  const fileInput = document.getElementById('worksheetFile');
  const hasFiles = fileInput.files && fileInput.files.length > 0;
  uploadBtn.disabled = !canManageWorksheets || !hasFiles;
}

async function hydrateUserState() {
  try {
    const userRes = await fetch('/api/user');
    const user = await userRes.json();

    if (!user) {
      setAlert('warning', 'Sign in with your school Google account before uploading worksheets.');
      canManageWorksheets = false;
      validateForm();
      return;
    }

    const signInBtn = document.getElementById('googleSignIn');
    const chip = document.getElementById('userChip');
    if (signInBtn) signInBtn.style.display = 'none';
    if (chip) chip.style.display = 'inline-flex';

    const initialsEl = document.getElementById('userInitials');
    if (initialsEl) initialsEl.textContent = getInitials(user.name);

    let primaryRole = 'Member';
    try {
      const rolesRes = await fetch('/api/my-roles');
      const roles = await rolesRes.json();
      primaryRole = getPrimaryRole(roles);
      canManageWorksheets = roles.some(r => r.role === 'Admin' || r.role === 'Lead Teacher');

      const roleEl = document.getElementById('userRoleBadge');
      if (roleEl) roleEl.textContent = primaryRole;

      if (roles.some(r => r.role === 'Admin' || r.role === 'Lead Teacher')) {
        const adminMenu = document.getElementById('adminMenu');
        if (adminMenu) adminMenu.style.display = 'flex';
      }
    } catch {
      canManageWorksheets = false;
    }

    if (canManageWorksheets) {
      setAlert('ready', `Signed in as ${primaryRole}. Upload worksheet files and share review links.`);
    } else {
      setAlert('warning', `Signed in as ${primaryRole}, but worksheet uploading is limited to Admin and Lead Teacher accounts.`);
    }

    validateForm();
  } catch {
    setAlert('error', 'Unable to check sign-in status. Refresh and try again.');
    canManageWorksheets = false;
    validateForm();
  }
}

form.addEventListener('change', () => {
  const fileInput = document.getElementById('worksheetFile');
  const titleInput = document.getElementById('worksheetTitle');
  const file = fileInput.files && fileInput.files.length === 1 ? fileInput.files[0] : null;

  if (file && !titleInput.value.trim()) {
    titleInput.value = String(file.name || '').replace(/\.[^.]+$/, '');
  }

  validateForm();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const fileInput = document.getElementById('worksheetFile');
  const files = fileInput.files;
  const title = document.getElementById('worksheetTitle').value.trim();
  const splitMode = document.getElementById('splitDocxList').checked;

  if (!files || !files.length) {
    setAlert('error', 'Please choose at least one worksheet file.');
    return;
  }

  if (splitMode && files.length !== 1) {
    setAlert('error', 'DOCX Split Mode only works when uploading a single DOCX file.');
    return;
  }

  uploadBtn.disabled = true;
  setAlert('saving', 'Uploading worksheet file...');

  try {
    const data = new FormData(form);
    const response = await fetch('/api/worksheets/upload', {
      method: 'POST',
      body: data,
    });

    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || 'Failed to upload worksheet.');
    }

    const uploadedCount = Number(json.uploadedCount || 0);
    const uploadedSummary = uploadedCount > 1
      ? `Uploaded ${uploadedCount} worksheets for ${json.worksheet.year_level}.`
      : `Uploaded ${json.worksheet.file_name} for ${json.worksheet.year_level}.`;
    setAlert('success', uploadedSummary);
    form.reset();
    document.getElementById('worksheetYearLevel').value = 'Junior';
    document.getElementById('worksheetCategory').value = 'Auto-detect';
    await loadWorksheets();
  } catch (error) {
    setAlert('error', error.message || 'Failed to upload worksheet.');
  } finally {
    validateForm();
  }
});

wireDropdowns();
hydrateUserState();
loadWorksheets();
validateForm();