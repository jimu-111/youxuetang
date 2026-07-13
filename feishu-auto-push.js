/**
 * 飞书周一自动推送 — GitHub Actions 云端全自动
 * 从 Supabase 读取已生成的考试/培训/学习，发送真实链接
 */
const fs = require('fs');
const FEISHU_APP_ID = 'cli_aab1fa4e87bbdbd3';
const FEISHU_APP_SECRET = '1uLKmOkzQpoac6Ixw3Qhsb6KR1gCrcTn';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co').replace(/\/$/, '').replace(/\s/g, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8').replace(/\s/g, '');
const PROXY_URL = 'https://zfxwnixlvdxawoylhgxj.supabase.co/functions/v1/feishu-proxy';
const SITE_URL = 'https://jimu-111.github.io/youxuetang/';

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

// ===== API =====
async function getAppToken() {
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
    });
    const d = await r.json();
    if (!d.tenant_access_token) throw new Error('AppToken: ' + JSON.stringify(d));
    return d.tenant_access_token;
}

async function supabaseGet(key) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value&limit=1', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length > 0) { try { return JSON.parse(arr[0].value); } catch(e) {} }
    return null;
}

async function sendCard(email, card, token) {
    const body = JSON.stringify({ receive_id: email, msg_type: 'interactive', content: JSON.stringify(card) });
    const h = { 'Authorization': 'Bearer ' + SUPABASE_KEY, 'x-target-url': 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', 'x-target-method': 'POST', 'x-target-auth': 'Bearer ' + token, 'Content-Type': 'application/json' };
    const r = await fetch(PROXY_URL, { method: 'POST', headers: h, body: body });
    const d = await r.json();
    if (d.code !== 0) throw new Error(d.msg || 'send fail');
    return d;
}

function examCard(name, count) {
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + name + ' 精准考试' }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达出卷阈值（≥6次）\n点击下方按钮自动出卷并开始考试' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: SITE_URL + '?autoExam=' + encodeURIComponent(name) }] }] };
}
function learnCard(name, count) {
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + name + ' 学习地图' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达学习阈值（≥11次）\n点击下方按钮查看学习地图' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: SITE_URL + '?autoLearn=' + encodeURIComponent(name) }] }] };
}
function trainCard(name, count) {
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + name + ' 精准培训' }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达培训阈值（≥16次）\n点击下方按钮查看培训资料' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: SITE_URL + '?autoTrain=' + encodeURIComponent(name) }] }] };
}

// ===== 主流程 =====
async function main() {
    console.log('=== 飞书周一自动推送 ' + new Date().toISOString() + ' ===');
    const wk = lastWeek();
    console.log('上周: ' + wk.key + ' ~ ' + fmt(wk.end));

    const doneKey = 'auto_push_done_' + wk.key;
    if (await supabaseGet(doneKey)) { console.log('已推送，跳过'); return; }

    const appToken = await getAppToken();
    const emails = (await supabaseGet('personnelEmails')) || {};
    console.log('Token OK, 邮箱: ' + Object.keys(emails).length + '人');

    let sent = 0, fail = 0;

    // 从飞书获取用户的 token 读表格
    const stored = await supabaseGet('feishu_token');
    var userToken = appToken;
    if (stored && stored.access_token && stored.expiresAt > Date.now()) userToken = stored.access_token;

    // 拉取上周数据，分析按人统计
    let rows = [];
    const FEISHU_SHEETS = [
        { id: '4054dd', colDate: 0, colReviewer: 8 }, { id: 'mEiT35', colDate: 0, colReviewer: 6 }, { id: 'LIfICo', colDate: 0, colReviewer: 5 }
    ];
    for (const sh of FEISHU_SHEETS) {
        try {
            const r2 = await fetch(PROXY_URL, { method: 'POST', headers: { 'Authorization': 'Bearer ' + SUPABASE_KEY, 'x-target-url': 'https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/EdI0sn3qkh7H6wtkhcpcxrTnnDf/values/' + sh.id + '?majorDimension=ROWS', 'x-target-method': 'GET', 'x-target-auth': 'Bearer ' + userToken } });
            const d2 = await r2.json();
            const vals = (d2.data && d2.data.valueRange && d2.data.valueRange.values) || [];
            for (let i = 2; i < vals.length; i++) {
                const row = vals[i]; if (!row) continue;
                const d = parseDate(row[sh.colDate]); if (!isIn(d, wk.start, wk.end)) continue;
                const rv = String(row[sh.colReviewer] || '').trim();
                if (rv) rows.push({ reviewer: rv });
            }
        } catch(e) {}
    }

    const rc = {};
    rows.forEach(r => { rc[r.reviewer] = (rc[r.reviewer] || 0) + 1; });
    console.log('上周失误: ' + rows.length + '条, ' + Object.keys(rc).length + '人');

    const TH = { examMin: 6, learnMin: 11, trainMin: 16 };

    for (const [name, count] of Object.entries(rc).sort((a,b) => b[1]-a[1])) {
        const email = emails[name];
        if (!email) continue;
        if (count >= TH.examMin) {
            try { await sendCard(email, examCard(name, count), appToken); console.log('  📝 考试 → ' + name+'('+count+')'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= TH.learnMin) {
            try { await sendCard(email, learnCard(name, count), appToken); console.log('  🗺️ 学习 → ' + name+'('+count+')'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= TH.trainMin) {
            try { await sendCard(email, trainCard(name, count), appToken); console.log('  📖 培训 → ' + name+'('+count+')'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
    }

    // 标记已完成
    await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify([{ key: doneKey, value: JSON.stringify({ date: new Date().toISOString(), week: wk.key, sent, fail }), updated_at: new Date().toISOString() }])
    });
    console.log('=== 完成: ' + sent + '成功 ' + fail + '失败 ===');
}

main().catch(e => { console.error(e.message); process.exit(1); });
