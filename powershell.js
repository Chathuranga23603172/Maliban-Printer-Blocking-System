const { execFile } = require('child_process');
const net = require('net');
const { dbAsync, getWeekStartDate } = require('./database');
require('dotenv').config();

const isSimulate = () => process.env.SIMULATE_POWERSHELL === 'true';
const getTimeout = () => parseInt(process.env.POWERSHELL_TIMEOUT_MS, 10) || 15000;

// Hostname / IP address validation regex to prevent injection
const VALID_HOSTNAME_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

/**
 * Normalizes a MAC address into standard uppercase format (XX-XX-XX-XX-XX-XX)
 */
function normalizeMacAddress(mac) {
  if (!mac || typeof mac !== 'string') return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join('-');
}

/**
 * Validates if a string is a valid MAC address (12 hex digits)
 */
function isValidMacAddress(mac) {
  return normalizeMacAddress(mac) !== null;
}

let arpCache = null;
let arpCacheTime = 0;

function getArpTable() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (arpCache && (now - arpCacheTime < 3000)) {
      return resolve(arpCache);
    }
    execFile('arp', ['-a'], { timeout: 1500 }, (err, stdout) => {
      if (!err && stdout) {
        arpCache = stdout;
        arpCacheTime = Date.now();
        return resolve(stdout);
      }
      resolve('');
    });
  });
}

/**
 * Resolves a workstation's dynamic IP address from its physical MAC address
 * using local ARP cache
 */
async function resolveIpByMac(macAddress) {
  const normalized = normalizeMacAddress(macAddress);
  if (!normalized) return null;

  const cleanHex = normalized.replace(/[^0-9A-F]/g, '').toLowerCase();
  const stdout = await getArpTable();
  if (stdout) {
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F\-:]{11,17})/);
      if (match) {
        const ip = match[1];
        const lineMac = match[2].replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        if (lineMac === cleanHex && !ip.startsWith('255.') && !ip.startsWith('224.')) {
          return ip;
        }
      }
    }
  }
  return null;
}

/**
 * Low-level TCP port probe for WinRM (Port 5985).
 * Tests if WinRM is actively listening so PowerShell remoting commands will succeed.
 * Does NOT rely on ICMP ping to avoid misidentifying stale DHCP IP addresses.
 */
function probeHost(target, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let completed = false;
    socket.setTimeout(timeout);

    const finish = (online, winrmOpen, reason) => {
      if (!completed) {
        completed = true;
        socket.destroy();
        resolve({ online, winrmOpen, reason });
      }
    };

    socket.on('connect', () => {
      finish(true, true, 'WinRM Port 5985 Open');
    });

    socket.on('timeout', () => {
      finish(false, false, 'Workstation powered off or offline (Port 5985 connection timed out)');
    });

    socket.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        finish(true, false, 'Host online, but WinRM Port 5985 connection refused');
      } else if (err.code === 'ENOTFOUND') {
        finish(false, false, 'Hostname not resolved - PC offline or unregistered');
      } else {
        finish(false, false, `Workstation offline (${err.code || err.message})`);
      }
    });

    try {
      socket.connect(5985, target);
    } catch (e) {
      finish(false, false, e.message);
    }
  });
}

/**
 * Fast reachability check for a workstation.
 * Supports tracking strictly by Computer Name and physical MAC Address (No IP caching).
 * target can be a string (host/MAC) or object { pc_name, mac_address }.
 */
async function checkWorkstationOnline(target, timeout = 1200) {
  let host = '';
  let mac = '';

  if (typeof target === 'object' && target !== null) {
    // ALWAYS prioritize Computer Name (No IP caching)
    host = (target.pc_name || '').trim();
    mac = (target.mac_address || '').trim();
  } else if (typeof target === 'string') {
    const trimmed = target.trim();
    if (isValidMacAddress(trimmed)) {
      mac = trimmed;
    } else {
      host = trimmed;
    }
  }

  if (!host && !mac) {
    return { online: false, winrmOpen: false, reason: 'Empty host and MAC address' };
  }

  // 1. If physical MAC address is provided, resolve live dynamic IP via ARP table
  if (mac) {
    const resolvedIp = await resolveIpByMac(mac);
    if (resolvedIp) {
      const macCheck = await probeHost(resolvedIp, timeout);
      if (macCheck.online && macCheck.winrmOpen) {
        return {
          online: true,
          winrmOpen: true,
          reason: `Workstation online via MAC (${normalizeMacAddress(mac)} -> IP: ${resolvedIp}): ${macCheck.reason}`,
          resolvedIp,
          mac: normalizeMacAddress(mac)
        };
      }
    }
  }

  // 2. If Computer Name is provided (or if PC has NO MAC address), probe Computer Name directly
  if (host) {
    const primaryCheck = await probeHost(host, timeout);
    if (primaryCheck.online) {
      return {
        online: true,
        winrmOpen: primaryCheck.winrmOpen,
        reason: primaryCheck.reason,
        host
      };
    }
  }

  return { online: false, winrmOpen: false, reason: 'Workstation powered off or offline (checked via Computer Name & MAC Address)' };
}

/**
 * Executes a PowerShell scriptblock on a remote computer using Invoke-Command
 * @param {string} pcName - Remote PC hostname or IP
 * @param {string} scriptBlock - PowerShell commands inside scriptblock
 * @param {number} departmentId - Associated department ID
 * @param {string} actionType - 'BLOCK' or 'UNBLOCK'
 */
async function runRemotePowerShell(pcName, scriptBlock, departmentId, actionType) {
  const trimmedPC = (pcName || '').trim();

  if (!VALID_HOSTNAME_REGEX.test(trimmedPC)) {
    const errMessage = `Invalid computer name or IP format: "${pcName}"`;
    console.error(`[-] [${actionType}] ${errMessage}`);
    await logAction(departmentId, actionType, pcName, '', 'FAILED', '', errMessage);
    return { success: false, pcName, error: errMessage };
  }

  let command;
  const psUser = process.env.POWERSHELL_USER;
  const psPass = process.env.POWERSHELL_PASSWORD;

  if (psUser && psPass) {
    const sanitizedUser = psUser.replace(/'/g, "''");
    const sanitizedPass = psPass.replace(/'/g, "''");
    command = `$pass = ConvertTo-SecureString '${sanitizedPass}' -AsPlainText -Force; $cred = New-Object System.Management.Automation.PSCredential ('${sanitizedUser}', $pass); Invoke-Command -ComputerName "${trimmedPC}" -Credential $cred -ScriptBlock { ${scriptBlock} }`;
  } else {
    command = `Invoke-Command -ComputerName "${trimmedPC}" -ScriptBlock { ${scriptBlock} }`;
  }

  if (isSimulate()) {
    console.log(`[SIMULATE] [${actionType}] Would execute on ${trimmedPC}:\n  ${command}`);
    await logAction(departmentId, actionType, trimmedPC, command, 'SIMULATED', 'Simulation mode active - command logged.', null);
    return {
      success: true,
      pcName: trimmedPC,
      simulated: true,
      output: 'Simulated successfully (SIMULATE_POWERSHELL=true)'
    };
  }

  // Pre-flight check: Is workstation online and ready for WinRM?
  const reachability = await checkWorkstationOnline(trimmedPC);
  if (!reachability.online || !reachability.winrmOpen) {
    const offlineMsg = !reachability.online
      ? `Workstation is offline or powered off (${reachability.reason})`
      : `Workstation is reachable on network but WinRM (Port 5985) is not open (${reachability.reason})`;
    console.log(`[-] [${actionType}] ${trimmedPC} cannot execute PowerShell: ${offlineMsg}`);
    await logAction(departmentId, actionType, trimmedPC, command, 'OFFLINE', '', offlineMsg);
    return {
      success: false,
      pcName: trimmedPC,
      offline: true,
      error: offlineMsg
    };
  }

  return new Promise((resolve) => {
    // PowerShell execution arguments for robust non-interactive execution
    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      command
    ];

    console.log(`[*] [${actionType}] Executing on ${trimmedPC}...`);

    execFile('powershell.exe', psArgs, { timeout: getTimeout() }, async (error, stdout, stderr) => {
      const outText = stdout ? stdout.trim() : '';
      const errText = stderr ? stderr.trim() : (error ? error.message : '');

      if (error || errText) {
        console.error(`[-] [${actionType}] Failed on ${trimmedPC}:`, errText || error.message);
        await logAction(departmentId, actionType, trimmedPC, command, 'FAILED', outText, errText);
        return resolve({
          success: false,
          pcName: trimmedPC,
          output: outText,
          error: errText
        });
      }

      console.log(`[+] [${actionType}] Success on ${trimmedPC}`);
      await logAction(departmentId, actionType, trimmedPC, command, 'SUCCESS', outText || 'Service status changed successfully', null);
      return resolve({
        success: true,
        pcName: trimmedPC,
        output: outText || 'Success'
      });
    });
  });
}

/**
 * Record action to action_logs table
 */
async function logAction(departmentId, actionType, pcName, command, status, output, error) {
  try {
    await dbAsync.run(
      `INSERT INTO action_logs (department_id, action_type, pc_name, command, status, output, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [departmentId, actionType, pcName, command, status, output, error]
    );
  } catch (err) {
    console.error('[-] Failed to write to action_logs:', err.message);
  }
}

/**
 * Blocks the Print Spooler on a single PC
 */
async function blockSinglePC(pcName, departmentId) {
  const scriptBlock = 'Stop-Service -Name Spooler -Force; Set-Service -Name Spooler -StartupType Disabled';
  return runRemotePowerShell(pcName, scriptBlock, departmentId, 'BLOCK');
}

/**
 * Unblocks the Print Spooler on a single PC
 */
async function unblockSinglePC(pcName, departmentId) {
  const scriptBlock = 'Set-Service -Name Spooler -StartupType Automatic; Start-Service -Name Spooler';
  return runRemotePowerShell(pcName, scriptBlock, departmentId, 'UNBLOCK');
}

/**
 * Queries the remote computer for the actual Windows Print Spooler service state
 * Accepts pcTarget as string or object { pc_name, mac_address }
 * Returns { online: boolean, isRunning: boolean, status: 'Running'|'Stopped'|'Offline'|'Unknown', startType: string }
 */
async function getLiveSpoolerStatus(pcTarget, departmentId) {
  let trimmedPC = '';
  let targetObj = null;

  if (typeof pcTarget === 'object' && pcTarget !== null) {
    trimmedPC = (pcTarget.pc_name || '').trim();
    targetObj = pcTarget;
  } else {
    trimmedPC = (pcTarget || '').trim();
    targetObj = { pc_name: trimmedPC };
  }

  if (!trimmedPC) return { online: false, isRunning: false, status: 'Offline', startType: 'Unknown' };

  // Fast pre-flight check: Is workstation online?
  const reachability = await checkWorkstationOnline(targetObj);
  if (!reachability.online) {
    return {
      online: false,
      isRunning: false,
      status: 'Offline',
      startType: 'Unknown',
      reason: reachability.reason
    };
  }
  if (!reachability.winrmOpen) {
    return {
      online: true,
      isRunning: false,
      status: 'WinRM Closed',
      startType: 'Unknown',
      reason: reachability.reason
    };
  }

  // Workstation is online: Query actual Windows service state
  // If MAC resolved a live dynamic IP, use that IP to execute; otherwise use Computer Name
  const execTarget = reachability.resolvedIp || trimmedPC;
  const scriptBlock = '$s = Get-Service -Name Spooler -ErrorAction SilentlyContinue; if ($s) { "$($s.Status)|$($s.StartType)" } else { "NotFound|Unknown" }';
  const res = await runRemotePowerShell(execTarget, scriptBlock, departmentId, 'QUERY');
  if (res.success && res.output) {
    const parts = res.output.trim().split('|');
    const status = (parts[0] || 'Unknown').trim();
    const startType = (parts[1] || 'Unknown').trim();
    const isRunning = status.toLowerCase() === 'running';

    return {
      online: true,
      isRunning,
      status, // 'Running', 'Stopped', etc.
      startType, // 'Automatic', 'Disabled', 'Manual'
      raw: res.output.trim()
    };
  }

  return {
    online: true,
    isRunning: false,
    status: 'Unknown',
    startType: 'Unknown',
    error: res.error || 'Failed to query service'
  };
}

/**
 * Block Print Spooler on all computers belonging to a department
 */
async function blockDepartmentPrinters(departmentId, reason = 'Automated Deadline Enforcement') {
  const dept = await dbAsync.get('SELECT * FROM departments WHERE id = ?', [departmentId]);
  if (!dept) {
    throw new Error(`Department with ID ${departmentId} not found.`);
  }

  const computers = await dbAsync.all('SELECT * FROM computers WHERE department_id = ?', [departmentId]);

  console.log(`[!] Initiating BLOCK on Department "${dept.name}" (${computers.length} PCs). Reason: ${reason}`);

  // Set department status in database (both departments and department_master)
  await dbAsync.run(
    'UPDATE departments SET spooler_status = "BLOCKED", last_action_at = CURRENT_TIMESTAMP WHERE id = ?',
    [departmentId]
  );
  await dbAsync.run(
    'UPDATE department_master SET spooler_status = "BLOCKED", last_action_at = CURRENT_TIMESTAMP WHERE dep_id = ? OR LOWER(department_name) = LOWER(?)',
    [departmentId, dept.name]
  );

  const results = await Promise.all(computers.map(async (pc) => {
    let target = pc.pc_name;
    let dynamicIp = null;
    if (pc.mac_address) {
      dynamicIp = await resolveIpByMac(pc.mac_address);
    }
    const execTarget = dynamicIp || target;
    let res = await blockSinglePC(execTarget, departmentId);

    if (!res.success && dynamicIp && dynamicIp !== target) {
      console.log(`[*] Retrying BLOCK on Computer Name ${target}...`);
      res = await blockSinglePC(target, departmentId);
    }

    if (res.success) {
      await dbAsync.run(
        'UPDATE computers SET spooler_status = "BLOCKED", last_sync_at = CURRENT_TIMESTAMP, last_sync_error = NULL WHERE id = ?',
        [pc.id]
      );
    } else {
      await dbAsync.run(
        'UPDATE computers SET spooler_status = "PENDING_BLOCK", last_sync_at = CURRENT_TIMESTAMP, last_sync_error = ? WHERE id = ?',
        [res.error || 'Workstation offline or unreachable', pc.id]
      );
    }
    return res;
  }));

  const offlinePCs = results.filter(r => !r.success || r.offline).map(r => r.pcName);
  const onlinePCs = results.filter(r => r.success && !r.offline).map(r => r.pcName);

  return {
    department: dept.name,
    departmentId,
    action: 'BLOCK',
    totalPCs: computers.length,
    success: true,
    hasOffline: offlinePCs.length > 0,
    allOffline: offlinePCs.length > 0 && onlinePCs.length === 0,
    offlinePCs,
    onlinePCs,
    results
  };
}

/**
 * Unblock Print Spooler on all computers belonging to a department
 */
async function unblockDepartmentPrinters(departmentId, reason = 'Supervisor Submitted Count') {
  const dept = await dbAsync.get('SELECT * FROM departments WHERE id = ?', [departmentId]);
  if (!dept) {
    throw new Error(`Department with ID ${departmentId} not found.`);
  }

  const computers = await dbAsync.all('SELECT * FROM computers WHERE department_id = ?', [departmentId]);

  console.log(`[+] Initiating UNBLOCK on Department "${dept.name}" (${computers.length} PCs). Reason: ${reason}`);

  // Set department status in database (both departments and department_master)
  await dbAsync.run(
    'UPDATE departments SET spooler_status = "ACTIVE", last_action_at = CURRENT_TIMESTAMP WHERE id = ?',
    [departmentId]
  );
  await dbAsync.run(
    'UPDATE department_master SET spooler_status = "ACTIVE", last_action_at = CURRENT_TIMESTAMP WHERE dep_id = ? OR LOWER(department_name) = LOWER(?)',
    [departmentId, dept.name]
  );

  const results = await Promise.all(computers.map(async (pc) => {
    let target = pc.pc_name;
    let dynamicIp = null;
    if (pc.mac_address) {
      dynamicIp = await resolveIpByMac(pc.mac_address);
    }
    const execTarget = dynamicIp || target;
    let res = await unblockSinglePC(execTarget, departmentId);

    if (!res.success && dynamicIp && dynamicIp !== target) {
      console.log(`[*] Retrying UNBLOCK on Computer Name ${target}...`);
      res = await unblockSinglePC(target, departmentId);
    }

    if (res.success) {
      await dbAsync.run(
        'UPDATE computers SET spooler_status = "ACTIVE", last_sync_at = CURRENT_TIMESTAMP, last_sync_error = NULL WHERE id = ?',
        [pc.id]
      );
    } else {
      await dbAsync.run(
        'UPDATE computers SET spooler_status = "PENDING_UNBLOCK", last_sync_at = CURRENT_TIMESTAMP, last_sync_error = ? WHERE id = ?',
        [res.error || 'Workstation offline or unreachable', pc.id]
      );
    }
    return res;
  }));

  const offlinePCs = results.filter(r => !r.success || r.offline).map(r => r.pcName);
  const onlinePCs = results.filter(r => r.success && !r.offline).map(r => r.pcName);

  return {
    department: dept.name,
    departmentId,
    action: 'UNBLOCK',
    totalPCs: computers.length,
    success: true,
    hasOffline: offlinePCs.length > 0,
    allOffline: offlinePCs.length > 0 && onlinePCs.length === 0,
    offlinePCs,
    onlinePCs,
    results
  };
}

/**
 * The Core Monday 2:00 PM Check:
 * Identifies all departments that have NOT submitted for current week and blocks their printers.
 */
async function checkAndBlockNonCompliantDepartments() {
  const currentWeekStart = getWeekStartDate();
  console.log(`\n============================================================`);
  console.log(`[CRON / DEADLINE CHECK] Running weekly compliance check for week: ${currentWeekStart}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`============================================================`);

  // Query departments that do NOT have a submission for this week
  const nonCompliantDepartments = await dbAsync.all(`
    SELECT d.id, d.name, d.spooler_status
    FROM departments d
    WHERE d.id NOT IN (
      SELECT s.department_id 
      FROM submissions s 
      WHERE s.week_start_date = ? AND s.status = 'Submitted'
    )
  `, [currentWeekStart]);

  if (nonCompliantDepartments.length === 0) {
    console.log('[+] All departments have submitted their print counts for this week. No action needed.');
    return {
      week: currentWeekStart,
      nonCompliantCount: 0,
      blockedDepartments: []
    };
  }

  console.log(`[!] Found ${nonCompliantDepartments.length} department(s) with PENDING submissions. Initiating blocking...`);

  const blockReports = [];
  for (const dept of nonCompliantDepartments) {
    try {
      const report = await blockDepartmentPrinters(dept.id, 'Monday 2:00 PM Deadline Missed');
      blockReports.push(report);
    } catch (err) {
      console.error(`[-] Error blocking department "${dept.name}":`, err.message);
      blockReports.push({
        department: dept.name,
        departmentId: dept.id,
        error: err.message
      });
    }
  }

  console.log(`[+] Finished automated blocking routine for ${blockReports.length} departments.`);
  return {
    week: currentWeekStart,
    nonCompliantCount: nonCompliantDepartments.length,
    blockedDepartments: blockReports
  };
}

/**
 * Automatically checks and executes pending BLOCK or UNBLOCK commands on workstations
 * that were offline or powered off when the department status changed.
 * Runs on a 1-minute cron interval or on demand.
 */
async function syncPendingWorkstations() {
  console.log(`\n============================================================`);
  console.log(`[1-MINUTE SYNC CHECK] Checking for powered-on workstations with pending commands...`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`============================================================`);

  // Query all computers whose status does not match their parent department's desired status
  const pendingComputers = await dbAsync.all(`
    SELECT c.*, d.name as department_name, d.spooler_status as desired_status
    FROM computers c
    JOIN departments d ON c.department_id = d.id
    WHERE (d.spooler_status = 'BLOCKED' AND (c.spooler_status != 'BLOCKED' OR c.spooler_status IS NULL))
       OR (d.spooler_status = 'ACTIVE' AND (c.spooler_status != 'ACTIVE' OR c.spooler_status IS NULL))
  `);

  if (pendingComputers.length === 0) {
    console.log('[+] All registered workstations are fully synced with their department spooler status.');
    return { syncedCount: 0, totalPending: 0, results: [] };
  }

  console.log(`[!] Found ${pendingComputers.length} workstation(s) requiring spooler status sync.`);

  const syncResults = [];
  for (const pc of pendingComputers) {
    const isBlock = pc.desired_status === 'BLOCKED';
    const actionType = isBlock ? 'BLOCK' : 'UNBLOCK';
    let target = pc.pc_name;

    console.log(`[*] [SYNC] Checking if ${pc.pc_name} (${pc.department_name}) is powered on for ${actionType}...`);

    let dynamicIp = null;
    if (pc.mac_address) {
      dynamicIp = await resolveIpByMac(pc.mac_address);
    }
    const execTarget = dynamicIp || target;
    let res = isBlock 
      ? await blockSinglePC(execTarget, pc.department_id) 
      : await unblockSinglePC(execTarget, pc.department_id);

    if (!res.success && dynamicIp && dynamicIp !== target) {
      console.log(`[*] [SYNC] Retrying ${actionType} on Computer Name ${target}...`);
      res = isBlock 
        ? await blockSinglePC(target, pc.department_id) 
        : await unblockSinglePC(target, pc.department_id);
    }

    if (res.success) {
      const finalStatus = isBlock ? 'BLOCKED' : 'ACTIVE';
      await dbAsync.run(
        `UPDATE computers 
         SET spooler_status = ?, last_sync_at = CURRENT_TIMESTAMP, last_sync_error = NULL 
         WHERE id = ?`,
        [finalStatus, pc.id]
      );
      console.log(`[+] [SYNC SUCCESS] ${pc.pc_name} is online and has been ${finalStatus}!`);
      syncResults.push({ pcName: pc.pc_name, status: finalStatus, success: true });
    } else {
      const pendingStatus = isBlock ? 'PENDING_BLOCK' : 'PENDING_UNBLOCK';
      await dbAsync.run(
        `UPDATE computers 
         SET spooler_status = ?, last_sync_at = CURRENT_TIMESTAMP, last_sync_error = ? 
         WHERE id = ?`,
        [pendingStatus, res.error || 'Workstation offline or unreachable', pc.id]
      );
      console.log(`[-] [SYNC PENDING] ${pc.pc_name} is still offline or unreachable. Will check again in 10 minutes.`);
      syncResults.push({ pcName: pc.pc_name, status: pendingStatus, success: false, error: res.error });
    }
  }

  const successCount = syncResults.filter(r => r.success).length;
  console.log(`[+] Sync cycle completed: ${successCount} workstation(s) updated, ${syncResults.length - successCount} still offline.`);

  // 2. Anti-Tamper Check: For departments that are BLOCKED, verify that no online workstation was manually enabled via services.msc!
  try {
    const blockedDeptsPCs = await dbAsync.all(`
      SELECT c.*, d.name as department_name 
      FROM computers c 
      JOIN departments d ON c.department_id = d.id 
      WHERE d.spooler_status = 'BLOCKED'
    `);

    for (const pc of blockedDeptsPCs) {
      const live = await getLiveSpoolerStatus(pc.pc_name, pc.department_id);
      if (live.online && live.isRunning) {
        console.log(`[!] [TAMPER DETECTED] Workstation ${pc.pc_name} (${pc.department_name}) was manually enabled via services.msc while department is BLOCKED!`);
        console.log(`[*] [AUTO-ENFORCE] Re-stopping and disabling Print Spooler on ${pc.pc_name}...`);
        
        const reblock = await blockSinglePC(pc.pc_name, pc.department_id);
        if (reblock.success) {
          console.log(`[+] [AUTO-ENFORCE] Successfully re-blocked Print Spooler on ${pc.pc_name}.`);
          await logAction(
            pc.department_id,
            'TAMPER_REBLOCK',
            pc.pc_name,
            'Stop-Service -Name Spooler -Force; Set-Service -Name Spooler -StartupType Disabled',
            'SUCCESS',
            'Auto-enforced block after manual override detected via services.msc',
            null
          );
          await dbAsync.run(
            `UPDATE computers SET spooler_status = 'BLOCKED', last_sync_at = CURRENT_TIMESTAMP, last_sync_error = 'Auto-reblocked after manual override in services.msc' WHERE id = ?`,
            [pc.id]
          );
        }
      }
    }
  } catch (tamperErr) {
    console.warn('[-] Anti-tamper check notice:', tamperErr.message);
  }

  return {
    syncedCount: successCount,
    totalPending: pendingComputers.length,
    results: syncResults
  };
}

module.exports = {
  runRemotePowerShell,
  checkWorkstationOnline,
  getLiveSpoolerStatus,
  blockDepartmentPrinters,
  unblockDepartmentPrinters,
  checkAndBlockNonCompliantDepartments,
  syncPendingWorkstations,
  blockSinglePC,
  unblockSinglePC,
  normalizeMacAddress,
  isValidMacAddress,
  resolveIpByMac
};
