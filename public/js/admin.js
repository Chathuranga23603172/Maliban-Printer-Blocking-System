document.addEventListener('DOMContentLoaded', () => {
  const tableBody = document.getElementById('departmentsTableBody');
  const alertContainer = document.getElementById('adminAlertContainer');
  const btnRefresh = document.getElementById('btnRefresh');
  const btnRunCronNow = document.getElementById('btnRunCronNow');
  const tableWeekBadge = document.getElementById('tableWeekBadge');
  const currentWeekSubtitle = document.getElementById('currentWeekSubtitle');

  // Stats elements
  const statTotalDepts = document.getElementById('statTotalDepts');
  const statSubmittedDepts = document.getElementById('statSubmittedDepts');
  const statPendingDepts = document.getElementById('statPendingDepts');
  const statBlockedDepts = document.getElementById('statBlockedDepts');

  // Modal elements
  const targetDeptSelect = document.getElementById('targetDeptSelect');
  const formAddComputer = document.getElementById('formAddComputer');
  const formAddDepartment = document.getElementById('formAddDepartment');
  const logTerminalContent = document.getElementById('logTerminalContent');
  const btnRefreshLogs = document.getElementById('btnRefreshLogs');
  const btnRefreshDashboard = document.getElementById('btnRefreshDashboard');
  if (btnRefreshDashboard) btnRefreshDashboard.addEventListener('click', () => loadDashboardData());

  let currentData = null;

  // 1. Fetch Current Week Submissions and Department Status
  async function loadDashboardData(isSilent = false) {
    try {
      if (!isSilent) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="5" class="text-center py-4 text-muted">
              <span class="spinner-border spinner-border-sm me-2"></span> Updating status...
            </td>
          </tr>
        `;
      }

      const res = await fetch('/api/submissions/current-week');
      if (!res.ok) throw new Error('Failed to retrieve department data');
      currentData = await res.json();

      renderDashboard(currentData);
      populateDeptSelect(currentData.departments);

      // Update live auto-sync timestamp badge
      const liveBadge = document.getElementById('liveSyncBadge');
      if (liveBadge) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        liveBadge.innerHTML = `<i class="bi bi-broadcast text-success me-1"></i>Live: 1m Auto-Sync (Last: ${timeStr})`;
      }
    } catch (err) {
      console.error('Error fetching admin data:', err);
      if (!isSilent) {
        showAlert('danger', `Could not load dashboard data: ${err.message}`);
      }
    }
  }

  // 2. Render Table and Stats
  function renderDashboard(data) {
    const { weekStartDate, departments } = data;

    if (tableWeekBadge) tableWeekBadge.textContent = `Reporting Week: ${weekStartDate}`;
    if (currentWeekSubtitle) currentWeekSubtitle.textContent = `Active cycle starting Monday ${weekStartDate}. Enforcement runs Mondays at 2:00 PM.`;

    let total = departments.length;
    let submitted = 0;
    let pending = 0;
    let blocked = 0;

    if (departments.length === 0) {
      if (tableBody) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="5" class="text-center py-4 text-muted">
              No departments found in the system. Click "Manage Depts & PCs" above to get started.
            </td>
          </tr>
        `;
      }
      if (statTotalDepts) statTotalDepts.textContent = '0';
      if (statSubmittedDepts) statSubmittedDepts.textContent = '0';
      if (statPendingDepts) statPendingDepts.textContent = '0';
      if (statBlockedDepts) statBlockedDepts.textContent = '0';
      return;
    }

    let rowsHtml = '';

    departments.forEach(dept => {
      const isSubmitted = dept.submission && dept.submission.status === 'Submitted';
      const isBlocked = dept.spooler_status === 'BLOCKED';

      if (isSubmitted) submitted++;
      else pending++;

      if (isBlocked) blocked++;

      // Assigned PCs tags
      let pcsHtml = '';
      if (dept.computers && dept.computers.length > 0) {
        pcsHtml = dept.computers.map(c => {
          let statusBadge = '';
          const isOnline = c.is_online === true;

          if (isOnline) {
            statusBadge = '<span class="badge bg-success ms-1" style="font-size:0.65rem;" title="Workstation is powered on and online"><i class="bi bi-power me-1"></i>Online</span>';
            // Live Spooler Service status on PC
            if (c.is_overridden) {
              statusBadge += '<span class="badge bg-warning text-dark ms-1" style="font-size:0.65rem;" title="Tamper detected: Print Spooler was manually started in services.msc while department is BLOCKED!"><i class="bi bi-exclamation-triangle-fill me-1"></i>Spooler: RUNNING (services.msc)</span>';
            } else if (c.is_running) {
              statusBadge += '<span class="badge bg-success-subtle text-success border border-success-subtle ms-1" style="font-size:0.65rem;" title="Windows Print Spooler is Running"><i class="bi bi-printer-fill me-1"></i>Spooler: Running</span>';
            } else if (c.live_service_status === 'Stopped') {
              statusBadge += '<span class="badge bg-danger-subtle text-danger border border-danger-subtle ms-1" style="font-size:0.65rem;" title="Windows Print Spooler is Stopped & Disabled"><i class="bi bi-slash-circle me-1"></i>Spooler: Stopped</span>';
            } else if (c.live_service_status === 'WinRM Closed' || c.live_service_status === 'Unknown') {
              statusBadge += '<span class="badge bg-warning text-dark ms-1" style="font-size:0.65rem;" title="PC is on network, but WinRM Port 5985 is closed/firewalled. Spooler commands cannot reach this PC until Enable-PSRemoting is run.">WinRM Closed (Spooler Not Stopped)</span>';
            }
          } else {
            statusBadge = '<span class="badge bg-secondary ms-1" style="font-size:0.65rem;" title="Workstation is powered off or offline"><i class="bi bi-power me-1"></i>Offline</span>';
            if (c.spooler_status === 'PENDING_BLOCK') {
              statusBadge += '<span class="badge bg-warning text-dark ms-1" style="font-size:0.65rem;" title="Workstation offline. Spooler will be blocked automatically when powered on."><i class="bi bi-clock-history me-1"></i>Pending Block</span>';
            }
          }

          const tooltip = `IP: ${c.ip_address || 'DHCP'}${c.mac_address ? ' | MAC: ' + c.mac_address : ''} | Status: ${isOnline ? 'Online' : 'Offline (' + (c.online_reason || 'Unreachable') + ')'} | Spooler: ${c.spooler_status || 'Unknown'}${c.last_sync_error ? ' | Last error: ' + c.last_sync_error : ''}`;

          return `<span class="pc-tag" title="${escapeHtml(tooltip)}">
            <i class="bi bi-pc me-1 ${isOnline ? 'text-success' : 'text-secondary'}"></i>${c.pc_name}
            ${statusBadge}
            <button class="btn btn-link btn-xs text-danger p-0 ms-1" style="font-size:0.7rem;text-decoration:none;" onclick="deleteComputer(${c.id}, '${c.pc_name}')" title="Remove PC">&times;</button>
          </span>`;
        }).join(' ');
      } else {
        pcsHtml = '<span class="text-muted small fst-italic"><i class="bi bi-exclamation-circle text-warning me-1"></i>No PCs registered</span>';
      }

      // Submission status badge & photo badge
      let subBadge = '';
      let photoCellHtml = '<span class="badge bg-light text-muted border small"><i class="bi bi-dash"></i> None</span>';

      if (isSubmitted) {
        const safeDept = escapeHtml(dept.name);
        const safeSup = escapeHtml(dept.submission.supervisor_name || 'Supervisor');
        const countFormatted = dept.submission.print_count.toLocaleString();
        const dateFormatted = new Date(dept.submission.submitted_at).toLocaleString();

        subBadge = `
          <span class="badge bg-success-subtle text-success border border-success-subtle p-2">
            <i class="bi bi-check-circle-fill me-1"></i> Submitted (${countFormatted} pages)
          </span>
          <div class="small text-muted mt-1" style="font-size: 0.75rem;">
            ${new Date(dept.submission.submitted_at).toLocaleDateString()} by ${safeSup}
            ${dept.submission.pc_name ? '<span class="badge bg-light text-secondary border small ms-1"><i class="bi bi-pc me-1"></i>' + escapeHtml(dept.submission.pc_name) + '</span>' : ''}
          </div>
          <div class="mt-1">
            <button type="button" 
                    class="btn btn-outline-danger btn-xs py-0 px-2 shadow-sm" 
                    style="font-size: 0.7rem; font-weight: 500;" 
                    onclick="adminDeleteSubmission(${dept.submission.id}, '${safeDept}', '${countFormatted}')" 
                    title="Delete incorrect submission to allow supervisor to re-enter">
              <i class="bi bi-trash3 me-1"></i> Delete &amp; Reset Count
            </button>
          </div>
        `;

        if (dept.submission.screenshot_path) {
          const photoUrl = dept.submission.screenshot_path;
          photoCellHtml = `
            <div class="d-flex align-items-center gap-2 photo-context-target"
                 data-sub-id="${dept.submission.id}" 
                 data-photo-url="${photoUrl}" 
                 data-dept="${safeDept}" 
                 data-sup="${safeSup}" 
                 data-count="${countFormatted}" 
                 data-time="${dateFormatted}">
              <img src="${photoUrl}" 
                   alt="Counter Thumbnail" 
                   style="width: 44px; height: 32px; object-fit: cover; border-radius: 4px; border: 1px solid #0d6efd; cursor: pointer;"
                   onclick="viewPhoto('${photoUrl}', '${safeDept}', '${safeSup}', '${countFormatted}', '${dateFormatted}', ${dept.submission.id})"
                   title="Left-click to view | Right-click to delete / options">
              <button type="button" 
                      class="btn btn-sm btn-primary py-0 px-2 d-inline-flex align-items-center shadow-sm" 
                      style="font-size: 0.75rem;" 
                      onclick="viewPhoto('${photoUrl}', '${safeDept}', '${safeSup}', '${countFormatted}', '${dateFormatted}', ${dept.submission.id})"
                      title="Left-click to view | Right-click to delete / options">
                <i class="bi bi-eye me-1"></i> View Photo
              </button>
            </div>
          `;
        } else {
          photoCellHtml = `
            <div class="d-flex align-items-center gap-2">
              <span class="badge bg-light text-muted border" style="font-size: 0.7rem;">
                <i class="bi bi-camera-slash me-1"></i> No Photo
              </span>
              <button type="button" 
                      class="btn btn-sm btn-outline-primary py-0 px-2" 
                      style="font-size: 0.7rem;" 
                      onclick="openAttachModal(${dept.submission.id}, '${safeDept}')"
                      title="Attach counter photo">
                <i class="bi bi-camera-fill me-1"></i> + Attach
              </button>
            </div>
          `;
        }
      } else {
        subBadge = `
          <span class="badge badge-pending p-2">
            <i class="bi bi-hourglass-split me-1"></i> Pending Submission
          </span>
        `;
        photoCellHtml = '<span class="badge bg-light text-muted border small"><i class="bi bi-dash"></i> None</span>';
      }

      // Spooler status badge
      let spoolerBadge = '';
      if (dept.has_override) {
        spoolerBadge = `
          <div class="d-flex flex-column gap-1">
            <span class="badge bg-warning text-dark p-2" title="Manual Override: Print Spooler on ${escapeHtml(dept.override_pc || 'workstation')} was manually started in services.msc while blocked!">
              <i class="bi bi-exclamation-triangle-fill me-1"></i> OVERRIDDEN (Running)
            </span>
            <button class="btn btn-outline-danger btn-xs py-0 px-2 shadow-sm" style="font-size: 0.72rem; font-weight: 600;" onclick="manualBlock(${dept.id}, '${escapeHtml(dept.name)}', ${dept.computers.length})" title="Re-Enforce Block & Disable Spooler immediately">
              <i class="bi bi-shield-slash me-1"></i> Re-Block PC
            </button>
          </div>
        `;
      } else if (isBlocked) {
        spoolerBadge = `
          <span class="badge badge-blocked p-2">
            <i class="bi bi-slash-circle-fill me-1"></i> BLOCKED
          </span>
        `;
      } else {
        spoolerBadge = `
          <span class="badge badge-active p-2">
            <i class="bi bi-check-circle-fill me-1"></i> ACTIVE
          </span>
        `;
      }

      rowsHtml += `
        <tr>
          <td>
            <div class="fw-bold text-dark fs-6">${dept.name}</div>
            <div class="small text-muted">ID: ${dept.id} | Workstations: ${dept.computers.length}</div>
          </td>
          <td>${spoolerBadge}</td>
          <td>${pcsHtml}</td>
          <td>${subBadge}</td>
          <td>${photoCellHtml}</td>
          <td class="text-center text-nowrap">
            <div class="btn-group btn-group-sm" role="group">
              <button 
                class="btn btn-outline-danger" 
                id="btn-block-${dept.id}"
                title="Execute Stop-Service & Disable Spooler on PCs"
                onclick="manualBlock(${dept.id}, '${escapeHtml(dept.name)}', ${dept.computers.length}, this)"
              >
                Block
              </button>
              <button 
                class="btn btn-outline-success" 
                id="btn-unblock-${dept.id}"
                title="Execute Start-Service & Enable Spooler on PCs"
                onclick="manualUnblock(${dept.id}, '${escapeHtml(dept.name)}', ${dept.computers.length}, this)"
              >
                Unblock
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    if (tableBody) tableBody.innerHTML = rowsHtml;

    // Update Counter Badges
    if (statTotalDepts) statTotalDepts.textContent = total;
    if (statSubmittedDepts) statSubmittedDepts.textContent = submitted;
    if (statPendingDepts) statPendingDepts.textContent = pending;
    if (statBlockedDepts) statBlockedDepts.textContent = blocked;
  }

  // 3. Populate Department Select in Management Modal
  function populateDeptSelect(departments) {
    targetDeptSelect.innerHTML = '<option value="" disabled selected>-- Select Department --</option>';
    departments.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} (${d.computers.length} PCs)`;
      targetDeptSelect.appendChild(opt);
    });
  }

  // 4. Trigger Monday 2:00 PM Check Now
  if (btnRunCronNow) {
    btnRunCronNow.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to trigger the Monday 2:00 PM deadline check now?\n\nThis will immediately identify all departments with PENDING submissions and run the PowerShell remote command to disable the Print Spooler on their workstations.')) {
        return;
      }

      const originalText = btnRunCronNow.innerHTML;
      btnRunCronNow.disabled = true;
      btnRunCronNow.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Executing Enforcement...';

      try {
        const res = await fetch('/api/admin/trigger-deadline-check', { method: 'POST' });
        const result = await res.json();

        if (!res.ok) throw new Error(result.error || 'Failed to execute deadline check.');

        const count = result.result.nonCompliantCount;
        if (count === 0) {
          showAlert('success', 'All departments have submitted their print counts! No printer restrictions were necessary.');
        } else {
          showAlert('warning', `Enforcement Completed: Evaluated all departments. ${count} non-compliant department(s) identified and Print Spoolers restricted via PowerShell.`);
        }

        await loadDashboardData();
      } catch (err) {
        console.error('Error triggering deadline check:', err);
        showAlert('danger', `Enforcement error: ${err.message}`);
      } finally {
        btnRunCronNow.disabled = false;
        btnRunCronNow.innerHTML = originalText;
      }
    });
  }

  // 5. Manual Block / Unblock Handlers (Exposed globally for button onclick)
  window.manualBlock = async (deptId, deptName, pcCount, btnElement) => {
    const confirmMsg = pcCount === 0
      ? `Are you sure you want to set status to BLOCKED for "${deptName}"? (No workstations currently registered)`
      : `Are you sure you want to BLOCK print spoolers on ${pcCount} workstation(s) for "${deptName}"?`;

    if (!confirm(confirmMsg)) {
      return;
    }

    const origHtml = btnElement ? btnElement.innerHTML : '';
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Blocking...';
    }

    try {
      showAlert('info', `Sending command to STOP Print Spooler on ${deptName} workstations...`);
      const res = await fetch(`/api/admin/block/${deptId}`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed to block department.');

      if (data.totalPCs === 0) {
        showAlert('warning', `<strong>Department "${deptName}" is BLOCKED.</strong> (No workstations currently registered).`);
      } else if (data.allOffline) {
        showAlert('warning', `<strong>Department "${deptName}" is BLOCKED.</strong><br>Workstation (${data.offlinePCs.join(', ')}) is currently <strong>offline or WinRM port closed</strong>. Status is set to <strong>Pending Block</strong> and will apply when online.`);
      } else if (data.hasOffline) {
        showAlert('warning', `<strong>Department "${deptName}" is BLOCKED.</strong><br>Disabled on: ${data.onlinePCs.join(', ')}.<br>Offline / Closed (${data.offlinePCs.join(', ')}): marked as Pending Block.`);
      } else {
        showAlert('danger', `Print Spooler disabled and stopped for "${deptName}".`);
      }
    } catch (err) {
      showAlert('danger', `Error blocking "${deptName}": ${err.message}`);
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerHTML = origHtml;
      }
      await loadDashboardData();
    }
  };

  window.manualUnblock = async (deptId, deptName, pcCount, btnElement) => {
    const confirmMsg = pcCount === 0
      ? `Are you sure you want to set status to ACTIVE for "${deptName}"? (No workstations currently registered)`
      : `Are you sure you want to UNBLOCK and start print spoolers on ${pcCount} workstation(s) for "${deptName}"?`;

    if (!confirm(confirmMsg)) {
      return;
    }

    const origHtml = btnElement ? btnElement.innerHTML : '';
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Unblocking...';
    }

    try {
      showAlert('info', `Sending command to START Print Spooler on ${deptName} workstations...`);
      const res = await fetch(`/api/admin/unblock/${deptId}`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed to unblock department.');

      if (data.totalPCs === 0) {
        showAlert('success', `<strong>Department "${deptName}" is UNBLOCKED.</strong> (Status set to ACTIVE).`);
      } else if (data.allOffline) {
        showAlert('warning', `<strong>Department "${deptName}" is UNBLOCKED.</strong><br>Workstation (${data.offlinePCs.join(', ')}) is currently <strong>offline or WinRM port closed</strong>. Status is set to <strong>Pending Unblock</strong> and will apply when online.`);
      } else if (data.hasOffline) {
        showAlert('warning', `<strong>Department "${deptName}" is UNBLOCKED.</strong><br>Started on: ${data.onlinePCs.join(', ')}.<br>Offline / Closed (${data.offlinePCs.join(', ')}): marked as Pending Unblock.`);
      } else {
        showAlert('success', `Print Spooler set to Automatic and started for "${deptName}".`);
      }
    } catch (err) {
      showAlert('danger', `Error unblocking "${deptName}": ${err.message}`);
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerHTML = origHtml;
      }
      await loadDashboardData();
    }
  };

  window.deleteComputer = async (pcId, pcName) => {
    if (!confirm(`Remove workstation "${pcName}" from the tracking registry?`)) return;

    try {
      const res = await fetch(`/api/computers/${pcId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete computer');
      showAlert('secondary', `Workstation "${pcName}" removed.`);
      await loadDashboardData();
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  // 6. Add Computer to Department Form
  formAddComputer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const deptId = targetDeptSelect.value;
    const pcName = document.getElementById('newPcName').value.trim();
    const ipAddress = document.getElementById('newPcIp').value.trim();
    const macAddress = document.getElementById('newPcMac') ? document.getElementById('newPcMac').value.trim() : '';
    const notes = document.getElementById('newPcNotes').value.trim();

    if (!deptId || !pcName) {
      alert('Department and PC Hostname are required.');
      return;
    }

    try {
      const res = await fetch(`/api/departments/${deptId}/computers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pc_name: pcName, ip_address: ipAddress || null, mac_address: macAddress || null, notes })
      });

      if (!res.ok) throw new Error('Failed to register computer');

      showAlert('success', `Workstation "${pcName}" successfully assigned.`);
      document.getElementById('newPcName').value = '';
      document.getElementById('newPcIp').value = '';
      if (document.getElementById('newPcMac')) document.getElementById('newPcMac').value = '';
      document.getElementById('newPcNotes').value = '';

      // Close modal
      const modalEl = document.getElementById('manageModal');
      bootstrap.Modal.getInstance(modalEl).hide();

      await loadDashboardData();
    } catch (err) {
      showAlert('danger', err.message);
    }
  });

  // 7. Add Department Form
  formAddDepartment.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newDeptName').value.trim();
    if (!name) return;

    try {
      const res = await fetch('/api/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create department');

      showAlert('success', `Department "${name}" created successfully.`);
      document.getElementById('newDeptName').value = '';

      const modalEl = document.getElementById('manageModal');
      bootstrap.Modal.getInstance(modalEl).hide();

      await loadDashboardData();
    } catch (err) {
      showAlert('danger', err.message);
    }
  });

  // 8. Automation Logs Modal
  async function loadLogs() {
    logTerminalContent.innerHTML = '<div class="text-muted">Loading audit entries...</div>';
    try {
      const res = await fetch('/api/admin/logs');
      const logs = await res.json();

      if (logs.length === 0) {
        logTerminalContent.innerHTML = '<div class="text-muted">No automation actions recorded yet.</div>';
        return;
      }

      logTerminalContent.innerHTML = logs.map(l => {
        const statusClass = l.status === 'SUCCESS' ? 'log-success' : (l.status === 'SIMULATED' ? 'log-simulated' : 'log-failed');
        const deptLabel = l.department_name ? `[${l.department_name}]` : '';
        const targetLabel = l.pc_name ? `@ ${l.pc_name}` : '';
        const dateStr = new Date(l.executed_at).toLocaleString();

        let details = '';
        if (l.error) details = `<div class="text-danger ps-3">&gt; Error: ${escapeHtml(l.error)}</div>`;
        else if (l.output) details = `<div class="text-muted ps-3">&gt; Output: ${escapeHtml(l.output)}</div>`;

        return `
          <div class="log-entry">
            <span class="log-time">[${dateStr}]</span>
            <span class="${statusClass} fw-bold ms-1">[${l.status}]</span>
            <span class="text-info ms-1">${l.action_type}</span>
            <span class="text-warning ms-1">${deptLabel}</span>
            <span class="text-white ms-1">${targetLabel}</span>
            ${l.command ? `<div class="text-secondary ps-3" style="font-size:0.75rem;">CMD: ${escapeHtml(l.command)}</div>` : ''}
            ${details}
          </div>
        `;
      }).join('');
    } catch (err) {
      logTerminalContent.innerHTML = `<div class="text-danger">Failed to load logs: ${err.message}</div>`;
    }
  }

  if (btnRefreshLogs) btnRefreshLogs.addEventListener('click', loadLogs);
  const btnViewLogs = document.getElementById('btnViewLogs');
  if (btnViewLogs) btnViewLogs.addEventListener('click', loadLogs);
  if (btnRefresh) btnRefresh.addEventListener('click', loadDashboardData);

  // 9. PDF Export Handler: Department, Supervisor Name & Print Count
  const btnExportPdf = document.getElementById('btnExportPdf');
  if (btnExportPdf) {
    btnExportPdf.addEventListener('click', exportPdfReport);
  }

  function exportPdfReport() {
    if (!currentData || !currentData.departments || currentData.departments.length === 0) {
      alert('No department data available to export.');
      return;
    }

    const { weekStartDate, departments } = currentData;
    let totalPagesPrinted = 0;
    let submittedCount = 0;
    let pendingCount = 0;

    const rows = departments.map((dept, index) => {
      const isSubmitted = dept.submission && dept.submission.status === 'Submitted';
      const count = isSubmitted ? (dept.submission.print_count || 0) : 0;
      if (isSubmitted) {
        totalPagesPrinted += count;
        submittedCount++;
      } else {
        pendingCount++;
      }

      const supervisor = (dept.submission && dept.submission.supervisor_name)
        ? dept.submission.supervisor_name
        : (isSubmitted ? 'Supervisor' : '-');

      const printDate = (dept.submission && dept.submission.submitted_at)
        ? new Date(dept.submission.submitted_at).toLocaleDateString()
        : '-';

      return [
        index + 1,
        dept.name,
        supervisor,
        isSubmitted ? count.toLocaleString() : '0',
        isSubmitted ? 'Submitted' : 'Pending',
        printDate
      ];
    });

    // 1. If jsPDF library is loaded
    if (window.jspdf && window.jspdf.jsPDF) {
      try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        // Header Banner (Corporate Dark Blue)
        doc.setFillColor(15, 44, 89);
        doc.rect(0, 0, 210, 34, 'F');

        doc.setTextColor(255, 255, 255);
        doc.setFontSize(15);
        doc.setFont('helvetica', 'bold');
        doc.text('MALIBAN BISCUIT MANUFACTORIES (PVT) LIMITED', 14, 13);

        doc.setFontSize(10.5);
        doc.setFont('helvetica', 'normal');
        doc.text('IT Department - Weekly Department Printer Counter Audit Report', 14, 21);

        doc.setFontSize(8.5);
        doc.setTextColor(215, 228, 245);
        doc.text(`Reporting Week: ${weekStartDate}   |   Generated: ${new Date().toLocaleString()}`, 14, 28);

        // Summary Metric Bar
        doc.setTextColor(33, 37, 41);
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        doc.text(`Departments: ${departments.length}   |   Submitted: ${submittedCount}   |   Pending: ${pendingCount}   |   Total Pages: ${totalPagesPrinted.toLocaleString()}`, 14, 42);

        // AutoTable
        doc.autoTable({
          startY: 46,
          head: [['#', 'Department', 'Supervisor Name', 'Print Count', 'Status', 'Submitted Date']],
          body: rows,
          foot: [[
            '',
            `TOTALS (${departments.length} Departments)`,
            `${submittedCount} Submitted / ${pendingCount} Pending`,
            `${totalPagesPrinted.toLocaleString()} Pages`,
            '',
            ''
          ]],
          headStyles: {
            fillColor: [15, 44, 89],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 9.5
          },
          footStyles: {
            fillColor: [240, 244, 250],
            textColor: [15, 44, 89],
            fontStyle: 'bold',
            fontSize: 10
          },
          bodyStyles: {
            fontSize: 9,
            cellPadding: 3.5
          },
          alternateRowStyles: {
            fillColor: [248, 250, 252]
          },
          columnStyles: {
            0: { cellWidth: 10, halign: 'center' },
            1: { cellWidth: 60, fontStyle: 'bold' },
            2: { cellWidth: 45 },
            3: { cellWidth: 30, halign: 'right', fontStyle: 'bold' },
            4: { cellWidth: 25, halign: 'center' },
            5: { cellWidth: 20, halign: 'center' }
          },
          didParseCell: function(data) {
            if (data.section === 'body' && data.column.index === 4) {
              if (data.cell.raw === 'Submitted') {
                data.cell.styles.textColor = [25, 135, 84]; // Green
                data.cell.styles.fontStyle = 'bold';
              } else {
                data.cell.styles.textColor = [220, 53, 69]; // Red
                data.cell.styles.fontStyle = 'bold';
              }
            }
          },
          didDrawPage: function(data) {
            const pageCount = doc.internal.getNumberOfPages();
            doc.setFontSize(8);
            doc.setTextColor(130, 130, 130);
            doc.text(
              `Maliban IT Infrastructure - Confidential Internal Audit Document   |   Page ${data.pageNumber} of ${pageCount}`,
              14,
              doc.internal.pageSize.height - 8
            );
          }
        });

        doc.save(`Maliban_Printer_Count_Report_${weekStartDate}.pdf`);
        showAlert('success', `<i class="bi bi-file-earmark-check-fill me-1"></i> PDF report downloaded successfully: <strong>Maliban_Printer_Count_Report_${weekStartDate}.pdf</strong>`);
        return;
      } catch (pdfErr) {
        console.warn('jsPDF generation error, switching to print fallback:', pdfErr);
      }
    }

    // 2. Fallback: Printable HTML Report Window (supports Save as PDF)
    printReportFallback(weekStartDate, departments, rows, totalPagesPrinted, submittedCount, pendingCount);
  }

  function printReportFallback(weekStartDate, departments, rows, totalPages, submittedCount, pendingCount) {
    const printWin = window.open('', '_blank');
    printWin.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Maliban Printer Count Report - ${weekStartDate}</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 30px; color: #212529; }
          .header-box { background: #0f2c59; color: white; padding: 20px; border-radius: 6px; margin-bottom: 25px; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          th { background: #0f2c59 !important; color: white !important; padding: 10px; font-size: 13px; }
          td { padding: 9px; border-bottom: 1px solid #dee2e6; font-size: 13px; }
          .total-row { font-weight: bold; background: #eef3fb !important; font-size: 14px; }
          @media print { .no-print { display: none !important; } }
        </style>
      </head>
      <body>
        <div class="header-box">
          <h4 class="mb-1 fw-bold">MALIBAN BISCUIT MANUFACTORIES (PVT) LIMITED</h4>
          <div class="fs-6">IT Department - Weekly Department Printer Counter Audit Report</div>
          <div class="small opacity-75 mt-1">Reporting Week: ${weekStartDate} | Generated on: ${new Date().toLocaleString()}</div>
        </div>
        <div class="mb-3 d-flex justify-content-between align-items-center">
          <div>
            <strong>Summary:</strong> ${departments.length} Departments &nbsp;|&nbsp; ${submittedCount} Submitted &nbsp;|&nbsp; ${pendingCount} Pending &nbsp;|&nbsp; <strong>${totalPages.toLocaleString()} Total Pages Printed</strong>
          </div>
          <button class="btn btn-primary no-print" onclick="window.print()">
            <i class="bi bi-printer"></i> Print / Save as PDF
          </button>
        </div>
        <table class="table table-bordered table-striped">
          <thead>
            <tr>
              <th style="width: 5%; text-align: center;">#</th>
              <th style="width: 32%;">Department</th>
              <th style="width: 25%;">Supervisor Name</th>
              <th style="width: 15%; text-align: right;">Print Count</th>
              <th style="width: 11%; text-align: center;">Status</th>
              <th style="width: 12%; text-align: center;">Submitted Date</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td style="text-align:center;">${r[0]}</td>
                <td><strong>${r[1]}</strong></td>
                <td>${r[2]}</td>
                <td style="text-align:right; font-weight:bold;">${r[3]}</td>
                <td style="text-align:center;"><span class="badge ${r[4] === 'Submitted' ? 'bg-success' : 'bg-danger'}">${r[4]}</span></td>
                <td style="text-align:center;">${r[5]}</td>
              </tr>
            `).join('')}
            <tr class="total-row">
              <td colspan="3" class="text-end">TOTAL PRINTED PAGES:</td>
              <td style="text-align:right; color: #0f2c59;">${totalPages.toLocaleString()} Pages</td>
              <td colspan="2"></td>
            </tr>
          </tbody>
        </table>
        <div class="text-muted small mt-4 text-center">Maliban IT Infrastructure &copy; 2026 | Confidential Internal Audit Document</div>
        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
      </html>
    `);
    printWin.document.close();
  }

  function showAlert(type, message) {
    alertContainer.innerHTML = `
      <div class="alert alert-${type} alert-dismissible fade show shadow-sm mb-4" role="alert">
        <div class="d-flex align-items-center">
          <i class="bi bi-info-circle-fill me-2 fs-5"></i>
          <div>${message}</div>
        </div>
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      </div>
    `;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ==========================================
  // 10. WEEKLY RECORDS & EXCEL EXPORT HANDLER
  // ==========================================
  const tabRecordsBtn = document.getElementById('tab-records-btn');
  const recordsWeekSelect = document.getElementById('recordsWeekSelect');
  const btnExportExcel = document.getElementById('btnExportExcel');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnRefreshRecords = document.getElementById('btnRefreshRecords');

  const recStatTotalDepts = document.getElementById('recStatTotalDepts');
  const recStatSubmitted = document.getElementById('recStatSubmitted');
  const recStatPending = document.getElementById('recStatPending');
  const recStatTotalPages = document.getElementById('recStatTotalPages');
  const recSelectedWeekBadge = document.getElementById('recSelectedWeekBadge');
  const recordsTableBody = document.getElementById('recordsTableBody');
  const recordsTableFoot = document.getElementById('recordsTableFoot');

  let currentWeeklyRecords = null;

  if (tabRecordsBtn) {
    tabRecordsBtn.addEventListener('click', () => {
      loadWeeklyRecords(recordsWeekSelect ? recordsWeekSelect.value : '');
    });
  }

  if (recordsWeekSelect) {
    recordsWeekSelect.addEventListener('change', () => {
      loadWeeklyRecords(recordsWeekSelect.value);
    });
  }

  if (btnRefreshRecords) {
    btnRefreshRecords.addEventListener('click', () => {
      loadWeeklyRecords(recordsWeekSelect ? recordsWeekSelect.value : '');
    });
  }

  if (btnExportExcel) {
    btnExportExcel.addEventListener('click', exportWeeklyRecordsToExcel);
  }

  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', exportWeeklyRecordsToCsv);
  }

  async function loadWeeklyRecords(targetWeek = '') {
    if (!recordsTableBody) return;
    try {
      recordsTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-4 text-muted">
            <span class="spinner-border spinner-border-sm me-2"></span> Loading weekly records...
          </td>
        </tr>
      `;

      const url = targetWeek ? `/api/submissions/history?week=${encodeURIComponent(targetWeek)}` : '/api/submissions/history';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load weekly records');
      const data = await res.json();
      currentWeeklyRecords = data;

      // Populate week select if needed
      populateWeekSelect(data.weeks, data.selectedWeek);

      // Render records table & summary stats
      renderWeeklyRecords(data);
    } catch (err) {
      console.error('Error loading weekly records:', err);
      showAlert('danger', `Could not load weekly records: ${err.message}`);
    }
  }

  function populateWeekSelect(weeks = [], selectedWeek) {
    if (!recordsWeekSelect) return;
    recordsWeekSelect.innerHTML = '';

    // "All Weeks" option
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = '--- All Recorded Weeks (Complete History) ---';
    if (selectedWeek === 'all') allOpt.selected = true;
    recordsWeekSelect.appendChild(allOpt);

    // Individual weeks
    weeks.forEach((w) => {
      const opt = document.createElement('option');
      opt.value = w;
      const startDate = new Date(w + 'T00:00:00');
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 4);
      const fmtOptions = { month: 'short', day: 'numeric', year: 'numeric' };
      opt.textContent = `Week: ${startDate.toLocaleDateString(undefined, fmtOptions)} - ${endDate.toLocaleDateString(undefined, fmtOptions)} (${w})`;
      if (w === selectedWeek) opt.selected = true;
      recordsWeekSelect.appendChild(opt);
    });

    if (!selectedWeek && weeks.length > 0) {
      recordsWeekSelect.value = weeks[0];
    }
  }

  function renderWeeklyRecords(data) {
    const { selectedWeek, records = [] } = data;

    let totalPages = 0;
    let submittedCount = 0;
    let pendingCount = 0;

    if (recSelectedWeekBadge) {
      recSelectedWeekBadge.textContent = selectedWeek === 'all' 
        ? 'Showing All Historical Weeks' 
        : `Week Starting: ${selectedWeek}`;
    }

    if (records.length === 0) {
      recordsTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-4 text-muted">
            <i class="bi bi-inbox fs-4 d-block mb-1 text-secondary"></i>
            No records found for the selected week.
          </td>
        </tr>
      `;
      if (recordsTableFoot) recordsTableFoot.innerHTML = '';
      if (recStatTotalDepts) recStatTotalDepts.textContent = '0';
      if (recStatSubmitted) recStatSubmitted.textContent = '0';
      if (recStatPending) recStatPending.textContent = '0';
      if (recStatTotalPages) recStatTotalPages.textContent = '0';
      return;
    }

    let rowsHtml = '';
    records.forEach((r, idx) => {
      const isSubmitted = r.status === 'Submitted';
      const count = isSubmitted ? (r.print_count || 0) : 0;
      if (isSubmitted) {
        totalPages += count;
        submittedCount++;
      } else {
        pendingCount++;
      }

      let photoBadge = '';
      const safeDept = escapeHtml(r.department_name);
      const safeSup = escapeHtml(r.supervisor_name || (isSubmitted ? 'Supervisor' : '-'));
      const countFormatted = count.toLocaleString();
      const submittedDate = r.submitted_at 
        ? new Date(r.submitted_at).toLocaleString() 
        : '<span class="text-muted">-</span>';

      if (r.screenshot_path) {
        photoBadge = `
          <button type="button" 
                  class="btn btn-xs btn-primary p-1 py-0 ms-1 d-inline-flex align-items-center shadow-sm" 
                  style="font-size:0.72rem;" 
                  onclick="viewPhoto('${r.screenshot_path}', '${safeDept}', '${safeSup}', '${countFormatted}', '${r.submitted_at ? new Date(r.submitted_at).toLocaleString() : ''}')" 
                  title="View attached counter photo">
            <i class="bi bi-image me-1"></i> Photo
          </button>
        `;
      } else if (isSubmitted && r.id) {
        photoBadge = `
          <button type="button" 
                  class="btn btn-xs btn-outline-secondary p-1 py-0 ms-1" 
                  style="font-size:0.68rem;" 
                  onclick="openAttachModal(${r.id}, '${safeDept}')" 
                  title="Attach counter photo">
            <i class="bi bi-upload me-1"></i> Attach
          </button>
        `;
      }

      const statusBadge = isSubmitted
        ? `<span class="badge bg-success-subtle text-success border border-success-subtle p-2"><i class="bi bi-check-circle-fill me-1"></i> Submitted</span>
           ${r.id ? '<div class="mt-1"><button type="button" class="btn btn-outline-danger btn-xs py-0 px-2 shadow-sm" style="font-size:0.68rem;" onclick="adminDeleteSubmission(' + r.id + ', \'' + safeDept + '\', \'' + countFormatted + '\')" title="Delete incorrect submission"><i class="bi bi-trash3 me-1"></i> Delete</button></div>' : ''}`
        : '<span class="badge bg-warning-subtle text-dark border border-warning-subtle p-2"><i class="bi bi-hourglass-split me-1"></i> Pending</span>';

      rowsHtml += `
        <tr>
          <td class="text-center">${idx + 1}</td>
          <td><span class="badge bg-light text-dark border">${r.week_start_date}</span></td>
          <td><strong>${escapeHtml(r.department_name)}</strong></td>
          <td>
            ${escapeHtml(r.supervisor_name || (isSubmitted ? 'Supervisor' : '-'))}
            ${r.pc_name ? ' <div class="small text-muted mt-1"><span class="badge bg-light text-secondary border"><i class="bi bi-pc me-1"></i>' + escapeHtml(r.pc_name) + '</span></div>' : ''}
          </td>
          <td class="text-end fw-bold fs-6">${isSubmitted ? count.toLocaleString() : '0'} ${photoBadge}</td>
          <td class="text-center">${statusBadge}</td>
          <td class="small">${submittedDate}</td>
        </tr>
      `;
    });

    recordsTableBody.innerHTML = rowsHtml;

    // Table Footer Total Row
    if (recordsTableFoot) {
      recordsTableFoot.innerHTML = `
        <tr>
          <td colspan="4" class="text-end text-uppercase">Total Pages Printed (${records.length} Depts):</td>
          <td class="text-end text-success fs-5 fw-bold">${totalPages.toLocaleString()} Pages</td>
          <td colspan="2" class="text-center text-muted small">${submittedCount} Submitted / ${pendingCount} Pending</td>
        </tr>
      `;
    }

    // Update Stats
    if (recStatTotalDepts) recStatTotalDepts.textContent = records.length;
    if (recStatSubmitted) recStatSubmitted.textContent = submittedCount;
    if (recStatPending) recStatPending.textContent = pendingCount;
    if (recStatTotalPages) recStatTotalPages.textContent = totalPages.toLocaleString();
  }

  // Export to Real Excel Workbook (.xlsx)
  function exportWeeklyRecordsToExcel() {
    if (!currentWeeklyRecords || !currentWeeklyRecords.records || currentWeeklyRecords.records.length === 0) {
      alert('No weekly records available to export.');
      return;
    }

    const { selectedWeek, records } = currentWeeklyRecords;
    let totalPages = 0;
    let submittedCount = 0;
    let pendingCount = 0;

    // Prepare Excel rows
    const excelRows = [
      ['MALIBAN BISCUIT MANUFACTORIES (PVT) LIMITED'],
      ['IT Department - Weekly Department Printer Counter Records'],
      [`Reporting Week: ${selectedWeek === 'all' ? 'All Recorded Weeks' : selectedWeek}`, `Exported on: ${new Date().toLocaleString()}`],
      [], // blank line
      ['#', 'Reporting Week', 'Department Name', 'Supervisor Name', 'Print Count (Pages)', 'Status', 'Submitted Date', 'Photo Attached', 'Remarks']
    ];

    records.forEach((r, idx) => {
      const isSubmitted = r.status === 'Submitted';
      const count = isSubmitted ? (r.print_count || 0) : 0;
      if (isSubmitted) {
        totalPages += count;
        submittedCount++;
      } else {
        pendingCount++;
      }

      excelRows.push([
        idx + 1,
        r.week_start_date,
        r.department_name,
        r.supervisor_name || (isSubmitted ? 'Supervisor' : 'N/A'),
        count,
        r.status || 'Pending',
        r.submitted_at ? new Date(r.submitted_at).toLocaleString() : 'N/A',
        r.screenshot_path ? 'Yes' : 'No',
        r.notes || ''
      ]);
    });

    // Summary footer row
    excelRows.push([]);
    excelRows.push(['', 'TOTALS', `${records.length} Departments`, `${submittedCount} Submitted / ${pendingCount} Pending`, totalPages, '', '', '', '']);

    // Check if SheetJS (XLSX) is available
    if (window.XLSX) {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(excelRows);

      // Auto-fit column widths
      ws['!cols'] = [
        { wch: 6 },
        { wch: 16 },
        { wch: 30 },
        { wch: 24 },
        { wch: 20 },
        { wch: 14 },
        { wch: 22 },
        { wch: 15 },
        { wch: 35 }
      ];

      XLSX.utils.book_append_sheet(wb, ws, 'Weekly Print Records');
      const filename = `Maliban_Print_Records_${selectedWeek === 'all' ? 'All_Weeks' : selectedWeek}.xlsx`;
      XLSX.writeFile(wb, filename);

      showAlert('success', `<i class="bi bi-file-earmark-excel-fill me-1"></i> Excel file exported successfully: <strong>${filename}</strong>`);
    } else {
      // Fallback to CSV if XLSX library is not yet loaded
      exportWeeklyRecordsToCsv();
    }
  }

  // Export to CSV spreadsheet
  function exportWeeklyRecordsToCsv() {
    if (!currentWeeklyRecords || !currentWeeklyRecords.records || currentWeeklyRecords.records.length === 0) {
      alert('No weekly records available to export.');
      return;
    }

    const { selectedWeek, records } = currentWeeklyRecords;
    const header = ['#', 'Reporting Week', 'Department Name', 'Supervisor Name', 'Print Count (Pages)', 'Status', 'Submitted Date', 'Photo Attached', 'Remarks'];
    
    let totalPages = 0;
    const csvRows = [header.map(h => `"${h}"`).join(',')];

    records.forEach((r, idx) => {
      const isSubmitted = r.status === 'Submitted';
      const count = isSubmitted ? (r.print_count || 0) : 0;
      if (isSubmitted) totalPages += count;

      const row = [
        idx + 1,
        r.week_start_date,
        r.department_name,
        r.supervisor_name || (isSubmitted ? 'Supervisor' : 'N/A'),
        count,
        r.status || 'Pending',
        r.submitted_at ? new Date(r.submitted_at).toLocaleString() : 'N/A',
        r.screenshot_path ? 'Yes' : 'No',
        (r.notes || '').replace(/"/g, '""')
      ];
      csvRows.push(row.map(cell => `"${cell}"`).join(','));
    });

    csvRows.push(`"","TOTALS","","","${totalPages}","","","",""`);

    // UTF-8 BOM so Excel opens CSV without encoding issues
    const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const filename = `Maliban_Print_Records_${selectedWeek === 'all' ? 'All_Weeks' : selectedWeek}.csv`;
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showAlert('success', `<i class="bi bi-filetype-csv me-1"></i> CSV file exported successfully: <strong>${filename}</strong>`);
  }

  // ==========================================
  // 11. COUNTER PHOTO MODAL & ATTACH HANDLERS
  // ==========================================
  // 11. COUNTER PHOTO MODAL & ATTACH HANDLERS
  // ==========================================
  // Lightbox Modal for Viewing Full Resolution Counter Photo
  let activeViewPhotoSubId = null;
  let activeViewPhotoDept = null;
  let activeContextPhotoData = null;

  window.viewPhoto = function(url, deptName, supervisor, printCount, submittedTime, subId) {
    const modalEl = document.getElementById('viewPhotoModal');
    if (!modalEl) return;

    activeViewPhotoSubId = subId || null;
    activeViewPhotoDept = deptName || null;

    document.getElementById('viewPhotoModalImg').src = url;
    document.getElementById('viewPhotoModalDept').textContent = deptName || '-';
    document.getElementById('viewPhotoModalSupervisor').textContent = supervisor || '-';
    document.getElementById('viewPhotoModalCount').textContent = printCount ? `${printCount} Pages` : '-';
    document.getElementById('viewPhotoModalTime').textContent = submittedTime || '-';

    const openBtn = document.getElementById('viewPhotoModalOpenBtn');
    if (openBtn) openBtn.href = url;

    const downloadBtn = document.getElementById('viewPhotoModalDownloadBtn');
    if (downloadBtn) {
      downloadBtn.href = url;
      downloadBtn.download = `Maliban_Counter_${(deptName || 'Dept').replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;
    }

    const deleteBtn = document.getElementById('viewPhotoModalDeleteBtn');
    if (deleteBtn) {
      deleteBtn.style.display = activeViewPhotoSubId ? 'inline-block' : 'none';
    }

    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  };

  // Wire Modal Delete Photo Button
  const viewPhotoModalDeleteBtn = document.getElementById('viewPhotoModalDeleteBtn');
  if (viewPhotoModalDeleteBtn) {
    viewPhotoModalDeleteBtn.addEventListener('click', async () => {
      if (!activeViewPhotoSubId) {
        alert('No submission ID associated with this photo.');
        return;
      }
      if (!confirm(`Are you sure you want to permanently delete the counter photo for ${activeViewPhotoDept || 'this department'}?`)) {
        return;
      }

      viewPhotoModalDeleteBtn.disabled = true;
      viewPhotoModalDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Deleting...';

      try {
        const res = await fetch(`/api/admin/submissions/${activeViewPhotoSubId}/screenshot`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to delete photo.');

        const modalEl = document.getElementById('viewPhotoModal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();

        showAlert('success', '<i class="bi bi-trash-fill me-1"></i> Counter photo was deleted successfully.');
        await loadDashboardData();
        if (recordsWeekSelect) loadWeeklyRecords(recordsWeekSelect.value);
      } catch (err) {
        alert('Error deleting photo: ' + err.message);
      } finally {
        viewPhotoModalDeleteBtn.disabled = false;
        viewPhotoModalDeleteBtn.innerHTML = '<i class="bi bi-trash-fill me-1"></i> Delete Photo';
      }
    });
  }

  // Delete / Reset Submission to allow re-entry
  window.adminDeleteSubmission = async function(subId, deptName, countFormatted) {
    if (!subId) return;
    if (!confirm(`Are you sure you want to delete the print count for "${deptName}" (${countFormatted} pages)?\n\nThis will remove the current submission and reset the department back to "Pending" so the supervisor can re-enter the correct count.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/submissions/${subId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete submission');

      showAlert('success', `<i class="bi bi-check-circle-fill me-1"></i> ${data.message || 'Submission deleted successfully.'}`);
      await loadDashboardData();
      if (recordsWeekSelect) loadWeeklyRecords(recordsWeekSelect.value);
    } catch (err) {
      alert('Error deleting submission: ' + err.message);
    }
  };

  // Right-Click Context Menu on Counter Photo
  const photoContextMenu = document.getElementById('photoContextMenu');
  const ctxViewPhoto = document.getElementById('ctxViewPhoto');
  const ctxOpenNewTab = document.getElementById('ctxOpenNewTab');
  const ctxDownloadPhoto = document.getElementById('ctxDownloadPhoto');
  const ctxDeletePhoto = document.getElementById('ctxDeletePhoto');

  document.addEventListener('contextmenu', (e) => {
    const target = e.target.closest('.photo-context-target');
    if (!target) {
      if (photoContextMenu) photoContextMenu.style.display = 'none';
      return;
    }

    e.preventDefault();
    const subId = target.dataset.subId ? parseInt(target.dataset.subId, 10) : null;
    const photoUrl = target.dataset.photoUrl;
    const dept = target.dataset.dept;
    const sup = target.dataset.sup;
    const count = target.dataset.count;
    const time = target.dataset.time;

    activeContextPhotoData = { subId, photoUrl, dept, sup, count, time };

    if (photoContextMenu) {
      let x = e.clientX;
      let y = e.clientY;
      const menuWidth = 230;
      const menuHeight = 180;
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
      if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;

      photoContextMenu.style.left = `${x}px`;
      photoContextMenu.style.top = `${y}px`;
      photoContextMenu.style.display = 'block';

      if (ctxOpenNewTab) ctxOpenNewTab.href = photoUrl;
      if (ctxDownloadPhoto) {
        ctxDownloadPhoto.href = photoUrl;
        ctxDownloadPhoto.download = `Maliban_Counter_${(dept || 'Dept').replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (photoContextMenu && !photoContextMenu.contains(e.target)) {
      photoContextMenu.style.display = 'none';
    }
  });

  if (ctxViewPhoto) {
    ctxViewPhoto.addEventListener('click', () => {
      if (!activeContextPhotoData) return;
      if (photoContextMenu) photoContextMenu.style.display = 'none';
      window.viewPhoto(
        activeContextPhotoData.photoUrl,
        activeContextPhotoData.dept,
        activeContextPhotoData.sup,
        activeContextPhotoData.count,
        activeContextPhotoData.time,
        activeContextPhotoData.subId
      );
    });
  }

  if (ctxDeletePhoto) {
    ctxDeletePhoto.addEventListener('click', async () => {
      if (!activeContextPhotoData || !activeContextPhotoData.subId) return;
      if (photoContextMenu) photoContextMenu.style.display = 'none';

      const deptName = activeContextPhotoData.dept || 'this department';
      if (!confirm(`Are you sure you want to permanently delete the counter photo for ${deptName}?`)) {
        return;
      }

      try {
        const res = await fetch(`/api/admin/submissions/${activeContextPhotoData.subId}/screenshot`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to delete photo.');

        showAlert('success', `<i class="bi bi-trash-fill me-1"></i> Counter photo for ${escapeHtml(deptName)} was deleted successfully.`);
        await loadDashboardData();
        if (recordsWeekSelect) loadWeeklyRecords(recordsWeekSelect.value);
      } catch (err) {
        alert('Error deleting photo: ' + err.message);
      }
    });
  }

  // Open Attach Counter Photo Modal
  let adminSelectedPhotoBase64 = null;
  window.openAttachModal = function(submissionId, deptName) {
    const modalEl = document.getElementById('attachPhotoModal');
    if (!modalEl) return;

    document.getElementById('attachPhotoSubId').value = submissionId;
    document.getElementById('attachPhotoDeptName').textContent = deptName;
    document.getElementById('adminPhotoInput').value = '';
    document.getElementById('adminPhotoPreviewBox').classList.add('d-none');
    document.getElementById('adminPhotoPreviewImg').src = '';
    adminSelectedPhotoBase64 = null;

    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  };

  // Handle Photo selection in Attach Modal (5 MB limit, PNG/JPG)
  const adminPhotoInput = document.getElementById('adminPhotoInput');
  if (adminPhotoInput) {
    adminPhotoInput.addEventListener('change', () => {
      const file = adminPhotoInput.files[0];
      if (!file) {
        adminSelectedPhotoBase64 = null;
        document.getElementById('adminPhotoPreviewBox').classList.add('d-none');
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        alert(`File exceeds the 5 MB maximum limit (${(file.size / (1024 * 1024)).toFixed(2)} MB). Please select a smaller photo.`);
        adminPhotoInput.value = '';
        adminSelectedPhotoBase64 = null;
        document.getElementById('adminPhotoPreviewBox').classList.add('d-none');
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        adminSelectedPhotoBase64 = e.target.result;
        document.getElementById('adminPhotoPreviewImg').src = adminSelectedPhotoBase64;
        document.getElementById('adminPhotoInfo').textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
        document.getElementById('adminPhotoPreviewBox').classList.remove('d-none');
      };
      reader.readAsDataURL(file);
    });
  }

  // Handle Save Photo submission by Admin
  const formAttachPhoto = document.getElementById('formAttachPhoto');
  if (formAttachPhoto) {
    formAttachPhoto.addEventListener('submit', async (e) => {
      e.preventDefault();
      const subId = document.getElementById('attachPhotoSubId').value;
      if (!subId || !adminSelectedPhotoBase64) {
        alert('Please select a valid image file first.');
        return;
      }

      const btnSave = document.getElementById('btnSaveAdminPhoto');
      btnSave.disabled = true;
      btnSave.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Uploading...';

      try {
        const res = await fetch(`/api/admin/submissions/${subId}/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ screenshot_base64: adminSelectedPhotoBase64 })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to attach photo.');

        showAlert('success', '<i class="bi bi-check-circle-fill me-1"></i> Counter photo attached successfully!');

        const modalEl = document.getElementById('attachPhotoModal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();

        await loadDashboardData();
        if (recordsWeekSelect) loadWeeklyRecords(recordsWeekSelect.value);
      } catch (err) {
        alert('Error attaching photo: ' + err.message);
      } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = '<i class="bi bi-cloud-arrow-up-fill me-1"></i> Save Photo';
      }
    });
  }

  // =========================================================
  // STAR SCHEMA MASTER DATA CRUD
  // =========================================================

  let cachedUsers = [];
  let cachedDepartments = [];
  let cachedPrinters = [];
  let currentReportData = null;

  const tabCrudBtn = document.getElementById('tab-crud-btn');

  if (tabCrudBtn) {
    tabCrudBtn.addEventListener('click', () => {
      loadUserMaster();
    });
  }

  const crudUsersTab = document.getElementById('crud-users-tab');
  const crudDeptsTab = document.getElementById('crud-depts-tab');
  const crudPrintersTab = document.getElementById('crud-printers-tab');
  const crudDatesTab = document.getElementById('crud-dates-tab');
  const crudFactsTab = document.getElementById('crud-facts-tab');

  if (crudUsersTab) crudUsersTab.addEventListener('click', loadUserMaster);
  if (crudDeptsTab) crudDeptsTab.addEventListener('click', loadDeptMaster);
  if (crudPrintersTab) crudPrintersTab.addEventListener('click', loadPrinterMaster);
  if (crudDatesTab) crudDatesTab.addEventListener('click', loadDateMaster);
  if (crudFactsTab) crudFactsTab.addEventListener('click', loadFactTable);

  // ---------------------------------------------------------
  // A. USER MASTER CRUD
  // ---------------------------------------------------------
  const userMasterTableBody = document.getElementById('userMasterTableBody');
  const btnOpenAddUser = document.getElementById('btnOpenAddUser');
  const formUserMaster = document.getElementById('formUserMaster');
  const userMasterModal = document.getElementById('userMasterModal');
  const userMasterModalTitle = document.getElementById('userMasterModalTitle');
  const userUidInput = document.getElementById('userUidInput');
  const userNameInput = document.getElementById('userNameInput');
  const userPcInput = document.getElementById('userPcInput');
  const userMacInput = document.getElementById('userMacInput');
  const userPasswordInput = document.getElementById('userPasswordInput');
  const userRoleSelect = document.getElementById('userRoleSelect');
  const userDeptSelect = document.getElementById('userDeptSelect');
  const userPassHelp = document.getElementById('userPassHelp');
  const userPassRequiredStar = document.getElementById('userPassRequiredStar');

  async function loadUserMaster() {
    if (!userMasterTableBody) return;
    userMasterTableBody.innerHTML = '<tr><td colspan="7" class="text-center py-3 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading users...</td></tr>';
    try {
      const res = await fetch('/api/masters/users');
      const users = await res.json();
      cachedUsers = users;

      if (users.length === 0) {
        userMasterTableBody.innerHTML = '<tr><td colspan="7" class="text-center py-3 text-muted">No users found. Click "Add New User" to create one.</td></tr>';
        return;
      }

      userMasterTableBody.innerHTML = users.map(u => `
        <tr>
          <td class="fw-bold font-monospace">UID-${u.uid}</td>
          <td class="fw-semibold text-dark">${escapeHtml(u.name)}</td>
          <td><span class="badge bg-light text-dark border font-monospace">${escapeHtml(u.mac_address || 'N/A')}</span></td>
          <td><span class="badge bg-primary-subtle text-primary border border-primary-subtle font-monospace">${escapeHtml(u.pc_name || 'N/A')}</span></td>
          <td><span class="badge ${u.role === 'admin' ? 'bg-danger' : 'bg-secondary'}">${escapeHtml(u.role)}</span></td>
          <td><span class="badge bg-info-subtle text-dark border">${escapeHtml(u.department_name || 'None')}</span></td>
          <td class="text-center">
            <button class="btn btn-outline-primary btn-sm py-0 px-2 me-1" onclick="openEditUserModal(${u.uid})">Edit</button>
            <button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="deleteUserMaster(${u.uid}, '${escapeHtml(u.name)}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      userMasterTableBody.innerHTML = `<tr><td colspan="7" class="text-danger text-center">Failed to load: ${err.message}</td></tr>`;
    }
  }

  if (btnOpenAddUser) {
    btnOpenAddUser.addEventListener('click', async () => {
      userUidInput.value = '';
      userNameInput.value = '';
      userPcInput.value = '';
      userMacInput.value = '';
      userPasswordInput.value = '';
      userPasswordInput.required = true;
      if (userPassRequiredStar) userPassRequiredStar.classList.remove('d-none');
      if (userPassHelp) userPassHelp.textContent = 'Required for new users.';
      userRoleSelect.value = 'supervisor';
      userMasterModalTitle.innerHTML = '<i class="bi bi-person-plus-fill me-2"></i>Add New User';
      await populateDeptDropdown(userDeptSelect);
      const modal = new bootstrap.Modal(userMasterModal);
      modal.show();
    });
  }

  window.openEditUserModal = async function(uid) {
    const user = cachedUsers.find(u => u.uid === uid);
    if (!user) return;
    userUidInput.value = user.uid;
    userNameInput.value = user.name || '';
    userPcInput.value = user.pc_name || '';
    userMacInput.value = user.mac_address || '';
    userPasswordInput.value = '';
    userPasswordInput.required = false;
    if (userPassRequiredStar) userPassRequiredStar.classList.add('d-none');
    if (userPassHelp) userPassHelp.textContent = 'Leave blank to keep existing password.';
    userRoleSelect.value = user.role || 'supervisor';
    userMasterModalTitle.innerHTML = '<i class="bi bi-pencil-square me-2"></i>Edit User';
    await populateDeptDropdown(userDeptSelect, user.dep_id);
    const modal = new bootstrap.Modal(userMasterModal);
    modal.show();
  };

  if (formUserMaster) {
    formUserMaster.addEventListener('submit', async (e) => {
      e.preventDefault();
      const uid = userUidInput.value;
      const isEdit = Boolean(uid);
      const payload = {
        name: userNameInput.value.trim(),
        pc_name: userPcInput.value.trim(),
        mac_address: userMacInput.value.trim() || null,
        role: userRoleSelect.value,
        dep_id: userDeptSelect.value ? parseInt(userDeptSelect.value, 10) : null
      };

      if (userPasswordInput.value.trim()) {
        payload.password = userPasswordInput.value.trim();
      } else if (!isEdit) {
        alert('Password is required for new users.');
        return;
      }

      try {
        const url = isEdit ? `/api/masters/users/${uid}` : '/api/masters/users';
        const method = isEdit ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save user');

        bootstrap.Modal.getInstance(userMasterModal).hide();
        showAlert('success', `<i class="bi bi-check-circle-fill me-1"></i> User ${isEdit ? 'updated' : 'created'} successfully.`);
        await loadUserMaster();
      } catch (err) {
        alert('Save user error: ' + err.message);
      }
    });
  }

  window.deleteUserMaster = async function(uid, name) {
    if (!confirm(`Are you sure you want to delete user "${name}" (UID-${uid})?`)) return;
    try {
      const res = await fetch(`/api/masters/users/${uid}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      showAlert('success', 'User removed successfully.');
      await loadUserMaster();
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
  };

  // ---------------------------------------------------------
  // B. DEPARTMENT MASTER CRUD
  // ---------------------------------------------------------
  const deptMasterTableBody = document.getElementById('deptMasterTableBody');
  const btnOpenAddDeptMaster = document.getElementById('btnOpenAddDeptMaster');
  const formDeptMaster = document.getElementById('formDeptMaster');
  const deptMasterModal = document.getElementById('deptMasterModal');
  const deptMasterModalTitle = document.getElementById('deptMasterModalTitle');
  const deptIdInput = document.getElementById('deptIdInput');
  const deptNameInput = document.getElementById('deptNameInput');

  async function loadDeptMaster() {
    if (!deptMasterTableBody) return;
    deptMasterTableBody.innerHTML = '<tr><td colspan="5" class="text-center py-3 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading departments...</td></tr>';
    try {
      const res = await fetch('/api/masters/departments');
      const depts = await res.json();
      cachedDepartments = depts;

      if (depts.length === 0) {
        deptMasterTableBody.innerHTML = '<tr><td colspan="5" class="text-center py-3 text-muted">No departments found.</td></tr>';
        return;
      }

      deptMasterTableBody.innerHTML = depts.map(d => `
        <tr>
          <td class="fw-bold font-monospace">DEP-${d.dep_id}</td>
          <td class="fw-semibold text-dark fs-6">${escapeHtml(d.department_name)}</td>
          <td><span class="badge ${d.spooler_status === 'ACTIVE' ? 'bg-success' : 'bg-danger'}">${d.spooler_status || 'ACTIVE'}</span></td>
          <td><span class="badge bg-light text-dark border">${d.user_count || 0} Users</span></td>
          <td class="text-center">
            <button class="btn btn-outline-success btn-sm py-0 px-2 me-1" onclick="openEditDeptModal(${d.dep_id}, '${escapeHtml(d.department_name)}')">Edit</button>
            <button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="deleteDeptMaster(${d.dep_id}, '${escapeHtml(d.department_name)}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      deptMasterTableBody.innerHTML = `<tr><td colspan="5" class="text-danger text-center">Failed to load: ${err.message}</td></tr>`;
    }
  }

  if (btnOpenAddDeptMaster) {
    btnOpenAddDeptMaster.addEventListener('click', () => {
      deptIdInput.value = '';
      deptNameInput.value = '';
      deptMasterModalTitle.innerHTML = '<i class="bi bi-building-add me-2"></i>Add New Department';
      new bootstrap.Modal(deptMasterModal).show();
    });
  }

  window.openEditDeptModal = function(dep_id, name) {
    deptIdInput.value = dep_id;
    deptNameInput.value = name;
    deptMasterModalTitle.innerHTML = '<i class="bi bi-pencil-square me-2"></i>Edit Department';
    new bootstrap.Modal(deptMasterModal).show();
  };

  if (formDeptMaster) {
    formDeptMaster.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dep_id = deptIdInput.value;
      const isEdit = Boolean(dep_id);
      const department_name = deptNameInput.value.trim();

      try {
        const url = isEdit ? `/api/masters/departments/${dep_id}` : '/api/masters/departments';
        const method = isEdit ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ department_name })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save department');

        bootstrap.Modal.getInstance(deptMasterModal).hide();
        showAlert('success', `Department ${isEdit ? 'updated' : 'created'} successfully.`);
        await loadDeptMaster();
        await loadDashboardData(true);
      } catch (err) {
        alert('Save department error: ' + err.message);
      }
    });
  }

  window.deleteDeptMaster = async function(dep_id, name) {
    if (!confirm(`Are you sure you want to delete department "${name}" (DEP-${dep_id})?`)) return;
    try {
      const res = await fetch(`/api/masters/departments/${dep_id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      showAlert('success', 'Department removed successfully.');
      await loadDeptMaster();
      await loadDashboardData(true);
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
  };

  // ---------------------------------------------------------
  // C. PRINTER MASTER CRUD
  // ---------------------------------------------------------
  const printerMasterTableBody = document.getElementById('printerMasterTableBody');
  const btnOpenAddPrinterMaster = document.getElementById('btnOpenAddPrinterMaster');
  const formPrinterMaster = document.getElementById('formPrinterMaster');
  const printerMasterModal = document.getElementById('printerMasterModal');
  const printerMasterModalTitle = document.getElementById('printerMasterModalTitle');
  const printerIdInput = document.getElementById('printerIdInput');
  const printerModelInput = document.getElementById('printerModelInput');
  const printerSerialInput = document.getElementById('printerSerialInput');
  const printerLocationInput = document.getElementById('printerLocationInput');
  const printerDeptSelect = document.getElementById('printerDeptSelect');

  async function loadPrinterMaster() {
    if (!printerMasterTableBody) return;
    printerMasterTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-3 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading printers...</td></tr>';
    try {
      const res = await fetch('/api/masters/printers');
      const printers = await res.json();
      cachedPrinters = printers;

      if (printers.length === 0) {
        printerMasterTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-3 text-muted">No printers found.</td></tr>';
        return;
      }

      printerMasterTableBody.innerHTML = printers.map(p => `
        <tr>
          <td class="fw-bold font-monospace">PTR-${p.printer_id}</td>
          <td class="fw-semibold text-dark">${escapeHtml(p.printer_model || 'Standard')}</td>
          <td><span class="badge bg-light text-dark border font-monospace">${escapeHtml(p.serial_number)}</span></td>
          <td><span class="badge bg-secondary-subtle text-dark border">${escapeHtml(p.location || 'Maliban')}</span></td>
          <td><span class="badge bg-info-subtle text-dark border">${escapeHtml(p.department_name || 'General')}</span></td>
          <td class="text-center">
            <button class="btn btn-outline-info btn-sm py-0 px-2 me-1" onclick="openEditPrinterModal(${p.printer_id})">Edit</button>
            <button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="deletePrinterMaster(${p.printer_id}, '${escapeHtml(p.serial_number)}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      printerMasterTableBody.innerHTML = `<tr><td colspan="6" class="text-danger text-center">Failed to load: ${err.message}</td></tr>`;
    }
  }

  if (btnOpenAddPrinterMaster) {
    btnOpenAddPrinterMaster.addEventListener('click', async () => {
      printerIdInput.value = '';
      printerModelInput.value = '';
      printerSerialInput.value = '';
      printerLocationInput.value = '';
      printerMasterModalTitle.innerHTML = '<i class="bi bi-plus-circle-fill me-2"></i>Add New Printer';
      await populateDeptDropdown(printerDeptSelect);
      new bootstrap.Modal(printerMasterModal).show();
    });
  }

  window.openEditPrinterModal = async function(id) {
    const printer = cachedPrinters.find(p => p.printer_id === id);
    if (!printer) return;
    printerIdInput.value = printer.printer_id;
    printerModelInput.value = printer.printer_model || '';
    printerSerialInput.value = printer.serial_number || '';
    printerLocationInput.value = printer.location || '';
    printerMasterModalTitle.innerHTML = '<i class="bi bi-pencil-square me-2"></i>Edit Printer';
    await populateDeptDropdown(printerDeptSelect, printer.dep_id);
    new bootstrap.Modal(printerMasterModal).show();
  };

  if (formPrinterMaster) {
    formPrinterMaster.addEventListener('submit', async (e) => {
      e.preventDefault();
      const printer_id = printerIdInput.value;
      const isEdit = Boolean(printer_id);
      const payload = {
        printer_model: printerModelInput.value.trim(),
        serial_number: printerSerialInput.value.trim(),
        location: printerLocationInput.value.trim(),
        dep_id: printerDeptSelect.value ? parseInt(printerDeptSelect.value, 10) : null
      };

      try {
        const url = isEdit ? `/api/masters/printers/${printer_id}` : '/api/masters/printers';
        const method = isEdit ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save printer');

        bootstrap.Modal.getInstance(printerMasterModal).hide();
        showAlert('success', `Printer ${isEdit ? 'updated' : 'added'} successfully.`);
        await loadPrinterMaster();
      } catch (err) {
        alert('Save printer error: ' + err.message);
      }
    });
  }

  window.deletePrinterMaster = async function(printer_id, serial) {
    if (!confirm(`Are you sure you want to delete printer ${serial} (PTR-${printer_id})?`)) return;
    try {
      const res = await fetch(`/api/masters/printers/${printer_id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      showAlert('success', 'Printer removed successfully.');
      await loadPrinterMaster();
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
  };

  // ---------------------------------------------------------
  // D. DATE MASTER CRUD
  // ---------------------------------------------------------
  const dateMasterTableBody = document.getElementById('dateMasterTableBody');
  const btnAddDateMaster = document.getElementById('btnAddDateMaster');
  const newDateInput = document.getElementById('newDateInput');

  async function loadDateMaster() {
    if (!dateMasterTableBody) return;
    dateMasterTableBody.innerHTML = '<tr><td colspan="7" class="text-center py-3 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading dates...</td></tr>';
    try {
      const res = await fetch('/api/masters/dates');
      const dates = await res.json();

      if (dates.length === 0) {
        dateMasterTableBody.innerHTML = '<tr><td colspan="7" class="text-center py-3 text-muted">No dates generated. Pick a date above to add.</td></tr>';
        return;
      }

      dateMasterTableBody.innerHTML = dates.map(d => `
        <tr>
          <td class="fw-bold font-monospace">DATE-${d.date_id}</td>
          <td class="fw-semibold text-dark">${d.full_date}</td>
          <td>${d.year}</td>
          <td><span class="badge bg-primary-subtle text-primary border border-primary-subtle">Q${d.quarter}</span></td>
          <td>Month ${d.month}</td>
          <td><span class="badge bg-light text-dark border">Week ${d.week}</span></td>
          <td>Day ${d.day}</td>
        </tr>
      `).join('');
    } catch (err) {
      dateMasterTableBody.innerHTML = `<tr><td colspan="7" class="text-danger text-center">Failed to load: ${err.message}</td></tr>`;
    }
  }

  if (btnAddDateMaster) {
    btnAddDateMaster.addEventListener('click', async () => {
      const dateVal = newDateInput ? newDateInput.value : '';
      if (!dateVal) {
        alert('Please select a date.');
        return;
      }
      try {
        const res = await fetch('/api/masters/dates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateVal })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add date');
        showAlert('success', `Date ${dateVal} added / verified in Date Master.`);
        await loadDateMaster();
      } catch (err) {
        alert('Date error: ' + err.message);
      }
    });
  }

  // ---------------------------------------------------------
  // E. FACT TABLE: PRINTER_COUNT CRUD
  // ---------------------------------------------------------
  const factTableBody = document.getElementById('factTableBody');
  const btnOpenAddFactCount = document.getElementById('btnOpenAddFactCount');
  const formFactCount = document.getElementById('formFactCount');
  const factCountModal = document.getElementById('factCountModal');
  const factCountModalTitle = document.getElementById('factCountModalTitle');
  const factCountIdInput = document.getElementById('factCountIdInput');
  const factDeptSelect = document.getElementById('factDeptSelect');
  const factUserSelect = document.getElementById('factUserSelect');
  const factPrinterSelect = document.getElementById('factPrinterSelect');
  const factDateInput = document.getElementById('factDateInput');
  const factPrintCountInput = document.getElementById('factPrintCountInput');
  const factPhotoInput = document.getElementById('factPhotoInput');
  const factNotesInput = document.getElementById('factNotesInput');

  let factPhotoBase64 = null;
  if (factPhotoInput) {
    factPhotoInput.addEventListener('change', () => {
      const file = factPhotoInput.files[0];
      if (!file) { factPhotoBase64 = null; return; }
      const reader = new FileReader();
      reader.onload = (e) => { factPhotoBase64 = e.target.result; };
      reader.readAsDataURL(file);
    });
  }

  async function loadFactTable() {
    if (!factTableBody) return;
    factTableBody.innerHTML = '<tr><td colspan="9" class="text-center py-3 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading fact entries...</td></tr>';
    try {
      const res = await fetch('/api/facts/printer-counts?limit=100');
      const records = await res.json();

      if (records.length === 0) {
        factTableBody.innerHTML = '<tr><td colspan="9" class="text-center py-3 text-muted">No fact entries recorded yet. Click "Log Print Count" to add.</td></tr>';
        return;
      }

      factTableBody.innerHTML = records.map(r => `
        <tr>
          <td class="fw-bold font-monospace">CNT-${r.count_id}</td>
          <td>
            <div class="fw-semibold text-dark">${r.full_date || 'N/A'}</div>
            <div class="text-muted small">Q${r.quarter} | Month ${r.month}</div>
          </td>
          <td><span class="badge bg-light text-dark border">${escapeHtml(r.department_name || 'N/A')}</span></td>
          <td>
            <div class="fw-semibold">${escapeHtml(r.user_name || 'Supervisor')}</div>
            <div class="text-muted small font-monospace">${escapeHtml(r.pc_name || '')}</div>
          </td>
          <td>
            <div class="fw-semibold text-truncate" style="max-width: 150px;">${escapeHtml(r.printer_model || 'Printer')}</div>
            <div class="text-muted small font-monospace">${escapeHtml(r.serial_number || '')}</div>
          </td>
          <td>
            <span class="badge bg-primary-subtle text-primary border border-primary-subtle px-2 py-1 fs-6 fw-bold">
              ${(r.print_count || 0).toLocaleString()}
            </span>
          </td>
          <td>
            ${r.screenshot_path ? `
              <a href="${r.screenshot_path}" target="_blank" class="btn btn-sm btn-outline-info p-1 px-2" title="View Counter Photo">
                <i class="bi bi-image"></i>
              </a>
            ` : '<span class="text-muted small">-</span>'}
          </td>
          <td class="small text-muted text-truncate" style="max-width: 140px;">${escapeHtml(r.notes || '-')}</td>
          <td class="text-center">
            <button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="deleteFactEntry(${r.count_id})">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      factTableBody.innerHTML = `<tr><td colspan="9" class="text-danger text-center">Failed to load: ${err.message}</td></tr>`;
    }
  }

  if (btnOpenAddFactCount) {
    btnOpenAddFactCount.addEventListener('click', async () => {
      factCountIdInput.value = '';
      factPrintCountInput.value = '';
      factNotesInput.value = '';
      if (factPhotoInput) factPhotoInput.value = '';
      factPhotoBase64 = null;
      factDateInput.value = new Date().toISOString().split('T')[0];
      factCountModalTitle.innerHTML = '<i class="bi bi-plus-lg me-2"></i>Log Print Count to Fact Table';

      await Promise.all([
        populateDeptDropdown(factDeptSelect),
        populateUserDropdown(factUserSelect),
        populatePrinterDropdown(factPrinterSelect)
      ]);

      new bootstrap.Modal(factCountModal).show();
    });
  }

  if (formFactCount) {
    formFactCount.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        dep_id: parseInt(factDeptSelect.value, 10),
        uid: parseInt(factUserSelect.value, 10),
        printer_id: parseInt(factPrinterSelect.value, 10),
        date: factDateInput.value,
        print_count: parseInt(factPrintCountInput.value, 10),
        notes: factNotesInput.value.trim() || null,
        screenshot_base64: factPhotoBase64
      };

      try {
        const res = await fetch('/api/facts/printer-counts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save print count');

        bootstrap.Modal.getInstance(factCountModal).hide();
        showAlert('success', 'Print count logged successfully into Fact Table.');
        await loadFactTable();
      } catch (err) {
        alert('Fact save error: ' + err.message);
      }
    });
  }

  window.deleteFactEntry = async function(count_id) {
    if (!confirm(`Are you sure you want to delete fact record CNT-${count_id}?`)) return;
    try {
      const res = await fetch(`/api/facts/printer-counts/${count_id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      showAlert('success', 'Fact record removed.');
      await loadFactTable();
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
  };

  async function populateDeptDropdown(selectEl, selectedId) {
    if (!selectEl) return;
    try {
      const res = await fetch('/api/masters/departments');
      const depts = await res.json();
      selectEl.innerHTML = '<option value="">-- Select Department --</option>';
      depts.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.dep_id;
        opt.textContent = `${d.department_name} (DEP-${d.dep_id})`;
        if (selectedId && d.dep_id === selectedId) opt.selected = true;
        selectEl.appendChild(opt);
      });
    } catch (e) {}
  }

  async function populateUserDropdown(selectEl, selectedId) {
    if (!selectEl) return;
    try {
      const res = await fetch('/api/masters/users');
      const users = await res.json();
      selectEl.innerHTML = '<option value="">-- Select User --</option>';
      users.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.uid;
        opt.textContent = `${u.name} [${u.pc_name || 'PC'}]`;
        if (selectedId && u.uid === selectedId) opt.selected = true;
        selectEl.appendChild(opt);
      });
    } catch (e) {}
  }

  async function populatePrinterDropdown(selectEl, selectedId) {
    if (!selectEl) return;
    try {
      const res = await fetch('/api/masters/printers');
      const printers = await res.json();
      selectEl.innerHTML = '<option value="">-- Select Printer --</option>';
      printers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.printer_id;
        opt.textContent = `${p.printer_model || 'Printer'} (${p.serial_number}) - ${p.location || 'General'}`;
        if (selectedId && p.printer_id === selectedId) opt.selected = true;
        selectEl.appendChild(opt);
      });
    } catch (e) {}
  }

  // =========================================================================
  // SECTION: Weekly & Monthly Usage Charts (Chart.js)
  // =========================================================================
  let weeklyChartInstance = null;
  let monthlyChartInstance = null;

  const btnRefreshCharts = document.getElementById('btnRefreshCharts');
  const tabChartsBtn = document.getElementById('tab-charts-btn');

  if (btnRefreshCharts) {
    btnRefreshCharts.addEventListener('click', () => loadUsageCharts());
  }
  if (tabChartsBtn) {
    tabChartsBtn.addEventListener('shown.bs.tab', () => loadUsageCharts());
  }

  async function loadUsageCharts() {
    try {
      const res = await fetch('/api/analytics/usage-charts');
      if (!res.ok) throw new Error('Failed to load chart analytics');
      const data = await res.json();

      // Update KPI cards
      const elPrinters = document.getElementById('chartKpiTotalPrinters');
      const elWeeklyPages = document.getElementById('chartKpiWeeklyPages');
      const elMonthlyUsage = document.getElementById('chartKpiMonthlyUsage');
      const elLocations = document.getElementById('chartKpiTotalLocations');
      const elBadge = document.getElementById('chartsLastUpdatedBadge');

      if (elPrinters) elPrinters.textContent = (data.kpis && data.kpis.total_printers != null) ? data.kpis.total_printers : '0';
      if (elWeeklyPages) elWeeklyPages.textContent = (data.kpis && data.kpis.current_week_pages != null) ? Number(data.kpis.current_week_pages).toLocaleString() : '0';
      if (elMonthlyUsage) elMonthlyUsage.textContent = (data.kpis && data.kpis.latest_monthly_usage != null) ? Number(data.kpis.latest_monthly_usage).toLocaleString() : '0';
      if (elLocations) elLocations.textContent = (data.kpis && data.kpis.total_locations != null) ? data.kpis.total_locations : '0';
      if (elBadge) {
        elBadge.innerHTML = `<i class="bi bi-clock-history me-1"></i>Updated: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }

      // 1. Weekly Usage Chart
      const weeklyCanvas = document.getElementById('weeklyUsageChart');
      const weeklyEmpty = document.getElementById('weeklyChartEmptyNote');
      if (weeklyCanvas && typeof Chart !== 'undefined') {
        const weeklyLabels = (data.weekly && data.weekly.labels) || [];
        const weeklyValues = (data.weekly && data.weekly.data) || [];

        if (weeklyEmpty) {
          if (weeklyLabels.length === 0 || weeklyValues.every(v => v === 0)) {
            weeklyEmpty.classList.remove('d-none');
          } else {
            weeklyEmpty.classList.add('d-none');
          }
        }

        if (weeklyChartInstance) {
          weeklyChartInstance.destroy();
        }

        const ctxWeekly = weeklyCanvas.getContext('2d');
        weeklyChartInstance = new Chart(ctxWeekly, {
          type: 'line',
          data: {
            labels: weeklyLabels.length > 0 ? weeklyLabels : ['No Submissions'],
            datasets: [{
              label: 'Weekly Total Printed Pages',
              data: weeklyValues.length > 0 ? weeklyValues : [0],
              borderColor: '#0d6efd',
              backgroundColor: 'rgba(13, 110, 253, 0.15)',
              borderWidth: 2.5,
              pointBackgroundColor: '#0d6efd',
              pointRadius: 4,
              pointHoverRadius: 6,
              fill: true,
              tension: 0.3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: true, position: 'top' },
              tooltip: {
                callbacks: {
                  label: (context) => ` Total Pages: ${Number(context.parsed.y).toLocaleString()}`
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  callback: (value) => Number(value).toLocaleString()
                },
                title: { display: true, text: 'Pages Printed' }
              },
              x: {
                title: { display: true, text: 'Reporting Week Cycle' }
              }
            }
          }
        });
      }

      // 2. Monthly Usage Chart
      const monthlyCanvas = document.getElementById('monthlyUsageChart');
      const monthlyEmpty = document.getElementById('monthlyChartEmptyNote');
      if (monthlyCanvas && typeof Chart !== 'undefined') {
        const monthlyLabels = (data.monthly && data.monthly.labels) || [];
        const monthlyValues = (data.monthly && data.monthly.data) || [];

        if (monthlyEmpty) {
          if (monthlyLabels.length === 0 || monthlyValues.every(v => v === 0)) {
            monthlyEmpty.classList.remove('d-none');
          } else {
            monthlyEmpty.classList.add('d-none');
          }
        }

        if (monthlyChartInstance) {
          monthlyChartInstance.destroy();
        }

        const ctxMonthly = monthlyCanvas.getContext('2d');
        monthlyChartInstance = new Chart(ctxMonthly, {
          type: 'bar',
          data: {
            labels: monthlyLabels.length > 0 ? monthlyLabels : ['No Readings'],
            datasets: [{
              label: 'Monthly Net Usage (Pages)',
              data: monthlyValues.length > 0 ? monthlyValues : [0],
              backgroundColor: 'rgba(25, 135, 84, 0.75)',
              borderColor: '#198754',
              borderWidth: 1.5,
              borderRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: true, position: 'top' },
              tooltip: {
                callbacks: {
                  label: (context) => ` Net Usage: ${Number(context.parsed.y).toLocaleString()} pages`
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  callback: (value) => Number(value).toLocaleString()
                },
                title: { display: true, text: 'Pages Consumed (Usage)' }
              },
              x: {
                title: { display: true, text: 'Month (n month)' }
              }
            }
          }
        });
      }
    } catch (err) {
      console.error('Error loading usage charts:', err);
    }
  }

  // =========================================================================
  // SECTION: Monthly Printer Usage Report
  // =========================================================================
  const tabMonthlyReportBtn = document.getElementById('tab-monthly-report-btn');
  const monthlyReportMonthSelect = document.getElementById('monthlyReportMonthSelect');
  const btnRefreshMonthlyReport = document.getElementById('btnRefreshMonthlyReport');
  const btnOpenLogMonthlyModal = document.getElementById('btnOpenLogMonthlyModal');
  const btnCopyMonthlyReport = document.getElementById('btnCopyMonthlyReport');
  const btnExportMonthlyExcel = document.getElementById('btnExportMonthlyExcel');
  const btnPrintMonthlyReport = document.getElementById('btnPrintMonthlyReport');
  const monthlyReportTableBody = document.getElementById('monthlyReportTableBody');
  const formLogMonthlyReading = document.getElementById('formLogMonthlyReading');

  let currentMonthlyReportData = null;

  if (tabMonthlyReportBtn) {
    tabMonthlyReportBtn.addEventListener('shown.bs.tab', async () => {
      await loadAvailableMonths();
      await loadMonthlyUsageReport();
    });
  }

  if (monthlyReportMonthSelect) {
    monthlyReportMonthSelect.addEventListener('change', () => {
      const selectedMonth = monthlyReportMonthSelect.value;
      loadMonthlyUsageReport(selectedMonth);
    });
  }

  if (btnRefreshMonthlyReport) {
    btnRefreshMonthlyReport.addEventListener('click', () => {
      const selectedMonth = monthlyReportMonthSelect ? monthlyReportMonthSelect.value : null;
      loadMonthlyUsageReport(selectedMonth);
    });
  }

  async function loadAvailableMonths() {
    if (!monthlyReportMonthSelect) return;
    try {
      const res = await fetch('/api/reports/available-months');
      if (!res.ok) throw new Error('Failed to fetch available months');
      const data = await res.json();
      const monthsList = Array.isArray(data) ? data : (data.months || []);

      const prevSelected = monthlyReportMonthSelect.value;
      monthlyReportMonthSelect.innerHTML = '';

      if (monthsList.length === 0) {
        // Default to current calendar month
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const curMonth = `${yyyy}-${mm}`;
        const opt = document.createElement('option');
        opt.value = curMonth;
        opt.textContent = `${curMonth} (Current Month)`;
        monthlyReportMonthSelect.appendChild(opt);
        return;
      }

      monthsList.forEach(m => {
        const opt = document.createElement('option');
        const val = typeof m === 'object' ? (m.key || `${m.year}-${String(m.month).padStart(2, '0')}`) : m;
        const label = typeof m === 'object' ? (m.label || m.key) : m;
        opt.value = val;
        opt.textContent = label;
        monthlyReportMonthSelect.appendChild(opt);
      });

      const firstVal = typeof monthsList[0] === 'object' ? (monthsList[0].key || `${monthsList[0].year}-${String(monthsList[0].month).padStart(2, '0')}`) : monthsList[0];
      if (prevSelected) {
        monthlyReportMonthSelect.value = prevSelected;
      } else {
        monthlyReportMonthSelect.value = firstVal;
      }
    } catch (err) {
      console.error('Error loading available report months:', err);
    }
  }

  async function loadMonthlyUsageReport(monthStr) {
    if (!monthlyReportTableBody) return;

    if (!monthStr) {
      if (monthlyReportMonthSelect && monthlyReportMonthSelect.value) {
        monthStr = monthlyReportMonthSelect.value;
      } else {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        monthStr = `${yyyy}-${mm}`;
      }
    }

    monthlyReportTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-4 text-muted">
          <span class="spinner-border spinner-border-sm me-2"></span>Loading report for ${monthStr}...
        </td>
      </tr>
    `;

    try {
      const res = await fetch(`/api/reports/monthly-usage?month=${encodeURIComponent(monthStr)}`);
      if (!res.ok) throw new Error('Failed to load monthly report data');
      const data = await res.json();
      currentMonthlyReportData = data;

      const rows = data.rows || data.report || [];
      const totalN = (data.totalNCount != null) ? data.totalNCount : (data.totals ? data.totals.total_n_count : 0);
      const totalPrev = (data.totalPrevCount != null) ? data.totalPrevCount : (data.totals ? data.totals.total_prev_count : 0);
      const totalUse = (data.totalUsage != null) ? data.totalUsage : (data.totals ? data.totals.total_usage : 0);
      const monthTitle = data.targetMonthName || data.target_month || monthStr;

      const lblActive = document.getElementById('lblActiveReportMonth');
      const badgeCount = document.getElementById('badgeReportPrinterCount');
      const reportTime = document.getElementById('reportGeneratedTimeText');
      const tdTotalN = document.getElementById('tdTotalNCount');
      const tdTotalPrev = document.getElementById('tdTotalPrevCount');
      const tdTotalUsage = document.getElementById('tdTotalUsage');

      if (lblActive) lblActive.textContent = monthTitle;
      if (badgeCount) badgeCount.textContent = `${rows.length} Printers`;
      if (reportTime) reportTime.textContent = `Generated: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

      if (rows.length === 0) {
        monthlyReportTableBody.innerHTML = `
          <tr>
            <td colspan="5" class="text-center py-4 text-muted">
              <i class="bi bi-info-circle fs-5 d-block mb-1 text-secondary"></i>
              No meter readings recorded for month <strong>${monthTitle}</strong>.<br>
              Click <button class="btn btn-xs btn-outline-primary ms-1" onclick="document.getElementById('btnOpenLogMonthlyModal').click()">Record Meter Reading</button> to enter physical count.
            </td>
          </tr>
        `;
        if (tdTotalN) tdTotalN.textContent = '0';
        if (tdTotalPrev) tdTotalPrev.textContent = '0';
        if (tdTotalUsage) tdTotalUsage.textContent = '0';
        return;
      }

      let html = '';
      rows.forEach(r => {
        const nCount = Number((r.n_month_total != null) ? r.n_month_total : 0);
        const prevCount = Number((r.prev_month_total != null) ? r.prev_month_total : (r.prev_n_month_total != null ? r.prev_n_month_total : 0));
        const usageVal = Number((r.usage != null) ? r.usage : (r.n_month_usage != null ? r.n_month_usage : 0));
        const hasUsage = usageVal > 0;
        const usageClass = hasUsage ? 'text-success fw-bold' : (usageVal < 0 ? 'text-danger fw-bold' : 'text-muted');

        html += `
          <tr>
            <td class="fw-semibold text-dark">
              <i class="bi bi-geo-alt-fill text-danger me-1"></i>${escapeHtml(r.location || 'Unknown')}
              ${r.department_name ? `<span class="badge bg-light text-secondary border ms-1 small">${escapeHtml(r.department_name)}</span>` : ''}
            </td>
            <td class="font-monospace text-primary fw-bold">
              <i class="bi bi-printer me-1 text-muted"></i>${escapeHtml(r.serial_number || '-')}
              <span class="text-muted fw-normal small d-block">${escapeHtml(r.model || r.printer_model || '')}</span>
            </td>
            <td class="text-end fw-bold text-dark font-monospace" style="font-size: 1rem;">
              ${nCount.toLocaleString()}
            </td>
            <td class="text-end text-muted font-monospace" style="font-size: 0.95rem;">
              ${prevCount.toLocaleString()}
            </td>
            <td class="text-end font-monospace ${usageClass}" style="font-size: 1.05rem;">
              <span class="badge ${hasUsage ? 'bg-success-subtle text-success border border-success-subtle' : 'bg-light text-muted border'} px-2 py-1">
                ${usageVal.toLocaleString()} Pages
              </span>
            </td>
          </tr>
        `;
      });
      monthlyReportTableBody.innerHTML = html;

      if (tdTotalN) tdTotalN.textContent = Number(totalN).toLocaleString();
      if (tdTotalPrev) tdTotalPrev.textContent = Number(totalPrev).toLocaleString();
      if (tdTotalUsage) tdTotalUsage.textContent = `${Number(totalUse).toLocaleString()} Pages`;

    } catch (err) {
      console.error('Error rendering monthly usage report:', err);
      monthlyReportTableBody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center py-4 text-danger">
            <i class="bi bi-exclamation-triangle-fill me-1"></i> Failed to load report: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }

  // Modal: Record Monthly Reading
  if (btnOpenLogMonthlyModal) {
    btnOpenLogMonthlyModal.addEventListener('click', async () => {
      const selectEl = document.getElementById('logMonthlyPrinterSelect');
      await populatePrinterDropdown(selectEl);

      const monthInput = document.getElementById('logMonthlyMonthInput');
      const dateInput = document.getElementById('logMonthlyReadingDateInput');
      const countInput = document.getElementById('logMonthlyTotalCountInput');
      const notesInput = document.getElementById('logMonthlyNotesInput');

      const activeMonth = monthlyReportMonthSelect ? monthlyReportMonthSelect.value : '';
      if (monthInput) {
        if (activeMonth && /^\d{4}-\d{2}$/.test(activeMonth)) {
          monthInput.value = activeMonth;
        } else {
          const now = new Date();
          monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }
      }
      if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
      }
      if (countInput) countInput.value = '';
      if (notesInput) notesInput.value = '';

      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('modalLogMonthlyReading'));
      modal.show();
    });
  }

  if (formLogMonthlyReading) {
    formLogMonthlyReading.addEventListener('submit', async (e) => {
      e.preventDefault();
      const printerId = document.getElementById('logMonthlyPrinterSelect').value;
      const monthVal = document.getElementById('logMonthlyMonthInput').value;
      const readingDate = document.getElementById('logMonthlyReadingDateInput').value;
      const cumulativeCount = document.getElementById('logMonthlyTotalCountInput').value;
      const notes = document.getElementById('logMonthlyNotesInput').value.trim();

      if (!printerId || !monthVal || !cumulativeCount) {
        alert('Printer, Month, and Total Count are required.');
        return;
      }

      let y = null;
      let m = null;
      if (monthVal.includes('-')) {
        const parts = monthVal.split('-');
        y = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10);
      } else {
        y = new Date().getFullYear();
        m = parseInt(monthVal, 10);
      }

      const btnSave = document.getElementById('btnSaveMonthlyReading');
      const origText = btnSave ? btnSave.innerHTML : 'Save';
      if (btnSave) {
        btnSave.disabled = true;
        btnSave.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';
      }

      try {
        const res = await fetch('/api/reports/monthly-reading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            printer_id: parseInt(printerId, 10),
            year: y,
            month: m,
            total_count: parseInt(cumulativeCount, 10),
            cumulative_count: parseInt(cumulativeCount, 10),
            reading_date: readingDate || null,
            notes
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save monthly reading');

        showAlert('success', `<i class="bi bi-check-circle-fill me-1"></i> Recorded monthly count (${Number(cumulativeCount).toLocaleString()}) for printer.`);

        // Hide modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('modalLogMonthlyReading'));
        if (modal) modal.hide();

        // Reload months, report and charts
        await loadAvailableMonths();
        if (monthlyReportMonthSelect) monthlyReportMonthSelect.value = monthVal;
        await loadMonthlyUsageReport(monthVal);
        await loadUsageCharts();
      } catch (err) {
        alert('Save error: ' + err.message);
      } finally {
        if (btnSave) {
          btnSave.disabled = false;
          btnSave.innerHTML = origText;
        }
      }
    });
  }

  // Export Monthly Report to Excel
  if (btnExportMonthlyExcel) {
    btnExportMonthlyExcel.addEventListener('click', () => {
      const rowsData = (currentMonthlyReportData && (currentMonthlyReportData.rows || currentMonthlyReportData.report)) || [];
      if (rowsData.length === 0) {
        alert('No report data available to export for this month.');
        return;
      }

      const month = currentMonthlyReportData.targetMonthName || currentMonthlyReportData.target_month || (monthlyReportMonthSelect ? monthlyReportMonthSelect.value : 'month');
      const totalN = (currentMonthlyReportData.totalNCount != null) ? currentMonthlyReportData.totalNCount : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_n_count : 0);
      const totalPrev = (currentMonthlyReportData.totalPrevCount != null) ? currentMonthlyReportData.totalPrevCount : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_prev_count : 0);
      const totalUse = (currentMonthlyReportData.totalUsage != null) ? currentMonthlyReportData.totalUsage : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_usage : 0);

      const rows = rowsData.map(r => ({
        'Location': r.location || '',
        'Serial Number': r.serial_number || '',
        'n month printer count total': Number((r.n_month_total != null) ? r.n_month_total : 0),
        'previous to n month printer count total': Number((r.prev_month_total != null) ? r.prev_month_total : (r.prev_n_month_total != null ? r.prev_n_month_total : 0)),
        'n month printer count usage': Number((r.usage != null) ? r.usage : (r.n_month_usage != null ? r.n_month_usage : 0))
      }));

      // Add totals row
      rows.push({
        'Location': 'TOTAL PAGES ACROSS ALL LOCATIONS',
        'Serial Number': '',
        'n month printer count total': Number(totalN),
        'previous to n month printer count total': Number(totalPrev),
        'n month printer count usage': Number(totalUse)
      });

      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [
        { wch: 30 },
        { wch: 20 },
        { wch: 28 },
        { wch: 36 },
        { wch: 28 }
      ];

      const wb = XLSX.utils.book_new();
      const safeMonthName = String(month).replace(/[^a-zA-Z0-9_-]/g, '_');
      XLSX.utils.book_append_sheet(wb, ws, `Usage_${safeMonthName}`);
      XLSX.writeFile(wb, `Maliban_Printer_Monthly_Usage_${safeMonthName}.xlsx`);
      showAlert('success', `<i class="bi bi-file-earmark-excel me-1"></i> Excel file exported: <strong>Maliban_Printer_Monthly_Usage_${safeMonthName}.xlsx</strong>`);
    });
  }

  // Copy Monthly Report Table to Clipboard
  if (btnCopyMonthlyReport) {
    btnCopyMonthlyReport.addEventListener('click', async () => {
      const rowsData = (currentMonthlyReportData && (currentMonthlyReportData.rows || currentMonthlyReportData.report)) || [];
      if (rowsData.length === 0) {
        alert('No data to copy.');
        return;
      }

      const totalN = (currentMonthlyReportData.totalNCount != null) ? currentMonthlyReportData.totalNCount : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_n_count : 0);
      const totalPrev = (currentMonthlyReportData.totalPrevCount != null) ? currentMonthlyReportData.totalPrevCount : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_prev_count : 0);
      const totalUse = (currentMonthlyReportData.totalUsage != null) ? currentMonthlyReportData.totalUsage : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_usage : 0);

      const header = ['Location', 'Serial Number', 'n month printer count total', 'previous to n month printer count total', 'n month printer count usage'].join('\t');
      const bodyLines = rowsData.map(r => [
        r.location || '',
        r.serial_number || '',
        (r.n_month_total != null) ? r.n_month_total : 0,
        (r.prev_month_total != null) ? r.prev_month_total : (r.prev_n_month_total != null ? r.prev_n_month_total : 0),
        (r.usage != null) ? r.usage : (r.n_month_usage != null ? r.n_month_usage : 0)
      ].join('\t'));

      const totalLine = [
        'TOTAL',
        '',
        totalN,
        totalPrev,
        totalUse
      ].join('\t');

      const fullText = [header, ...bodyLines, totalLine].join('\n');
      try {
        await navigator.clipboard.writeText(fullText);
        showAlert('success', '<i class="bi bi-clipboard-check-fill me-1"></i> Monthly report table copied to clipboard (TSV format, ready to paste into Excel).');
      } catch (err) {
        alert('Failed to copy: ' + err.message);
      }
    });
  }

  // Print Monthly Report
  if (btnPrintMonthlyReport) {
    btnPrintMonthlyReport.addEventListener('click', () => {
      const rowsData = (currentMonthlyReportData && (currentMonthlyReportData.rows || currentMonthlyReportData.report)) || [];
      if (rowsData.length === 0) {
        alert('No report data to print.');
        return;
      }

      const month = currentMonthlyReportData.targetMonthName || currentMonthlyReportData.target_month || (monthlyReportMonthSelect ? monthlyReportMonthSelect.value : '');
      const totalN = (currentMonthlyReportData.totalNCount != null) ? currentMonthlyReportData.totalNCount : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_n_count : 0);
      const totalPrev = (currentMonthlyReportData.totalPrevCount != null) ? currentMonthlyReportData.totalPrevCount : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_prev_count : 0);
      const totalUse = (currentMonthlyReportData.totalUsage != null) ? currentMonthlyReportData.totalUsage : (currentMonthlyReportData.totals ? currentMonthlyReportData.totals.total_usage : 0);

      const printWin = window.open('', '_blank');
      printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Maliban Monthly Printer Usage Report - ${month}</title>
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 30px; color: #212529; }
            .header-box { background: #0f2c59; color: white; padding: 20px; border-radius: 6px; margin-bottom: 25px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th { background: #0f2c59 !important; color: white !important; padding: 10px; font-size: 13px; }
            td { padding: 9px; border-bottom: 1px solid #dee2e6; font-size: 13px; }
            .total-row { font-weight: bold; background: #eef3fb !important; font-size: 14px; }
            @media print { .no-print { display: none !important; } }
          </style>
        </head>
        <body>
          <div class="header-box">
            <h4 class="mb-1 fw-bold">MALIBAN BISCUIT MANUFACTORIES (PVT) LIMITED</h4>
            <div class="fs-6">IT Infrastructure - Monthly Printer Usage Report</div>
            <div class="small opacity-75 mt-1">
              Reporting Month: <strong>${month}</strong> | Generated on: ${new Date().toLocaleString()}
            </div>
            <div class="small opacity-75 mt-1 fst-italic">
              Formula: [n month printer count usage] = [n month printer count total] &minus; [previous to n month printer count total]
            </div>
          </div>

          <table class="table table-bordered">
            <thead>
              <tr>
                <th>Location</th>
                <th>Serial Number</th>
                <th style="text-align: right;">n month printer count total</th>
                <th style="text-align: right;">previous to n month printer count total</th>
                <th style="text-align: right;">n month printer count usage</th>
              </tr>
            </thead>
            <tbody>
              ${rowsData.map(r => {
                const nCount = Number((r.n_month_total != null) ? r.n_month_total : 0);
                const prevCount = Number((r.prev_month_total != null) ? r.prev_month_total : (r.prev_n_month_total != null ? r.prev_n_month_total : 0));
                const usageVal = Number((r.usage != null) ? r.usage : (r.n_month_usage != null ? r.n_month_usage : 0));
                return `
                <tr>
                  <td><strong>${escapeHtml(r.location || '')}</strong></td>
                  <td style="font-family: monospace;">${escapeHtml(r.serial_number || '')}</td>
                  <td style="text-align: right; font-weight: bold;">${nCount.toLocaleString()}</td>
                  <td style="text-align: right;">${prevCount.toLocaleString()}</td>
                  <td style="text-align: right; font-weight: bold; color: #198754;">${usageVal.toLocaleString()}</td>
                </tr>
                `;
              }).join('')}
              <tr class="total-row">
                <td colspan="2" class="text-end">TOTAL PAGES:</td>
                <td style="text-align: right;">${Number(totalN).toLocaleString()}</td>
                <td style="text-align: right;">${Number(totalPrev).toLocaleString()}</td>
                <td style="text-align: right; color: #198754;">${Number(totalUse).toLocaleString()} Pages</td>
              </tr>
            </tbody>
          </table>
          <div class="text-muted small mt-4 text-center">Maliban IT Infrastructure &copy; 2026 | Confidential Meter Audit Document</div>
          <script>
            window.onload = function() { window.print(); }
          </script>
        </body>
        </html>
      `);
      printWin.document.close();
    });
  }

  // ==========================================
  // LOCATION & PRINTER CREATION
  // ==========================================
  const modalCreateLocationEl = document.getElementById('modalCreateLocation');
  const btnOpenCreateLocationModal = document.getElementById('btnOpenCreateLocationModal');
  const cu_btnAddLocation = document.getElementById('cu_btnAddLocation');
  const formCreateLocation = document.getElementById('formCreateLocation');
  const loc_feedback = document.getElementById('loc_feedback');
  const cu_location = document.getElementById('cu_location');

  let modalCreateLocationInstance = null;
  if (modalCreateLocationEl && window.bootstrap) {
    modalCreateLocationInstance = new bootstrap.Modal(modalCreateLocationEl);
  }

  function openCreateLocationDialog() {
    if (formCreateLocation) formCreateLocation.reset();
    if (loc_feedback) loc_feedback.innerHTML = '';
    if (modalCreateLocationInstance) modalCreateLocationInstance.show();
  }

  if (btnOpenCreateLocationModal) {
    btnOpenCreateLocationModal.addEventListener('click', openCreateLocationDialog);
  }

  if (cu_btnAddLocation) {
    cu_btnAddLocation.addEventListener('click', () => {
      const tabLocBtn = document.getElementById('tab-locations-btn');
      if (tabLocBtn) {
        const tab = new bootstrap.Tab(tabLocBtn);
        tab.show();
      }
    });
  }

  const loc_branch = document.getElementById('loc_branch');
  const loc_name = document.getElementById('loc_name');
  const loc_preview_box = document.getElementById('loc_preview_box');
  const loc_preview_text = document.getElementById('loc_preview_text');

  function updateLocationPreview() {
    if (!loc_preview_box || !loc_preview_text) return;
    const branch = (loc_branch?.value || '').trim();
    const name = (loc_name?.value || '').trim();
    if (branch || name) {
      loc_preview_box.classList.remove('d-none');
      let combined = name;
      if (branch && name) {
        if (!name.toLowerCase().includes(branch.toLowerCase()) && !name.toLowerCase().includes(branch.replace('Little Lion ', '').toLowerCase())) {
          combined = `${branch} - ${name}`;
        }
      } else if (branch) {
        combined = `${branch} - [Location Name]`;
      }
      loc_preview_text.textContent = combined;
    } else {
      loc_preview_box.classList.add('d-none');
    }
  }

  if (loc_branch) loc_branch.addEventListener('change', updateLocationPreview);
  if (loc_name) loc_name.addEventListener('input', updateLocationPreview);

  async function loadLocationSelectOptions(selectedLocation = '') {
    if (!cu_location) return;
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

      cu_location.innerHTML = html;
      if (selectedLocation) {
        cu_location.value = selectedLocation;
      }
    } catch (e) {
      console.warn('Could not load locations:', e);
    }
  }

  if (formCreateLocation) {
    formCreateLocation.addEventListener('submit', async (e) => {
      e.preventDefault();
      const locBranch = (document.getElementById('loc_branch')?.value || '').trim();
      const locName = (document.getElementById('loc_name')?.value || '').trim();
      const locModel = (document.getElementById('loc_model')?.value || '').trim();
      const locSerial = (document.getElementById('loc_serial')?.value || '').trim();

      if (!locBranch) {
        alert('Please select Company Part / Division (Little Lion 105, Little Lion 11, or Kandawala).');
        return;
      }
      if (!locName) {
        alert('Please enter Location Name.');
        return;
      }
      if (!locModel) {
        alert('Please enter Printer Model.');
        return;
      }
      if (!locSerial) {
        alert('Please enter Serial Number.');
        return;
      }

      const btnSubmit = document.getElementById('btnSubmitCreateLocation');
      const origText = btnSubmit ? btnSubmit.innerHTML : '';
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';
      }

      try {
        const res = await fetch('/api/locations/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branch: locBranch,
            location: locName,
            printer_model: locModel,
            serial_number: locSerial
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to create location');
        }

        if (loc_feedback) {
          loc_feedback.innerHTML = `
            <div class="alert alert-success py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-check-circle-fill me-1"></i> ${escapeHtml(data.message)}
            </div>
          `;
        }

        // Reload location options in User Creation form and select the new one
        await loadLocationSelectOptions(data.location);
        loadDashboardData(true);
        loadLocationDirectory();

        setTimeout(() => {
          if (modalCreateLocationInstance) modalCreateLocationInstance.hide();
          formCreateLocation.reset();
          if (loc_preview_box) loc_preview_box.classList.add('d-none');
          if (loc_feedback) loc_feedback.innerHTML = '';
        }, 1200);

      } catch (err) {
        if (loc_feedback) {
          loc_feedback.innerHTML = `
            <div class="alert alert-danger py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-x-circle-fill me-1"></i> ${escapeHtml(err.message)}
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

  // ==========================================
  // USER CREATION & WORKSTATION TRACKING
  // ==========================================
  const btnOpenCreateUserModal = document.getElementById('btnOpenCreateUserModal');
  const btnOpenUserListModal = document.getElementById('btnOpenUserListModal');
  const modalCreateUserEl = document.getElementById('modalCreateUser');
  const modalUserListEl = document.getElementById('modalUserList');
  const cu_btnAutoDetect = document.getElementById('cu_btnAutoDetect');
  const formCreateUser = document.getElementById('formCreateUser');
  const cu_feedback = document.getElementById('cu_feedback');
  const cu_pass = document.getElementById('cu_pass');
  const cu_repass = document.getElementById('cu_repass');
  const cu_pass_match_indicator = document.getElementById('cu_pass_match_indicator');
  const userListTableBody = document.getElementById('userListTableBody');
  const btnRefreshUserList = document.getElementById('btnRefreshUserList');

  let modalCreateUserInstance = null;
  let modalUserListInstance = null;
  if (modalCreateUserEl && window.bootstrap) {
    modalCreateUserInstance = new bootstrap.Modal(modalCreateUserEl);
  }
  if (modalUserListEl && window.bootstrap) {
    modalUserListInstance = new bootstrap.Modal(modalUserListEl);
  }

  if (btnOpenCreateUserModal) {
    btnOpenCreateUserModal.addEventListener('click', () => {
      if (formCreateUser) formCreateUser.reset();
      if (cu_feedback) cu_feedback.innerHTML = '';
      if (cu_pass_match_indicator) cu_pass_match_indicator.innerHTML = '';
      loadLocationSelectOptions();
      if (modalCreateUserInstance) modalCreateUserInstance.show();
    });
  }

  if (btnOpenUserListModal) {
    btnOpenUserListModal.addEventListener('click', () => {
      if (modalUserListInstance) modalUserListInstance.show();
      loadUserDirectory();
    });
  }

  if (btnRefreshUserList) {
    btnRefreshUserList.addEventListener('click', () => {
      loadUserDirectory();
    });
  }

  // Password matching check in real-time
  function checkPasswordMatch() {
    if (!cu_pass || !cu_repass || !cu_pass_match_indicator) return;
    const p1 = cu_pass.value;
    const p2 = cu_repass.value;
    if (!p2) {
      cu_pass_match_indicator.innerHTML = '';
      return;
    }
    if (p1 === p2) {
      cu_pass_match_indicator.innerHTML = '<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i> Passwords match</span>';
    } else {
      cu_pass_match_indicator.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle-fill me-1"></i> Passwords do not match</span>';
    }
  }

  if (cu_pass) cu_pass.addEventListener('input', checkPasswordMatch);
  if (cu_repass) cu_repass.addEventListener('input', checkPasswordMatch);

  // Auto-detect PC & MAC
  if (cu_btnAutoDetect) {
    cu_btnAutoDetect.addEventListener('click', async () => {
      const origText = cu_btnAutoDetect.innerHTML;
      cu_btnAutoDetect.disabled = true;
      cu_btnAutoDetect.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Detecting...';
      try {
        const res = await fetch('/api/system/client-network');
        if (!res.ok) throw new Error('Auto-detection request failed');
        const data = await res.json();
        if (data.hostname && document.getElementById('cu_pc')) {
          document.getElementById('cu_pc').value = data.hostname;
        }
        if (data.mac_address && document.getElementById('cu_mac')) {
          document.getElementById('cu_mac').value = data.mac_address;
        }
        if (cu_feedback) {
          cu_feedback.innerHTML = `
            <div class="alert alert-success py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-check-circle-fill me-1"></i> Detected PC Name: <strong>${data.hostname || 'N/A'}</strong> | MAC: <strong>${data.mac_address || 'N/A'}</strong>
              <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>
            </div>
          `;
        }
      } catch (e) {
        if (cu_feedback) {
          cu_feedback.innerHTML = `
            <div class="alert alert-warning py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-exclamation-triangle-fill me-1"></i> Could not auto-detect: ${e.message}. Please enter manually.
              <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>
            </div>
          `;
        }
      } finally {
        cu_btnAutoDetect.disabled = false;
        cu_btnAutoDetect.innerHTML = origText;
      }
    });
  }

  // Handle Form Submission
  if (formCreateUser) {
    formCreateUser.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (document.getElementById('cu_name')?.value || '').trim();
      let email = (document.getElementById('cu_email')?.value || '').trim();
      if (email && !email.includes('@')) {
        email = email + '@malibangroup.lk';
      }
      const location = (document.getElementById('cu_location')?.value || '').trim();
      const mac = (document.getElementById('cu_mac')?.value || '').trim();
      const pc = (document.getElementById('cu_pc')?.value || '').trim();
      const password = (document.getElementById('cu_pass')?.value || '').trim();
      const repass = (document.getElementById('cu_repass')?.value || '').trim();

      // Client-side validations
      if (!name) {
        alert('Please enter the User Name.');
        return;
      }
      if (!email || !email.toLowerCase().endsWith('@malibangroup.lk')) {
        alert('Email must belong to the @malibangroup.lk corporate domain.');
        return;
      }
      if (!location) {
        alert('Please enter or select a Location.');
        return;
      }
      if (!mac) {
        alert('MAC Address is required for workstation tracking.');
        return;
      }
      const cleanMac = mac.replace(/[^0-9a-fA-F]/g, '');
      if (cleanMac.length !== 12) {
        alert('Invalid MAC Address. It must contain exactly 12 hexadecimal characters (e.g. C8-95-CE-4A-5E-B6).');
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
        alert('Passwords do not match. Please re-enter identical passwords.');
        return;
      }

      const btnSubmit = document.getElementById('btnSubmitCreateUser');
      const origText = btnSubmit ? btnSubmit.innerHTML : '';
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Creating & Linking PC...';
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
          throw new Error(result.error || 'Failed to create user');
        }

        showAlert('success', `User <strong>${escapeHtml(name)}</strong> created and PC <strong>${escapeHtml(pc)}</strong> registered for dual tracking!`);
        if (modalCreateUserInstance) modalCreateUserInstance.hide();
        formCreateUser.reset();
        loadDashboardData();
        loadUserDirectory();
      } catch (err) {
        if (cu_feedback) {
          cu_feedback.innerHTML = `
            <div class="alert alert-danger py-2 small alert-dismissible fade show" role="alert">
              <i class="bi bi-x-circle-fill me-1"></i> ${escapeHtml(err.message)}
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

  // Load User Directory & Tracked PCs
  async function loadUserDirectory() {
    if (!userListTableBody) return;
    userListTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-4 text-muted">
          <div class="spinner-border spinner-border-sm text-primary me-2"></div> Loading tracked users & workstations...
        </td>
      </tr>
    `;

    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error('Failed to load users');
      const users = await res.json();

      if (users.length === 0) {
        userListTableBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center py-4 text-muted">
              No users registered yet. Click "Create User & Track PC" to add the first user.
            </td>
          </tr>
        `;
        return;
      }

      userListTableBody.innerHTML = users.map(u => {
        const emailBadge = u.email ? `<div class="small text-muted"><i class="bi bi-envelope me-1"></i>${escapeHtml(u.email)}</div>` : '<div class="small text-warning">No email set</div>';
        const spoolerBadge = u.computer_spooler_status === 'BLOCKED'
          ? '<span class="badge bg-danger">BLOCKED</span>'
          : '<span class="badge bg-success">ACTIVE</span>';

        return `
          <tr id="user-row-${u.uid}">
            <td>
              <div class="fw-bold text-dark">${escapeHtml(u.name)}</div>
              ${emailBadge}
            </td>
            <td>
              <span class="badge bg-light text-dark border"><i class="bi bi-geo-alt me-1 text-primary"></i>${escapeHtml(u.location || u.department_name || 'N/A')}</span>
            </td>
            <td>
              <span class="font-monospace fw-bold text-primary">${escapeHtml(u.pc_name || 'N/A')}</span>
            </td>
            <td>
              <span class="font-monospace text-secondary">${escapeHtml(u.mac_address || 'N/A')}</span>
            </td>
            <td>${spoolerBadge}</td>
            <td id="track-status-${u.uid}">
              <span class="badge bg-secondary-subtle text-secondary border">Ready to probe</span>
            </td>
            <td class="text-end pe-3 text-nowrap">
              <button class="btn btn-sm btn-outline-primary btn-track-user me-1" data-uid="${u.uid}" data-pc="${escapeHtml(u.pc_name || '')}" data-mac="${escapeHtml(u.mac_address || '')}" title="Probe PC reachability via PC Name or MAC Address">
                Track Now
              </button>
              <button class="btn btn-sm btn-outline-secondary btn-edit-user me-1" data-uid="${u.uid}" data-name="${escapeHtml(u.name || '')}" data-email="${escapeHtml(u.email || '')}" data-location="${escapeHtml(u.location || u.department_name || '')}" data-pc="${escapeHtml(u.pc_name || '')}" data-mac="${escapeHtml(u.mac_address || '')}" title="Edit User & Workstation">
                Edit
              </button>
              <button class="btn btn-sm btn-outline-danger btn-delete-user" data-uid="${u.uid}" data-name="${escapeHtml(u.name)}" title="Delete User">
                Delete
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Wire track buttons
      document.querySelectorAll('.btn-track-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const uid = btn.dataset.uid;
          const statusCell = document.getElementById(`track-status-${uid}`);
          if (statusCell) {
            statusCell.innerHTML = '<span class="spinner-border spinner-border-sm text-primary me-1"></span> Probing...';
          }
          btn.disabled = true;

          try {
            const trackRes = await fetch(`/api/users/track/${uid}`);
            const data = await trackRes.json();
            if (statusCell) {
              if (data.online) {
                const badgeText = data.tracked_by === 'MAC Address' 
                  ? `Online (MAC &rarr; ${data.resolved_ip || 'IP'})` 
                  : `Online (${data.tracked_by})`;
                statusCell.innerHTML = `
                  <span class="badge bg-success-subtle text-success border border-success-subtle">
                    <i class="bi bi-check-circle-fill me-1"></i> ${badgeText}
                  </span>
                  <div class="small text-muted" style="font-size: 0.75rem;">${escapeHtml(data.reason || '')}</div>
                `;
              } else {
                statusCell.innerHTML = `
                  <span class="badge bg-danger-subtle text-danger border border-danger-subtle">
                    <i class="bi bi-x-circle-fill me-1"></i> Offline / Unreachable
                  </span>
                  <div class="small text-muted" style="font-size: 0.75rem;">Checked PC Name & MAC</div>
                `;
              }
            }
          } catch (e) {
            if (statusCell) {
              statusCell.innerHTML = `<span class="badge bg-warning text-dark">Error probing</span>`;
            }
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Wire edit user buttons
      document.querySelectorAll('.btn-edit-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const uid = btn.dataset.uid;
          const name = btn.dataset.name;
          const email = btn.dataset.email;
          const location = btn.dataset.location;
          const pc = btn.dataset.pc;
          const mac = btn.dataset.mac;

          document.getElementById('eu_uid').value = uid;
          document.getElementById('eu_name').value = name;
          document.getElementById('eu_email').value = email;
          document.getElementById('eu_pc').value = pc;
          document.getElementById('eu_mac').value = mac;
          document.getElementById('eu_pass').value = '';
          const euFeedback = document.getElementById('eu_feedback');
          if (euFeedback) euFeedback.innerHTML = '';

          // Populate eu_location options from /api/locations
          const euLocationSelect = document.getElementById('eu_location');
          if (euLocationSelect) {
            euLocationSelect.innerHTML = '<option value="">-- Select Location --</option>';
            try {
              const locRes = await fetch('/api/locations');
              const locations = await locRes.json();
              locations.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc.name;
                opt.textContent = `${loc.name}${loc.branch ? ' (' + loc.branch + ')' : ''}`;
                if (loc.name.toLowerCase() === location.toLowerCase()) {
                  opt.selected = true;
                }
                euLocationSelect.appendChild(opt);
              });
            } catch (e) {
              console.warn('Failed to load locations for edit user:', e);
            }
          }

          const modalEl = document.getElementById('modalEditUser');
          if (modalEl) {
            const modal = new bootstrap.Modal(modalEl);
            modal.show();
          }
        });
      });

      // Wire delete buttons
      document.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const uid = btn.dataset.uid;
          const name = btn.dataset.name;
          if (!confirm(`Are you sure you want to delete user "${name}"?`)) return;

          try {
            const delRes = await fetch(`/api/users/${uid}`, { method: 'DELETE' });
            if (!delRes.ok) throw new Error('Failed to delete user');
            const row = document.getElementById(`user-row-${uid}`);
            if (row) row.remove();
            showAlert('info', `User "${escapeHtml(name)}" was deleted.`);
            loadDashboardData();
          } catch (e) {
            alert(`Error deleting user: ${e.message}`);
          }
        });
      });

    } catch (err) {
      userListTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-4 text-danger">
            <i class="bi bi-exclamation-triangle-fill me-1"></i> Error loading directory: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }

  // Handle Edit User Form Submission
  const formEditUser = document.getElementById('formEditUser');
  if (formEditUser) {
    formEditUser.addEventListener('submit', async (e) => {
      e.preventDefault();
      const uid = document.getElementById('eu_uid').value;
      const name = document.getElementById('eu_name').value.trim();
      let email = document.getElementById('eu_email').value.trim();
      if (email && !email.includes('@')) {
        email = email + '@malibangroup.lk';
      }
      const location = document.getElementById('eu_location').value.trim();
      const pc = document.getElementById('eu_pc').value.trim();
      const mac = document.getElementById('eu_mac').value.trim();
      const pass = document.getElementById('eu_pass').value;
      const euFeedback = document.getElementById('eu_feedback');

      if (!name || !location) {
        if (euFeedback) euFeedback.innerHTML = '<div class="alert alert-danger py-2 small">Name and Location are required.</div>';
        return;
      }

      if (email && !email.toLowerCase().endsWith('@malibangroup.lk')) {
        if (euFeedback) euFeedback.innerHTML = '<div class="alert alert-danger py-2 small">Email must end with @malibangroup.lk</div>';
        return;
      }

      const btnSubmit = document.getElementById('btnSubmitEditUser');
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

      try {
        const res = await fetch(`/api/users/${uid}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            location,
            pc_name: pc,
            mac_address: mac,
            password: pass
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update user');

        const modalEl = document.getElementById('modalEditUser');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();

        showAlert('success', `<i class="bi bi-check-circle-fill me-1"></i> User <strong>${escapeHtml(name)}</strong> updated successfully.`);
        loadUserDirectory();
        loadDashboardData();
      } catch (err) {
        if (euFeedback) euFeedback.innerHTML = `<div class="alert alert-danger py-2 small">${escapeHtml(err.message)}</div>`;
      } finally {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = '<i class="bi bi-save me-1"></i> Update User';
      }
    });
  }

  // =========================================================
  // PLANT LOCATIONS & PRINTERS DIRECTORY & CRUD
  // =========================================================
  const btnOpenLocationListModal = document.getElementById('btnOpenLocationListModal');
  const modalLocationListEl = document.getElementById('modalLocationList');
  let modalLocationListInstance = null;
  if (modalLocationListEl) {
    modalLocationListInstance = new bootstrap.Modal(modalLocationListEl);
  }

  if (btnOpenLocationListModal) {
    btnOpenLocationListModal.addEventListener('click', () => {
      if (modalLocationListInstance) modalLocationListInstance.show();
      loadLocationDirectory();
    });
  }

  const btnRefreshLocationList = document.getElementById('btnRefreshLocationList');
  if (btnRefreshLocationList) {
    btnRefreshLocationList.addEventListener('click', () => loadLocationDirectory());
  }

  const btnAddNewLocationFromDir = document.getElementById('btnAddNewLocationFromDir');
  if (btnAddNewLocationFromDir) {
    btnAddNewLocationFromDir.addEventListener('click', () => {
      if (modalLocationListInstance) modalLocationListInstance.hide();
      const modalCreateLocEl = document.getElementById('modalCreateLocation');
      if (modalCreateLocEl) {
        const modal = new bootstrap.Modal(modalCreateLocEl);
        modal.show();
      }
    });
  }

  // Load Location Directory
  async function loadLocationDirectory() {
    const tableBody = document.getElementById('locationListTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-4 text-muted">
          <div class="spinner-border spinner-border-sm text-success me-2"></div> Loading plant locations...
        </td>
      </tr>
    `;

    try {
      const res = await fetch('/api/locations');
      if (!res.ok) throw new Error('Failed to load locations');
      const locations = await res.json();

      if (locations.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="6" class="text-center py-4 text-muted">
              No locations registered yet. Click "+ Create Location" to add your first plant location.
            </td>
          </tr>
        `;
        return;
      }

      tableBody.innerHTML = locations.map(loc => {
        const branchBadge = loc.branch === 'Little Lion 105'
          ? '<span class="badge bg-primary-subtle text-primary border border-primary-subtle fw-semibold"><i class="bi bi-buildings-fill me-1"></i>Little Lion 105</span>'
          : (loc.branch === 'Little Lion 11'
            ? '<span class="badge bg-warning-subtle text-warning-emphasis border border-warning-subtle fw-semibold"><i class="bi bi-buildings me-1"></i>Little Lion 11</span>'
            : (loc.branch === 'Kandawala'
              ? '<span class="badge bg-info-subtle text-info-emphasis border border-info-subtle fw-semibold"><i class="bi bi-geo-alt-fill me-1"></i>Kandawala</span>'
              : `<span class="badge bg-secondary-subtle text-secondary border">${escapeHtml(loc.branch || 'General')}</span>`));

        const pModel = loc.printer_model || (loc.printers && loc.printers[0] ? (loc.printers[0].model || loc.printers[0].printer_model) : '') || 'N/A';
        const pSerial = loc.serial_number || (loc.printers && loc.printers[0] ? loc.printers[0].serial_number : '') || 'N/A';

        return `
          <tr id="loc-row-${escapeHtml(loc.name).replace(/[^a-zA-Z0-9]/g, '_')}">
            <td>${branchBadge}</td>
            <td>
              <div class="fw-bold text-dark">${escapeHtml(loc.name)}</div>
            </td>
            <td>
              <span class="text-secondary">${escapeHtml(pModel)}</span>
            </td>
            <td>
              <span class="font-monospace text-uppercase fw-bold text-primary">${escapeHtml(pSerial)}</span>
            </td>
            <td>
              ${(() => {
                const count = loc.computers_count !== undefined ? loc.computers_count : (loc.computers ? loc.computers.length : 0);
                const pcNames = (loc.computers || []).map(c => c.pc_name).filter(Boolean).join(', ');
                if (count > 0) {
                  return `<span class="badge text-white fw-bold shadow-sm" style="background-color: #002b66;" title="Assigned: ${escapeHtml(pcNames)}">${count} PC${count > 1 ? 's' : ''}</span>
                          <div class="small text-muted text-truncate mt-1" style="max-width: 170px;" title="${escapeHtml(pcNames)}">${escapeHtml(pcNames)}</div>`;
                }
                return `<span class="badge bg-light text-muted border">0 PCs</span>`;
              })()}
            </td>
            <td class="text-end pe-3">
              <button class="btn btn-sm btn-outline-secondary btn-edit-loc me-1"
                      data-original-name="${escapeHtml(loc.name)}"
                      data-branch="${escapeHtml(loc.branch || 'Little Lion 105')}"
                      data-name="${escapeHtml(loc.name)}"
                      data-model="${escapeHtml(pModel)}"
                      data-serial="${escapeHtml(pSerial === 'N/A' ? '' : pSerial)}"
                      title="Edit Location & Hardware">
                Edit
              </button>
              <button class="btn btn-sm btn-outline-danger btn-delete-loc"
                      data-name="${escapeHtml(loc.name)}"
                      title="Delete Location">
                Delete
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Wire edit location buttons
      document.querySelectorAll('.btn-edit-loc').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('el_original_name').value = btn.dataset.originalName;
          document.getElementById('el_branch').value = btn.dataset.branch || 'Little Lion 105';
          document.getElementById('el_name').value = btn.dataset.name;
          document.getElementById('el_model').value = btn.dataset.model;
          document.getElementById('el_serial').value = btn.dataset.serial;
          const elFeedback = document.getElementById('el_feedback');
          if (elFeedback) elFeedback.innerHTML = '';

          const modalEl = document.getElementById('modalEditLocation');
          if (modalEl) {
            const modal = new bootstrap.Modal(modalEl);
            modal.show();
          }
        });
      });

      // Wire delete location buttons
      document.querySelectorAll('.btn-delete-loc').forEach(btn => {
        btn.addEventListener('click', async () => {
          const locName = btn.dataset.name;
          if (!confirm(`Are you sure you want to delete location "${locName}" and its associated printer hardware? This cannot be undone.`)) {
            return;
          }

          try {
            const delRes = await fetch('/api/locations/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ location: locName })
            });
            const data = await delRes.json();
            if (!delRes.ok) throw new Error(data.error || 'Failed to delete location');

            showAlert('info', `<i class="bi bi-trash-fill me-1"></i> Location "${escapeHtml(locName)}" deleted.`);
            loadLocationDirectory();
            loadDashboardData();
          } catch (e) {
            alert(`Error deleting location: ${e.message}`);
          }
        });
      });

    } catch (err) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-4 text-danger">
            <i class="bi bi-exclamation-triangle-fill me-1"></i> Error loading locations: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }

  // Wire Edit Location Form Submission
  const formEditLocation = document.getElementById('formEditLocation');
  if (formEditLocation) {
    formEditLocation.addEventListener('submit', async (e) => {
      e.preventDefault();
      const origName = document.getElementById('el_original_name').value.trim();
      const branch = document.getElementById('el_branch').value.trim();
      const name = document.getElementById('el_name').value.trim();
      const model = document.getElementById('el_model').value.trim();
      const serial = document.getElementById('el_serial').value.trim();
      const feedback = document.getElementById('el_feedback');

      if (!origName || !branch || !name || !model || !serial) {
        if (feedback) feedback.innerHTML = '<div class="alert alert-danger py-2 small">All fields are required.</div>';
        return;
      }

      const btnSubmit = document.getElementById('btnSubmitEditLocation');
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

      try {
        const res = await fetch('/api/locations/update', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            original_name: origName,
            branch,
            location: name,
            printer_model: model,
            serial_number: serial
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update location');

        const modalEl = document.getElementById('modalEditLocation');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();

        showAlert('success', `<i class="bi bi-check-circle-fill me-1"></i> Location <strong>${escapeHtml(data.location || name)}</strong> updated successfully.`);
        loadLocationDirectory();
        loadDashboardData();
      } catch (err) {
        if (feedback) feedback.innerHTML = `<div class="alert alert-danger py-2 small">${escapeHtml(err.message)}</div>`;
      } finally {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i> Save Changes';
      }
    });
  }

  // Tab Navigation Listeners
  const tabLocationsBtn = document.getElementById('tab-locations-btn');
  if (tabLocationsBtn) {
    tabLocationsBtn.addEventListener('shown.bs.tab', () => {
      loadLocationDirectory();
    });
  }

  const tabUsersBtn = document.getElementById('tab-users-btn');
  if (tabUsersBtn) {
    tabUsersBtn.addEventListener('shown.bs.tab', () => {
      loadUserDirectory();
      loadLocationSelectOptions();
    });
  }

  // =========================================================================
  // SECTION: Monthly Print Usage Report
  // =========================================================================
  const tabMonthlyReportMainBtn = document.getElementById('tab-monthly-report-btn');
  const reportSelectMonth = document.getElementById('reportSelectMonth');
  const reportSelectYear = document.getElementById('reportSelectYear');
  const btnLoadMonthlyReport = document.getElementById('btnLoadMonthlyReport');
  const btnDownloadReportExcel = document.getElementById('btnDownloadReportExcel');
  const btnRefreshArchive = document.getElementById('btnRefreshArchive');

  // Set default month & year in dropdowns on load
  const nowReportDate = new Date();
  if (reportSelectMonth) {
    reportSelectMonth.value = String(nowReportDate.getMonth() + 1);
  }
  if (reportSelectYear) {
    reportSelectYear.value = String(nowReportDate.getFullYear());
  }

  if (tabMonthlyReportMainBtn) {
    tabMonthlyReportMainBtn.addEventListener('shown.bs.tab', async () => {
      await loadMonthlyReportData();
      await loadReportArchive();
    });
  }

  if (btnLoadMonthlyReport) {
    btnLoadMonthlyReport.addEventListener('click', () => loadMonthlyReportData());
  }

  if (btnDownloadReportExcel) {
    btnDownloadReportExcel.addEventListener('click', () => {
      const y = reportSelectYear ? reportSelectYear.value : new Date().getFullYear();
      const m = reportSelectMonth ? reportSelectMonth.value : (new Date().getMonth() + 1);
      window.location.href = `/api/reports/monthly/download?year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}`;
    });
  }

  function showMonthlyFeedback(type, message) {
    const box = document.getElementById('monthlyReportFeedback');
    if (!box) return;
    box.innerHTML = `
      <div class="alert alert-${type} alert-dismissible fade show shadow-sm py-2 px-3 small" role="alert">
        ${message}
        <button type="button" class="btn-close btn-close-sm" data-bs-dismiss="alert"></button>
      </div>
    `;
  }

  async function loadMonthlyReportData() {
    const tableBody = document.getElementById('monthlyReportTableBody');
    if (!tableBody) return;

    const y = reportSelectYear ? reportSelectYear.value : new Date().getFullYear();
    const m = reportSelectMonth ? reportSelectMonth.value : (new Date().getMonth() + 1);

    tableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-5 text-muted">
          <div class="spinner-border spinner-border-sm text-primary me-2"></div> Compiling supervisor counts for Month ${m}/${y}...
        </td>
      </tr>
    `;

    try {
      const res = await fetch(`/api/reports/monthly?year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}`);
      if (!res.ok) throw new Error('Failed to load report data');
      const data = await res.json();
      const report = data.report;

      // Update Dynamic Column Headers
      document.getElementById('thCol1').textContent = report.headers.col1;
      document.getElementById('thCol2').textContent = report.headers.col2;
      document.getElementById('thCol3').textContent = report.headers.col3;
      document.getElementById('thCol4').textContent = report.headers.col4;
      document.getElementById('thCol5').textContent = report.headers.col5;

      // Update Titles & Badges
      const lblTitle = document.getElementById('lblReportTitle');
      const lblCutoffBadge = document.getElementById('lblCutoffDateBadge');
      const lblCutoffText = document.getElementById('lblCutoffDateText');
      const lblStatusBadge = document.getElementById('lblReportStatusBadge');

      if (lblTitle) lblTitle.textContent = `Print Usage Compilation – ${report.currentMonthName} ${report.year}`;
      if (lblCutoffBadge) lblCutoffBadge.textContent = `${report.cutoffDate} (UTC+05:30)`;
      if (lblCutoffText) lblCutoffText.textContent = `${report.cutoffDate} (UTC+05:30)`;
      if (lblStatusBadge) lblStatusBadge.textContent = `${report.summary.totalPrinters} Active Printers`;

      // Update Metric Cards
      const grandTotalVal = report.summary.grandTotalUsage || 0;
      document.getElementById('metricGrandTotalUsage').textContent = grandTotalVal.toLocaleString();
      document.getElementById('metricPrintersSubmitted').textContent = `${report.summary.completedCount} / ${report.summary.totalPrinters}`;
      document.getElementById('metricPrintersPending').textContent = report.summary.pendingCount;
      document.getElementById('metricBillingCutoff').textContent = `${report.cutoffDate.split(' ')[0]} 23:59`;

      // Render Rows
      if (!report.rows || report.rows.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="5" class="text-center py-4 text-muted">
              No printer records found for this billing period.
            </td>
          </tr>
        `;
        document.getElementById('tdGrandTotalFoot').textContent = '0';
        return;
      }

      let rowsHtml = '';
      report.rows.forEach(r => {
        const rowClass = r.isNegative ? 'table-danger' : (r.isPending ? 'table-warning-subtle' : '');
        const prevText = r.prevTotal !== null ? Number(r.prevTotal).toLocaleString() : '-';
        
        let currHtml = '';
        if (r.currentTotal !== null) {
          currHtml = `<span class="fw-bold">${Number(r.currentTotal).toLocaleString()}</span>`;
        } else {
          currHtml = '<span class="badge bg-warning text-dark px-2 py-1">Pending</span>';
        }

        let usageHtml = '';
        if (r.usage !== null) {
          if (r.isNegative) {
            usageHtml = `<span class="badge bg-danger text-white px-2 py-1">${Number(r.usage).toLocaleString()} (Negative)</span>`;
          } else {
            usageHtml = `<span class="fw-bold text-dark">${Number(r.usage).toLocaleString()}</span>`;
          }
        } else {
          usageHtml = '<span class="badge bg-warning text-dark px-2 py-1">Pending</span>';
        }

        rowsHtml += `
          <tr class="${rowClass}">
            <td class="text-start ps-3 fw-bold text-dark" style="border: 1px solid #dee2e6;">${escapeHtml(r.location)}</td>
            <td class="font-monospace text-primary fw-bold" style="border: 1px solid #dee2e6;">${escapeHtml(r.serial)}</td>
            <td class="text-end pe-3 font-monospace text-secondary" style="border: 1px solid #dee2e6;">${prevText}</td>
            <td class="text-end pe-3 font-monospace" style="border: 1px solid #dee2e6;">${currHtml}</td>
            <td class="text-end pe-3 font-monospace" style="border: 1px solid #dee2e6;">${usageHtml}</td>
          </tr>
        `;
      });

      tableBody.innerHTML = rowsHtml;
      document.getElementById('tdGrandTotalFoot').textContent = grandTotalVal.toLocaleString();

    } catch (err) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center py-4 text-danger">
            <i class="bi bi-exclamation-triangle-fill me-1"></i> Failed to compile monthly report: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }

  // Load Archive
  async function loadReportArchive() {
    const tableBody = document.getElementById('reportArchiveTableBody');
    if (!tableBody) return;
    try {
      const res = await fetch('/api/reports/monthly/archive');
      const data = await res.json();
      const archives = data.archives || [];

      if (archives.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">No historical report snapshots yet.</td></tr>';
        return;
      }

      tableBody.innerHTML = archives.map(a => {
        return `
          <tr>
            <td class="fw-bold text-dark">
              ${escapeHtml(a.month_name)} ${a.year}
              <div class="small text-muted" style="font-size: 0.75rem;">Created: ${a.generated_at || '-'}</div>
            </td>
            <td class="text-end font-monospace fw-bold text-primary">${Number(a.total_usage).toLocaleString()} pages</td>
            <td class="text-center">
              <span class="badge bg-success-subtle text-success border border-success-subtle">${a.total_printers - a.pending_count} / ${a.total_printers}</span>
              ${a.pending_count > 0 ? `<span class="badge bg-warning-subtle text-warning border ms-1">${a.pending_count} pend</span>` : ''}
            </td>
            <td class="small text-muted font-monospace">${escapeHtml(a.cutoff_date || '')}</td>
            <td class="text-end pe-3 text-nowrap">
              <a href="/api/reports/monthly/download?year=${a.year}&month=${a.month}" class="btn btn-sm btn-outline-success" title="Download Excel (.xlsx)">
                📥 Download Excel
              </a>
            </td>
          </tr>
        `;
      }).join('');

    } catch (e) {
      tableBody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-danger">Failed to load archives.</td></tr>';
    }
  }

  if (btnRefreshArchive) {
    btnRefreshArchive.addEventListener('click', () => loadReportArchive());
  }

  // Initial load
  loadDashboardData();
  loadLocationSelectOptions();
  loadLocationDirectory();
  loadUserDirectory();
  if (document.getElementById('weeklyUsageChart')) {
    loadUsageCharts();
  }

  // Automatic 1-minute live background sync without page reloading
  const AUTO_SYNC_INTERVAL_MS = 60000; // 60 seconds = 1 minute
  setInterval(async () => {
    try {
      // 1. Check if any powered-on PC has pending block/unblock commands to execute
      await fetch('/api/admin/sync-pending', { method: 'POST' }).catch(() => {});
      // 2. Refresh live reachability & department state silently (without page reload or table flicker)
      await loadDashboardData(true);
    } catch (e) {
      console.warn('Live 1-minute auto sync failed:', e);
    }
  }, AUTO_SYNC_INTERVAL_MS);
});
