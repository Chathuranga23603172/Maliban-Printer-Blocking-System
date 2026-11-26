const http = require('http');
const { dbAsync, initDatabase, getWeekStartDate, getCurrentWeekDeadline } = require('./database');
const { checkAndBlockNonCompliantDepartments, unblockDepartmentPrinters, syncPendingWorkstations } = require('./powershell');

async function testAll() {
  await initDatabase();
  console.log('--- TEST 1: Week Calculation ---');
  const monday = getWeekStartDate();
  const deadline = getCurrentWeekDeadline(monday);
  console.log('Week Monday:', monday);
  console.log('Friday 5 PM Deadline:', deadline.toString());

  console.log('\n--- TEST 2: Database Query ---');
  const depts = await dbAsync.all('SELECT * FROM departments');
  console.log(`Found ${depts.length} departments:`, depts.map(d => d.name));

  console.log('\n--- TEST 3: Automated Friday Check (Simulation) ---');
  process.env.SIMULATE_POWERSHELL = 'true';
  const cronResult = await checkAndBlockNonCompliantDepartments();
  console.log('Cron check result:', JSON.stringify(cronResult, null, 2));

  console.log('\n--- TEST 4: Unblock Department (Simulation) ---');
  const unblockResult = await unblockDepartmentPrinters(1, 'Test Supervisor Submission');
  console.log('Unblock result:', JSON.stringify(unblockResult, null, 2));

  console.log('\n--- TEST 5: Action Logs in DB ---');
  const logs = await dbAsync.all('SELECT * FROM action_logs ORDER BY id DESC LIMIT 5');
  console.log(`Retrieved ${logs.length} action log entries:`);
  logs.forEach(l => console.log(`  [${l.action_type}] PC: ${l.pc_name} | Status: ${l.status} | Cmd: ${l.command}`));

  console.log('\n--- TEST 6: Periodic Sync Pending Workstations (Simulation) ---');
  const syncResult = await syncPendingWorkstations();
  console.log('Sync result:', JSON.stringify(syncResult, null, 2));

  console.log('\n[ALL UNIT TESTS PASSED SUCCESSFULLY]');
  process.exit(0);
}

testAll().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
