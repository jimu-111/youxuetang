/**
 * 推送前邮箱校准（2026-11-22 建）
 *
 * 读飞书 BzG8… / qCBZEl「邮箱管理」：
 *   - 员工邮箱 → personnelEmails
 *   - 站点 → adminPersonSiteMap
 *   - 系统行（反馈/报告/告警）→ emailConfigData
 *
 * 用法：
 *   const { loadEmailConfig } = require('./email-calibrate');
 *   const cal = await loadEmailConfig();       // 成功会顺手写云端；失败回退云端缓存
 *   cal.emails / cal.sites / cal.config / cal.source
 *
 * 可选：{ noWrite: true } 只读不写云端。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const PAGES = 'https://yxt-feishu.pages.dev';
const APP_ID = 'cli_aab1fa4e87bbdbd3';
const SHEET_TOKEN = 'BzG8s8py3hDZIvtUJl7cRXJXnfe';
const SHEET_ID = 'qCBZEl';

const APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
  try { return fs.readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();
const pageHtml = (function () {
  try { return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); } catch (e) { return ''; }
})();
const SUPABASE_URL = (process.env.SUPABASE_URL || (pageHtml.match(/const SUPABASE_URL = '([^']+)'/) || [])[1] || '').replace(/\s/g, '').replace(/\/$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || (pageHtml.match(/const SUPABASE_KEY = '([^']+)'/) || [])[1] || '').replace(/\s/g, '');
const FALLBACK_REPORT = 'xuhang02@zhuanzhuan.com';

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
  if (!a.json || !a.json.tenant_access_token) throw new Error('飞书 token 获取失败 HTTP ' + a.status);
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
function parseRows(rows) {
  const emails = {}, sites = {}, feedback = [];
  let reportEmail = '', alertEmail = '';
  (rows || []).forEach(r => {
    const name = cellText(r[0]);
    const email = cellText(r[1]).replace(/^mailto:/i, '');
    const site = cellText(r[2]);
    const type = cellText(r[3]);
    const use = cellText(r[4]);
    const enabled = cellText(r[5]);
    if (enabled === '否') return;
    if (type === '系统') {
      if (!email || email.indexOf('@') < 0) return;
      if (use.indexOf('反馈') >= 0) feedback.push(email);
      else if (use.indexOf('报告') >= 0 && !reportEmail) reportEmail = email;
      else if (use.indexOf('告警') >= 0 && !alertEmail) alertEmail = email;
      return;
    }
    if (name && site) sites[name] = site;
    if (name && email && email.indexOf('@') >= 0) emails[name] = email;
  });
  return {
    emails,
    sites,
    config: {
      feedbackRecipients: feedback,
      reportEmail: reportEmail || FALLBACK_REPORT,
      alertEmail: alertEmail || FALLBACK_REPORT,
      updatedAt: new Date().toISOString()
    }
  };
}
async function readCloud(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await requestJson(SUPABASE_URL + '/rest/v1/app_data?select=value&key=eq.' + encodeURIComponent(key), {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  return (r.status === 200 && Array.isArray(r.json) && r.json[0]) ? r.json[0].value : null;
}
async function writeCloud(key, value) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  await requestJson(SUPABASE_URL + '/rest/v1/app_data', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
}
function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
async function loadEmailConfig(opts) {
  opts = opts || {};
  try {
    const tk = await getToken();
    const r = await viaProxy('/sheets/v2/spreadsheets/' + SHEET_TOKEN + '/values/' + SHEET_ID + '!A2:F500?majorDimension=ROWS', tk);
    if (!r.json || r.json.code !== 0) throw new Error('读飞书表失败 ' + r.status);
    const rows = (r.json.data && r.json.data.valueRange && r.json.data.valueRange.values) || [];
    const parsed = parseRows(rows);
    const newCount = Object.keys(parsed.emails).length;
    if (!newCount) throw new Error('表里没有员工邮箱');
    const oldRaw = await readCloud('personnelEmails');
    const oldCount = Object.keys(parseJson(oldRaw, {})).length;
    if (oldCount > 0 && newCount < Math.floor(oldCount * 0.5)) {
      throw new Error('员工邮箱从 ' + oldCount + ' 掉到 ' + newCount + '，少了一半以上');
    }
    if (!opts.noWrite) {
      try {
        const oldSites = parseJson(await readCloud('adminPersonSiteMap'), {});
        const oldSitesCount = Object.keys(oldSites).length;
        const newSitesCount = Object.keys(parsed.sites).length;
        const finalSites = (newSitesCount && (!oldSitesCount || newSitesCount >= Math.floor(oldSitesCount * 0.5))) ? parsed.sites : oldSites;
        await Promise.all([
          writeCloud('personnelEmails', JSON.stringify(parsed.emails)),
          writeCloud('adminPersonSiteMap', JSON.stringify(finalSites)),
          writeCloud('emailConfigData', JSON.stringify(parsed.config))
        ]);
      } catch (e) { console.log('  ⚠️ 邮箱校准写云端失败（继续用飞书最新值）：' + e.message); }
    }
    return Object.assign({ source: 'feishu' }, parsed);
  } catch (e) {
    console.log('  ⚠️ 推送前邮箱校准失败，回退云端缓存：' + e.message);
    try {
      const [emailsRaw, sitesRaw, configRaw] = await Promise.all([
        readCloud('personnelEmails'), readCloud('adminPersonSiteMap'), readCloud('emailConfigData')
      ]);
      return {
        source: 'cloud',
        emails: parseJson(emailsRaw, {}),
        sites: parseJson(sitesRaw, {}),
        config: parseJson(configRaw, {
          feedbackRecipients: [FALLBACK_REPORT],
          reportEmail: FALLBACK_REPORT,
          alertEmail: FALLBACK_REPORT
        })
      };
    } catch (e2) {
      return {
        source: 'fallback',
        emails: {}, sites: {},
        config: { feedbackRecipients: [FALLBACK_REPORT], reportEmail: FALLBACK_REPORT, alertEmail: FALLBACK_REPORT }
      };
    }
  }
}
module.exports = { loadEmailConfig };
