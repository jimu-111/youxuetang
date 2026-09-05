/**
 * 题库每周一同步（2026-09-05）：
 * 每周一 8:00（北京时间，GitHub Actions UTC 周一 0:00）读飞书总表 7 个品类 tab
 * 全量覆盖 7 个源品类，跳过「手动录入题目」区（独立第 8 品类永不触碰）
 * 写入 Supabase questionBankData（402 挂断则 KV 兜底），本地不备份（Actions 无持久盘）
 * 与 qb-import-categories.js 同套：user token 自持循环（KV /token 取，401 用 refresh_token 换新写回）
 */
const https = require('https');
const fs = require('fs');

const PAGES = 'https://yxt-feishu.pages.dev';
const SECRET = 'yxt-feishu-2026';
const SS_TOKEN = 'BzG8s8py3hDZIvtUJl7cRXJXnfe'; // 总表（含全部 7 个品类 tab）
const APP_ID = 'cli_aab1fa4e87bbdbd3';
const APP_SECRET = '1uLKmOkzQpoac6Ixw3Qhsb6KR1gCrcTn';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co').replace(/\/$/, '').replace(/\s/g, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8').replace(/\s/g, '');
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';

// 8 个品类定义（categories key = 品类中文名；key 字段为英文标识）
const CATEGORIES = {
  '手机':           { name: '手机',            key: 'phone',    order: 1, source: true },
  '平板':           { name: '平板',            key: 'tablet',   order: 2, source: true },
  '笔记本':         { name: '笔记本',          key: 'laptop',   order: 3, source: true },
  '手表':           { name: '手表',            key: 'watch',    order: 4, source: true },
  '耳机':           { name: '耳机',            key: 'earphone', order: 5, source: true },
  '相机&镜头':      { name: '相机&镜头',       key: 'camera',   order: 6, source: true },
  '游戏机&游戏卡带': { name: '游戏机&游戏卡带', key: 'console',  order: 7, source: true },
  '手动录入题目':    { name: '手动录入题目',    key: 'manual',   order: 8, source: false }
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
async function api(path, extra) {
  let r = await viaProxy(path, TOKEN.access_token, extra);
  if (r.status === 401 || (r.json && (r.json.code === 99991663 || r.json.code === 99991661))) {
    console.log('  access token 失效，刷新中…');
    const rt = TOKEN.refresh_token;
    if (!rt) throw new Error('无 refresh_token 可刷新');
    const ref = await viaProxy('/authen/v1/oidc/refresh_access_token', '', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt, app_id: APP_ID, app_secret: APP_SECRET })
    });
    if (ref.status !== 200 || !ref.json || !ref.json.data) throw new Error('刷新失败: ' + ref.status + ' ' + JSON.stringify(ref.json).slice(0, 200));
    TOKEN = ref.json.data;
    console.log('  刷新成功，有效期至 ' + new Date(Date.now() + TOKEN.expires_in * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    // 新 refresh_token 写回 KV（永不断）
    await httpJson(PAGES + '/token', {
      method: 'POST', headers: { 'x-yxt-secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: TOKEN.access_token, refresh_token: TOKEN.refresh_token })
    }).catch(() => console.log('  ⚠️ 新 token 写回 KV 失败（不影响本次运行）'));
    r = await viaProxy(path, TOKEN.access_token, extra);
  }
  return r;
}

// —— 图片 cell 提取 fileToken ——
function extractFileTokens(cell) {
  if (!cell) return [];
  const list = Array.isArray(cell) ? cell : [cell];
  return list.filter(c => c && typeof c === 'object' && c.fileToken).map(c => c.fileToken);
}
function cellText(cell) {
  if (cell === undefined || cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  return '';
}

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
      const toks = extractFileTokens(row[colIdx]);
      if (toks.length && options[i]) options[i].images = toks;
    });
    const qImages = cQImg >= 0 ? extractFileTokens(row[cQImg]) : [];
    const aImages = cAImg >= 0 ? extractFileTokens(row[cAImg]) : [];
    questions.push({
      id: 'qb_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      sourceId: sourceId,
      type: inferType(cType >= 0 ? row[cType] : '', answer),
      question: text,
      options: options,
      answer: answer,
      explanation: cAnalysis >= 0 ? cellText(row[cAnalysis]).trim() : '',
      images: qImages,
      analysisImages: aImages,
      difficulty: '中等',
      createdAt: new Date().toISOString()
    });
  }
  return questions;
}

// —— 读现有题库（Supabase 优先，失败 KV 兜底）——
async function readExistingBank() {
  try {
    const u = new URL(SUPABASE_URL + '/rest/v1/app_data?key=eq.questionBankData&select=value&limit=1');
    const r = await httpJson(u.toString(), { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } });
    if (r.status === 200 && r.json && Array.isArray(r.json) && r.json.length > 0 && r.json[0].value) {
      const parsed = JSON.parse(r.json[0].value);
      console.log('✅ Supabase 读取现有题库: ' + (parsed.questions || []).length + ' 题');
      return parsed;
    }
    throw new Error('Supabase 读题失败 HTTP ' + r.status);
  } catch (e) {
    console.log('⚠️ ' + e.message + '，转 KV 兜底读');
    const kv = await httpJson(PAGES + '/data?key=questionBankData', { headers: { 'x-yxt-secret': SECRET } });
    if (kv.status === 200 && kv.json && typeof kv.json.value === 'string') {
      try {
        const o = JSON.parse(kv.json.value);
        const parsed = JSON.parse(o.v);
        console.log('✅ KV 读取现有题库: ' + (parsed.questions || []).length + ' 题');
        return parsed;
      } catch (e2) {}
    }
    console.log('⚠️ 现有题库读不到（Supabase/KV 均失败），视为题库为空，同步后全量重建源区');
    return { categories: {}, questions: [] };
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

async function main() {
  console.log('========== 题库周一同步 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + (DRY_RUN ? ' [DRY_RUN 只读不写]' : '') + ' ==========');
  await getToken();
  console.log('✅ 飞书 token 就绪');

  // 1. 子表列表
  const q = await api('/sheets/v3/spreadsheets/' + SS_TOKEN + '/sheets/query');
  if (q.status !== 200 || !q.json || q.json.code !== 0) { console.log('❌ sheets/query 失败:', q.status, JSON.stringify(q.json).slice(0, 200)); process.exitCode = 1; return; }
  const sheets = (q.json.data && q.json.data.sheets) || [];
  console.log('子表数: ' + sheets.length);

  // 2. 逐品类读取解析
  const srcQuestions = []; // 源区 7 类新题
  const stat = {};
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
    if (v.status !== 200 || !v.json || v.json.code !== 0) { console.log('  ❌ 读值失败:', v.status, JSON.stringify(v.json).slice(0, 150)); continue; }
    const rows = v.json.data.valueRange.values || [];
    const qs = parseSheetRows(rows, title);
    qs.forEach(question => {
      question.categoryId = CATEGORIES[catName].key;
      question.category = catName;
      question.productCategory = catName;
      srcQuestions.push(question);
    });
    stat[catName] = qs.length;
    console.log('  ✅ ' + catName + ' 解析出 ' + qs.length + ' 题');
  }

  // 3. 读现有题库，保留手动区题目（categoryId=manual 或 category=手动录入题目）
  const existing = await readExistingBank();
  const manualQuestions = (existing.questions || []).filter(q => {
    return q.categoryId === 'manual' || q.category === '手动录入题目';
  });
  console.log('\n手动区保留: ' + manualQuestions.length + ' 题（永不触碰）');

  // 4. 组装新题库：源区全量覆盖 + 手动区保留
  const result = { categories: JSON.parse(JSON.stringify(CATEGORIES)), questions: srcQuestions.concat(manualQuestions) };
  const total = result.questions.length;
  console.log('\n========== 汇总 ==========');
  Object.keys(stat).forEach(k => console.log('  ' + CATEGORIES[k].name + ': ' + stat[k] + ' 题（全量覆盖）'));
  console.log('  手动录入题目: ' + manualQuestions.length + ' 题（保留）');
  console.log('  总计: ' + total + ' 题');
  if (srcQuestions.length === 0) { console.log('❌ 源区解析 0 题，终止（保护现有题库不被清空）'); process.exitCode = 1; return; }

  // 5. 写入
  const json = JSON.stringify(result);
  console.log('\n💾 新题库 JSON: ' + (json.length / 1024 / 1024).toFixed(2) + ' MB');
  if (DRY_RUN) { console.log('🔍 DRY_RUN：跳过写入'); return; }
  console.log('☁️ 写入云端…');
  try {
    await supabaseWrite('questionBankData', json);
    console.log('✅ 已写入 Supabase');
  } catch (e) {
    console.log('⚠️ ' + e.message);
    const ok = await kvWrite('questionBankData', json);
    console.log(ok ? '✅ 已转存 KV 兜底（Supabase 恢复后页面自动回灌）' : '❌ KV 写入也失败，请检查网络');
  }
  console.log('\n🎉 同步流程结束');
}

main().catch(e => { console.log('❌ 异常: ' + e.message); process.exit(1); });
