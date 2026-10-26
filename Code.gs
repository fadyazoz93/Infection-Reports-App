
/**
 * Handle GET requests (Data Retrieval & Health Check)
 */
function doGet(e) {
  // 1. التحقق مما إذا كان هناك طلب قراءة للبيانات من تطبيق Vercel
  if (e && e.parameter && Object.keys(e.parameter).length > 0) {
    // دمج كود جلب البيانات ليعمل مع طلبات GET أيضاً
    try {
      const incoming = e.parameter;
      if (incoming.sheetId) {
        const ss = SpreadsheetApp.openById(incoming.sheetId);
        const method = incoming.method;

        if (method === 'getSettings') {
          return ContentService.createTextOutput(JSON.stringify({data: getSettings(ss), success: true})).setMimeType(ContentService.MimeType.JSON);
        } else if (method === 'getDashboardMetrics') {
          return ContentService.createTextOutput(JSON.stringify({data: getDashboardMetrics(ss), success: true})).setMimeType(ContentService.MimeType.JSON);
        } else if (method === 'getReportData') {
          const args = incoming.args ? JSON.parse(incoming.args) : [];
          return ContentService.createTextOutput(JSON.stringify({data: getReportData(ss, ...args), success: true})).setMimeType(ContentService.MimeType.JSON);
        }
      }
    } catch (err) {
      // Fallback
    }

    return ContentService.createTextOutput(JSON.stringify({"status": "success", "message": "Data endpoints are active"}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  // 2. رسالة فحص السيرفر للزيارات المباشرة
  return ContentService.createTextOutput("API Server is Running Successfully.")
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Handle External API Requests (Netlify/Vercel)
 */
function doPost(e) {
  try {
    const incoming = JSON.parse(e.postData.contents);
    
    if (!incoming.sheetId) throw new Error("لم يتم إرسال sheetId مع الطلب.");
    const ss = SpreadsheetApp.openById(incoming.sheetId);
    
    const method = incoming.method;
    const args = incoming.args || [];
    
    let result;
    if (method === 'getSettings') result = getSettings(ss);
    else if (method === 'saveSettingsData') result = saveSettingsData(ss, ...args);
    else if (method === 'saveDailyReport') result = saveDailyReport(ss, ...args);
    else if (method === 'getReportData') result = getReportData(ss, ...args);
    else if (method === 'getDashboardMetrics') result = getDashboardMetrics(ss);
    else if (method === 'copyMonthlyReport') result = copyMonthlyReport(ss, ...args);
    else throw new Error("Method not found: " + method);
    
    return ContentService.createTextOutput(JSON.stringify({data: result, success: true}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({error: error.message, success: false}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Setup Spreadsheet Structure (Run once or checks on load)
 * @param {Spreadsheet} optSS - Optional spreadsheet instance to avoid recursive calls
 */
function setupSheet(optSS) {
  // Use the passed instance or fetch safely
  const ss = optSS;
  
  // 1. Data Sheet
  let dataSheet = ss.getSheetByName('Reports Data');
  if (!dataSheet) {
    dataSheet = ss.insertSheet('Reports Data');
    dataSheet.appendRow(['Date', 'Month', 'Year', 'Period', 'Department', 'Inspector', 'Supervisor', 'Procedure', 'Status', 'Note', 'Recommendation', 'Timestamp']);
    dataSheet.setFrozenRows(1);
  }

  // 2. Settings Sheet
  let settingsSheet = ss.getSheetByName('Reports Settings');
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet('Reports Settings');
    settingsSheet.appendRow(['Key', 'Value (JSON)']);
    // Default Settings
    const defaults = [
      ['hospitalName', JSON.stringify('مستشفى المنيا الجامعى للعيون')],
      ['teamSignature', JSON.stringify('فريق مكافحة العدوى')],
      ['managerSignature', JSON.stringify('مدير عام المستشفى')],
      ['passwords', JSON.stringify({ admin: 'admin', manger: 'manger', user: 'user' })],
      ['departments', JSON.stringify(['طوارئ', 'عناية مركزة', 'عمليات', 'عيادات خارجية', 'معمل', 'أشعة'])],
      ['periods', JSON.stringify(['صباحية', 'مسائية', 'سهر'])],
      ['inspectors', JSON.stringify(['د. أحمد', 'د. محمد', 'أ. سارة'])],
      ['procedures', JSON.stringify([
         {name: 'غسل الأيدي', note: 'عدم الالتزام باللحظات الخمس', rec: 'إعادة التدريب', depts: []},
         {name: 'ارتداء الواقيات الشخصية', note: 'عدم ارتداء الماسك/الجوانتي', rec: 'توفير المستلزمات', depts: []},
         {name: 'فرز النفايات', note: 'خلط النفايات', rec: 'توفير أكياس ملونة', depts: []},
         {name: 'تعقيم الآلات', note: 'قصور في الدورة التعقيمية', rec: 'صيانة الأوتوكلاف', depts: ['عمليات', 'طوارئ']}
      ])]
    ];
    defaults.forEach(row => settingsSheet.appendRow(row));
  }
}

/**
 * Save Daily Report
 */
function saveDailyReport(ss, form) {
  let sheet = ss.getSheetByName('Reports Data');
  // Ensure structure exists
  if (!sheet) { setupSheet(ss); sheet = ss.getSheetByName('Reports Data'); }

  // Create a Date object from the input string (YYYY-MM-DD)
  // We use new Date(form.date) which parses as UTC midnight usually, 
  // but it's safer to store as a Date object in Sheets for sorting.
  const dateObj = new Date(form.date);
  const month = dateObj.getMonth() + 1;
  const year = dateObj.getFullYear();
  const timestamp = new Date();

  const rows = form.evaluations.map(e => {
    return [
      dateObj,        // 0: Store as Date Object
      month,          // 1
      year,           // 2
      form.period,    // 3
      form.department,// 4
      form.inspector, // 5
      form.supervisor,// 6
      e.procedure,    // 7
      e.status,       // 8
      e.note,         // 9
      e.rec,          // 10
      timestamp       // 11
    ];
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return {success: true};
}

/**
 * Copy Monthly Report from sourceMonth (YYYY-MM) to targetMonth (YYYY-MM)
 */
function copyMonthlyReport(ss, sourceMonth, targetMonth, replaceExisting) {
  let sheet = ss.getSheetByName('Reports Data');
  if (!sheet) { setupSheet(ss); sheet = ss.getSheetByName('Reports Data'); }

  if (!sourceMonth || !targetMonth || sourceMonth === targetMonth) {
    throw new Error("يرجى اختيار شهرين مختلفين للنسخ");
  }

  const sourceRows = getReportData(ss, 'monthly', sourceMonth);
  if (!sourceRows || sourceRows.length === 0) {
    throw new Error("لا توجد بيانات مسجلة في الشهر المصدر لنسخها");
  }

  const [tgtYear, tgtMonth] = String(targetMonth).split('-').map(Number);
  const maxDay = new Date(tgtYear, tgtMonth, 0).getDate();
  const timestamp = new Date();

  if (replaceExisting) {
    const allValues = sheet.getDataRange().getValues();
    for (let i = allValues.length - 1; i >= 1; i--) {
      if (Number(allValues[i][2]) === tgtYear && Number(allValues[i][1]) === tgtMonth) {
        sheet.deleteRow(i + 1);
      }
    }
  }

  const newRows = sourceRows.map(r => {
    const parts = String(r[0] || '').split('-');
    const origDay = parts.length === 3 ? (parseInt(parts[2], 10) || 1) : 1;
    const safeDay = Math.min(Math.max(origDay, 1), maxDay);
    const newDateObj = new Date(tgtYear, tgtMonth - 1, safeDay);
    return [
      newDateObj,
      tgtMonth,
      tgtYear,
      r[3] || "",
      r[4] || "",
      r[5] || "",
      r[6] || "",
      r[7] || "",
      r[8] || "",
      r[9] || "",
      r[10] || "",
      timestamp
    ];
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }

  return {
    success: true,
    copiedCount: newRows.length,
    sourceMonth: sourceMonth,
    targetMonth: targetMonth
  };
}

/**
 * Fetch Report Data
 */
function getReportData(ss, filterType, filterValue) {
  let sheet = ss.getSheetByName('Reports Data');
  if (!sheet) { setupSheet(ss); sheet = ss.getSheetByName('Reports Data'); }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // Only headers
  
  const headers = data.shift(); // Remove headers

  // Indices: 0:Date, 1:Month, 2:Year, 3:Period, 4:Dept, 5:Inspector, 6:Supervisor, 7:Procedure, 8:Status

  let filteredData = data;
  
  // Helper to safely get Date object
  const parseDate = (d) => {
    if (d instanceof Date) return d;
    if (typeof d === 'string') return new Date(d);
    return null;
  };

  // Helper to format Date to YYYY-MM-DD string to avoid timezone issues on client
  const formatDateStr = (d) => {
    if (!d) return "";
    const date = parseDate(d);
    if (!date || isNaN(date.getTime())) return "";
    // Format using the script's timezone (or UTC if preferred, but simple string concat is safest for YMD)
    // Using getFullYear, getMonth, getDate acts on local script time.
    // If the sheet cell is a Date, GAS reads it in script time.
    let y = date.getFullYear();
    let m = String(date.getMonth() + 1).padStart(2, '0');
    let day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  if (filterType === 'daily') {
    // filterValue = 'YYYY-MM-DD'
    filteredData = data.filter(row => {
      const dStr = formatDateStr(row[0]);
      return dStr === filterValue;
    });
  } else if (filterType === 'monthly') {
     // filterValue = 'YYYY-MM'
     const [y, m] = filterValue.split('-');
     filteredData = data.filter(row => row[2] == y && row[1] == parseInt(m));
  } else if (filterType === 'yearly') {
     // filterValue = 'YYYY'
     filteredData = data.filter(row => row[2] == filterValue);
  } else if (filterType === 'range') {
     // filterValue = {start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'}
     const start = new Date(filterValue.start);
     start.setHours(0, 0, 0, 0); 
     const end = new Date(filterValue.end);
     end.setHours(23, 59, 59, 999); 

     filteredData = data.filter(row => {
       const d = parseDate(row[0]);
       if (!d) return false;
       return d >= start && d <= end;
     });
  }

  // Convert dates to simple string YYYY-MM-DD for client
  return filteredData.map(row => {
    let r = [...row];
    r[0] = formatDateStr(row[0]); // Replace Date object with string
    // row[11] is timestamp, let's ISO string that one
    if (r[11] instanceof Date) r[11] = r[11].toISOString();
    return r;
  });
}

/**
 * Dashboard Metrics
 */
function getDashboardMetrics(ss) {
  let sheet = ss.getSheetByName('Reports Data');
  if (!sheet) { setupSheet(ss); sheet = ss.getSheetByName('Reports Data'); }
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  data.shift(); // remove header

  // Return simplified object list: {date, dept, status}
  return data.map(r => {
    let dStr = "";
    if (r[0] instanceof Date) {
       let m = String(r[0].getMonth() + 1).padStart(2, '0');
       let day = String(r[0].getDate()).padStart(2, '0');
       dStr = `${r[0].getFullYear()}-${m}-${day}`;
    } else {
       dStr = String(r[0]);
    }

    return {
      date: dStr, // Return YYYY-MM-DD string
      dept: r[4],
      status: r[8]
    };
  });
}

/**
 * Settings Management
 */
function getSettings(ss) {
  let sheet = ss.getSheetByName('Reports Settings');
  if (!sheet) { setupSheet(ss); sheet = ss.getSheetByName('Reports Settings'); }
  
  const data = sheet.getDataRange().getValues();
  const settings = {};
  
  // Skip header
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    const val = data[i][1];
    try {
      settings[key] = JSON.parse(val);
    } catch (e) {
      settings[key] = val;
    }
  }
  return settings;
}

function saveSettingsData(ss, newSettings) {
  let sheet = ss.getSheetByName('Reports Settings');
  if (!sheet) { setupSheet(ss); sheet = ss.getSheetByName('Reports Settings'); }
  
  // Clear everything including formatting to ensure we write from row 1
  sheet.clear();
  
  const rows = [
    ['Key', 'Value (JSON)'],
    ['hospitalName', JSON.stringify(newSettings.hospitalName || 'مستشفى المنيا الجامعى للعيون')],
    ['teamSignature', JSON.stringify(newSettings.teamSignature || 'فريق مكافحة العدوى')],
    ['managerSignature', JSON.stringify(newSettings.managerSignature || 'مدير عام المستشفى')],
    ['passwords', JSON.stringify(newSettings.passwords)],
    ['departments', JSON.stringify(newSettings.departments)],
    ['periods', JSON.stringify(newSettings.periods)],
    ['inspectors', JSON.stringify(newSettings.inspectors)],
    ['procedures', JSON.stringify(newSettings.procedures)]
  ];
  
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  
  return true;
}

// verifyPassword function removed as authentication is now handled via getSettings and role assignment in the frontend

