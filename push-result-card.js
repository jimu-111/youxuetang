/**
 * 周一自动推送「结果卡片」（2026-11-09 建）
 *
 * 目的：只要推送跑过，就给徐行发一张飞书卡片说明结果 ——
 *   · 成功、发了 N 条
 *   · 成功、但本次无人达到推送门槛（0 条）
 *   · 失败 / 被取消
 *
 * 由 .github/workflows/auto-push.yml 在「分析上周数据并推送」之后用 if: always() 调用，
 * 所以即使推送脚本失败，这张卡也会发。不依赖本机、不依赖计划任务。
 *
 * 幂等：发完写 auto_push_notified_<日期>；同一天再跑（Cloudflare + GitHub 两条通道）不会重复发。
 * 本机的 feishu-push-check.js 也会先看这条标记，避免重复。
 */
const ADMIN_EMAIL = 'xuhang02@zhuanzhuan.com';
const FEISHU_APP_ID = 'cli_aab1fa4e87bbdbd3';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const OUTCOME = String(process.env.PUSH_OUTCOME || '').trim();
const RUN_URL = process.env.RUN_URL || 'https://github.com/jimu-111/youxuetang/actions/workflows/auto-push.yml';
const KV_PAGES = 'https://yxt-feishu.pages.dev';

function bjDate(d) {
    return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 手动补跑可能不在周一，卡片上的星期按实际日期写，别写死「周一」
function weekdayCn(dateStr) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

async function supabaseGet(key) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value&limit=1', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    try { return JSON.parse(arr[0].value); } catch (e) { return null; }
}

async function supabaseSet(key, value) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify([{ key: key, value: JSON.stringify(value), updated_at: new Date().toISOString() }])
    });
}

// 与 feishu-auto-push.js 同样的退路：有密钥直连；没配 Secret 或直连被拒就走 Pages 代理，
// 由代理用 Cloudflare 环境变量里的真值补上 app_secret（不然没配 Secret 时这张卡会哑掉）。
async function feishuPost(path, body) {
    const url = 'https://open.feishu.cn/open-apis' + path;
    if (FEISHU_APP_SECRET) {
        try {
            const r = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const d = await r.json();
            if (d && d.code === 0) return d;
            console.log('  ⚠️ 直连飞书被拒（code=' + (d && d.code) + ' ' + ((d && d.msg) || '') + '），改走代理重试');
        } catch (e) {
            console.log('  ⚠️ 直连飞书网络错误（' + e.message + '），改走代理重试');
        }
    }
    const r = await fetch(KV_PAGES, {
        method: 'POST',
        headers: {
            'x-target-url': url,
            'x-target-method': 'POST',
            'x-target-content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    return await r.json();
}

async function getAppToken() {
    const d = await feishuPost('/auth/v3/tenant_access_token/internal', {
        app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET
    });
    if (!d.tenant_access_token) throw new Error('拿不到飞书应用 token：' + JSON.stringify(d));
    return d.tenant_access_token;
}

async function sendCard(card, token) {
    const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receive_id: ADMIN_EMAIL, msg_type: 'interactive', content: JSON.stringify(card) })
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error('发卡片失败：' + JSON.stringify(d));
}

function buildCard(today, sent, fail, hasDone) {
    let title, color, text, buttonText = '🔎 查看运行';

    if (OUTCOME === 'success') {
        title = '📝 本周考试推送完成';
        color = 'green';
        if (!hasDone) {
            text = '本周推送**已运行** ✅\n运行成功，但没有找到本次的统计标记。';
        } else if (sent > 0) {
            text = '本周考试推送**已完成** ✅\n**成功 ' + sent + ' 条**' + (fail ? '，失败 ' + fail + ' 条' : '');
        } else {
            text = '本周推送**已运行** ✅\n**本次无人达到推送门槛**（考试 ≥6 / 培训 ≥11 / 学习 ≥16 次），没有给员工发考试卡片。';
        }
    } else if (OUTCOME === 'failure') {
        title = '❌ 推送运行失败';
        color = 'red';
        text = '本周推送**运行失败** ❌\n点击下方按钮查看运行日志。';
        buttonText = '📋 查看日志';
    } else if (OUTCOME === 'cancelled') {
        title = '⚠️ 推送被取消';
        color = 'orange';
        text = '本周推送**被取消**了（' + (OUTCOME || '无结果') + '）。';
        buttonText = '📋 查看运行';
    } else if (OUTCOME === 'skipped') {
        title = '⚠️ 推送被跳过';
        color = 'orange';
        text = '本次推送步骤**被跳过**了（前面的步骤可能失败），请点开运行记录查看原因。';
        buttonText = '📋 查看运行';
    } else {
        title = '⚠️ 推送结果未知';
        color = 'grey';
        text = '推送步骤结束了，但没有拿到明确结果（' + (OUTCOME || '空') + '）。';
    }

    const elements = [{ tag: 'div', text: { tag: 'lark_md', content: '**' + today + '（' + weekdayCn(today) + '）** ' + text } }];
    elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: buttonText }, type: 'primary', url: RUN_URL }] });
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: title }, template: color }, elements };
}

async function main() {
    const today = bjDate(new Date());

    // 同一天、同一结果已经发过（可能是另一条触发通道先跑完）就不重复发。
    // 结果变了（比如先失败、手动补跑后成功）要再发一张，不能因为「今天发过」就把成功消息吞掉。
    const notified = await supabaseGet('auto_push_notified_' + today).catch(function () { return null; });
    if (notified && notified.status === (OUTCOME || 'unknown')) {
        console.log('今天已发过同结果（' + (notified.status || '?') + '）的卡片，跳过');
        return;
    }

    const done = await supabaseGet('auto_push_done_' + today).catch(function () { return null; });
    const hasDone = done && typeof done === 'object';
    const sent = hasDone ? Number(done.sent || 0) : 0;
    const fail = hasDone ? Number(done.fail || 0) : 0;

    const card = buildCard(today, sent, fail, hasDone);
    const token = await getAppToken();
    await sendCard(card, token);

    // 先发卡再写标记：写标记失败也不会影响卡片已经发出去
    await supabaseSet('auto_push_notified_' + today, {
        status: OUTCOME || 'unknown', sent: sent, fail: fail, at: new Date().toISOString()
    }).catch(function () { });

    console.log('已发送结果卡片：' + card.header.title.content + '（sent=' + sent + ', fail=' + fail + ', outcome=' + (OUTCOME || '空') + '）');
}

if (require.main === module) {
    main().catch(function (e) {
        console.error('结果卡片发送失败：' + e.message);
        process.exit(1);
    });
}

// 给本机测试用（node -e 里 require 进来单独验卡片文案/流程，不会真发）
module.exports = { buildCard: buildCard, main: main };
