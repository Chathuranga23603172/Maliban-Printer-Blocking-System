# Maliban IT - Weekly Printer Count Tracking & Automated Spooler Restriction System

An enterprise-grade internal web application built for the IT Department to track weekly physical printer print counts from department supervisors and automatically enforce printer restrictions across Windows Domain workstations via PowerShell WinRM if a department fails to submit by Friday 5:00 PM.

---

## 🏗️ Architecture & Tech Stack

| Layer | Technology | Details |
|---|---|---|
| **Backend** | **Node.js + Express.js** | RESTful API, static file serving, and orchestration |
| **Database** | **SQLite3** | Embedded relational database with foreign keys & cascading |
| **Frontend** | **HTML5, CSS (Bootstrap 5), Vanilla JS** | Dual views: Supervisor Submission Portal & IT Admin Control Center |
| **Automation** | **node-cron** & `child_process` | Scheduled Friday 5:00 PM audit + remote `Invoke-Command` execution |
| **Environment** | **Windows Active Directory Domain** | Executes remote PowerShell commands over WinRM |

---

## 📁 Project Structure

```
printer-blocking-system/
│
├── data/
│   └── printer_tracking.db         # Auto-generated SQLite database
├── public/
│   ├── css/
│   │   └── style.css               # Modern enterprise styles & status indicators
│   ├── js/
│   │   ├── supervisor.js           # Supervisor portal logic & auto-unblock feedback
│   │   └── admin.js                # IT Admin dashboard, manual control & log viewer
│   ├── index.html                  # Supervisor submission form
│   └── admin.html                  # IT Admin command & control dashboard
│
├── .env.example                    # Sample environment variables
├── .env                            # Active environment configuration
├── database.js                     # SQLite database schema, connection & query helpers
├── powershell.js                   # PowerShell automation logic & sanitized execution
├── server.js                       # Express web server & node-cron scheduler
├── seed.js                         # Database seeder with sample departments & PCs
├── test_server.js                  # Automated unit and simulation test suite
└── package.json                    # Dependencies and npm scripts
```

---

## 🗄️ Database Schema

### 1. `departments`
- `id` (INTEGER, Primary Key, Auto-increment)
- `name` (TEXT, Unique, Required) - e.g. "Finance & Accounts", "Supply Chain"
- `spooler_status` (TEXT) - `'ACTIVE'` or `'BLOCKED'`
- `last_action_at` (DATETIME) - Timestamp of last remote execution
- `created_at` (DATETIME)

### 2. `computers`
- `id` (INTEGER, Primary Key, Auto-increment)
- `department_id` (INTEGER, Foreign Key -> `departments.id` ON DELETE CASCADE)
- `pc_name` (TEXT, Required) - Workstation hostname (e.g. `FIN-PC01`)
- `ip_address` (TEXT, Optional) - Workstation IP
- `notes` (TEXT, Optional) - Location or user info
- `created_at` (DATETIME)

### 3. `submissions`
- `id` (INTEGER, Primary Key, Auto-increment)
- `department_id` (INTEGER, Foreign Key -> `departments.id` ON DELETE CASCADE)
- `print_count` (INTEGER, Required) - Number of pages printed
- `week_start_date` (TEXT, Required) - `YYYY-MM-DD` (Monday of the reporting cycle)
- `status` (TEXT) - `'Submitted'` or `'Pending'`
- `supervisor_name` (TEXT, Optional) - Submitting supervisor
- `notes` (TEXT, Optional) - Justification or remarks
- `submitted_at` (DATETIME) - Timestamp of submission
- **Constraint:** `UNIQUE(department_id, week_start_date)`

### 4. `action_logs`
- `id` (INTEGER, Primary Key, Auto-increment)
- `department_id` (INTEGER, Foreign Key -> `departments.id`)
- `action_type` (TEXT) - `'BLOCK'`, `'UNBLOCK'`, `'CRON_CHECK'`
- `pc_name` (TEXT) - Workstation targeted
- `command` (TEXT) - Full PowerShell command executed
- `status` (TEXT) - `'SUCCESS'`, `'FAILED'`, or `'SIMULATED'`
- `output` (TEXT) - Standard output from PowerShell
- `error` (TEXT) - Error stream from PowerShell
- `executed_at` (DATETIME)

---

## ⚙️ Core Automation Logic

### 1. Friday 5:00 PM Deadline Enforcement (Node-Cron)
Every Friday at 17:00 (`0 17 * * 5`), the scheduled job performs:
1. Queries the database for all departments that have **not** submitted a count for the current week (`submissions.week_start_date = currentMonday AND status = 'Submitted'`).
2. Gathers all registered workstation hostnames (`pc_name`) for each non-compliant department.
3. Spawns `powershell.exe` to execute the block command:
   ```powershell
   Invoke-Command -ComputerName "<PC_Name>" -ScriptBlock { Stop-Service -Name Spooler -Force; Set-Service -Name Spooler -StartupType Disabled }
   ```
4. Updates department `spooler_status` to `'BLOCKED'` and records detailed logs in `action_logs`.

### 2. Automatic Real-Time Unblocking
When a supervisor accesses the web form and submits the delayed count:
1. The submission record is created or updated in `submissions`.
2. The backend immediately triggers the unblock command across all workstations in that department:
   ```powershell
   Invoke-Command -ComputerName "<PC_Name>" -ScriptBlock { Set-Service -Name Spooler -StartupType Automatic; Start-Service -Name Spooler }
   ```
3. Updates department `spooler_status` to `'ACTIVE'` and provides immediate feedback in the UI.

---

## 🚀 Quick Start Guide (1-Click Batch Files)

For quick setup and running on any laptop:
- **`setup_new_laptop.bat`**: Right-click and **Run as Administrator** to automatically check/install Node.js, configure WinRM/PowerShell permissions, install dependencies, seed the database, and run self-tests.
- **`start_system.bat`**: Double-click anytime to launch the server and open the web portal in your browser.
- **`test_pc_connection.bat`**: Double-click to test WinRM port 5985 and Print Spooler access on any remote workstation.

---

### Manual Setup Steps
- **Node.js**: LTS version (v18.x, v20.x, or v22+)
- **PowerShell**: 5.1 or PowerShell 7+

### 2. Install Dependencies
```powershell
npm install
```

### 3. Configure `.env`
Edit `.env` to suit your testing or production environment:
```env
PORT=3000
DB_PATH=./data/printer_tracking.db
CRON_SCHEDULE=0 17 * * 5
SIMULATE_POWERSHELL=true     # Set to 'false' in production domain
POWERSHELL_TIMEOUT_MS=15000  # Timeout for offline PCs (15 seconds)
```

> **Tip:** Keep `SIMULATE_POWERSHELL=true` while testing on a local laptop/development machine so you can verify all UI flows and database logs without needing active domain PCs.

### 4. Seed Initial Data
Populate realistic departments (Finance, HR, Supply Chain, Sales, etc.) and sample workstations:
```powershell
npm run seed
```

### 5. Start the Web Server
```powershell
npm start
```
- **Supervisor Portal**: [http://localhost:3000/](http://localhost:3000/)
- **IT Admin Dashboard**: [http://localhost:3000/admin](http://localhost:3000/admin)

---

## 🛡️ Windows Server & Active Directory Domain Setup Guide

To allow the Node.js application to execute remote PowerShell commands seamlessly across domain client PCs without permission errors, follow these steps:

### Step 1: Enable WinRM Across Domain Workstations (Group Policy / GPO)
On your Active Directory Domain Controller:
1. Open **Group Policy Management** (`gpmc.msc`).
2. Create or edit a GPO linked to the Workstations Organizational Unit (OU) (e.g. `Print-Management-Policy`).
3. **Enable WinRM Service:**
   - Path: `Computer Configuration` -> `Policies` -> `Administrative Templates` -> `Windows Components` -> `Windows Remote Management (WinRM)` -> `WinRM Service`
   - Policy: **Allow remote server management through WinRM**
   - Set to: **Enabled**
   - IPv4 Filter: `*` (or your management server's static IP/subnet)
4. **Configure WinRM Service to Start Automatically:**
   - Path: `Computer Configuration` -> `Policies` -> `Windows Settings` -> `Security Settings` -> `System Services`
   - Select **Windows Remote Management (WS-Management)** -> Set Startup Mode to **Automatic**.
5. **Open Windows Firewall Inbound Port (Port 5985):**
   - Path: `Computer Configuration` -> `Policies` -> `Windows Settings` -> `Security Settings` -> `Windows Defender Firewall with Advanced Security` -> `Inbound Rules`
   - Add Predefined Rule: **Windows Remote Management (HTTP-In)** (TCP Port 5985).

*To verify on a client PC directly:*
```powershell
winrm quickconfig -q
Enable-PSRemoting -Force
```

---

### Step 2: Dedicated Domain Service Account Setup
Do **not** run the web application under a regular user account or the local `SYSTEM` account. Create a dedicated Domain Service Account:

1. In Active Directory Users and Computers (`dsa.msc`):
   - Create user: `svc-printadmin`
   - Set password to never expire.
2. Grant Remote Management & Service Control Rights:
   - Option A (**Recommended**): Add `svc-printadmin` to the **Remote Management Users** domain group, and grant it permissions to start/stop the Spooler service via GPO or `sc.exe`:
     ```powershell
     # Grant Remote Management Users rights to control the Spooler service
     sc.exe sdset Spooler "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;RPWP;;;S-1-5-32-580)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)"
     ```
   - Option B: Add `svc-printadmin` to a restricted "Workstation Administrators" group across client PCs via GPO Restricted Groups.

---

### Step 3: Run Node.js as a Windows Service (NSSM)
To ensure the server starts automatically with Windows Server, runs in the background, and has proper domain Kerberos authentication tokens:

1. Download **NSSM** (Non-Sucking Service Manager) from [nssm.cc](https://nssm.cc/) or install via winget/choco:
   ```powershell
   choco install nssm
   ```
2. Install the service:
   ```powershell
   nssm install MalibanPrintTracker "C:\Program Files\nodejs\node.exe" "C:\inetpub\apps\printer-blocking\server.js"
   nssm set MalibanPrintTracker AppDirectory "C:\inetpub\apps\printer-blocking"
   nssm set MalibanPrintTracker Description "Maliban IT Print Count & Spooler Restriction Service"
   ```
3. Set the Service Account Credentials:
   ```powershell
   nssm set MalibanPrintTracker ObjectName "MALIBAN\svc-printadmin" "YourServiceAccountPassword"
   ```
4. Start the service:
   ```powershell
   nssm start MalibanPrintTracker
   ```

---

### Step 4: Verification and Smoke Testing
Test the remote command directly from PowerShell on the application server:
```powershell
# Test connection
Test-WsMan -ComputerName "FIN-PC01"

# Test Spooler Status
Invoke-Command -ComputerName "FIN-PC01" -ScriptBlock { Get-Service -Name Spooler }

# Test Block Command
Invoke-Command -ComputerName "FIN-PC01" -ScriptBlock { Stop-Service -Name Spooler -Force; Set-Service -Name Spooler -StartupType Disabled }

# Test Unblock Command
Invoke-Command -ComputerName "FIN-PC01" -ScriptBlock { Set-Service -Name Spooler -StartupType Automatic; Start-Service -Name Spooler }
```
When these commands succeed in PowerShell, the Node.js application will execute them seamlessly without permission prompts or popups!
