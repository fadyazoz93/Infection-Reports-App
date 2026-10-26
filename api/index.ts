import express, { Request, Response } from 'express';
import { db, createInfectionTable } from '../lib/db.js';
import { memoryCache } from '../lib/cache.js';

const app = express();

// Enable JSON parsing
app.use(express.json());

// Initialize SQLite database, tables, and mandatory indexes
createInfectionTable().then(() => {
  console.log("Database & performance indexes initialized successfully!");
}).catch(err => {
  console.error("Database initialization failed:", err);
});

// Explicit columns list for Reports Data queries (Strictly avoids SELECT * to prevent full scans)
const REPORT_COLUMNS = [
  'report_date',
  'month',
  'year',
  'period',
  'department',
  'inspector',
  'supervisor',
  'procedure',
  'status',
  'note',
  'rec',
  'timestamp'
].join(', ');

// Safe server-side proxy for public Google Drive logo images (avoids browser CORS/ORB blocks & caches in RAM with 0 DB reads)
app.get('/api/drive-image', async (req: Request, res: Response) => {
  try {
    const fileId = String(req.query.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{10,120}$/.test(fileId)) {
      return res.status(400).send('Invalid Google Drive file ID');
    }

    const cacheKey = `drive_img:${fileId}`;
    const cachedImg = memoryCache.get<{ buffer: Buffer; contentType: string }>(cacheKey);
    if (cachedImg) {
      res.setHeader('Content-Type', cachedImg.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cachedImg.buffer);
    }

    const candidateUrls = [
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w600`,
      `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w600`,
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
    ];

    for (const url of candidateUrls) {
      try {
        const upstream = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; InfectionControlReports/1.0)',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          }
        });

        const contentType = upstream.headers.get('content-type') || '';
        if (upstream.ok && contentType.startsWith('image/')) {
          const arrayBuf = await upstream.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          if (buffer.length > 0 && buffer.length <= 8 * 1024 * 1024) {
            memoryCache.set(cacheKey, { buffer, contentType }, 60 * 60 * 1000);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(buffer);
          }
        }
      } catch {
        // Try next candidate URL
      }
    }

    return res.status(404).send('Image not accessible. Ensure Google Drive file sharing is set to Anyone with the link.');
  } catch (err) {
    return res.status(500).send('Failed to proxy image');
  }
});

// RPC Gateway Handler
app.post('/api', async (req: Request, res: Response) => {
  try {
    const { method, args } = req.body;
    console.log(`[RPC API] Method: ${method}, Args:`, args);

    if (!method) {
      return res.status(400).json({ success: false, error: "Method parameter is required" });
    }

    let data: any = null;

    switch (method) {
      // ----------------------------------------------------
      // 1. Settings (Cached in memory with 15-minute TTL)
      // ----------------------------------------------------
      case 'getSettings': {
        const cacheKey = 'settings:all';
        const cached = memoryCache.get<any>(cacheKey);
        if (cached) {
          data = cached;
          break;
        }

        const rowsObj = await db.execute('SELECT key, value FROM "Reports Settings"');
        const settings: any = {};
        for (const row of rowsObj.rows) {
          const key = row.key as string;
          const val = row.value as string;
          try {
            settings[key] = JSON.parse(val);
          } catch {
            settings[key] = val;
          }
        }
        
        // If empty, provide default fallback settings and seed once
        if (Object.keys(settings).length === 0) {
          const defaultSettings = {
            hospitalName: 'مستشفى المنيا الجامعى للعيون',
            teamSignature: 'فريق مكافحة العدوى',
            managerSignature: 'مدير عام المستشفى',
            rightLogoUrl: '',
            leftLogoUrl: '',
            passwords: { admin: 'admin', manger: 'manger', user: 'user' },
            departments: ['طوارئ', 'عناية مركزة', 'عمليات', 'عيادات خارجية'],
            periods: ['صباحية', 'مسائية', 'سهر'],
            inspectors: ['د. تجريبي', 'م. مكافحة'],
            procedures: [
              {name: 'غسل الأيدي', note: 'عدم الالتزام باللحظات الخمس', rec: 'إعادة التدريب', depts: []},
              {name: 'ارتداء الواقيات', note: 'عدم ارتداء الماسك', rec: 'توفير المستلزمات', depts: ['عناية مركزة']},
              {name: 'فرز النفايات', note: 'خلط النفايات', rec: 'توفير أكياس ملونة', depts: []},
              {name: 'تعقيم الآلات', note: 'قصور في الدورة التعقيمية', rec: 'صيانة الأوتوكلاف', depts: ['عمليات', 'طوارئ']}
            ]
          };
          
          for (const [key, val] of Object.entries(defaultSettings)) {
            await db.execute({
              sql: 'INSERT OR REPLACE INTO "Reports Settings" (key, value) VALUES (?, ?)',
              args: [key, typeof val === 'object' ? JSON.stringify(val) : String(val)]
            });
            settings[key] = val;
          }
        }

        // Cache in memory: 15 minutes TTL
        memoryCache.set(cacheKey, settings, 15 * 60 * 1000);
        data = settings;
        break;
      }

      // ----------------------------------------------------
      // 2. Save Settings (Optimistic Mutation: 0 follow-up reads)
      // ----------------------------------------------------
      case 'saveSettingsData': {
        const [newSettings] = args || [];
        if (!newSettings) {
          throw new Error("Missing settings parameter");
        }
        for (const [key, val] of Object.entries(newSettings)) {
          await db.execute({
            sql: 'INSERT OR REPLACE INTO "Reports Settings" (key, value) VALUES (?, ?)',
            args: [key, typeof val === 'object' ? JSON.stringify(val) : String(val)]
          });
        }

        // Optimistically update memory cache without executing a SELECT
        memoryCache.set('settings:all', newSettings, 15 * 60 * 1000);
        data = true;
        break;
      }

      // ----------------------------------------------------
      // 3. Save Daily Report (Optimistic Mutation & Cache Invalidation)
      // ----------------------------------------------------
      case 'saveDailyReport': {
        const [form] = args || [];
        if (!form) {
          throw new Error("Missing form parameter");
        }
        const dateObj = new Date(form.date);
        const month = dateObj.getMonth() + 1;
        const year = dateObj.getFullYear();
        const timestamp = new Date().toISOString();

        for (const e of form.evaluations) {
          await db.execute({
            sql: `INSERT INTO "Reports Data" (
              report_date, month, year, period, department, inspector, supervisor, procedure, status, note, rec, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              form.date,
              month,
              year,
              form.period,
              form.department,
              form.inspector,
              form.supervisor,
              e.procedure,
              e.status,
              e.note || "",
              e.rec || "",
              timestamp
            ]
          });
        }

        // Optimistic in-memory mutation for dashboard metrics without re-reading from cloud DB
        const cachedDashboard = memoryCache.get<any[]>('dashboard:metrics');
        if (cachedDashboard) {
          const newEntries = form.evaluations.map((e: any) => ({
            date: form.date,
            dept: form.department,
            status: e.status
          }));
          memoryCache.set('dashboard:metrics', [...cachedDashboard, ...newEntries], 10 * 60 * 1000);
        }

        // Invalidate stale report caches so next periodic queries fetch fresh data
        memoryCache.invalidatePrefix('report:');
        
        data = { success: true };
        break;
      }

      // ----------------------------------------------------
      // 4. Governed Report Data Retrieval (No SELECT *, Strict Limits & Caching)
      // ----------------------------------------------------
      case 'getReportData': {
        const [filterType, filterValue] = args || [];
        
        // Construct unique cache key based on query parameters
        let cacheKey = `report:${filterType}:`;
        if (filterType === 'range' && filterValue) {
          cacheKey += `${filterValue.start}_${filterValue.end}`;
        } else {
          cacheKey += String(filterValue || 'all');
        }

        const cachedReport = memoryCache.get<any[][]>(cacheKey);
        if (cachedReport) {
          data = cachedReport;
          break;
        }

        // Structured query strictly selecting required columns (No SELECT *)
        let sql = `SELECT ${REPORT_COLUMNS} FROM "Reports Data"`;
        const sqlArgs: any[] = [];
        let queryLimit = 2500;

        if (filterType === 'daily') {
          sql += " WHERE report_date = ? ORDER BY id DESC LIMIT ?";
          sqlArgs.push(filterValue, 500);
        } else if (filterType === 'monthly') {
          const [y, m] = String(filterValue).split('-');
          sql += " WHERE year = ? AND month = ? ORDER BY report_date DESC, id DESC LIMIT ?";
          sqlArgs.push(Number(y), Number(m), 2500);
        } else if (filterType === 'yearly') {
          sql += " WHERE year = ? ORDER BY report_date DESC, id DESC LIMIT ?";
          sqlArgs.push(Number(filterValue), 5000);
        } else if (filterType === 'range' && filterValue) {
          sql += " WHERE report_date >= ? AND report_date <= ? ORDER BY report_date DESC, id DESC LIMIT ?";
          sqlArgs.push(filterValue.start, filterValue.end, 2500);
        } else {
          sql += " ORDER BY report_date DESC LIMIT ?";
          sqlArgs.push(queryLimit);
        }

        const result = await db.execute(sql, sqlArgs);
        data = result.rows.map(row => [
          row.report_date,
          row.month,
          row.year,
          row.period,
          row.department,
          row.inspector,
          row.supervisor,
          row.procedure,
          row.status,
          row.note || "",
          row.rec || "",
          row.timestamp
        ]);

        // Cache results with 10-minute TTL
        memoryCache.set(cacheKey, data, 10 * 60 * 1000);
        break;
      }

      // ----------------------------------------------------
      // 5. Governed Dashboard Metrics (In-Memory Cache & Strict LIMIT)
      // ----------------------------------------------------
      case 'getDashboardMetrics': {
        const cacheKey = 'dashboard:metrics';
        const cachedMetrics = memoryCache.get<any[]>(cacheKey);
        if (cachedMetrics) {
          data = cachedMetrics;
          break;
        }

        // Governed query with explicit columns and strict ceiling limit
        const result = await db.execute(
          'SELECT report_date, department, status FROM "Reports Data" ORDER BY report_date DESC LIMIT 5000'
        );
        data = result.rows.map(row => ({
          date: row.report_date,
          dept: row.department,
          status: row.status
        }));

        // Cache with 10-minute TTL
        memoryCache.set(cacheKey, data, 10 * 60 * 1000);
        break;
      }

      // ----------------------------------------------------
      // 6. Copy Monthly Report (Cache-Aside + Batch Write + Optimistic Mutation)
      // ----------------------------------------------------
      case 'copyMonthlyReport': {
        const [sourceMonth, targetMonth, replaceExisting = true] = args || [];
        const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

        if (!sourceMonth || !targetMonth || !monthRegex.test(String(sourceMonth)) || !monthRegex.test(String(targetMonth))) {
          throw new Error("يرجى تحديد الشهر المصدر والشهر الهدف بصيغة صحيحة (YYYY-MM)");
        }

        if (sourceMonth === targetMonth) {
          throw new Error("لا يمكن نسخ التقرير إلى نفس الشهر المصدر");
        }

        // 1. Read source month via Cache-Aside first (0 cloud reads on cache hit)
        const sourceCacheKey = `report:monthly:${sourceMonth}`;
        let sourceRows = memoryCache.get<any[][]>(sourceCacheKey);

        if (!sourceRows) {
          const [srcYear, srcMonth] = String(sourceMonth).split('-').map(Number);
          // Governed indexed query via idx_reports_year_month (No SELECT *, strict LIMIT)
          const srcResult = await db.execute(
            `SELECT ${REPORT_COLUMNS} FROM "Reports Data" WHERE year = ? AND month = ? ORDER BY report_date DESC, id DESC LIMIT ?`,
            [srcYear, srcMonth, 2500]
          );
          sourceRows = srcResult.rows.map(row => [
            row.report_date,
            row.month,
            row.year,
            row.period,
            row.department,
            row.inspector,
            row.supervisor,
            row.procedure,
            row.status,
            row.note || "",
            row.rec || "",
            row.timestamp
          ]);
          memoryCache.set(sourceCacheKey, sourceRows, 10 * 60 * 1000);
        }

        if (!sourceRows || sourceRows.length === 0) {
          throw new Error(`لا توجد بيانات مسجلة في شهر (${sourceMonth}) لنسخها`);
        }

        // 2. Remap dates safely to target year & month (clamping day to max days in target month)
        const [tgtYear, tgtMonth] = String(targetMonth).split('-').map(Number);
        const maxDayInTarget = new Date(tgtYear, tgtMonth, 0).getDate();
        const paddedTgtMonth = String(tgtMonth).padStart(2, '0');
        const timestamp = new Date().toISOString();

        const mappedTargetRows: any[][] = [];
        const statements: any[] = [];

        if (replaceExisting) {
          statements.push({
            sql: 'DELETE FROM "Reports Data" WHERE year = ? AND month = ?',
            args: [tgtYear, tgtMonth]
          });
        }

        for (const row of sourceRows) {
          const origDateParts = String(row[0] || '').split('-');
          const origDay = origDateParts.length === 3 ? (parseInt(origDateParts[2], 10) || 1) : 1;
          const safeDay = Math.min(Math.max(origDay, 1), maxDayInTarget);
          const newDateStr = `${tgtYear}-${paddedTgtMonth}-${String(safeDay).padStart(2, '0')}`;

          const newRow = [
            newDateStr,
            tgtMonth,
            tgtYear,
            row[3] !== undefined ? String(row[3]) : "",
            row[4] !== undefined ? String(row[4]) : "",
            row[5] !== undefined ? String(row[5]) : "",
            row[6] !== undefined ? String(row[6]) : "",
            row[7] !== undefined ? String(row[7]) : "",
            row[8] !== undefined ? String(row[8]) : "",
            row[9] !== undefined ? String(row[9]) : "",
            row[10] !== undefined ? String(row[10]) : "",
            timestamp
          ];

          mappedTargetRows.push(newRow);
          statements.push({
            sql: `INSERT INTO "Reports Data" (
              report_date, month, year, period, department, inspector, supervisor, procedure, status, note, rec, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: newRow
          });
        }

        // 3. Execute atomic/chunked batch write to cloud DB
        const chunkSize = 500;
        for (let i = 0; i < statements.length; i += chunkSize) {
          const chunk = statements.slice(i, i + chunkSize);
          await db.batch(chunk, "write");
        }

        // 4. Optimistic Cache Mutation (0 follow-up SELECT queries)
        const targetCacheKey = `report:monthly:${targetMonth}`;
        if (replaceExisting) {
          memoryCache.set(targetCacheKey, mappedTargetRows, 10 * 60 * 1000);
        } else {
          const existingTargetCache = memoryCache.get<any[][]>(targetCacheKey);
          if (existingTargetCache) {
            memoryCache.set(targetCacheKey, [...mappedTargetRows, ...existingTargetCache], 10 * 60 * 1000);
          } else {
            memoryCache.delete(targetCacheKey);
          }
        }

        // Optimistically update dashboard:metrics cache if warm
        const cachedDashboard = memoryCache.get<any[]>('dashboard:metrics');
        if (cachedDashboard) {
          const targetPrefix = `${tgtYear}-${paddedTgtMonth}-`;
          const baseDashboard = replaceExisting
            ? cachedDashboard.filter((item: any) => !String(item.date || '').startsWith(targetPrefix))
            : cachedDashboard;
          const newDashboardEntries = mappedTargetRows.map(r => ({
            date: r[0],
            dept: r[4],
            status: r[8]
          }));
          memoryCache.set('dashboard:metrics', [...newDashboardEntries, ...baseDashboard], 10 * 60 * 1000);
        }

        // Invalidate derived yearly, daily (for target month), and range caches
        memoryCache.delete(`report:yearly:${tgtYear}`);
        memoryCache.invalidatePrefix(`report:daily:${targetMonth}`);
        memoryCache.invalidatePrefix('report:range:');
        memoryCache.delete('report:undefined:all');

        data = {
          success: true,
          copiedCount: mappedTargetRows.length,
          sourceMonth,
          targetMonth,
          replaced: Boolean(replaceExisting),
          rows: mappedTargetRows
        };
        break;
      }

      // ----------------------------------------------------
      // 7. Cache Diagnostics & Governance Metrics
      // ----------------------------------------------------
      case 'getCacheMetrics': {
        data = memoryCache.getMetrics();
        break;
      }

      default: {
        return res.status(404).json({ success: false, error: `Method ${method} not found` });
      }
    }

    return res.json({ success: true, data });

  } catch (error: any) {
    console.error("[RPC API Error]:", error);
    return res.json({ success: false, error: error.message || "Unknown server-side error" });
  }
});

export default app;
