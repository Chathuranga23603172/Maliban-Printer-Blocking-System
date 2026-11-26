const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const dbPath = process.env.DB_PATH || './data/printer_tracking.db';
const dbDir = path.dirname(path.resolve(dbPath));

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(path.resolve(dbPath), (err) => {
  if (err) {
    console.error('[-] Could not connect to SQLite database:', err.message);
  } else {
    console.log(`[+] Connected to SQLite database at: ${path.resolve(dbPath)}`);
  }
});

// Promisified helpers for clean async/await
const dbAsync = {
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },
  exec: (sql) => {
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
};

/**
 * Calculates standard ISO week number
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Gets or creates an entry in date_master for a given Date / string
 * Dimension Table: Date Master [Date_ID (pk), Year, Quater, Month, Week, Day]
 */
async function getOrCreateDateId(dateInput = new Date()) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) {
    throw new Error('Invalid date provided to getOrCreateDateId');
  }
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const quarter = Math.floor(d.getMonth() / 3) + 1;
  const week = getWeekNumber(d);
  const fullDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const existing = await dbAsync.get('SELECT date_id FROM date_master WHERE full_date = ?', [fullDate]);
  if (existing) {
    return existing.date_id;
  }

  const res = await dbAsync.run(
    `INSERT INTO date_master (full_date, year, quarter, month, week, day)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fullDate, year, quarter, month, week, day]
  );
  return res.lastID;
}

/**
 * Initializes database tables and indices
 */
async function initDatabase() {
  await dbAsync.run('PRAGMA foreign_keys = ON;');

  // 1. Departments Table
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      spooler_status TEXT DEFAULT 'ACTIVE', -- 'ACTIVE' or 'BLOCKED'
      last_action_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Computers Table
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS computers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      pc_name TEXT NOT NULL,
      ip_address TEXT,
      mac_address TEXT,
      notes TEXT,
      spooler_status TEXT DEFAULT 'ACTIVE', -- 'ACTIVE', 'BLOCKED', 'PENDING_BLOCK', 'PENDING_UNBLOCK'
      last_sync_at DATETIME,
      last_sync_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
    )
  `);

  // Migrate existing computers table if missing new sync columns
  try {
    const computerColumns = await dbAsync.all("PRAGMA table_info(computers);");
    const columnNames = computerColumns.map(c => c.name);
    if (!columnNames.includes('spooler_status')) {
      await dbAsync.run("ALTER TABLE computers ADD COLUMN spooler_status TEXT DEFAULT 'ACTIVE';");
    }
    if (!columnNames.includes('last_sync_at')) {
      await dbAsync.run("ALTER TABLE computers ADD COLUMN last_sync_at DATETIME;");
    }
    if (!columnNames.includes('last_sync_error')) {
      await dbAsync.run("ALTER TABLE computers ADD COLUMN last_sync_error TEXT;");
    }
    if (!columnNames.includes('mac_address')) {
      await dbAsync.run("ALTER TABLE computers ADD COLUMN mac_address TEXT;");
    }
    if (!columnNames.includes('location')) {
      await dbAsync.run("ALTER TABLE computers ADD COLUMN location TEXT;");
    }
  } catch (migErr) {
    console.warn('[!] Computer table migration notice:', migErr.message);
  }

  // 2b. Excluded / Deleted Computers Blacklist Table
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS excluded_computers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pc_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2c. Excluded / Deleted Locations Blacklist Table
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS excluded_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Submissions Table
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      print_count INTEGER NOT NULL,
      week_start_date TEXT NOT NULL, -- Format: YYYY-MM-DD (Monday of week)
      status TEXT NOT NULL DEFAULT 'Submitted', -- 'Submitted' or 'Pending'
      supervisor_name TEXT,
      notes TEXT,
      screenshot_path TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
      UNIQUE(department_id, week_start_date)
    )
  `);

  // Migrate existing submissions table if missing screenshot_path, pc_name, printer_id, or location
  try {
    const submissionColumns = await dbAsync.all("PRAGMA table_info(submissions);");
    const subColNames = submissionColumns.map(c => c.name);
    if (!subColNames.includes('screenshot_path')) {
      await dbAsync.run("ALTER TABLE submissions ADD COLUMN screenshot_path TEXT;");
    }
    if (!subColNames.includes('pc_name')) {
      await dbAsync.run("ALTER TABLE submissions ADD COLUMN pc_name TEXT;");
    }
    if (!subColNames.includes('printer_id')) {
      await dbAsync.run("ALTER TABLE submissions ADD COLUMN printer_id INTEGER;");
    }
    if (!subColNames.includes('location')) {
      await dbAsync.run("ALTER TABLE submissions ADD COLUMN location TEXT;");
    }
  } catch (subMigErr) {
    console.warn('[!] Submissions table migration notice:', subMigErr.message);
  }

  // 4. Action Logs (Auditing PowerShell execution and Spooler changes)
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER,
      action_type TEXT NOT NULL, -- 'BLOCK', 'UNBLOCK', 'CRON_CHECK', 'MANUAL_OVERRIDE'
      pc_name TEXT,
      command TEXT,
      status TEXT, -- 'SUCCESS', 'FAILED', 'SIMULATED'
      output TEXT,
      error TEXT,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
    )
  `);

  // 5. Rental Printers Table (Printers deployed / leased across Maliban locations)
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS rental_printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      serial_number TEXT NOT NULL UNIQUE,
      model TEXT,
      department_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
    )
  `);

  // 6. Rental Meter Readings Table (Cumulative monthly meter counter readings)
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS rental_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL, -- 1 = Jan, ..., 12 = Dec
      meter_reading INTEGER NOT NULL,
      reading_date DATE,
      notes TEXT,
      screenshot_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (printer_id) REFERENCES rental_printers(id) ON DELETE CASCADE,
      UNIQUE(printer_id, year, month)
    )
  `);

  // =========================================================================
  // STAR SCHEMA DATA WAREHOUSE: DIMENSION TABLES & FACT TABLE
  // =========================================================================

  // 7. Dimension Table: User Master [UID (pk), Name, Email, Location, mac Address, PC Name, Password]
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS user_master (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      location TEXT,
      mac_address TEXT,
      pc_name TEXT,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user', -- 'admin', 'supervisor', 'user'
      dep_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (dep_id) REFERENCES department_master(dep_id) ON DELETE SET NULL
    )
  `);

  // Migrate existing user_master table if missing email or location columns
  try {
    const userColumns = await dbAsync.all("PRAGMA table_info(user_master);");
    const userColNames = userColumns.map(c => c.name);
    if (!userColNames.includes('email')) {
      await dbAsync.run("ALTER TABLE user_master ADD COLUMN email TEXT;");
    }
    if (!userColNames.includes('location')) {
      await dbAsync.run("ALTER TABLE user_master ADD COLUMN location TEXT;");
    }
    if (!userColNames.includes('branch')) {
      await dbAsync.run("ALTER TABLE user_master ADD COLUMN branch TEXT;");
    }
  } catch (uMigErr) {
    console.warn('[!] User master table migration notice:', uMigErr.message);
  }

  // Migrate departments and printers for branch column ('Little Lion 105', 'Little Lion 11')
  try {
    const deptCols = (await dbAsync.all("PRAGMA table_info(departments);")).map(c => c.name);
    if (!deptCols.includes('branch')) {
      await dbAsync.run("ALTER TABLE departments ADD COLUMN branch TEXT;");
    }

    const deptMasterCols = (await dbAsync.all("PRAGMA table_info(department_master);")).map(c => c.name);
    if (!deptMasterCols.includes('branch')) {
      await dbAsync.run("ALTER TABLE department_master ADD COLUMN branch TEXT;");
    }

    const printerMasterCols = (await dbAsync.all("PRAGMA table_info(printer_master);")).map(c => c.name);
    if (!printerMasterCols.includes('branch')) {
      await dbAsync.run("ALTER TABLE printer_master ADD COLUMN branch TEXT;");
    }

    const rentalCols = (await dbAsync.all("PRAGMA table_info(rental_printers);")).map(c => c.name);
    if (!rentalCols.includes('branch')) {
      await dbAsync.run("ALTER TABLE rental_printers ADD COLUMN branch TEXT;");
    }

    // Auto-backfill existing Little Lion 105 and 11 records based on location names
    await dbAsync.run(`
      UPDATE printer_master 
      SET branch = 'Little Lion 105' 
      WHERE (location LIKE '%105%' OR location LIKE '%Little Lion 105%') AND (branch IS NULL OR branch = '')
    `);
    await dbAsync.run(`
      UPDATE printer_master 
      SET branch = 'Little Lion 11' 
      WHERE (location LIKE '%11%' AND location NOT LIKE '%105%') AND (branch IS NULL OR branch = '')
    `);

    await dbAsync.run(`
      UPDATE rental_printers 
      SET branch = 'Little Lion 105' 
      WHERE (location LIKE '%105%' OR location LIKE '%Little Lion 105%') AND (branch IS NULL OR branch = '')
    `);
    await dbAsync.run(`
      UPDATE rental_printers 
      SET branch = 'Little Lion 11' 
      WHERE (location LIKE '%11%' AND location NOT LIKE '%105%') AND (branch IS NULL OR branch = '')
    `);

    // Backfill user_master location from department_master
    await dbAsync.run(`
      UPDATE user_master 
      SET location = (SELECT department_name FROM department_master WHERE department_master.dep_id = user_master.dep_id)
      WHERE (location IS NULL OR location = '') AND dep_id IS NOT NULL
    `);
    await dbAsync.run(`
      UPDATE user_master 
      SET location = (SELECT name FROM departments WHERE departments.id = user_master.dep_id)
      WHERE (location IS NULL OR location = '') AND dep_id IS NOT NULL
    `);
  } catch (bErr) {
    console.warn('[!] Branch migration notice:', bErr.message);
  }

  // 8. Dimension Table: Department Master [Dep_ID (pk), Department Name]
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS department_master (
      dep_id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_name TEXT NOT NULL UNIQUE,
      spooler_status TEXT DEFAULT 'ACTIVE',
      last_action_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 9. Dimension Table: Printer Master [Printer_ID (pk), Printer_Model, Serial_Number]
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS printer_master (
      printer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_model TEXT,
      serial_number TEXT NOT NULL UNIQUE,
      location TEXT,
      dep_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (dep_id) REFERENCES department_master(dep_id) ON DELETE SET NULL
    )
  `);

  // 10. Dimension Table: Date Master [Date_ID (pk), Year, Quater, Month, Week, Day]
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS date_master (
      date_id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_date DATE NOT NULL UNIQUE,
      year INTEGER NOT NULL,
      quarter INTEGER NOT NULL,
      month INTEGER NOT NULL,
      week INTEGER NOT NULL,
      day INTEGER NOT NULL
    )
  `);

  // 11. Fact Table: Printer_Count [Count_ID (pk), UID (Fk), Dep_ID (Fk), Printer_ID (Fk), Date_ID (Fk)]
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS fact_printer_count (
      count_id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid INTEGER NOT NULL,
      dep_id INTEGER NOT NULL,
      printer_id INTEGER NOT NULL,
      date_id INTEGER NOT NULL,
      print_count INTEGER NOT NULL,
      screenshot_path TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uid) REFERENCES user_master(uid) ON DELETE CASCADE,
      FOREIGN KEY (dep_id) REFERENCES department_master(dep_id) ON DELETE CASCADE,
      FOREIGN KEY (printer_id) REFERENCES printer_master(printer_id) ON DELETE CASCADE,
      FOREIGN KEY (date_id) REFERENCES date_master(date_id) ON DELETE CASCADE
    )
  `);

  // Synchronize Dimension Tables from Existing Data
  try {
    // Sync departments into department_master
    const existingDepts = await dbAsync.all('SELECT * FROM departments');
    for (const d of existingDepts) {
      await dbAsync.run(
        `INSERT INTO department_master (dep_id, department_name, spooler_status, last_action_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dep_id) DO UPDATE SET department_name = excluded.department_name, spooler_status = excluded.spooler_status`,
        [d.id, d.name, d.spooler_status || 'ACTIVE', d.last_action_at]
      );
    }

    // Startup cleanup: Ensure blacklisted/excluded computers are removed from computers table
    await dbAsync.run('DELETE FROM computers WHERE UPPER(pc_name) IN (SELECT UPPER(pc_name) FROM excluded_computers)');

    // Startup cleanup: Ensure blacklisted/excluded locations are purged from all tables
    await dbAsync.run('DELETE FROM printer_master WHERE LOWER(location) IN (SELECT LOWER(location_name) FROM excluded_locations)');
    await dbAsync.run('DELETE FROM rental_printers WHERE LOWER(location) IN (SELECT LOWER(location_name) FROM excluded_locations)');
    await dbAsync.run('DELETE FROM departments WHERE LOWER(name) IN (SELECT LOWER(location_name) FROM excluded_locations)');
    await dbAsync.run('DELETE FROM department_master WHERE LOWER(department_name) IN (SELECT LOWER(location_name) FROM excluded_locations)');

    // Ensure date_master has current year calendar days
    const currentYear = new Date().getFullYear();
    const startDate = new Date(currentYear, 0, 1);
    for (let dayOffset = 0; dayOffset <= 365; dayOffset++) {
      const curD = new Date(startDate);
      curD.setDate(startDate.getDate() + dayOffset);
      await getOrCreateDateId(curD);
    }
  } catch (syncErr) {
    console.warn('[!] Star schema sync notice:', syncErr.message);
  }

  // Create clean monthly printer readings table (for real month-by-month readings)
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS printer_monthly_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (printer_id) REFERENCES printer_master(printer_id) ON DELETE CASCADE,
      UNIQUE(printer_id, year, month)
    )
  `);

  // 12. Monthly Report Settings (Recipients, auto-schedule toggle)
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS report_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email_to TEXT NOT NULL DEFAULT 'itadmin@malibangroup.lk',
      email_cc TEXT DEFAULT '',
      auto_email_enabled INTEGER NOT NULL DEFAULT 1,
      schedule_day INTEGER NOT NULL DEFAULT 25,
      schedule_hour INTEGER NOT NULL DEFAULT 18,
      schedule_minute INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbAsync.run(`
    INSERT OR IGNORE INTO report_settings (id, email_to, email_cc, auto_email_enabled, schedule_day, schedule_hour, schedule_minute)
    VALUES (1, 'itadmin@malibangroup.lk', '', 1, 25, 18, 0)
  `);

  // 13. Monthly Report Historical Snapshots
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS monthly_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      month_name TEXT NOT NULL,
      prev_month_name TEXT NOT NULL,
      cutoff_date TEXT NOT NULL,
      total_usage INTEGER NOT NULL DEFAULT 0,
      total_printers INTEGER NOT NULL DEFAULT 0,
      pending_count INTEGER NOT NULL DEFAULT 0,
      report_json TEXT NOT NULL,
      file_path TEXT,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(year, month)
    )
  `);

  // 14. Email Delivery Audit Logs
  await dbAsync.run(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_month TEXT NOT NULL,
      recipients_to TEXT NOT NULL,
      recipients_cc TEXT,
      subject TEXT NOT NULL,
      status TEXT NOT NULL, -- 'SENT', 'FAILED', 'SIMULATED'
      error_message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[+] Database tables initialized successfully.');
}

/**
 * Returns Monday's date in YYYY-MM-DD for the specified date (default: today)
 */
function getWeekStartDate(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  
  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const dateNum = String(monday.getDate()).padStart(2, '0');
  return `${year}-${month}-${dateNum}`;
}

/**
 * Returns Monday's deadline timestamp (2:00 PM) for the current week
 */
function getCurrentWeekDeadline(weekStartDate = getWeekStartDate()) {
  const monday = new Date(weekStartDate + 'T14:00:00');
  return monday;
}

module.exports = {
  db,
  dbAsync,
  initDatabase,
  getWeekStartDate,
  getCurrentWeekDeadline,
  getOrCreateDateId,
  getWeekNumber
};
