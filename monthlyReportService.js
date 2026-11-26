const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { dbAsync } = require('./database');

// Reports directory
const reportsDir = path.resolve(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// CRC32 Lookup Table for pure Node zip generation
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/**
 * Pure Node.js ZIP archive builder with zero external dependencies
 */
function buildZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const compData = zlib.deflateRawSync(data);

    // Local file header (30 bytes + filename)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4);         // version needed (2.0)
    lh.writeUInt16LE(0, 6);          // flags
    lh.writeUInt16LE(8, 8);          // compression method (deflate)
    lh.writeUInt16LE(0, 10);         // time
    lh.writeUInt16LE(0, 12);         // date
    lh.writeUInt32LE(crc, 14);       // crc32
    lh.writeUInt32LE(compData.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22);     // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);  // filename length
    lh.writeUInt16LE(0, 28);               // extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compData);

    // Central directory header (46 bytes + filename)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4);         // version made by
    ch.writeUInt16LE(20, 6);         // version needed
    ch.writeUInt16LE(0, 8);          // flags
    ch.writeUInt16LE(8, 10);         // compression method
    ch.writeUInt16LE(0, 12);         // time
    ch.writeUInt16LE(0, 14);         // date
    ch.writeUInt32LE(crc, 16);       // crc32
    ch.writeUInt32LE(compData.length, 20); // compressed size
    ch.writeUInt32LE(data.length, 24);     // uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28);  // filename length
    ch.writeUInt16LE(0, 30);               // extra length
    ch.writeUInt16LE(0, 32);               // comment length
    ch.writeUInt16LE(0, 34);               // disk start
    ch.writeUInt16LE(0, 36);               // internal attrs
    ch.writeUInt32LE(0, 38);               // external attrs
    ch.writeUInt32LE(offset, 42);          // local header offset
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + compData.length;
  }

  const centralSize = centralHeaders.reduce((s, b) => s + b.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // signature
  endRecord.writeUInt16LE(0, 4);          // disk number
  endRecord.writeUInt16LE(0, 6);          // start disk
  endRecord.writeUInt16LE(files.length, 8); // entries on disk
  endRecord.writeUInt16LE(files.length, 10); // total entries
  endRecord.writeUInt32LE(centralSize, 12);  // central directory size
  endRecord.writeUInt32LE(offset, 16);       // central directory offset
  endRecord.writeUInt16LE(0, 20);           // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord]);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_SHORT = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
];

/**
 * Returns month metadata, names, and 25th 23:59:59 cutoffs
 */
function getBillingCycleInfo(targetYear, targetMonth) {
  const now = new Date();
  const year = targetYear ? parseInt(targetYear, 10) : now.getFullYear();
  const month = targetMonth ? parseInt(targetMonth, 10) : (now.getMonth() + 1);

  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  const currentMonthName = MONTH_NAMES[month - 1];
  const prevMonthName = MONTH_NAMES[prevMonth - 1];
  const currentMonthShort = MONTH_SHORT[month - 1];
  const prevMonthShort = MONTH_SHORT[prevMonth - 1];

  const currentCutoff = `${year}-${String(month).padStart(2, '0')}-25 23:59:59`;
  const prevCutoff = `${prevYear}-${String(prevMonth).padStart(2, '0')}-25 23:59:59`;

  return {
    year,
    month,
    prevYear,
    prevMonth,
    currentMonthName,
    prevMonthName,
    currentMonthShort,
    prevMonthShort,
    currentCutoff,
    prevCutoff
  };
}

/**
 * Compiles supervisor-submitted printer counts for the billing cycle
 */
async function compileMonthlyReport(targetYear, targetMonth) {
  const cycle = getBillingCycleInfo(targetYear, targetMonth);

  // 1. Fetch all distinct active printers from printer_master and rental_printers
  const printers = await dbAsync.all(`
    SELECT DISTINCT p.printer_id, p.serial_number, p.printer_model, p.location, p.branch, p.dep_id,
           COALESCE(d.name, p.location) as dept_name
    FROM printer_master p
    LEFT JOIN departments d ON p.dep_id = d.id
    WHERE p.location NOT IN (SELECT location_name FROM excluded_locations)
      AND p.serial_number IS NOT NULL AND TRIM(p.serial_number) != ''
    ORDER BY p.location ASC, p.serial_number ASC
  `);

  // Also check if rental_printers has any unique serial numbers not in printer_master
  const rentalPrinters = await dbAsync.all(`
    SELECT DISTINCT r.id as rental_id, r.serial_number, r.model as printer_model, r.location, r.branch, r.department_id as dep_id,
           COALESCE(d.name, r.location) as dept_name
    FROM rental_printers r
    LEFT JOIN departments d ON r.department_id = d.id
    WHERE r.location NOT IN (SELECT location_name FROM excluded_locations)
      AND r.serial_number IS NOT NULL AND TRIM(r.serial_number) != ''
  `);

  const mergedPrintersMap = new Map();
  for (const p of printers) {
    mergedPrintersMap.set(p.serial_number.toUpperCase(), p);
  }
  for (const r of rentalPrinters) {
    const key = r.serial_number.toUpperCase();
    if (!mergedPrintersMap.has(key)) {
      mergedPrintersMap.set(key, {
        printer_id: null,
        rental_id: r.rental_id,
        serial_number: r.serial_number,
        printer_model: r.printer_model,
        location: r.location,
        branch: r.branch,
        dep_id: r.dep_id,
        dept_name: r.dept_name
      });
    }
  }

  const allPrintersList = Array.from(mergedPrintersMap.values()).sort((a, b) => {
    return (a.location || '').localeCompare(b.location || '');
  });

  // 2. Evaluate readings for each printer
  const rows = [];
  let grandTotalUsage = 0;
  let pendingCount = 0;
  let negativeCount = 0;
  let completedCount = 0;

  for (const p of allPrintersList) {
    const cleanSerial = p.serial_number.trim().toUpperCase();
    const cleanLocation = p.location ? p.location.trim() : (p.dept_name || 'Plant Location');

    // A. Current Month Total Reading (latest on or before currentCutoff)
    let currentTotal = null;
    let currentReadingDate = null;

    // Direct override in printer_monthly_readings if present
    if (p.printer_id) {
      const pmr = await dbAsync.get(
        'SELECT total_count, created_at FROM printer_monthly_readings WHERE printer_id = ? AND year = ? AND month = ?',
        [p.printer_id, cycle.year, cycle.month]
      );
      if (pmr && pmr.total_count !== null && pmr.total_count !== undefined) {
        currentTotal = pmr.total_count;
        currentReadingDate = pmr.created_at;
      }
    }

    // Supervisor submissions: latest submission for this billing cycle / month
    if (currentTotal === null) {
      const sub = await dbAsync.get(
        `SELECT print_count, submitted_at, week_start_date 
         FROM submissions 
         WHERE status = 'Submitted'
           AND (
             (printer_id IS NOT NULL AND printer_id = ?)
             OR (department_id IS NOT NULL AND department_id = ?)
             OR LOWER(location) = LOWER(?)
           )
           AND (
             datetime(submitted_at) <= datetime(?)
             OR (strftime('%Y', week_start_date) = ? AND CAST(strftime('%m', week_start_date) AS INTEGER) = ?)
             OR (strftime('%Y', submitted_at) = ? AND CAST(strftime('%m', submitted_at) AS INTEGER) = ?)
           )
         ORDER BY datetime(submitted_at) DESC, id DESC
         LIMIT 1`,
        [
          p.printer_id || 0, p.dep_id || 0, cleanLocation,
          cycle.currentCutoff,
          String(cycle.year), cycle.month,
          String(cycle.year), cycle.month
        ]
      );

      if (sub && sub.print_count !== null && sub.print_count !== undefined) {
        currentTotal = sub.print_count;
        currentReadingDate = sub.submitted_at;
      }
    }

    // Fact table fallback
    if (currentTotal === null && p.printer_id) {
      const fact = await dbAsync.get(
        `SELECT print_count, created_at 
         FROM fact_printer_count 
         WHERE printer_id = ? 
           AND (
             datetime(created_at) <= datetime(?)
             OR (strftime('%Y', created_at) = ? AND CAST(strftime('%m', created_at) AS INTEGER) = ?)
           )
         ORDER BY datetime(created_at) DESC, count_id DESC
         LIMIT 1`,
        [p.printer_id, cycle.currentCutoff, String(cycle.year), cycle.month]
      );
      if (fact && fact.print_count !== null) {
        currentTotal = fact.print_count;
        currentReadingDate = fact.created_at;
      }
    }

    // B. Previous Month Total Reading (latest on or before prevCutoff)
    let prevTotal = null;
    let prevReadingDate = null;

    if (p.printer_id) {
      const pmrPrev = await dbAsync.get(
        'SELECT total_count, created_at FROM printer_monthly_readings WHERE printer_id = ? AND year = ? AND month = ?',
        [p.printer_id, cycle.prevYear, cycle.prevMonth]
      );
      if (pmrPrev && pmrPrev.total_count !== null) {
        prevTotal = pmrPrev.total_count;
        prevReadingDate = pmrPrev.created_at;
      }
    }

    if (prevTotal === null) {
      const subPrev = await dbAsync.get(
        `SELECT print_count, submitted_at, week_start_date 
         FROM submissions 
         WHERE status = 'Submitted'
           AND (
             (printer_id IS NOT NULL AND printer_id = ?)
             OR (department_id IS NOT NULL AND department_id = ?)
             OR LOWER(location) = LOWER(?)
           )
           AND (
             datetime(submitted_at) <= datetime(?)
             OR (strftime('%Y', week_start_date) = ? AND CAST(strftime('%m', week_start_date) AS INTEGER) = ?)
             OR (strftime('%Y', submitted_at) = ? AND CAST(strftime('%m', submitted_at) AS INTEGER) = ?)
           )
         ORDER BY datetime(submitted_at) DESC, id DESC
         LIMIT 1`,
        [
          p.printer_id || 0, p.dep_id || 0, cleanLocation,
          cycle.prevCutoff,
          String(cycle.prevYear), cycle.prevMonth,
          String(cycle.prevYear), cycle.prevMonth
        ]
      );

      if (subPrev && subPrev.print_count !== null) {
        prevTotal = subPrev.print_count;
        prevReadingDate = subPrev.submitted_at;
      }
    }

    if (prevTotal === null && p.printer_id) {
      const factPrev = await dbAsync.get(
        `SELECT print_count, created_at 
         FROM fact_printer_count 
         WHERE printer_id = ? 
           AND (
             datetime(created_at) <= datetime(?)
             OR (strftime('%Y', created_at) = ? AND CAST(strftime('%m', created_at) AS INTEGER) = ?)
           )
         ORDER BY datetime(created_at) DESC, count_id DESC
         LIMIT 1`,
        [p.printer_id, cycle.prevCutoff, String(cycle.prevYear), cycle.prevMonth]
      );
      if (factPrev && factPrev.print_count !== null) {
        prevTotal = factPrev.print_count;
        prevReadingDate = factPrev.created_at;
      }
    }

    // Baseline calculation: if previous month has no reading yet, check if there is an earliest reading BEFORE current month
    if (prevTotal === null && currentTotal !== null) {
      const monthStart = `${cycle.year}-${String(cycle.month).padStart(2, '0')}-01 00:00:00`;
      const initialSub = await dbAsync.get(
        `SELECT print_count, submitted_at
         FROM submissions
         WHERE status = 'Submitted'
           AND datetime(submitted_at) < datetime(?)
           AND (
             (printer_id IS NOT NULL AND printer_id = ?)
             OR (department_id IS NOT NULL AND department_id = ?)
             OR LOWER(location) = LOWER(?)
           )
         ORDER BY datetime(submitted_at) DESC, id DESC
         LIMIT 1`,
        [monthStart, p.printer_id || 0, p.dep_id || 0, cleanLocation]
      );
      if (initialSub && initialSub.print_count !== null) {
        prevTotal = initialSub.print_count;
        prevReadingDate = initialSub.submitted_at;
      } else {
        // If currentTotal exists and no prior reading exists before current month, default baseline is 0
        prevTotal = 0;
      }
    }

    // C. Calculate Usage & Status
    let usage = null;
    let isPending = false;
    let isNegative = false;

    if (currentTotal === null) {
      isPending = true;
      pendingCount++;
    } else {
      const safePrev = prevTotal !== null ? prevTotal : 0;
      usage = currentTotal - safePrev;
      if (usage < 0) {
        isNegative = true;
        negativeCount++;
      } else {
        completedCount++;
      }
      grandTotalUsage += usage;
    }

    rows.push({
      printer_id: p.printer_id,
      location: cleanLocation,
      serial: cleanSerial,
      model: p.printer_model || 'Maliban Laser Printer',
      branch: p.branch || 'General',
      prevTotal: prevTotal,
      prevReadingDate: prevReadingDate,
      currentTotal: currentTotal,
      currentReadingDate: currentReadingDate,
      usage: usage,
      isPending: isPending,
      isNegative: isNegative,
      status: isPending ? 'Pending' : (isNegative ? 'Negative Usage' : 'Verified')
    });
  }

  return {
    year: cycle.year,
    month: cycle.month,
    currentMonthName: cycle.currentMonthName,
    prevMonthName: cycle.prevMonthName,
    currentMonthShort: cycle.currentMonthShort,
    prevMonthShort: cycle.prevMonthShort,
    cutoffDate: cycle.currentCutoff,
    prevCutoffDate: cycle.prevCutoff,
    headers: {
      col1: 'LOCATION',
      col2: 'SERIAL',
      col3: `TOTAL ${cycle.prevMonthName.toUpperCase()}`,
      col4: `TOTAL ${cycle.currentMonthName.toUpperCase()}`,
      col5: `${cycle.currentMonthName.toUpperCase()} USAGE`
    },
    summary: {
      totalPrinters: allPrintersList.length,
      completedCount,
      pendingCount,
      negativeCount,
      grandTotalUsage
    },
    rows
  };
}

/**
 * Escapes XML strings
 */
function escapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates formatted .xlsx file matching Section 3 styling specifications
 */
function generateExcelBuffer(reportData) {
  const { headers, rows, summary, currentMonthName, year } = reportData;

  // OpenXML Stylesheet (Sky blue header #00B0F0, bold text, borders, number formatting)
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="#,##0;[Red]-#,##0;&quot;-&quot;"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00B0F0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F8"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/></border>
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
    </border>
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="double"><color rgb="FF000000"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="8">
    <!-- 0: Default Normal -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Header (Sky Blue #00B0F0, Bold Black, Centered, Thin Border) -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 2: Data String Centered (LOCATION, SERIAL) with Thin Border -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 3: Numeric Right-Aligned (#,##0) with Thin Border -->
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 4: Negative Usage (Light Red Fill, Bold Red Text, Right-Aligned) -->
    <xf numFmtId="3" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 5: Pending Status (Light Yellow Fill, Centered) -->
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 6: Grand Total Label (Bold, Light Gray Fill, Double Bottom Border) -->
    <xf numFmtId="0" fontId="3" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 7: Grand Total Numeric (Bold, Right-Aligned, #,##0, Double Bottom Border) -->
    <xf numFmtId="3" fontId="3" fillId="5" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>`;

  // Build sheet rows XML
  let sheetRowsXml = '';

  // Row 1: Header Row
  sheetRowsXml += `<row r="1" ht="28" customHeight="1">
    <c r="A1" t="str" s="1"><v>${escapeXml(headers.col1)}</v></c>
    <c r="B1" t="str" s="1"><v>${escapeXml(headers.col2)}</v></c>
    <c r="C1" t="str" s="1"><v>${escapeXml(headers.col3)}</v></c>
    <c r="D1" t="str" s="1"><v>${escapeXml(headers.col4)}</v></c>
    <c r="E1" t="str" s="1"><v>${escapeXml(headers.col5)}</v></c>
  </row>`;

  // Calculate auto-fit column widths
  let maxColA = headers.col1.length;
  let maxColB = headers.col2.length;
  let maxColC = headers.col3.length;
  let maxColD = headers.col4.length;
  let maxColE = headers.col5.length;

  // Data Rows
  let rowIdx = 2;
  for (const r of rows) {
    const locStr = r.location || 'N/A';
    const serialStr = r.serial || 'N/A';
    maxColA = Math.max(maxColA, locStr.length);
    maxColB = Math.max(maxColB, serialStr.length);

    sheetRowsXml += `<row r="${rowIdx}" ht="22" customHeight="1">`;
    // Col A: Location
    sheetRowsXml += `<c r="A${rowIdx}" t="str" s="2"><v>${escapeXml(locStr)}</v></c>`;
    // Col B: Serial
    sheetRowsXml += `<c r="B${rowIdx}" t="str" s="2"><v>${escapeXml(serialStr)}</v></c>`;

    // Col C: Previous Month Total
    if (r.prevTotal !== null) {
      sheetRowsXml += `<c r="C${rowIdx}" s="3"><v>${r.prevTotal}</v></c>`;
      maxColC = Math.max(maxColC, String(r.prevTotal).length + 3);
    } else {
      sheetRowsXml += `<c r="C${rowIdx}" t="str" s="2"><v>-</v></c>`;
    }

    // Col D: Current Month Total
    if (r.currentTotal !== null) {
      sheetRowsXml += `<c r="D${rowIdx}" s="3"><v>${r.currentTotal}</v></c>`;
      maxColD = Math.max(maxColD, String(r.currentTotal).length + 3);
    } else {
      sheetRowsXml += `<c r="D${rowIdx}" t="str" s="5"><v>Pending</v></c>`;
    }

    // Col E: Usage
    if (r.usage !== null) {
      const usageStyle = r.isNegative ? 4 : 3;
      sheetRowsXml += `<c r="E${rowIdx}" s="${usageStyle}"><v>${r.usage}</v></c>`;
      maxColE = Math.max(maxColE, String(r.usage).length + 3);
    } else {
      sheetRowsXml += `<c r="E${rowIdx}" t="str" s="5"><v>Pending</v></c>`;
    }

    sheetRowsXml += `</row>`;
    rowIdx++;
  }

  // Grand Total Row at bottom
  sheetRowsXml += `<row r="${rowIdx}" ht="24" customHeight="1">
    <c r="A${rowIdx}" t="str" s="6"><v>GRAND TOTAL</v></c>
    <c r="B${rowIdx}" t="str" s="6"><v></v></c>
    <c r="C${rowIdx}" t="str" s="6"><v></v></c>
    <c r="D${rowIdx}" t="str" s="6"><v></v></c>
    <c r="E${rowIdx}" s="7"><v>${summary.grandTotalUsage}</v></c>
  </row>`;

  // Column width padding
  const colAWidth = Math.max(maxColA + 4, 24);
  const colBWidth = Math.max(maxColB + 4, 18);
  const colCWidth = Math.max(maxColC + 4, 18);
  const colDWidth = Math.max(maxColD + 4, 18);
  const colEWidth = Math.max(maxColE + 4, 18);

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:E${rowIdx}"/>
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>
    <col min="1" max="1" width="${colAWidth}" customWidth="1"/>
    <col min="2" max="2" width="${colBWidth}" customWidth="1"/>
    <col min="3" max="3" width="${colCWidth}" customWidth="1"/>
    <col min="4" max="4" width="${colDWidth}" customWidth="1"/>
    <col min="5" max="5" width="${colEWidth}" customWidth="1"/>
  </cols>
  <sheetData>
    ${sheetRowsXml}
  </sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(currentMonthName)} ${year}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: relsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml }
  ]);
}

/**
 * Compiles report, creates formatted .xlsx file and saves to reports directory
 */
async function generateAndSaveExcel(targetYearOrReport, targetMonth) {
  let reportData;
  if (targetYearOrReport && typeof targetYearOrReport === 'object' && targetYearOrReport.rows) {
    reportData = targetYearOrReport;
  } else {
    reportData = await compileMonthlyReport(targetYearOrReport, targetMonth);
  }
  const buffer = generateExcelBuffer(reportData);
  const filename = `Print_Usage_Report_${reportData.currentMonthName.slice(0, 3)}_${reportData.year}.xlsx`;
  const filePath = path.join(reportsDir, filename);

  fs.writeFileSync(filePath, buffer);

  return {
    reportData,
    buffer,
    filename,
    filePath
  };
}

/**
 * Snapshots the report in monthly_reports table
 */
async function snapshotMonthlyReport(targetYear, targetMonth) {
  const { reportData, filePath } = await generateAndSaveExcel(targetYear, targetMonth);

  await dbAsync.run(
    `INSERT INTO monthly_reports (year, month, month_name, prev_month_name, cutoff_date, total_usage, total_printers, pending_count, report_json, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET
       total_usage = excluded.total_usage,
       total_printers = excluded.total_printers,
       pending_count = excluded.pending_count,
       report_json = excluded.report_json,
       file_path = excluded.file_path,
       generated_at = CURRENT_TIMESTAMP`,
    [
      reportData.year,
      reportData.month,
      reportData.currentMonthName,
      reportData.prevMonthName,
      reportData.cutoffDate,
      reportData.summary.grandTotalUsage,
      reportData.summary.totalPrinters,
      reportData.summary.pendingCount,
      JSON.stringify(reportData),
      filePath
    ]
  );

  return { reportData, filePath };
}

module.exports = {
  getBillingCycleInfo,
  compileMonthlyReport,
  generateExcelBuffer,
  generateAndSaveExcel,
  snapshotMonthlyReport,
  reportsDir
};
