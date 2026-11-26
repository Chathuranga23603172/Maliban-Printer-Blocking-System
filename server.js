const express = require('express');
const cron = require('node-cron');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
require('dotenv').config();

const { dbAsync, initDatabase, getWeekStartDate, getCurrentWeekDeadline, getOrCreateDateId, getWeekNumber } = require('./database');
const {
  blockDepartmentPrinters,
  unblockDepartmentPrinters,
  checkAndBlockNonCompliantDepartments,
  syncPendingWorkstations,
  checkWorkstationOnline,
  getLiveSpoolerStatus,
  normalizeMacAddress,
  isValidMacAddress,
  resolveIpByMac
} = require('./powershell');

const {
  compileMonthlyReport,
  generateAndSaveExcel,
  snapshotMonthlyReport,
  getBillingCycleInfo
} = require('./monthlyReportService');

const { createOAuthRouter } = require('./auth/oauth');

const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 14 * * 1'; // Monday 2:00 PM
const SYNC_CRON_SCHEDULE = process.env.SYNC_CRON_SCHEDULE || '* * * * *'; // Every 1 minute

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware with 10MB payload limit for 5MB photo uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// OAuth 2.0 / OpenID Connect Router
app.use('/api/auth/oauth', createOAuthRouter());

// Serve routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==========================================
// API ROUTES
// ==========================================

/**
 * GET /api/week-info
 * Returns current week start (Monday) and Monday 2:00 PM deadline
 */
app.get('/api/week-info', (req, res) => {
  const currentWeekStart = getWeekStartDate();
  const deadline = getCurrentWeekDeadline(currentWeekStart);
  const now = new Date();

  res.json({
    weekStartDate: currentWeekStart,
    deadline: deadline.toISOString(),
    deadlinePassed: now > deadline,
    serverTime: now.toISOString()
  });
});

/**
 * GET /api/departments
 * Returns list of departments and their associated computers
 */
app.get('/api/departments', async (req, res) => {
  try {
    const departments = await dbAsync.all('SELECT * FROM departments ORDER BY name ASC');
    const computers = await dbAsync.all('SELECT * FROM computers ORDER BY pc_name ASC');

    const mapped = departments.map((dept) => ({
      ...dept,
      computers: computers.filter((c) => c.department_id === dept.id)
    }));

    res.json(mapped);
  } catch (error) {
    console.error('[-] Error fetching departments:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/departments
 * Create a new department
 */
app.post('/api/departments', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Department name is required' });
  }

  try {
    const result = await dbAsync.run(
      'INSERT INTO departments (name, spooler_status) VALUES (?, "ACTIVE")',
      [name.trim()]
    );
    res.status(201).json({ id: result.lastID, name: name.trim(), spooler_status: 'ACTIVE' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A department with this name already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/departments/:id
 * Delete a department and associated computers/submissions (CASCADE)
 */
app.delete('/api/departments/:id', async (req, res) => {
  const departmentId = parseInt(req.params.id, 10);
  try {
    await dbAsync.run('DELETE FROM departments WHERE id = ?', [departmentId]);
    res.json({ success: true, message: 'Department removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/departments/:id/computers
 * Add a computer to a department
 */
app.post('/api/departments/:id/computers', async (req, res) => {
  const departmentId = parseInt(req.params.id, 10);
  const { pc_name, ip_address, mac_address, notes } = req.body;

  if (!pc_name || !pc_name.trim()) {
    return res.status(400).json({ error: 'Computer name or IP is required' });
  }

  try {
    const cleanPc = pc_name.trim().toUpperCase();
    const cleanMac = mac_address && mac_address.trim() ? mac_address.trim().toUpperCase() : null;
    // Un-blacklist if computer was previously excluded
    await dbAsync.run('DELETE FROM excluded_computers WHERE UPPER(pc_name) = ?', [cleanPc]);
    const result = await dbAsync.run(
      'INSERT INTO computers (department_id, pc_name, ip_address, mac_address, notes) VALUES (?, ?, ?, ?, ?)',
      [departmentId, cleanPc, ip_address ? ip_address.trim() : null, cleanMac, notes ? notes.trim() : null]
    );

    res.status(201).json({
      id: result.lastID,
      department_id: departmentId,
      pc_name: cleanPc,
      ip_address: ip_address ? ip_address.trim() : null,
      mac_address: cleanMac
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/computers/:id
 * Delete a computer permanently and add to excluded_computers blacklist
 */
app.delete('/api/computers/:id', async (req, res) => {
  const computerId = parseInt(req.params.id, 10);
  try {
    const comp = await dbAsync.get('SELECT pc_name FROM computers WHERE id = ?', [computerId]);
    if (comp && comp.pc_name) {
      const cleanPc = comp.pc_name.trim().toUpperCase();
      // 1. Permanently add to excluded_computers blacklist so server restarts never revive it
      await dbAsync.run('INSERT OR IGNORE INTO excluded_computers (pc_name) VALUES (?)', [cleanPc]);
      // 2. Unbind from user_master so startup user-to-computer sync does not re-add it
      await dbAsync.run('UPDATE user_master SET pc_name = NULL WHERE UPPER(pc_name) = ?', [cleanPc]);
    }
    // 3. Delete from computers table
    await dbAsync.run('DELETE FROM computers WHERE id = ?', [computerId]);
    res.json({ success: true, message: `Workstation ${comp ? comp.pc_name : computerId} permanently removed and blacklisted from auto-sync.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/submissions/current-week
 * Returns status of all departments for the current week (Submitted vs Pending)
 */
app.get('/api/submissions/current-week', async (req, res) => {
  try {
    const currentWeekStart = getWeekStartDate();
    const departments = await dbAsync.all('SELECT * FROM departments ORDER BY name ASC');
    const computers = await dbAsync.all('SELECT * FROM computers');
    const submissions = await dbAsync.all(
      'SELECT * FROM submissions WHERE week_start_date = ?',
      [currentWeekStart]
    );

    // Fast parallel reachability and live service probe for all computers
    let hasOnlinePending = false;
    const computersWithStatus = await Promise.all(
      computers.map(async (c) => {
        // Probe live service status on the workstation using Computer Name and MAC Address (no IP caching)
        let liveCheck = await getLiveSpoolerStatus({ pc_name: c.pc_name, mac_address: c.mac_address }, c.department_id);

        const isOnline = liveCheck.online;
        const liveStatus = liveCheck.status; // 'Running', 'Stopped', 'Offline', 'Unknown'
        const liveStartType = liveCheck.startType;
        const isRunning = liveCheck.isRunning;

        // Compare against department desired policy
        const dept = departments.find(d => d.id === c.department_id);
        const desiredStatus = dept ? (dept.spooler_status || 'ACTIVE') : 'ACTIVE';
        const isOverridden = isOnline && isRunning && desiredStatus === 'BLOCKED';

        // Detect if workstation came online while in pending block or pending unblock
        if (isOnline && (c.spooler_status === 'PENDING_BLOCK' || c.spooler_status === 'PENDING_UNBLOCK')) {
          hasOnlinePending = true;
        }

        // Determine workstation status
        let pcSpoolerStatus = c.spooler_status || 'ACTIVE';
        if (isOnline) {
          pcSpoolerStatus = isRunning ? 'ACTIVE' : 'BLOCKED';
        } else {
          pcSpoolerStatus = desiredStatus === 'BLOCKED' ? 'PENDING_BLOCK' : (c.spooler_status === 'PENDING_UNBLOCK' ? 'PENDING_UNBLOCK' : 'ACTIVE');
        }

        return {
          ...c,
          is_online: isOnline,
          online_reason: liveCheck.reason,
          spooler_status: pcSpoolerStatus,
          live_service_status: liveStatus,
          live_start_type: liveStartType,
          is_running: isRunning,
          is_overridden: isOverridden
        };
      })
    );

    // If an offline PC just booted up and has pending block/unblock actions, auto-sync immediately in background
    if (hasOnlinePending) {
      syncPendingWorkstations().catch(err => console.error('[-] Auto-sync error on powered-on PC:', err.message));
    }

    const data = departments.map((dept) => {
      const sub = submissions.find((s) => s.department_id === dept.id);
      const deptComputers = computersWithStatus.filter((c) => c.department_id === dept.id);
      const hasOverride = deptComputers.some(c => c.is_overridden === true);
      const overriddenPC = deptComputers.find(c => c.is_overridden === true);

      return {
        id: dept.id,
        name: dept.name,
        spooler_status: dept.spooler_status || 'ACTIVE',
        has_override: hasOverride,
        override_pc: overriddenPC ? overriddenPC.pc_name : null,
        last_action_at: dept.last_action_at,
        computers: deptComputers,
        submission: sub
          ? {
              id: sub.id,
              print_count: sub.print_count,
              status: sub.status,
              submitted_at: sub.submitted_at,
              supervisor_name: sub.supervisor_name,
              pc_name: sub.pc_name,
              notes: sub.notes,
              screenshot_path: sub.screenshot_path
            }
          : {
              status: 'Pending',
              print_count: null,
              submitted_at: null,
              pc_name: null,
              screenshot_path: null
            }
      };
    });

    res.json({
      weekStartDate: currentWeekStart,
      departments: data
    });
  } catch (error) {
    console.error('[-] Error fetching current-week submissions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/submissions/history
 * Returns historical weekly records categorized by week and date
 */
app.get('/api/submissions/history', async (req, res) => {
  try {
    const { week } = req.query;
    const departments = await dbAsync.all('SELECT * FROM departments ORDER BY name ASC');
    const currentWeek = getWeekStartDate();

    const rawWeeks = await dbAsync.all('SELECT DISTINCT week_start_date FROM submissions ORDER BY week_start_date DESC');
    const weekList = rawWeeks.map((w) => w.week_start_date);
    if (!weekList.includes(currentWeek)) {
      weekList.unshift(currentWeek);
    }

    const selectedWeek = week || currentWeek;

    if (selectedWeek === 'all') {
      const allSubmissions = await dbAsync.all(`
        SELECT s.*, d.name as department_name 
        FROM submissions s
        JOIN departments d ON s.department_id = d.id
        ORDER BY s.week_start_date DESC, d.name ASC
      `);
      return res.json({
        weeks: weekList,
        selectedWeek: 'all',
        records: allSubmissions
      });
    }

    // Specific week: return all departments with their submission record or pending
    const submissions = await dbAsync.all(
      `SELECT s.*, d.name as department_name 
       FROM submissions s 
       JOIN departments d ON s.department_id = d.id 
       WHERE s.week_start_date = ?`,
      [selectedWeek]
    );

    const records = departments.map((d) => {
      const sub = submissions.find((s) => s.department_id === d.id);
      return {
        id: sub ? sub.id : null,
        department_id: d.id,
        department_name: d.name,
        week_start_date: selectedWeek,
        print_count: sub ? sub.print_count : 0,
        status: sub ? sub.status : 'Pending',
        supervisor_name: sub ? sub.supervisor_name : null,
        pc_name: sub ? sub.pc_name : null,
        notes: sub ? sub.notes : null,
        screenshot_path: sub ? sub.screenshot_path : null,
        submitted_at: sub ? sub.submitted_at : null
      };
    });

    res.json({
      weeks: weekList,
      selectedWeek,
      records
    });
  } catch (error) {
    console.error('[-] Error fetching submission history:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/submissions
 * Supervisor submits weekly print count for their department.
 * - Saves submission into database with optional screenshot photo (max 5 MB, png/jpg)
 * - Automatically triggers PowerShell unblock command on department PCs if previously blocked or pending
 */
app.post('/api/submissions', async (req, res) => {
  let { department_id, location, print_count, supervisor_name, pc_name, notes, screenshot_base64 } = req.body;

  try {
    // If department_id is not provided, look up by location name
    if (!department_id && location && location.trim()) {
      const foundDept = await dbAsync.get('SELECT id, name FROM departments WHERE LOWER(name) = LOWER(?)', [location.trim()]);
      if (foundDept) {
        department_id = foundDept.id;
      }
    }

    if (!department_id) {
      return res.status(400).json({ error: 'Location / Department is required.' });
    }

    const count = parseInt(print_count, 10);
    if (isNaN(count) || count < 0) {
      return res.status(400).json({ error: 'Print count must be a non-negative number.' });
    }

    const currentWeekStart = getWeekStartDate();

    // 1. Verify department exists
    const dept = await dbAsync.get('SELECT * FROM departments WHERE id = ?', [department_id]);
    if (!dept) {
      return res.status(404).json({ error: 'Selected location / department does not exist.' });
    }

    const locName = location && location.trim() ? location.trim() : dept.name;

    // Process photo if provided (PNG / JPG / JPEG, max 5 MB)
    let screenshotPath = null;
    if (screenshot_base64 && typeof screenshot_base64 === 'string' && screenshot_base64.includes(';base64,')) {
      const parts = screenshot_base64.split(';base64,');
      const mime = parts[0].toLowerCase();
      let ext = 'jpg';
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
      else {
        return res.status(400).json({ error: 'Invalid photo format. Only PNG, JPG, and JPEG images are allowed.' });
      }

      const cleanBase64 = parts[1].replace(/\s/g, '');
      const buffer = Buffer.from(cleanBase64, 'base64');

      // Enforce 5 MB maximum size limit
      const MAX_BYTES = 5 * 1024 * 1024;
      if (buffer.length > MAX_BYTES) {
        return res.status(400).json({ error: 'Photo exceeds the 5 MB maximum file size limit.' });
      }

      const filename = `counter_dept_${department_id}_${currentWeekStart}_${Date.now()}.${ext}`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);
      screenshotPath = `/uploads/${filename}`;
      console.log(`[+] Saved counter screenshot: ${screenshotPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
    }

    // 2. Check if a submission already exists for this week
    const existing = await dbAsync.get(
      'SELECT id, screenshot_path, status, supervisor_name, print_count FROM submissions WHERE department_id = ? AND week_start_date = ?',
      [department_id, currentWeekStart]
    );

    // Prevent re-entering or overwriting an already-submitted count for this week
    if (existing && existing.status === 'Submitted' && !req.body.admin_override) {
      return res.status(409).json({
        error: `This week's print count for "${dept.name}" has already been submitted by "${existing.supervisor_name || 'Supervisor'}" (${(existing.print_count || 0).toLocaleString()} pages). Re-entry is not allowed.`
      });
    }

    const finalSupervisor = (supervisor_name && supervisor_name.trim()) 
      ? supervisor_name.trim() 
      : (pc_name ? pc_name.trim() : 'Supervisor');

    let submissionId = null;
    if (existing) {
      // Update pending submission
      const finalScreenshot = screenshotPath || existing.screenshot_path;
      await dbAsync.run(
        `UPDATE submissions 
         SET print_count = ?, status = 'Submitted', supervisor_name = ?, pc_name = ?, location = ?, notes = ?, screenshot_path = ?, submitted_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [count, finalSupervisor, pc_name || null, locName, notes || null, finalScreenshot, existing.id]
      );
      screenshotPath = finalScreenshot;
      submissionId = existing.id;
    } else {
      // Insert new submission
      const insertResult = await dbAsync.run(
        `INSERT INTO submissions (department_id, print_count, week_start_date, status, supervisor_name, pc_name, location, notes, screenshot_path)
         VALUES (?, ?, ?, 'Submitted', ?, ?, ?, ?, ?)`,
        [department_id, count, currentWeekStart, finalSupervisor, pc_name || null, locName, notes || null, screenshotPath]
      );
      submissionId = insertResult.lastID;
    }

    console.log(`[+] Submission recorded for "${dept.name}" by "${finalSupervisor}" (Count: ${count}, PC: ${pc_name || 'N/A'}, Location: ${locName}).`);

    // Synchronize to Star Schema Fact Table (fact_printer_count)
    try {
      let matchedUser = null;
      if (pc_name && pc_name.trim()) {
        matchedUser = await dbAsync.get('SELECT uid FROM user_master WHERE LOWER(pc_name) = LOWER(?)', [pc_name.trim()]);
      }
      if (!matchedUser && finalSupervisor) {
        matchedUser = await dbAsync.get('SELECT uid FROM user_master WHERE LOWER(name) = LOWER(?)', [finalSupervisor]);
      }
      if (!matchedUser) {
        matchedUser = await dbAsync.get('SELECT uid FROM user_master ORDER BY uid ASC LIMIT 1');
      }

      let matchedPrinter = null;
      if (department_id) {
        matchedPrinter = await dbAsync.get('SELECT printer_id FROM printer_master WHERE dep_id = ? LIMIT 1', [department_id]);
      }
      if (!matchedPrinter && finalLocation) {
        matchedPrinter = await dbAsync.get('SELECT printer_id FROM printer_master WHERE LOWER(location) = LOWER(?) LIMIT 1', [finalLocation]);
      }
      if (!matchedPrinter && finalLocation) {
        matchedPrinter = await dbAsync.get('SELECT printer_id FROM printer_master WHERE LOWER(location) LIKE LOWER(?) LIMIT 1', [`%${finalLocation}%`]);
      }

      const dateId = await getOrCreateDateId(new Date());

      if (matchedUser && matchedPrinter) {
        await dbAsync.run(
          `INSERT INTO fact_printer_count (uid, dep_id, printer_id, date_id, print_count, screenshot_path, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [matchedUser.uid, department_id, matchedPrinter.printer_id, dateId, count, screenshotPath, notes || 'Supervisor weekly submission']
        );
        console.log(`[+] Star Schema fact_printer_count synced for department ${department_id} (count: ${count}).`);
      }
    } catch (factErr) {
      console.warn('[-] Fact table sync warning:', factErr.message);
    }

    // 3. Automated Unblock: Trigger PowerShell command to re-enable Spooler on department PCs
    let unblockResult = null;
    try {
      unblockResult = await unblockDepartmentPrinters(department_id, 'Supervisor submitted print count');
    } catch (unblockErr) {
      console.error('[-] Failed during automated unblock:', unblockErr.message);
      unblockResult = { error: unblockErr.message };
    }

    res.json({
      success: true,
      message: `Weekly print count (${count}) submitted successfully for ${dept.name}.`,
      spoolerUnblocked: true,
      submissionId,
      screenshot_path: screenshotPath,
      unblockDetails: unblockResult
    });
  } catch (error) {
    console.error('[-] Submission processing error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/submissions/:id/screenshot
 * Admin attaches or replaces a counter photo for a specific submission
 */
app.post('/api/admin/submissions/:id/screenshot', async (req, res) => {
  const submissionId = parseInt(req.params.id, 10);
  const { screenshot_base64 } = req.body;

  if (!submissionId) {
    return res.status(400).json({ error: 'Valid submission ID is required.' });
  }

  if (!screenshot_base64 || typeof screenshot_base64 !== 'string' || !screenshot_base64.includes(';base64,')) {
    return res.status(400).json({ error: 'Valid photo base64 data is required.' });
  }

  try {
    const sub = await dbAsync.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!sub) {
      return res.status(404).json({ error: 'Submission record not found.' });
    }

    const parts = screenshot_base64.split(';base64,');
    const mime = parts[0].toLowerCase();
    let ext = 'jpg';
    if (mime.includes('png')) ext = 'png';
    else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else {
      return res.status(400).json({ error: 'Only PNG, JPG, and JPEG images are allowed.' });
    }

    const cleanBase64 = parts[1].replace(/\s/g, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    const MAX_BYTES = 5 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Photo exceeds the 5 MB maximum file size limit.' });
    }

    const filename = `counter_sub_${submissionId}_${Date.now()}.${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, buffer);
    const screenshotPath = `/uploads/${filename}`;

    await dbAsync.run(
      'UPDATE submissions SET screenshot_path = ? WHERE id = ?',
      [screenshotPath, submissionId]
    );

    console.log(`[+] Admin attached photo to submission #${submissionId}: ${screenshotPath}`);

    res.json({
      success: true,
      screenshot_path: screenshotPath,
      message: 'Counter photo attached successfully.'
    });
  } catch (error) {
    console.error('[-] Error attaching photo in admin:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/submissions/:id/screenshot
 * Deletes counter photo from a submission and removes file from disk
 */
app.delete('/api/admin/submissions/:id/screenshot', async (req, res) => {
  const submissionId = parseInt(req.params.id, 10);
  if (!submissionId) {
    return res.status(400).json({ error: 'Valid submission ID is required.' });
  }

  try {
    const sub = await dbAsync.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!sub) {
      return res.status(404).json({ error: 'Submission record not found.' });
    }

    if (sub.screenshot_path) {
      const fullPath = path.join(__dirname, 'public', sub.screenshot_path.replace(/^\//, ''));
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (e) { console.warn('Could not delete image file:', e.message); }
      }
    }

    await dbAsync.run('UPDATE submissions SET screenshot_path = NULL WHERE id = ?', [submissionId]);

    // Also update fact_printer_count if present
    await dbAsync.run(
      'UPDATE fact_printer_count SET screenshot_path = NULL WHERE dep_id = ? AND date_id = (SELECT date_id FROM date_master WHERE full_date = ?)',
      [sub.department_id, sub.week_start_date]
    ).catch(() => {});

    console.log(`[+] Deleted counter photo for submission #${submissionId}`);
    res.json({ success: true, message: 'Counter photo deleted successfully.' });
  } catch (error) {
    console.error('[-] Error deleting photo:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/submissions/:id/screenshot
 * Supervisor deletes counter photo from their weekly submission
 */
app.delete('/api/submissions/:id/screenshot', async (req, res) => {
  const submissionId = parseInt(req.params.id, 10);
  if (!submissionId) {
    return res.status(400).json({ error: 'Valid submission ID is required.' });
  }

  try {
    const sub = await dbAsync.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!sub) {
      return res.status(404).json({ error: 'Submission record not found.' });
    }

    if (sub.screenshot_path) {
      const fullPath = path.join(__dirname, 'public', sub.screenshot_path.replace(/^\//, ''));
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (e) { console.warn('Could not delete image file:', e.message); }
      }
    }

    await dbAsync.run('UPDATE submissions SET screenshot_path = NULL WHERE id = ?', [submissionId]);

    await dbAsync.run(
      'UPDATE fact_printer_count SET screenshot_path = NULL WHERE dep_id = ? AND date_id = (SELECT date_id FROM date_master WHERE full_date = ?)',
      [sub.department_id, sub.week_start_date]
    ).catch(() => {});

    console.log(`[+] Supervisor deleted counter photo for submission #${submissionId}`);
    res.json({ success: true, message: 'Counter photo deleted successfully.' });
  } catch (error) {
    console.error('[-] Error deleting photo:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/submissions/:id
 * Delete/reset an incorrect print count submission so the supervisor can re-enter it
 */
app.delete('/api/submissions/:id', async (req, res) => {
  const submissionId = parseInt(req.params.id, 10);
  if (!submissionId) {
    return res.status(400).json({ error: 'Valid submission ID is required.' });
  }

  try {
    const sub = await dbAsync.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!sub) {
      return res.status(404).json({ error: 'Submission record not found or already deleted.' });
    }

    const dept = await dbAsync.get('SELECT * FROM departments WHERE id = ?', [sub.department_id]);
    const deptName = dept ? dept.name : `Department #${sub.department_id}`;

    // 1. Delete associated counter photo from disk if present
    if (sub.screenshot_path) {
      const fullPath = path.join(__dirname, 'public', sub.screenshot_path.replace(/^\//, ''));
      if (fs.existsSync(fullPath)) {
        try { 
          fs.unlinkSync(fullPath); 
          console.log(`[+] Deleted screenshot file from disk: ${fullPath}`);
        } catch (e) { 
          console.warn('Could not delete image file:', e.message); 
        }
      }
    }

    // 2. Remove matching entry from fact_printer_count to maintain accurate reports
    await dbAsync.run(
      `DELETE FROM fact_printer_count 
       WHERE dep_id = ? AND (print_count = ? OR screenshot_path = ?)`,
      [sub.department_id, sub.print_count, sub.screenshot_path || '']
    ).catch(err => console.warn('[-] Fact table cleanup warning:', err.message));

    // 3. Delete the submission row from database
    await dbAsync.run('DELETE FROM submissions WHERE id = ?', [submissionId]);

    console.log(`[+] Deleted incorrect submission #${submissionId} for "${deptName}" (${sub.print_count} pages). Unlocked for re-entry.`);
    res.json({
      success: true,
      message: `Incorrect print count (${(sub.print_count || 0).toLocaleString()} pages) for "${deptName}" has been deleted. You can now re-enter the correct count.`,
      department_id: sub.department_id
    });
  } catch (error) {
    console.error('[-] Error deleting submission:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/computers/live-status
 * Returns online/offline connectivity status for all registered computers in parallel
 */
app.get('/api/computers/live-status', async (req, res) => {
  try {
    const computers = await dbAsync.all('SELECT * FROM computers');
    const statuses = await Promise.all(
      computers.map(async (c) => {
        const check = await checkWorkstationOnline({
          pc_name: c.pc_name,
          mac_address: c.mac_address
        });
        return {
          id: c.id,
          pc_name: c.pc_name,
          mac_address: c.mac_address,
          location: c.location,
          is_online: check.online,
          reason: check.reason,
          tracked_by: check.resolvedIp ? 'MAC Address' : (check.online ? 'PC Name' : 'Offline'),
          resolved_ip: check.resolvedIp || null,
          spooler_status: c.spooler_status
        };
      })
    );
    res.json(statuses);
  } catch (error) {
    console.error('[-] Error fetching live computer statuses:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/block/:id
 * Manual override to block printers for a department
 */
app.post('/api/admin/block/:id', async (req, res) => {
  const departmentId = parseInt(req.params.id, 10);
  try {
    const result = await blockDepartmentPrinters(departmentId, 'Manual Admin Override');
    res.json({
      success: true,
      result,
      action: 'BLOCK',
      department: result.department,
      hasOffline: result.hasOffline,
      allOffline: result.allOffline,
      offlinePCs: result.offlinePCs || [],
      onlinePCs: result.onlinePCs || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/unblock/:id
 * Manual override to unblock printers for a department
 */
app.post('/api/admin/unblock/:id', async (req, res) => {
  const departmentId = parseInt(req.params.id, 10);
  try {
    const result = await unblockDepartmentPrinters(departmentId, 'Manual Admin Override');
    res.json({
      success: true,
      result,
      action: 'UNBLOCK',
      department: result.department,
      hasOffline: result.hasOffline,
      allOffline: result.allOffline,
      offlinePCs: result.offlinePCs || [],
      onlinePCs: result.onlinePCs || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/trigger-deadline-check
 * Manually trigger the Monday 2:00 PM evaluation logic on demand
 */
app.post('/api/admin/trigger-deadline-check', async (req, res) => {
  try {
    const result = await checkAndBlockNonCompliantDepartments();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/sync-pending
 * Check and execute pending BLOCK or UNBLOCK on workstations that were offline
 */
app.post('/api/admin/sync-pending', async (req, res) => {
  try {
    const result = await syncPendingWorkstations();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/logs
 * Retrieve recent PowerShell and system action logs
 */
app.get('/api/admin/logs', async (req, res) => {
  try {
    const logs = await dbAsync.all(`
      SELECT l.*, d.name as department_name
      FROM action_logs l
      LEFT JOIN departments d ON l.department_id = d.id
      ORDER BY l.executed_at DESC
      LIMIT 100
    `);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MONTHLY PRINTER USAGE REPORT & CHARTS API
// ==========================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * GET /api/reports/available-months
 * Returns list of distinct months with actual recorded submissions or readings
 */
app.get('/api/reports/available-months', async (req, res) => {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // Months from real submissions
    const subMonths = await dbAsync.all(`
      SELECT DISTINCT 
        CAST(strftime('%Y', week_start_date) AS INTEGER) as year,
        CAST(strftime('%m', week_start_date) AS INTEGER) as month
      FROM submissions
      WHERE status = 'Submitted'
    `);

    // Months from printer_monthly_readings
    const readMonths = await dbAsync.all(`
      SELECT DISTINCT year, month FROM printer_monthly_readings
    `);

    const combined = [{ year: currentYear, month: currentMonth }];
    [...subMonths, ...readMonths].forEach(m => {
      if (m.year && m.month && !combined.some(c => c.year === m.year && c.month === m.month)) {
        combined.push({ year: m.year, month: m.month });
      }
    });

    combined.sort((a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month));

    const result = combined.map(m => ({
      year: m.year,
      month: m.month,
      label: `${MONTH_NAMES[m.month - 1]} ${m.year}`,
      key: `${m.year}-${m.month}`
    }));

    res.json(result);
  } catch (error) {
    console.error('[-] Error fetching available months:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reports/monthly-usage
 * Generates printer usage report:
 * Location | Serial Number | n month printer count total | previous to n month printer count total | n month printer count usage
 * Formula: n month printer count usage = n month total printer count - previous month to n month printer count total
 */
app.get('/api/reports/monthly-usage', async (req, res) => {
  try {
    const now = new Date();
    let targetYear = parseInt(req.query.year, 10);
    let targetMonth = null;

    if (req.query.month && typeof req.query.month === 'string' && req.query.month.includes('-')) {
      const parts = req.query.month.split('-');
      targetYear = parseInt(parts[0], 10);
      targetMonth = parseInt(parts[1], 10);
    } else if (req.query.month) {
      targetMonth = parseInt(req.query.month, 10);
    }

    if (!targetYear || isNaN(targetYear)) targetYear = now.getFullYear();
    if (!targetMonth || isNaN(targetMonth)) targetMonth = (now.getMonth() + 1);

    // Calculate previous month (Month N-1)
    const prevYear = targetMonth === 1 ? targetYear - 1 : targetYear;
    const prevMonth = targetMonth === 1 ? 12 : targetMonth - 1;

    const nMonthName = MONTH_NAMES[targetMonth - 1] || 'Current Month';
    const prevMonthName = MONTH_NAMES[prevMonth - 1] || 'Previous Month';

    // Get all registered printers from printer_master
    const printers = await dbAsync.all(`
      SELECT printer_id, location, serial_number, printer_model
      FROM printer_master
      ORDER BY location ASC, printer_id ASC
    `);

    const formattedTargetMonth = String(targetMonth).padStart(2, '0');
    const formattedPrevMonth = String(prevMonth).padStart(2, '0');

    let totalNCount = 0;
    let totalPrevCount = 0;
    let totalUsage = 0;

    const rows = [];

    for (const p of printers) {
      // 1. Get n Month printer count total
      // Priority A: Explicit entry in printer_monthly_readings
      let nRow = await dbAsync.get(`
        SELECT total_count FROM printer_monthly_readings
        WHERE printer_id = ? AND year = ? AND month = ?
      `, [p.printer_id, targetYear, targetMonth]);

      // Priority B: Latest print count from submissions in month N
      if (!nRow || nRow.total_count == null) {
        nRow = await dbAsync.get(`
          SELECT MAX(print_count) as total_count FROM submissions
          WHERE (printer_id = ? OR location = ?) AND strftime('%Y', week_start_date) = ? AND strftime('%m', week_start_date) = ?
            AND status = 'Submitted'
        `, [p.printer_id, p.location, String(targetYear), formattedTargetMonth]);
      }

      // Priority C: Latest count from fact_printer_count linked to date_master
      if (!nRow || nRow.total_count == null) {
        nRow = await dbAsync.get(`
          SELECT MAX(f.print_count) as total_count FROM fact_printer_count f
          JOIN date_master d ON f.date_id = d.date_id
          WHERE f.printer_id = ? AND d.year = ? AND d.month = ?
        `, [p.printer_id, targetYear, targetMonth]);
      }

      // 2. Get previous to n Month printer count total
      let prevRow = await dbAsync.get(`
        SELECT total_count FROM printer_monthly_readings
        WHERE printer_id = ? AND year = ? AND month = ?
      `, [p.printer_id, prevYear, prevMonth]);

      if (!prevRow || prevRow.total_count == null) {
        prevRow = await dbAsync.get(`
          SELECT MAX(print_count) as total_count FROM submissions
          WHERE (printer_id = ? OR location = ?) AND strftime('%Y', week_start_date) = ? AND strftime('%m', week_start_date) = ?
            AND status = 'Submitted'
        `, [p.printer_id, p.location, String(prevYear), formattedPrevMonth]);
      }

      if (!prevRow || prevRow.total_count == null) {
        prevRow = await dbAsync.get(`
          SELECT MAX(f.print_count) as total_count FROM fact_printer_count f
          JOIN date_master d ON f.date_id = d.date_id
          WHERE f.printer_id = ? AND d.year = ? AND d.month = ?
        `, [p.printer_id, prevYear, prevMonth]);
      }

      const nCount = (nRow && nRow.total_count != null) ? nRow.total_count : 0;
      const prevCount = (prevRow && prevRow.total_count != null) ? prevRow.total_count : 0;

      // Usage = n month total - previous month total
      let usage = 0;
      if (nCount > 0 && prevCount > 0) {
        usage = Math.max(0, nCount - prevCount);
      } else if (nCount > 0 && prevCount === 0) {
        usage = nCount;
      }

      totalNCount += nCount;
      totalPrevCount += prevCount;
      totalUsage += usage;

      rows.push({
        printer_id: p.printer_id,
        location: p.location,
        serial_number: p.serial_number,
        model: p.printer_model,
        n_month_total: nCount,
        prev_month_total: prevCount,
        usage: usage
      });
    }

    res.json({
      targetYear,
      targetMonth,
      targetMonthName: `${nMonthName} ${targetYear}`,
      prevYear,
      prevMonth,
      prevMonthName: `${prevMonthName} ${prevYear}`,
      headerNMonth: `TOTAL COUNT ${nMonthName.toUpperCase()}`,
      headerPrevMonth: `TOTAL COUNT ${prevMonthName.toUpperCase()}`,
      headerUsage: `${nMonthName.toUpperCase()} USAGE`,
      totalNCount,
      totalPrevCount,
      totalUsage,
      rows
    });
  } catch (error) {
    console.error('[-] Error generating monthly usage report:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reports/monthly-reading
 * Saves or updates a real monthly total count for a printer
 */
app.post('/api/reports/monthly-reading', async (req, res) => {
  let { printer_id, year, month, total_count, cumulative_count, notes } = req.body;
  const pId = parseInt(printer_id, 10);
  const count = parseInt(total_count != null ? total_count : cumulative_count, 10);

  let y = parseInt(year, 10);
  let m = null;
  if (typeof month === 'string' && month.includes('-')) {
    const parts = month.split('-');
    y = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
  } else {
    m = parseInt(month, 10);
  }
  if (!y || isNaN(y)) y = new Date().getFullYear();

  if (isNaN(pId) || isNaN(y) || isNaN(m) || isNaN(count) || count < 0) {
    return res.status(400).json({ error: 'Valid printer_id, year, month, and non-negative total_count are required.' });
  }

  try {
    await dbAsync.run(`
      INSERT INTO printer_monthly_readings (printer_id, year, month, total_count, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(printer_id, year, month) DO UPDATE SET
        total_count = excluded.total_count,
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `, [pId, y, m, count, notes || null]);

    res.json({ success: true, message: 'Monthly printer reading saved successfully.' });
  } catch (error) {
    console.error('[-] Error saving monthly reading:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/usage-charts
 * Returns weekly and monthly aggregated printer usage for Chart.js
 */
app.get('/api/analytics/usage-charts', async (req, res) => {
  try {
    // 1. Weekly Printer Usage (from real submissions, grouped by week_start_date)
    const weeklyData = await dbAsync.all(`
      SELECT 
        s.week_start_date,
        SUM(s.print_count) as total_prints,
        COUNT(DISTINCT s.department_id) as depts_count,
        COUNT(s.id) as submissions_count
      FROM submissions s
      WHERE s.status = 'Submitted'
      GROUP BY s.week_start_date
      ORDER BY s.week_start_date ASC
      LIMIT 12
    `);

    // 2. Monthly Printer Usage (from real submissions and monthly readings)
    const monthlyData = await dbAsync.all(`
      SELECT 
        CAST(strftime('%Y', s.week_start_date) AS INTEGER) as year,
        CAST(strftime('%m', s.week_start_date) AS INTEGER) as month,
        SUM(s.print_count) as total_prints,
        COUNT(s.id) as submissions_count
      FROM submissions s
      WHERE s.status = 'Submitted'
      GROUP BY strftime('%Y', s.week_start_date), strftime('%m', s.week_start_date)
      ORDER BY year ASC, month ASC
      LIMIT 12
    `);

    // Format weekly chart dataset
    const weeklyLabels = [];
    const weeklyValues = [];
    weeklyData.forEach(w => {
      const d = new Date(w.week_start_date + 'T00:00:00');
      const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      weeklyLabels.push(`Wk ${w.week_start_date.substring(5)} (${label})`);
      weeklyValues.push(w.total_prints || 0);
    });

    // Format monthly chart dataset
    const monthlyLabels = [];
    const monthlyValues = [];
    monthlyData.forEach(m => {
      const monthName = MONTH_NAMES[m.month - 1] || `Month ${m.month}`;
      monthlyLabels.push(`${monthName.substring(0, 3)} ${m.year}`);
      monthlyValues.push(m.total_prints || 0);
    });

    // Overall summary metrics
    const totalPrintsAllTime = weeklyData.reduce((acc, w) => acc + (w.total_prints || 0), 0);
    const avgWeeklyPrints = weeklyData.length > 0 ? Math.round(totalPrintsAllTime / weeklyData.length) : 0;

    // Additional live KPIs
    const totalPrintersRow = await dbAsync.get('SELECT COUNT(*) as c, COUNT(DISTINCT location) as locs FROM printer_master');
    const latestWeekly = weeklyData.length > 0 ? weeklyData[weeklyData.length - 1].total_prints : 0;
    const latestMonthly = monthlyData.length > 0 ? monthlyData[monthlyData.length - 1].total_prints : 0;

    res.json({
      summary: {
        totalPrints: totalPrintsAllTime,
        avgWeeklyPrints,
        activeWeeksCount: weeklyData.length,
        activeMonthsCount: monthlyData.length
      },
      kpis: {
        total_printers: totalPrintersRow ? totalPrintersRow.c : 0,
        current_week_pages: latestWeekly,
        latest_monthly_usage: latestMonthly,
        total_locations: totalPrintersRow ? totalPrintersRow.locs : 0
      },
      weekly: {
        labels: weeklyLabels,
        data: weeklyValues,
        raw: weeklyData
      },
      monthly: {
        labels: monthlyLabels,
        data: monthlyValues,
        raw: monthlyData
      }
    });
  } catch (error) {
    console.error('[-] Error fetching usage charts data:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// AUTHENTICATION ROUTES (USER MASTER)
// ==========================================

/**
 * POST /api/auth/login
 * Authenticates user against 'user_master' by PC Name or Name + Password
 */
app.post('/api/auth/login', async (req, res) => {
  const { identifier, pc_name, name, password } = req.body;
  const loginId = identifier || pc_name || name;

  if (!loginId || !password) {
    return res.status(400).json({ error: 'User/PC Name and Password are required.' });
  }

  try {
    const user = await dbAsync.get(
      `SELECT u.uid, u.name, u.email, u.location, u.mac_address, u.pc_name, u.role, u.dep_id, d.department_name
       FROM user_master u
       LEFT JOIN department_master d ON u.dep_id = d.dep_id
       WHERE (LOWER(u.pc_name) = LOWER(?) OR LOWER(u.name) = LOWER(?) OR LOWER(COALESCE(u.email, '')) = LOWER(?))
         AND u.password = ?`,
      [loginId.trim(), loginId.trim(), loginId.trim(), password]
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid login credentials. Please check your PC/User Name/Email and Password.' });
    }

    res.json({
      success: true,
      user: {
        uid: user.uid,
        name: user.name,
        email: user.email,
        location: user.location,
        pc_name: user.pc_name,
        mac_address: user.mac_address,
        role: user.role,
        dep_id: user.dep_id,
        department_name: user.department_name || user.location
      }
    });
  } catch (error) {
    console.error('[-] Login error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/auth/verify
 * Verifies current user session
 */
app.get('/api/auth/verify', async (req, res) => {
  const { uid, pc_name } = req.query;
  try {
    let user = null;
    if (uid) {
      user = await dbAsync.get(
        `SELECT u.uid, u.name, u.email, u.location, u.mac_address, u.pc_name, u.role, u.dep_id, d.department_name
         FROM user_master u
         LEFT JOIN department_master d ON u.dep_id = d.dep_id
         WHERE u.uid = ?`,
        [parseInt(uid, 10)]
      );
    } else if (pc_name) {
      user = await dbAsync.get(
        `SELECT u.uid, u.name, u.email, u.location, u.mac_address, u.pc_name, u.role, u.dep_id, d.department_name
         FROM user_master u
         LEFT JOIN department_master d ON u.dep_id = d.dep_id
         WHERE LOWER(u.pc_name) = LOWER(?)`,
        [pc_name.trim()]
      );
    }

    if (!user) {
      return res.status(404).json({ authenticated: false, error: 'User not found' });
    }

    res.json({ authenticated: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/system/client-network
 * Auto-detects caller hostname, active MAC address and client IP
 */
app.get('/api/system/client-network', async (req, res) => {
  try {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.replace('::ffff:', '');
    }

    const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '' || clientIp === 'localhost';
    let pcName = '';
    let macAddress = '';

    if (isLocalhost) {
      pcName = os.hostname();
      const ifaces = os.networkInterfaces();
      for (const ifaceName of Object.keys(ifaces)) {
        for (const netInfo of ifaces[ifaceName]) {
          if (!netInfo.internal && netInfo.mac && netInfo.mac !== '00:00:00:00:00:00') {
            macAddress = normalizeMacAddress(netInfo.mac);
            if (netInfo.family === 'IPv4') {
              break;
            }
          }
        }
        if (macAddress) break;
      }
    } else {
      // For remote network clients, probe ARP table for client IP
      macAddress = await new Promise((resolve) => {
        execFile('arp', ['-a', clientIp], { timeout: 2000 }, (err, stdout) => {
          if (!err && stdout) {
            const match = stdout.match(/([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})/);
            if (match) {
              return resolve(normalizeMacAddress(match[1]));
            }
          }
          resolve('');
        });
      });
    }

    res.json({
      hostname: pcName,
      mac_address: macAddress,
      client_ip: clientIp,
      detected: !!(pcName || macAddress)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/users/create
 * Creates user account & registers PC for dual tracking (PC Name / MAC Address)
 * Required:
 * - User Name
 * - email (@malibangroup.lk)
 * - Location
 * - Mac Address (req)
 * - Pc Name
 * - Password
 * - re-Enter Password
 */
app.post('/api/users/create', async (req, res) => {
  try {
    const { name, email, location, mac_address, pc_name, password, re_enter_password } = req.body;

    // 1. Validation: User Name
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'User Name is required.' });
    }

    // 2. Validation: Email (@malibangroup.lk required, auto-append if omitted)
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    let cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.includes('@')) {
      cleanEmail = cleanEmail + '@malibangroup.lk';
    }
    const malibanEmailRegex = /^[a-zA-Z0-9._%+-]+@malibangroup\.lk$/i;
    if (!malibanEmailRegex.test(cleanEmail)) {
      return res.status(400).json({ 
        error: 'Invalid email domain. Email must belong to the official @malibangroup.lk corporate domain (e.g. yourname@malibangroup.lk).' 
      });
    }

  // 3. Validation: Location
  if (!location || !location.trim()) {
    return res.status(400).json({ error: 'Location is required (e.g. Rathmalana Factory, Head Office, Bake House).' });
  }

  // 4. Validation: MAC Address (req)
  if (!mac_address || !mac_address.trim()) {
    return res.status(400).json({ error: 'MAC Address is required.' });
  }
  if (!isValidMacAddress(mac_address.trim())) {
    return res.status(400).json({ 
      error: 'Invalid MAC Address format. Please provide a valid 12-character physical address (e.g. C8-95-CE-4A-5E-B6 or C8:95:CE:4A:5E:B6).' 
    });
  }
  const cleanMac = normalizeMacAddress(mac_address.trim());

  // 5. Validation: PC Name
  if (!pc_name || !pc_name.trim()) {
    return res.status(400).json({ error: 'PC Name is required.' });
  }
  const cleanPc = pc_name.trim().toUpperCase();

  // 6. Validation: Password & Re-enter Password
  if (!password || !password.trim()) {
    return res.status(400).json({ error: 'Password is required.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
  }
  if (!re_enter_password || password !== re_enter_password) {
    return res.status(400).json({ error: 'Passwords do not match. Please ensure Password and Re-enter Password are identical.' });
  }

  const cleanName = name.trim();
  const cleanLocation = location.trim();
  const cleanPassword = password.trim();

  // Check if user already exists with same email
    const existingEmail = await dbAsync.get('SELECT uid, name FROM user_master WHERE LOWER(email) = LOWER(?)', [cleanEmail]);
    if (existingEmail) {
      return res.status(400).json({ 
        error: `A user account with email "${cleanEmail}" is already registered (User: ${existingEmail.name}).` 
      });
    }

    // Link or create department for this location in departments & department_master
    let dept = await dbAsync.get('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)', [cleanLocation]);
    if (!dept) {
      const newDept = await dbAsync.run(
        'INSERT INTO departments (name, spooler_status) VALUES (?, "ACTIVE")',
        [cleanLocation]
      );
      dept = { id: newDept.lastID };
    }

    let deptMaster = await dbAsync.get('SELECT dep_id FROM department_master WHERE LOWER(department_name) = LOWER(?)', [cleanLocation]);
    if (!deptMaster) {
      const newDm = await dbAsync.run(
        'INSERT INTO department_master (department_name, spooler_status) VALUES (?, "ACTIVE")',
        [cleanLocation]
      );
      deptMaster = { dep_id: newDm.lastID };
    }

    // Insert user into user_master
    const userRes = await dbAsync.run(
      `INSERT INTO user_master (name, email, location, mac_address, pc_name, password, role, dep_id)
       VALUES (?, ?, ?, ?, ?, ?, 'supervisor', ?)`,
      [cleanName, cleanEmail, cleanLocation, cleanMac, cleanPc, cleanPassword, deptMaster.dep_id]
    );

    // Un-blacklist if re-registered explicitly
    if (cleanPc) {
      await dbAsync.run('DELETE FROM excluded_computers WHERE UPPER(pc_name) = ?', [cleanPc]);
    }

    // Register / Update workstation in computers table for Spooler Governance & Dual Tracking
    const existingComp = await dbAsync.get(
      'SELECT id FROM computers WHERE UPPER(pc_name) = ? OR UPPER(mac_address) = ?',
      [cleanPc, cleanMac]
    );

    if (!existingComp) {
      await dbAsync.run(
        `INSERT INTO computers (department_id, pc_name, mac_address, location, notes, spooler_status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
        [dept.id, cleanPc, cleanMac, cleanLocation, `Assigned to: ${cleanName} (${cleanEmail})`]
      );
    } else {
      await dbAsync.run(
        `UPDATE computers 
         SET department_id = ?, pc_name = ?, mac_address = ?, location = ?, notes = ?, spooler_status = 'ACTIVE'
         WHERE id = ?`,
        [dept.id, cleanPc, cleanMac, cleanLocation, `Assigned to: ${cleanName} (${cleanEmail})`, existingComp.id]
      );
    }

    res.status(201).json({
      success: true,
      message: `User "${cleanName}" and PC "${cleanPc}" successfully registered and tracked.`,
      user: {
        uid: userRes.lastID,
        name: cleanName,
        email: cleanEmail,
        location: cleanLocation,
        mac_address: cleanMac,
        pc_name: cleanPc
      }
    });
  } catch (error) {
    console.error('[-] User creation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Also alias POST /api/users to POST /api/users/create
app.post('/api/users', (req, res, next) => {
  req.url = '/api/users/create';
  app._router.handle(req, res, next);
});

/**
 * GET /api/users
 * Returns list of registered users with their tracked PC and MAC address
 */
app.get('/api/users', async (req, res) => {
  try {
    const users = await dbAsync.all(
      `SELECT u.uid, u.name, u.email, u.location, u.mac_address, u.pc_name, u.role, u.dep_id, u.created_at,
              COALESCE(d.department_name, u.location, 'General') as department_name,
              c.id as computer_id,
              c.spooler_status as computer_spooler_status
       FROM user_master u
       LEFT JOIN department_master d ON u.dep_id = d.dep_id
       LEFT JOIN computers c ON UPPER(c.pc_name) = UPPER(u.pc_name) OR UPPER(c.mac_address) = UPPER(u.mac_address)
       ORDER BY u.uid DESC`
    );
    res.json(users);
  } catch (error) {
    console.error('[-] Error fetching users:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/users/track/:uid
 * Live workstation reachability probe using PC Name OR MAC Address (via ARP)
 */
app.get('/api/users/track/:uid', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const user = await dbAsync.get('SELECT * FROM user_master WHERE uid = ?', [uid]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const check = await checkWorkstationOnline({
      pc_name: user.pc_name,
      mac_address: user.mac_address
    });

    res.json({
      uid: user.uid,
      name: user.name,
      pc_name: user.pc_name,
      mac_address: user.mac_address,
      location: user.location,
      online: check.online,
      reason: check.reason,
      resolved_ip: check.resolvedIp || null,
      tracked_by: check.resolvedIp ? 'MAC Address' : (check.online ? 'PC Name / Host' : 'Offline')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/users/:uid
 * Deletes user from user_master
 */
app.delete('/api/users/:uid', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const user = await dbAsync.get('SELECT * FROM user_master WHERE uid = ?', [uid]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.pc_name) {
      const cleanPc = user.pc_name.trim().toUpperCase();
      await dbAsync.run('INSERT OR IGNORE INTO excluded_computers (pc_name) VALUES (?)', [cleanPc]);
      await dbAsync.run('DELETE FROM computers WHERE UPPER(pc_name) = ?', [cleanPc]);
    }

    await dbAsync.run('DELETE FROM user_master WHERE uid = ?', [uid]);
    res.json({ success: true, message: `User "${user.name}" removed.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/locations
 * Returns list of distinct locations along with their assigned branch ('Little Lion 105', 'Little Lion 11'), printer models and serial numbers
 */
app.get('/api/locations', async (req, res) => {
  try {
    const excludedRows = await dbAsync.all('SELECT LOWER(location_name) as name FROM excluded_locations');
    const excludedSet = new Set(excludedRows.map(r => r.name));

    const rows = await dbAsync.all(`
      SELECT DISTINCT location, branch, printer_model, serial_number, 'printer_master' as source 
      FROM printer_master 
      WHERE location IS NOT NULL AND TRIM(location) != ''
      UNION
      SELECT DISTINCT location, branch, model as printer_model, serial_number, 'rental_printers' as source
      FROM rental_printers
      WHERE location IS NOT NULL AND TRIM(location) != ''
      UNION
      SELECT DISTINCT name as location, branch, NULL as printer_model, NULL as serial_number, 'departments' as source
      FROM departments
      WHERE name IS NOT NULL AND TRIM(name) != ''
      UNION
      SELECT DISTINCT location, NULL as branch, NULL as printer_model, NULL as serial_number, 'computers' as source
      FROM computers
      WHERE location IS NOT NULL AND TRIM(location) != ''
    `);

    // Fetch all computers with their associated department
    const computers = await dbAsync.all(`
      SELECT c.id, c.pc_name, c.ip_address, c.mac_address, c.notes, c.spooler_status,
             c.department_id, d.name AS dept_name, c.location
      FROM computers c
      LEFT JOIN departments d ON c.department_id = d.id
    `);

    const locationMap = {};
    for (const r of rows) {
      const loc = r.location.trim();
      if (excludedSet.has(loc.toLowerCase())) continue;

      if (!locationMap[loc]) {
        let assignedBranch = r.branch ? r.branch.trim() : null;
        if (!assignedBranch) {
          if (loc.includes('105')) assignedBranch = 'Little Lion 105';
          else if (loc.includes('11')) assignedBranch = 'Little Lion 11';
          else if (loc.toLowerCase().includes('kandawala')) assignedBranch = 'Kandawala';
        }
        locationMap[loc] = {
          name: loc,
          branch: assignedBranch,
          printers: [],
          computers: [],
          computers_count: 0
        };
      } else if (!locationMap[loc].branch && r.branch) {
        locationMap[loc].branch = r.branch.trim();
      }

      if (r.serial_number && r.serial_number.trim()) {
        const cleanSn = r.serial_number.trim().toUpperCase();
        if (!locationMap[loc].printers.some(p => p.serial_number === cleanSn)) {
          locationMap[loc].printers.push({
            model: r.printer_model ? r.printer_model.trim() : 'Maliban Laser Printer',
            serial_number: cleanSn
          });
        }
      }
    }

    // Attach computers to their corresponding location
    for (const comp of computers) {
      const candidates = [
        comp.location && comp.location.trim(),
        comp.dept_name && comp.dept_name.trim()
      ].filter(Boolean);

      let matchedLoc = null;
      for (const cand of candidates) {
        if (excludedSet.has(cand.toLowerCase())) continue;
        if (locationMap[cand]) {
          matchedLoc = locationMap[cand];
          break;
        }
        const found = Object.values(locationMap).find(
          l => l.name.toLowerCase() === cand.toLowerCase()
        );
        if (found) {
          matchedLoc = found;
          break;
        }
      }

      if (matchedLoc) {
        if (!matchedLoc.computers.some(c => c.id === comp.id)) {
          matchedLoc.computers.push({
            id: comp.id,
            pc_name: comp.pc_name,
            ip_address: comp.ip_address,
            mac_address: comp.mac_address,
            spooler_status: comp.spooler_status,
            notes: comp.notes
          });
          matchedLoc.computers_count = matchedLoc.computers.length;
        }
      }
    }

    const locations = Object.values(locationMap).sort((a, b) => a.name.localeCompare(b.name));
    res.json(locations);
  } catch (error) {
    console.error('[-] Error fetching locations:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/locations/create
 * Creates Location with Company Part ('Little Lion 105' or 'Little Lion 11'), Location Name, Printer Model, and Serial Number
 */
app.post('/api/locations/create', async (req, res) => {
  const { branch, location, printer_model, serial_number } = req.body;

  if (!branch || !branch.trim()) {
    return res.status(400).json({ error: 'Company Part / Division is required. Please select Little Lion 105, Little Lion 11, or Kandawala.' });
  }
  const cleanBranch = branch.trim();
  const validBranches = ['Little Lion 105', 'Little Lion 11', 'Kandawala'];
  if (!validBranches.includes(cleanBranch)) {
    return res.status(400).json({ error: 'Invalid Company Part / Division. Must be Little Lion 105, Little Lion 11, or Kandawala.' });
  }

  if (!location || !location.trim()) {
    return res.status(400).json({ error: 'Location Name is required.' });
  }
  if (!printer_model || !printer_model.trim()) {
    return res.status(400).json({ error: 'Printer Model is required.' });
  }
  if (!serial_number || !serial_number.trim()) {
    return res.status(400).json({ error: 'Serial Number is required.' });
  }

  let cleanLoc = location.trim();
  // Ensure location displays clearly with plant branch if not already included
  if (!cleanLoc.toLowerCase().includes(cleanBranch.toLowerCase()) && !cleanLoc.toLowerCase().includes(cleanBranch.replace('Little Lion ', '').toLowerCase())) {
    cleanLoc = `${cleanBranch} - ${cleanLoc}`;
  }

  const cleanModel = printer_model.trim();
  const cleanSerial = serial_number.trim().toUpperCase();

  try {
    // Un-blacklist if location was previously deleted
    await dbAsync.run('DELETE FROM excluded_locations WHERE LOWER(location_name) = LOWER(?)', [cleanLoc]);

    // 1. Ensure department exists in departments
    let dept = await dbAsync.get('SELECT id, name FROM departments WHERE LOWER(name) = LOWER(?)', [cleanLoc]);
    if (!dept) {
      const insDept = await dbAsync.run(
        'INSERT INTO departments (name, branch, spooler_status) VALUES (?, ?, "ACTIVE")',
        [cleanLoc, cleanBranch]
      );
      dept = { id: insDept.lastID, name: cleanLoc };
    } else {
      await dbAsync.run('UPDATE departments SET branch = ? WHERE id = ?', [cleanBranch, dept.id]);
    }

    // 2. Ensure department exists in department_master
    let deptMaster = await dbAsync.get('SELECT dep_id, department_name FROM department_master WHERE LOWER(department_name) = LOWER(?)', [cleanLoc]);
    if (!deptMaster) {
      const insDm = await dbAsync.run(
        'INSERT INTO department_master (department_name, branch, spooler_status) VALUES (?, ?, "ACTIVE")',
        [cleanLoc, cleanBranch]
      );
      deptMaster = { dep_id: insDm.lastID, department_name: cleanLoc };
    } else {
      await dbAsync.run('UPDATE department_master SET branch = ? WHERE dep_id = ?', [cleanBranch, deptMaster.dep_id]);
    }

    // 3. Insert or update in printer_master
    const existingPrinterMaster = await dbAsync.get('SELECT printer_id FROM printer_master WHERE UPPER(serial_number) = ?', [cleanSerial]);
    if (existingPrinterMaster) {
      await dbAsync.run(
        'UPDATE printer_master SET printer_model = ?, location = ?, branch = ?, dep_id = ? WHERE printer_id = ?',
        [cleanModel, cleanLoc, cleanBranch, deptMaster.dep_id, existingPrinterMaster.printer_id]
      );
    } else {
      await dbAsync.run(
        'INSERT INTO printer_master (printer_model, serial_number, location, branch, dep_id) VALUES (?, ?, ?, ?, ?)',
        [cleanModel, cleanSerial, cleanLoc, cleanBranch, deptMaster.dep_id]
      );
    }

    // 4. Insert or update in rental_printers
    const existingRental = await dbAsync.get('SELECT id FROM rental_printers WHERE UPPER(serial_number) = ?', [cleanSerial]);
    if (existingRental) {
      await dbAsync.run(
        'UPDATE rental_printers SET model = ?, location = ?, branch = ?, department_id = ? WHERE id = ?',
        [cleanModel, cleanLoc, cleanBranch, dept.id, existingRental.id]
      );
    } else {
      await dbAsync.run(
        'INSERT INTO rental_printers (location, serial_number, model, branch, department_id) VALUES (?, ?, ?, ?, ?)',
        [cleanLoc, cleanSerial, cleanModel, cleanBranch, dept.id]
      );
    }

    res.status(201).json({
      success: true,
      message: `Location "${cleanLoc}" (${cleanBranch}) registered with Printer "${cleanModel}" (S/N: ${cleanSerial}).`,
      branch: cleanBranch,
      location: cleanLoc,
      printer_model: cleanModel,
      serial_number: cleanSerial
    });
  } catch (error) {
    console.error('[-] Location creation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/locations/update
 * Updates a Location name, branch, printer model, and serial number across all tables
 */
app.put('/api/locations/update', async (req, res) => {
  const { original_name, branch, location, printer_model, serial_number } = req.body;

  if (!original_name || !original_name.trim()) {
    return res.status(400).json({ error: 'Original location name is required.' });
  }
  if (!location || !location.trim()) {
    return res.status(400).json({ error: 'New location name is required.' });
  }
  if (!branch || !branch.trim()) {
    return res.status(400).json({ error: 'Company Part / Division is required (Little Lion 105, Little Lion 11, or Kandawala).' });
  }

  const origName = original_name.trim();
  const cleanBranch = branch.trim();
  const validBranches = ['Little Lion 105', 'Little Lion 11', 'Kandawala'];
  if (!validBranches.includes(cleanBranch)) {
    return res.status(400).json({ error: 'Invalid Company Part / Division. Must be Little Lion 105, Little Lion 11, or Kandawala.' });
  }
  let cleanLoc = location.trim();
  if (!cleanLoc.toLowerCase().includes(cleanBranch.toLowerCase()) && !cleanLoc.toLowerCase().includes(cleanBranch.replace('Little Lion ', '').toLowerCase())) {
    cleanLoc = `${cleanBranch} - ${cleanLoc}`;
  }

  const cleanModel = printer_model ? printer_model.trim() : 'Maliban Laser Printer';
  const cleanSerial = serial_number ? serial_number.trim().toUpperCase() : null;

  try {
    // Un-blacklist if location was previously deleted
    await dbAsync.run('DELETE FROM excluded_locations WHERE LOWER(location_name) = LOWER(?)', [cleanLoc]);

    // 1. Update departments
    await dbAsync.run(
      'UPDATE departments SET name = ?, branch = ? WHERE LOWER(name) = LOWER(?)',
      [cleanLoc, cleanBranch, origName]
    );

    // 2. Update department_master
    await dbAsync.run(
      'UPDATE department_master SET department_name = ?, branch = ? WHERE LOWER(department_name) = LOWER(?)',
      [cleanLoc, cleanBranch, origName]
    );

    // 3. Update printer_master
    if (cleanSerial) {
      const existingPm = await dbAsync.get('SELECT printer_id FROM printer_master WHERE LOWER(location) = LOWER(?)', [origName]);
      if (existingPm) {
        await dbAsync.run(
          'UPDATE printer_master SET location = ?, branch = ?, printer_model = ?, serial_number = ? WHERE printer_id = ?',
          [cleanLoc, cleanBranch, cleanModel, cleanSerial, existingPm.printer_id]
        );
      } else {
        await dbAsync.run(
          'INSERT INTO printer_master (location, branch, printer_model, serial_number) VALUES (?, ?, ?, ?)',
          [cleanLoc, cleanBranch, cleanModel, cleanSerial]
        );
      }
    } else {
      await dbAsync.run(
        'UPDATE printer_master SET location = ?, branch = ? WHERE LOWER(location) = LOWER(?)',
        [cleanLoc, cleanBranch, origName]
      );
    }

    // 4. Update rental_printers
    if (cleanSerial) {
      const existingRp = await dbAsync.get('SELECT id FROM rental_printers WHERE LOWER(location) = LOWER(?)', [origName]);
      if (existingRp) {
        await dbAsync.run(
          'UPDATE rental_printers SET location = ?, branch = ?, model = ?, serial_number = ? WHERE id = ?',
          [cleanLoc, cleanBranch, cleanModel, cleanSerial, existingRp.id]
        );
      } else {
        await dbAsync.run(
          'INSERT INTO rental_printers (location, branch, model, serial_number) VALUES (?, ?, ?, ?)',
          [cleanLoc, cleanBranch, cleanModel, cleanSerial]
        );
      }
    } else {
      await dbAsync.run(
        'UPDATE rental_printers SET location = ?, branch = ? WHERE LOWER(location) = LOWER(?)',
        [cleanLoc, cleanBranch, origName]
      );
    }

    // 5. Update computers and users references
    await dbAsync.run('UPDATE computers SET location = ? WHERE LOWER(location) = LOWER(?)', [cleanLoc, origName]);
    await dbAsync.run('UPDATE user_master SET location = ? WHERE LOWER(location) = LOWER(?)', [cleanLoc, origName]);

    res.json({
      success: true,
      message: `Location "${origName}" updated to "${cleanLoc}" (${cleanBranch}).`,
      location: cleanLoc,
      branch: cleanBranch
    });
  } catch (error) {
    console.error('[-] Error updating location:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/locations/delete
 * Deletes a Location and its associated printer record
 */
app.post('/api/locations/delete', async (req, res) => {
  const { location } = req.body;
  if (!location || !location.trim()) {
    return res.status(400).json({ error: 'Location name is required.' });
  }

  const cleanLoc = location.trim();
  try {
    // 1. Add to excluded_locations blacklist so it never recreates on server restart
    await dbAsync.run(
      'INSERT OR IGNORE INTO excluded_locations (location_name) VALUES (?)',
      [cleanLoc]
    );

    // 2. Permanently delete from all location and printer tables
    await dbAsync.run('DELETE FROM departments WHERE LOWER(name) = LOWER(?)', [cleanLoc]);
    await dbAsync.run('DELETE FROM department_master WHERE LOWER(department_name) = LOWER(?)', [cleanLoc]);
    await dbAsync.run('DELETE FROM printer_master WHERE LOWER(location) = LOWER(?)', [cleanLoc]);
    await dbAsync.run('DELETE FROM rental_printers WHERE LOWER(location) = LOWER(?)', [cleanLoc]);

    // 3. Clear location on users and computers
    await dbAsync.run('UPDATE user_master SET location = NULL WHERE LOWER(location) = LOWER(?)', [cleanLoc]);
    await dbAsync.run('UPDATE computers SET location = NULL WHERE LOWER(location) = LOWER(?)', [cleanLoc]);

    console.log(`[+] Location permanently deleted and blacklisted: "${cleanLoc}"`);
    res.json({ success: true, message: `Location "${cleanLoc}" deleted permanently.` });
  } catch (error) {
    console.error('[-] Error deleting location:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/users/:uid
 * Updates user account, email, location, MAC address, PC Name, and optional password
 */
app.put('/api/users/:uid', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const { name, email, location, mac_address, pc_name, password } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'User Name is required.' });
    }
    const cleanLocation = (location && location.trim()) || (req.body.department_name && req.body.department_name.trim()) || null;
    if (!cleanLocation) {
      return res.status(400).json({ error: 'Location is required.' });
    }
    let cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
    if (cleanEmail && !cleanEmail.includes('@')) {
      cleanEmail = cleanEmail + '@malibangroup.lk';
    }
    if (cleanEmail && !cleanEmail.endsWith('@malibangroup.lk')) {
      return res.status(400).json({ error: 'Email must belong to the @malibangroup.lk corporate domain.' });
    }
    if (mac_address && !isValidMacAddress(mac_address.trim())) {
      return res.status(400).json({ error: 'Valid physical MAC Address is required (e.g. C8-95-CE-4A-5E-B6).' });
    }

    const cleanName = name.trim();
    const cleanMac = mac_address ? normalizeMacAddress(mac_address.trim()) : null;
    const cleanPc = pc_name ? pc_name.trim().toUpperCase() : null;

    const existing = await dbAsync.get('SELECT * FROM user_master WHERE uid = ?', [uid]);
    if (!existing) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Match department
    let depId = existing.dep_id;
    const dm = await dbAsync.get('SELECT dep_id FROM department_master WHERE LOWER(department_name) = LOWER(?)', [cleanLocation]);
    if (dm) depId = dm.dep_id;

    if (password && password.trim()) {
      if (password.trim().length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
      }
      await dbAsync.run(
        `UPDATE user_master 
         SET name = ?, email = ?, location = ?, mac_address = ?, pc_name = ?, password = ?, dep_id = ?
         WHERE uid = ?`,
        [cleanName, cleanEmail, cleanLocation, cleanMac, cleanPc, password.trim(), depId, uid]
      );
    } else {
      await dbAsync.run(
        `UPDATE user_master 
         SET name = ?, email = ?, location = ?, mac_address = ?, pc_name = ?, dep_id = ?
         WHERE uid = ?`,
        [cleanName, cleanEmail, cleanLocation, cleanMac, cleanPc, depId, uid]
      );
    }

    // Sync to computers table
    if (cleanPc) {
      await dbAsync.run('DELETE FROM excluded_computers WHERE UPPER(pc_name) = ?', [cleanPc]);
      let deptId = null;
      const d = await dbAsync.get('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)', [cleanLocation]);
      if (d) deptId = d.id;

      const existingComp = await dbAsync.get('SELECT id FROM computers WHERE UPPER(pc_name) = ? OR UPPER(mac_address) = ?', [cleanPc, cleanMac]);
      if (!existingComp) {
        if (deptId) {
          await dbAsync.run(
            'INSERT INTO computers (department_id, pc_name, mac_address, location, notes, spooler_status) VALUES (?, ?, ?, ?, ?, "ACTIVE")',
            [deptId, cleanPc, cleanMac, cleanLocation, `User: ${cleanName}`]
          );
        }
      } else {
        await dbAsync.run(
          'UPDATE computers SET pc_name = ?, mac_address = ?, location = ?, department_id = COALESCE(?, department_id) WHERE id = ?',
          [cleanPc, cleanMac, cleanLocation, deptId, existingComp.id]
        );
      }
    }

    res.json({
      success: true,
      message: `User "${cleanName}" updated successfully.`
    });
  } catch (error) {
    console.error('[-] Error updating user:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MASTER DATA CRUD ROUTES (STAR SCHEMA)
// ==========================================

// 1. USER MASTER CRUD
// [UID(pk), Name, Email, Location, mac Address, PC Name, Password]
app.get('/api/masters/users', async (req, res) => {
  try {
    const users = await dbAsync.all(
      `SELECT u.uid, u.name, u.email, u.location, u.mac_address, u.pc_name, u.password, u.role, u.dep_id, d.department_name, u.created_at,
              (SELECT COUNT(*) FROM fact_printer_count f WHERE f.uid = u.uid) as submission_count
       FROM user_master u
       LEFT JOIN department_master d ON u.dep_id = d.dep_id
       ORDER BY u.uid ASC`
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/masters/users', async (req, res) => {
  const { name, email, location, mac_address, pc_name, password, role, dep_id } = req.body;
  if (!name || !name.trim() || !password || !password.trim()) {
    return res.status(400).json({ error: 'Name and Password are required.' });
  }
  try {
    const cleanMac = mac_address && mac_address.trim() ? normalizeMacAddress(mac_address.trim()) : null;
    const cleanPc = pc_name && pc_name.trim() ? pc_name.trim().toUpperCase() : null;
    const cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
    const cleanLocation = location && location.trim() ? location.trim() : null;

    const result = await dbAsync.run(
      `INSERT INTO user_master (name, email, location, mac_address, pc_name, password, role, dep_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), cleanEmail, cleanLocation, cleanMac, cleanPc, password.trim(), role || 'supervisor', dep_id ? parseInt(dep_id, 10) : null]
    );

    // Sync to computers table if pc_name & dep_id provided
    if (cleanPc && dep_id) {
      await dbAsync.run('DELETE FROM excluded_computers WHERE UPPER(pc_name) = ?', [cleanPc]);
      const existingComp = await dbAsync.get('SELECT id FROM computers WHERE UPPER(pc_name) = ?', [cleanPc]);
      if (!existingComp) {
        await dbAsync.run(
          'INSERT INTO computers (department_id, pc_name, mac_address, location, notes) VALUES (?, ?, ?, ?, ?)',
          [parseInt(dep_id, 10), cleanPc, cleanMac, cleanLocation, `User: ${name.trim()}`]
        );
      } else {
        await dbAsync.run(
          'UPDATE computers SET department_id = ?, mac_address = ?, location = ? WHERE id = ?',
          [parseInt(dep_id, 10), cleanMac, cleanLocation, existingComp.id]
        );
      }
    }

    res.status(201).json({ success: true, uid: result.lastID, message: 'User created successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/masters/users/:uid', async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  const { name, email, location, mac_address, pc_name, password, role, dep_id } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  try {
    const cleanMac = mac_address && mac_address.trim() ? normalizeMacAddress(mac_address.trim()) : null;
    const cleanPc = pc_name && pc_name.trim() ? pc_name.trim().toUpperCase() : null;
    const cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
    const cleanLocation = location && location.trim() ? location.trim() : null;
    
    if (password && password.trim()) {
      await dbAsync.run(
        `UPDATE user_master 
         SET name = ?, email = ?, location = ?, mac_address = ?, pc_name = ?, password = ?, role = ?, dep_id = ?
         WHERE uid = ?`,
        [name.trim(), cleanEmail, cleanLocation, cleanMac, cleanPc, password.trim(), role || 'supervisor', dep_id ? parseInt(dep_id, 10) : null, uid]
      );
    } else {
      await dbAsync.run(
        `UPDATE user_master 
         SET name = ?, email = ?, location = ?, mac_address = ?, pc_name = ?, role = ?, dep_id = ?
         WHERE uid = ?`,
        [name.trim(), cleanEmail, cleanLocation, cleanMac, cleanPc, role || 'supervisor', dep_id ? parseInt(dep_id, 10) : null, uid]
      );
    }

    // Sync to computers table if pc_name & dep_id provided
    if (cleanPc && dep_id) {
      await dbAsync.run('DELETE FROM excluded_computers WHERE UPPER(pc_name) = ?', [cleanPc]);
      const existingComp = await dbAsync.get('SELECT id FROM computers WHERE UPPER(pc_name) = ?', [cleanPc]);
      if (!existingComp) {
        await dbAsync.run(
          'INSERT INTO computers (department_id, pc_name, mac_address, location, notes) VALUES (?, ?, ?, ?, ?)',
          [parseInt(dep_id, 10), cleanPc, cleanMac, cleanLocation, `User: ${name.trim()}`]
        );
      } else {
        await dbAsync.run(
          'UPDATE computers SET department_id = ?, mac_address = ?, location = ? WHERE id = ?',
          [parseInt(dep_id, 10), cleanMac, cleanLocation, existingComp.id]
        );
      }
    }

    res.json({ success: true, message: 'User updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/masters/users/:uid', async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  try {
    const user = await dbAsync.get('SELECT * FROM user_master WHERE uid = ?', [uid]);
    if (user && user.pc_name) {
      const cleanPc = user.pc_name.trim().toUpperCase();
      await dbAsync.run('INSERT OR IGNORE INTO excluded_computers (pc_name) VALUES (?)', [cleanPc]);
      await dbAsync.run('DELETE FROM computers WHERE UPPER(pc_name) = ?', [cleanPc]);
    }
    await dbAsync.run('DELETE FROM user_master WHERE uid = ?', [uid]);
    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. DEPARTMENT MASTER CRUD
// [Dep_ID (pk), Department Name]
app.get('/api/masters/departments', async (req, res) => {
  try {
    const depts = await dbAsync.all(
      `SELECT d.dep_id, d.department_name, d.spooler_status, d.last_action_at, d.created_at,
              (SELECT COUNT(*) FROM user_master u WHERE u.dep_id = d.dep_id) as user_count,
              (SELECT COUNT(*) FROM printer_master p WHERE p.dep_id = d.dep_id) as printer_count,
              (SELECT COUNT(*) FROM fact_printer_count f WHERE f.dep_id = d.dep_id) as print_record_count
       FROM department_master d
       ORDER BY d.dep_id ASC`
    );
    res.json(depts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/masters/departments', async (req, res) => {
  const { department_name } = req.body;
  if (!department_name || !department_name.trim()) {
    return res.status(400).json({ error: 'Department name is required.' });
  }
  try {
    const name = department_name.trim();
    const result = await dbAsync.run(
      'INSERT INTO department_master (department_name, spooler_status) VALUES (?, "ACTIVE")',
      [name]
    );
    await dbAsync.run(
      'INSERT OR IGNORE INTO departments (id, name, spooler_status) VALUES (?, ?, "ACTIVE")',
      [result.lastID, name]
    );
    res.status(201).json({ success: true, dep_id: result.lastID, department_name: name });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A department with this name already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/masters/departments/:dep_id', async (req, res) => {
  const dep_id = parseInt(req.params.dep_id, 10);
  const { department_name } = req.body;
  if (!department_name || !department_name.trim()) {
    return res.status(400).json({ error: 'Department name is required.' });
  }
  try {
    const name = department_name.trim();
    await dbAsync.run(
      'UPDATE department_master SET department_name = ? WHERE dep_id = ?',
      [name, dep_id]
    );
    await dbAsync.run(
      'UPDATE departments SET name = ? WHERE id = ?',
      [name, dep_id]
    );
    res.json({ success: true, message: 'Department updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/masters/departments/:dep_id', async (req, res) => {
  const dep_id = parseInt(req.params.dep_id, 10);
  try {
    await dbAsync.run('DELETE FROM department_master WHERE dep_id = ?', [dep_id]);
    await dbAsync.run('DELETE FROM departments WHERE id = ?', [dep_id]);
    res.json({ success: true, message: 'Department deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. PRINTER MASTER CRUD
// [Printer_ID(pk), Printer_Model, Serial_Number, Location]
app.get('/api/masters/printers', async (req, res) => {
  try {
    const printers = await dbAsync.all(
      `SELECT p.printer_id, p.printer_model, p.serial_number, p.location, p.dep_id, d.department_name, p.created_at,
              (SELECT f.print_count FROM fact_printer_count f WHERE f.printer_id = p.printer_id ORDER BY f.count_id DESC LIMIT 1) as latest_count,
              (SELECT COUNT(*) FROM fact_printer_count f WHERE f.printer_id = p.printer_id) as record_count
       FROM printer_master p
       LEFT JOIN department_master d ON p.dep_id = d.dep_id
       ORDER BY p.printer_id ASC`
    );
    res.json(printers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/masters/printers', async (req, res) => {
  const { printer_model, serial_number, location, dep_id } = req.body;
  if (!serial_number || !serial_number.trim()) {
    return res.status(400).json({ error: 'Serial number is required.' });
  }
  try {
    const cleanSerial = serial_number.trim().toUpperCase();
    const result = await dbAsync.run(
      `INSERT INTO printer_master (printer_model, serial_number, location, dep_id)
       VALUES (?, ?, ?, ?)`,
      [printer_model ? printer_model.trim() : 'LaserJet', cleanSerial, location ? location.trim().toUpperCase() : 'Maliban Plant', dep_id ? parseInt(dep_id, 10) : null]
    );
    res.status(201).json({ success: true, printer_id: result.lastID, message: 'Printer added successfully.' });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A printer with this serial number already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/masters/printers/:printer_id', async (req, res) => {
  const printer_id = parseInt(req.params.printer_id, 10);
  const { printer_model, serial_number, location, dep_id } = req.body;
  if (!serial_number || !serial_number.trim()) {
    return res.status(400).json({ error: 'Serial number is required.' });
  }
  try {
    const cleanSerial = serial_number.trim().toUpperCase();
    await dbAsync.run(
      `UPDATE printer_master
       SET printer_model = ?, serial_number = ?, location = ?, dep_id = ?
       WHERE printer_id = ?`,
      [printer_model ? printer_model.trim() : null, cleanSerial, location ? location.trim().toUpperCase() : null, dep_id ? parseInt(dep_id, 10) : null, printer_id]
    );
    res.json({ success: true, message: 'Printer updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/masters/printers/:printer_id', async (req, res) => {
  const printer_id = parseInt(req.params.printer_id, 10);
  try {
    await dbAsync.run('DELETE FROM printer_master WHERE printer_id = ?', [printer_id]);
    res.json({ success: true, message: 'Printer deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. DATE MASTER CRUD
// [Date_ID(pk), Year, Quater, Month, Week, Day]
app.get('/api/masters/dates', async (req, res) => {
  try {
    const { year, month } = req.query;
    let sql = 'SELECT * FROM date_master';
    const params = [];
    if (year) {
      sql += ' WHERE year = ?';
      params.push(parseInt(year, 10));
      if (month) {
        sql += ' AND month = ?';
        params.push(parseInt(month, 10));
      }
    }
    sql += ' ORDER BY full_date DESC LIMIT 150';
    const dates = await dbAsync.all(sql, params);
    res.json(dates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/masters/dates', async (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Date is required (YYYY-MM-DD).' });
  }
  try {
    const dateId = await getOrCreateDateId(date);
    const dateRecord = await dbAsync.get('SELECT * FROM date_master WHERE date_id = ?', [dateId]);
    res.json({ success: true, date: dateRecord });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. FACT TABLE: PRINTER_COUNT CRUD
// [Count_ID(pk), UID(Fk), Dep_ID(Fk), Printer_ID(Fk), Date_ID(Fk), print_count]
app.get('/api/facts/printer-counts', async (req, res) => {
  try {
    const { uid, dep_id, printer_id, year, month, quarter, limit } = req.query;
    let whereClauses = [];
    let params = [];

    if (uid) {
      whereClauses.push('f.uid = ?');
      params.push(parseInt(uid, 10));
    }
    if (dep_id) {
      whereClauses.push('f.dep_id = ?');
      params.push(parseInt(dep_id, 10));
    }
    if (printer_id) {
      whereClauses.push('f.printer_id = ?');
      params.push(parseInt(printer_id, 10));
    }
    if (year) {
      whereClauses.push('dt.year = ?');
      params.push(parseInt(year, 10));
    }
    if (month) {
      whereClauses.push('dt.month = ?');
      params.push(parseInt(month, 10));
    }
    if (quarter) {
      whereClauses.push('dt.quarter = ?');
      params.push(parseInt(quarter, 10));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const limitSql = limit ? `LIMIT ${parseInt(limit, 10)}` : 'LIMIT 250';

    const sql = `
      SELECT f.count_id, f.uid, f.dep_id, f.printer_id, f.date_id, f.print_count, f.screenshot_path, f.notes, f.created_at,
             u.name as user_name, u.pc_name, u.mac_address,
             d.department_name,
             p.printer_model, p.serial_number, p.location,
             dt.full_date, dt.year, dt.quarter, dt.month, dt.week, dt.day
      FROM fact_printer_count f
      LEFT JOIN user_master u ON f.uid = u.uid
      LEFT JOIN department_master d ON f.dep_id = d.dep_id
      LEFT JOIN printer_master p ON f.printer_id = p.printer_id
      LEFT JOIN date_master dt ON f.date_id = dt.date_id
      ${whereSql}
      ORDER BY dt.full_date DESC, f.count_id DESC
      ${limitSql}
    `;

    const records = await dbAsync.all(sql, params);
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/facts/printer-counts', async (req, res) => {
  const { uid, dep_id, printer_id, print_count, date, notes, screenshot_base64 } = req.body;
  if (!dep_id || !printer_id || print_count === undefined || print_count === null) {
    return res.status(400).json({ error: 'Department, Printer, and Print Count are required.' });
  }

  const count = parseInt(print_count, 10);
  if (isNaN(count) || count < 0) {
    return res.status(400).json({ error: 'Print count must be a non-negative number.' });
  }

  try {
    let screenshotPath = null;
    if (screenshot_base64 && typeof screenshot_base64 === 'string' && screenshot_base64.includes(';base64,')) {
      const parts = screenshot_base64.split(';base64,');
      const mime = parts[0].toLowerCase();
      let ext = 'jpg';
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';

      const cleanBase64 = parts[1].replace(/\s/g, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      const MAX_BYTES = 5 * 1024 * 1024;
      if (buffer.length <= MAX_BYTES) {
        const filename = `fact_cnt_${dep_id}_${printer_id}_${Date.now()}.${ext}`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, buffer);
        screenshotPath = `/uploads/${filename}`;
      }
    }

    const targetDate = date ? new Date(date) : new Date();
    const dateId = await getOrCreateDateId(targetDate);
    const resolvedUid = uid ? parseInt(uid, 10) : 1;

    const result = await dbAsync.run(
      `INSERT INTO fact_printer_count (uid, dep_id, printer_id, date_id, print_count, screenshot_path, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [resolvedUid, parseInt(dep_id, 10), parseInt(printer_id, 10), dateId, count, screenshotPath, notes || null]
    );

    unblockDepartmentPrinters(dep_id, 'Fact counter logged').catch(e => console.warn(e.message));

    res.status(201).json({
      success: true,
      count_id: result.lastID,
      message: 'Print count recorded in Fact Table successfully.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/facts/printer-counts/:count_id', async (req, res) => {
  const count_id = parseInt(req.params.count_id, 10);
  const { uid, dep_id, printer_id, print_count, date, notes } = req.body;

  try {
    let dateId = null;
    if (date) {
      dateId = await getOrCreateDateId(new Date(date));
    }

    const updates = [];
    const params = [];

    if (print_count !== undefined) {
      updates.push('print_count = ?');
      params.push(parseInt(print_count, 10));
    }
    if (uid) {
      updates.push('uid = ?');
      params.push(parseInt(uid, 10));
    }
    if (dep_id) {
      updates.push('dep_id = ?');
      params.push(parseInt(dep_id, 10));
    }
    if (printer_id) {
      updates.push('printer_id = ?');
      params.push(parseInt(printer_id, 10));
    }
    if (dateId) {
      updates.push('date_id = ?');
      params.push(dateId);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update provided.' });
    }

    params.push(count_id);
    await dbAsync.run(`UPDATE fact_printer_count SET ${updates.join(', ')} WHERE count_id = ?`, params);

    res.json({ success: true, message: 'Fact table entry updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/facts/printer-counts/:count_id', async (req, res) => {
  const count_id = parseInt(req.params.count_id, 10);
  try {
    await dbAsync.run('DELETE FROM fact_printer_count WHERE count_id = ?', [count_id]);
    res.json({ success: true, message: 'Fact table entry deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// INDIVIDUAL REPORTS & ANALYTICS (STAR SCHEMA)
// ==========================================

/**
 * GET /api/reports/star-schema
 * Generate individual and multidimensional reports from the Star Schema
 */
app.get('/api/reports/star-schema', async (req, res) => {
  try {
    const { groupBy, dep_id, uid, printer_id, year, quarter, month, week } = req.query;

    let whereClauses = [];
    let params = [];

    if (dep_id && dep_id !== 'all') {
      whereClauses.push('f.dep_id = ?');
      params.push(parseInt(dep_id, 10));
    }
    if (uid && uid !== 'all') {
      whereClauses.push('f.uid = ?');
      params.push(parseInt(uid, 10));
    }
    if (printer_id && printer_id !== 'all') {
      whereClauses.push('f.printer_id = ?');
      params.push(parseInt(printer_id, 10));
    }
    if (year && year !== 'all') {
      whereClauses.push('dt.year = ?');
      params.push(parseInt(year, 10));
    }
    if (quarter && quarter !== 'all') {
      whereClauses.push('dt.quarter = ?');
      params.push(parseInt(quarter, 10));
    }
    if (month && month !== 'all') {
      whereClauses.push('dt.month = ?');
      params.push(parseInt(month, 10));
    }
    if (week && week !== 'all') {
      whereClauses.push('dt.week = ?');
      params.push(parseInt(week, 10));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const records = await dbAsync.all(
      `SELECT f.count_id, f.uid, f.dep_id, f.printer_id, f.date_id, f.print_count, f.screenshot_path, f.notes, f.created_at,
              u.name as user_name, u.pc_name, u.mac_address,
              d.department_name,
              p.printer_model, p.serial_number, p.location,
              dt.full_date, dt.year, dt.quarter, dt.month, dt.week, dt.day
       FROM fact_printer_count f
       LEFT JOIN user_master u ON f.uid = u.uid
       LEFT JOIN department_master d ON f.dep_id = d.dep_id
       LEFT JOIN printer_master p ON f.printer_id = p.printer_id
       LEFT JOIN date_master dt ON f.date_id = dt.date_id
       ${whereSql}
       ORDER BY dt.full_date DESC, f.count_id DESC`,
      params
    );

    let totalCount = 0;
    records.forEach(r => { totalCount += (r.print_count || 0); });
    const avgCount = records.length > 0 ? Math.round(totalCount / records.length) : 0;

    let groupColumn = 'd.department_name';
    if (groupBy === 'user') {
      groupColumn = 'u.name';
    } else if (groupBy === 'printer') {
      groupColumn = 'p.printer_model || " (" || p.location || ")"';
    } else if (groupBy === 'month') {
      groupColumn = 'dt.year || "-M" || SUBSTR("0" || dt.month, -2, 2)';
    } else if (groupBy === 'quarter') {
      groupColumn = 'dt.year || "-Q" || dt.quarter';
    } else if (groupBy === 'week') {
      groupColumn = 'dt.year || "-W" || SUBSTR("0" || dt.week, -2, 2)';
    }

    const breakdownSql = `
      SELECT ${groupColumn} as label,
             COUNT(f.count_id) as entry_count,
             SUM(f.print_count) as total_prints,
             AVG(f.print_count) as avg_prints,
             MIN(f.print_count) as min_count,
             MAX(f.print_count) as max_count
      FROM fact_printer_count f
      LEFT JOIN user_master u ON f.uid = u.uid
      LEFT JOIN department_master d ON f.dep_id = d.dep_id
      LEFT JOIN printer_master p ON f.printer_id = p.printer_id
      LEFT JOIN date_master dt ON f.date_id = dt.date_id
      ${whereSql}
      GROUP BY label
      ORDER BY total_prints DESC
    `;

    const breakdown = await dbAsync.all(breakdownSql, params);

    res.json({
      success: true,
      filters: { groupBy, dep_id, uid, printer_id, year, quarter, month, week },
      summary: {
        totalRecords: records.length,
        totalPrintCount: totalCount,
        averagePrintCount: avgCount
      },
      breakdown,
      records
    });
  } catch (error) {
    console.error('[-] Star schema report error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MONTHLY PRINT USAGE REPORT & EMAIL ROUTES
// ==========================================

// 1. Preview / Compile Monthly Report Data
app.get('/api/reports/monthly', async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : undefined;
    const month = req.query.month ? parseInt(req.query.month, 10) : undefined;
    const reportData = await compileMonthlyReport(year, month);
    res.json({ success: true, report: reportData });
  } catch (error) {
    console.error('[-] Failed to compile monthly report:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Download Formatted Excel (.xlsx) Report
app.get('/api/reports/monthly/download', async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : undefined;
    const month = req.query.month ? parseInt(req.query.month, 10) : undefined;
    const { buffer, filename } = await generateAndSaveExcel(year, month);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error('[-] Failed to download monthly report Excel:', error.message);
    res.status(500).send(`Error generating Excel file: ${error.message}`);
  }
});

// 3. Historical Monthly Reports Archive
app.get('/api/reports/monthly/archive', async (req, res) => {
  try {
    const archives = await dbAsync.all(`
      SELECT id, year, month, month_name, prev_month_name, cutoff_date, total_usage,
             total_printers, pending_count, file_path, generated_at
      FROM monthly_reports
      ORDER BY year DESC, month DESC
    `);
    res.json({ success: true, archives });
  } catch (error) {
    console.error('[-] Failed to fetch report archive:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// CRON JOB SCHEDULER
// ==========================================
// 1. Runs every Monday at 2:00 PM (14:00) for weekly compliance audit
cron.schedule(CRON_SCHEDULE, async () => {
  console.log(`\n[CRON TRIGGER] Executing scheduled Monday 2:00 PM print count audit...`);
  try {
    await checkAndBlockNonCompliantDepartments();
  } catch (error) {
    console.error('[-] Cron execution failed:', error.message);
  }
});

// 2. Runs every 1 minute to auto-sync workstations that were offline when blocked/unblocked
cron.schedule(SYNC_CRON_SCHEDULE, async () => {
  console.log(`\n[CRON TRIGGER] Executing 1-minute workstation sync check...`);
  try {
    await syncPendingWorkstations();
  } catch (error) {
    console.error('[-] 1-Minute sync execution failed:', error.message);
  }
});

// 3. Runs on the 25th of every month at 18:00 (Sri Lanka time UTC+05:30) to snapshot Monthly Usage Report
cron.schedule('0 18 25 * *', async () => {
  console.log(`\n[CRON TRIGGER] Executing scheduled 25th 18:00 Monthly Printer Usage Report snapshot...`);
  try {
    const now = new Date();
    await snapshotMonthlyReport(now.getFullYear(), now.getMonth() + 1);
    console.log(`[+] [Cron] 25th Monthly Report snapshot completed.`);
  } catch (error) {
    console.error('[-] 25th Monthly report cron failed:', error.message);
  }
});

// Global error safety guards to prevent server crashes
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================
async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`  MALIBAN IT - PRINT MANAGEMENT & RESTRICTION SYSTEM   `);
      console.log(`=======================================================`);
      console.log(`[+] Server running at: http://localhost:${PORT}`);
      console.log(`[+] Supervisor Portal: http://localhost:${PORT}/`);
      console.log(`[+] IT Admin Portal:   http://localhost:${PORT}/admin`);
      console.log(`[+] Automated Cron:    ${CRON_SCHEDULE} (Monday 2:00 PM)`);
      console.log(`[+] PowerShell Mode:   ${process.env.SIMULATE_POWERSHELL === 'true' ? 'SIMULATION' : 'ACTIVE DOMAIN EXECUTION'}`);
      console.log(`=======================================================\n`);
    });
  } catch (error) {
    console.error('[-] Fatal error starting server:', error);
    process.exit(1);
  }
}

startServer();
