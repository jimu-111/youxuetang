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
        { id: '4054dd', colDate: 0, colReviewer: 8, colCategory: 6, colNote: 9, colProduct: 5 },
        { id: 'mEiT35', colDate: 0, colReviewer: 6, colCategory: 10, colNote: 11, colProduct: 5 },
        { id: 'LIfICo', colDate: 0, colReviewer: 5, colCategory: 4, colNote: 6, colProduct: 3 }
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
                    product: (row[sh.colProduct] || '').toString().trim(),
                    note: (row[sh.colNote] || '').toString().trim()
                });
            }
        } catch(e) {}
    }

    // 再读一遍全部数据（不限周），用于学习地图关键词提取
    var allRows = [];
    for (const sh of FEISHU_SHEETS) {
        try {
            var r3 = await fetch(PROXY_URL, {method:'POST',
                headers:{'Authorization':'Bearer '+SUPABASE_KEY,'x-target-url':'https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/EdI0sn3qkh7H6wtkhcpcxrTnnDf/values/'+sh.id+'?majorDimension=ROWS','x-target-method':'GET','x-target-auth':'Bearer '+userToken,'Content-Type':'application/json'}
            });
            var d3 = await r3.json();
            var vals3 = (d3.data&&d3.data.valueRange&&d3.data.valueRange.values)||[];
            for (let i=2; i<vals3.length; i++) {
                var row3 = vals3[i]; if (!row3) continue;
                var rv3 = String(row3[sh.colReviewer]||'').trim();
                if (rv3) allRows.push({
                    reviewer: rv3,
                    category: (row3[sh.colCategory]||'').toString().trim(),
                    product: (row3[sh.colProduct]||'').toString().trim(),
                    note: (row3[sh.colNote]||'').toString().trim()
                });
            }
        } catch(e) {}
    }
    console.log('全部数据: ' + allRows.length + '条');

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
    // 类别别名映射（去标点后仍不同的）
    const catAlias = {'组合差价未勾选':'组合项未同步判责','拍照/取证不规范':'拍照取证不规范','低级/投诉失误':'明显失误','低级失误':'明显失误','责任分类错':'判错责任方','责任明细选错':'判错责任方','责任类选错':'判错责任方'};
    // 2-6字滑动提取
    function extractKW(texts) {
      const stop = new Set(['的','了','是','在','有','和','就','不','人','都','一','个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','他','她','它','们','那','些','什么','怎么','因为','所以','但是','如果','虽然','然后','可以','应该','可能','需要','不是','这个','那个','比较','非常','还是','已经','通过','进行','以及','对于','关于','被','把','让','从','向','往','用','以','为','能','下','中','等','之','与','其','未','将','改','改正','正常','主动','报备','照片','图片','总部','报告','修改','师傅','没有','情况','反馈','问题','是否','售后','mm','cm']);
      const all = texts.join('|').replace(/[，,。、：:；;！!?？（）()【】\[\]「」\s\/]+/g,'|');
      const words = {};
      all.split('|').forEach(part => {
        if (!part || part.length < 2) return;
        for (var len = 6; len >= 2; len--) {
          for (var i = 0; i <= part.length - len; i++) {
            var w = part.substring(i, i + len);
            if (!stop.has(w)) { words[w] = len; }
          }
        }
      });
      // 按字长排序（6字优先）
      return Object.entries(words).sort(function(a,b){return b[1]-a[1];}).map(function(e){return e[0];});
    }
    // 去标点+别名映射
    function matchCat(qCat, errCat) {
      if (!qCat || !errCat) return false;
      var alias = catAlias[errCat];
      if (alias) errCat = alias;
      var qc = qCat.replace(/[\/\-・\s]/g,'').toLowerCase();
      var ec = errCat.replace(/[\/\-・\s]/g,'').toLowerCase();
      return qc.includes(ec) || ec.includes(qc);
    }

    for (const [name, count] of Object.entries(rc).sort((a,b) => b[1]-a[1])) {
        if (count >= TH.examMin) {
            var hasExam = Object.values(examHistory).some(function(e) {
                if (e.reviewerName !== name) return false;
                var t = new Date(e.generatedAt || e.time || 0);
                return t >= wk.start && t <= wk.end;
            });
            if (hasExam) continue;
            if (allQuestions.length < 5) continue;

            var cats = rCat[name] || {};
            var totalMistakes = Object.values(cats).reduce(function(a,b){return a+b;},0);
            var prods = rProd[name] || {};
            var totalProds = Object.values(prods).reduce(function(a,b){return a+b;},0);
            var qCount = 30;
            var selected = [];
            var usedIds = new Set();

            // 按类别分配题数
            var catList = Object.entries(cats).sort(function(a,b){return b[1]-a[1];});
            var catQ = {};
            var assigned = 0;
            catList.forEach(function(e,i){
              var n = Math.max(1, Math.round(e[1]/totalMistakes*qCount));
              catQ[e[0]] = n;
              assigned += n;
            });
            var diff = qCount - assigned;
            for (var di = 0; di < Math.abs(diff); di++) {
              if (diff > 0) catQ[catList[di%catList.length][0]]++;
              else if (catQ[catList[di%catList.length][0]] > 1) catQ[catList[di%catList.length][0]]--;
            }

            // 按品类分配：每种类别需要多少题来自各品类
            var prodRatio = {};
            Object.entries(prods).forEach(function(e){ prodRatio[e[0]] = e[1]/totalProds; });

            // 该人的所有失误备注
            var personRows = rows.filter(function(r){ return r.reviewer === name; });

            // 对每个类别出题
            catList.forEach(function(entry){
              var cat = entry[0];
              var needed = catQ[cat] || 0;
              var matched = [];
              // 该类别下的备注
              var catNotes = personRows.filter(function(r){ return r.category === cat; }).map(function(r){ return r.note; }).filter(Boolean);

              // === 第1层：2-6字→题面/答案 ===
              var kws = extractKW(catNotes);
              kws.forEach(function(kw){
                if (matched.length >= needed) return;
                var kl = kw.toLowerCase();
                allQuestions.forEach(function(q){
                  if (matched.length >= needed) return;
                  if (usedIds.has(q.id)) return;
                  var text = ((q.question||'')+' '+(q.answer||'')+' '+(q.explanation||'')).toLowerCase();
                  if (text.includes(kl)) {
                    matched.push(q);
                    usedIds.add(q.id);
                  }
                });
              });

              // === 第2层：分类匹配（去标点+别名）===
              if (matched.length < needed) {
                allQuestions.forEach(function(q){
                  if (matched.length >= needed) return;
                  if (usedIds.has(q.id)) return;
                  if (matchCat(q.category, cat)) {
                    matched.push(q);
                    usedIds.add(q.id);
                  }
                });
              }

              // === 第3层：按品类补齐 ===
              if (matched.length < needed) {
                var relevantProds = Object.keys(prods);
                allQuestions.forEach(function(q){
                  if (matched.length >= needed) return;
                  if (usedIds.has(q.id)) return;
                  var qp = (q.productCategory||'').toLowerCase();
                  if (qp === '全品类') { matched.push(q); usedIds.add(q.id); return; }
                  for (var pi = 0; pi < relevantProds.length; pi++) {
                    var rp = relevantProds[pi].toLowerCase();
                    if (qp.includes(rp) || rp.includes(qp)) { matched.push(q); usedIds.add(q.id); break; }
                  }
                });
              }

              matched.sort(function(){return Math.random()-0.5;});
              for (var mi = 0; mi < matched.length && mi < needed; mi++) selected.push(matched[mi]);
            });

            // 仍然不够就从全部题库补
            if (selected.length < qCount) {
              allQuestions.sort(function(){return Math.random()-0.5;}).forEach(function(q){
                if (selected.length >= qCount) return;
                if (usedIds.has(q.id)) return;
                selected.push(q);
                usedIds.add(q.id);
              });
            }

            var examCode = genExamCode();
            var examRecord = {
                id: 'auto_' + Date.now(),
                examCode: examCode,
                reviewerName: name,
                questions: selected,
                generatedAt: wk.end.toISOString(),
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

    // 从 Supabase 读学习地图课程数据（同看板 lm_cache）
    const lmCache = (await supabaseGet('lm_cache')) || {};
    const lmGroups = lmCache.groups || [];
    // 重组为看板 _lmCategories 格式（按 sheetTitle 分组）
    var lmCategories = [];
    var sheetMap = {};
    lmGroups.forEach(function(g) {
        var st = g.sheetTitle || '其他';
        if (!sheetMap[st]) sheetMap[st] = [];
        sheetMap[st].push(g);
    });
    Object.keys(sheetMap).forEach(function(st) {
        lmCategories.push({ title: st, groups: sheetMap[st] });
    });
    // 知识领域分类（同看板）
    const KNOWLEDGE_AREA_RULES = [
        { name: '基础信息', icon: '📋', keywords: ['入门','认识','知识','基础','名词','标准','sku','品牌','型号','参数','介绍','文化','组织','架构','展望','流程','办理','实物'] },
        { name: '显示类', icon: '🖥️', keywords: ['显示','屏幕','屏'] },
        { name: '外观类', icon: '📱', keywords: ['外观','成色','外壳','后壳','中框','正面'] },
        { name: '功能类', icon: '⚙️', keywords: ['功能','验机','开机','账号','系统','保修'] },
        { name: '拆修类', icon: '🔧', keywords: ['拆修','拆机','维修','浸液','零件','摄像','电池','主板','副屏'] },
        { name: '考核实操', icon: '📝', keywords: ['考核','实操','考试','测试','练习题'] },
        { name: '业务介绍', icon: '📦', keywords: ['业务','回收','上门','售后','以旧换新','曼哈顿'] }
    ];
    function classifyKnowledgeArea(item) {
        var desc = (item.desc || '').toLowerCase();
        var name = (item.name || '').toLowerCase();
        var firstSegment = (item.desc || '').split('>')[0].trim().toLowerCase();
        var searchText = firstSegment + ' ' + name;
        var bestMatch = null, bestScore = 0;
        for (var i = 0; i < KNOWLEDGE_AREA_RULES.length; i++) {
            var rule = KNOWLEDGE_AREA_RULES[i];
            var score = 0;
            for (var j = 0; j < rule.keywords.length; j++) {
                var kw = rule.keywords[j].toLowerCase();
                if (firstSegment.indexOf(kw) >= 0) score += 3;
                if (name.indexOf(kw) >= 0) score += 2;
                if (desc.indexOf(kw) >= 0) score += 1;
            }
            if (score > bestScore) { bestScore = score; bestMatch = rule; }
        }
        return bestMatch || { name: '其他', icon: '📋' };
    }

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
        if (count >= TH.learnMin && lmCategories.length > 0) {
            // ===== 从看板一字不改搬过来的学习地图生成逻辑 =====
            var personErrs = allRows.filter(function(e) { return e.reviewer === name; });
            if (personErrs.length === 0) { console.log('  ⏭ ' + name + ' 无失误记录'); continue; }
            var totalE = personErrs.length;
            var productCounts = {};
            personErrs.forEach(function(e) { var p = e.product||'未知'; productCounts[p] = (productCounts[p]||0)+1; });
            var dominantProduct = null;
            Object.entries(productCounts).forEach(function(e) { if (e[1]/totalE >= 0.9) dominantProduct = e[0]; });
            var kwScores = {};
            personErrs.forEach(function(e) {
                var text = (e.note + ' ' + e.category).toLowerCase();
                var stopWords = {手机:1,异常:1,反馈:1,问题:1,错误:1,未达:1,标准:1,情况:1,质检:1,失误:1,存在:1,进行:1,需要:1,注意:1,可能:1,部分:1};
                var words = text.split(/[，,、\s。；;：:（）()\/]+/);
                words.forEach(function(w) {
                    w = w.trim();
                    if (!w || w.length < 2 || stopWords[w]) return;
                    if (w.length <= 4) { kwScores[w] = (kwScores[w]||0) + 1; }
                    else {
                        kwScores[w] = (kwScores[w]||0) + 1;
                        for (var n=0; n <= w.length-2; n++) {
                            var sub = w.substring(n, n+2);
                            if (!stopWords[sub] && sub.length === 2) kwScores[sub] = (kwScores[sub]||0) + 0.5;
                        }
                    }
                });
            });
            var allItems = [];
            lmCategories.forEach(function(cat) {
                if (dominantProduct && cat.title !== dominantProduct && !cat.title.includes(dominantProduct) && !dominantProduct.includes(cat.title) && !cat.title.replace(/[&、\-・\s]/g,'').includes(dominantProduct.replace(/[&、\-・\s]/g,''))) return;
                cat.groups.forEach(function(g) {
                    g.items.forEach(function(item) {
                        if (!item.link) return;
                        var courseText = ((item.desc||'') + ' ' + (item.name||'')).toLowerCase();
                        var matchScore = 0;
                        var matchWords = [];
                        Object.keys(kwScores).forEach(function(kw) {
                            if (courseText.indexOf(kw) >= 0) {
                                matchScore += kwScores[kw];
                                matchWords.push(kw);
                            }
                        });
                        if (matchScore >= 1) {
                            var area = classifyKnowledgeArea(item);
                            allItems.push({
                                areaName: area.name, areaIcon: area.icon, catTitle: cat.title,
                                name: item.name, desc: item.desc, link: item.link,
                                weaknessCount: matchScore, matchWords: matchWords
                            });
                        }
                    });
                });
            });
            allItems.sort(function(a,b){ return b.weaknessCount - a.weaknessCount; });
            allItems = allItems.slice(0, 20);
            var planAreas = {};
            allItems.forEach(function(item) {
                var key = item.areaName;
                if (!planAreas[key]) planAreas[key] = { name: item.areaName, icon: item.areaIcon, weaknessCount: item.weaknessCount, items: [] };
                planAreas[key].items.push(item);
            });
            var sortedAreas = Object.values(planAreas).sort(function(a, b) { return b.weaknessCount - a.weaknessCount; });
            if (sortedAreas.length > 0) {
                var planCode = 'LP' + Date.now().toString(36).toUpperCase();
                var planData = {
                    id: planCode, code: planCode, reviewerName: name,
                    generatedAt: new Date().toISOString(), areas: sortedAreas,
                    totalCourses: allItems.length, source: '自动推送（看板逻辑）'
                };
                var allPlans = (await supabaseGet('learningPlanData')) || {};
                allPlans[planCode] = planData;
                await fetch(SUPABASE_URL+'/rest/v1/app_data',{
                    method:'POST',headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates'},
                    body:JSON.stringify([{key:'learningPlanData',value:JSON.stringify(allPlans),updated_at:new Date().toISOString()}])
                }).catch(function(){});
                var areaNames = sortedAreas.slice(0,3).map(function(a){return a.name+'('+a.items.length+'课)';}).join('、');
                var lcard = {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'🗺️ '+name+' 学习地图'},template:'blue'},elements:[{tag:'div',text:{tag:'lark_md',content:'**'+name+'** 上周失误 **'+count+' 次**，已达学习阈值\n课程：'+allItems.length+' 节\n涉及：'+areaNames}},{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'🗺️ 学习地图'},type:'primary',url:SITE_URL+'?learnPlan='+planCode}]}]};
                try { await sendCard(email, lcard, appToken); console.log('  🗺️ 学习 → '+name+' ['+planCode+'] '+allItems.length+'课'); sent++; }
                catch(e) { console.log('  ❌ '+name+': '+e.message); fail++; }
            } else { console.log('  ⏭ '+name+' 未匹配到课程'); }
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
                    '<p style="color:#5e6f8d;">周期：' + fmt(wk.start) + ' ~ ' + fmt(wk.end) + ' | 失误总计：' + count + ' 次</p>' +
                    '<p style="background:#f1f5f9;padding:10px 16px;border-radius:12px;">主要失误类别：' + catsList + '</p>';
                // 图片下载函数
                async function getImgBase64(ft) {
                    if (!ft || typeof ft !== 'object' || !ft.t) return null;
                    try {
                        var resp = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/' + ft.t + '/download', {
                            headers: { 'Authorization': 'Bearer ' + userToken }
                        });
                        if (!resp.ok) return null;
                        var buf = await resp.arrayBuffer();
                        if (!buf || buf.byteLength === 0) return null;
                        var base64 = Buffer.from(buf).toString('base64');
                        var ext = resp.headers.get('content-type') || 'image/png';
                        return 'data:' + ext + ';base64,' + base64;
                    } catch(e) { return null; }
                }
                for (var ci = 0; ci < matched.length; ci++) {
                    var c = matched[ci];
                    html += '<div style="border:1px solid #eef2f6;border-radius:16px;padding:20px;margin:20px 0;background:#fafcfd;">' +
                        '<div style="font-weight:700;color:#1f3a6b;">🔖 ' + (c.qcCode||'') + ' | 🏷️ ' + (c.errorCategory||'') + '</div>' +
                        '<div style="margin-top:10px;"><strong>📝 问题描述：</strong>' + (c.issueDesc||'') + '</div>';
                    // 下载并嵌入图片
                    var allPhotos = (c.issuePhotos||[]).concat(c.dirPhotos||[]).concat(c.dirExamplePhotos||[]);
                    for (var pi = 0; pi < allPhotos.length; pi++) {
                        var b64 = await getImgBase64(allPhotos[pi]);
                        if (b64) html += '<img src="' + b64 + '" style="max-width:300px;border-radius:8px;margin:6px;border:1px solid #e2e8f0;">';
                    }
                    html += '<div style="margin-top:8px;"><strong>✅ 应操作方向：</strong>' + (c.correctDir||'') + '</div></div>';
                }
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
