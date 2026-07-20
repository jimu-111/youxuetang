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
        { id: '4054dd', colDate: 0, colReviewer: 8, colCategory: 6, colProduct: 5 },
        { id: 'mEiT35', colDate: 0, colReviewer: 6, colCategory: 10, colProduct: 5 },
        { id: 'LIfICo', colDate: 0, colReviewer: 5, colCategory: 4, colProduct: 3 }
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
                if (rv) rows.push({
                    reviewer: rv,
                    category: (row[sh.colCategory] || '').toString().trim(),
                    product: (row[sh.colProduct] || '').toString().trim()
                });
            }
        } catch(e) {}
    }

    // 同时记录每人的失误类别分布和品类分布
    const rc = {};
    const rCat = {}; // { name: { category: count } }
    const rProd = {}; // { name: { product: count } }
    rows.forEach(r => {
        rc[r.reviewer] = (rc[r.reviewer] || 0) + 1;
        if (!rCat[r.reviewer]) rCat[r.reviewer] = {};
        var cat = r.category || '其他';
        rCat[r.reviewer][cat] = (rCat[r.reviewer][cat] || 0) + 1;
        if (r.product) {
            if (!rProd[r.reviewer]) rProd[r.reviewer] = {};
            rProd[r.reviewer][r.product] = (rProd[r.reviewer][r.product] || 0) + 1;
        }
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

    // 从 Supabase 读学习地图课程数据
    const lmCache = (await supabaseGet('lm_cache')) || {};
    const lmGroups = lmCache.groups || [];

    // 从 Supabase 读案例库，用于生成培训报告
    const allCasesData = ((await supabaseGet('manualCases')) || []).filter(function(c) { return c.errorCategory && c.issueDesc; });

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
        if (count >= TH.learnMin && lmGroups.length > 0) {
            // 从失误备注提取关键词
            var personRows = rows.filter(function(r) { return r.reviewer === name; });
            var kwScores = {};
            var stopWords = {手机:1,异常:1,反馈:1,问题:1,错误:1,未达:1,标准:1,情况:1,质检:1,失误:1,存在:1,进行:1,需要:1,注意:1,可能:1,部分:1,没有:1,是否:1,已经:1,还是:1,这个:1,因为:1,可以:1,如果:1,不是:1,应该:1,比较:1,什么:1,不过:1,怎么:1,但是:1,他们:1,自己:1,通过:1};
            personRows.forEach(function(r) {
                var text = (r.category + ' ' + (r.product||'')).toLowerCase();
                text.split(/[，,、\s。；;：:（）()\/]+/).forEach(function(w) {
                    w = w.trim(); if (!w || w.length < 2 || stopWords[w]) return;
                    kwScores[w] = (kwScores[w]||0) + 1;
                });
            });
            // 匹配课程
            var matchedItems = [];
            lmGroups.forEach(function(cat) {
                (cat.items||[]).forEach(function(item) {
                    if (!item.link) return;
                    var courseText = ((item.desc||'') + ' ' + (item.name||'')).toLowerCase();
                    var score = 0;
                    Object.keys(kwScores).forEach(function(kw) { if (courseText.indexOf(kw) >= 0) score += kwScores[kw]; });
                    if (score >= 1) matchedItems.push({ name: item.name, desc: item.desc, link: item.link, score: score, catTitle: cat.title || '' });
                });
            });
            matchedItems.sort(function(a,b){return b.score - a.score;});
            matchedItems = matchedItems.slice(0, 20);
            if (matchedItems.length > 0) {
                var planCode = 'LP' + Date.now().toString(36).toUpperCase();
                var areas = {};
                matchedItems.forEach(function(item) {
                    var areaKey = item.catTitle || '其他';
                    if (!areas[areaKey]) areas[areaKey] = { name: areaKey, icon: '📚', items: [] };
                    areas[areaKey].items.push(item);
                });
                var sortedAreas = Object.values(areas).sort(function(a,b){return b.items.length - a.items.length;});
                var planData = { id: planCode, code: planCode, reviewerName: name, generatedAt: new Date().toISOString(), areas: sortedAreas, totalCourses: matchedItems.length, source: '自动推送' };
                // 存到 Supabase
                var allPlans = (await supabaseGet('learningPlanData')) || {};
                allPlans[planCode] = planData;
                await fetch(SUPABASE_URL + '/rest/v1/app_data', {
                    method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify([{ key: 'learningPlanData', value: JSON.stringify(allPlans), updated_at: new Date().toISOString() }])
                }).catch(function(){});
                var areaNames = sortedAreas.slice(0,3).map(function(a){return a.name+'('+a.items.length+'课)';}).join('、');
                var lcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + name + ' 学习地图' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达学习阈值\n匹配课程：' + matchedItems.length + ' 节\n涉及：' + areaNames } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: SITE_URL + '?learnPlan=' + planCode }] }] };
                try { await sendCard(email, lcard, appToken); console.log('  🗺️ 学习 → ' + name+' [' + planCode + '] ' + matchedItems.length + '课'); sent++; }
                catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
            } else { console.log('  ⏭ ' + name + ' 无匹配课程，跳过'); }
        }
        if (count >= TH.trainMin) {
            // 从 Supabase 案例库匹配培训报告
            var personCats = rCat[name] || {};
            var personProds = rProd[name] || {};
            var catNames = Object.keys(personCats);
            // 判断主品类
            var prodEntries = Object.entries(personProds);
            var totalM = prodEntries.reduce(function(a,b){return a+b[1];},0);
            var dominantProd = null;
            prodEntries.forEach(function(e) { if (e[1]/totalM >= 0.9) dominantProd = e[0]; });
            // 按失误类别匹配案例
            var matched = allCasesData.filter(function(c) {
                return catNames.some(function(cn) { return (c.errorCategory||'').includes(cn) || cn.includes(c.errorCategory||''); });
            });
            // 主品类过滤
            if (dominantProd) {
                matched = matched.filter(function(c) {
                    var cp = c.productCategory||'';
                    return cp === '全品类' || cp.includes(dominantProd) || dominantProd.includes(cp);
                });
            }
            // 不够20条按品类补齐
            if (matched.length < 20) {
                var fillProds = dominantProd ? [dominantProd] : Object.keys(personProds);
                var fillCases = allCasesData.filter(function(c) {
                    if (matched.find(function(m){return m.qcCode===c.qcCode;})) return false;
                    var cp = c.productCategory||'';
                    return cp === '全品类' || fillProds.some(function(p){ return cp.includes(p) || p.includes(cp); });
                });
                fillCases.sort(function(){return Math.random()-0.5;});
                matched = matched.concat(fillCases.slice(0, 20 - matched.length));
            }
            if (matched.length > 0) {
                matched = matched.slice(0, 20);
                var reportName = name + ' 培训资料(' + wk.key + ')';
                var catsList = Object.entries(personCats).sort(function(a,b){return b[1]-a[1];}).map(function(e){return e[0]+'('+e[1]+'次)';}).join('、');
                var html = '<html><head><meta charset="UTF-8"><title>' + reportName + '</title></head><body style="font-family:Microsoft YaHei;padding:40px;max-width:900px;margin:0 auto;">' +
                    '<h1 style="color:#1f3a6b;">📖 ' + name + ' 精准培训资料</h1>' +
                    '<p style="color:#5e6f8d;">周期：' + wk.key + ' | 失误总计：' + count + ' 次</p>' +
                    '<p style="background:#f1f5f9;padding:10px 16px;border-radius:12px;">主要失误类别：' + catsList + '</p>';
                matched.forEach(function(c) {
                    html += '<div style="border:1px solid #eef2f6;border-radius:16px;padding:20px;margin:20px 0;background:#fafcfd;">' +
                        '<div style="font-weight:700;color:#1f3a6b;">🔖 ' + (c.qcCode||'') + ' | 🏷️ ' + (c.errorCategory||'') + '</div>' +
                        '<div style="margin-top:10px;"><strong>📝 问题描述：</strong>' + (c.issueDesc||'') + '</div>' +
                        '<div style="margin-top:8px;"><strong>✅ 应操作方向：</strong>' + (c.correctDir||'') + '</div></div>';
                });
                html += '<div style="text-align:center;color:#94a3b8;margin-top:30px;">优学堂 · 自动生成</div></body></html>';
                // 保存到 Supabase
                var reports = (await supabaseGet('generatedReports')) || {};
                reports[reportName] = html;
                await fetch(SUPABASE_URL + '/rest/v1/app_data', {
                    method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify([{ key: 'generatedReports', value: JSON.stringify(reports), updated_at: new Date().toISOString() }])
                }).catch(function(){});
                var tcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + name + ' 精准培训' }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达培训阈值\n匹配案例：' + matched.length + ' 条' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: SITE_URL + '?report=' + encodeURIComponent(reportName) }] }] };
                try { await sendCard(email, tcard, appToken); console.log('  📖 培训 → ' + name+' (' + matched.length + '条)'); sent++; }
                catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
            } else {
                console.log('  ⏭ ' + name + ' 案例库无匹配，跳过');
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
