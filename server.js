/* 客服日回報系統 — 後端 + 主管彙整後台
 * 儲存：libsql（本機用 file:local.db；線上設 TURSO_DATABASE_URL 即用 Turso 雲端，永久保存）
 * 啟動：node server.js   （或 npm start）
 * 環境變數：PORT（預設 4322）、ADMIN_PASSWORD（預設 admin123）、TURSO_DATABASE_URL、TURSO_AUTH_TOKEN
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 4323;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// 本機沒設 Turso → 用 file:local.db（SQLite 檔）；線上設環境變數即用 Turso 雲端
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const TEMPLATE_FILE = path.join(PUBLIC, 'default-template.json');
async function initDB() {
  // 資料表名 cs_*，與直播版（submissions/config）不衝突，可安全共用同一個 Turso
  await db.execute(`CREATE TABLE IF NOT EXISTS cs_submissions (
    id TEXT PRIMARY KEY,
    pos TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    UNIQUE(name, pos, date)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS cs_config (key TEXT PRIMARY KEY, value TEXT)`);
  const t = await db.execute({ sql: 'SELECT value FROM cs_config WHERE key=?', args: ['template'] });
  if (!t.rows.length) {
    let def = '{}'; try { def = fs.readFileSync(TEMPLATE_FILE, 'utf8'); } catch (e) {}
    await db.execute({ sql: 'INSERT INTO cs_config (key,value) VALUES (?,?)', args: ['template', def] });
  }
}
async function getTemplate() {
  const r = await db.execute({ sql: 'SELECT value FROM cs_config WHERE key=?', args: ['template'] });
  if (r.rows.length) { try { return JSON.parse(r.rows[0].value); } catch (e) {} }
  try { return JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')); } catch (e) { return {}; }
}
async function saveTemplate(t) {
  await db.execute({ sql: 'INSERT INTO cs_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', args: ['template', JSON.stringify(t)] });
}

const sessions = new Set(); // in-memory admin tokens (reset on restart)

/* ---------- helpers ---------- */
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    // 收集 Buffer chunk，最後整體 UTF-8 解碼；不可用 d += c（會在 chunk 邊界把中文切半 → �）
    const chunks = []; let len = 0;
    req.on('data', c => { chunks.push(c); len += c.length; if (len > 2e6) req.destroy(); });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); } });
  });
}
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function isAdmin(req) { const c = cookies(req); return c.sid && sessions.has(c.sid); }
function csv(v) { v = (v == null ? '' : String(v)); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

async function listSubs(month, pos) {
  const conds = [], args = [];
  if (month) { conds.push('substr(date,1,7)=?'); args.push(month); }
  if (pos) { conds.push('pos=?'); args.push(pos); }
  let sql = 'SELECT id,payload,received_at FROM cs_submissions';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY date DESC, received_at DESC';
  const r = await db.execute({ sql, args });
  return r.rows.map(row => Object.assign({ id: row.id, receivedAt: row.received_at }, JSON.parse(row.payload)));
}

/* 月度彙總：每人一列（回報天數、各清單欄位件數、交辦完成率）
 * metrics.counts 以「欄位 id → 件數」記錄，欄位改名也不會壞（後台用範本對照 id→label） */
function summarize(subs) {
  const g = {};
  subs.forEach(s => {
    const k = s.name + '|' + s.pos;
    if (!g[k]) g[k] = { name: s.name, pos: s.pos, days: 0, counts: {}, tasks: 0, tasksDone: 0, escal: 0, trackOpen: 0 };
    const G = g[k]; G.days++;
    const m = s.metrics || {};
    const c = m.counts || {};
    for (const id in c) G.counts[id] = (G.counts[id] || 0) + (Number(c[id]) || 0);
    G.tasks += (Number(m.tasks) || 0);
    G.tasksDone += (Number(m.tasksDone) || 0);
    G.escal += (Number(m.escal) || 0);
    if (G.days === 1) G.trackOpen = Number(m.trackOpen) || 0; // subs 依日期新→舊，第一筆即該員最新的未結件數
  });
  return Object.values(g)
    .map(G => Object.assign(G, {
      taskRate: G.tasks ? Math.round(G.tasksDone / G.tasks * 100) : null
    }))
    .sort((a, b) => a.pos.localeCompare(b.pos) || a.name.localeCompare(b.name));
}

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, rel) {
  const p = path.join(PUBLIC, decodeURIComponent(rel === '/' ? '/index.html' : rel));
  if (!p.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(p, (e, d) => {
    if (e) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(d);
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pn = u.pathname;
  try {
    // 填寫者送出（送出即鎖定：同人同班同日只能送一次，之後由主管後台管理）
    if (pn === '/api/submit' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.pos || !b.name || !b.date) return send(res, 400, { error: '缺少必要欄位（班別/姓名/日期）' });
      const existing = await db.execute({ sql: 'SELECT id FROM cs_submissions WHERE name=? AND pos=? AND date=?', args: [b.name, b.pos, b.date] });
      if (existing.rows.length > 0) {
        return send(res, 409, { error: b.name + '（' + b.pos + '）' + b.date + ' 的回報已送出並鎖定，由主管後台統一管理。如需修改，請聯繫主管。', locked: true });
      }
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const receivedAt = new Date().toISOString();
      await db.execute({
        sql: 'INSERT INTO cs_submissions (id,pos,name,date,payload,received_at) VALUES (?,?,?,?,?,?)',
        args: [id, b.pos, b.name, b.date, JSON.stringify(b), receivedAt]
      });
      return send(res, 200, { ok: true, id });
    }

    // 回報表範本（填寫頁載入用，公開讀取）
    if (pn === '/api/template' && req.method === 'GET') {
      return send(res, 200, await getTemplate());
    }

    // 前台新增下拉選項（公開；追加到範本對應欄位的選項清單，所有人共用、持久保存）
    if (pn === '/api/option' && req.method === 'POST') {
      const b = await readBody(req);
      const fieldId = String(b.fieldId || ''); const value = String(b.value || '').trim();
      if (!fieldId || !value) return send(res, 400, { error: '缺少欄位或選項值' });
      const t = await getTemplate();
      const f = (t.fields || []).find(x => x.id === fieldId);
      if (!f) return send(res, 404, { error: '找不到欄位' });
      const ALLOWED = ['platformOptions', 'options', 'reasonOptions'];
      let key = String(b.key || '');
      if (!ALLOWED.includes(key)) key = (f.type === 'caselist' ? 'platformOptions' : 'options');
      f[key] = Array.isArray(f[key]) ? f[key] : [];
      if (!f[key].includes(value)) f[key].push(value);
      await saveTemplate(t);
      return send(res, 200, { ok: true, key, options: f[key] });
    }

    // 跨日帶入：回傳「指定日期之前最近一天」全隊仍標「持續追蹤」的追蹤件（公開讀取）
    if (pn === '/api/carryover' && req.method === 'GET') {
      const date = u.searchParams.get('date') || '';
      if (!date) return send(res, 400, { error: '缺少日期' });
      const prev = await db.execute({ sql: 'SELECT MAX(date) AS d FROM cs_submissions WHERE date < ?', args: [date] });
      const pd = prev.rows.length ? prev.rows[0].d : null;
      if (!pd) return send(res, 200, { date: null, items: [] });
      const tpl = await getTemplate();
      const trackIds = (tpl.fields || []).filter(f => f.type === 'tracklist' && f.carryover).map(f => f.id);
      const r = await db.execute({ sql: 'SELECT payload FROM cs_submissions WHERE date = ?', args: [pd] });
      const items = []; const seen = new Set();
      r.rows.forEach(row => {
        let p; try { p = JSON.parse(row.payload); } catch (e) { return; }
        trackIds.forEach(fid => {
          const arr = (p.fields || {})[fid];
          (Array.isArray(arr) ? arr : []).forEach(it => {
            if (!it || !(it.text || '').trim()) return;
            if (it.status === '已結案') return;
            const k = fid + '|' + it.text.trim();
            if (seen.has(k)) return; seen.add(k);
            items.push({ fieldId: fid, text: it.text.trim(), progress: (it.progress || '').trim() });
          });
        });
      });
      return send(res, 200, { date: pd, items });
    }

    // 主管登入 / 狀態 / 登出
    if (pn === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.password === ADMIN_PASSWORD) {
        const t = crypto.randomBytes(16).toString('hex'); sessions.add(t);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=' + t + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400' });
      }
      return send(res, 401, { error: '密碼錯誤' });
    }
    if (pn === '/api/admin/check') return send(res, 200, { isAdmin: isAdmin(req) });
    if (pn === '/api/admin/logout' && req.method === 'POST') { sessions.delete(cookies(req).sid); return send(res, 200, { ok: true }); }

    // 受保護的主管 API
    if (pn.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: '請先登入' });

      if (pn === '/api/admin/data') {
        const subs = await listSubs(u.searchParams.get('month'), u.searchParams.get('pos'));
        return send(res, 200, { submissions: subs, summary: summarize(subs) });
      }
      if (pn === '/api/admin/submission' && req.method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM cs_submissions WHERE id=?', args: [u.searchParams.get('id')] });
        return send(res, 200, { ok: true });
      }
      // 主管編輯回報表範本
      if (pn === '/api/admin/template' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b || typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.fields)) return send(res, 400, { error: '格式錯誤' });
        await saveTemplate(b);
        return send(res, 200, { ok: true });
      }
      if (pn === '/api/admin/export') {
        const m = u.searchParams.get('month');
        const tpl = await getTemplate();
        const fields = tpl.fields || [];
        const subs = (await listSubs(m, null)).sort((a, b) => a.date.localeCompare(b.date));
        const head = ['日期', '班別', '姓名'].concat(fields.map(f => f.label)).concat(['收到時間']);
        const rows = [head.map(csv).join(',')];
        subs.forEach(s => {
          const line = [s.date, s.pos, s.name];
          fields.forEach(f => line.push(flatten(f, (s.fields || {})[f.id])));
          line.push(s.receivedAt);
          rows.push(line.map(csv).join(','));
        });
        return send(res, 200, '﻿' + rows.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cs_report_' + (m || 'all') + '.csv"' });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (pn.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    serveStatic(res, pn);
  } catch (err) {
    console.error(err); send(res, 500, { error: '伺服器錯誤' });
  }
});

/* 把一個欄位的值攤平成 CSV 單格文字 */
function flatten(f, val) {
  if (val == null) return '';
  if (f.type === 'text') return String(val);
  if (f.type === 'select_text') return [val.option, val.text].filter(Boolean).join('：');
  if (f.type === 'list') return (Array.isArray(val) ? val : []).filter(Boolean).join(' ／ ');
  if (f.type === 'caselist') return (Array.isArray(val) ? val : []).map(c =>
    '[' + (c.platform || '') + ']' + (c.customer ? '【' + c.customer + '】' : '') + (c.reason ? '(' + c.reason + ')' : '') + (c.text || '') + (c.escalate ? '⚠需主管介入' : '')
  ).join(' ／ ');
  if (f.type === 'helplist') return (Array.isArray(val) ? val : []).map(h => (h.helper || '') + '→' + (h.helpee || '') + '：' + (h.text || '')).join(' ／ ');
  if (f.type === 'task_status') return (Array.isArray(val) ? val : []).map(t => (t.text || '') + '（' + (t.status || '') + (t.reason ? '：' + t.reason : '') + '）').join(' ／ ');
  if (f.type === 'tracklist') return (Array.isArray(val) ? val : []).map(t => (t.text || '') + (t.progress ? '｜進度：' + t.progress : '') + '（' + (t.status || '') + '）').join(' ／ ');
  return String(val);
}

initDB().then(() => {
  server.listen(PORT, () => {
    console.log('客服日回報系統   http://localhost:' + PORT);
    console.log('主管彙整後台     http://localhost:' + PORT + '/admin.html');
    console.log('儲存：' + (process.env.TURSO_DATABASE_URL ? 'Turso 雲端' : 'file:local.db（本機）'));
    console.log('（後台密碼預設 admin123，可用環境變數 ADMIN_PASSWORD 變更）');
  });
}).catch(err => { console.error('啟動失敗:', err); process.exit(1); });
