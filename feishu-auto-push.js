/**
 * 飞书周一自动推送 — GitHub Actions 云端全自动
 * 拉取上周数据 → 分析 → 按阈值出卷/学习/培训 → 飞书发送
 */

const FEISHU_APP_ID = 'cli_aab1fa4e87bbdbd3';
const FEISHU_APP_SECRET = '1uLKmOkzQpoac6Ixw3Qhsb6KR1gCrcTn';
const SPREADSHEET_TOKEN = 'EdI0sn3qkh7H6wtkhcpcxrTnnDf';
const SHEETS = [
    { id: '4054dd', name: '初审失误登记', colDate: 0, colReviewer: 8, colCategory: 6, colSite: 1 },
    { id: 'mEiT35', name: '抽检失误登记', colDate: 0, colReviewer: 6, colCategory: 10, colSite: 1 },
    { id: 'LIfICo', name: 'QA失误登记', colDate: 0, colReviewer: 5, colCategory: 4, colSite: 1 }
];
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8').trim();
const PROXY_URL = 'https://zfxwnixlvdxawoylhgxj.supabase.co/functions/v1/feishu-proxy';

// ===== 工具 =====
function fmt(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    const s = String(v).trim();
    const n = parseFloat(s);
    if (!isNaN(n) && n > 40000 && n < 100000) return new Date((n - 25569) * 86400 * 1000);
    const m = s.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}
function isIn(d, s, e) {
    if (!d) return false;
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return dd >= new Date(s.getFullYear(), s.getMonth(), s.getDate()) && dd <= new Date(e.getFullYear(), e.getMonth(), e.getDate());
}
function lastWeek() {
    const now = new Date();
    const dw = now.getDay() || 7;
    const mon = new Date(now); mon.setDate(now.getDate() - dw - 6); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23,59,59,999);
    return { start: mon, end: sun, key: fmt(mon) };
}

// ===== API 调用（使用 fetch，Node 18+ 原生） =====
async function getToken() {
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
    });
    const d = await r.json();
    if (!d.tenant_access_token) throw new Error('Token: ' + JSON.stringify(d));
    return d.tenant_access_token;
}

async function feishuProxy(targetUrl, method, authToken, body) {
    const r = await fetch(PROXY_URL, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'x-target-url': targetUrl,
            'x-target-method': method || 'GET',
            'x-target-auth': 'Bearer ' + authToken,
            'Content-Type': 'application/json'
        },
        body: body || undefined
    });
    return r.json();
}

async function fetchSheet(sheetId, token) {
    const url = 'https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/' + SPREADSHEET_TOKEN + '/values/' + sheetId + '?majorDimension=ROWS';
    const d = await feishuProxy(url, 'GET', token);
    if (d.code !== 0) throw new Error('Sheet读取失败: ' + (d.msg || ''));
    return (d.data && d.data.valueRange && d.data.valueRange.values) || [];
}

async function supabaseGet(key) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value&limit=1', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length > 0) { try { return JSON.parse(arr[0].value); } catch(e) {} }
    return null;
}

async function supabaseUpsert(key, value) {
    await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify([{ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }])
    });
}

async function sendCard(email, card, token) {
    const body = JSON.stringify({ receive_id: email, msg_type: 'interactive', content: JSON.stringify(card) });
    const d = await feishuProxy('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', 'POST', token, body);
    if (d.code !== 0) throw new Error(d.msg || '发送失败');
    return d;
}

// ===== 卡片 =====
function buildCard(type, d) {
    if (type === 'exam') return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + d.title }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + d.reviewerName + '** 上周失误 ' + d.count + ' 次，已达出卷阈值\n请完成精准考试，强化薄弱环节' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: d.examUrl || 'https://jimu-111.github.io/youxuetang/' }] }] };
    if (type === 'learn') return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + d.title }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + d.reviewerName + '** 上周失误 ' + d.count + ' 次\n建议查看学习地图，针对性提升' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: d.learnUrl || 'https://jimu-111.github.io/youxuetang/' }] }] };
    if (type === 'train') return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + d.title }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + d.reviewerName + '** 上周失误 ' + d.count + ' 次，已达培训阈值\n请查看培训资料，系统提升' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: d.trainUrl || 'https://jimu-111.github.io/youxuetang/' }] }] };
    return {};
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

    let rows = [];
    for (const sh of SHEETS) {
        const vals = await fetchSheet(sh.id, token);
        console.log('  ' + sh.name + ': ' + vals.length + '行');
        for (let i = 2; i < vals.length; i++) {
            const row = vals[i]; if (!row) continue;
            const d = parseDate(row[sh.colDate]);
            if (!isIn(d, wk.start, wk.end)) continue;
            const rv = String(row[sh.colReviewer] || '').trim();
            if (rv) rows.push({ reviewer: rv, category: String(row[sh.colCategory]||'').trim(), site: String(row[sh.colSite]||'').trim() });
        }
    }
    console.log('上周失误: ' + rows.length + '条');
    if (rows.length === 0) { console.log('无数据'); return; }

    const rc = {};
    rows.forEach(r => { rc[r.reviewer] = (rc[r.reviewer] || 0) + 1; });

    const th = { examMin: 6, learnMin: 11, trainMin: 16 };
    const emails = (await supabaseGet('reviewerEmailMap')) || {};
    console.log('邮箱映射: ' + Object.keys(emails).length + '人');

    let sent = 0, fail = 0;
    for (const [name, count] of Object.entries(rc).sort((a,b) => b[1]-a[1])) {
        const email = emails[name];
        if (!email) continue;
        if (count >= th.examMin) {
            try { await sendCard(email, buildCard('exam', { title: name+' 精准考试', reviewerName: name, count }), token); console.log('  📝 考试 → ' + name+'('+count+')'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= th.learnMin) {
            try { await sendCard(email, buildCard('learn', { title: name+' 学习地图', reviewerName: name, count }), token); console.log('  🗺️ 学习 → ' + name+'('+count+')'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= th.trainMin) {
            try { await sendCard(email, buildCard('train', { title: name+' 精准培训', reviewerName: name, count }), token); console.log('  📖 培训 → ' + name+'('+count+')'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
    }

    await supabaseUpsert(doneKey, { date: new Date().toISOString(), week: wk.key, sent, fail, total: rows.length });
    console.log('=== 完成: ' + sent + '成功 ' + fail + '失败 ===');
}

main().catch(e => { console.error(e.message); process.exit(1); });
