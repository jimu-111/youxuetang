/**
 * 题库每周同步（2026-09-05 建，2026-09-13 加固）：
 * 每周日 8:00（北京时间 = GitHub Actions UTC 周日 0:00）读飞书总表 7 个品类 tab，
 * 全量覆盖 7 个源品类，写入 Supabase questionBankData（402 挂断则 KV 兜底）。
 *
 * ⚠️ 写之前有四道闸门（2026-09-13 加）。原则：**宁可这周不同步，也不要把坏数据推上去**——
 *    不同步只是题库晚一周更新（看得出来），推上去是题目凭空消失（看不出来）。
 *    ① 任一品类读值失败          → 中止（原来只 console.log + continue，会让那个品类的题从云端全消失）
 *    ② 7 个品类有任何一个没解析出题 → 中止（sheet 被改名/删掉的典型症状）
 *    ③ 现有题库两端都读不到       → 中止（无法比对缩水，不能盲写）
 *    ④ 新题数 < 现有题数 × 0.9    → 中止（防飞书侧被误删、或读取被 row_count 截断）
 *    FORCE=1 可越过 ①②③④（日志会写明「已越过闸门」）；不能用它越过写后校验。
 *
 * 手动区已砍（2026-09-13）：页面不再增删改题，题库全量由本脚本维护，没有需要「保留」的区域。
 * 与 qb-import-categories.js 同套：user token 自持循环（KV /token 取，401 用 refresh_token 换新写回）
 */
const https = require('https');
const fs = require('fs');

const PAGES = 'https://yxt-feishu.pages.dev';
const SECRET = 'yxt-feishu-2026';
const SS_TOKEN = 'BzG8s8py3hDZIvtUJl7cRXJXnfe'; // 总表（含全部 7 个品类 tab）
const APP_ID = 'cli_aab1fa4e87bbdbd3';
// 2026-09-20：应用密钥不再写在本文件里 —— 本文件在**公开仓库**根目录，写上就等于公开。
// 取值顺序：① 环境变量 FEISHU_APP_SECRET（GitHub Actions 由仓库 Secrets 注入）
//           ② 本地密钥文件（在你自己电脑上手工跑时用；不进仓库）
// 两个都没有就留空 —— 留空不等于死：本脚本换 token 走的是代理，代理会用 Cloudflare
// 环境变量 FEISHU_APP_SECRET 里的真值把 app_secret 补上。
const APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
  try { return require('fs').readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co').replace(/\/$/, '').replace(/\s/g, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8').replace(/\s/g, '');
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === 'true' || process.env.FORCE === '1';

// 7 个品类定义（categories key = 品类中文名；key 字段为英文标识）
//   2026-09-13：原第 8 类「手动录入题目」已随页面手动区一起砍掉，从这里删掉后，下次同步会把云端那个空分类一并覆盖掉。
//   ⚠️ 页面 index.html 的 QB_DEFAULT_CATEGORIES 必须与本表保持一致（页面会按那张表把缺失分类补回来）。
const CATEGORIES = {
  '手机':           { name: '手机',            key: 'phone',    order: 1, source: true },
  '平板':           { name: '平板',            key: 'tablet',   order: 2, source: true },
  '笔记本':         { name: '笔记本',          key: 'laptop',   order: 3, source: true },
  '手表':           { name: '手表',            key: 'watch',    order: 4, source: true },
  '耳机':           { name: '耳机',            key: 'earphone', order: 5, source: true },
  '相机&镜头':      { name: '相机&镜头',       key: 'camera',   order: 6, source: true },
  '游戏机&游戏卡带': { name: '游戏机&游戏卡带', key: 'console',  order: 7, source: true }
};
// sheet 标题 → 品类中文名
const SHEET_MATCHERS = [
  ['手机', '手机'], ['平板', '平板'], ['笔记本', '笔记本'], ['手表', '手表'],
  ['耳机', '耳机'], ['相机', '相机&镜头'], ['镜头', '相机&镜头'],
  ['游戏机', '游戏机&游戏卡带'], ['游戏卡带', '游戏机&游戏卡带']
];

function httpJson(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(Object.assign({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, opts || {}), res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    // 2026-09-13：原来漏了这句，POST 从不带 body —— 新 token「写回 KV」实际写了个空请求，
    // 刷新成功后云端仍是旧 token，下次运行照样失败。
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
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// —— token 自持循环：KV 取 → 401 用 refresh_token 换新 → 新 refresh_token 写回 KV ——
let TOKEN = null;
async function getToken() {
  const kv = await httpJson(PAGES + '/token', { headers: { 'x-yxt-secret': SECRET } });
  let stored = kv.json && kv.json.value;
  if (typeof stored === 'string') stored = JSON.parse(stored);
  if (stored && stored.access_token) TOKEN = stored;
  if (!TOKEN) throw new Error('KV 里没有飞书 token');
  return TOKEN;
}

// —— 应用身份（2026-09-13 新增）——
// 总表已授权给「优学堂」应用（2026-09-11 实测可读可写），应用凭据长期有效、不会过期，
// 不再依赖个人 token。个人 token 的 refresh_token 是一次性的，一旦写回失败就断链、需重新授权，
// 2026-09-13 题库同步失败即由此而来。按用户定的「双身份谁可用用谁」策略，读总表走应用身份。
let TENANT = null;
async function getTenantToken() {
  if (TENANT && TENANT.exp > Date.now()) return TENANT.token;
  const r = await viaProxy('/auth/v3/tenant_access_token/internal', '', {
    method: 'POST',
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  if (!r.json || r.json.code !== 0 || !r.json.tenant_access_token) throw new Error('tenant_access_token 获取失败: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
  TENANT = { token: r.json.tenant_access_token, exp: Date.now() + (r.json.expire || 7200) * 1000 - 300000 };
  return TENANT.token;
}

// 刷新 user_access_token 必须用 app_access_token 做 Authorization（不是 tenant_access_token，
// 也不是 body 里传 app_id/app_secret）。2026-09-13：原来往 body 塞 app_id/app_secret 的写法
// 被飞书拒（20014 The app access token passed is invalid），刷新从来没成功过。
async function getAppAccessToken() {
  const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  const r = await viaProxy('/auth/v3/app_access_token/internal', '', { method: 'POST', body });
  if (!r.json || r.json.code !== 0 || !r.json.app_access_token) throw new Error('app_access_token 获取失败: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
  return r.json.app_access_token;
}

async function api(path, extra) {
  // 应用身份优先（2026-09-13）：读总表只需应用权限，且应用凭据永不过期
  try {
    const at = await getTenantToken();
    const ra = await viaProxy(path, at, extra);
    if (ra.json && ra.json.code === 0) return ra;
    console.log('  ⚠️ 应用身份返回 code=' + (ra.json && ra.json.code) + '（' + (ra.json && ra.json.msg || '') + '），回退用户 token');
  } catch (e) {
    console.log('  ⚠️ 应用身份不可用：' + e.message + '，回退用户 token');
  }
  // —— 以下为用户 token 路径（含刷新），作为兜底 ——
  if (!TOKEN) throw new Error('应用身份与用户 token 均不可用');
  let r = await viaProxy(path, TOKEN.access_token, extra);
  // 99991668 = Invalid access token for authorization：飞书对「已失效/已作废」的 token 返回这个码，
  // 而不是 99991663「过期」。2026-09-13 题库同步就因为它不在名单里、没触发刷新而直接失败。
  if (r.status === 401 || (r.json && (r.json.code === 99991663 || r.json.code === 99991661 || r.json.code === 99991668))) {
    console.log('  access token 失效，刷新中…');
    const rt = TOKEN.refresh_token;
    if (!rt) throw new Error('无 refresh_token 可刷新');
    const aat = await getAppAccessToken();
    const ref = await viaProxy('/authen/v1/oidc/refresh_access_token', aat, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt })
    });
    if (ref.status !== 200 || !ref.json || !ref.json.data) throw new Error('刷新失败: ' + ref.status + ' ' + JSON.stringify(ref.json).slice(0, 200));
    // 保留 owner 等原字段：页面靠 owner 判断是否上云、靠 expiresAt 决定是否自动刷新
    const d = ref.json.data;
    TOKEN = Object.assign({}, TOKEN, {
      access_token: d.access_token,
      refresh_token: d.refresh_token || TOKEN.refresh_token,
      expiresAt: Date.now() + (d.expires_in || 7200) * 1000
    });
    console.log('  刷新成功，有效期至 ' + new Date(TOKEN.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    // 新 refresh_token 写回 KV（永不断）
    await httpJson(PAGES + '/token', {
      method: 'POST', headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify(TOKEN)
    }).catch(() => console.log('  ⚠️ 新 token 写回 KV 失败（不影响本次运行）'));
    r = await viaProxy(path, TOKEN.access_token, extra);
  }
  return r;
}

// —— 媒体 cell 分流（2026-10-20 视频支持）——
// 飞书单元格里的媒体有三种形态：
//   图片        {fileToken, type:'embed-image'} 或图片附件 {fileToken, mimeType:'image/*', type:'attachment'}
//   视频附件    {fileToken, mimeType:'video/*', type:'attachment'}  ← 能用应用身份下载，自动转存 KV
//   视频外链    {link, text:'xxx.mp4', type:'url'}（企业微信微盘等） ← 取不到字节，只能提醒人工转存
const VIDEO_EXT_RE = /\.(mp4|mov|avi|mkv|webm|m4v)(\?|$)/i;
function isVideoObj(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.type === 'attachment') return /^video\//i.test(c.mimeType || '') || VIDEO_EXT_RE.test(c.text || '');
  if (c.type === 'url') return VIDEO_EXT_RE.test(c.text || '') || /drive\.weixin\.qq\.com/i.test(c.link || '');
  if (c.type === 'embed-video' || c.type === 'embed-media') return true;
  return false;
}
function splitMediaCell(cell) {
  const images = [], videos = [];
  const list = (cell === undefined || cell === null) ? [] : (Array.isArray(cell) ? cell : [cell]);
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c)) {
      const sub = splitMediaCell(c);
      images.push(...sub.images); videos.push(...sub.videos);
      continue;
    }
    if (isVideoObj(c)) {
      if (c.fileToken) videos.push({ token: c.fileToken, name: String(c.text || '').trim() || '视频.mp4', size: Number(c.size) || 0 });
      else if (c.link) videos.push({ link: c.link, name: String(c.text || '').trim() || '视频' });
      continue;
    }
    if (c.fileToken) images.push(c.fileToken);
  }
  return { images, videos };
}
// —— 图片 cell 提取 fileToken（视频不再混进 images）——
function extractFileTokens(cell) {
  return splitMediaCell(cell).images;
}
function cellText(cell) {
  if (cell === undefined || cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  return '';
}
// parseSheetRows 顺手收集的视频位置（题目图/解析图/选项图），用于转存与提醒，不进题库 JSON
const VIDEO_META = [];

// —— 题型推断（与页面 inferQuestionType 同规则）——
function inferType(typeColVal, answerStr) {
  typeColVal = String(typeColVal || '').trim();
  answerStr = String(answerStr || '').trim();
  if (/判断|judge/i.test(typeColVal) || /^(正确|错误|对|错|√|✓|×|✗|true|false)[。.]?$/i.test(answerStr)) return 'judge';
  if (/^[A-Fa-f\s,，、;；]+$/.test(answerStr)) {
    const letters = (answerStr.match(/[A-Fa-f]/g) || []);
    if (letters.length === 1) return 'choice';
    if (letters.length >= 2) return 'multi';
  }
  if (/^[A-Fa-f][.．、，,:：]/.test(answerStr)) {
    const tokens = (answerStr.match(/[A-Fa-f][.．、，,:：]/g) || []);
    if (tokens.length === 1) return 'choice';
    if (tokens.length >= 2) return 'multi';
  }
  return 'qa';
}

// —— 解析一个品类 sheet 的全部题目（与 qb-import-categories.js 一致）——
function parseSheetRows(rows, sheetTitle) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map(h => (h === undefined || h === null) ? '' : String(h).trim());
  const findCol = (...names) => header.findIndex(h => names.includes(h));
  const cId = findCol('题目ID');
  const cType = findCol('题型');
  const cText = findCol('题目');
  const cAnswer = findCol('答案');
  const cAnalysis = findCol('答案解析');
  const cQImg = findCol('题目图');
  const cAImg = findCol('解析图', '答案解析图');
  const optKeys = ['A', 'B', 'C', 'D', 'E', 'F'];
  const cOpts = optKeys.map(k => findCol(k)).filter(i => i >= 0);
  const cOptImgs = [];
  for (let i = 0; i < header.length; i++) {
    if (/^[1-5]$/.test(header[i])) cOptImgs.push(i);
  }

  const questions = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri] || [];
    const text = cellText(row[cText]).trim();
    if (!text) continue;
    const answer = cellText(row[cAnswer]).trim();
    const sourceId = cId >= 0 ? cellText(row[cId]).trim() : '';
    const options = [];
    cOpts.forEach((colIdx, i) => {
      const t = cellText(row[colIdx]).trim();
      if (t) options.push({ key: optKeys[i], text: t, images: [] });
    });
    cOptImgs.forEach((colIdx, i) => {
      const m = splitMediaCell(row[colIdx]);
      if (!options[i]) return;
      if (m.images.length) options[i].images = m.images;
      if (m.videos.length) options[i].videos = m.videos;
    });
    const qMedia = cQImg >= 0 ? splitMediaCell(row[cQImg]) : { images: [], videos: [] };
    const aMedia = cAImg >= 0 ? splitMediaCell(row[cAImg]) : { images: [], videos: [] };
    const question = {
      id: 'qb_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      sourceId: sourceId,
      type: inferType(cType >= 0 ? row[cType] : '', answer),
      question: text,
      options: options,
      answer: answer,
      explanation: cAnalysis >= 0 ? cellText(row[cAnalysis]).trim() : '',
      images: qMedia.images,
      analysisImages: aMedia.images,
      difficulty: '中等',
      createdAt: new Date().toISOString()
    };
    // 视频只在有内容时才写字段（1300+ 题全写空数组会白肥 JSON）
    if (qMedia.videos.length) question.videos = qMedia.videos;
    if (aMedia.videos.length) question.analysisVideos = aMedia.videos;
    questions.push(question);
    // 收集视频位置，供转存/提醒用（不进题库 JSON）
    const addMeta = (v, col) => VIDEO_META.push({
      sheet: sheetTitle, row: ri + 1, qid: sourceId, col: col,
      token: v.token || '', link: v.link || '', name: v.name || '', size: v.size || 0
    });
    qMedia.videos.forEach(v => addMeta(v, '题目图'));
    aMedia.videos.forEach(v => addMeta(v, '解析图'));
    options.forEach((o, oi) => (o.videos || []).forEach(v => addMeta(v, (oi + 1) + '号选项图')));
  }
  return questions;
}

// —— 读现有题库（Supabase 优先，失败 KV 兜底）——
// 2026-09-13 改为三态返回 { ok:true, bank, count, from } / { ok:false, error }。
//   原来把「两端都读不到」和「题库真的是空的」合并成同一个 {questions:[]} 返回，调用方分不出来 ——
//   缩水闸门拿 0 当基准等于形同虚设。现在读不到就明确 ok:false，由 main() 决定中止。
//   「真的是空的」有明确信号：Supabase 返回 200 + 0 行；KV 返回 200 + {"value":null}（已实测）。
async function readExistingBank() {
  try {
    const u = new URL(SUPABASE_URL + '/rest/v1/app_data?key=eq.questionBankData&select=value&limit=1');
    const r = await httpJson(u.toString(), { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } });
    if (r.status === 200 && Array.isArray(r.json)) {
      if (r.json.length === 0) {
        console.log('ℹ️ Supabase 无 questionBankData 记录（首次同步）');
        return { ok: true, bank: { categories: {}, questions: [] }, count: 0, from: 'Supabase(空)' };
      }
      if (r.json[0] && r.json[0].value) {
        const parsed = JSON.parse(r.json[0].value);
        const n = (parsed.questions || []).length;
        console.log('✅ Supabase 读取现有题库: ' + n + ' 题');
        return { ok: true, bank: parsed, count: n, from: 'Supabase' };
      }
    }
    throw new Error('Supabase 读题失败 HTTP ' + r.status);
  } catch (e) {
    console.log('⚠️ ' + e.message + '，转 KV 兜底读');
    try {
      const kv = await httpJson(PAGES + '/data?key=questionBankData', { headers: { 'x-yxt-secret': SECRET } });
      if (kv.status !== 200) throw new Error('KV 读题失败 HTTP ' + kv.status);
      // KV 对不存在的 key 返回 200 + {"value":null}（2026-09-13 实测）
      if (kv.json && typeof kv.json.value === 'string') {
        const o = JSON.parse(kv.json.value);
        const parsed = JSON.parse(o.v);
        const n = (parsed.questions || []).length;
        console.log('✅ KV 读取现有题库: ' + n + ' 题');
        return { ok: true, bank: parsed, count: n, from: 'KV' };
      }
      console.log('ℹ️ KV 无 questionBankData 记录（首次同步）');
      return { ok: true, bank: { categories: {}, questions: [] }, count: 0, from: 'KV(空)' };
    } catch (e2) {
      console.log('❌ 现有题库两端都读不到: ' + e2.message);
      return { ok: false, error: e2.message };
    }
  }
}

// —— 写入：Supabase 优先，失败转 KV ——
function kvWrite(key, value) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ items: [{ key, v: String(value), t: new Date().toISOString() }] });
    const u = new URL(PAGES + '/data');
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode < 400)); });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}
function supabaseWrite(key, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]);
    const u = new URL(SUPABASE_URL + '/rest/v1/app_data');
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error('Supabase ' + res.statusCode + ': ' + d.slice(0, 120)));
        else resolve();
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ===================== 视频转存 KV（2026-10-20） =====================
//   存储：KV key = qbvideo_<fileToken>，值为 base64 原文（/data 路由会包一层 {"v":..,"t":..}）
//   索引：qbvideo_index = {"<token>":{n:文件名,s:字节数,t:时间}}，token 在索引里就跳过下载/上传，
//         避免每周把 69MB 视频重新传一遍。上传成功才写索引 —— 失败的下周会自动重试。
//   上限：KV 单值 25MiB，base64 膨胀 4/3，留余量后原始视频上限取 17MB（当前最大 13.8MB）。
const VIDEO_INDEX_KEY = 'qbvideo_index';
const VIDEO_MAX_BYTES = 17 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 读一个 /data key 的「真值」（剥掉 {v,t} 信封）；不存在返回 null，网络/服务异常则抛错
async function kvGetValue(key) {
  const r = await httpJson(PAGES + '/data?key=' + encodeURIComponent(key), { headers: { 'x-yxt-secret': SECRET } });
  if (r.status !== 200 || !r.json) throw new Error('HTTP ' + r.status);
  if (r.json.value === null || r.json.value === undefined) return null;
  const o = JSON.parse(r.json.value);
  return o && o.v !== undefined ? o.v : null;
}

function kvPutLarge(key, value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ items: [{ key, v: value, t: new Date().toISOString() }] });
    const u = new URL(PAGES + '/data');
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        if (res.statusCode !== 200 || !j) return reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 120)));
        if (j.failed) return reject(new Error('KV 写入失败 ' + JSON.stringify(j)));
        if (!j.written && !j.skipped) return reject(new Error('KV 未写入 ' + JSON.stringify(j)));
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 180000, () => req.destroy(new Error('上传超时（' + Math.round((timeoutMs || 180000) / 1000) + ' 秒）')));
    req.write(body);
    req.end();
  });
}

// 应用身份直连下载视频字节。必须直连：走 Pages 代理会把二进制转成 base64 JSON 包一层（体积 1.8 倍）
function downloadVideoDirect(fileToken, tenantToken) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://open.feishu.cn/open-apis/drive/v1/medias/' + encodeURIComponent(fileToken) + '/download');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { Authorization: 'Bearer ' + tenantToken }
    }, res => {
      if (res.statusCode !== 200) {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 120))));
        return;
      }
      const chunks = []; let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > VIDEO_MAX_BYTES) { req.destroy(new Error('文件超过 ' + (VIDEO_MAX_BYTES / 1048576).toFixed(0) + 'MB 上限')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    // 120 秒：13.8MB 只需 ~115KB/s，留足余量；同时保证 10 个视频最坏也顶不满 60 分钟的 workflow 上限
    req.setTimeout(120000, () => req.destroy(new Error('下载超时（120 秒）')));
    req.end();
  });
}

async function processVideos() {
  const uniq = new Map();   // token -> {token,name,size,where[]}
  const links = [];         // 外链视频（取不到字节）
  for (const m of VIDEO_META) {
    if (m.token) {
      if (!uniq.has(m.token)) uniq.set(m.token, { token: m.token, name: m.name, size: m.size, where: [] });
      const w = (m.sheet || '') + ' 第' + m.row + '行' + (m.qid ? ' 题目ID=' + m.qid : '');
      if (uniq.get(m.token).where.indexOf(w) < 0) uniq.get(m.token).where.push(w);
    } else if (m.link) {
      links.push(m);
    }
  }
  const result = { total: uniq.size, uploaded: 0, existed: 0, failed: [], links: links };
  if (!uniq.size && !links.length) return result;
  if (DRY_RUN) {
    console.log('\n🔍 DRY_RUN：视频 ' + uniq.size + ' 个（仅计划，不下载不上传）' +
      (links.length ? '；外链待转存 ' + links.length + ' 个' : ''));
    links.slice(0, 20).forEach(v => console.log('  🎬 外链 [' + v.sheet + ' 第' + v.row + '行 题目ID=' + v.qid + '] ' + v.name + ' ' + v.link));
    return result;
  }

  console.log('\n========== 视频转存（' + uniq.size + ' 个附件 + ' + links.length + ' 个外链） ==========');
  let index;
  try {
    const raw = await kvGetValue(VIDEO_INDEX_KEY);
    index = raw ? JSON.parse(raw) : {};
    if (!index || typeof index !== 'object' || Array.isArray(index)) index = {};
  } catch (e) {
    // 索引读不到就停手：贸然当成空索引会把已转存的几十 MB 全部重传一遍
    result.failed.push({ name: '（视频索引读取失败）', where: '', reason: e.message + '，本次不转存' });
    console.log('  ❌ 视频索引读取失败：' + e.message + '，本次跳过视频转存（下周重试）');
    return result;
  }

  let tenant = null;
  try { tenant = await getTenantToken(); }
  catch (e) { console.log('  ⚠️ 应用身份不可用：' + e.message); }

  for (const [token, meta] of uniq) {
    if (index[token]) { result.existed++; continue; }
    if (!tenant) {
      result.failed.push({ name: meta.name, where: meta.where.join('、'), reason: '应用身份不可用，无法下载' });
      continue;
    }
    try {
      if (meta.size && meta.size > VIDEO_MAX_BYTES) {
        throw new Error('文件 ' + (meta.size / 1048576).toFixed(1) + 'MB，超过 ' + (VIDEO_MAX_BYTES / 1048576).toFixed(0) + 'MB 上限');
      }
      console.log('  ⬇️ 下载 ' + meta.name + (meta.size ? '（' + (meta.size / 1048576).toFixed(1) + 'MB）' : '') + ' …');
      const buf = await downloadVideoDirect(token, tenant);
      console.log('  ⬆️ 转存 KV（' + (buf.length / 1048576).toFixed(1) + 'MB → base64 ' + (buf.length * 4 / 3 / 1048576).toFixed(1) + 'MB）…');
      await kvPutLarge('qbvideo_' + token, buf.toString('base64'), 120000);
      index[token] = { n: meta.name, s: buf.length, t: new Date().toISOString() };
      result.uploaded++;
    } catch (e) {
      result.failed.push({ name: meta.name, where: meta.where.join('、'), reason: e.message });
      console.log('  ❌ ' + meta.name + '：' + e.message);
    }
    await sleep(600);   // KV 同 key 每秒 1 次写，逐个传也顺便避免限流
  }
  if (result.uploaded) {
    try { await kvPutLarge(VIDEO_INDEX_KEY, JSON.stringify(index)); }
    catch (e) { console.log('  ⚠️ 视频索引写回失败：' + e.message + '（下周会重传这批，已有视频不受影响）'); }
  }
  console.log('  ✅ 视频：新转存 ' + result.uploaded + ' 个，已存在跳过 ' + result.existed + ' 个，失败 ' + result.failed.length + ' 个');
  return result;
}

async function sendVideoReminder(result) {
  if (DRY_RUN) return;
  const links = result.links || [];
  if (!result.failed.length && !links.length) return;
  const lines = [];
  if (links.length) {
    lines.push('**⚠️ 有 ' + links.length + ' 个视频还是外链**（企业微信微盘等），脚本取不到文件，请在总表里换成**视频附件**：');
    links.slice(0, 20).forEach(v => {
      lines.push('· 【' + v.sheet + '】第' + v.row + '行' + (v.qid ? ' 题目ID=' + v.qid : '') + '　' + v.name);
      if (v.link) lines.push('　' + v.link);
    });
    if (links.length > 20) lines.push('… 共 ' + links.length + ' 个，其余见运行日志');
  }
  if (result.failed.length) {
    if (lines.length) lines.push('');
    lines.push('**❌ 有 ' + result.failed.length + ' 个视频转存失败**（换好后下周自动重试）：');
    result.failed.slice(0, 15).forEach(f => lines.push('· ' + (f.where ? '【' + f.where + '】' : '') + f.name + '：' + f.reason));
  }
  lines.push('');
  lines.push('_本次新转存 ' + result.uploaded + ' 个，已存在跳过 ' + result.existed + ' 个_');
  await sendCard('🎬 题库视频待处理', lines.join('\n'), 'orange');
}

async function main() {
  console.log('========== 题库周一同步 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + (DRY_RUN ? ' [DRY_RUN 只读不写]' : '') + ' ==========');
  try { await getToken(); console.log('✅ 用户 token 就绪（兜底身份）'); }
  catch (e) { console.log('⚠️ ' + e.message + '（不影响：主路径走应用身份）'); }

  // 1. 子表列表
  const q = await api('/sheets/v3/spreadsheets/' + SS_TOKEN + '/sheets/query');
  if (q.status !== 200 || !q.json || q.json.code !== 0) { console.log('❌ sheets/query 失败:', q.status, JSON.stringify(q.json).slice(0, 200)); process.exitCode = 1; return; }
  const sheets = (q.json.data && q.json.data.sheets) || [];
  console.log('子表数: ' + sheets.length);

  // 2. 逐品类读取解析
  const srcQuestions = []; // 源区 7 类新题
  const stat = {};         // 品类 → 题数（相机/镜头是两个 sheet 同一个品类，必须累加不能覆盖）
  const readErrors = [];   // 读值失败的品类 —— 闸门①用
  for (const s of sheets) {
    const title = String(s.title || '').trim();
    let catName = null;
    for (const [kw, name] of SHEET_MATCHERS) {
      if (title.includes(kw)) { catName = name; break; }
    }
    if (!catName) { console.log('⏭️ 跳过非品类 sheet: ' + title); continue; }
    const rowsCount = (s.grid_properties && s.grid_properties.row_count) || 500;
    console.log('\n📄 读取品类 [' + title + '] → ' + catName + '（' + rowsCount + ' 行）');
    const v = await api('/sheets/v2/spreadsheets/' + SS_TOKEN + '/values/' + s.sheet_id + '!A1:AB' + rowsCount);
    if (v.status !== 200 || !v.json || v.json.code !== 0) {
      console.log('  ❌ 读值失败:', v.status, JSON.stringify(v.json).slice(0, 150));
      readErrors.push(catName + '（sheet「' + title + '」HTTP ' + v.status + '）');
      continue;
    }
    const rows = v.json.data.valueRange.values || [];
    const qs = parseSheetRows(rows, title);
    qs.forEach(question => {
      question.categoryId = CATEGORIES[catName].key;
      question.category = catName;
      question.productCategory = catName;
      srcQuestions.push(question);
    });
    stat[catName] = (stat[catName] || 0) + qs.length;
    console.log('  ✅ ' + catName + ' 解析出 ' + qs.length + ' 题');
  }

  // 3. ★闸门①②：飞书侧必须完整 —— 先于读云端，飞书侧不完整就没必要碰云端
  const emptyCats = Object.keys(CATEGORIES).filter(k => !stat[k]);
  console.log('\n========== 飞书侧汇总 ==========');
  Object.keys(CATEGORIES).forEach(k => {
    console.log('  ' + (stat[k] ? '✅' : '❌') + ' ' + CATEGORIES[k].name + ': ' +
      (stat[k] === undefined ? '未找到对应 sheet' : stat[k] + ' 题'));
  });
  console.log('  合计: ' + srcQuestions.length + ' 题');

  if (readErrors.length) {
    console.log('\n' + (FORCE ? '⚠️ 已越过闸门①（FORCE=1）' : '🛑 闸门① 拦下') + '：品类读值失败 —— ' + readErrors.join('；'));
    if (!FORCE) {
      console.log('   若继续，这些品类的题会从云端**全部消失**。已中止，云端未被修改。');
      console.log('   确认这些品类确实该清空 → 加 FORCE=1 重跑。');
      process.exitCode = 1;
      return;
    }
  }
  if (emptyCats.length) {
    console.log('\n' + (FORCE ? '⚠️ 已越过闸门②（FORCE=1）' : '🛑 闸门② 拦下') + '：以下品类没解析出任何题 —— ' + emptyCats.join('、'));
    if (!FORCE) {
      console.log('   常见原因：sheet 被改名或删除，或 SHEET_MATCHERS 匹配不上。');
      console.log('   若继续，这些品类的题会从云端**全部消失**。已中止，云端未被修改。');
      console.log('   确认这些品类确实该清空 → 加 FORCE=1 重跑。');
      process.exitCode = 1;
      return;
    }
  }

  // 4. ★闸门③④：与现有题库比对 —— 读不到不盲写；缩水超 10% 不写
  const existing = await readExistingBank();
  if (!existing.ok) {
    console.log('\n' + (FORCE ? '⚠️ 已越过闸门③（FORCE=1）：现有题库读不到，无法比对缩水' : '🛑 闸门③ 拦下：现有题库两端都读不到'));
    if (!FORCE) {
      console.log('   没法比对缩水，不能盲写。已中止，云端未被修改。');
      console.log('   确认新数据完整、就是要覆盖 → 加 FORCE=1 重跑。');
      process.exitCode = 1;
      return;
    }
  } else if (existing.count > 0) {
    const floor = Math.floor(existing.count * 0.9);
    console.log('\n现有题库（' + existing.from + '）' + existing.count + ' 题 → 本次 ' + srcQuestions.length +
      ' 题（缩水中止线 ' + floor + '）');
    if (srcQuestions.length < floor) {
      console.log('\n' + (FORCE ? '⚠️ 已越过闸门④（FORCE=1）' : '🛑 闸门④ 拦下') + '：新题数比现有少 ' +
        (existing.count - srcQuestions.length) + ' 题（超过 10%）');
      if (!FORCE) {
        console.log('   常见原因：飞书侧被误删，或 sheet 行数读取被截断。');
        console.log('   已中止，云端未被修改。确认确实删了这么多题 → 加 FORCE=1 重跑。');
        process.exitCode = 1;
        return;
      }
    }
  } else {
    console.log('\nℹ️ 云端还没有题库（' + existing.from + '），本次为首次全量写入');
  }

  // 5. 组装（手动区已砍：源区 7 类就是全部）
  const result = { categories: JSON.parse(JSON.stringify(CATEGORIES)), questions: srcQuestions };
  const json = JSON.stringify(result);
  console.log('\n========== 待写入 ==========');
  console.log('  ' + result.questions.length + ' 题 / ' + Object.keys(result.categories).length + ' 个品类 / ' +
    (json.length / 1024 / 1024).toFixed(2) + ' MB');

  // 6. 写入
  if (DRY_RUN) {
    console.log('\n🔍 DRY_RUN：闸门全部通过，跳过写入');
    try { await processVideos(); } catch (e) {}   // DRY_RUN 下只打印视频计划（processVideos 内部会跳过下载/上传）
    return;
  }
  console.log('\n☁️ 写入云端…');
  let writeTo = '';
  try {
    await supabaseWrite('questionBankData', json);
    writeTo = 'Supabase';
    console.log('✅ 已写入 Supabase');
  } catch (e) {
    console.log('⚠️ ' + e.message);
    if (await kvWrite('questionBankData', json)) {
      writeTo = 'KV';
      console.log('✅ 已转存 KV 兜底（Supabase 恢复后页面自动回灌）');
    } else {
      console.log('❌ KV 写入也失败');
    }
  }
  if (!writeTo) { console.log('\n❌ 写入失败，同步未完成'); process.exitCode = 1; return; }

  // 7. ★闸门⑤：写后回读校验 —— POST 返回 2xx 不代表真写进去了
  //    KV 有最终一致延迟，所以重试 3 次、每次隔 3 秒。校验不通过只报错并退出码 1（不覆盖、不回滚）。
  console.log('\n🔎 回读校验（目标 ' + writeTo + '）…');
  let verified = false, lastCount = -1, lastFrom = '';
  for (let i = 0; i < 3 && !verified; i++) {
    if (i) await new Promise(r => setTimeout(r, 3000));
    const after = await readExistingBank();
    if (!after.ok) { console.log('  第 ' + (i + 1) + ' 次：读不到'); continue; }
    lastCount = after.count; lastFrom = after.from;
    if (after.count === result.questions.length) {
      verified = true;
      console.log('✅ 回读一致：' + after.count + ' 题（' + after.from + '）');
      break;
    }
    console.log('  第 ' + (i + 1) + ' 次：回读 ' + after.count + ' 题 ≠ 写入 ' + result.questions.length + ' 题');
  }
  if (!verified) {
    console.log('\n❌ 闸门⑤：回读校验未通过（最后读到 ' +
      (lastCount < 0 ? '读不到' : lastCount + ' 题 / ' + lastFrom) + '，写入 ' + result.questions.length + ' 题 / ' + writeTo + '）');
    process.exitCode = 1;
    return;
  }
  // 8. 视频转存（2026-10-20）：放在题库写入成功之后才做 —— 大文件传输再慢也不会拖住题库主同步。
  //    附件视频 → KV（qbvideo_<fileToken>）；外链取不到字节 → 飞书卡片提醒人工转存。
  //    失败只影响视频（下周自动重试），题库已写成功。
  try {
    const videoResult = await processVideos();
    await sendVideoReminder(videoResult);
  } catch (e) {
    console.log('⚠️ 视频处理异常（题库已同步，不影响）：' + e.message);
  }

  console.log('\n🎉 同步完成' + (FORCE ? '（本次有闸门被 FORCE=1 越过，请确认结果符合预期）' : ''));
}

// —— 飞书告警卡片（workflow 的失败兜底步骤调用：node qb-weekly-sync.js --alert-only "消息"）——
//   复用 api()：它优先走应用身份，应用凭据不过期，所以告警不受个人 token 失效影响。
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'xuhang02@zhuanzhuan.com';
const RUN_URL = process.env.RUN_URL || '';
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
    if (!r.json || r.json.code !== 0) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
    console.log('📨 飞书卡片已发送');
  } catch (e) {
    console.log('⚠️ 飞书卡片发送失败: ' + e.message);
  }
}

const ARGV = process.argv.slice(2);
if (ARGV[0] === '--alert-only') {
  // 告警分支不走 main()，TOKEN 从未加载 → 应用身份一旦失败，用户 token 兜底会直接抛「均不可用」。
  // 这里补一次预加载（拿不到就算了，不影响应用身份那条路）。
  getToken().catch(e => console.log('ℹ️ 用户 token 预加载失败（不影响应用身份发送）：' + e.message))
    .then(() => sendCard('❌ 题库同步未完成', ARGV[1] || '（无详情）', 'red'))
    .then(() => process.exit(0));
} else {
  main().catch(e => { console.log('❌ 异常: ' + e.message); process.exit(1); });
}
