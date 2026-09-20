/**
 * 周一推送结果检查
 * 检查 GitHub Actions 今天的「周一自动推送」运行状态，飞书发结果卡片给管理员
 * 计划任务：每周一 12:30 主查 + 每天 14:00 补查（幂等：同一天相同状态不重复发，状态变化才再发）
 * 用法：node feishu-push-check.js [--force]（--force 忽略幂等强制发，试跑用）
 */
const fs = require('fs');
const ADMIN_EMAIL = 'xuhang02@zhuanzhuan.com';
const FEISHU_APP_ID = 'cli_aab1fa4e87bbdbd3';
// 2026-09-20：密钥不再写在本文件里，改从本地密钥文件读（这份只在你自己电脑上，不进仓库/网页）。
// 取不到就当场抛错 —— 本脚本是「周一推送没跑成功」的唯一告警，它自己静默失效等于告警消失。
const FEISHU_APP_SECRET = (function () {
    try { return fs.readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); }
    catch (e) { throw new Error('读不到本地密钥文件 C:\\Users\\xuhan\\yxt\\feishu-secret.txt：' + e.message); }
})();
const SUPABASE_URL = 'https://zfxwnixlvdxawoylhgxj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8';
const REPO = 'jimu-111/youxuetang';
const WORKFLOW_NAME = '周一自动推送';
const RUN_URL = 'https://github.com/jimu-111/youxuetang/actions/workflows/auto-push.yml';
const STATE_FILE = __dirname + '\\check-state.json';

function fmt(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtTime(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
// GitHub 时间是 UTC，转北京时间后取日期
function beijingDate(isoStr) { return new Date(new Date(isoStr).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

async function getAppToken() {
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
    });
    const d = await r.json();
    if (!d.tenant_access_token) throw new Error('AppToken: ' + JSON.stringify(d));
    return d.tenant_access_token;
}

async function sendCard(card, token) {
    const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receive_id: ADMIN_EMAIL, msg_type: 'interactive', content: JSON.stringify(card) })
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error('sendCard: ' + JSON.stringify(d));
}

async function fetchTodayRuns() {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs?per_page=10', {
        headers: { 'User-Agent': 'youxuetang-push-check', 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error('GitHub API: ' + r.status);
    const d = await r.json();
    const today = fmt(new Date());
    return d.workflow_runs.filter(function (x) { return x.name === WORKFLOW_NAME && beijingDate(x.created_at) === today; });
}

async function getDoneInfo() {
    const key = 'auto_push_done_' + fmt(new Date());
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value&limit=1', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length > 0) { try { return JSON.parse(arr[0].value); } catch (e) { return null; } }
    return null;
}

async function main() {
    const force = process.argv.includes('--force');
    const now = new Date();
    if (now.getDay() !== 1 && !force) { console.log('[' + now.toISOString() + '] 今天不是周一，跳过'); return; }
    const today = fmt(now);
    console.log('[' + now.toISOString() + '] 开始检查今日推送状态' + (force ? '（--force 强制发）' : ''));

    // 1. 查 GitHub 今天的推送运行记录
    let result;
    try {
        const runs = await fetchTodayRuns();
        if (runs.length === 0) {
            result = { status: 'not_triggered', text: '今天 GitHub 定时推送**没有触发**（可能是触发器又丢失了），请点击下方按钮手动补跑。' };
        } else {
            const run = runs[runs.length - 1]; // 取最新一条
            if (run.status === 'queued' || run.status === 'in_progress' || run.status === 'pending') {
                result = { status: 'running', text: '推送**正在运行中**（' + fmtTime(new Date(run.created_at)) + ' 开始），完成后留意飞书消息。' };
            } else if (run.conclusion === 'success') {
                const done = await getDoneInfo();
                const sent = done && typeof done === 'object' ? (done.sent || 0) : null;
                const fail = done && typeof done === 'object' ? (done.fail || 0) : null;
                const detail = sent === null ? '运行成功（标记数据未找到）' : '**成功 ' + sent + ' 条**' + (fail ? '，失败 ' + fail + ' 条' : '');
                result = { status: 'success', text: '本周考试推送**已完成** ✅\n' + detail + '\n（' + fmtTime(new Date(run.created_at)) + ' 开始）', runUrl: run.html_url };
            } else {
                result = { status: 'failed', text: '推送运行**失败**（结论：' + run.conclusion + '），点击下方按钮查看日志。', runUrl: run.html_url };
            }
        }
    } catch (e) {
        result = { status: 'check_error', text: '检查器自身出错：' + e.message };
    }
    console.log('检查结果: ' + result.status);

    // 2. 幂等：今天同状态已发过则不重复发（状态变化才再发）
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { }
    if (!force && prev && prev.date === today && prev.status === result.status) {
        console.log('今天已发过同状态（' + result.status + '），跳过发送');
        return;
    }

    // 3. 飞书发卡片
    const cardMap = {
        success: { title: '📝 本周考试推送完成', color: 'green', button: { text: '🔎 查看运行', url: null } },
        not_triggered: { title: '🚨 本周考试未推送', color: 'red', button: { text: '📤 手动补跑', url: RUN_URL } },
        running: { title: '⏳ 推送运行中', color: 'blue', button: null },
        failed: { title: '❌ 推送运行失败', color: 'red', button: { text: '📋 查看日志', url: null } },
        check_error: { title: '⚠️ 推送检查器出错', color: 'red', button: null }
    };
    const meta = cardMap[result.status];
    const elements = [{ tag: 'div', text: { tag: 'lark_md', content: '**' + today + '（周一）** ' + result.text } }];
    if (meta.button && (meta.button.url || result.runUrl)) {
        elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: meta.button.text }, type: 'primary', url: meta.button.url || result.runUrl }] });
    }
    const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: meta.title }, template: meta.color }, elements: elements };
    const token = await getAppToken();
    await sendCard(card, token);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ date: today, status: result.status, updatedAt: new Date().toISOString() }));
    console.log('已发送飞书卡片（' + result.status + '）');
}

// 2026-09-13：原来这里只写一行日志、**不发卡片** —— 检查器自己坏掉时用户收不到任何通知。
// 「推送检查」的两个计划任务曾因 bat 是 LF 换行而静默失败多日（check-state.json 停在 08-31），
// 正是因为这条路径不会告警，才一直没人发现。现在兜底发一张卡片。
// 注意：崩因很可能就是「网络/飞书不通」，所以发送本身必须 best-effort，绝不能二次抛出。
// 非周一不会走到这里（main 里在取 force/now 之后就 return 了，那里不可能抛），所以不会打扰非周一。
main().catch(async function (e) {
    console.error('检查器异常: ' + e.message);
    try {
        const today = fmt(new Date());
        // 与主流程同样的幂等：今天已经报过「检查器出错」就不再重复发（主查+补查会跑两次）
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e2) { }
        if (prev && prev.date === today && prev.status === 'check_error') {
            console.log('今天已发过「检查器出错」，跳过');
            return;
        }
        const card = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: '⚠️ 推送检查器出错' }, template: 'red' },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + today + '** 检查器**自己异常退出**了：' + e.message + '\n本次**没能检查**推送状态，请手动确认 GitHub 上的运行情况。' } }]
        };
        const token = await getAppToken();
        await sendCard(card, token);
        fs.writeFileSync(STATE_FILE, JSON.stringify({ date: today, status: 'check_error', updatedAt: new Date().toISOString() }));
        console.log('已发送「检查器出错」卡片');
    } catch (e2) {
        console.error('兜底告警也发不出去: ' + e2.message);
    }
});
