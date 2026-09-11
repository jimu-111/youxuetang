/**
 * 源1 → 源2 每周对账同步（qb-source-sync.js，2026-09-11 建）
 *
 * 用途：每周（GitHub Actions 周一，跑在题库同步之前）把「源1」（人工维护的 wiki 题库表）
 *       以源1为准同步到「源2」（优学堂题库的源文档）——新增 / 修改 / 删除（含图片），
 *       完成后发飞书卡片汇报。
 *
 * 身份（关键）：
 *   - 源1 读取 = 徐行 user token（存 CF KV；过期用 refresh_token 换新并写回 KV）
 *   - 源2 读写 = 优学堂应用 token（tenant_access_token，app_id/app_secret 必须 snake_case）
 *   ⚠️ 代理线路（yxt-feishu.pages.dev）只转发 POST 的 body，DELETE/PUT 的 body 会被丢掉
 *      → 默认直连 open.feishu.cn，代理仅作 GET/POST 的降级线路；删行/写图绝不走代理。
 *
 * 安全阀（写前拦截，绝不误清源2）：
 *   - 源1 读失败 / 0 行 / 比上次骤降 → 在第一次写入前中止
 *   - 源2 读成空 → 中止（ALLOW_EMPTY_DEST=1 例外，首次空表用）
 *   - 删除量超阈值 → 中止（FORCE=true 例外）
 *   - 无「题目ID」且无「题目」的行：源1 侧跳过并告警，源2 侧永不删除
 *
 * 用法：
 *   node qb-source-sync.js                       # 正式同步
 *   DRY_RUN=true node qb-source-sync.js          # 只读演练（不写任何东西）
 *   LIMIT=20 ALLOW_EMPTY_DEST=1 node ...         # 只处理源1 前 20 行（沙箱表验证用）
 *   node qb-source-sync.js --rollback-from kv:qb_src_backup_laptop_20260914 [--dry-run]
 *   node qb-source-sync.js --alert-only "消息"    # 只发飞书卡片（workflow 兜底告警用）
 */
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// ===================== 配置 =====================
const PAGES = 'https://yxt-feishu.pages.dev';
const SECRET = 'yxt-feishu-2026';
const APP_ID = 'cli_aab1fa4e87bbdbd3';
const APP_SECRET = '1uLKmOkzQpoac6Ixw3Qhsb6KR1gCrcTn';
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'xuhang02@zhuanzhuan.com';

// 配对表（key 只能含字母/数字/下划线——CF KV key 规则；新增配对只加一条）
//   src: 源1（wiki 内表格 obj_token；alt 为备用 token，读不通时依次尝试）
//   dst: 源2（优学堂题库源文档）
const PAIRS = [
  // key 只能含字母/数字/下划线（CF KV key 规则）；src.ss 可直接写 wiki 节点 token（脚本自动解析 obj_token）
  { key: 'laptop', name: '笔记本',
    src: { ss: 'WVf0smthLhX0qZtLeVdcVlcenhc', alt: ['VcVqwKXQ5iaZbWkOlpMc3ru3nXg'], sheet: '2YvJVj', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheet: 'TsPnkN', sheetTitle: '笔记本' } },
  { key: 'earphone', name: '耳机',
    src: { ss: 'ZLwkwEKqGilugAkGeJgcTBbBnMh', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheetTitle: '耳机' } },
  { key: 'tablet', name: '平板',
    src: { ss: 'CjkHw04iPiW6pykjS3zc55YxnOf', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheetTitle: '平板' } },
  { key: 'watch', name: '手表',
    src: { ss: 'I2Mewo43ii2QGEkDxKTcRArLnMc', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheetTitle: '手表' } },
  { key: 'phone', name: '手机',
    src: { ss: 'Vlauw8ek1iW2PFkXJ4scBtT6nqg', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheetTitle: '手机' } },
  { key: 'camera', name: '相机&镜头',
    src: { ss: 'Ob4hw5Zf6iPeR4kGuSbc8qCPnWf', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheetTitle: '相机&镜头' } },
  { key: 'console', name: '游戏机&游戏卡带',
    src: { ss: 'EOhFwnu6SiYiTrkZt92ckiM5nVf', sheetTitle: '题库' },
    dst: { ss: 'BzG8s8py3hDZIvtUJl7cRXJXnfe', sheetTitle: '游戏机&游戏卡带' } }
];

// 沙箱/临时验证用：环境变量可覆盖第一对的源/目标表（不改配置）
if (process.env.SRC_SS || process.env.SRC_SHEET || process.env.DST_SS || process.env.DST_SHEET) {
  const p = PAIRS[0];
  if (process.env.PAIR_KEY) p.key = process.env.PAIR_KEY;   // 沙箱验证用，隔离 KV 备份/状态键
  if (process.env.SRC_SS) p.src.ss = process.env.SRC_SS;
  if (process.env.SRC_SHEET) { p.src.sheet = process.env.SRC_SHEET; p.src.sheetTitle = ''; }
  if (process.env.DST_SS) p.dst.ss = process.env.DST_SS;
  if (process.env.DST_SHEET) { p.dst.sheet = process.env.DST_SHEET; p.dst.sheetTitle = ''; }
  console.log('⚠️ 配对目标被环境变量覆盖：源 ' + p.src.ss.slice(0, 10) + '…/' + p.src.sheet + ' → 目标 ' + p.dst.ss.slice(0, 10) + '…/' + p.dst.sheet);
}

const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === 'true' || process.env.FORCE === '1';
const ONLY_MONDAY = process.env.ONLY_MONDAY === 'true';
const ALLOW_EMPTY_DEST = process.env.ALLOW_EMPTY_DEST === '1' || process.env.ALLOW_EMPTY_DEST === 'true';
const LIMIT = parseInt(process.env.LIMIT || '0', 10) || 0;              // 只处理源1 前 N 行（沙箱验证）
const MIN_SRC_ROWS = parseInt(process.env.MIN_SRC_ROWS || '50', 10) || 50;
const MAX_DELETE_RATIO = 0.3;
const IGNORE_COLUMNS = (process.env.IGNORE_COLUMNS || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
const RUN_URL = process.env.RUN_URL || '';
const BACKUP_IMAGES = process.env.BACKUP_IMAGES !== 'false';             // 覆盖图片前留底（默认开）
const BACKUP_IMAGE_MAX_MB = parseInt(process.env.BACKUP_IMAGE_MAX_MB || '40', 10) || 40;

// ===================== 工具 =====================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = (d) => { const x = d || new Date(); return x.getFullYear() + String(x.getMonth() + 1).padStart(2, '0') + String(x.getDate()).padStart(2, '0'); };
const bjNow = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

function httpsRequest(url, opt) {
  const o = opt || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({}, o.headers || {});
    // ⚠️ 必须显式带 Content-Length：Node 默认 chunked，飞书 DELETE 接口读不到 body
    //（删行会报 9499 Missing required parameter: dimension）——2026-09-11 实测踩坑
    if (o.body) headers['Content-Length'] = Buffer.byteLength(o.body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: o.method || 'GET',
      headers: headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(o.timeout || 60000, () => req.destroy(new Error('请求超时')));
    if (o.body) req.write(o.body);
    req.end();
  });
}

function viaProxy(targetPath, auth, extra) {
  const e = extra || {};
  const headers = {
    'x-target-url': 'https://open.feishu.cn/open-apis' + targetPath,
    'x-target-auth': auth ? 'Bearer ' + auth : '',
    'x-target-method': e.method || 'GET'
  };
  if (e.body) headers['x-target-content-type'] = 'application/json';
  return httpsRequest(PAGES, { method: 'POST', headers, body: e.body || undefined, timeout: 45000 });
}

// 飞书 API：直连优先，网络层失败时降级代理（仅 GET/POST——代理不转发 DELETE/PUT 的 body）
async function feishu(path, opt) {
  const o = opt || {};
  const method = o.method || 'GET';
  const body = o.body ? (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : undefined;
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (o.token) headers['Authorization'] = 'Bearer ' + o.token;
  try {
    return await httpsRequest('https://open.feishu.cn/open-apis' + path, { method, headers, body });
  } catch (e) {
    if (method === 'GET' || method === 'POST') {
      console.log('  ⚠️ 直连失败（' + e.message + '），降级代理线路…');
      return await viaProxy(path, o.token, { method, body });
    }
    throw new Error('直连失败且 ' + method + ' 不走代理: ' + e.message);
  }
}

function checkOk(r, what) {
  if (!r || r.status !== 200 || !r.json || r.json.code !== 0) {
    const detail = r && r.json ? ('code=' + r.json.code + ' msg=' + (r.json.msg || '')) : ('HTTP ' + (r ? r.status : '?'));
    throw new Error(what + ' 失败: ' + detail);
  }
  return r.json.data;
}

// ===================== token =====================
let USER_TOKEN = null;   // 徐行（源1 只读）
let APP_TOKEN = null;    // 应用（源2 读写 + 发消息）

async function loadUserToken() {
  const kv = await httpsRequest(PAGES + '/token', { headers: { 'x-yxt-secret': SECRET } });
  let stored = kv.json && kv.json.value;
  if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch (e) { stored = null; } }
  if (!stored || !stored.access_token) throw new Error('KV 里没有飞书 token（需徐行账号在页面重新授权一次）');
  USER_TOKEN = stored;
  const owner = stored.owner || '(未知)';
  const exp = stored.expiresAt ? new Date(stored.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '(未知)';
  console.log('✅ 徐行 token 就绪：owner=' + owner + '，到期 ' + exp);
  if (String(owner).indexOf('徐行') < 0) console.log('⚠️ 云端 token 的 owner 不是徐行，源1 可能读不到（继续尝试）');
  return USER_TOKEN;
}

// 刷新 user_access_token 必须用 app_access_token 做 Authorization（不是 tenant_access_token，也不是 body 里传 app_id）
async function getAppAccessToken() {
  const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  let r;
  try {
    r = await httpsRequest('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  } catch (e) {
    r = await viaProxy('/auth/v3/app_access_token/internal', '', { method: 'POST', body });
  }
  if (!r.json || r.json.code !== 0 || !r.json.app_access_token) throw new Error('app_access_token 获取失败: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
  return r.json.app_access_token;
}
async function refreshUserToken() {
  const rt = USER_TOKEN && USER_TOKEN.refresh_token;
  if (!rt) throw new Error('无 refresh_token，无法刷新（需徐行重新授权）');
  console.log('  🔄 徐行 token 失效，用 refresh_token 换新…');
  const aat = await getAppAccessToken();
  const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aat };
  let r;
  try {
    r = await httpsRequest('https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token', { method: 'POST', headers, body });
  } catch (e) {
    r = await viaProxy('/authen/v1/oidc/refresh_access_token', aat, { method: 'POST', body });
  }
  if (!r.json || r.json.code !== 0 || !r.json.data) throw new Error('刷新失败: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
  const d = r.json.data;
  // 保留 owner 等原字段：页面靠 owner 判断是否上云、靠 expiresAt 决定是否自动刷新
  USER_TOKEN = Object.assign({}, USER_TOKEN, {
    access_token: d.access_token,
    refresh_token: d.refresh_token || USER_TOKEN.refresh_token,
    expiresAt: Date.now() + (d.expires_in || 7200) * 1000
  });
  try {
    const w = await httpsRequest(PAGES + '/token', { method: 'POST', headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(USER_TOKEN) });
    console.log(w.status === 200 ? '  ✅ 新 token 已写回 KV（永不断链）' : '  ⚠️ 新 token 写回 KV 失败 HTTP ' + w.status);
  } catch (e) { console.log('  ⚠️ 新 token 写回 KV 失败（不影响本次运行）'); }
  return USER_TOKEN;
}

// 已知「源1 这张图 == 源2 这张图」的令牌对缓存：源1/源2 的 fileToken 天然不同，
// 不缓存的话每周都要下载全部图片做 MD5 比对（实测 380 张 / 6 分钟）
let IMG_PAIR_CACHE = {};
let IMG_PAIR_DIRTY = false;
async function loadImgPairCache(pairKey) {
  IMG_PAIR_CACHE = {}; IMG_PAIR_DIRTY = false;   // 必须先清空：否则该对首次运行会把上一对的条目带进来
  try { const raw = await kvGet('qb_src_imgmap_' + pairKey); if (raw) IMG_PAIR_CACHE = JSON.parse(raw) || {}; } catch (e) { IMG_PAIR_CACHE = {}; }
  console.log('🧠 图片令牌对缓存：' + Object.keys(IMG_PAIR_CACHE).length + ' 组');
}
async function saveImgPairCache(pairKey) {
  if (!IMG_PAIR_DIRTY) return;
  try {
    let keys = Object.keys(IMG_PAIR_CACHE);
    if (keys.length > 3000) { const cut = keys.slice(keys.length - 3000); const o = {}; cut.forEach(k => o[k] = 1); IMG_PAIR_CACHE = o; }
    await kvPost([{ key: 'qb_src_imgmap_' + pairKey, v: JSON.stringify(IMG_PAIR_CACHE), t: new Date().toISOString() }]);
    console.log('🧠 图片令牌对缓存已更新（' + Object.keys(IMG_PAIR_CACHE).length + ' 组）');
  } catch (e) {}
}

async function apiAsUser(path, opt) {
  if (!USER_TOKEN) await loadUserToken();
  let r = await feishu(path, Object.assign({}, opt, { token: USER_TOKEN.access_token }));
  if (r.status === 401 || (r.json && (r.json.code === 99991663 || r.json.code === 99991661))) {
    await refreshUserToken();
    r = await feishu(path, Object.assign({}, opt, { token: USER_TOKEN.access_token }));
  }
  return r;
}

async function getAppToken() {
  if (APP_TOKEN) return APP_TOKEN;
  const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  let d = null;
  try {
    const r = await httpsRequest('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    d = r.json;
  } catch (e) {
    const p = await viaProxy('/auth/v3/tenant_access_token/internal', '', { method: 'POST', body });
    d = p.json;
  }
  if (!d || !d.tenant_access_token) throw new Error('应用 token 获取失败: ' + JSON.stringify(d).slice(0, 200));
  APP_TOKEN = d.tenant_access_token;
  console.log('✅ 应用 token 就绪（源2 读写 + 发消息）');
  return APP_TOKEN;
}
async function apiAsApp(path, opt) { await getAppToken(); return feishu(path, Object.assign({}, opt, { token: APP_TOKEN })); }

// ===================== 单元格工具 =====================
function cellText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(cellText).join('');
  if (typeof v === 'object') return typeof v.text === 'string' ? v.text : '';
  return '';
}
function normText(v) {
  return cellText(v).normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}
function extractFileTokens(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  const out = [];
  for (const c of list) {
    if (c && typeof c === 'object') {
      if (c.fileToken) out.push(c.fileToken);
      else if (Array.isArray(c)) out.push(...extractFileTokens(c));
    }
  }
  return out;
}
function isImageCell(v) {
  if (!v) return false;
  const list = Array.isArray(v) ? v : [v];
  return list.some(c => c && typeof c === 'object' && (c.fileToken || c.type === 'embed-image'));
}
function colLetter(n) { let s = ''; n = n + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sniffExt(buf) {
  if (!buf || buf.length < 4) return 'png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'png';
}

// ===================== 读表 =====================
async function querySheets(ssToken, asUser) {
  const r = asUser ? await apiAsUser('/sheets/v3/spreadsheets/' + ssToken + '/sheets/query')
                   : await apiAsApp('/sheets/v3/spreadsheets/' + ssToken + '/sheets/query');
  const d = checkOk(r, 'sheets/query(' + ssToken.slice(0, 8) + '…)');
  return (d && d.sheets) || [];
}
function pickSheet(sheets, id, title) {
  if (id) { const s = sheets.find(x => x.sheet_id === id); if (s) return s; }
  if (title) {
    const s = sheets.find(x => String(x.title || '').trim() === title)
           || sheets.find(x => String(x.title || '').indexOf(title) >= 0);
    if (s) return s;
  }
  return null;
}
async function readSheet(ssToken, sheet, asUser, maxRows) {
  const gp = sheet.grid_properties || {};
  const rows = Math.max(20, Math.min(maxRows || 2000, gp.row_count || 1000));
  const cols = Math.max(1, Math.min(30, gp.column_count || 20));
  const range = sheet.sheet_id + '!A1:' + colLetter(cols - 1) + rows;
  const path = '/sheets/v2/spreadsheets/' + ssToken + '/values/' + encodeURIComponent(range) + '?majorDimension=ROWS';
  const r = asUser ? await apiAsUser(path) : await apiAsApp(path);
  const d = checkOk(r, '读取 ' + ssToken.slice(0, 8) + '…/' + (sheet.title || sheet.sheet_id));
  const values = (d && d.valueRange && d.valueRange.values) || [];
  const maxCols = values.reduce((m, row) => Math.max(m, (row || []).length), 0);
  const rowsOut = [];
  for (let i = 0; i < values.length; i++) {
    const cells = (values[i] || []).slice();
    while (cells.length < maxCols) cells.push('');
    rowsOut.push({ row: i + 1, cells });      // row = 表内绝对行号（1 基）
  }
  // 数据末行：最后一个有内容的行
  let dataEndRow = 0;
  for (const rw of rowsOut) { if (rw.cells.some(c => c !== '' && c !== null && c !== undefined)) dataEndRow = rw.row; }
  return { rows: rowsOut, dataEndRow, gridRows: gp.row_count || rows, gridCols: cols, truncated: (gp.row_count || 0) > rows };
}

// 源1 定位：候选 token 直读 → 全失败则把候选当 wiki 节点解析 obj_token 再读
async function resolveWikiObjToken(nodeToken) {
  try {
    const r = await apiAsUser('/wiki/v2/spaces/get_node?token=' + encodeURIComponent(nodeToken));
    const d = checkOk(r, 'wiki/get_node(' + nodeToken.slice(0, 8) + '…)');
    const node = d && d.node;
    if (node && node.obj_token) {
      console.log('  🔗 wiki 节点 ' + nodeToken.slice(0, 10) + '… → obj_token ' + node.obj_token.slice(0, 10) + '…（' + (node.title || '') + '）');
      return node.obj_token;
    }
  } catch (e) { console.log('  ⚠️ wiki 节点解析失败 ' + nodeToken.slice(0, 10) + '…：' + e.message); }
  return null;
}
async function locateSrcSheet(pair) {
  const cands = [pair.src.ss].concat(pair.src.alt || []).filter(Boolean);
  for (const cand of cands) {
    try { const sheets = await querySheets(cand, true); if (sheets.length) return { token: cand, sheets }; }
    catch (e) { console.log('  ⚠️ 源1 token ' + cand.slice(0, 10) + '… 直读失败：' + e.message); }
  }
  for (const cand of cands) {                       // 直读全失败 → 按 wiki 节点解析
    const obj = await resolveWikiObjToken(cand);
    if (!obj) continue;
    try {
      const sheets = await querySheets(obj, true);
      if (sheets.length) { pair.src.resolved = obj; return { token: obj, sheets }; }
    } catch (e) { console.log('  ⚠️ 源1 解析得到的 ' + obj.slice(0, 10) + '… 读取失败：' + e.message); }
  }
  throw new Error('源1 读取失败（试过 ' + cands.length + ' 个 token 及其 wiki 节点解析），徐行 token 可能失效或无权访问');
}

// ===================== 列映射 / diff =====================
function buildColMap(srcHeader, dstHeader) {
  const norm = h => String(h === undefined || h === null ? '' : h).normalize('NFKC').trim();
  const ignore = new Set(IGNORE_COLUMNS.map(norm));
  const dIdx = new Map();
  dstHeader.forEach((h, i) => { const k = norm(h); if (k && !ignore.has(k) && !dIdx.has(k)) dIdx.set(k, i); });
  const shared = [], onlySrc = [], onlyDst = [];
  srcHeader.forEach((h, i) => {
    const k = norm(h);
    if (!k || ignore.has(k)) return;
    if (dIdx.has(k)) shared.push({ name: k, src: i, dst: dIdx.get(k) });
    else onlySrc.push(k);
  });
  const sharedNames = new Set(shared.map(c => c.name));
  dstHeader.forEach(h => { const k = norm(h); if (k && !ignore.has(k) && !sharedNames.has(k)) onlyDst.push(k); });
  return { shared, onlySrc, onlyDst };
}

// 图片列 = 列名约定 ∪ 值探测（两重保险）
function splitImageCols(shared, srcRows, dstRows) {
  const imgNames = /^(题目图|解析图|答案解析图|图片)$/;
  const imageCols = [], textCols = [];
  for (const c of shared) {
    const byName = imgNames.test(c.name) || /^[1-9]$/.test(c.name);
    const byVal = srcRows.some(r => isImageCell(r.cells[c.src])) || dstRows.some(r => isImageCell(r.cells[c.dst]));
    (byName || byVal ? imageCols : textCols).push(c);
  }
  return { imageCols, textCols };
}

function makeRowKeyFn(map) {
  const cId = map.shared.find(c => c.name === '题目ID');
  const cQ = map.shared.find(c => c.name === '题目');
  return (row) => {
    const id = cId ? normText(row.cells[cId.src]) : '';
    if (id) return 'id:' + id;
    const t = cQ ? normText(row.cells[cQ.src]) : '';
    return t ? 'q:' + t : null;
  };
}

function diffRows(srcRows, dstRows, map, keyFn) {
  const idx = (rows) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const sm = idx(srcRows), dm = idx(dstRows);
  const adds = [], mods = [], dels = [], dupKeys = [];
  for (const [k, sl] of sm) {
    const dl = dm.get(k) || [];
    if (sl.length > 1 || dl.length > 1) dupKeys.push(k + ' ×' + Math.max(sl.length, dl.length));
    for (let i = 0; i < sl.length; i++) {
      if (i < dl.length) {
        const { textChanged, imgChanged } = compareRow(sl[i], dl[i], map);
        if (textChanged.length || imgChanged.length) mods.push({ src: sl[i], dst: dl[i], textChanged, imgChanged, key: k });
      } else adds.push(sl[i]);
    }
    for (let i = sl.length; i < dl.length; i++) dels.push(dl[i]);
  }
  for (const [k, dl] of dm) if (!sm.has(k)) dels.push(...dl);
  return { adds, mods, dels, dupKeys };
}

// 文本列归一化比较；图片列先比 fileToken 列表（MD5 二次确认在后续阶段）
function compareRow(srcRow, dstRow, map) {
  const textChanged = [], imgChanged = [];
  for (const c of map.textCols) {
    if (normText(srcRow.cells[c.src]) !== normText(dstRow.cells[c.dst])) textChanged.push(c.name);
  }
  for (const c of map.imageCols) {
    const a = extractFileTokens(srcRow.cells[c.src]);
    const b = extractFileTokens(dstRow.cells[c.dst]);
    if (JSON.stringify(a) !== JSON.stringify(b)) imgChanged.push(c.name);
  }
  return { textChanged, imgChanged };
}

// ===================== 图片 =====================
const IMG_CACHE = new Map();   // fileToken -> {buf, md5, ext} | {err}

async function resolveTmpUrls(fileTokens, asUser) {
  const out = new Map();
  for (let i = 0; i < fileTokens.length; i += 5) {
    const batch = fileTokens.slice(i, i + 5);
    const qs = batch.map(t => 'file_tokens=' + encodeURIComponent(t)).join('&');
    const r = asUser ? await apiAsUser('/drive/v1/medias/batch_get_tmp_download_url?' + qs)
                     : await apiAsApp('/drive/v1/medias/batch_get_tmp_download_url?' + qs);
    if (r.json && r.json.code === 0 && r.json.data && Array.isArray(r.json.data.tmp_download_urls)) {
      r.json.data.tmp_download_urls.forEach(u => { if (u.file_token && u.tmp_download_url) out.set(u.file_token, u.tmp_download_url); });
    } else {
      console.log('  ⚠️ 取临时下载地址失败: ' + JSON.stringify(r.json).slice(0, 160));
    }
    if (i + 5 < fileTokens.length) await sleep(300);
  }
  return out;
}

function downloadBinary(url, depth) {
  const d = depth || 0;
  return new Promise((resolve, reject) => {
    if (d > 5) return reject(new Error('重定向过多'));
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'yxt-qb-source-sync' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadBinary(new URL(res.headers.location, url).toString(), d + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('下载超时')));
    req.end();
  });
}

// 并发下载（12 路；图片单个 1-4 MB，并发是唯一能压缩首次全量比对耗时的杠杆）
async function downloadBatch(tokens, urls) {
  let ok = 0, fail = 0, next = 0;
  const failed = [];
  const worker = async () => {
    while (next < tokens.length) {
      const t = tokens[next++];
      const u = urls.get(t);
      if (!u) { IMG_CACHE.set(t, { err: '无临时下载地址' }); failed.push(t); fail++; continue; }
      try {
        const buf = await downloadBinary(u);
        IMG_CACHE.set(t, { buf, md5: md5(buf), ext: sniffExt(buf) });
        ok++;
      } catch (e) { IMG_CACHE.set(t, { err: e.message }); failed.push(t); fail++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, tokens.length) }, worker));
  return { ok, fail, failed };
}
async function ensureImages(fileTokens, asUser, label) {
  const todo = [...new Set(fileTokens)].filter(t => t && !IMG_CACHE.has(t));
  if (!todo.length) return;
  console.log('  🖼️ ' + label + '：需下载 ' + todo.length + ' 张图片，取临时地址…');
  let urls = await resolveTmpUrls(todo, asUser);
  let r = await downloadBatch(todo, urls);
  if (r.failed.length) {          // 临时地址会过期/抖动，失败的重取地址再试一轮
    console.log('  🖼️ ' + label + '：失败 ' + r.failed.length + ' 张，重取临时地址重试…');
    await sleep(600);
    urls = await resolveTmpUrls(r.failed, asUser);
    const r2 = await downloadBatch(r.failed, urls);
    r = { ok: r.ok + r2.ok, fail: r2.fail, failed: r2.failed };
  }
  const ok = r.ok, fail = r.fail;
  console.log('  🖼️ ' + label + '：下载完成 ' + ok + ' 张' + (fail ? '，❌ 失败 ' + fail + ' 张' : ''));
}

function imgSig(cell) {
  return extractFileTokens(cell).map(t => {
    const c = IMG_CACHE.get(t);
    return c && c.md5 ? c.md5 : '?' + t;
  }).join('|');
}

// 下载两侧图片比 MD5，剔除「内容其实相同」的假差异（令牌对命中缓存的直接跳过，不下载）
async function confirmImageChanges(mods, map, adds) {
  const units = [];      // 待判定：{m, col, sToks, dToks, ck}
  const srcNeed = [], dstNeed = [];
  let skipped = 0;
  for (const m of mods) {
    m.upload = [];
    for (const name of m.imgChanged) {
      const c = map.imageCols.find(x => x.name === name);
      if (!c) continue;
      const sToks = extractFileTokens(m.src.cells[c.src]);
      const dToks = extractFileTokens(m.dst.cells[c.dst]);
      const ck = (sToks.length === 1 && dToks.length === 1) ? (sToks[0] + '|' + dToks[0]) : null;
      if (ck && IMG_PAIR_CACHE[ck]) { skipped++; continue; }   // 上周已确认内容相同
      units.push({ m, col: c, sToks, dToks, ck });
      srcNeed.push(...sToks); dstNeed.push(...dToks);
    }
  }
  for (const a of adds) for (const c of map.imageCols) srcNeed.push(...extractFileTokens(a.cells[c.src]));
  await ensureImages(srcNeed, true, '源1');
  await ensureImages(dstNeed, false, '源2');

  const notReady = t => { const c = IMG_CACHE.get(t); return !c || !c.md5; };
  let indet = 0;
  for (const u of units) {
    if (u.sToks.some(notReady) || u.dToks.some(notReady)) { indet++; continue; }   // 有图没下下来 → 本轮不判定（不写缓存，下周重下重判）
    if (u.sToks.length && u.dToks.length && imgSig(u.m.src.cells[u.col.src]) === imgSig(u.m.dst.cells[u.col.dst])) {
      skipped++;                                              // 内容相同（只是重新上传过），跳过
      if (u.ck) { IMG_PAIR_CACHE[u.ck] = 1; IMG_PAIR_DIRTY = true; }
      continue;
    }
    u.m.upload.push({ name: u.col.name, srcIdx: u.col.src, dstIdx: u.col.dst, fileToken: u.sToks[0] || null, oldTokens: u.dToks, needClear: u.sToks.length === 0 });
  }
  return { skipped, indet };
}

async function uploadImage(ssToken, sheetId, rowNo, letter, fileToken, name) {
  const c = IMG_CACHE.get(fileToken);
  if (!c || !c.buf) throw new Error('图片 ' + fileToken.slice(0, 10) + '… 未下载成功（' + ((c && c.err) || '?') + '）');
  const body = JSON.stringify({
    range: sheetId + '!' + letter + rowNo + ':' + letter + rowNo,
    name: name || ('q' + rowNo + '_' + letter + '.' + c.ext),
    image: c.buf.toString('base64')
  });
  const r = await apiAsApp('/sheets/v2/spreadsheets/' + ssToken + '/values_image', { method: 'POST', body });
  checkOk(r, '写图 ' + letter + rowNo);
  return c;
}

// ===================== 写入 =====================
function textBlocks(map) {
  const cols = map.textCols.slice().sort((a, b) => a.dst - b.dst);
  const blocks = [];
  for (const c of cols) {
    const last = blocks[blocks.length - 1];
    if (last && c.dst === last.end + 1) { last.end = c.dst; last.cols.push(c); }
    else blocks.push({ start: c.dst, end: c.dst, cols: [c] });
  }
  return blocks;
}
function buildTextRanges(targets, map, sheetId) {
  const blocks = textBlocks(map);
  const sorted = targets.slice().sort((a, b) => a.row - b.row);
  const ranges = [];
  for (const b of blocks) {
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].row === sorted[j].row + 1) j++;
      const values = [];
      for (let k = i; k <= j; k++) values.push(b.cols.map(c => cellText(sorted[k].cells[c.src])));
      ranges.push({ range: sheetId + '!' + colLetter(b.start) + sorted[i].row + ':' + colLetter(b.end) + sorted[j].row, values });
      i = j + 1;
    }
  }
  return ranges;
}
async function batchUpdateValues(ssToken, ranges, label) {
  let n = 0;
  for (let i = 0; i < ranges.length; i += 50) {
    const chunk = ranges.slice(i, i + 50);
    const r = await apiAsApp('/sheets/v2/spreadsheets/' + ssToken + '/values_batch_update', { method: 'POST', body: JSON.stringify({ valueRanges: chunk }) });
    checkOk(r, label + ' 批量写值（第 ' + (i + 1) + '~' + (i + chunk.length) + ' 段）');
    n += chunk.length;
  }
  return n;
}
async function deleteRows(ssToken, sheetId, rowNumbers, label) {
  const rows = [...new Set(rowNumbers)].sort((a, b) => b - a);   // 从下往上
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && r === last.startIndex - 1) last.startIndex = r;
    else groups.push({ startIndex: r, endIndex: r });
  }
  for (const g of groups) {
    const r = await apiAsApp('/sheets/v2/spreadsheets/' + ssToken + '/dimension_range', {
      method: 'DELETE',
      body: JSON.stringify({ dimension: { sheetId, majorDimension: 'ROWS', startIndex: g.startIndex, endIndex: g.endIndex } })
    });
    checkOk(r, label + ' 删行 ' + g.startIndex + '-' + g.endIndex);
  }
  return rows.length;
}
async function ensureGridRows(ssToken, sheetId, needRow, currentRows) {
  if (needRow <= currentRows) return currentRows;
  const add = Math.max(20, needRow - currentRows + 20);
  const r = await apiAsApp('/sheets/v2/spreadsheets/' + ssToken + '/dimension_range', {
    method: 'POST',
    body: JSON.stringify({ dimension: { sheetId, majorDimension: 'ROWS', length: add } })
  });
  checkOk(r, '扩行 +' + add);
  return currentRows + add;
}

// ===================== KV 备份 / 状态 =====================
function kvPost(items) {
  return httpsRequest(PAGES + '/data', {
    method: 'POST', headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  }).then(r => r.json || {}).catch(() => ({}));
}
function kvGet(key) {
  return httpsRequest(PAGES + '/data?key=' + encodeURIComponent(key), { headers: { 'x-yxt-secret': SECRET } })
    .then(r => {
      if (r.status !== 200 || !r.json || r.json.value === null || r.json.value === undefined) return null;
      try { const o = JSON.parse(r.json.value); return o && o.v !== undefined ? o.v : null; } catch (e) { return null; }
    })
    .catch(() => null);
}

// ===================== 飞书汇报 =====================
async function sendCard(card) {
  if (process.env.NO_CARD === '1') { console.log('📨（NO_CARD=1，未发送飞书卡片）'); return; }
  try {
    const token = await getAppToken();
    const r = await feishu('/im/v1/messages?receive_id_type=email', {
      method: 'POST', token,
      body: JSON.stringify({ receive_id: REPORT_EMAIL, msg_type: 'interactive', content: JSON.stringify(card) })
    });
    if (!r.json || r.json.code !== 0) throw new Error(JSON.stringify(r.json).slice(0, 200));
    console.log('📨 飞书卡片已发送');
  } catch (e) {
    console.log('⚠️ 飞书卡片发送失败: ' + e.message);
  }
}
function buildReportCard(summaries, totalSec) {
  const anyFail = summaries.some(s => s.error);
  const anyChange = summaries.some(s => s.add || s.mod || s.del || s.imgUp);
  const title = DRY_RUN ? '🔍 源1→源2 同步预览（未写入）'
    : anyFail ? '❌ 源1→源2 同步失败' : (anyChange ? '📓 源1→源2 同步完成' : '📓 源1→源2 同步完成（无变化）');
  const color = DRY_RUN ? 'grey' : (anyFail ? 'red' : (anyChange ? 'blue' : 'green'));
  const lines = ['**' + new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '** 耗时 ' + totalSec + ' 秒' + (DRY_RUN ? ' · DRY_RUN 未写入' : '')];
  for (const s of summaries) {
    lines.push('');
    lines.push('**【' + s.pair + '】**' + (s.error ? ' ❌ ' + s.error : ''));
    lines.push('源1 **' + s.srcRows + '** 条 → 源2 **' + s.dstRows + '** 条　➕ 新增 **' + s.add + '** · ✏️ 修改 **' + s.mod + '** · 🗑️ 删除 **' + s.del + '**');
    if (s.addDetail && s.addDetail.length) lines.push('　➕ ' + s.addDetail.slice(0, 10).join('、') + (s.addDetail.length > 10 ? ' 等 ' + s.addDetail.length + ' 条' : ''));
    if (s.modDetail && s.modDetail.length) lines.push('　✏️ ' + s.modDetail.slice(0, 5).join(' ') + (s.modDetail.length > 5 ? ' 等 ' + s.modDetail.length + ' 行' : ''));
    if (s.delDetail && s.delDetail.length) lines.push('　🗑️ ' + s.delDetail.slice(0, 5).join('、') + (s.delDetail.length > 5 ? ' 等 ' + s.delDetail.length + ' 条' : ''));
    lines.push('🖼️ 图片上传 ' + s.imgUp + (s.imgSkip ? '（内容相同跳过 ' + s.imgSkip + '）' : '') + (s.imgFail ? ' · ❌ 失败 ' + s.imgFail : ''));
    if (s.unkeyedSrc || s.unkeyedDst) lines.push('🛡️ 无键行：源1 ' + s.unkeyedSrc + ' 行已跳过 / 源2 ' + s.unkeyedDst + ' 行已保护不删');
    if (s.dupKeys) lines.push('⚠️ 重复键 ' + s.dupKeys + ' 组');
    if (s.warn && s.warn.length) lines.push('⚠️ ' + s.warn.slice(0, 3).join('；') + (s.warn.length > 3 ? ' 等 ' + s.warn.length + ' 条' : ''));
    if (s.backupKey) lines.push('💾 备份：KV `' + s.backupKey + '`');
  }
  if (anyFail) lines.push('', '提示：修正后**重跑即幂等收敛**（源1 为准，不会重复写入）。');
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }];
  if (RUN_URL) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📋 查看运行日志' }, type: 'primary', url: RUN_URL }] });
  return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: title }, template: color }, elements };
}

// ===================== 单对同步 =====================
async function syncPair(pair) {
  const t0 = Date.now();
  const s = {
    pair: pair.name, key: pair.key, phase: 'init', error: '',
    srcRows: 0, dstRows: 0, add: 0, mod: 0, del: 0,
    imgUp: 0, imgSkip: 0, imgFail: 0, unkeyedSrc: 0, unkeyedDst: 0, dupKeys: 0,
    warn: [], backupKey: '', sec: 0, detail: {}
  };
  IMG_CACHE.clear();   // 图片缓冲区只在本对内有意义，不清会跨对累积（实测 7 对到 2 GB）
  const stateKey = 'qb_src_state_' + pair.key;
  const prevState = await kvGet(stateKey).catch(() => null);
  let prev = null;
  try { prev = prevState ? JSON.parse(prevState) : null; } catch (e) {}

  console.log('\n===== 【' + pair.name + '】开始 =====');
  // ---- 1. 源1（徐行 token，只读） ----
  s.phase = '读源1';
  const loc = await locateSrcSheet(pair);
  const srcToken = loc.token, srcSheets = loc.sheets;
  const srcSheet = pickSheet(srcSheets, pair.src.sheet, pair.src.sheetTitle);
  if (!srcSheet) throw new Error('源1 里找不到工作表「' + (pair.src.sheetTitle || pair.src.sheet) + '」，现有：' + srcSheets.map(x => x.title).join('/'));
  const src = await readSheet(srcToken, srcSheet, true, 5000);
  console.log('📄 源1 [' + srcSheet.title + '] 读到 ' + src.rows.length + ' 行（数据末行 ' + src.dataEndRow + '）');
  let srcBody = src.rows.slice(1).filter(r => r.row <= src.dataEndRow);
  if (LIMIT) { srcBody = srcBody.slice(0, LIMIT); console.log('  ⚠️ LIMIT=' + LIMIT + '，只处理源1 前 ' + srcBody.length + ' 行'); }

  // ---- 2. 源2（应用 token，读写） ----
  s.phase = '读源2';
  const dstSheets = await querySheets(pair.dst.ss, false);
  const dstSheet = pickSheet(dstSheets, pair.dst.sheet, pair.dst.sheetTitle);
  if (!dstSheet) throw new Error('源2 里找不到工作表「' + (pair.dst.sheetTitle || pair.dst.sheet) + '」，现有：' + dstSheets.map(x => x.title).join('/'));
  const dst = await readSheet(pair.dst.ss, dstSheet, false, 5000);
  console.log('📄 源2 [' + dstSheet.title + '] 读到 ' + dst.rows.length + ' 行（数据末行 ' + dst.dataEndRow + '）');
  const dstBody = dst.rows.slice(1).filter(r => r.row <= dst.dataEndRow);
  // 截断守卫：读到上限最后一行仍有数据 → 下方可能有没读到的内容，写入会误删
  for (const [label, sh] of [['源1', src], ['源2', dst]]) {
    if (sh.truncated && sh.dataEndRow >= sh.rows.length && !FORCE) {
      throw new Error(label + ' 数据超出读取上限（读到第 ' + sh.rows.length + ' 行仍有数据），终止（FORCE=true 可强制）');
    }
  }

  const srcHeader = (src.rows[0] && src.rows[0].cells) || [];
  const dstHeader = (dst.rows[0] && dst.rows[0].cells) || [];
  const map = buildColMap(srcHeader, dstHeader);
  const { imageCols, textCols } = splitImageCols(map.shared, srcBody, dstBody);
  map.imageCols = imageCols; map.textCols = textCols;
  const idColShared = map.shared.find(c => c.name === '题目ID');
  const rowIdOf = (row, side) => idColShared ? normText(row.cells[side === 'src' ? idColShared.src : idColShared.dst]) : '';
  console.log('🔗 列映射：共有 ' + map.shared.length + ' 列（文本 ' + textCols.length + ' / 图片 ' + imageCols.length + '）'
    + (map.onlySrc.length ? '；仅源1有：' + map.onlySrc.join('、') : '')
    + (map.onlyDst.length ? '；仅源2有：' + map.onlyDst.join('、') : ''));
  if (map.shared.length < 5) throw new Error('表头匹配列数过少（' + map.shared.length + '），可能读错表或表结构变了');
  if (map.onlySrc.length) s.warn.push('仅源1有的列未同步：' + map.onlySrc.join('、'));
  if (map.onlyDst.length) s.warn.push('仅源2有的列未触碰：' + map.onlyDst.join('、'));

  // ---- 3. diff ----
  s.phase = '对比';
  const keyFn = makeRowKeyFn(map);
  const srcKeyed = [], dstKeyed = [];
  for (const r of srcBody) { if (keyFn(r)) srcKeyed.push(r); else { s.unkeyedSrc++; if (s.warn.length < 8) s.warn.push('源1 第 ' + r.row + ' 行无题目ID/题目，已跳过'); } }
  for (const r of dstBody) { if (keyFn(r)) dstKeyed.push(r); else { s.unkeyedDst++; if (s.warn.length < 8) s.warn.push('源2 第 ' + r.row + ' 行无题目ID/题目，已保护不删'); } }
  if (srcKeyed.length === 0) throw new Error('源1 解析出 0 条有效题目，终止（保护源2 不被清空）');
  if (dstKeyed.length === 0 && !ALLOW_EMPTY_DEST) throw new Error('源2 解析出 0 条有效题目，终止（如确认源2 是空表，用 ALLOW_EMPTY_DEST=1）');
  if (!LIMIT && !FORCE) {
    if (srcKeyed.length < MIN_SRC_ROWS) throw new Error('源1 只有 ' + srcKeyed.length + ' 条（< ' + MIN_SRC_ROWS + '），疑似读取异常，终止（FORCE=true 可强制）');
    if (prev && prev.srcRows && srcKeyed.length < prev.srcRows * 0.7) throw new Error('源1 条数骤降：' + prev.srcRows + ' → ' + srcKeyed.length + '，终止（FORCE=true 可强制）');
  }
  const { adds, mods, dels, dupKeys } = diffRows(srcKeyed, dstKeyed, map, keyFn);
  s.srcRows = srcKeyed.length; s.dstRows = dstKeyed.length;
  s.add = adds.length; s.mod = mods.length; s.del = dels.length; s.dupKeys = dupKeys.length;
  if (dupKeys.length) s.warn.push('重复键：' + dupKeys.slice(0, 5).join('、'));
  if (!LIMIT && !FORCE && dels.length > Math.max(50, dstKeyed.length * MAX_DELETE_RATIO)) {
    throw new Error('删除量异常：' + dels.length + ' 行（源2 共 ' + dstKeyed.length + ' 行），终止（FORCE=true 可强制）');
  }
  console.log('🔍 差异：➕ ' + adds.length + ' · ✏️ ' + mods.length + ' · 🗑️ ' + dels.length
    + (adds.length ? '（新增：' + adds.slice(0, 8).map(r => normText(r.cells[(map.shared.find(c => c.name === '题目ID') || {}).src]) || '(无ID)').join('、') + (adds.length > 8 ? '…' : '') + '）' : ''));
  if (mods.length) console.log('✏️ 修改明细：' + mods.slice(0, 10).map(m => '行' + m.dst.row + '[' + m.textChanged.concat(m.imgChanged).join(',') + ']').join(' '));
  if (dels.length) console.log('🗑️ 删除明细：' + dels.slice(0, 10).map(r => '行' + r.row + '（' + (normText(r.cells[(map.shared.find(c => c.name === '题目ID') || {}).src]).slice(0, 12) || '(无ID)') + '）').join(' '));

  // ---- 4. 图片差异确认（下载两侧比 MD5，剔除「内容其实相同」的假差异） ----
  s.phase = '图片比对';
  await loadImgPairCache(pair.key);
  const imgInfo = await confirmImageChanges(mods, map, adds);
  s.imgSkip = imgInfo.skipped;
  if (imgInfo.indet) {
    s.warn.push('有 ' + imgInfo.indet + ' 张图片未下载成功，本轮未判定（下周自动重试）');
    console.log('  ⚠️ 有 ' + imgInfo.indet + ' 张图片未下载成功，本轮不判定（下周重试）');
  }
  // 只剩真正要动的行：有文本差异，或有图片要上传/清空
  const realMods = mods.filter(m => m.textChanged.length || (m.upload || []).length);
  const textModCount = realMods.filter(m => m.textChanged.length).length;
  const addsImgCount = adds.reduce((n, a) => n + map.imageCols.reduce((n2, c) => n2 + extractFileTokens(a.cells[c.src]).length, 0), 0);
  const modImgCount = realMods.reduce((n, m) => n + (m.upload || []).filter(u => u.fileToken).length, 0);
  const clearCount = realMods.reduce((n, m) => n + (m.upload || []).filter(u => u.needClear).length, 0);
  s.mod = realMods.length;
  s.detail.textMods = textModCount;
  s.detail.imgModRows = realMods.length - textModCount;
  s.detail.planImgUp = addsImgCount + modImgCount;
  s.detail.planImgAdd = addsImgCount;
  s.detail.planImgMod = modImgCount;
  console.log('🔍 实际待处理：文本修改 ' + textModCount + ' 行 / 仅图片 ' + s.detail.imgModRows + ' 行 / 新增 ' + adds.length + ' 行 / 删除 ' + dels.length + ' 行');
  console.log('🖼️ 图片：需上传 ' + (addsImgCount + modImgCount) + ' 张（新增行 ' + addsImgCount + ' + 修改行 ' + modImgCount + '）'
    + (s.imgSkip ? '，内容相同跳过 ' + s.imgSkip + ' 张' : '') + (clearCount ? '，需清空 ' + clearCount + ' 格' : ''));
  // 汇报卡片用的明细
  s.addDetail = adds.map(a => rowIdOf(a, 'src') || '(无ID)');
  s.delDetail = dels.map(r => rowIdOf(r, 'dst') || '(无ID)');
  s.modDetail = realMods.filter(m => m.textChanged.length).map(m => '行' + m.dst.row + '[' + m.textChanged.join(',') + ']');

  await saveImgPairCache(pair.key);   // 纯知识缓存（记「哪些令牌对内容相同」），DRY_RUN 也存，省得下轮重下
  if (DRY_RUN) {
    s.phase = 'DRY_RUN';
    s.imgUp = addsImgCount + modImgCount;   // DRY_RUN 里记为「计划上传数」
    console.log('🔍 DRY_RUN：跳过全部写入');
    s.sec = Math.round((Date.now() - t0) / 1000);
    return s;
  }
  if (!adds.length && !realMods.length && !dels.length) {
    console.log('✅ 无差异，无需写入');
    s.phase = 'done';
    s.sec = Math.round((Date.now() - t0) / 1000);
    await kvPost([{ key: stateKey, v: JSON.stringify({ date: ymd(), ok: true, srcRows: s.srcRows, dstRows: s.dstRows, add: 0, mod: 0, del: 0 }), t: new Date().toISOString() }]);
    return s;
  }

  // ---- 5. 备份 ----
  s.phase = '备份';
  const backupKey = 'qb_src_backup_' + pair.key + '_' + ymd();
  const idCol = idColShared;
  const backup = {
    version: 1, at: new Date().toISOString(), pair: pair.name, pairKey: pair.key,
    src: { ss: srcToken, sheet: srcSheet.sheet_id, rows: s.srcRows },
    dst: { ss: pair.dst.ss, sheet: dstSheet.sheet_id, rows: s.dstRows },
    dels: dels.map(r => ({ row: r.row, id: idCol ? normText(r.cells[idCol.dst]) : '', cells: r.cells })),
    mods: realMods.map(m => ({ row: m.dst.row, id: idCol ? normText(m.dst.cells[idCol.dst]) : '', cells: m.dst.cells })),
    adds: adds.map(a => ({ id: idCol ? normText(a.cells[idCol.src]) : '', row: null })),
    images: []
  };
  // 覆盖前的源2 老图留底（base64，受总量上限约束）
  if (BACKUP_IMAGES) {
    let total = 0, cut = false;
    for (const m of realMods) for (const u of (m.upload || [])) {
      for (const t of (u.oldTokens || [])) {
        const c = IMG_CACHE.get(t);
        if (!c || !c.buf) continue;
        if (total + c.buf.length > BACKUP_IMAGE_MAX_MB * 1024 * 1024) { cut = true; continue; }
        total += c.buf.length;
        backup.images.push({ row: m.dst.row, col: u.dstIdx, fileToken: t, ext: c.ext, b64: c.buf.toString('base64') });
      }
    }
    if (cut) s.warn.push('老图留底超过 ' + BACKUP_IMAGE_MAX_MB + 'MB，部分未留底');
  }
  const bstr = JSON.stringify(backup);
  try { fs.writeFileSync('qb-source-sync-backup-' + pair.key + '.json', bstr); } catch (e) { s.warn.push('备份落盘失败：' + e.message); }
  // KV 单值上限 25MiB：超限时去掉图片 base64 再写（图片另存本地文件/artifact）
  let kvStr = bstr;
  if (Buffer.byteLength(kvStr) > 20 * 1024 * 1024) {
    const slim = JSON.parse(bstr); slim.images = []; slim.note = '图片 base64 已省略（超 KV 上限），见运行 artifact 里的本地备份文件';
    kvStr = JSON.stringify(slim);
    s.warn.push('备份超 20MB，KV 版已省略图片留底');
  }
  const w = await kvPost([
    { key: backupKey, v: kvStr, t: new Date().toISOString() },
    { key: 'qb_src_backup_latest_' + pair.key, v: kvStr, t: new Date().toISOString() }
  ]);
  s.backupKey = backupKey;
  console.log('💾 备份 ' + (w.written ? '已写 KV：' + backupKey : '⚠️ KV 写入异常 ' + JSON.stringify(w)) + '（' + (bstr.length / 1024).toFixed(0) + 'KB，' + backup.dels.length + ' 删除行 + ' + backup.mods.length + ' 修改行 + ' + backup.images.length + ' 张图）');

  // ---- 6. 写文本（修改） ----
  s.phase = '写修改';
  const textTargets = realMods.filter(m => m.textChanged.length);
  if (textTargets.length) {
    const n = await batchUpdateValues(pair.dst.ss, buildTextRanges(textTargets.map(m => ({ row: m.dst.row, cells: m.src.cells })), map, dstSheet.sheet_id), '修改');
    console.log('✏️ 已更新 ' + textTargets.length + ' 行文本（' + n + ' 个范围）');
  }

  // ---- 7. 写图片（修改行） ----
  s.phase = '写修改图';
  for (const m of realMods) {
    for (const u of (m.upload || [])) {
      if (u.fileToken) {
        try { await uploadImage(pair.dst.ss, dstSheet.sheet_id, m.dst.row, colLetter(u.dstIdx), u.fileToken); s.imgUp++; }
        catch (e) { s.imgFail++; s.warn.push('行' + m.dst.row + ' 写图失败：' + e.message); console.log('  ❌ 行' + m.dst.row + ' 写图失败：' + e.message); }
      } else if (u.needClear) {
        try {
          await batchUpdateValues(pair.dst.ss, [{ range: dstSheet.sheet_id + '!' + colLetter(u.dstIdx) + m.dst.row + ':' + colLetter(u.dstIdx) + m.dst.row, values: [['']] }], '清图');
          console.log('  🧹 行' + m.dst.row + ' 列' + colLetter(u.dstIdx) + ' 图片已清空');
        } catch (e) { s.warn.push('行' + m.dst.row + ' 清图失败（源1 该格为空但源2 有图）：' + e.message); }
      }
    }
  }

  // ---- 8. 删除行（从下往上） ----
  s.phase = '删除行';
  if (dels.length) {
    const n = await deleteRows(pair.dst.ss, dstSheet.sheet_id, dels.map(r => r.row), '删除');
    console.log('🗑️ 已删除 ' + n + ' 行');
  }

  // ---- 9. 新增（追加到末尾） ----
  s.phase = '新增行';
  if (adds.length) {
    const dst2 = await readSheet(pair.dst.ss, dstSheet, false, 3000);
    let nextRow = dst2.dataEndRow + 1;
    await ensureGridRows(pair.dst.ss, dstSheet.sheet_id, nextRow + adds.length, dst2.gridRows);
    const targets = adds.map((a, i) => ({ row: nextRow + i, cells: a.cells }));
    await batchUpdateValues(pair.dst.ss, buildTextRanges(targets, map, dstSheet.sheet_id), '新增');
    backup.adds.forEach((x, i) => { x.row = nextRow + i; });
    console.log('➕ 已追加 ' + adds.length + ' 行（第 ' + nextRow + '~' + (nextRow + adds.length - 1) + ' 行），开始传图…');
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti], a = adds[ti];
      for (const c of map.imageCols) {
        const toks = extractFileTokens(a.cells[c.src]);
        for (const tok of toks) {
          try { await uploadImage(pair.dst.ss, dstSheet.sheet_id, t.row, colLetter(c.dst), tok); s.imgUp++; }
          catch (e) { s.imgFail++; s.warn.push('新增行' + t.row + ' 写图失败：' + e.message); console.log('  ❌ 新增行' + t.row + ' 写图失败：' + e.message); }
        }
      }
    }
    // 更新备份里的新增行号
    await kvPost([{ key: backupKey, v: JSON.stringify(backup), t: new Date().toISOString() }]);
  }

  // ---- 10. 复核（只读） ----
  s.phase = '复核';
  try {
    const dst3 = await readSheet(pair.dst.ss, dstSheet, false, 3000);
    const body3 = dst3.rows.slice(1).filter(r => r.row <= dst3.dataEndRow && keyFn(r));
    const again = diffRows(srcKeyed, body3, map, keyFn);
    // 复核剔除「图片只是 token 不同、内容已确认相同（命中缓存）」的假差异
    const realAgain = again.mods.filter(m => m.textChanged.length || m.imgChanged.some(name => {
      const c = map.imageCols.find(x => x.name === name);
      if (!c) return true;
      const sT = extractFileTokens(m.src.cells[c.src]), dT = extractFileTokens(m.dst.cells[c.dst]);
      const ck = (sT.length === 1 && dT.length === 1) ? (sT[0] + '|' + dT[0]) : null;
      return !(ck && IMG_PAIR_CACHE[ck]);
    }));
    s.detail.verify = { add: again.adds.length, mod: realAgain.length, del: again.dels.length };
    console.log('🔎 复核：剩余差异 ➕' + again.adds.length + ' ✏️' + realAgain.length + ' 🗑️' + again.dels.length
      + (again.mods.length - realAgain.length ? '（另有 ' + (again.mods.length - realAgain.length) + ' 行仅图片 token 不同、内容已确认相同，不计）' : ''));
  } catch (e) { s.warn.push('复核读取失败：' + e.message); }

  s.phase = 'done';
  s.sec = Math.round((Date.now() - t0) / 1000);
  await kvPost([{
    key: stateKey,
    v: JSON.stringify({ date: ymd(), ok: true, srcRows: s.srcRows, dstRows: s.dstRows, add: s.add, mod: s.mod, del: s.del }),
    t: new Date().toISOString()
  }]);
  console.log('✅ 【' + pair.name + '】完成，用时 ' + s.sec + ' 秒');
  return s;
}

// ===================== 回滚 =====================
async function rollback(fromArg, dryRun) {
  let raw = null;
  if (fromArg.indexOf('kv:') === 0) raw = await kvGet(fromArg.slice(3).trim());
  else raw = fs.readFileSync(fromArg, 'utf8');
  if (!raw) throw new Error('找不到备份：' + fromArg);
  const b = JSON.parse(raw);
  const pair = PAIRS.find(p => p.key === (b.pairKey || (b.pair === '笔记本' ? 'laptop' : ''))) || PAIRS[0];
  console.log('↩️ 回滚 ' + b.pair + '（备份时间 ' + b.at + '）：删除行 ' + b.dels.length + ' / 修改行 ' + b.mods.length + ' / 新增行 ' + b.adds.length + ' / 图片 ' + ((b.images || []).length));
  const dstSheets = await querySheets(pair.dst.ss, false);
  const dstSheet = pickSheet(dstSheets, pair.dst.sheet, pair.dst.sheetTitle);
  const cur = await readSheet(pair.dst.ss, dstSheet, false, 3000);
  const body = cur.rows.slice(1).filter(r => r.row <= cur.dataEndRow);
  const map = buildColMap((cur.rows[0] || {}).cells || [], (cur.rows[0] || {}).cells || []);   // 列以当前表为准
  const idCol = map.shared.find(c => c.name === '题目ID');
  const findRow = (id) => {
    if (!id) return null;
    for (const r of body) {
      const cId = map.shared.find(c => c.name === '题目ID');
      if (cId && normText(r.cells[cId.dst]) === id) return r;
      const cQ = map.shared.find(c => c.name === '题目');
      if (cQ && normText(r.cells[cQ.dst]) === id) return r;
    }
    return null;
  };
  const plan = [];
  for (const a of b.adds) { const r = a.id ? findRow(a.id) : null; plan.push({ act: '删除新增行', id: a.id, row: r ? r.row : (a.row || '?'), ok: !!r }); }
  for (const d of b.dels) { const r = d.id ? findRow(d.id) : null; plan.push({ act: '恢复删除行', id: d.id, row: r ? r.row : '?', ok: !!r }); }
  for (const m of b.mods) { const r = m.id ? findRow(m.id) : null; plan.push({ act: '还原修改行', id: m.id, row: r ? r.row : '?', ok: !!r }); }
  plan.forEach(p => console.log('  ' + (p.ok ? '✓' : '✗') + ' ' + p.act + ' ' + (p.id || '') + '（现第 ' + p.row + ' 行）'));
  const restorable = plan.filter(p => p.ok).length;
  console.log('可执行 ' + restorable + ' / ' + plan.length + ' 项');
  if (dryRun) { console.log('🔍 --dry-run：未执行'); return; }

  // 1) 删掉本次新增的行（从下往上）
  const addRows = [];
  for (const a of b.adds) { const r = a.id ? findRow(a.id) : null; if (r) addRows.push(r.row); }
  if (addRows.length) await deleteRows(pair.dst.ss, dstSheet.sheet_id, addRows, '回滚删除新增');
  // 2) 还原修改/删除行的文本
  const targets = [];
  for (const rec of b.mods.concat(b.dels)) {
    const r = rec.id ? findRow(rec.id) : null;
    if (!r) continue;
    // 备份里的 cells 是按当时源2 的列序存的，列结构未变时可直接按当前列序写回
    targets.push({ row: r.row, cells: rec.cells });
  }
  if (targets.length) {
    // 恒等映射（源列=目标列）：只还原文本列，图片列绝不写文本（会把图清掉）
    const { textCols: curTextCols } = splitImageCols(map.shared, body, body);
    const identMap = { textCols: curTextCols.map(c => ({ name: c.name, src: c.dst, dst: c.dst })), imageCols: [] };
    const ranges = [];
    const blocks = textBlocks(identMap);
    for (const b2 of blocks) {
      for (const t of targets) ranges.push({ range: dstSheet.sheet_id + '!' + colLetter(b2.start) + t.row + ':' + colLetter(b2.end) + t.row, values: [b2.cols.map(c => cellText(t.cells[c.dst]))] });
    }
    await batchUpdateValues(pair.dst.ss, ranges, '回滚还原');
    console.log('↩️ 已还原 ' + targets.length + ' 行文本');
  }
  // 3) 还原被覆盖的图片
  let imgOk = 0, imgFail = 0;
  for (const im of (b.images || [])) {
    const rec = b.mods.concat(b.dels).find(x => x.row === im.row) || {};
    const r = rec.id ? findRow(rec.id) : null;
    if (!r) { imgFail++; continue; }
    try {
      const buf = Buffer.from(im.b64, 'base64');
      const tb = { buf, ext: im.ext || 'png' };
      IMG_CACHE.set('__rb_' + im.fileToken, tb);
      await uploadImage(pair.dst.ss, dstSheet.sheet_id, r.row, colLetter(im.col), '__rb_' + im.fileToken);
      imgOk++;
    } catch (e) { imgFail++; console.log('  ❌ 图片还原失败（行 ' + im.row + '）：' + e.message); }
  }
  console.log('↩️ 图片还原 ' + imgOk + ' 张' + (imgFail ? '，失败 ' + imgFail + ' 张' : ''));
  console.log('✅ 回滚流程结束');
}

// ===================== 配对体检（只读，不写、不发卡片） =====================
async function probePairs() {
  console.log('========== 配对体检（只读） ' + bjNow() + ' ==========');
  const only = process.env.PAIR_KEY || '';
  for (const pair of PAIRS) {
    if (only && pair.key !== only) continue;
    console.log('\n===== 【' + pair.name + '】key=' + pair.key + ' =====');
    try {
      const loc = await locateSrcSheet(pair);
      const srcSheet = pickSheet(loc.sheets, pair.src.sheet, pair.src.sheetTitle);
      if (!srcSheet) throw new Error('源1 找不到工作表「' + (pair.src.sheetTitle || pair.src.sheet) + '」，现有：' + loc.sheets.map(x => x.title).join(' / '));
      const src = await readSheet(loc.token, srcSheet, true, 5000);
      const dstSheets = await querySheets(pair.dst.ss, false);
      const dstSheet = pickSheet(dstSheets, pair.dst.sheet, pair.dst.sheetTitle);
      if (!dstSheet) throw new Error('源2 找不到工作表「' + (pair.dst.sheetTitle || pair.dst.sheet) + '」，现有：' + dstSheets.map(x => x.title).join(' / '));
      const dst = await readSheet(pair.dst.ss, dstSheet, false, 5000);
      const srcBody = src.rows.slice(1).filter(r => r.row <= src.dataEndRow);
      const dstBody = dst.rows.slice(1).filter(r => r.row <= dst.dataEndRow);
      const map = buildColMap((src.rows[0] || {}).cells || [], (dst.rows[0] || {}).cells || []);
      const { imageCols, textCols } = splitImageCols(map.shared, srcBody, dstBody);
      map.imageCols = imageCols; map.textCols = textCols;
      const keyFn = makeRowKeyFn(map);
      const sk = [], dk = [];
      let unkeyedSrc = 0, unkeyedDst = 0;
      for (const r of srcBody) { if (keyFn(r)) sk.push(r); else unkeyedSrc++; }
      for (const r of dstBody) { if (keyFn(r)) dk.push(r); else unkeyedDst++; }
      const d = diffRows(sk, dk, map, keyFn);
      const textMods = d.mods.filter(m => m.textChanged.length).length;
      const imgMods = d.mods.length - textMods;
      console.log('源1：' + loc.token.slice(0, 10) + '… sheet「' + srcSheet.title + '」' + (srcSheet.sheet_id || '') + '　数据末行 ' + src.dataEndRow + (src.truncated ? ' ⚠️截断' : ''));
      console.log('源2：sheet「' + dstSheet.title + '」' + (dstSheet.sheet_id || '') + '　数据末行 ' + dst.dataEndRow + (dst.truncated ? ' ⚠️截断' : ''));
      console.log('表头：共有 ' + map.shared.length + ' 列（文本 ' + textCols.length + ' / 图片 ' + imageCols.length + '）'
        + (map.onlySrc.length ? '　仅源1：' + map.onlySrc.join('、') : '')
        + (map.onlyDst.length ? '　仅源2：' + map.onlyDst.join('、') : ''));
      console.log('数据：源1 ' + sk.length + ' 条 / 源2 ' + dk.length + ' 条（无键行 ' + unkeyedSrc + '/' + unkeyedDst + '，重复键 ' + d.dupKeys.length + '）');
      console.log('差异：➕' + d.adds.length + ' · ✏️文本 ' + textMods + ' 行 · 🖼️仅图 ' + imgMods + ' 行 · 🗑️' + d.dels.length);
      if (d.dupKeys.length) {
        console.log('⚠️ 重复键：' + d.dupKeys.slice(0, 6).join('、'));
        const qCol = map.shared.find(c => c.name === '题目') || map.shared.find(c => c.name === '题目ID');
        for (const kk of d.dupKeys.slice(0, 3)) {
          const rawKey = kk.replace(/ ×\d+$/, '');
          const pick = (arr, side) => arr.filter(r => keyFn(r) === rawKey)
            .map(r => '源' + side + '第' + r.row + '行「' + normText(r.cells[qCol ? (side === 1 ? qCol.src : qCol.dst) : 0]).slice(0, 34) + '」');
          console.log('　' + rawKey + ' → ' + pick(sk, 1).concat(pick(dk, 2)).join(' ／ '));
        }
      }
      if (d.adds.length && d.adds.length <= 12) console.log('　新增ID：' + d.adds.map(a => normText(a.cells[(map.shared.find(c => c.name === '题目ID') || {}).src]) || '(无ID)').join('、'));
      if (d.dels.length && d.dels.length <= 12) {
        const qc = map.shared.find(c => c.name === '题目');
        console.log('　删除：' + d.dels.map(r => '源2第' + r.row + '行 ' + (normText(r.cells[(map.shared.find(c => c.name === '题目ID') || {}).dst]) || '(无ID)')
          + '「' + (qc ? normText(r.cells[qc.dst]).slice(0, 30) : '') + '」').join('；'));
      }
      if (textMods) {
        console.log('　文本改动明细（以源1 为准覆盖源2）：');
        for (const m of d.mods.filter(x => x.textChanged.length).slice(0, 8)) {
          for (const nm of m.textChanged) {
            const c = map.textCols.find(x => x.name === nm);
            const a = c ? normText(m.src.cells[c.src]) : '', b = c ? normText(m.dst.cells[c.dst]) : '';
            let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;   // 第一个不同字符
            const win = (s) => (i > 20 ? '…' : '') + s.slice(Math.max(0, i - 20), i + 40) + (s.length > i + 40 ? '…' : '');
            console.log('　　[' + nm + '] 源1「' + win(a) + '」');
            console.log('　　' + '　'.repeat(nm.length ? 0 : 0) + '[' + nm + '] 源2「' + win(b) + '」（将被源1 覆盖）');
          }
        }
      }
      if (map.shared.length < 5) console.log('⛔ 表头匹配 < 5 列，脚本会拒绝写');
    } catch (e) { console.log('❌ ' + e.message); }
  }
  console.log('\n（体检只读，未写任何数据）');
}

// ===================== 主流程 =====================
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--probe-pairs') { await probePairs(); return; }
  if (args[0] === '--alert-only') {
    const msg = args[1] || '同步工作流异常结束，请查看日志';
    await sendCard({ config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '❌ 源1→源2 同步异常' }, template: 'red' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: msg } }].concat(RUN_URL ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📋 查看日志' }, type: 'primary', url: RUN_URL }] }] : []) });
    return;
  }
  if (args[0] === '--rollback-from') {
    await getAppToken();
    await rollback(args[1], args.includes('--dry-run'));
    return;
  }
  // 定时跑只在周一（UTC 周一 0:00 = 北京周一 8:00）；手动触发不受限（方便随时补跑/演练）
  if (ONLY_MONDAY && process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && new Date().getUTCDay() !== 1) {
    console.log('⏭️ 非周一（UTC），跳过（ONLY_MONDAY=true；手动触发不受此限）');
    return;
  }

  const t0 = Date.now();
  console.log('========== 源1→源2 对账同步 ' + bjNow() + (DRY_RUN ? ' [DRY_RUN 只读不写]' : '') + ' ==========');
  const summaries = [];
  let failed = false;
  // 定向跑单个配对：PAIR_KEY=xxx（沙箱覆盖模式除外，那时 PAIR_KEY 只用来隔离 KV 键）
  const pairs = (process.env.PAIR_KEY && !process.env.SRC_SS && !process.env.DST_SS)
    ? PAIRS.filter(p => p.key === process.env.PAIR_KEY) : PAIRS;
  if (!pairs.length) { console.log('❌ PAIR_KEY=' + process.env.PAIR_KEY + ' 没有匹配的配对'); process.exit(1); }
  for (const pair of pairs) {
    try {
      const s = await syncPair(pair);
      summaries.push(s);
      if (s.error) failed = true;
    } catch (e) {
      console.log('❌ 【' + pair.name + '】失败：' + e.message);
      summaries.push({ pair: pair.name, key: pair.key, error: e.message, srcRows: 0, dstRows: 0, add: 0, mod: 0, del: 0, imgUp: 0, imgSkip: 0, imgFail: 0, unkeyedSrc: 0, unkeyedDst: 0, dupKeys: 0, warn: [], backupKey: '', sec: 0 });
      failed = true;
    }
  }
  const totalSec = Math.round((Date.now() - t0) / 1000);
  console.log('\n========== 汇总（' + totalSec + ' 秒） ==========');
  summaries.forEach(s => console.log('  ' + (s.error ? '❌' : '✅') + ' ' + s.pair + '：源1 ' + s.srcRows + ' → 源2 ' + s.dstRows + '，➕' + s.add + ' ✏️' + s.mod + ' 🗑️' + s.del + (s.imgUp ? ' 🖼️' + s.imgUp : '') + (s.error ? '　' + s.error : '')));

  // 落盘报告（Actions artifact 用）
  try {
    fs.writeFileSync('qb-source-sync-report.json', JSON.stringify({ at: new Date().toISOString(), dryRun: DRY_RUN, totalSec, summaries }, null, 2));
  } catch (e) { console.log('⚠️ 报告落盘失败：' + e.message); }

  await sendCard(buildReportCard(summaries, totalSec));
  if (failed) process.exitCode = 1;
  console.log(DRY_RUN ? '🔍 DRY_RUN 结束（未写任何数据）' : '🎉 同步流程结束');
}

main().catch(e => { console.log('❌ 异常: ' + e.message); process.exit(1); });
