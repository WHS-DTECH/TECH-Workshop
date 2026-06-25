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
const lessonNoteForm = document.getElementById('lessonNoteUploadForm');
const uploadLessonNoteBtn = document.getElementById('uploadLessonNoteBtn');
const alertBox = document.getElementById('worksheetUploadAlert');
const worksheetListBody = document.getElementById('worksheetListBody');
const lessonNotesListBody = document.getElementById('lessonNotesListBody');
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
    worksheetListBody.innerHTML = '<tr><td colspan="9" class="planner-empty">No worksheets uploaded yet.</td></tr>';
    return;
  }

  worksheetListBody.innerHTML = items.map(item => {
    const reviewHref = `/api/worksheets/${encodeURIComponent(item.id)}/file`;
    const strandLabel = item.strand_number
      ? `Strand ${item.strand_number}${item.strand_title ? ` - ${item.strand_title}` : ''}`
      : (item.strand_title || '-');
    const linkedLessonHref = item.lesson_note_id ? `/api/lesson-notes/${encodeURIComponent(item.lesson_note_id)}/file` : null;
    const linkedLesson = item.lesson_note_title
      ? (linkedLessonHref
        ? `<a href="${linkedLessonHref}" target="_blank" rel="noopener">${esc(item.lesson_note_title)}</a>`
        : esc(item.lesson_note_title))
      : '-';
    return `
      <tr>
        <td>${esc(item.worksheet_title || 'Untitled')}</td>
        <td>${esc(item.year_level || 'Not set')}</td>
        <td>${esc(strandLabel)}</td>
        <td>${esc(item.worksheet_category || 'Uncategorized')}</td>
        <td>${linkedLesson}</td>
        <td>${esc(item.file_name || 'Unknown file')}</td>
        <td>${esc(formatDate(item.created_at))}</td>
        <td>
          <a class="btn btn-secondary btn-sm" href="${reviewHref}" target="_blank" rel="noopener">Review</a>
        </td>
        <td>
          ${canManageWorksheets
            ? `<button type="button" class="btn btn-danger btn-sm" data-delete-worksheet-id="${esc(item.id)}" data-delete-worksheet-title="${esc(item.worksheet_title || 'worksheet')}">Delete</button>`
            : '<span class="topic-empty">-</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

function renderLessonNoteRows(items) {
  if (!Array.isArray(items) || !items.length) {
    lessonNotesListBody.innerHTML = '<tr><td colspan="7" class="planner-empty">No lesson notes uploaded yet.</td></tr>';
    return;
  }

  lessonNotesListBody.innerHTML = items.map(item => {
    const strandLabel = item.strand_number
      ? `Strand ${item.strand_number}${item.strand_title ? ` - ${item.strand_title}` : ''}`
      : (item.strand_title || '-');
    const hasFile = Boolean(item.source_file_name);
    const reviewAction = hasFile
      ? `<a class="btn btn-secondary btn-sm" href="/api/lesson-notes/${encodeURIComponent(item.id)}/file" target="_blank" rel="noopener">Review</a>`
      : '<span class="topic-empty">No file</span>';

    return `
      <tr>
        <td>${esc(item.lesson_note_title || 'Untitled')}</td>
        <td>${esc(item.year_level || 'Not set')}</td>
        <td>${esc(strandLabel)}</td>
        <td>${esc(String(item.linked_worksheet_count ?? 0))}</td>
        <td>${esc(formatDate(item.created_at))}</td>
        <td>${reviewAction}</td>
        <td>
          ${canManageWorksheets
            ? `<button type="button" class="btn btn-danger btn-sm" data-delete-lesson-note-id="${esc(item.id)}" data-delete-lesson-note-title="${esc(item.lesson_note_title || 'lesson note')}">Delete</button>`
            : '<span class="topic-empty">-</span>'}
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
    worksheetListBody.innerHTML = `<tr><td colspan="9" class="planner-empty">${esc(error.message || 'Failed to load worksheets.')}</td></tr>`;
  }
}

async function loadLessonNotes() {
  try {
    const res = await fetch('/api/lesson-notes', { cache: 'no-store' });
    const json = await res.json();

    if (!res.ok) {
      throw new Error(json.error || 'Failed to load lesson notes.');
    }

    renderLessonNoteRows(Array.isArray(json.lessonNotes) ? json.lessonNotes : []);
  } catch (error) {
    lessonNotesListBody.innerHTML = `<tr><td colspan="7" class="planner-empty">${esc(error.message || 'Failed to load lesson notes.')}</td></tr>`;
  }
}

async function deleteWorksheetById(id, title) {
  if (!canManageWorksheets) {
    setAlert('warning', 'Only Admin and Lead Teacher accounts can delete worksheets.');
    return;
  }

  const confirmed = window.confirm(`Delete worksheet "${title}"? This action cannot be undone.`);
  if (!confirmed) return;

  setAlert('saving', 'Deleting worksheet...');

  try {
    const response = await fetch(`/api/worksheets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || 'Failed to delete worksheet.');
    }

    setAlert('success', `Deleted worksheet: ${json.worksheet.worksheet_title}.`);
    await loadWorksheets();
    await loadLessonNotes();
  } catch (error) {
    setAlert('error', error.message || 'Failed to delete worksheet.');
  }
}

async function deleteLessonNoteById(id, title) {
  if (!canManageWorksheets) {
    setAlert('warning', 'Only Admin and Lead Teacher accounts can delete lesson notes.');
    return;
  }

  const confirmed = window.confirm(`Delete lesson note "${title}"? Linked worksheets will remain but be unlinked from this note.`);
  if (!confirmed) return;

  setAlert('saving', 'Deleting lesson note...');

  try {
    const response = await fetch(`/api/lesson-notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || 'Failed to delete lesson note.');
    }

    setAlert('success', `Deleted lesson note: ${json.lessonNote.lesson_note_title}.`);
    await loadLessonNotes();
    await loadWorksheets();
  } catch (error) {
    setAlert('error', error.message || 'Failed to delete lesson note.');
  }
}

function validateForm() {
  const fileInput = document.getElementById('worksheetFile');
  const hasFiles = fileInput.files && fileInput.files.length > 0;
  uploadBtn.disabled = !canManageWorksheets || !hasFiles;

  const lessonNoteFileInput = document.getElementById('lessonNoteFile');
  const lessonNoteHasFile = lessonNoteFileInput.files && lessonNoteFileInput.files.length > 0;
  uploadLessonNoteBtn.disabled = !canManageWorksheets || !lessonNoteHasFile;
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
    await loadWorksheets();
    await loadLessonNotes();
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
    await loadLessonNotes();
  } catch (error) {
    setAlert('error', error.message || 'Failed to upload worksheet.');
  } finally {
    validateForm();
  }
});

lessonNoteForm.addEventListener('change', () => {
  const fileInput = document.getElementById('lessonNoteFile');
  const titleInput = document.getElementById('lessonNoteTitle');
  const file = fileInput.files && fileInput.files.length === 1 ? fileInput.files[0] : null;

  if (file && !titleInput.value.trim()) {
    titleInput.value = String(file.name || '').replace(/\.[^.]+$/, '');
  }

  validateForm();
});

lessonNoteForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const fileInput = document.getElementById('lessonNoteFile');
  const file = fileInput.files && fileInput.files[0];
  const splitMode = document.getElementById('splitDocxLessonList').checked;
  if (!file) {
    setAlert('error', 'Please choose a lesson note file.');
    return;
  }

  if (splitMode && !String(file.name || '').toLowerCase().endsWith('.docx')) {
    setAlert('error', 'Lesson Note DOCX Split Mode only works with a single DOCX file.');
    return;
  }

  uploadLessonNoteBtn.disabled = true;
  setAlert('saving', 'Uploading lesson note...');

  try {
    const data = new FormData(lessonNoteForm);
    const response = await fetch('/api/lesson-notes/upload', {
      method: 'POST',
      body: data,
    });

    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || 'Failed to upload lesson note.');
    }

    const uploadedCount = Number(json.uploadedCount || 0);
    if (uploadedCount > 1) {
      setAlert('success', `Uploaded ${uploadedCount} lesson notes from DOCX split mode.`);
    } else {
      setAlert('success', `Uploaded lesson note: ${json.lessonNote.lesson_note_title}.`);
    }
    lessonNoteForm.reset();
    document.getElementById('lessonNoteYearLevel').value = 'Junior';
    await loadLessonNotes();
    await loadWorksheets();
  } catch (error) {
    setAlert('error', error.message || 'Failed to upload lesson note.');
  } finally {
    validateForm();
  }
});

worksheetListBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-delete-worksheet-id]');
  if (!button) return;

  const worksheetId = button.getAttribute('data-delete-worksheet-id');
  const worksheetTitle = button.getAttribute('data-delete-worksheet-title') || 'worksheet';
  await deleteWorksheetById(worksheetId, worksheetTitle);
});

lessonNotesListBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-delete-lesson-note-id]');
  if (!button) return;

  const lessonNoteId = button.getAttribute('data-delete-lesson-note-id');
  const lessonNoteTitle = button.getAttribute('data-delete-lesson-note-title') || 'lesson note';
  await deleteLessonNoteById(lessonNoteId, lessonNoteTitle);
});

wireDropdowns();
hydrateUserState();
loadWorksheets();
loadLessonNotes();
validateForm();