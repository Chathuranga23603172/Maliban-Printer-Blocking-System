const { dbAsync, initDatabase, getWeekStartDate } = require('./database');

async function seed() {
  console.log('[*] Initializing database for seeding...');
  await initDatabase();

  const currentWeek = getWeekStartDate();
  console.log(`[*] Seeding sample departments and computers for week: ${currentWeek}...`);

  const departmentsData = [
    {
      name: 'Finance & Accounts',
      computers: [
        { pc_name: 'FIN-PC01', ip: '192.168.10.21', notes: 'Accounts Payable Workstation' },
        { pc_name: 'FIN-PC02', ip: '192.168.10.22', notes: 'Payroll Lead Desktop' }
      ]
    },
    {
      name: 'Human Resources',
      computers: [
        { pc_name: 'HR-PC01', ip: '192.168.10.31', notes: 'HR Executive PC' },
        { pc_name: 'HR-PC02', ip: '192.168.10.32', notes: 'Recruitment & Training PC' }
      ]
    },
    {
      name: 'Supply Chain & Logistics',
      computers: [
        { pc_name: 'SCM-PC01', ip: '192.168.10.41', notes: 'Warehouse Dispatch PC' },
        { pc_name: 'SCM-PC02', ip: '192.168.10.42', notes: 'Inventory Controller PC' },
        { pc_name: 'SCM-PC03', ip: '192.168.10.43', notes: 'Shipping Gate Office PC' }
      ]
    },
    {
      name: 'Sales & Marketing',
      computers: [
        { pc_name: 'MKT-PC01', ip: '192.168.10.51', notes: 'Regional Sales Desk' },
        { pc_name: 'MKT-PC02', ip: '192.168.10.52', notes: 'Brand Manager Laptop' }
      ]
    },
    {
      name: 'Quality Assurance & Lab',
      computers: [
        { pc_name: 'QA-PC01', ip: '192.168.10.61', notes: 'Testing Lab Terminal' },
        { pc_name: 'QA-PC02', ip: '192.168.10.62', notes: 'QA Supervisor Desktop' }
      ]
    },
    {
      name: 'Production & Factory',
      computers: [
        { pc_name: 'PROD-PC01', ip: '192.168.10.71', notes: 'Shift Supervisor Station' },
        { pc_name: 'PROD-PC02', ip: '192.168.10.72', notes: 'Packaging Line PC' }
      ]
    }
  ];

  for (const dept of departmentsData) {
    try {
      const existing = await dbAsync.get('SELECT id FROM departments WHERE name = ?', [dept.name]);
      let deptId;
      if (!existing) {
        const res = await dbAsync.run(
          'INSERT INTO departments (name, spooler_status) VALUES (?, "ACTIVE")',
          [dept.name]
        );
        deptId = res.lastID;
        console.log(`[+] Added Department: ${dept.name} (ID: ${deptId})`);
      } else {
        deptId = existing.id;
        console.log(`[~] Department already exists: ${dept.name} (ID: ${deptId})`);
      }

      for (const comp of dept.computers) {
        const compExists = await dbAsync.get(
          'SELECT id FROM computers WHERE department_id = ? AND pc_name = ?',
          [deptId, comp.pc_name]
        );
        if (!compExists) {
          await dbAsync.run(
            'INSERT INTO computers (department_id, pc_name, ip_address, notes) VALUES (?, ?, ?, ?)',
            [deptId, comp.pc_name, comp.ip, comp.notes]
          );
          console.log(`  [+] Added Computer: ${comp.pc_name} (${comp.ip})`);
        }
      }
    } catch (err) {
      console.error(`[-] Error inserting ${dept.name}:`, err.message);
    }
  }

  // Add 1 sample submission for demonstration (Finance submitted)
  try {
    const finDept = await dbAsync.get('SELECT id FROM departments WHERE name = "Finance & Accounts"');
    if (finDept) {
      const subExists = await dbAsync.get(
        'SELECT id FROM submissions WHERE department_id = ? AND week_start_date = ?',
        [finDept.id, currentWeek]
      );
      if (!subExists) {
        await dbAsync.run(
          `INSERT INTO submissions (department_id, print_count, week_start_date, status, supervisor_name, notes)
           VALUES (?, 1240, ?, 'Submitted', 'Ruwan Silva', 'Weekly financial report printing')`,
          [finDept.id, currentWeek]
        );
        console.log(`[+] Seeded sample submission for Finance (Week: ${currentWeek})`);
      }
    }
  } catch (err) {
    console.error('[-] Error seeding sample submission:', err.message);
  }

  console.log('\n[SUCCESS] Seeding complete! You can now start the server with: npm start\n');
  process.exit(0);
}

seed();
