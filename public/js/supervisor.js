document.addEventListener('DOMContentLoaded', () => {
  // Navigation & User State elements
  const navUserBadgeItem = document.getElementById('navUserBadgeItem');
  const navUserName = document.getElementById('navUserName');
  const navUserPc = document.getElementById('navUserPc');
  const btnLogout = document.getElementById('btnLogout');
  const btnSwitchUser = document.getElementById('btnSwitchUser');

  // Containers
  const loginCardContainer = document.getElementById('loginCardContainer');
  const submissionContainer = document.getElementById('submissionContainer');
  const loginForm = document.getElementById('loginForm');
  const loginIdentifier = document.getElementById('loginIdentifier');
  const loginPassword = document.getElementById('loginPassword');
  const loginFeedback = document.getElementById('loginFeedback');
  const btnLogin = document.getElementById('btnLogin');

  // User Welcome Banner
  const userWelcomeName = document.getElementById('userWelcomeName');
  const userWelcomeDept = document.getElementById('userWelcomeDept');
  const userWelcomePc = document.getElementById('userWelcomePc');
  const userWelcomeMac = document.getElementById('userWelcomeMac');

  // Form Elements
  const locationSelect = document.getElementById('locationSelect');
  const locationBranchBadge = document.getElementById('locationBranchBadge');
  const displayPrinterModel = document.getElementById('displayPrinterModel');
  const displayPrinterSerial = document.getElementById('displayPrinterSerial');
  const displaySpoolerStatus = document.getElementById('displaySpoolerStatus');
  const displayWorkstationsSummary = document.getElementById('displayWorkstationsSummary');
  const printerDetailsCard = document.getElementById('printerDetailsCard');
  const departmentSelect = document.getElementById('departmentSelect');
  const submissionForm = document.getElementById('submissionForm');
  const submitBtn = document.getElementById('submitBtn');
  const printCountInput = document.getElementById('printCount');
  const supervisorNameInput = document.getElementById('supervisorName');
  const notesInput = document.getElementById('submissionNotes');
  const feedbackContainer = document.getElementById('feedbackContainer');
  const weekRangeDisplay = document.getElementById('weekRangeDisplay');
  const deadlineDisplay = document.getElementById('deadlineDisplay');
  const deadlineStatusBadge = document.getElementById('deadlineStatusBadge');
  const deptSubmissionNotice = document.getElementById('deptSubmissionNotice');
  const previousCountBadge = document.getElementById('previousCountBadge');
  const usageDeltaText = document.getElementById('usageDeltaText');

  // PC Selection & Dual Tracking elements
  const pcSelect = document.getElementById('pcSelect');
  const macTrackedBadge = document.getElementById('macTrackedBadge');
  const pcDetailsText = document.getElementById('pcDetailsText');

  // Photo & Context Menu elements
  const screenshotFileInput = document.getElementById('screenshotFile');
  const photoPreviewContainer = document.getElementById('photoPreviewContainer');
  const photoPreviewCard = document.getElementById('photoPreviewCard');
  const photoPreviewImgWrapper = document.getElementById('photoPreviewImgWrapper');
  const photoPreviewImg = document.getElementById('photoPreviewImg');
  const photoFileName = document.getElementById('photoFileName');
  const photoFileSize = document.getElementById('photoFileSize');
  const btnRemovePhoto = document.getElementById('btnRemovePhoto');
  const btnBadgeRemovePhoto = document.getElementById('btnBadgeRemovePhoto');
  const existingPhotoContainer = document.getElementById('existingPhotoContainer');
  const existingPhotoCard = document.getElementById('existingPhotoCard');
  const existingPhotoThumb = document.getElementById('existingPhotoThumb');
  const existingPhotoLink = document.getElementById('existingPhotoLink');
  const btnDeleteExistingPhoto = document.getElementById('btnDeleteExistingPhoto');

  // Image Context Menu Elements (Right-Click)
  const imageContextMenu = document.getElementById('imageContextMenu');
  const ctxDeletePhoto = document.getElementById('ctxDeletePhoto');
  const ctxChangePhoto = document.getElementById('ctxChangePhoto');
  const ctxViewPhoto = document.getElementById('ctxViewPhoto');

  // History Table
  const userRecentFactTableBody = document.getElementById('userRecentFactTableBody');
  const historyCountBadge = document.getElementById('historyCountBadge');

  let currentUser = null;
  let selectedPhotoBase64 = null;
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

  let currentWeekInfo = null;
  let allDepartments = [];
  let allLocations = [];
  let currentSubmissionsData = [];
  let previousCountForLocation = null;
  let currentActiveSubmissionId = null;

  // Helper: HTML escaping
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================
  // AUTHENTICATION LOGIC (USER MASTER)
  // ==========================================
  function initAuth() {
    loadWeekInfo();
    const savedUserJson = localStorage.getItem('maliban_user');
    if (savedUserJson) {
      try {
        currentUser = JSON.parse(savedUserJson);
        showAuthenticatedUI(currentUser);
        return;
      } catch (e) {
        localStorage.removeItem('maliban_user');
      }
    }
    showLoginUI();
  }

  function showLoginUI() {
    currentUser = null;
    loginCardContainer.classList.remove('d-none');
    submissionContainer.classList.add('d-none');
    navUserBadgeItem.classList.add('d-none');
    if (loginIdentifier) loginIdentifier.focus();
  }

  function showAuthenticatedUI(user) {
    currentUser = user;
    loginCardContainer.classList.add('d-none');
    submissionContainer.classList.remove('d-none');
    navUserBadgeItem.classList.remove('d-none');

    // Update navigation user badge
    if (navUserName) navUserName.textContent = user.name || 'User';
    if (navUserPc) navUserPc.textContent = user.pc_name || 'PC-NAME';

    // Update welcome banner
    if (userWelcomeName) userWelcomeName.textContent = `Welcome, ${user.name}`;
    if (userWelcomeDept) {
      userWelcomeDept.textContent = user.location || user.department_name || (user.dep_id ? `Dept ID: ${user.dep_id}` : 'All Plant Locations');
    }
    if (userWelcomePc) userWelcomePc.textContent = `PC: ${user.pc_name || 'Not assigned'}`;
    if (userWelcomeMac) userWelcomeMac.textContent = `MAC: ${user.mac_address || 'N/A'}`;

    // Pre-fill supervisor name
    if (supervisorNameInput) {
      supervisorNameInput.value = user.name || '';
    }

    // Load data and auto-select user location
    loadWeekInfo();
    Promise.all([loadLocations(), loadDepartments()]).then(() => {
      autoSelectUserLocation(user);
    });
  }

  // Handle Login Submission
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = loginIdentifier.value.trim();
      const password = loginPassword.value.trim();

      if (!identifier || !password) {
        showLoginFeedback('danger', 'Please enter your User/PC Name and Password.');
        return;
      }

      btnLogin.disabled = true;
      btnLogin.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Authenticating...';

      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Authentication failed');
        }

        // Save session
        localStorage.setItem('maliban_user', JSON.stringify(data.user));
        loginPassword.value = '';
        loginFeedback.innerHTML = '';
        showAuthenticatedUI(data.user);

      } catch (err) {
        showLoginFeedback('danger', err.message);
      } finally {
        btnLogin.disabled = false;
        btnLogin.innerHTML = '<i class="bi bi-box-arrow-in-right me-2"></i> Log In to Portal';
      }
    });
  }

  // Quick Login Buttons
  document.querySelectorAll('.btn-quick-login').forEach(btn => {
    btn.addEventListener('click', () => {
      const user = btn.getAttribute('data-user');
      const pass = btn.getAttribute('data-pass');
      if (loginIdentifier) loginIdentifier.value = user;
      if (loginPassword) loginPassword.value = pass;
      if (loginForm) loginForm.dispatchEvent(new Event('submit'));
    });
  });

  // Logout Handlers
  function handleLogout() {
    localStorage.removeItem('maliban_user');
    showLoginUI();
  }

  if (btnLogout) btnLogout.addEventListener('click', handleLogout);
  if (btnSwitchUser) btnSwitchUser.addEventListener('click', handleLogout);

  function showLoginFeedback(type, message) {
    loginFeedback.innerHTML = `
      <div class="alert alert-${type} alert-dismissible fade show" role="alert">
        <i class="bi bi-exclamation-triangle-fill me-2"></i> ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
      </div>
    `;
  }

  // ==========================================
  // PHOTO UPLOAD VALIDATION & RIGHT-CLICK MENU
  // ==========================================
  if (screenshotFileInput) {
    screenshotFileInput.addEventListener('change', () => {
      const file = screenshotFileInput.files[0];
      if (!file) {
        clearPhotoSelection();
        return;
      }

      const validTypes = ['image/png', 'image/jpeg', 'image/jpg'];
      const validExts = /\.(png|jpe?g)$/i;
      if (!validTypes.includes(file.type.toLowerCase()) && !validExts.test(file.name)) {
        alert('Invalid file format! Only PNG and JPG/JPEG photos are allowed.');
        clearPhotoSelection();
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        alert(`File is too large (${(file.size / (1024 * 1024)).toFixed(2)} MB)! Maximum allowed file size is 5 MB.`);
        clearPhotoSelection();
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        selectedPhotoBase64 = e.target.result;
        photoPreviewImg.src = selectedPhotoBase64;
        photoFileName.textContent = file.name;
        photoFileSize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
        photoPreviewContainer.classList.remove('d-none');
      };
      reader.readAsDataURL(file);
    });

    if (btnRemovePhoto) btnRemovePhoto.addEventListener('click', clearPhotoSelection);
    if (btnBadgeRemovePhoto) btnBadgeRemovePhoto.addEventListener('click', clearPhotoSelection);
  }

  function clearPhotoSelection() {
    selectedPhotoBase64 = null;
    if (screenshotFileInput) screenshotFileInput.value = '';
    if (photoPreviewContainer) photoPreviewContainer.classList.add('d-none');
    if (photoPreviewImg) photoPreviewImg.src = '';
  }

  // Right-Click Context Menu Support for Images
  function openImageContextMenu(e, viewUrl, isExisting) {
    if (!imageContextMenu) return;
    e.preventDefault();
    e.stopPropagation();

    // Position menu near cursor
    imageContextMenu.style.display = 'block';
    imageContextMenu.style.left = `${e.pageX}px`;
    imageContextMenu.style.top = `${e.pageY}px`;

    // Configure Context Menu Actions
    if (ctxViewPhoto) {
      ctxViewPhoto.href = viewUrl || '#';
      ctxViewPhoto.style.display = viewUrl ? 'block' : 'none';
    }

    ctxDeletePhoto.onclick = async (ev) => {
      ev.preventDefault();
      closeImageContextMenu();
      if (isExisting && currentActiveSubmissionId) {
        if (!confirm('Are you sure you want to delete this submitted counter photo from the database?')) return;
        try {
          const res = await fetch(`/api/submissions/${currentActiveSubmissionId}/screenshot`, { method: 'DELETE' });
          const json = await res.json();
          if (res.ok) {
            existingPhotoContainer.classList.add('d-none');
            alert('Counter photo removed successfully.');
            if (locationSelect) locationSelect.dispatchEvent(new Event('change'));
          } else {
            alert(json.error || 'Failed to delete photo.');
          }
        } catch (err) {
          alert('Error deleting photo: ' + err.message);
        }
      } else {
        clearPhotoSelection();
      }
    };

    ctxChangePhoto.onclick = (ev) => {
      ev.preventDefault();
      closeImageContextMenu();
      if (screenshotFileInput) screenshotFileInput.click();
    };
  }

  function closeImageContextMenu() {
    if (imageContextMenu) imageContextMenu.style.display = 'none';
  }

  document.addEventListener('click', () => {
    closeImageContextMenu();
  });

  // Attach context menu listeners
  [photoPreviewCard, photoPreviewImgWrapper, photoPreviewImg].forEach(el => {
    if (el) {
      el.addEventListener('contextmenu', (e) => {
        if (selectedPhotoBase64) {
          openImageContextMenu(e, selectedPhotoBase64, false);
        }
      });
    }
  });

  [existingPhotoCard, existingPhotoThumb].forEach(el => {
    if (el) {
      el.addEventListener('contextmenu', (e) => {
        const url = existingPhotoLink ? existingPhotoLink.href : null;
        if (url) {
          openImageContextMenu(e, url, true);
        }
      });
    }
  });

  // Delete existing photo button
  if (btnDeleteExistingPhoto) {
    btnDeleteExistingPhoto.addEventListener('click', async () => {
      if (!currentActiveSubmissionId) return;
      if (!confirm('Are you sure you want to remove the counter photo for this week?')) return;
      try {
        const res = await fetch(`/api/submissions/${currentActiveSubmissionId}/screenshot`, { method: 'DELETE' });
        const json = await res.json();
        if (res.ok) {
          existingPhotoContainer.classList.add('d-none');
          alert('Counter photo deleted.');
          if (locationSelect) locationSelect.dispatchEvent(new Event('change'));
        } else {
          alert(json.error || 'Failed to delete photo.');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  }

  // ==========================================
  // DATA LOADING & POPULATION
  // ==========================================
  async function loadWeekInfo() {
    try {
      const res = await fetch('/api/week-info');
      currentWeekInfo = await res.json();

      const startDate = new Date(currentWeekInfo.weekStartDate + 'T00:00:00');
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 4);

      const options = { month: 'short', day: 'numeric', year: 'numeric' };
      if (weekRangeDisplay) {
        weekRangeDisplay.textContent = `Week: ${startDate.toLocaleDateString(undefined, options)} - ${endDate.toLocaleDateString(undefined, options)}`;
      }

      const currentWeekSubtitle = document.getElementById('currentWeekSubtitle');
      if (currentWeekSubtitle && currentWeekInfo) {
        currentWeekSubtitle.textContent = `Active cycle starting Monday ${currentWeekInfo.weekStartDate}. Enforcement runs Mondays at 2:00 PM.`;
      }

      const deadlineDate = new Date(currentWeekInfo.deadline);
      if (deadlineDisplay) {
        deadlineDisplay.innerHTML = `<i class="bi bi-clock-fill me-1"></i> Monday, ${deadlineDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }

      if (deadlineStatusBadge) {
        if (currentWeekInfo.deadlinePassed) {
          deadlineStatusBadge.innerHTML = '<span class="badge bg-danger-subtle text-danger border border-danger-subtle"><i class="bi bi-exclamation-octagon-fill me-1"></i> Deadline Passed for this week</span>';
        } else {
          deadlineStatusBadge.innerHTML = '<span class="badge bg-success-subtle text-success border border-success-subtle"><i class="bi bi-hourglass-split me-1"></i> Reporting Active</span>';
        }
      }
    } catch (err) {
      console.error('Failed to load week info:', err);
    }
  }

  async function loadLocations() {
    if (!locationSelect) return;
    try {
      const res = await fetch('/api/locations');
      allLocations = await res.json();

      const group105 = [];
      const group11 = [];
      const groupKandawala = [];
      const groupOther = [];

      allLocations.forEach(loc => {
        const is105 = loc.branch === 'Little Lion 105' || loc.name.includes('105');
        const is11 = (loc.branch === 'Little Lion 11' || loc.name.includes('11')) && !is105;
        const isKandawala = loc.branch === 'Kandawala' || loc.name.toLowerCase().includes('kandawala');

        if (is105) group105.push(loc);
        else if (is11) group11.push(loc);
        else if (isKandawala) groupKandawala.push(loc);
        else groupOther.push(loc);
      });

      const buildOptions = (list) => list.map(loc => {
        const printerLabel = loc.printers && loc.printers.length 
          ? ` [${loc.printers[0].model} - ${loc.printers[0].serial_number}]` 
          : '';
        return `<option value="${escapeHtml(loc.name)}" data-branch="${escapeHtml(loc.branch || '')}">${escapeHtml(loc.name)}${escapeHtml(printerLabel)}</option>`;
      }).join('');

      let html = '<option value="" selected disabled>-- Select Plant / Floor Location --</option>';
      if (group105.length) {
        html += `<optgroup label="🏢 Little Lion 105">${buildOptions(group105)}</optgroup>`;
      }
      if (group11.length) {
        html += `<optgroup label="🏢 Little Lion 11">${buildOptions(group11)}</optgroup>`;
      }
      if (groupKandawala.length) {
        html += `<optgroup label="📍 Kandawala">${buildOptions(groupKandawala)}</optgroup>`;
      }
      if (groupOther.length) {
        html += `<optgroup label="🏭 Other Maliban Locations">${buildOptions(groupOther)}</optgroup>`;
      }

      locationSelect.innerHTML = html;
    } catch (err) {
      console.error('Failed to load locations:', err);
    }
  }

  async function loadDepartments() {
    try {
      const [deptRes, subRes] = await Promise.all([
        fetch('/api/departments'),
        fetch('/api/submissions/current-week')
      ]);

      allDepartments = await deptRes.json();
      const subData = await subRes.json();
      currentSubmissionsData = subData.departments || [];

      // Sync hidden departmentSelect
      if (departmentSelect) {
        departmentSelect.innerHTML = '<option value="" selected disabled>-- Department ID --</option>';
        allDepartments.forEach(dept => {
          const option = document.createElement('option');
          option.value = dept.id;
          option.textContent = dept.name;
          departmentSelect.appendChild(option);
        });
      }
    } catch (err) {
      console.error('Failed to load departments:', err);
      showFeedback('danger', 'Error loading department records. Please check server connection.');
    }
  }

  function autoSelectUserLocation(user) {
    if (!locationSelect) return;
    const targetLoc = (user.location || user.department_name || '').trim().toLowerCase();
    let matchedOption = null;

    for (let opt of locationSelect.options) {
      if (opt.value && opt.value.toLowerCase() === targetLoc) {
        matchedOption = opt.value;
        break;
      }
    }

    if (!matchedOption && targetLoc) {
      for (let opt of locationSelect.options) {
        if (opt.value && (opt.value.toLowerCase().includes(targetLoc) || targetLoc.includes(opt.value.toLowerCase()))) {
          matchedOption = opt.value;
          break;
        }
      }
    }

    if (matchedOption) {
      locationSelect.value = matchedOption;
    } else if (locationSelect.options.length > 1) {
      locationSelect.selectedIndex = 1;
    }

    locationSelect.dispatchEvent(new Event('change'));
  }

  // Load Recent Fact Table History for Department / Location
  async function loadRecentFactHistory(depId, locName) {
    if (!userRecentFactTableBody) return;
    try {
      let url = '/api/facts/printer-counts?limit=10';
      if (depId) url += `&dep_id=${depId}`;

      const res = await fetch(url);
      let records = await res.json();

      if (locName) {
        records = records.filter(r => 
          !depId || (r.dep_id === depId) || (r.location && r.location.toLowerCase() === locName.toLowerCase())
        );
      }

      historyCountBadge.textContent = `${records.length} Records`;

      if (records.length === 0) {
        userRecentFactTableBody.innerHTML = `<tr><td colspan="6" class="text-center py-3 text-muted">No print counts recorded yet for this location.</td></tr>`;
        return;
      }

      userRecentFactTableBody.innerHTML = records.map(r => `
        <tr>
          <td class="fw-semibold text-dark">${r.full_date || 'N/A'}</td>
          <td><span class="badge bg-light text-dark border">${r.department_name || r.location || 'N/A'}</span></td>
          <td>
            <div class="fw-semibold text-truncate" style="max-width: 180px;">${r.printer_model || 'Standard Printer'}</div>
            <div class="text-muted small font-monospace">${r.serial_number || ''}</div>
          </td>
          <td>
            <span class="badge bg-primary-subtle text-primary border border-primary-subtle px-2 py-1 fs-6 fw-bold">
              ${(r.print_count || 0).toLocaleString()}
            </span>
          </td>
          <td>
            <div class="fw-semibold">${r.user_name || 'Supervisor'}</div>
            <div class="text-muted small font-monospace">${r.pc_name || ''}</div>
          </td>
          <td>
            ${r.screenshot_path ? `
              <a href="${r.screenshot_path}" target="_blank" class="btn btn-sm btn-outline-info p-1 px-2" title="View Counter Photo">
                <i class="bi bi-image"></i>
              </a>
            ` : '<span class="text-muted small">-</span>'}
          </td>
        </tr>
      `).join('');
    } catch (err) {
      console.warn('Could not load fact history:', err.message);
    }
  }

  // Handle Location Change & Update Printer Hardware Card
  if (locationSelect) {
    locationSelect.addEventListener('change', async () => {
      const selectedLocName = locationSelect.value;
      if (!selectedLocName) return;

      const locData = allLocations.find(l => l.name === selectedLocName) || { name: selectedLocName, branch: '', printers: [] };
      const branchName = locData.branch || (selectedLocName.includes('105') ? 'Little Lion 105' : (selectedLocName.includes('11') ? 'Little Lion 11' : (selectedLocName.toLowerCase().includes('kandawala') ? 'Kandawala' : 'Maliban Plant')));

      // Update Division Badge
      if (locationBranchBadge) {
        locationBranchBadge.textContent = branchName;
        locationBranchBadge.className = branchName.includes('105') 
          ? 'badge bg-primary text-white' 
          : (branchName.includes('11') 
            ? 'badge bg-warning text-dark border' 
            : (branchName === 'Kandawala'
              ? 'badge bg-info text-dark border'
              : 'badge bg-secondary-subtle text-dark border'));
      }

      // Map to department
      let dept = allDepartments.find(d => d.name.toLowerCase() === selectedLocName.toLowerCase());
      if (!dept) {
        dept = allDepartments.find(d => selectedLocName.toLowerCase().includes(d.name.toLowerCase()) || d.name.toLowerCase().includes(selectedLocName.toLowerCase()));
      }

      const depId = dept ? dept.id : null;
      if (departmentSelect && depId) {
        departmentSelect.value = depId;
      }

      // Update Printer Hardware Info Card
      const printer = (locData.printers && locData.printers.length > 0) ? locData.printers[0] : null;
      if (displayPrinterModel) {
        displayPrinterModel.textContent = printer ? printer.model : 'Standard Network Printer';
      }
      if (displayPrinterSerial) {
        displayPrinterSerial.textContent = printer ? `S/N: ${printer.serial_number}` : 'S/N: Unspecified';
      }

      // Spooler Status
      const isBlocked = dept && dept.spooler_status === 'BLOCKED';
      if (displaySpoolerStatus) {
        displaySpoolerStatus.className = isBlocked ? 'badge bg-danger' : 'badge bg-success';
        displaySpoolerStatus.innerHTML = isBlocked 
          ? '<i class="bi bi-slash-circle me-1"></i> SPOOLER BLOCKED' 
          : '<i class="bi bi-check-circle me-1"></i> SPOOLER ACTIVE';
      }

      // Workstations
      const computers = (dept && dept.computers) ? dept.computers : [];
      if (displayWorkstationsSummary) {
        displayWorkstationsSummary.innerHTML = `<i class="bi bi-laptop me-1"></i> Workstations: <span class="fw-bold text-dark">${computers.length} Registered</span>`;
      }

      // Populate Reporting Workstations (Dual-Tracking by PC & MAC)
      if (pcSelect) {
        pcSelect.innerHTML = '<option value="" selected disabled>-- Select Reporting PC --</option>';

        if (computers.length > 0) {
          computers.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.pc_name;
            opt.textContent = `${c.pc_name} [${c.mac_address || 'MAC Tracked'}]`;
            opt.setAttribute('data-mac', c.mac_address || '');
            pcSelect.appendChild(opt);
          });
        }

        // Add user's own workstation if not listed
        if (currentUser && currentUser.pc_name) {
          const exists = computers.some(c => c.pc_name.toUpperCase() === currentUser.pc_name.toUpperCase());
          if (!exists) {
            const userOpt = document.createElement('option');
            userOpt.value = currentUser.pc_name;
            userOpt.textContent = `${currentUser.pc_name} [${currentUser.mac_address || 'Physical MAC'}] (My Registered PC)`;
            userOpt.setAttribute('data-mac', currentUser.mac_address || '');
            pcSelect.prepend(userOpt);
          }
        }

        // Auto-select user's PC
        if (currentUser && currentUser.pc_name) {
          pcSelect.value = currentUser.pc_name;
        } else if (pcSelect.options.length > 1) {
          pcSelect.selectedIndex = 1;
        }

        updateWorkstationTrackingBadge();
      }

      // Check current week submission for this department / location
      clearPhotoSelection();
      const subDept = currentSubmissionsData.find(d => 
        (depId && d.id === depId) ||
        (d.name && selectedLocName && d.name.toLowerCase() === selectedLocName.toLowerCase()) ||
        (d.submission && d.submission.location && selectedLocName && d.submission.location.toLowerCase() === selectedLocName.toLowerCase())
      );

      const btnDeleteExistingPhoto = document.getElementById('btnDeleteExistingPhoto');

      if (subDept && subDept.submission && subDept.submission.status === 'Submitted') {
        const sub = subDept.submission;
        currentActiveSubmissionId = sub.id;

        // Display submitted count and notes as READ-ONLY / LOCKED
        printCountInput.value = sub.print_count;
        printCountInput.disabled = true;
        printCountInput.readOnly = true;
        printCountInput.classList.add('bg-light');

        notesInput.value = sub.notes || '';
        notesInput.disabled = true;
        notesInput.readOnly = true;
        notesInput.classList.add('bg-light');

        if (supervisorNameInput) {
          supervisorNameInput.value = currentUser ? currentUser.name : (sub.supervisor_name || 'Supervisor');
          supervisorNameInput.disabled = true;
          supervisorNameInput.readOnly = true;
        }

        if (pcSelect) {
          if (currentUser && currentUser.pc_name) {
            pcSelect.value = currentUser.pc_name;
          } else if (sub.pc_name) {
            pcSelect.value = sub.pc_name;
          }
          pcSelect.disabled = true;
          updateWorkstationTrackingBadge();
        }

        if (screenshotFile) {
          screenshotFile.disabled = true;
        }

        if (sub.screenshot_path) {
          existingPhotoContainer.classList.remove('d-none');
          existingPhotoThumb.src = sub.screenshot_path;
          existingPhotoLink.href = sub.screenshot_path;
          // Hide photo deletion button so another user cannot remove verified proof photo
          if (btnDeleteExistingPhoto) btnDeleteExistingPhoto.classList.add('d-none');
        } else {
          existingPhotoContainer.classList.add('d-none');
        }

        // Show prominent LOCKED & COMPLETED status notice with option to delete incorrect count
        deptSubmissionNotice.classList.remove('d-none');
        deptSubmissionNotice.innerHTML = `
          <div class="alert alert-success border-success-subtle shadow-sm p-3 mb-0">
            <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
              <div class="d-flex align-items-center gap-2">
                <span class="badge bg-success px-2 py-1"><i class="bi bi-check2-all me-1"></i> SUBMISSION COMPLETED</span>
                <strong class="text-success-emphasis fs-6">Weekly Print Count Already Submitted</strong>
              </div>
              <span class="badge bg-light text-dark border"><i class="bi bi-lock-fill me-1 text-secondary"></i>Locked for this Cycle</span>
            </div>
            <div class="row g-2 small mt-1">
              <div class="col-sm-6">
                <span class="text-muted">Verified Meter Reading:</span>
                <span class="badge bg-dark font-monospace fs-6 ms-1 px-2 py-1">${(sub.print_count || 0).toLocaleString()} Pages</span>
              </div>
              <div class="col-sm-6 text-sm-end">
                <span class="text-muted">Recorded By:</span>
                <strong class="text-dark">${escapeHtml(sub.supervisor_name || 'Supervisor')}</strong> (${escapeHtml(sub.pc_name || 'PC')})
              </div>
              <div class="col-12 text-muted">
                <i class="bi bi-calendar-check me-1 text-success"></i> Submitted on <strong>${new Date(sub.submitted_at).toLocaleString()}</strong>
              </div>
            </div>
            <div class="small text-secondary mt-2 pt-2 border-top border-success-subtle">
              <i class="bi bi-shield-check text-success me-1"></i> <strong>Spoolers Active:</strong> Print spoolers are running on all departmental workstations. Further re-entry for this location is disabled to protect submitted audit records.
            </div>
            <div class="mt-3 pt-2 border-top border-success-subtle d-flex align-items-center justify-content-between flex-wrap gap-2">
              <div class="small text-secondary">
                <i class="bi bi-exclamation-circle text-warning me-1"></i> <strong>Entered an incorrect count?</strong> You can delete it and re-enter.
              </div>
              <button type="button" class="btn btn-outline-danger btn-sm fw-semibold shadow-sm" id="btnDeleteIncorrectSubmission">
                <i class="bi bi-trash3 me-1"></i> Delete Incorrect Count &amp; Re-enter
              </button>
            </div>
          </div>
        `;

        // Function to delete incorrect submission and unlock form
        const handleDeleteIncorrectSubmission = async () => {
          if (!currentActiveSubmissionId) return;
          const countStr = (sub.print_count || 0).toLocaleString();
          if (!confirm(`Are you sure you want to delete this incorrect print count (${countStr} pages)?\n\nThis will remove the current submission and unlock the form so you can enter and submit the correct count.`)) {
            return;
          }

          const btnDel = document.getElementById('btnDeleteIncorrectSubmission');
          if (btnDel) {
            btnDel.disabled = true;
            btnDel.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Deleting...';
          }

          try {
            const res = await fetch(`/api/submissions/${currentActiveSubmissionId}`, {
              method: 'DELETE'
            });
            const json = await res.json();
            if (!res.ok) {
              throw new Error(json.error || 'Failed to delete submission');
            }

            currentActiveSubmissionId = null;
            if (subDept) {
              subDept.submission = {
                status: 'Pending',
                print_count: null,
                submitted_at: null,
                pc_name: null,
                screenshot_path: null
              };
            }

            await loadDepartments();
            if (locationSelect) locationSelect.dispatchEvent(new Event('change'));

            showFeedback('info', 'Incorrect print count deleted. Please enter the correct reading below and submit.');
            if (printCountInput) {
              printCountInput.value = '';
              printCountInput.focus();
            }
          } catch (err) {
            alert(`Error deleting submission: ${err.message}`);
            if (btnDel) {
              btnDel.disabled = false;
              btnDel.innerHTML = '<i class="bi bi-trash3 me-1"></i> Delete Incorrect Count &amp; Re-enter';
            }
          }
        };

        const btnDeleteIncorrect = document.getElementById('btnDeleteIncorrectSubmission');
        if (btnDeleteIncorrect) {
          btnDeleteIncorrect.onclick = handleDeleteIncorrectSubmission;
        }

        const btnLinkReenter = document.getElementById('btnLinkReenter');
        if (btnLinkReenter) {
          btnLinkReenter.onclick = handleDeleteIncorrectSubmission;
        }

        const reenterHelpContainer = document.getElementById('reenterHelpContainer');
        if (reenterHelpContainer) {
          reenterHelpContainer.classList.remove('d-none');
        }

        // Lock submit button
        submitBtn.disabled = true;
        submitBtn.className = 'btn btn-secondary btn-lg py-3 fw-bold disabled w-100 opacity-75';
        submitBtn.innerHTML = '<i class="bi bi-lock-fill me-2"></i> Print Count Already Submitted & Verified for This Week (Locked)';
        submitBtn.setAttribute('title', 'Weekly print count is already submitted and locked for this location');

        const formStatusBadge = document.getElementById('formStatusBadge');
        if (formStatusBadge) {
          formStatusBadge.className = 'badge bg-success-subtle text-success border border-success-subtle p-2 fw-bold';
          formStatusBadge.innerHTML = '<i class="bi bi-lock-fill me-1"></i> Submitted &amp; Locked';
        }
      } else {
        currentActiveSubmissionId = null;

        const reenterHelpContainer = document.getElementById('reenterHelpContainer');
        if (reenterHelpContainer) {
          reenterHelpContainer.classList.add('d-none');
        }

        // Unlock all fields for entering count
        printCountInput.disabled = false;
        printCountInput.readOnly = false;
        printCountInput.classList.remove('bg-light');
        printCountInput.value = '';

        notesInput.disabled = false;
        notesInput.readOnly = false;
        notesInput.classList.remove('bg-light');
        notesInput.value = '';

        if (supervisorNameInput) {
          supervisorNameInput.disabled = false;
          supervisorNameInput.readOnly = true;
          if (currentUser && currentUser.name) supervisorNameInput.value = currentUser.name;
        }

        if (pcSelect) {
          pcSelect.disabled = false;
          if (currentUser && currentUser.pc_name) pcSelect.value = currentUser.pc_name;
        }

        if (screenshotFile) {
          screenshotFile.disabled = false;
        }

        if (btnDeleteExistingPhoto) {
          btnDeleteExistingPhoto.classList.remove('d-none');
        }

        existingPhotoContainer.classList.add('d-none');
        deptSubmissionNotice.classList.add('d-none');
        deptSubmissionNotice.innerHTML = '';

        submitBtn.disabled = false;
        submitBtn.className = 'btn btn-primary-custom btn-lg py-3 fw-bold';
        submitBtn.innerHTML = '<i class="bi bi-send-fill me-2"></i> Submit Weekly Print Count & Activate Spooler';
        submitBtn.removeAttribute('title');

        const formStatusBadge = document.getElementById('formStatusBadge');
        if (formStatusBadge) {
          formStatusBadge.className = 'badge bg-light text-dark border p-2';
          formStatusBadge.innerHTML = 'Domain Synced';
        }
      }

      // Fetch Previous Count for Location to calculate delta
      fetchPreviousCountForLocation(depId, selectedLocName);

      // Load History
      loadRecentFactHistory(depId, selectedLocName);
    });
  }

  function updateWorkstationTrackingBadge() {
    if (!pcSelect || !macTrackedBadge) return;
    const selectedOption = pcSelect.options[pcSelect.selectedIndex];
    const mac = selectedOption ? (selectedOption.getAttribute('data-mac') || (currentUser ? currentUser.mac_address : '')) : '';

    if (mac) {
      macTrackedBadge.innerHTML = `<i class="bi bi-shield-check me-1"></i>MAC: ${mac}`;
      macTrackedBadge.className = 'badge bg-success-subtle text-success border border-success-subtle small font-monospace';
    } else {
      macTrackedBadge.innerHTML = '<i class="bi bi-laptop me-1"></i>PC Tracked';
      macTrackedBadge.className = 'badge bg-info-subtle text-primary border small';
    }
  }

  if (pcSelect) {
    pcSelect.addEventListener('change', updateWorkstationTrackingBadge);
  }

  // Fetch previous count for delta calculation
  async function fetchPreviousCountForLocation(depId, locName) {
    previousCountForLocation = null;
    if (usageDeltaText) usageDeltaText.innerHTML = '';
    if (previousCountBadge) previousCountBadge.textContent = 'Previous: --';

    try {
      let url = '/api/facts/printer-counts?limit=10';
      if (depId) url += `&dep_id=${depId}`;
      const res = await fetch(url);
      const records = await res.json();

      // Find the latest count record before current week if updating
      if (records && records.length > 0) {
        const prev = records[0];
        previousCountForLocation = prev.print_count;
        if (previousCountBadge) {
          previousCountBadge.textContent = `Previous: ${previousCountForLocation.toLocaleString()} pgs (${prev.full_date || ''})`;
        }
        updatePrintCountDelta();
      }
    } catch (e) {
      console.warn('Could not fetch previous count:', e);
    }
  }

  function updatePrintCountDelta() {
    if (!usageDeltaText) return;
    const val = parseInt(printCountInput.value, 10);

    if (isNaN(val) || previousCountForLocation === null) {
      usageDeltaText.innerHTML = '';
      return;
    }

    const delta = val - previousCountForLocation;
    if (delta > 0) {
      usageDeltaText.innerHTML = `<span class="text-success"><i class="bi bi-graph-up-arrow me-1"></i>+${delta.toLocaleString()} pages printed since last reading</span>`;
    } else if (delta === 0) {
      usageDeltaText.innerHTML = `<span class="text-muted"><i class="bi bi-dash-circle me-1"></i>Same as previous reading (0 pages)</span>`;
    } else {
      usageDeltaText.innerHTML = `<span class="text-warning"><i class="bi bi-exclamation-triangle-fill me-1"></i>Reading is lower than previous by ${Math.abs(delta).toLocaleString()} pages</span>`;
    }
  }

  if (printCountInput) {
    printCountInput.addEventListener('input', updatePrintCountDelta);
  }

  // ==========================================
  // FORM SUBMISSION (DUAL TRACKING & UNBLOCK)
  // ==========================================
  submissionForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (currentActiveSubmissionId) {
      alert('This week\'s print count has already been submitted and verified for this location. Re-entry is locked.');
      return;
    }

    const selectedLoc = locationSelect ? locationSelect.value : '';
    const departmentId = (departmentSelect && departmentSelect.value) ? departmentSelect.value : (currentUser ? currentUser.dep_id : null);
    const printCount = printCountInput.value;
    const selectedPc = (pcSelect && pcSelect.value) ? pcSelect.value : (currentUser ? currentUser.pc_name : 'WORKSTATION');
    const supervisorName = supervisorNameInput.value.trim() || (currentUser ? currentUser.name : 'Supervisor');
    const notes = notesInput.value.trim();

    if (!selectedLoc && !departmentId) {
      alert('Please select your Plant Location.');
      if (locationSelect) locationSelect.focus();
      return;
    }

    if (printCount === '' || isNaN(printCount) || parseInt(printCount, 10) < 0) {
      alert('Please enter a valid weekly page counter reading (0 or higher).');
      if (printCountInput) printCountInput.focus();
      return;
    }

    const originalBtnText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving Reading & Activating Spoolers...';

    try {
      const response = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department_id: departmentId ? parseInt(departmentId, 10) : undefined,
          location: selectedLoc,
          print_count: parseInt(printCount, 10),
          supervisor_name: supervisorName,
          pc_name: selectedPc,
          notes: notes,
          screenshot_base64: selectedPhotoBase64
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to submit print count.');
      }

      clearPhotoSelection();

      let feedbackHtml = `
        <div class="alert alert-success alert-dismissible fade show shadow-sm" role="alert">
          <h5 class="alert-heading fw-bold mb-1"><i class="bi bi-check2-circle me-2"></i>Weekly Print Count Submitted Successfully!</h5>
          <p class="mb-1">${result.message}</p>
          <div class="small text-muted">Synchronized to Star Schema Fact Table (fact_printer_count) with Date_ID and dual-tracked workstation credentials (${selectedPc}).</div>
      `;

      if (result.screenshot_path) {
        feedbackHtml += `
          <div class="small fw-semibold text-success mt-2">
            <i class="bi bi-camera-fill me-1"></i> Physical counter photo attached successfully.
          </div>
        `;
      }

      if (result.spoolerUnblocked) {
        feedbackHtml += `
          <hr class="my-2">
          <div class="small fw-semibold text-dark">
            <i class="bi bi-lightning-charge-fill text-warning me-1"></i> 
            PowerShell WinRM Automation: Print Spooler service on department computers has been re-enabled and started.
          </div>
        `;
      }

      feedbackHtml += `
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        </div>
      `;

      feedbackContainer.innerHTML = feedbackHtml;
      feedbackContainer.scrollIntoView({ behavior: 'smooth' });

      // Refresh data
      await loadDepartments();
      if (locationSelect) locationSelect.dispatchEvent(new Event('change'));

    } catch (err) {
      console.error('Submission error:', err);
      showFeedback('danger', err.message);
    } finally {
      if (!currentActiveSubmissionId) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
      }
    }
  });

  function showFeedback(type, message) {
    feedbackContainer.innerHTML = `
      <div class="alert alert-${type} alert-dismissible fade show shadow-sm" role="alert">
        <i class="bi bi-exclamation-triangle-fill me-2"></i> ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
      </div>
    `;
    feedbackContainer.scrollIntoView({ behavior: 'smooth' });
  }

  // ==========================================
  // SUPERVISOR REGISTRATION & PC TRACKING
  // ==========================================
  const btnOpenSupervisorRegister = document.getElementById('btnOpenSupervisorRegister');
  const modalSupervisorRegisterEl = document.getElementById('modalSupervisorRegister');
  const formSupervisorRegister = document.getElementById('formSupervisorRegister');
  const reg_feedback = document.getElementById('reg_feedback');
  const reg_btnAutoDetect = document.getElementById('reg_btnAutoDetect');
  const reg_pass = document.getElementById('reg_pass');
  const reg_repass = document.getElementById('reg_repass');
  const reg_pass_match_indicator = document.getElementById('reg_pass_match_indicator');
  const reg_location = document.getElementById('reg_location');

  let modalSupervisorRegisterInstance = null;
  if (modalSupervisorRegisterEl && window.bootstrap) {
    modalSupervisorRegisterInstance = new bootstrap.Modal(modalSupervisorRegisterEl);
  }

  async function loadSupervisorLocationOptions(selectedLocation = '') {
    if (!reg_location) return;
    try {
      const res = await fetch('/api/locations');
      if (!res.ok) throw new Error('Failed to fetch locations');
      const locations = await res.json();

      const group105 = [];
      const group11 = [];
      const groupKandawala = [];
      const groupOther = [];

      locations.forEach(loc => {
        const is105 = loc.branch === 'Little Lion 105' || loc.name.includes('105');
        const is11 = (loc.branch === 'Little Lion 11' || loc.name.includes('11')) && !is105;
        const isKandawala = loc.branch === 'Kandawala' || loc.name.toLowerCase().includes('kandawala');

        if (is105) group105.push(loc);
        else if (is11) group11.push(loc);
        else if (isKandawala) groupKandawala.push(loc);
        else groupOther.push(loc);
      });

      const buildOptions = (list) => list.map(loc => {
        const printerLabel = loc.printers && loc.printers.length 
          ? ` [${loc.printers[0].model} - ${loc.printers[0].serial_number}]` 
          : '';
        const isSel = selectedLocation && selectedLocation.toLowerCase() === loc.name.toLowerCase() ? 'selected' : '';
        return `<option value="${escapeHtml(loc.name)}" ${isSel}>${escapeHtml(loc.name)}${escapeHtml(printerLabel)}</option>`;
      }).join('');

      let html = '<option value="">-- Select Location Name --</option>';
      if (group105.length) {
        html += `<optgroup label="🏢 Little Lion 105">${buildOptions(group105)}</optgroup>`;
      }
      if (group11.length) {
        html += `<optgroup label="🏢 Little Lion 11">${buildOptions(group11)}</optgroup>`;
      }
      if (groupKandawala.length) {
        html += `<optgroup label="📍 Kandawala">${buildOptions(groupKandawala)}</optgroup>`;
      }
      if (groupOther.length) {
        html += `<optgroup label="🏭 Other Maliban Locations">${buildOptions(groupOther)}</optgroup>`;
      }

      reg_location.innerHTML = html;
      if (selectedLocation) {
        reg_location.value = selectedLocation;
      }
    } catch (e) {
      console.warn('Could not load locations for supervisor form:', e);
    }
  }

  if (btnOpenSupervisorRegister) {
    btnOpenSupervisorRegister.addEventListener('click', () => {
      if (formSupervisorRegister) formSupervisorRegister.reset();
      if (reg_feedback) reg_feedback.innerHTML = '';
      if (reg_pass_match_indicator) reg_pass_match_indicator.innerHTML = '';
      loadSupervisorLocationOptions();
      if (modalSupervisorRegisterInstance) modalSupervisorRegisterInstance.show();
    });
  }

  function checkRegPasswordMatch() {
    if (!reg_pass || !reg_repass || !reg_pass_match_indicator) return;
    const p1 = reg_pass.value;
    const p2 = reg_repass.value;
    if (!p2) {
      reg_pass_match_indicator.innerHTML = '';
      return;
    }
    if (p1 === p2) {
      reg_pass_match_indicator.innerHTML = '<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i> Passwords match</span>';
    } else {
      reg_pass_match_indicator.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle-fill me-1"></i> Passwords do not match</span>';
    }
  }

  if (reg_pass) reg_pass.addEventListener('input', checkRegPasswordMatch);
  if (reg_repass) reg_repass.addEventListener('input', checkRegPasswordMatch);

  // Auto-detect PC & MAC
  if (reg_btnAutoDetect) {
    reg_btnAutoDetect.addEventListener('click', async () => {
      const origText = reg_btnAutoDetect.innerHTML;
      reg_btnAutoDetect.disabled = true;
      reg_btnAutoDetect.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Detecting...';
      try {
        const res = await fetch('/api/system/client-network');
        if (!res.ok) throw new Error('Auto-detection request failed');
        const data = await res.json();
        if (data.hostname && document.getElementById('reg_pc')) {
          document.getElementById('reg_pc').value = data.hostname;
        }
        if (data.mac_address && document.getElementById('reg_mac')) {
          document.getElementById('reg_mac').value = data.mac_address;
        }
        if (reg_feedback) {
          reg_feedback.innerHTML = `
            <div class="alert alert-success py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-check-circle-fill me-1"></i> Detected PC Name: <strong>${data.hostname || 'N/A'}</strong> | MAC: <strong>${data.mac_address || 'N/A'}</strong>
              <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>
            </div>
          `;
        }
      } catch (e) {
        if (reg_feedback) {
          reg_feedback.innerHTML = `
            <div class="alert alert-warning py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-exclamation-triangle-fill me-1"></i> Could not auto-detect: ${e.message}. Please enter manually.
              <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>
            </div>
          `;
        }
      } finally {
        reg_btnAutoDetect.disabled = false;
        reg_btnAutoDetect.innerHTML = origText;
      }
    });
  }

  // Handle Registration Form Submission
  if (formSupervisorRegister) {
    formSupervisorRegister.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (document.getElementById('reg_name')?.value || '').trim();
      let email = (document.getElementById('reg_email')?.value || '').trim();
      if (email && !email.includes('@')) {
        email = email + '@malibangroup.lk';
      }
      const location = (document.getElementById('reg_location')?.value || '').trim();
      const mac = (document.getElementById('reg_mac')?.value || '').trim();
      const pc = (document.getElementById('reg_pc')?.value || '').trim();
      const password = (document.getElementById('reg_pass')?.value || '').trim();
      const repass = (document.getElementById('reg_repass')?.value || '').trim();

      if (!name) {
        alert('Please enter your User Name.');
        return;
      }
      if (!email || !email.toLowerCase().endsWith('@malibangroup.lk')) {
        alert('Email must belong to the @malibangroup.lk domain.');
        return;
      }
      if (!location) {
        alert('Please enter your Location.');
        return;
      }
      if (!mac) {
        alert('MAC Address is required.');
        return;
      }
      const cleanMac = mac.replace(/[^0-9a-fA-F]/g, '');
      if (cleanMac.length !== 12) {
        alert('Invalid MAC Address. Please provide 12 hexadecimal characters (e.g. C8-95-CE-4A-5E-B6).');
        return;
      }
      if (!pc) {
        alert('PC Name is required.');
        return;
      }
      if (!password || password.length < 4) {
        alert('Password must be at least 4 characters long.');
        return;
      }
      if (password !== repass) {
        alert('Passwords do not match.');
        return;
      }

      const btnSubmit = document.getElementById('btnSubmitSupervisorRegister');
      const origText = btnSubmit ? btnSubmit.innerHTML : '';
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Registering...';
      }

      try {
        const res = await fetch('/api/users/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            location,
            mac_address: mac,
            pc_name: pc,
            password,
            re_enter_password: repass
          })
        });

        const result = await res.json();
        if (!res.ok) {
          throw new Error(result.error || 'Registration failed');
        }

        if (modalSupervisorRegisterInstance) modalSupervisorRegisterInstance.hide();
        formSupervisorRegister.reset();

        // Pre-fill login form
        if (loginIdentifier) loginIdentifier.value = email || pc;
        if (loginPassword) loginPassword.value = password;

        if (loginFeedback) {
          loginFeedback.innerHTML = `
            <div class="alert alert-success alert-dismissible fade show shadow-sm" role="alert">
              <i class="bi bi-check-circle-fill me-2"></i> Account registered successfully for <strong>${name}</strong>! Your PC (<strong>${pc}</strong> / <strong>${result.user.mac_address}</strong>) is now tracked. Click "Log In to Portal" to continue.
              <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
            </div>
          `;
        }
      } catch (err) {
        if (reg_feedback) {
          reg_feedback.innerHTML = `
            <div class="alert alert-danger py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-x-circle-fill me-1"></i> ${err.message}
              <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>
            </div>
          `;
        } else {
          alert(`Error: ${err.message}`);
        }
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerHTML = origText;
        }
      }
    });
  }

  // Handle supervisor tab nav clicks (smooth scrolling & active state)
  const supervisorNavLinks = document.querySelectorAll('#supervisorTabNav .nav-link');
  supervisorNavLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      supervisorNavLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      const targetId = link.getAttribute('href');
      if (targetId && targetId.startsWith('#')) {
        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          e.preventDefault();
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });

  // Refresh button listener
  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Refreshing...';
      await Promise.all([loadWeekInfo(), loadLocations(), loadDepartments()]);
      if (locationSelect) locationSelect.dispatchEvent(new Event('change'));
      btnRefresh.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i> Refresh Data';
    });
  }

  // Initialize
  initAuth();
});