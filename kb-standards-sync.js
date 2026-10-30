/**
 * 质检标准卡片每日同步（2026-10-30 建）
 *
 * 数据源：飞书表 BzG8s8py3hDZIvtUJl7cRXJXnfe 的 Sheet8（gMNoIv）
 *   A 列 = 品类名（已经是「手机-质检标准」这种完整名称，直接当卡片名用）
 *   B 列 = 封面照片（插入的图片；也兼容直接粘贴公开图片网址）
 *   C 列 = 飞书链接（「提及文档」或直接粘网址，取里面的 link）
 *   D 列 = 描述
 *
 * 每天 9:00（北京时间）跑一次（GitHub Actions，cron 0 1 * * * UTC）：
 *   ① 读表 → 整理成卡片清单，算指纹；
 *   ② 和云端 kbs_config 里的指纹比，一样就结束（只花两次请求）；
 *   ③ 不一样才处理：换了图只重新下载压缩那一张，然后写封面到 KV、写配置到 kbs_config。
 *
 * 页面（index.html）打开「质检标准库」时读 kbs_config，按表里的顺序渲染；读不到就用本地兜底。
 * 页面上的 ✏️/🗑️/➕/◀▶ 对这张表驱动的卡片是隐藏的 —— 表是唯一数据源，改了页面也留不住。
 *
 * 安全闸门（宁可这轮不同步，也不要把坏数据推上去）：
 *   ① 表读不到 / 解析出 0 个品类 → 中止
 *   ② 品类名有重复 → 中止（页面按名字生成 id，重复会串）
 *   ③ 新品类数比上次少一半以上 → 中止（多半是表被改坏；FORCE=1 可越过）
 *   ④ 某张新图下载失败 → 中止（不会出现「图没了」的半截状态）
 *   ⑤ 写完后回读校验指纹，不一致退出码 1
 *
 * 手动用法：
 *   node kb-standards-sync.js                 # 正常同步
 *   DRY_RUN=1 node kb-standards-sync.js      # 只读演练：读表、对比、打印计划，不写任何东西
 *   FORCE=1 node kb-standards-sync.js        # 越过闸门③
 *   node kb-standards-sync.js --alert-only "消息"   # 只发飞书告警卡片
 */
const https = require('https');
const crypto = require('crypto');

const PAGES = 'https://yxt-feishu.pages.dev';
const SECRET = 'yxt-feishu-2026';
const SHEET_TOKEN = 'BzG8s8py3hDZIvtUJl7cRXJXnfe';
const SHEET_ID = 'gMNoIv';
const CONFIG_KEY = 'kbs_config';
const COVER_PREFIX = 'kbcover_';
const APP_ID = 'cli_aab1fa4e87bbdbd3';

// 应用密钥不写进本文件（仓库是公开的）。取值顺序：① Actions Secrets 注入的环境变量 ② 本机密钥文件（不进仓库）。
// 都没有也不一定死：走代理时代理会用 Cloudflare 环境变量里的真值补上。
const APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
  try { return require('fs').readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === 'true' || process.env.FORCE === '1';
const RUN_URL = process.env.RUN_URL || '';
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'xuhang02@zhuanzhuan.com';

let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.log('⚠️ 没装 sharp，封面按原图存（能用，只是页面加载大一点）');
}

// ---------------- 网络基础 ----------------
function httpJson(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(Object.assign({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, opts || {}), res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: d, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
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
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: d, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
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
  const kv = await httpJson(PAGES + '/token', { headers: { 'x-yxt-secret': SECRET } });
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

// 直连下载图片字节（走代理会把二进制转成 base64 JSON，体积变大）
function downloadMedia(fileToken, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://open.feishu.cn/open-apis/drive/v1/medias/' + encodeURIComponent(fileToken) + '/download');
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => {
      if (res.statusCode !== 200) {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 120))));
        return;
      }
      const chunks = []; let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > 20 * 1048576) { req.destroy(new Error('图片超过 20MB')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('下载超时（60 秒）')));
    req.end();
  });
}

async function downloadMediaAny(fileToken) {
  try { return await downloadMedia(fileToken, await getTenantToken()); }
  catch (e) {
    console.log('  ⚠️ 应用身份下载失败（' + e.message + '），改用用户 token 重试');
    const u = await getUserToken();
    if (!u) throw e;
    return downloadMedia(fileToken, u.access_token);
  }
}

// ---------------- KV ----------------
async function kvGet(key) {
  const r = await httpJson(PAGES + '/data?key=' + encodeURIComponent(key), { headers: { 'x-yxt-secret': SECRET } });
  if (r.status !== 200) throw new Error('KV 读取失败 HTTP ' + r.status + ' ' + String(r.raw).slice(0, 120));
  let v = r.json && r.json.value;
  if (typeof v === 'string') { try { const o = JSON.parse(v); v = o && o.v; } catch (e) { v = null; } }
  return typeof v === 'string' ? v : null;
}

function kvPutLarge(key, value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ items: [{ key, v: value, t: new Date().toISOString() }] });
    const u = new URL(PAGES + '/data');
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 120)));
        if (!j || !j.ok || j.failed) return reject(new Error('写入失败 ' + d.slice(0, 200)));
        // written=0 且 skipped>0 = 同内容去重，算成功
        if (!j.written && !j.skipped) return reject(new Error('未写入 ' + d.slice(0, 200)));
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error('写入超时')));
    req.write(body);
    req.end();
  });
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

// B 列：返回 { imgToken, imgUrl }
function parseCoverCell(c) {
  const out = { imgToken: '', imgUrl: '' };
  const list = Array.isArray(c) ? c : (c ? [c] : []);
  for (const x of list) {
    if (!x || typeof x !== 'object') {
      if (typeof x === 'string' && /^https?:\/\//i.test(x.trim())) { out.imgUrl = x.trim(); break; }
      continue;
    }
    if (x.fileToken || x.file_token) { out.imgToken = x.fileToken || x.file_token; break; }
    if (x.link && /^https?:\/\//i.test(x.link)) { out.imgUrl = x.link; break; }
  }
  if (!out.imgToken && !out.imgUrl && typeof c === 'string' && /^https?:\/\//i.test(c.trim())) out.imgUrl = c.trim();
  return out;
}

// C 列：返回飞书链接
function parseLinkCell(c) {
  if (!c) return '';
  const list = Array.isArray(c) ? c : [c];
  for (const x of list) {
    if (!x) continue;
    if (typeof x === 'string' && /^https?:\/\//i.test(x.trim())) return x.trim();
    if (typeof x === 'object' && x.link && /^https?:\/\//i.test(x.link)) return x.link;
  }
  return typeof c === 'string' && /^https?:\/\//i.test(c.trim()) ? c.trim() : '';
}

function parseRows(rows) {
  const items = [];
  const dup = [];
  const seen = {};
  rows.forEach((r, idx) => {
    if (!Array.isArray(r)) return;
    const name = cellText(r[0]);
    if (!name) return;                       // 空行跳过（表格预留了 198 行）
    const cover = parseCoverCell(r[1]);
    const url = parseLinkCell(r[2]);
    const desc = cellText(r[3]);
    if (seen[name]) dup.push(name);
    seen[name] = true;
    items.push({ row: idx + 2, name, img: cover.imgToken, imgUrl: cover.imgUrl, url, desc });
  });
  return { items, dup };
}

// ---------------- 图片处理 ----------------
async function compressToDataUrl(buf, label) {
  let out = buf;
  let how = '原图';
  if (sharp) {
    try {
      out = await sharp(buf).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
      how = '压缩';
    } catch (e) {
      console.log('  ⚠️ ' + label + ' 压缩失败，按原图存：' + e.message);
    }
  }
  return { dataUrl: 'data:image/jpeg;base64,' + out.toString('base64'), how, bytes: out.length, rawBytes: buf.length };
}

function coverKeyFor(imgToken) {
  return COVER_PREFIX + crypto.createHash('sha1').update(String(imgToken)).digest('hex').slice(0, 16);
}

// ---------------- 告警卡片 ----------------
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
async function readSheet() {
  const r = await api('/sheets/v2/spreadsheets/' + SHEET_TOKEN + '/values/' + SHEET_ID + '!A2:D500?majorDimension=ROWS');
  const rows = (r.json && r.json.data && r.json.data.valueRange && r.json.data.valueRange.values) || [];
  console.log('📖 表里读到 ' + rows.length + ' 行（含空行）');
  return rows;
}

async function main() {
  console.log('=== 质检标准卡片同步 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' ===');
  const rows = await readSheet();
  const { items, dup } = parseRows(rows);

  if (dup.length) throw new Error('品类名有重复：' + dup.join('、') + '（页面按名字生成卡片，重复会串，请先把表里的重名改掉）');
  if (!items.length) throw new Error('表里一个品类都没解析出来（A2:D 是不是被清空/移走了？）');

  console.log('\n解析结果（顺序=表里的顺序）：');
  items.forEach((it, i) => {
    console.log('  ' + (i + 1) + '. ' + it.name +
      ' | 封面=' + (it.img ? '图片 ' + it.img.slice(0, 10) + '…' : (it.imgUrl ? '网址' : '（空）')) +
      ' | 链接=' + (it.url || '（空）') +
      ' | 描述=' + (it.desc || '（空）'));
  });

  // 读上次配置
  let prev = null;
  try {
    const rawPrev = await kvGet(CONFIG_KEY);
    if (rawPrev) { prev = JSON.parse(rawPrev); console.log('\n云端已有配置：' + (prev.count || (prev.items || []).length) + ' 个品类，更新于 ' + (prev.updatedAt || '未知')); }
    else console.log('\n云端还没有配置（首次同步）');
  } catch (e) {
    console.log('\n⚠️ 读云端配置失败：' + e.message + '（按首次同步处理）');
  }

  // 闸门③：品类数骤降
  const prevCount = prev && Array.isArray(prev.items) ? prev.items.length : 0;
  if (prevCount >= 4 && items.length < prevCount * 0.5 && !FORCE) {
    throw new Error('品类数从 ' + prevCount + ' 掉到 ' + items.length + '（少了一半以上），多半是表被改坏。本轮不写入；确认无误可用 FORCE=1 强制同步');
  }

  // 指纹：名字/图/链接/描述 + 顺序
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(items.map(x => [x.name, x.img || x.imgUrl, x.url, x.desc])))
    .digest('hex');
  if (prev && prev.fingerprint === fingerprint) {
    console.log('\n✅ 内容和上次一致，不用更新（只比对，没有写任何东西）');
    return { changed: false };
  }

  // 上次的封面复用表：img → cover
  const prevCoverByImg = {};
  ((prev && prev.items) || []).forEach(x => { if (x && x.img && x.cover) prevCoverByImg[x.img] = x.cover; });

  if (DRY_RUN) {
    console.log('\n🔍 DRY_RUN：检测到变化，但只打印计划，不下载不上传不写配置');
    items.forEach(it => {
      if (it.imgUrl) console.log('  ' + it.name + '：封面直接用网址 ' + it.imgUrl);
      else if (it.img) console.log('  ' + it.name + '：封面 ' + (prevCoverByImg[it.img] ? '沿用已有 ' + prevCoverByImg[it.img] : '需要新上传 ' + coverKeyFor(it.img)));
      else console.log('  ' + it.name + '：没有封面');
    });
    return { changed: true, dryRun: true };
  }

  // 逐张处理封面
  let uploaded = 0, reused = 0, empty = 0;
  const failures = [];
  for (const it of items) {
    if (it.imgUrl) { it.cover = it.imgUrl; continue; }
    if (!it.img) { it.cover = ''; empty++; continue; }
    const key = coverKeyFor(it.img);
    if (prevCoverByImg[it.img]) { it.cover = prevCoverByImg[it.img]; reused++; continue; }
    try {
      console.log('  ⬇️ 下载封面：' + it.name);
      const buf = await downloadMediaAny(it.img);
      const c = await compressToDataUrl(buf, it.name);
      console.log('    ' + it.name + '：' + (c.rawBytes / 1024).toFixed(0) + 'KB → ' + c.how + ' ' + (c.bytes / 1024).toFixed(0) + 'KB');
      await kvPutLarge(key, c.dataUrl, 60000);
      it.cover = 'kv:' + key;
      uploaded++;
      await new Promise(r => setTimeout(r, 300));   // KV 同 key 每秒 1 次写，串行稳稳的
    } catch (e) {
      failures.push(it.name + '：' + e.message);
    }
  }
  if (failures.length) {
    throw new Error('有 ' + failures.length + ' 张封面处理失败，本轮不写配置（避免卡片丢图）：\n  ' + failures.join('\n  '));
  }

  // 写配置
  const config = {
    v: 1,
    updatedAt: new Date().toISOString(),
    count: items.length,
    fingerprint,
    items: items.map(x => ({ name: x.name, cover: x.cover || '', url: x.url || '', desc: x.desc || '', img: x.img || x.imgUrl || '' }))
  };
  await kvPutLarge(CONFIG_KEY, JSON.stringify(config), 60000);
  console.log('\n✅ 已写入云端配置 kbs_config（' + items.length + ' 个品类；新传封面 ' + uploaded + ' 张，沿用 ' + reused + ' 张，无封面 ' + empty + ' 个）');

  // 回读校验
  const back = await kvGet(CONFIG_KEY);
  const backObj = back ? JSON.parse(back) : null;
  if (!backObj || backObj.fingerprint !== fingerprint || backObj.items.length !== items.length) {
    throw new Error('写完回读校验不一致（云端那份和本次结果对不上），请检查');
  }
  console.log('✅ 回读校验通过');

  if (uploaded > 0 || prevCount === 0) {
    const lines = ['品类数：' + items.length + '（新传封面 ' + uploaded + ' 张）'];
    if (prevCount) {
      const prevNames = (prev.items || []).map(x => x.name);
      const nowNames = items.map(x => x.name);
      const added = nowNames.filter(n => prevNames.indexOf(n) < 0);
      const removed = prevNames.filter(n => nowNames.indexOf(n) < 0);
      if (added.length) lines.push('新增：' + added.join('、'));
      if (removed.length) lines.push('删除：' + removed.join('、'));
    }
    await sendCard('✅ 质检标准卡片已更新', lines.join('\n'), 'green');
  }
  return { changed: true };
}

// ---------------- 入口 ----------------
// 被测试脚本 require 时只导出函数，不自动跑同步
module.exports = { parseRows, parseCoverCell, parseLinkCell, cellText, coverKeyFor, CONFIG_KEY };

if (require.main === module) {
  const ARGV = process.argv.slice(2);
  if (ARGV[0] === '--alert-only') {
    sendCard('❌ 质检标准卡片同步未完成', ARGV[1] || '（无详情）', 'red').then(() => process.exit(0));
  } else {
    main().then(() => process.exit(0)).catch(e => {
      console.log('\n❌ ' + (e && e.message || e));
      process.exit(1);
    });
  }
}
