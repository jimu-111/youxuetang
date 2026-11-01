/**
 * 培训案例自动同步（2026-11-01 建）
 *
 * 数据源：飞书表 Id6OsBKpWhYJm8ti08acihZbnNh 的「培训案例」页签（dd29f7）
 *   表头按名字取：质检码 / 失误类别 / 问题点描述（兼容「问题描述」）/ 品类 /
 *                问题照片 / 应操作方向（兼容「正确方向」）/ 方向照片 / 方向示例照片
 *   「日期」「更新人」不导入（和页面手动导入的字段保持一致）。
 *
 * 目标：云端 app_data 的 manualCases（就是网页「案例库 → 📝 培训案例收集」那份数据）。
 *
 * 每周一、三、五、日 9:00（北京时间 = UTC 1:00）由 GitHub Actions 在云端跑：
 *   ① 读飞书表，按「质检码」整理成案例（重复码：第 1 条为准，空字段用后面的补）；
 *   ② 读云端 manualCases；
 *   ③ 逐条比对：
 *      - 表里新出现的质检码 → 新增；
 *      - 已有案例，表里哪一项变了 → 就用表里的（飞书优先）；
 *        表里没变的项 → 网页上手动改过的内容保留；
 *      - 表里没有、但上次是从飞书同步来的案例 → 删除；
 *      - 网页手动录入的案例（没有 _feishu 标记）永远不动；
 *   ④ 没变化 → 不写任何东西；有变化 → 写回云端并回读校验；
 *   ⑤ 有变化发一条飞书卡片，失败由工作流发红色告警卡片。
 *
 * 首次运行是「认领」：给现有案例打上 _feishu / _syncH 标记，不改任何内容；
 * 从第二次起才按「表里改了才更新」走。这样第一次不会把网页上手改过的内容冲掉。
 *
 * 安全闸门（宁可这轮不同步，也不要把坏数据推上去）：
 *   ① 表读不到 / 表头没有「质检码」/ 解析出 0 条 → 中止
 *   ② 案例数比上次从飞书同步来的少一半以上 → 中止（多半是表被改坏；FORCE=1 可越过）
 *   ③ 云端 manualCases 读不到 / 解析失败 → 中止（绝不能当成空数组，否则会整份重建）
 *   ④ 写入失败 / 写完回读不一致 → 退出码 1（工作流发告警）
 *
 * 手动用法：
 *   node case-sync.js                       # 正常同步
 *   DRY_RUN=1 node case-sync.js             # 只读演练：读表、对比、打印计划，不写任何东西
 *   FORCE=1 node case-sync.js               # 越过闸门②
 *   node case-sync.js --alert-only "消息"    # 只发飞书告警卡片
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGES = 'https://yxt-feishu.pages.dev';
const SECRET = 'yxt-feishu-2026';
const APP_ID = 'cli_aab1fa4e87bbdbd3';

const SHEET_TOKEN = 'Id6OsBKpWhYJm8ti08acihZbnNh';
const SHEET_ID = 'dd29f7';

const CLOUD_KEY = 'manualCases';
const FEISHU_MARK = '_feishu';   // 1 = 这条是从飞书表同步来的（删除只认这个标记）
const HASH_FIELD = '_syncH';     // 上一次从表里看到的各字段指纹

const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === 'true' || process.env.FORCE === '1';
const RUN_URL = process.env.RUN_URL || '';
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'xuhang02@zhuanzhuan.com';

// 应用密钥不写进本文件（仓库是公开的）。取值顺序：① Actions Secrets 注入的环境变量 ② 本机密钥文件（不进仓库）。
const APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
  try { return fs.readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();

// Supabase 地址/密钥直接从仓库里的 index.html 读（本来就是公开在前端页面里的），
// 也可以用环境变量覆盖。绝不在这里写死新的密钥。
const SUPABASE_URL = process.env.SUPABASE_URL || (function () {
  try {
    const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    return (page.match(/const SUPABASE_URL = '([^']+)'/) || [])[1] || '';
  } catch (e) { return ''; }
})();
const SUPABASE_KEY = process.env.SUPABASE_KEY || (function () {
  try {
    const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    return (page.match(/const SUPABASE_KEY = '([^']+)'/) || [])[1] || '';
  } catch (e) { return ''; }
})();

// ---------------- 通用网络 ----------------
function requestJson(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({}, (opts && opts.headers) || {});
    const body = opts && opts.body;
    if (body && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET',
      headers
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        raw: d,
        json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })()
      }));
    });
    req.on('error', reject);
    req.setTimeout((opts && opts.timeout) || 60000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function viaProxy(targetPath, auth, extra) {
  const headers = {
    'x-target-url': 'https://open.feishu.cn/open-apis' + targetPath,
    'x-target-auth': 'Bearer ' + auth,
    'x-target-method': (extra && extra.method) || 'GET'
  };
  if (extra && extra.body) headers['x-target-content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const u = new URL(PAGES);
    const body = (extra && extra.body) || undefined;
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        raw: d,
        json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })()
      }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('代理请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

// ---------------- 飞书身份 ----------------
let TENANT = null;
async function getTenantToken() {
  if (TENANT && TENANT.exp > Date.now()) return TENANT.token;
  const r = await viaProxy('/auth/v3/tenant_access_token/internal', '', {
    method: 'POST',
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  if (!r.json || r.json.code !== 0 || !r.json.tenant_access_token) {
    throw new Error('tenant_access_token 获取失败: ' + r.status + ' ' + String(r.raw).slice(0, 200));
  }
  TENANT = { token: r.json.tenant_access_token, exp: Date.now() + (r.json.expire || 7200) * 1000 - 300000 };
  return TENANT.token;
}

let USER = null;
async function getUserToken() {
  if (USER) return USER;
  const kv = await requestJson(PAGES + '/token', { headers: { 'x-yxt-secret': SECRET } });
  let stored = kv.json && kv.json.value;
  if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch (e) { stored = null; } }
  if (stored && stored.access_token) USER = stored;
  return USER;
}

// 优先应用身份（凭据不过期），失败回退用户 token（只读，不需要刷新）
async function api(path, extra) {
  try {
    const at = await getTenantToken();
    const ra = await viaProxy(path, at, extra);
    if (ra.json && ra.json.code === 0) return ra;
    console.log('  ⚠️ 应用身份返回 code=' + (ra.json && ra.json.code) + '（' + ((ra.json && ra.json.msg) || '') + '），回退用户 token');
  } catch (e) {
    console.log('  ⚠️ 应用身份不可用：' + e.message + '，回退用户 token');
  }
  const u = await getUserToken();
  if (!u) throw new Error('应用身份与用户 token 均不可用');
  const r = await viaProxy(path, u.access_token, extra);
  if (!r.json || r.json.code !== 0) throw new Error('飞书接口失败: ' + r.status + ' ' + String(r.raw).slice(0, 200));
  return r;
}

// ---------------- 表格解析 ----------------
function cellText(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c.trim();
  if (typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object') ? (x.text || '') : String(x || '')).join('').trim();
  if (typeof c === 'object') return String(c.text || '').trim();
  return '';
}

function cellTokens(c) {
  const list = Array.isArray(c) ? c : (c ? [c] : []);
  const out = [];
  for (const x of list) {
    if (x && typeof x === 'object') {
      const t = x.fileToken || x.file_token;
      if (t) out.push({ t });
    }
  }
  return out;
}

// 字段定义：key = 网页案例里的字段名；names = 表头列名（按顺序取第一个非空的）
const FIELD_DEFS = [
  { key: 'errorCategory',    names: ['失误类别'] },
  { key: 'issueDesc',        names: ['问题点描述', '问题描述'] },
  { key: 'issuePhotos',      names: ['问题照片'], img: true },
  { key: 'correctDir',       names: ['应操作方向', '正确方向'] },
  { key: 'dirPhotos',        names: ['方向照片'], img: true },
  { key: 'dirExamplePhotos', names: ['方向示例照片'], img: true },
  { key: 'productCategory',  names: ['品类'] }
];
const ALL_FIELDS = FIELD_DEFS.map(d => d.key);
const TEXT_FIELDS = FIELD_DEFS.filter(d => !d.img).map(d => d.key);
const IMG_FIELDS = FIELD_DEFS.filter(d => d.img).map(d => d.key);

function buildColMap(headerRow) {
  const col = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = cellText(headerRow[i]);
    if (h) col[h] = i;
  }
  return col;
}

function cellAny(row, col, names) {
  for (const n of names) {
    const idx = col[n];
    if (idx === undefined) continue;
    const v = cellText(row[idx]);
    if (v) return v;
  }
  return '';
}

function extractFields(row, col) {
  const out = {};
  for (const d of FIELD_DEFS) {
    if (d.img) {
      let arr = [];
      for (const n of d.names) {
        const idx = col[n];
        if (idx === undefined) continue;
        const v = cellTokens(row[idx]);
        if (v.length) { arr = v; break; }
      }
      out[d.key] = arr;
    } else {
      out[d.key] = cellAny(row, col, d.names);
    }
  }
  return out;
}

function parseCaseRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { cases: [], dup: [], rowCount: 0, col: {} };
  const col = buildColMap(rows[0]);
  if (col['质检码'] === undefined) {
    throw new Error('表头里找不到「质检码」列，本轮不写入（请检查表头是否被改过）');
  }
  const byCode = new Map();
  const order = [];
  const dupCount = {};
  let rowCount = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const code = cellText(row[col['质检码']]);
    if (!code) continue;
    rowCount++;
    const fields = extractFields(row, col);
    if (byCode.has(code)) {
      dupCount[code] = (dupCount[code] || 1) + 1;
      // 和页面手动导入一致：第 1 条为准，只补空着的字段
      const prev = byCode.get(code);
      for (const k of TEXT_FIELDS) if (!prev[k] && fields[k]) prev[k] = fields[k];
      for (const k of IMG_FIELDS) if ((!prev[k] || prev[k].length === 0) && fields[k].length) prev[k] = fields[k];
      continue;
    }
    const c = Object.assign({ qcCode: code }, fields, { caseType: '培训案例' });
    byCode.set(code, c);
    order.push(code);
  }

  const dup = Object.keys(dupCount).map(code => ({ code, rows: dupCount[code] }));
  return {
    cases: order.map(code => byCode.get(code)),
    dup,
    rowCount,
    col
  };
}

// ---------------- 指纹 / 合并 ----------------
function fieldHash(v) {
  return crypto.createHash('sha1').update(JSON.stringify(v === undefined ? '' : v)).digest('hex').slice(0, 10);
}

function fieldHashes(c) {
  const h = {};
  for (const k of ALL_FIELDS) h[k] = fieldHash(c[k]);
  return h;
}

// 网页里合法的「培训案例」（兼容历史上被编码损坏的「培训案��」这类值）
function isTrainingCase(c) {
  const t = String((c && c.caseType) || '');
  return !t || t.indexOf('培训案') === 0;
}

function findCaseIndex(cases, code) {
  let fallback = -1;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c || c.qcCode !== code) continue;
    if (c[FEISHU_MARK] === 1 || isTrainingCase(c)) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

/**
 * 把表里的案例合并进云端数组。
 * 返回 { cases, changed, added, updatedCases, updatedFields, deleted, adopted,
 *        addedCodes, updatedCodes, deletedCodes, warnings }
 */
function mergeCases(cloudCases, tableCases) {
  const result = (Array.isArray(cloudCases) ? cloudCases : [])
    .filter(c => c && typeof c === 'object')
    .map(c => Object.assign({}, c));

  const tableCodes = new Set(tableCases.map(t => t.qcCode));
  const addedCodes = [];
  const updatedCodes = [];
  const deletedCodes = [];
  const warnings = [];
  let added = 0, updatedCases = 0, updatedFields = 0, deleted = 0, adopted = 0;

  // 1) 删除：只删「上次从飞书同步来的」且表里已经没有的
  for (let i = result.length - 1; i >= 0; i--) {
    const c = result[i];
    if (!c || c[FEISHU_MARK] !== 1) continue;
    if (!tableCodes.has(c.qcCode)) {
      result.splice(i, 1);
      deleted++;
      deletedCodes.push(c.qcCode);
    }
  }

  // 2) 逐条处理表里的案例
  for (const t of tableCases) {
    const idx = findCaseIndex(result, t.qcCode);
    const curH = fieldHashes(t);

    if (idx < 0) {
      // 新案例：和页面手动导入一样放到最前面
      const newCase = Object.assign({}, t, {
        caseType: '培训案例',
        createTime: Date.now(),
        [FEISHU_MARK]: 1,
        [HASH_FIELD]: curH
      });
      result.unshift(newCase);
      added++;
      addedCodes.push(t.qcCode);
      continue;
    }

    const c = result[idx];
    if (c[FEISHU_MARK] !== 1 && !isTrainingCase(c)) {
      warnings.push('质检码 ' + t.qcCode + ' 在网页上已存在为「' + (c.caseType || '其他') + '」，未改动');
      continue;
    }

    if (c[FEISHU_MARK] !== 1) {
      // 首次运行「认领」：只打标记，不改内容
      c[FEISHU_MARK] = 1;
      c[HASH_FIELD] = curH;
      adopted++;
      continue;
    }

    const oldH = (c[HASH_FIELD] && typeof c[HASH_FIELD] === 'object') ? c[HASH_FIELD] : null;
    if (!oldH) {
      // 有标记但没有指纹（理论上不该出现）：按认领处理，不覆盖内容
      c[HASH_FIELD] = curH;
      adopted++;
      continue;
    }

    const changedFields = [];
    for (const k of ALL_FIELDS) {
      if (oldH[k] !== curH[k]) {
        c[k] = t[k];
        changedFields.push(k);
      }
    }
    c[HASH_FIELD] = curH;
    if (changedFields.length) {
      updatedCases++;
      updatedFields += changedFields.length;
      updatedCodes.push(t.qcCode);
    }
  }

  return {
    cases: result,
    changed: (added + updatedCases + deleted + adopted) > 0,
    added,
    updatedCases,
    updatedFields,
    deleted,
    adopted,
    addedCodes,
    updatedCodes,
    deletedCodes,
    warnings
  };
}

function checkGates(cloudCases, tableCases, force) {
  if (!Array.isArray(tableCases) || tableCases.length === 0) {
    throw new Error('表里读不到任何带质检码的案例（0 条），本轮不写入。请检查表格是否被清空、表头是否被改过');
  }
  const prevFeishu = (Array.isArray(cloudCases) ? cloudCases : []).filter(c => c && c[FEISHU_MARK] === 1).length;
  if (!force && prevFeishu >= 4 && tableCases.length < prevFeishu * 0.5) {
    throw new Error('表里的案例从 ' + prevFeishu + ' 条掉到 ' + tableCases.length + ' 条（少了一半以上），多半是表被改坏。本轮不写入；确认无误可用 FORCE=1 强制同步');
  }
}

// ---------------- 云端（Supabase app_data） ----------------
function supabaseHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY
  }, extra || {});
}

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('没有读到 Supabase 地址/密钥（缺 index.html 或环境变量 SUPABASE_URL/SUPABASE_KEY）');
  }
}

async function readCloudManualCases() {
  assertSupabaseConfig();
  const r = await requestJson(
    SUPABASE_URL + '/rest/v1/app_data?select=value,updated_at&key=eq.' + encodeURIComponent(CLOUD_KEY) + '&limit=1',
    { headers: supabaseHeaders() }
  );
  if (r.status !== 200) {
    throw new Error('读取云端培训案例失败：HTTP ' + r.status + ' ' + String(r.raw).slice(0, 200));
  }
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row) return { cases: [], rawValue: null, updatedAt: null, exists: false };
  let arr;
  try { arr = JSON.parse(row.value); } catch (e) {
    throw new Error('云端培训案例不是合法 JSON，本轮不写入：' + e.message);
  }
  if (!Array.isArray(arr)) throw new Error('云端培训案例不是数组，本轮不写入');
  return { cases: arr, rawValue: row.value, updatedAt: row.updated_at, exists: true };
}

async function writeCloudManualCases(value) {
  assertSupabaseConfig();
  const body = JSON.stringify({ key: CLOUD_KEY, value: value, updated_at: new Date().toISOString() });
  const r = await requestJson(SUPABASE_URL + '/rest/v1/app_data', {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    }),
    body,
    timeout: 90000
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error('写入云端培训案例失败：HTTP ' + r.status + ' ' + String(r.raw).slice(0, 300));
  }
}

// ---------------- 飞书告警卡片 ----------------
async function sendCard(title, msg, color) {
  if (process.env.NO_CARD === '1') { console.log('📨（NO_CARD=1，未发送飞书卡片）'); return; }
  try {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: title }, template: color || 'red' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: msg } }]
        .concat(RUN_URL ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📋 查看日志' }, type: 'primary', url: RUN_URL }] }] : [])
    };
    const r = await api('/im/v1/messages?receive_id_type=email', {
      method: 'POST',
      body: JSON.stringify({ receive_id: REPORT_EMAIL, msg_type: 'interactive', content: JSON.stringify(card) })
    });
    if (!r.json || r.json.code !== 0) throw new Error('HTTP ' + r.status + ' ' + String(r.raw).slice(0, 200));
    console.log('📨 飞书卡片已发送');
  } catch (e) {
    console.log('⚠️ 飞书卡片发送失败: ' + e.message);
  }
}

// ---------------- 主流程 ----------------
async function readCaseTable() {
  const r = await api('/sheets/v2/spreadsheets/' + SHEET_TOKEN + '/values/' + SHEET_ID + '?majorDimension=ROWS');
  const rows = (r.json && r.json.data && r.json.data.valueRange && r.json.data.valueRange.values) || [];
  console.log('📖 表里读到 ' + rows.length + ' 行（含表头和空行）');
  return rows;
}

function listCodes(arr, max) {
  const m = max || 20;
  const s = arr.slice(0, m).join('、');
  return arr.length > m ? s + ' …等 ' + arr.length + ' 条' : s;
}

function buildCardMessage(merged, dup, firstRun) {
  const lines = [];
  if (firstRun) lines.push('首次同步：认领 **' + merged.adopted + '** 条现有案例（内容未改）');
  if (merged.added) lines.push('新增 **' + merged.added + '** 条：' + listCodes(merged.addedCodes, 10));
  if (merged.updatedCases) lines.push('更新 **' + merged.updatedCases + '** 条：' + listCodes(merged.updatedCodes, 10));
  if (merged.deleted) lines.push('删除 **' + merged.deleted + '** 条：' + listCodes(merged.deletedCodes, 10));
  if (!lines.length) lines.push('内容和上次一致，没有变化');
  lines.push('');
  lines.push('规则：表里改了哪项就用表里的；网页手动改过、表里没变的项保留；手动录入的案例不动。');
  if (dup && dup.length) {
    const slash = dup.filter(d => d.code === '/').reduce((n, d) => n + d.rows, 0);
    let warn = '⚠️ 表里有 ' + dup.length + ' 个质检码重复';
    if (slash) warn += '（其中「/」占 ' + slash + ' 行，只能保留第 1 条）';
    warn += '；重复码按第 1 条为准、空字段用后面的补。';
    lines.push(warn);
  }
  if (merged.warnings && merged.warnings.length) {
    lines.push('⚠️ ' + merged.warnings.slice(0, 5).join('；') + (merged.warnings.length > 5 ? ' …' : ''));
  }
  return lines.join('\n');
}

async function main() {
  console.log('=== 培训案例自动同步 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' ===');
  if (DRY_RUN) console.log('🔍 DRY_RUN：只读演练，不会写任何东西');

  const rows = await readCaseTable();
  const parsed = parseCaseRows(rows);
  console.log('📋 表里有效案例：' + parsed.cases.length + ' 条（去重后；原始 ' + parsed.rowCount + ' 行）');
  if (parsed.dup.length) {
    console.log('ℹ️ 重复质检码 ' + parsed.dup.length + ' 个：' + parsed.dup.map(d => d.code + '×' + d.rows).slice(0, 20).join('、') + (parsed.dup.length > 20 ? ' …' : ''));
  }

  const cloud = await readCloudManualCases();
  console.log('☁️ 云端现有案例：' + cloud.cases.length + ' 条' + (cloud.exists ? '' : '（云端还没有这一行，将新建）'));

  checkGates(cloud.cases, parsed.cases, FORCE);

  const prevFeishu = cloud.cases.filter(c => c && c[FEISHU_MARK] === 1).length;
  const merged = mergeCases(cloud.cases, parsed.cases);
  const firstRun = prevFeishu === 0 && merged.adopted > 0;

  console.log('\n—— 本次计划 ——');
  console.log('  新增：' + merged.added + (merged.added ? '（' + listCodes(merged.addedCodes) + '）' : ''));
  console.log('  更新：' + merged.updatedCases + (merged.updatedCases ? '（' + listCodes(merged.updatedCodes) + '）' : ''));
  console.log('  删除：' + merged.deleted + (merged.deleted ? '（' + listCodes(merged.deletedCodes) + '）' : ''));
  console.log('  认领：' + merged.adopted);
  if (merged.warnings.length) merged.warnings.forEach(w => console.log('  ⚠️ ' + w));

  if (!merged.changed) {
    console.log('\n✅ 内容和上次一致，不用更新（只比对，没有写任何东西）');
    return { changed: false };
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY_RUN：检测到变化，但只是演练，没有写入云端');
    return { changed: true, dryRun: true, merged };
  }

  const value = JSON.stringify(merged.cases);
  const sizeKB = (Buffer.byteLength(value) / 1024).toFixed(1);
  console.log('\n💾 写入云端 ' + CLOUD_KEY + '（' + merged.cases.length + ' 条，' + sizeKB + 'KB）...');
  await writeCloudManualCases(value);

  const back = await readCloudManualCases();
  if (back.rawValue !== value) {
    throw new Error('写完回读校验不一致（云端那份和本次结果对不上），请检查');
  }
  console.log('✅ 回读校验通过');

  await sendCard(
    firstRun ? '✅ 培训案例自动同步已启用' : '✅ 培训案例已自动更新',
    buildCardMessage(merged, parsed.dup, firstRun),
    'green'
  );
  return { changed: true, merged };
}

// ---------------- 入口 ----------------
module.exports = {
  cellText, cellTokens, buildColMap, extractFields, parseCaseRows,
  fieldHash, fieldHashes, isTrainingCase, mergeCases, checkGates,
  CLOUD_KEY, FEISHU_MARK, HASH_FIELD
};

if (require.main === module) {
  const ARGV = process.argv.slice(2);
  if (ARGV[0] === '--alert-only') {
    sendCard('❌ 培训案例自动同步未完成', ARGV[1] || '（无详情）', 'red').then(() => process.exit(0));
  } else {
    main().then(() => process.exit(0)).catch(e => {
      console.log('\n❌ ' + (e && e.message || e));
      process.exit(1);
    });
  }
}
