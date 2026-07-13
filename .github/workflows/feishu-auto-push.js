/**
 * 飞书周一自动推送 — GitHub Actions 云端全自动
 * 拉取上周数据 → 分析 → 按阈值出卷/学习/培训 → 飞书发送
 */
const https = require('https');
const FEISHU_CONFIG = {
    appId: 'cli_aab1fa4e87bbdbd3',
    appSecret: '1uLKmOkzQpoac6Ixw3Qhsb6KR1gCrcTn',
    spreadsheetToken: 'EdI0sn3qkh7H6wtkhcpcxrTnnDf',
    sheets: [
        { id: '4054dd', name: '初审失误登记', source: '初审', colDate: 0, colSite: 1, colQcCode: 3, colCategory: 6, colReviewer: 8, colNote: 9, colProduct: 5 },
        { id: 'mEiT35', name: '抽检失误登记', source: '抽检', colDate: 0, colSite: 1, colQcCode: 3, colCategory: 10, colReviewer: 6, colNote: 11, colProduct: 5 },
        { id: 'LIfICo', name: 'QA失误登记', source: 'QA', colDate: 0, colSite: 1, colQcCode: 2, colCategory: 4, colReviewer: 5, colNote: 6, colProduct: 3 }
    ]
};
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8';
const FEISHU_HOST = 'open.feishu.cn';
const PROXY_HOST = 'zfxwnixlvdxawoylhgxj.supabase.co';
const PROXY_PATH = '/functions/v1/feishu-proxy';

// ===== HTTP =====
function req(method, host, path, headers, body) {
    return new Promise((resolve, reject) => {
        const o = { hostname: host, path, method, headers: headers || {} };
        const r = https.request(o, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

async function feishuApiFetch(targetUrl, method, authToken, body) {
    const h = { 'Authorization': 'Bearer ' + SUPABASE_KEY, 'x-target-url': targetUrl, 'x-target-method': method || 'GET', 'Content-Type': 'application/json' };
    if (authToken) h['x-target-auth'] = 'Bearer ' + authToken;
    if (body) h['x-target-content-type'] = 'application/json';
    return req('POST', PROXY_HOST, PROXY_PATH, h, body);
}

async function getToken() {
    const b = JSON.stringify({ app_id: FEISHU_CONFIG.appId, app_secret: FEISHU_CONFIG.appSecret });
    const r = await req('POST', FEISHU_HOST, '/open-apis/auth/v3/tenant_access_token/internal', { 'Content-Type': 'application/json' }, b);
    if (!r.tenant_access_token) throw new Error('Token: ' + JSON.stringify(r));
    return r.tenant_access_token;
}

function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    const s = String(v).trim();
    const n = parseFloat(s);
    if (!isNaN(n) && n > 40000 && n < 100000) return new Date((n - 25569) * 86400 * 1000);
    const m = s.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}

function fmt(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

function isIn(d, s, e) {
    if (!d) return false;
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return dd >= new Date(s.getFullYear(), s.getMonth(), s.getDate()) && dd <= new Date(e.getFullYear(), e.getMonth(), e.getDate());
}

// ===== 上周 =====
function lastWeek() {
    const now = new Date();
    const dw = now.getDay() || 7;
    const mon = new Date(now); mon.setDate(now.getDate() - dw - 6); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23,59,59,999);
    return { start: mon, end: sun, key: fmt(mon) };
}

// ===== Supabase =====
async function supabaseGet(key) {
    const r = await req('GET', PROXY_HOST.split('.')[0]+'.'+PROXY_HOST.split('.').slice(1).join('.'),
        '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value&limit=1',
        { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY });
    if (Array.isArray(r) && r.length > 0) { try { return JSON.parse(r[0].value); } catch(e) {} }
    return null;
}

async function supabaseUpsert(key, value) {
    const b = JSON.stringify([{ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }]);
    await req('POST', PROXY_HOST.split('.')[0]+'.'+PROXY_HOST.split('.').slice(1).join('.'),
        '/rest/v1/app_data',
        { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }, b);
}

// ===== 卡片 =====
function card(type, d) {
    if (type === 'exam') return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + d.title }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + d.reviewerName + '** 上周失误 ' + d.count + ' 次，已达出卷阈值\n请完成精准考试，强化薄弱环节' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: d.examUrl || 'https://jimu-111.github.io/youxuetang/' }] }] };
    if (type === 'learn') return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + d.title }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + d.reviewerName + '** 上周失误 ' + d.count + ' 次\n建议查看学习地图，针对性提升' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: d.learnUrl || 'https://jimu-111.github.io/youxuetang/' }] }] };
    if (type === 'train') return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + d.title }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + d.reviewerName + '** 上周失误 ' + d.count + ' 次，已达培训阈值\n请查看培训资料，系统提升' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: d.trainUrl || 'https://jimu-111.github.io/youxuetang/' }] }] };
    return {};
}

async function sendCard(email, c, token) {
    const b = JSON.stringify({ receive_id: email, msg_type: 'interactive', content: JSON.stringify(c) });
    const r = await feishuApiFetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', 'POST', token, b);
    if (r.code !== 0) throw new Error(r.msg || 'send fail');
    return r;
}

// ===== 主流程 =====
async function main() {
    console.log('=== 飞书周一自动推送 ' + new Date().toISOString() + ' ===');
    const wk = lastWeek();
    console.log('上周: ' + wk.key + ' ~ ' + fmt(wk.end));

    const doneKey = 'auto_push_done_' + wk.key;
    if (await supabaseGet(doneKey)) { console.log('已推送，跳过'); return; }

    const token = await getToken();
    console.log('Token OK');

    // 拉取三个sheet数据
    let rows = [];
    for (const sh of FEISHU_CONFIG.sheets) {
        const url = 'https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/' + FEISHU_CONFIG.spreadsheetToken + '/values/' + sh.id + '?majorDimension=ROWS';
        const resp = await feishuApiFetch(url, 'GET', token);
        const vals = (resp.data && resp.data.valueRange && resp.data.valueRange.values) || [];
        console.log('  ' + sh.name + ': ' + vals.length + '行');
        for (let i = 2; i < vals.length; i++) {
            const row = vals[i];
            if (!row) continue;
            const d = parseDate(row[sh.colDate]);
            if (!isIn(d, wk.start, wk.end)) continue;
            const rv = String(row[sh.colReviewer] || '').trim();
            const cat = String(row[sh.colCategory] || '').trim();
            const site = String(row[sh.colSite] || '').trim();
            if (rv) rows.push({ reviewer: rv, category: cat, site, source: sh.source });
        }
    }
    console.log('上周失误: ' + rows.length + '条');

    if (rows.length === 0) { console.log('无数据'); return; }

    // 按初审人统计
    const rc = {};
    rows.forEach(r => { rc[r.reviewer] = (rc[r.reviewer] || 0) + 1; });

    // 阈值（与前端 getLightThresholds 保持一致）
    const th = { examMin: 6, learnMin: 11, trainMin: 16 };

    // 读邮箱
    const emails = (await supabaseGet('reviewerEmailMap')) || {};
    console.log('邮箱映射: ' + Object.keys(emails).length + '人');

    let sent = 0, fail = 0;
    const entries = Object.entries(rc).sort((a,b) => b[1]-a[1]);

    for (const [name, count] of entries) {
        const email = emails[name];
        if (!email) continue;

        if (count >= th.examMin) {
            try {
                await sendCard(email, card('exam', { title: name + ' 精准考试', reviewerName: name, count }), token);
                console.log('  📝 考试 → ' + name + '(' + count + ')');
                sent++;
            } catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= th.learnMin) {
            try {
                await sendCard(email, card('learn', { title: name + ' 学习地图', reviewerName: name, count }), token);
                console.log('  🗺️ 学习 → ' + name + '(' + count + ')');
                sent++;
            } catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= th.trainMin) {
            try {
                await sendCard(email, card('train', { title: name + ' 精准培训', reviewerName: name, count }), token);
                console.log('  📖 培训 → ' + name + '(' + count + ')');
                sent++;
            } catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
    }

    await supabaseUpsert(doneKey, { date: new Date().toISOString(), week: wk.key, sent, fail, total: rows.length });
    console.log('=== 完成: ' + sent + '成功 ' + fail + '失败 ===');
}

main().catch(e => { console.error(e.message); process.exit(1); });
