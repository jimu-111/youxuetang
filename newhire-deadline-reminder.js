/**
 * 新人纳期提醒（2026-11-21 建）
 *
 * 每天 09:30（北京时间）由 GitHub Actions 跑：
 *   ① 读云端 trainee_full_admin_backup（学员）、siteConfigData（站点/负责人）、
 *      newhireDeadlineConfig（纳期天数）、personnelEmails（姓名→邮箱）；
 *   ② 按「当前阶段开始日 + 第几天」算每一项的纳期；
 *   ③ 到期当天发一次；逾期后发一次（不重复）；
 *   ④ 收件人 = 站点负责人 + 学员本人（有邮箱才发）；
 *   ⑤ 发送记录写 newhireDeadlineReminders，避免重复。
 *
 * 手动用法：
 *   DRY_RUN=1 node newhire-deadline-reminder.js   # 只打印计划，不发消息、不写记录
 *   node newhire-deadline-reminder.js             # 正常发送
 *
 * 密钥：FEISHU_APP_SECRET 由 GitHub Actions Secrets 注入；本机测试可读
 *   C:/Users/xuhan/yxt/feishu-secret.txt。Supabase 地址/密钥从 index.html 读。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const PAGES = 'https://yxt-feishu.pages.dev';
const APP_ID = 'cli_aab1fa4e87bbdbd3';
const SITE_URL = process.env.SITE_URL || 'https://jimu-111.github.io/youxuetang/';
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'xuhang02@zhuanzhuan.com';
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';
const RUN_URL = process.env.RUN_URL || '';

const APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
  try { return fs.readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();

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

// ---------------- 默认配置（与页面 index.html 保持一致） ----------------
const DEFAULT_SITES = [
  { name: '成都', icon: '🐼', color: '#f0fdf4', supervisor: '徐行', supervisorEmail: '', enabled: true },
  { name: '青岛', icon: '🌊', color: '#eff6ff', supervisor: '孙伟', supervisorEmail: '', enabled: true },
  { name: '深圳', icon: '📱', color: '#fefce8', supervisor: '孙俊', supervisorEmail: '', enabled: true }
];
const DEFAULT_STAGES = {
  '0': { limitDays: 5, items: [
    { key: 'theory', label: '理论学习', offsetDays: 2 },
    { key: 'online', label: '线上考试', offsetDays: 4 },
    { key: 'practical', label: '实操考试', offsetDays: 5 }
  ]},
  '1': { limitDays: 5, items: [
    { key: 'manhattan', label: '曼哈顿系统', offsetDays: 2 },
    { key: 'athena', label: '雅典娜系统', offsetDays: 3 },
    { key: 'responsibility', label: '责任方详解', offsetDays: 4 },
    { key: 'judgment', label: '判责详解', offsetDays: 5 }
  ]},
  '2': { limitDays: 2, items: [{ key: 'fullCheck', label: '实操全检考试', offsetDays: 2 }] },
  '3': { limitDays: 2, items: [{ key: 'mock', label: '模拟判责', offsetDays: 2 }] },
  '4': { limitDays: 42, items: [{ key: 'formal', label: '正式判责', offsetDays: 42 }] }
};
const STAGE_NAMES = ['一、学习地图SOP', '二、师傅带教', '三、实操全检考试', '四、模拟判责', '五、正式判责'];

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

// ---------------- 飞书 ----------------
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

async function sendMessage(email, card) {
  const token = await getTenantToken();
  const r = await viaProxy('/im/v1/messages?receive_id_type=email', token, {
    method: 'POST',
    body: JSON.stringify({ receive_id: email, msg_type: 'interactive', content: JSON.stringify(card) })
  });
  if (!r.json || r.json.code !== 0) {
    throw new Error('发送失败 ' + email + ': ' + r.status + ' ' + String(r.raw).slice(0, 200));
  }
  return r.json;
}

// ---------------- 云端读写 ----------------
async function readCloud(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('缺少 SUPABASE_URL / SUPABASE_KEY');
  const r = await requestJson(SUPABASE_URL + '/rest/v1/app_data?select=value&key=eq.' + encodeURIComponent(key), {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (r.status !== 200) throw new Error('读 ' + key + ' 失败: HTTP ' + r.status + ' ' + String(r.raw).slice(0, 120));
  if (!Array.isArray(r.json) || !r.json.length) return null;
  return r.json[0].value;
}

async function writeCloud(key, value) {
  const r = await requestJson(SUPABASE_URL + '/rest/v1/app_data', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if (r.status >= 300) throw new Error('写 ' + key + ' 失败: HTTP ' + r.status + ' ' + String(r.raw).slice(0, 120));
}

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

// ---------------- 日期 ----------------
function pad(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function parseDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function addDays(s, n) {
  const t = parseDate(s);
  if (t === null) return null;
  const d = new Date(t + Number(n || 0) * 86400000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function diffDays(due, today) {
  const a = parseDate(due), b = parseDate(today);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86400000);
}
function shortDate(s) { return String(s || '').slice(5); }

// ---------------- 配置解析 ----------------
function normalizeSites(raw) {
  const c = parseJson(raw, null);
  if (c && Array.isArray(c.sites) && c.sites.length) {
    const out = [], seen = {};
    c.sites.forEach(s => {
      if (!s || typeof s !== 'object') return;
      const name = String(s.name || '').trim();
      if (!name || seen[name]) return;
      seen[name] = 1;
      out.push({
        name,
        icon: String(s.icon || '📍').trim() || '📍',
        supervisor: String(s.supervisor || '').trim(),
        supervisorEmail: String(s.supervisorEmail || '').trim(),
        enabled: s.enabled !== false
      });
    });
    if (out.length) return out;
  }
  return DEFAULT_SITES.slice();
}

function normalizeStages(raw) {
  const c = parseJson(raw, null);
  const out = {};
  Object.keys(DEFAULT_STAGES).forEach(sid => {
    const def = DEFAULT_STAGES[sid];
    const cur = c && c.stages && c.stages[sid] ? c.stages[sid] : {};
    const items = Array.isArray(cur.items) && cur.items.length ? cur.items : def.items;
    out[sid] = {
      limitDays: Math.max(1, parseInt(cur.limitDays, 10) || def.limitDays),
      items: items.map((it, idx) => {
        const di = def.items[idx] || def.items[0] || {};
        return {
          key: String(it.key || di.key || ('item' + idx)),
          label: String(it.label || di.label || ('项目' + (idx + 1))),
          offsetDays: Math.max(0, parseInt(it.offsetDays, 10) || 0)
        };
      })
    };
  });
  return out;
}

// ---------------- 纳期计算 ----------------
function isPassed(student, stageId, key) {
  const sp = student.stageProgress || {};
  if (stageId === 0) return !!sp[key + 'Passed'];
  if (stageId === 1) return !!sp.mentorComplete || !!sp[key];
  if (stageId === 2) return !!sp.fullCheckPassed;
  if (stageId === 3) return !!sp.mockPassed;
  if (stageId === 4) return !!sp.graduatedFormal;
  return false;
}

function collectStudentItems(student, stages, today) {
  const stageId = Number(student.stage);
  if (!(stageId >= 0 && stageId <= 4)) return [];
  if (student.graduatedToArchive) return [];
  const sp = student.stageProgress || {};
  if (sp.graduatedFormal) return [];
  const stage = stages[String(stageId)];
  if (!stage) return [];
  const start = student.stageStartDate || student.joinDate;
  if (!start) return [];
  const out = [];
  stage.items.forEach(item => {
    if (isPassed(student, stageId, item.key)) return;
    const due = addDays(start, item.offsetDays);
    if (!due) return;
    const diff = diffDays(due, today);
    if (diff === null) return;
    if (diff === 0) out.push({ item, due, diff, type: 'due' });
    else if (diff < 0) out.push({ item, due, diff, type: 'overdue' });
  });
  return out;
}

// ---------------- 发送记录 ----------------
function sentKey(student, stageId, item, type, due) {
  return type === 'overdue'
    ? String(student.id) + '_' + stageId + '_' + item.key + '_overdue'
    : String(student.id) + '_' + stageId + '_' + item.key + '_due_' + due;
}
function sentKeyFor(sentMap, base, who) { return base + '_' + who; }

function cleanSent(sent, today) {
  const cutoff = addDays(today, -180);
  const out = {};
  Object.keys(sent || {}).forEach(k => {
    const v = String(sent[k] || '');
    if (v && v >= cutoff) out[k] = v;
  });
  return out;
}

// ---------------- 卡片 ----------------
function itemsText(items) {
  return items.map(x => {
    const status = x.type === 'overdue'
      ? '已逾期 ' + Math.abs(x.diff) + ' 天'
      : '今天到期';
    return '• **' + x.item.label + '**：纳期 ' + shortDate(x.due) + '，' + status;
  }).join('\n');
}

function cardForSupervisor(student, site, items) {
  const hasOverdue = items.some(x => x.type === 'overdue');
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: (hasOverdue ? '⚠️ ' : '📅 ') + '新人纳期提醒' }, template: hasOverdue ? 'red' : 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**' + student.name + '**（' + (student.site || '') + '）· ' + (STAGE_NAMES[Number(student.stage)] || ('阶段' + (Number(student.stage) + 1))) + '\n' + itemsText(items) } },
      { tag: 'div', text: { tag: 'lark_md', content: '站点负责人：' + (site && site.supervisor ? site.supervisor : '未配置') + '，请跟进。' } },
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开优学堂' }, type: 'primary', url: SITE_URL }] }
    ].concat(RUN_URL ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: '运行日志：' + RUN_URL }] }] : [])
  };
}

function cardForStudent(student, items) {
  const hasOverdue = items.some(x => x.type === 'overdue');
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: (hasOverdue ? '⚠️ ' : '📅 ') + '你的新人培养纳期' }, template: hasOverdue ? 'red' : 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**' + student.name + '**（' + (student.site || '') + '）\n' + itemsText(items) } },
      { tag: 'div', text: { tag: 'lark_md', content: '请按纳期完成；如果有特殊情况，请联系站点负责人。' } },
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开优学堂' }, type: 'primary', url: SITE_URL }] }
    ]
  };
}

// ---------------- 主流程 ----------------
async function main() {
  const today = todayStr();
  console.log('📅 新人纳期检查 ' + today + (DRY_RUN ? '（DRY_RUN，只读）' : ''));

  const [studentsRaw, sitesRaw, stagesRaw, emailsRaw, sentRaw] = await Promise.all([
    readCloud('trainee_full_admin_backup'),
    readCloud('siteConfigData'),
    readCloud('newhireDeadlineConfig'),
    readCloud('personnelEmails'),
    readCloud('newhireDeadlineReminders')
  ]);

  const students = parseJson(studentsRaw, []);
  const sites = normalizeSites(sitesRaw);
  const stages = normalizeStages(stagesRaw);
  const emails = parseJson(emailsRaw, {});
  const sent = cleanSent(parseJson(sentRaw, {}), today);

  if (!Array.isArray(students) || !students.length) {
    console.log('⚠️ 云端没有学员数据（trainee_full_admin_backup），本次不发送');
    return;
  }

  let dueCount = 0, overdueCount = 0, sentCards = 0, skipped = 0, failed = 0;
  let sentChanged = false;

  for (const student of students) {
    if (!student || !student.name) continue;
    const items = collectStudentItems(student, stages, today);
    if (!items.length) continue;

    const site = sites.find(s => s.name === student.site) || null;
    if (site && site.enabled === false) {
      console.log('  ⏭️ ' + student.name + '（' + student.site + '）站点已停用，跳过提醒');
      continue;
    }
    const supervisorName = site ? site.supervisor : '';
    const supervisorEmail = (site && site.supervisorEmail) || (supervisorName ? emails[supervisorName] : '') || '';
    const studentEmail = emails[student.name] || '';
    const stageId = Number(student.stage);

    // 按收件人分别判断哪些 item 还没发过
    const supItems = items.filter(x => {
      const base = sentKey(student, stageId, x.item, x.type, x.due);
      return !sent[sentKeyFor(sent, base, 'sup')];
    });
    const stuItems = items.filter(x => {
      const base = sentKey(student, stageId, x.item, x.type, x.due);
      return !sent[sentKeyFor(sent, base, 'stu')];
    });

    if (!supItems.length && !stuItems.length) continue;

    if (supItems.length) {
      dueCount += supItems.filter(x => x.type === 'due').length;
      overdueCount += supItems.filter(x => x.type === 'overdue').length;
      if (!supervisorEmail) {
        console.log('  ⚠️ ' + student.name + '（' + student.site + '）没有站点负责人邮箱，跳过负责人提醒');
        skipped++;
      } else if (DRY_RUN) {
        console.log('  [DRY-负责人] ' + student.name + ' → ' + supervisorName + ' <' + supervisorEmail + '>：' + supItems.map(x => x.item.label + '(' + x.type + ',' + x.due + ')').join('；'));
      } else {
        try {
          await sendMessage(supervisorEmail, cardForSupervisor(student, site, supItems));
          supItems.forEach(x => {
            const base = sentKey(student, stageId, x.item, x.type, x.due);
            sent[sentKeyFor(sent, base, 'sup')] = today;
          });
          sentCards++;
          sentChanged = true;
          console.log('  ✅ 负责人 ' + supervisorName + ' <' + supervisorEmail + '>：' + student.name + ' ' + supItems.length + ' 项');
        } catch (e) {
          failed++;
          console.log('  ❌ 负责人发送失败 ' + student.name + '：' + e.message);
        }
      }
    }

    if (stuItems.length) {
      if (!studentEmail) {
        console.log('  ⚠️ ' + student.name + ' 没有邮箱，跳过学员本人提醒');
        skipped++;
      } else if (DRY_RUN) {
        console.log('  [DRY-学员] ' + student.name + ' <' + studentEmail + '>：' + stuItems.map(x => x.item.label + '(' + x.type + ',' + x.due + ')').join('；'));
      } else {
        try {
          await sendMessage(studentEmail, cardForStudent(student, stuItems));
          stuItems.forEach(x => {
            const base = sentKey(student, stageId, x.item, x.type, x.due);
            sent[sentKeyFor(sent, base, 'stu')] = today;
          });
          sentCards++;
          sentChanged = true;
          console.log('  ✅ 学员 ' + student.name + ' <' + studentEmail + '>：' + stuItems.length + ' 项');
        } catch (e) {
          failed++;
          console.log('  ❌ 学员发送失败 ' + student.name + '：' + e.message);
        }
      }
    }
  }

  if (!DRY_RUN && sentChanged) {
    await writeCloud('newhireDeadlineReminders', JSON.stringify(cleanSent(sent, today)));
    console.log('💾 发送记录已写回云端');
  }

  console.log('📊 汇总：到期 ' + dueCount + ' 项，逾期 ' + overdueCount + ' 项，发送 ' + sentCards + ' 张卡片，跳过 ' + skipped + '，失败 ' + failed);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async function (e) {
    console.error('❌ 纳期提醒失败：' + e.message);
    if (!DRY_RUN) {
      try {
        await sendMessage(REPORT_EMAIL, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '⚠️ 新人纳期提醒未跑完' }, template: 'red' },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: '纳期提醒脚本异常退出：' + e.message + '\n请查看运行日志。云端发送记录没有被修改。' } }]
        });
      } catch (e2) { console.log('⚠️ 失败告警也没发出去：' + e2.message); }
    }
    process.exit(1);
  });
}

module.exports = {
  collectStudentItems,
  normalizeStages,
  normalizeSites,
  addDays,
  diffDays,
  todayStr,
  cardForSupervisor,
  cardForStudent
};
