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
    if (process.env.FORCE_RUN !== 'true' && await supabaseGet(doneKey)) { console.log('已推送，跳过'); return; }
    if (process.env.FORCE_RUN === 'true') console.log('⚠️ 强制运行模式（已忽略推送标记）');

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

    // 同时记录每人的失误类别分布
    const rc = {};
    const rCat = {}; // { name: { category: count } }
    rows.forEach(r => {
        rc[r.reviewer] = (rc[r.reviewer] || 0) + 1;
        if (!rCat[r.reviewer]) rCat[r.reviewer] = {};
        var cat = r.category || '其他';
        rCat[r.reviewer][cat] = (rCat[r.reviewer][cat] || 0) + 1;
    });
    console.log('上周失误: ' + rows.length + '条, ' + Object.keys(rc).length + '人');

    // 读题库和考试历史，按失误类别比例出卷
    const examHistory = (await supabaseGet('examHistoryData')) || {};
    const qbData = (await supabaseGet('questionBankData')) || {};
    const allQuestions = qbData.questions || [];

    const examCodeChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    function genExamCode() {
        var code = '';
        for (var i = 0; i < 6; i++) code += examCodeChars[Math.floor(Math.random() * examCodeChars.length)];
        return code;
    }
    // 类别名标准化（模拟前端的 mergeCategory 简化版）
    function normCat(c) {
        c = (c || '').trim();
        if (!c) return '其他';
        // 去掉数字后缀，统一相似类别
        return c.replace(/[\d]+$/, '').replace(/[（(].*[)）]/g, '').trim() || c;
    }

    const TH = { examMin: 6, learnMin: 11, trainMin: 16 };

    for (const [name, count] of Object.entries(rc).sort((a,b) => b[1]-a[1])) {
        if (count >= TH.examMin) {
            // 检查本周是否已有考试
            var hasExam = Object.values(examHistory).some(function(e) {
                if (e.reviewerName !== name) return false;
                var t = new Date(e.generatedAt || e.time || 0);
                return t >= wk.start && t <= wk.end;
            });
            if (hasExam) continue;
            if (allQuestions.length < 5) continue;

            // 按失误类别比例选题
            var cats = rCat[name] || {};
            var totalMistakes = Object.values(cats).reduce(function(a,b){return a+b;},0);
            // 合并标准化类别
            var merged = {};
            Object.entries(cats).forEach(function(e) {
                var nc = normCat(e[0]);
                merged[nc] = (merged[nc] || 0) + e[1];
            });
            // 按比例分配题数（最少1题，最多20题）
            var qCount = 20; // 固定20题
            var selected = [];
            var slots = qCount;
            var catList = Object.entries(merged).sort(function(a,b){return b[1]-a[1];});
            // 每个类别按比例分配
            for (var ci = 0; ci < catList.length && slots > 0; ci++) {
                var catName = catList[ci][0];
                var catRatio = catList[ci][1] / totalMistakes;
                var catSlots = Math.max(1, Math.min(slots, Math.ceil(qCount * catRatio)));
                if (ci === catList.length - 1) catSlots = slots; // 最后一个类别拿剩余
                // 从题库找匹配该类别的题
                var catQuestions = allQuestions.filter(function(q) {
                    var qc = normCat(q.category || q.type || '');
                    return qc === catName || qc.includes(catName) || catName.includes(qc);
                });
                if (catQuestions.length === 0) catQuestions = allQuestions; // 兜底：随机
                var shuffled = [...catQuestions].sort(function(){return Math.random()-0.5;});
                for (var s = 0; s < catSlots && s < shuffled.length; s++) {
                    if (selected.length >= qCount) break;
                    selected.push(shuffled[s]);
                }
                slots = qCount - selected.length;
            }
            // 不够的随机补齐
            if (selected.length < qCount) {
                var remaining = [...allQuestions].sort(function(){return Math.random()-0.5;});
                for (var r = 0; r < remaining.length && selected.length < qCount; r++) {
                    if (!selected.some(function(q){return q === remaining[r];})) selected.push(remaining[r]);
                }
            }

            var examCode = genExamCode();
            var examRecord = {
                id: 'auto_' + Date.now(),
                examCode: examCode,
                reviewerName: name,
                questions: selected,
                generatedAt: wk.end.toISOString(), // 标记为上周日
                source: '周一自动推送',
                status: 'pending', attempts: 0, records: [],
                timeLimit: 40, maxAttempts: 2, wrongAnswers: []
            };
            examHistory[examRecord.id] = examRecord;
            console.log('  📝 自动出卷 → ' + name + ' [' + examCode + '] ' + selected.length + '题');
        }
    }
    // 写入 Supabase
    if (Object.keys(examHistory).length > 0) {
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: 'examHistoryData', value: JSON.stringify(examHistory), updated_at: new Date().toISOString() }])
        }).catch(function() {});
    }

    // 自动生成学习计划（≥learnMin 的人）
    const learnPlans = (await supabaseGet('learnPlanPushes')) || [];
    for (const [name, count] of Object.entries(rc)) {
        if (count >= TH.learnMin) {
            var hasLearn = learnPlans.some(function(l) {
                return l.reviewerName === name && new Date(l.time || 0) >= wk.start;
            });
            if (!hasLearn) {
                var planCode = 'LP' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2,4).toUpperCase();
                learnPlans.push({ reviewerName: name, planCode: planCode, mistakeCount: count, cats: Object.keys(rCat[name]||{}).slice(0,5), time: new Date().toISOString() });
                console.log('  🗺️ 学习 → ' + name + ' [' + planCode + ']');
            }
        }
    }
    if (learnPlans.length > 0) {
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: 'learnPlanPushes', value: JSON.stringify(learnPlans), updated_at: new Date().toISOString() }])
        }).catch(function() {});
    }

    // 自动生成培训报告（≥trainMin 的人）
    const training = (await supabaseGet('trainingPushRecords')) || [];
    const generatedReports = (await supabaseGet('generatedReports')) || {};
    for (const [name, count] of Object.entries(rc)) {
        if (count >= TH.trainMin) {
            var hasTrain = training.some(function(t) {
                return t.reviewerName === name && new Date(t.time || 0) >= wk.start;
            });
            if (!hasTrain) {
                var reportName = name + ' 培训资料(' + wk.key + ')';
                var catList = Object.entries(rCat[name]||{}).sort(function(a,b){return b[1]-a[1];}).map(function(e){return e[0]+'('+e[1]+'次)';}).join('、');
                var reportHtml = '<html><head><meta charset="UTF-8"><title>' + reportName + '</title></head><body style="font-family:Microsoft YaHei;padding:20px;">' +
                    '<h2>📖 ' + name + ' 精准培训资料</h2><p>周期：' + wk.key + ' | 失误总计：' + count + ' 次</p>' +
                    '<p>主要失误类别：' + catList + '</p>' +
                    '<p>培训建议：针对上述类别查阅SOP文档，重点复习高频失误类型的判定标准。</p>' +
                    '<p style="color:#5e6f8d;margin-top:30px;">智训通+数据分析中心 · 自动生成</p></body></html>';
                training.push({ reviewerName: name, reportName: reportName, mistakeCount: count, cats: catList, time: new Date().toISOString() });
                generatedReports[reportName] = reportHtml;
                console.log('  📖 培训 → ' + name + ' [' + reportName + ']');
            }
        }
    }
    if (training.length > 0) {
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: 'trainingPushRecords', value: JSON.stringify(training), updated_at: new Date().toISOString() }])
        }).catch(function() {});
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: 'generatedReports', value: JSON.stringify(generatedReports), updated_at: new Date().toISOString() }])
        }).catch(function() {});
    }


    for (const [name, count] of Object.entries(rc).sort((a,b) => b[1]-a[1])) {
        const email = emails[name];
        if (!email) continue;
        if (count >= TH.examMin) {
            var examCode = null;
            var exams = Object.values(examHistory).filter(function(e) {
                if (e.reviewerName !== name) return false;
                var t = new Date(e.generatedAt || e.time || 0);
                return t >= wk.start && t <= wk.end;
            });
            if (exams.length > 0) examCode = exams[exams.length - 1].examCode;

            if (!examCode) { console.log('  ⏭ ' + name + ' 无考试码，跳过'); continue; }
            var card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + name + ' 精准考试' }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达出卷阈值\n考试码：**' + examCode + '**' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: SITE_URL + '?exam=' + examCode }] }] };
            try { await sendCard(email, card, appToken); console.log('  📝 考试 → ' + name+'('+count+') [' + examCode + ']'); sent++; }
            catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
        }
        if (count >= TH.learnMin) {
            // 找本周生成的学习计划码
            var lp = learnPlans.find(function(l) {
                return l.reviewerName === name && new Date(l.time || 0) >= wk.start;
            });
            if (lp && lp.planCode) {
                var lcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + name + ' 学习地图' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达学习阈值\n涉及类别：' + (lp.cats||[]).slice(0,3).join('、') } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: SITE_URL + '?learnPlan=' + lp.planCode }] }] };
                try { await sendCard(email, lcard, appToken); console.log('  🗺️ 学习 → ' + name+'('+count+') [' + lp.planCode + ']'); sent++; }
                catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
            }
        }
        if (count >= TH.trainMin) {
            // 找本周生成的培训报告
            var tr = training.find(function(t) {
                return t.reviewerName === name && new Date(t.time || 0) >= wk.start;
            });
            if (tr && tr.reportName) {
                var tcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + name + ' 精准培训' }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达培训阈值\n涉及类别：' + (tr.cats||'') } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: SITE_URL + '?report=' + encodeURIComponent(tr.reportName) }] }] };
                try { await sendCard(email, tcard, appToken); console.log('  📖 培训 → ' + name+'('+count+') [' + tr.reportName + ']'); sent++; }
                catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
            }
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
