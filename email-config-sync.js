/**
 * 邮箱通讯录同步（2026-11-28 改）
 *
 * 数据源：飞书通讯录「质量管理部」
 *   - 四个复核组：成都 / 青岛 / 深圳 / 郑州
 *   - 质量管理部直属人员
 *   - 质量运营组不写
 *   - 许伟明（上级部门）作为固定例外保留
 *
 * 结果：
 *   ① 写回飞书「邮箱管理」表 qCBZEl（员工行；系统收件人原样保留）
 *   ② 写云端 personnelEmails / adminPersonSiteMap / emailConfigData
 *   ③ 页面「人员变动」里已标记离职的人跳过，不再写回
 *
 * 时间：每周一 / 周四 / 周日 10:00（北京时间）
 *
 * 安全闸门：
 *   - 四个复核组任意一个读不到人 → 中止
 *   - 通讯录总人数比现有名单少 20% 以上 → 中止（FORCE=1 可越过）
 *   - 有邮箱的人数低于 80% → 中止
 *   - 飞书表写入失败 → 不写云端
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

const ROOT_DEPT_NAME = '质量管理部';
const EXPECTED_GROUPS = ['成都复核组', '青岛复核组', '深圳复核组', '郑州复核组'];
const SITE_ORDER = ['成都', '青岛', '深圳', '郑州', '直属', '上级部门'];
// 部直属里，四位复核组负责人按站点归属；其余直属人员写「直属」
const DIRECT_SITE_MAP = {
  '李玥': '青岛',
  '唐洲': '成都',
  '陈佳鹏': '深圳',
  '张振珀': '郑州',
  '吴尧飞': '直属'
};
// 通讯录范围外的固定例外；不参与部门同步，也不会被删
const EXTRA_PEOPLE = [
  { name: '许伟明', email: 'xuweiming01@zhuanzhuan.com', site: '直属', dept: '上级部门' }
];

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
async function feishuGet(tk, targetPath) {
  const r = await viaProxy(targetPath, tk);
  if (!r.json || r.json.code !== 0) throw new Error('飞书接口失败 ' + r.status + ' ' + String(r.raw).slice(0, 160));
  return r.json.data || {};
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

async function findRootDepartment(tk) {
  const scopes = await feishuGet(tk, '/contact/v3/scopes');
  const ids = scopes.department_ids || [];
  if (!ids.length) throw new Error('通讯录权限范围内没有部门，请检查飞书应用的通讯录权限');
  for (const id of ids) {
    const d = await feishuGet(tk, '/contact/v3/departments/' + encodeURIComponent(id) + '?department_id_type=open_department_id&user_id_type=open_id');
    const dep = d.department || {};
    if (dep.name === ROOT_DEPT_NAME) return dep;
  }
  throw new Error('通讯录权限范围内没找到「' + ROOT_DEPT_NAME + '」');
}
async function listChildren(tk, deptId) {
  let pageToken = '', all = [];
  do {
    const q = '/contact/v3/departments/' + encodeURIComponent(deptId) + '/children?department_id_type=open_department_id&page_size=50&user_id_type=open_id' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const d = await feishuGet(tk, q);
    all = all.concat(d.items || []);
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return all;
}
async function listUsers(tk, deptId) {
  let pageToken = '', all = [];
  do {
    const q = '/contact/v3/users/find_by_department?department_id=' + encodeURIComponent(deptId) + '&department_id_type=open_department_id&page_size=50&user_id_type=open_id' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const d = await feishuGet(tk, q);
    all = all.concat(d.items || []);
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return all;
}
function addPerson(people, person, issues) {
  if (!person.name) { issues.push('有成员没有姓名，已跳过'); return; }
  const old = people[person.name];
  if (old) {
    if (old.email !== person.email) issues.push('「' + person.name + '」出现两次且邮箱不同：' + old.email + ' / ' + person.email);
    return;
  }
  people[person.name] = person;
}
async function readSheetRows(tk) {
  const r = await viaProxy('/sheets/v2/spreadsheets/' + SHEET_TOKEN + '/values/' + SHEET_ID + '!A2:F300?majorDimension=ROWS', tk);
  if (!r.json || r.json.code !== 0) throw new Error('读飞书邮箱表失败: ' + r.status + ' ' + String(r.raw).slice(0, 160));
  return (r.json.data && r.json.data.valueRange && r.json.data.valueRange.values) || [];
}

(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('缺少 Supabase 配置');
  const tk = await getToken();

  // 1. 通讯录：质量管理部 + 四个复核组
  const root = await findRootDepartment(tk);
  const children = await listChildren(tk, root.open_department_id);
  const groupDepts = children.filter(d => EXPECTED_GROUPS.indexOf(d.name) >= 0);
  const foundNames = groupDepts.map(d => d.name).sort();
  const expectedNames = EXPECTED_GROUPS.slice().sort();
  if (JSON.stringify(foundNames) !== JSON.stringify(expectedNames)) {
    throw new Error('复核组不完整：读到 ' + foundNames.join('、') + '，应为 ' + expectedNames.join('、'));
  }

  const people = {};
  const issues = [];
  let groupTotal = 0;
  for (const g of groupDepts) {
    const site = g.name.replace(/复核组$/, '');
    const users = await listUsers(tk, g.open_department_id);
    if (!users.length) throw new Error('「' + g.name + '」没有读到人，已中止（不会清空现有名单）');
    groupTotal += users.length;
    users.forEach(u => addPerson(people, {
      name: String(u.name || '').trim(),
      email: String(u.email || u.enterprise_email || '').trim(),
      site: site,
      dept: g.name
    }, issues));
  }

  const directUsers = await listUsers(tk, root.open_department_id);
  if (!directUsers.length) throw new Error('质量管理部直属人员没有读到，已中止');
  directUsers.forEach(u => {
    const name = String(u.name || '').trim();
    addPerson(people, {
      name: name,
      email: String(u.email || u.enterprise_email || '').trim(),
      site: DIRECT_SITE_MAP[name] || '直属',
      dept: '质量管理部'
    }, issues);
  });

  // 2. 固定例外（上级部门许伟明）
  EXTRA_PEOPLE.forEach(p => addPerson(people, Object.assign({}, p), issues));

  // 3. 页面「人员变动」里已标记离职的人，即使通讯录还没移除，也不再同步
  let departed = {};
  try { departed = JSON.parse(await readCloud('departedReviewers') || '{}'); } catch (e) {}
  const skippedDeparted = [];
  Object.keys(people).forEach(n => {
    if (departed && departed[n]) {
      skippedDeparted.push(n);
      delete people[n];
    }
  });

  const names = Object.keys(people);
  const withEmail = names.filter(n => people[n].email && people[n].email.indexOf('@') > 0);
  const missingEmail = names.filter(n => !people[n].email || people[n].email.indexOf('@') < 0);
  const newCount = names.length;
  if (!newCount) throw new Error('通讯录里没有可同步的员工，已中止');
  if (missingEmail.length > Math.floor(newCount * 0.2)) {
    throw new Error('没有邮箱的人太多（' + missingEmail.length + '/' + newCount + '），已中止');
  }
  if (!withEmail.length) throw new Error('通讯录里没有可用邮箱，已中止');

  // 3. 读现有飞书表和云端，做安全闸门与差异统计
  const sheetRows = await readSheetRows(tk);
  const systemRows = [];
  const oldSheet = {};
  sheetRows.forEach(r => {
    const name = cellText(r[0]);
    const email = cellText(r[1]).replace(/^mailto:/i, '');
    const site = cellText(r[2]);
    const type = cellText(r[3]);
    const use = cellText(r[4]);
    const enabled = cellText(r[5]) || '是';
    if (type === '系统') {
      if (email && email.indexOf('@') >= 0) systemRows.push([name, email, site, '系统', use, enabled]);
      return;
    }
    if (name && email && email.indexOf('@') >= 0) oldSheet[name] = { email: email, site: site };
  });

  let cloudOld = {};
  try { cloudOld = JSON.parse(await readCloud('personnelEmails') || '{}'); } catch (e) {}
  const oldCount = Math.max(Object.keys(oldSheet).length, Object.keys(cloudOld).length);
  if (!FORCE && oldCount > 0 && newCount < Math.floor(oldCount * 0.8)) {
    throw new Error('通讯录人数从 ' + oldCount + ' 掉到 ' + newCount + '，少了两成以上，已中止；确认无误请用 FORCE=1');
  }

  const added = names.filter(n => !oldSheet[n]);
  const removed = Object.keys(oldSheet).filter(n => !people[n]);
  const emailChanged = names.filter(n => oldSheet[n] && oldSheet[n].email !== people[n].email);
  const siteChanged = names.filter(n => oldSheet[n] && oldSheet[n].site !== people[n].site);

  // 4. 生成飞书表数据（系统收件人放最前面，保持原表结构）
  const siteIndex = {};
  SITE_ORDER.forEach((s, i) => { siteIndex[s] = i; });
  const sortedNames = names.slice().sort((a, b) => {
    const sa = siteIndex[people[a].site] === undefined ? 99 : siteIndex[people[a].site];
    const sb = siteIndex[people[b].site] === undefined ? 99 : siteIndex[people[b].site];
    return sa - sb || a.localeCompare(b, 'zh');
  });
  const out = [['姓名', '邮箱', '站点', '类型', '用途', '启用']];
  systemRows.forEach(r => out.push(r));
  sortedNames.forEach(n => out.push([n, people[n].email, people[n].site, '员工', '员工邮箱', '是']));
  while (out.length < 200) out.push(['', '', '', '', '', '']);

  const curOut = [['姓名', '邮箱', '站点', '类型', '用途', '启用']];
  sheetRows.forEach(r => {
    const row = [0, 1, 2, 3, 4, 5].map(i => cellText(r[i]));
    if (row.some(x => x)) curOut.push(row);
  });
  while (curOut.length < out.length) curOut.push(['', '', '', '', '', '']);
  const changed = JSON.stringify(curOut) !== JSON.stringify(out);

  const siteCount = {};
  names.forEach(n => { siteCount[people[n].site] = (siteCount[people[n].site] || 0) + 1; });
  console.log('📇 通讯录：复核组 ' + groupTotal + ' 人 + 直属 ' + directUsers.length + ' 人 + 例外 ' + EXTRA_PEOPLE.length + ' 人 = ' + newCount + ' 人');
  console.log('   站点分布：' + Object.keys(siteCount).sort((a, b) => (siteIndex[a] === undefined ? 99 : siteIndex[a]) - (siteIndex[b] === undefined ? 99 : siteIndex[b])).map(s => s + ' ' + siteCount[s]).join(' / '));
  console.log('   质量运营组：已排除');
  if (skippedDeparted.length) console.log('   已按人员变动离职标记跳过：' + skippedDeparted.join('、'));
  console.log('📧 对比现有表：新增 ' + added.length + '、移除 ' + removed.length + '、改邮箱 ' + emailChanged.length + '、改站点 ' + siteChanged.length + (changed ? '（表需要更新）' : '（表无变化）'));
  if (added.length) console.log('   ➕ 新增：' + added.slice(0, 12).join('、') + (added.length > 12 ? ' …' : ''));
  if (removed.length) console.log('   ➖ 移除：' + removed.slice(0, 12).join('、') + (removed.length > 12 ? ' …' : ''));
  if (missingEmail.length) console.log('⚠️ 没有邮箱：' + missingEmail.slice(0, 10).join('、') + (missingEmail.length > 10 ? ' …' : ''));
  if (issues.length) console.log('⚠️ ' + issues.slice(0, 10).join('；') + (issues.length > 10 ? ' …' : ''));

  const cfg = (function () {
    const feedback = [], report = [], alert = [];
    systemRows.forEach(r => {
      const use = r[4], email = r[1];
      if (use.indexOf('反馈') >= 0) feedback.push(email);
      else if (use.indexOf('报告') >= 0) report.push(email);
      else if (use.indexOf('告警') >= 0) alert.push(email);
    });
    return {
      feedbackRecipients: feedback,
      reportEmail: report[0] || (systemRows[0] && systemRows[0][1]) || 'xuhang02@zhuanzhuan.com',
      alertEmail: alert[0] || (systemRows[0] && systemRows[0][1]) || 'xuhang02@zhuanzhuan.com',
      updatedAt: new Date().toISOString()
    };
  })();

  if (DRY_RUN) {
    console.log('🧪 DRY_RUN：不写飞书、不写云端。前 5 条：');
    console.log(JSON.stringify(out.slice(1, 6), null, 2));
    return;
  }

  // 5. 先写飞书表；失败就不动云端
  if (changed) {
    const writeUrl = '/sheets/v2/spreadsheets/' + SHEET_TOKEN + '/values_batch_update';
    const wr = await viaProxy(writeUrl, tk, {
      method: 'POST',
      body: JSON.stringify({ valueRanges: [{ range: SHEET_ID + '!A1:F200', values: out }] })
    });
    if (!wr.json || wr.json.code !== 0) throw new Error('写飞书邮箱表失败: ' + wr.status + ' ' + String(wr.raw).slice(0, 160));
    console.log('✅ 已写回飞书邮箱表');
  } else {
    console.log('ℹ️ 飞书邮箱表无变化，跳过写入');
  }

  // 6. 写云端（personnelEmails 只存姓名→邮箱，和页面现有格式一致）
  const emailMap = {};
  const siteMap = {};
  sortedNames.forEach(n => {
    emailMap[n] = people[n].email;
    siteMap[n] = people[n].site;
  });
  await writeCloud('personnelEmails', JSON.stringify(emailMap));
  await writeCloud('adminPersonSiteMap', JSON.stringify(siteMap));
  await writeCloud('emailConfigData', JSON.stringify(cfg));
  console.log('✅ 已写云端 personnelEmails / adminPersonSiteMap / emailConfigData');
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
