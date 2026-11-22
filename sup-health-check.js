#!/usr/bin/env node
const { loadEmailConfig } = require('./email-calibrate');
// Supabase 探活 —— 每天 10:00 / 14:00 / 18:00 / 22:00 各跑一次（Windows 计划任务「Supabase探活」）
// 出问题发飞书私聊；**只在「状态变化」时才发**，不会刷屏。
//
// 为什么要有这个（2026-09-20 建）：
//   2026-09 初 Supabase 免费额度（出站流量）烧穿被停，页面所有云端同步**静默失败**了一整周，
//   直到收到官方邮件才知道。这个脚本补上「坏了立刻知道」这一环。
//
// ⚠️ 探的是「还能不能用」，不是「用了多少 GB」—— Supabase 官方**没有**开放查流量的接口
//    （Management API 里没有返回 egress 字节数的 endpoint；绕道查日志还要按扫描量计费）。
//    用量数字只能去控制台看：Project Settings → Billing → Usage，或 Reports → Database → Data Transfer。
//
// 用法：
//   node sup-health-check.js          正常探测（计划任务跑的就是这个）
//   node sup-health-check.js --test   只发一条测试卡片，确认告警通道通不通
//
// 凭据来源（本文件不新增任何密钥副本，都是单一来源）：
//   · Supabase 地址/密钥 → 从 index.html 里读
//   · 飞书应用凭据       → 从 qb-weekly-sync.js 里读（应用身份，凭据不过期）

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), 'Desktop', '新建文件夹');
const STATE_FILE = path.join(DIR, 'sup-health-state.json');
const LOG_FILE = path.join(DIR, 'sup-health-log.txt');
const ALERT_EMAIL = 'xuhang02@zhuanzhuan.com';
const TIMEOUT_MS = 20000;
const SH = { timeZone: 'Asia/Shanghai', hour12: false };

function nowText() { return new Date().toLocaleString('zh-CN', SH); }
function log(line) {
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, '[' + nowText() + '] ' + line + '\n'); } catch (e) {}
}

// ── 凭据：都从既有文件里读 ──
function readCreds() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const m1 = html.match(/const SUPABASE_URL\s*=\s*'([^']+)'/);
  const m2 = html.match(/const SUPABASE_KEY\s*=\s*'([^']+)'/);
  if (!m1 || !m2) throw new Error('从 index.html 里读不到 Supabase 地址或密钥（是不是被改过写法了？）');
  const qb = fs.readFileSync(path.join(DIR, 'qb-weekly-sync.js'), 'utf8');
  const m3 = qb.match(/const APP_ID\s*=\s*'([^']+)'/);
  // 2026-09-20：应用密钥不再从 qb-weekly-sync.js 里正则抠了 —— 那边已改成不写明文（它进了公开仓库），
  // 抠不到。改读本地密钥文件。
  // ⚠️ 别改回去「从脚本里抠密钥」：那边现在是空的，抠到的会是空串，本脚本会**静默失效**——
  //    而它就是那个「Supabase 又挂了没人知道」的告警，失效等于没建。
  let appSecret = '';
  try { appSecret = fs.readFileSync(path.join(os.homedir(), 'yxt', 'feishu-secret.txt'), 'utf8').trim(); } catch (e) {}
  if (!m3 || !appSecret) throw new Error('读不到飞书应用凭据：App ID 从 qb-weekly-sync.js 读，密钥读 C:\\Users\\xuhan\\yxt\\feishu-secret.txt');
  return { SUPA_URL: m1[1], SUPA_KEY: m2[1], APP_ID: m3[1], APP_SECRET: appSecret };
}

// ── 极简 HTTP ──
function req(urlStr, opts) {
  return new Promise(resolve => {
    const u = new URL(urlStr);
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || {},
      timeout: TIMEOUT_MS
    }, s => {
      let d = '';
      s.on('data', c => d += c);
      s.on('end', () => fin({ code: s.statusCode, raw: d }));
    });
    r.on('timeout', () => { r.destroy(); fin({ code: 0, raw: '请求超时（' + (TIMEOUT_MS / 1000) + ' 秒没回应）' }); });
    r.on('error', e => fin({ code: 0, raw: '连不上：' + e.message }));
    if (opts && opts.body) r.write(opts.body);
    r.end();
  });
}

// ── 探活：一个极小的请求（一行数据，几十字节）──
async function probe(c) {
  const r = await req(c.SUPA_URL + '/rest/v1/app_data?select=key&limit=1', {
    headers: { 'apikey': c.SUPA_KEY, 'Authorization': 'Bearer ' + c.SUPA_KEY }
  });
  if (r.code === 200) return { state: 'ok', detail: '' };
  if (r.code === 402) return { state: 'bad', detail: '**配额用超了**（Supabase 返回 402）\n\n云端同步已经全部失效 —— 页面上谁改东西都同步不出去（本机照常能用，页面会自己兜底）。\n去控制台 **Billing → Usage** 看是哪个额度爆了（多半是出站流量 Egress）。' };
  if (r.code === 401 || r.code === 403) return { state: 'bad', detail: '**密钥不对了**（HTTP ' + r.code + '）\n\n可能是 Supabase 的 anon key 被重置过，页面里的密钥需要跟着换。' };
  if (r.code === 0) return { state: 'bad', detail: '**连不上 Supabase**\n\n' + r.raw };
  return { state: 'bad', detail: '**意外的返回**：HTTP ' + r.code + '\n\n' + String(r.raw).slice(0, 200) };
}

// ── 发飞书卡片（应用身份，不过期）──
async function sendCard(c, title, msg, color) {
  let _to = ALERT_EMAIL;
  try { const _cal = await loadEmailConfig(); _to = (_cal.config && _cal.config.alertEmail) || _to; } catch (e) {}
  const t = await req('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.APP_ID, app_secret: c.APP_SECRET })
  });
  let tj = null; try { tj = JSON.parse(t.raw); } catch (e) {}
  if (!tj || !tj.tenant_access_token) throw new Error('拿不到飞书 token（HTTP ' + t.code + '）');
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: color },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: msg } }]
  };
  const r = await req('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tj.tenant_access_token },
    body: JSON.stringify({ receive_id: _to, msg_type: 'interactive', content: JSON.stringify(card) })
  });
  let j = null; try { j = JSON.parse(r.raw); } catch (e) {}
  if (!j || j.code !== 0) throw new Error('发卡片失败（HTTP ' + r.code + '）：' + String(r.raw).slice(0, 200));
}

(async () => {
  let c;
  try { c = readCreds(); } catch (e) { log('❌ ' + e.message); process.exit(1); }

  // ── 测试模式：只发一条卡片，确认通道通 ──
  if (process.argv.includes('--test')) {
    try {
      await sendCard(c, '🔔 探活告警测试',
        '这是一条**测试消息**。\n\n收到它说明「Supabase 探活」的飞书告警通道是通的。\n\n' +
        '以后 Supabase 出问题（配额爆 / 密钥失效 / 连不上）会往这里发一条，**恢复后再发一条**，' +
        '中间不会重复发。检查时间是每天 **10:00 / 14:00 / 18:00 / 22:00**。', 'blue');
      log('✅ 测试卡片已发送到 ' + ALERT_EMAIL);
      process.exit(0);
    } catch (e) { log('❌ 测试卡片发送失败：' + e.message); process.exit(1); }
  }

  const now = await probe(c);

  let prev = { state: 'unknown', notified: false, at: null };
  try {
    const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (p && p.state) prev = p;
  } catch (e) {}

  log('探测：' + (now.state === 'ok' ? '正常 ✅' : '异常 ❌') +
      (now.detail ? '　' + now.detail.split('\n')[0].replace(/\*/g, '') : ''));

  // ── 只在状态变化时发消息 ──
  let kind = null;
  if (now.state === 'bad') {
    if (prev.state !== 'bad') kind = 'down';        // 刚刚坏的
    else if (!prev.notified) kind = 'down';          // 一直坏但上次没发成功 → 重试
  } else if (prev.state === 'bad') {
    kind = 'up';                                     // 坏了以后恢复了
  }

  if (kind) {
    const isDown = kind === 'down';
    const title = isDown ? '❌ Supabase 出问题了' : '✅ Supabase 恢复了';
    const body = isDown
      ? now.detail + '\n\n——\n**发现时间**：' + nowText() +
        '\n**要做什么**：去控制台看一眼用量。**本机使用不受影响**，页面会自动用浏览器本地数据兜底。'
      : '云端同步恢复正常了，各设备的同步会自己接上，不用做任何操作。\n\n——\n**恢复时间**：' + nowText();
    try {
      await sendCard(c, title, body, isDown ? 'red' : 'green');
      log('📨 已发飞书：' + title);
      now.notified = true;
    } catch (e) {
      log('❌ 飞书发送失败：' + e.message + '（下次探测会重试）');
      now.notified = false;
    }
  } else {
    log('（状态没变，不发消息）');
  }

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      state: now.state,
      notified: !!now.notified,
      detail: now.detail || '',
      at: new Date().toISOString(),
      checkedAt: nowText()
    }, null, 2));
  } catch (e) { log('⚠️ 状态文件写不进去：' + e.message); }
})();
