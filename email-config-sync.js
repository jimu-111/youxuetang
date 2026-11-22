/**
 * 邮箱配置同步（2026-11-22 建）
 *
 * 数据源：飞书 BzG8s8py3hDZIvtUJl7cRXJXnfe 的「邮箱管理」sheet（qCBZEl）
 *   列：A 姓名 | B 邮箱 | C 站点 | D 类型（员工/系统）| E 用途 | F 启用
 *
 * 做两件事：
 *   ① 类型=员工 → 写云端 personnelEmails（姓名→邮箱）
 *   ② 类型=系统 → 写云端 emailConfigData（反馈/报告/告警收件人）
 *
 * 安全闸门：表里员工邮箱为 0，或比云端现有少一半以上 → 中止（FORCE=1 可越过）。
 *
 * 手动：
 *   DRY_RUN=1 node email-config-sync.js
 *   FORCE=1 node email-config-sync.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const PAGES = 'https://yxt-feishu.pages.dev';
const APP_ID = 'cli_aab1fa4e87bbdbd3';
const SHEET_TOKEN = 'BzG8s8py3hDZIvtUJl7cRXJXnfe';
const SHEET_ID = 'qCBZEl';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';

const APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
  try { return fs.readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();
const page = (function () {
  try { return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); } catch (e) { return ''; }
})();
const SUPABASE_URL = (process.env.SUPABASE_URL || (page.match(/const SUPABASE_URL = '([^']+)'/) || [])[1] || '').replace(/\s/g, '').replace(/\/$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || (page.match(/const SUPABASE_KEY = '([^']+)'/) || [])[1] || '').replace(/\s/g, '');

function requestJson(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({}, (opts && opts.headers) || {});
    const body = opts && opts.body;
    if (body && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: (opts && opts.method) || 'GET', headers }, res => {
      let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, raw: d, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body); req.end();
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
      let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, raw: d, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body); req.end();
  });
}
async function getToken() {
  const a = await viaProxy('/auth/v3/tenant_access_token/internal', '', {
    method: 'POST',
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  if (!a.json || !a.json.tenant_access_token) throw new Error('飞书 token 获取失败: ' + a.status);
  return a.json.tenant_access_token;
}
function cellText(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c.trim();
  if (typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object') ? String(x.text || x.link || '') : String(x || '')).join('').trim();
  if (typeof c === 'object') return String(c.text || c.link || '').trim();
  return '';
}
async function readCloud(key) {
  const r = await requestJson(SUPABASE_URL + '/rest/v1/app_data?select=value&key=eq.' + encodeURIComponent(key), {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (r.status !== 200) throw new Error('读 ' + key + ' 失败 HTTP ' + r.status);
  return (Array.isArray(r.json) && r.json[0]) ? r.json[0].value : null;
}
async function writeCloud(key, value) {
  const r = await requestJson(SUPABASE_URL + '/rest/v1/app_data', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if (r.status >= 300) throw new Error('写 ' + key + ' 失败 HTTP ' + r.status + ' ' + String(r.raw).slice(0, 120));
}

(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('缺少 Supabase 配置');
  const tk = await getToken();
  const r = await viaProxy('/sheets/v2/spreadsheets/' + SHEET_TOKEN + '/values/' + SHEET_ID + '!A2:F500?majorDimension=ROWS', tk);
  if (!r.json || r.json.code !== 0) throw new Error('读飞书邮箱表失败: ' + r.status + ' ' + String(r.raw).slice(0, 160));
  const rows = (r.json.data && r.json.data.valueRange && r.json.data.valueRange.values) || [];

  const map = {}, sitesFromSheet = {}, feedback = [], issues = [];
  let reportEmail = '', alertEmail = '';
  rows.forEach((row, idx) => {
    const name = cellText(row[0]);
    const email = cellText(row[1]).replace(/^mailto:/i, '');
    const site = cellText(row[2]);
    const type = cellText(row[3]);
    const use = cellText(row[4]);
    const enabled = cellText(row[5]);
    if (!email && !name) return;
    if (!email || email.indexOf('@') < 0) {
      if (name) issues.push('第 ' + (idx + 2) + ' 行「' + name + '」邮箱为空或格式不对');
      return;
    }
    if (enabled === '否') return;
    if (type === '系统') {
      if (use.indexOf('反馈') >= 0) feedback.push(email);
      else if (use.indexOf('报告') >= 0 && !reportEmail) reportEmail = email;
      else if (use.indexOf('告警') >= 0 && !alertEmail) alertEmail = email;
      return;
    }
    if (name) { map[name] = email; if (site) sitesFromSheet[name] = site; }
  });

  const oldRaw = await readCloud('personnelEmails');
  let old = {};
  try { old = oldRaw ? JSON.parse(oldRaw) : {}; } catch (e) {}
  const oldSitesRaw = await readCloud('adminPersonSiteMap');
  let oldSites = {};
  try { oldSites = oldSitesRaw ? JSON.parse(oldSitesRaw) : {}; } catch (e) {}
  Object.keys(sitesFromSheet).forEach(n => { oldSites[n] = sitesFromSheet[n]; });
  const oldCount = Object.keys(old).length;
  const newCount = Object.keys(map).length;
  console.log('📧 飞书表员工邮箱 ' + newCount + ' 人（站点 ' + Object.keys(sitesFromSheet).length + ' 人），云端现有 ' + oldCount + ' 人；系统收件人：反馈 ' + feedback.length + '、报告 ' + (reportEmail ? 1 : 0) + '、告警 ' + (alertEmail ? 1 : 0));
  if (issues.length) console.log('⚠️ ' + issues.slice(0, 10).join('；') + (issues.length > 10 ? ' …' : ''));

  if (!newCount) throw new Error('表里没有员工邮箱，已中止（不会清空现有名单）');
  if (!FORCE && oldCount > 0 && newCount < Math.floor(oldCount * 0.5)) {
    throw new Error('员工邮箱从 ' + oldCount + ' 掉到 ' + newCount + '，少了一半以上，已中止；确认无误请用 FORCE=1');
  }

  const cfg = {
    feedbackRecipients: feedback,
    reportEmail: reportEmail || 'xuhang02@zhuanzhuan.com',
    alertEmail: alertEmail || 'xuhang02@zhuanzhuan.com',
    updatedAt: new Date().toISOString()
  };
  console.log('📨 系统收件人：' + JSON.stringify(cfg));
  if (DRY_RUN) {
    console.log('🧪 DRY_RUN：不写云端。示例：' + JSON.stringify(Object.entries(map).slice(0, 5)));
    return;
  }
  await writeCloud('personnelEmails', JSON.stringify(map));
  await writeCloud('emailConfigData', JSON.stringify(cfg));
  await writeCloud('adminPersonSiteMap', JSON.stringify(oldSites));
  console.log('✅ 已写云端 personnelEmails / emailConfigData / adminPersonSiteMap');
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
