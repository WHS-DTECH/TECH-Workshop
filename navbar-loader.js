async function loadGlobalNavbar() {
  try {
    const response = await fetch('/navbar.html');
    if (!response.ok) throw new Error('Failed to load navbar');
    const navbarHtml = await response.text();
    
    const headerElement = document.querySelector('header.top-strip');
    if (headerElement) {
      headerElement.outerHTML = navbarHtml;
    }
    
    // Re-wire dropdowns and user state after navbar is injected
    wireDropdowns();
    hydrateUserState();
  } catch (error) {
    console.error('Error loading global navbar:', error);
  }
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

// Load navbar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadGlobalNavbar);
} else {
  loadGlobalNavbar();
}
