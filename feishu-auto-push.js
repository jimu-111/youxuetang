/**
 * 飞书周一自动推送
 * PHASE=analyze : 周一11:00 分析上周失误，生成考试/学习/培训，存入队列（不发、不标记）
 * PHASE=send    : 周一14:00 读队列发出飞书卡片，标记已推送
 * 其他时间手动跑不标记
 */
const PHASE = process.env.PHASE || 'full';
const FEISHU_APP_ID = 'cli_aab1fa4e87bbdbd3';
// 2026-09-20：应用密钥不再写在本文件里 —— 本文件在**公开仓库**根目录，写上就等于公开。
// 取值顺序：① 环境变量 FEISHU_APP_SECRET（GitHub Actions 由仓库 Secrets 注入）
//           ② 本地密钥文件（在你自己电脑上手工跑时用；不进仓库）
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (function () {
    try { return require('fs').readFileSync('C:/Users/xuhan/yxt/feishu-secret.txt', 'utf8').trim(); } catch (e) { return ''; }
})();
// ⚠️ 没配**不等于跑不了**：下面 feishuPost() 会退到代理，由代理把密钥补上。
//    （这里原先写的是 process.exit(1)。2026-09-20 当天就改掉了 —— 本脚本是周一推送的主力，
//      让它被「一个忘了配的 Secret」拦死太脆。宁可走代理慢半秒，也不要周一早上整个不发。）
if (!FEISHU_APP_SECRET) {
    console.log('⚠️ 没拿到飞书应用密钥（FEISHU_APP_SECRET），本次改走代理、由代理补密钥。');
    console.log('   · GitHub Actions 里跑 → 仓库 Settings → Secrets and variables → Actions 配 FEISHU_APP_SECRET');
    console.log('   · 本机手工跑     → 确认 C:\\Users\\xuhan\\yxt\\feishu-secret.txt 存在且非空');
}
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co').replace(/\/$/, '').replace(/\s/g, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8').replace(/\s/g, '');
const SITE_URL = 'https://jimu-111.github.io/youxuetang/';
const KV_PAGES = 'https://yxt-feishu.pages.dev';
const KV_SECRET = 'yxt-feishu-2026';

// 三个推送阈值。
// 2026-09-21：原来这行写在 main() 里面，而下面几个 *Card() 的文案是**另写一遍数字**的，
//   结果两边对不上 —— learnCard 写「≥11次」而 learnMin 是 16，trainCard 写「≥16次」而 trainMin 是 11，
//   正好写反了（真发出去的卡片是内联拼的，没写数字，所以员工没被误导；但这三个函数是个雷）。
//   现在：阈值只在这里定义一处，卡片文案一律读 TH.*，改阈值不可能再改漏。
const TH = { examMin: 6, learnMin: 16, trainMin: 11 };

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

// ═══════════════════════════════════════════════════════════════════════════
// 个人培训资料生成（2026-09-21 重写）
//
// 目标：脚本自动推的那份报告，和页面上「失误分析看板 → 个人培训资料」**手动生成**
//       的那份逐字一致。页面那边是 buildTrainingDoc()（index.html 约 18921 行）。
//
// 下面这套「选案例 + 排版」是照抄页面的，别再单独改；要改先看页面有没有同步改。
// 本次对齐掉的差异（原来脚本这边是这样的）：
//   ① 名额分配：先到先得 → 按失误类别占比用「最大余数法」分 30 个名额
//   ② 补缺口：随机抓 → 各类别轮流补
//   ③ 类别匹配：双向模糊包含 → 精确相等（主品类过滤补上「去标点再比」那一步）
//   ④ 照片：一律下飞书原图内嵌（几十 MB、必然爆）→ 改「KV 压缩图优先，KV 没有就下原图自己压到
//      900px」，做到**每张都嵌进报告**（收件人打开就有图、零点击）
//   ⑤ 排版：内联样式 → 照抄页面的 CSS 类
//   ⑥ 数量：20 → 30
// 另外这份报告的存档从「只写 Supabase」改成了「**KV 优先**、KV 失败才退 Supabase」——
// KV 那层才是「收件人一定点得开」的保障（站点案例链一直正常就是因为它显式写了 KV），
// 而 Supabase 那条共享记录放不下 30 份个人报告（详见 saveReportAsync 上方注释）。
// ═══════════════════════════════════════════════════════════════════════════

// KV 单键体积上限：与页面 index.html 18816 行同值。超了 KV 写不进去，报告改用占位图版。
const KV_REPORT_HARD_BYTES = 2.5 * 1024 * 1024;

// 内嵌照片的体积预算（2026-09-21 实测后加的）。
// 实测 KV 里的压缩图平均 75KB/张、最大 263KB；30 个案例最坏 90 张 → 6.6MB，
// 按实际平均 45 张也要 3.3MB —— 全都超过上面那条 2.5MB 硬线。
// 如果按「要么全嵌、要么全占位」，结果是**每次都会退回占位图版、一张照片都不嵌**，
// 白烧几十次 KV 读。所以改成装到预算为止：先装的先嵌（照片按 问题→方向→补充 的顺序取），
// 装不下的留占位图（点一下照样能看），报告体积因此有硬上限、永远写得进 KV。
const KV_PHOTO_BUDGET_BYTES = 2.2 * 1024 * 1024;

// 图片压缩库（2026-09-22 加）：照片要「收件人打开就有图、不用点」，就得每张都嵌进报告；
// 而飞书原图平均 2.08MB/张（最大 6MB），30 个案例几十张 = 几十 MB，必须先在服务器上压小。
// 为什么压到 900px 就够：报告里照片的显示框只有 400px（页面 buildTrainingDoc 是 photoTag(p,400,400)），
//   900px 已经超采样两倍多 —— 在手机屏幕上看就是原画质；再大只是让收件人多下流量。
//   （页面自己压的那份也是 900px JPEG 80%，见 index.html _generateThumbnail(img,900,0.8)。）
// ⚠️ 装不上**必须能继续跑**：本脚本是周一推送的主力，不能被一个图片库拦死。
//   拿不到 sharp 就退回「只用 KV 里现成的压缩图」，剩下的留占位图（点一下能看），推送照发。
const sharp = (function () {
    try { return require('sharp'); } catch (e) {
        console.log('⚠️ 没装图片压缩库 sharp（' + String(e.message).split('\n')[0] + '）');
        console.log('   → 本次照片只用 KV 里现成的压缩图；KV 里没有的会留成占位图（点一下能看）。');
        console.log('   → GitHub Actions 上由工作流自动装；本机想装：在本目录跑 npm install');
        return null;
    }
})();

function escapeHtml(str) { if (!str) return ''; return String(str).replace(/[&<>"']/g, function(m) { if (m === '&') return '&amp;'; if (m === '<') return '&lt;'; if (m === '>') return '&gt;'; if (m === '"') return '&quot;'; return '&#39;'; }); }

// 生成日期取**北京时间的今天**。脚本跑在 GitHub Actions（UTC），凌晨跑时 UTC 日期会比
// 北京晚一天 —— 报告名里的日期按北京算，才和员工看到的「今天」一致。
function beijingDateStr() {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    return bj.getUTCFullYear() + '-' + String(bj.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bj.getUTCDate()).padStart(2, '0');
}

// 照片标签 —— 输出的 HTML 与页面 photoTag()（index.html 约 9931 行）逐字相同。
// 页面是「本地缓存里有就内嵌、没有就占位」；脚本没有本地缓存，对应物是 Pages KV 里的
// 压缩图（键 qbimg_<token>，主电脑压缩后同步上去的）—— 取得到就内嵌，取不到就占位。
function trainPhotoTag(p, maxW, maxH, resolved, placeholderOnly) {
    maxW = maxW || 150; maxH = maxH || 150;
    if (typeof p === 'object' && p && p.t) {
        const token = p.t;
        if (!placeholderOnly && resolved && resolved[token]) {
            return '<img src="' + resolved[token] + '" style="max-width:' + maxW + 'px;max-height:' + maxH + 'px;border-radius:8px;border:1px solid #e2e8f0;object-fit:cover;cursor:pointer;margin:2px;" onclick="event.stopPropagation();showImageViewer(this.src)">';
        }
        return '<div class="photo-loadable" data-ftoken="' + escapeHtml(token) + '" style="width:' + Math.min(maxW, 100) + 'px;height:' + Math.min(maxH, 80) + 'px;background:#f1f5f9;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px dashed #cbd5e1;margin:2px;flex-shrink:0;" onclick="event.stopPropagation();loadPhotoToken(this,\'' + token + '\')"><span style="font-size:1.2rem;">📷</span></div>';
    }
    if (typeof p === 'string' && (p.indexOf('ci_') === 0 || p.indexOf('ki_') === 0)) {
        return '<div style="width:' + Math.min(maxW, 100) + 'px;height:' + Math.min(maxH, 80) + 'px;background:#fff5f5;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;border:1px dashed #e53e3e;margin:2px;flex-shrink:0;font-size:0.65rem;color:#c0392b;text-align:center;padding:4px;" title="图片数据丢失，请重新上传">📷<br>已丢失</div>';
    }
    return '<img src="' + p + '" style="max-width:' + maxW + 'px;max-height:' + maxH + 'px;border-radius:8px;border:1px solid #e2e8f0;object-fit:cover;cursor:pointer;margin:2px;" onclick="event.stopPropagation();showImageViewer(this.src)">';
}

/**
 * 个人培训资料 —— 页面 buildTrainingDoc() 的 Node 版（index.html 约 18921 行）。
 * 页面上的「个人」入口传的是 caseTypes:null / noteKeywordMap:false / floorOnePerCat:false，
 * 所以这里也不做 caseType 过滤、不掺备注关键词、不做每类保底 —— 只跑个人链真正会跑的那部分。
 *
 * @param {Object} opts
 *   opts.errors          {Array}   本周全部失误行（与页面 getFilteredErrors() 同形状）
 *   opts.reviewerNames   {Array}   要生成谁（个人链只有一个人）
 *   opts.scopeText       {string}  报告抬头「培训范围」
 *   opts.docTitle        {string}  报告标题
 *   opts.footerText      {string}  页脚
 *   opts.cases           {Array}   案例库（manualCases）
 *   opts.maxCases        {number}  默认 30
 *   opts.resolvedPhotos  {Object}  { 飞书token: dataURI }，调用方先从 KV 取好压缩图
 *   opts.placeholderOnly {boolean} true = 照片一律用占位图（报告体积从 MB 级降到百 KB 级）
 * @returns {{ok:boolean, reason?:string, docHtml?:string, matched?:Array, comboText?:string}}
 */
function buildTrainingDocLocal(opts) {
    opts = opts || {};
    const errors = opts.errors || [];
    const reviewerNames = opts.reviewerNames || [];
    const allCases = opts.cases || [];
    const MAX_CASES = opts.maxCases || 30;
    const resolved = opts.resolvedPhotos || {};
    const placeholderOnly = !!opts.placeholderOnly;

    const comboCats = {};   // 品类+类别组合统计（抬头展示用）
    const cats = {};        // 汇总到类别（案例匹配用）
    reviewerNames.forEach(function(name){
        errors.filter(function(e){return e.reviewer===name;}).forEach(function(e){
            const key = (e.product||'未知') + '-' + e.category;
            comboCats[key] = (comboCats[key]||0) + 1;
            cats[e.category] = (cats[e.category]||0) + 1;
        });
    });
    if (Object.keys(cats).length === 0) return { ok: false, reason: '当前维度下无可匹配的培训人员' };
    const comboSorted = Object.entries(comboCats).sort(function(a,b){ return b[1] - a[1]; });
    const comboText = comboSorted.map(function(e){ return e[0] + '(' + e[1] + ')'; }).join(' / ');

    // 主品类判断：≥90% 则排除其他品类案例
    let totalErrors = 0;
    const productCounts = {};
    reviewerNames.forEach(function(name){
        errors.filter(function(e){return e.reviewer===name;}).forEach(function(e){
            const p = e.product||'未知'; productCounts[p] = (productCounts[p]||0)+1; totalErrors++;
        });
    });
    let dominantProduct = null;
    Object.entries(productCounts).forEach(function(e) {
        if (totalErrors > 0 && e[1] / totalErrors >= 0.9) dominantProduct = e[0];
    });

    // 案例匹配：类别**精确相等**（不是模糊包含）；主品类过滤含「去标点再比」那一步
    let matched = allCases.filter(function(c){
        if (!c.errorCategory || !cats[c.errorCategory]) return false;
        if (dominantProduct && c.productCategory && c.productCategory !== '全品类' && c.productCategory !== dominantProduct && !c.productCategory.includes(dominantProduct) && !dominantProduct.includes(c.productCategory) && !c.productCategory.replace(/[&、\-・\s]/g,'').includes(dominantProduct.replace(/[&、\-・\s]/g,''))) return false;
        return true;
    });
    if (matched.length === 0) return { ok: false, reason: '案例库中无匹配的案例' };

    // 按失误比例分配案例数（最大余数法）：失误多的类别配额多，再轮转补齐缺口
    const sortedCats = Object.keys(cats).sort(function(a,b){ return (cats[b]||0)-(cats[a]||0); });
    const casesByCat = {};
    matched.forEach(function(c){ (casesByCat[c.errorCategory] = casesByCat[c.errorCategory]||[]).push(c); });
    let totalFails = 0;
    sortedCats.forEach(function(cat){ totalFails += cats[cat]||0; });
    const quota = {}, used = {};
    let remain = MAX_CASES;
    sortedCats.forEach(function(cat){
        const q = totalFails > 0 ? Math.floor((cats[cat]||0)/totalFails*MAX_CASES) : 0;
        quota[cat] = q; remain -= q; used[cat] = 0;
    });
    // 余数名额按小数部分从大到小分配，保证总数凑满
    const fracList = sortedCats.map(function(cat){
        return { cat: cat, f: totalFails > 0 ? ((cats[cat]||0)/totalFails*MAX_CASES) - quota[cat] : 0 };
    }).sort(function(a,b){ return b.f - a.f; });
    for (let fi = 0; fi < remain && fi < fracList.length; fi++) quota[fracList[fi].cat]++;

    // 按配额取案例（类别内保持案例库原顺序），不足配额的类别由其他类别轮转补齐
    const result = [];
    sortedCats.forEach(function(cat){
        const pool = casesByCat[cat] || [];
        const take = Math.min(quota[cat], pool.length);
        result.push.apply(result, pool.slice(0, take));
        used[cat] = take;
    });
    let ci = 0, noAdd = 0;
    while (result.length < MAX_CASES) {
        const cat = sortedCats[ci % sortedCats.length];
        const pool = casesByCat[cat] || [];
        if (used[cat] < pool.length) { result.push(pool[used[cat]]); used[cat]++; noAdd = 0; }
        else noAdd++;
        if (noAdd >= sortedCats.length) break;   // 所有类别案例都已取尽
        ci++;
    }
    matched = result;

    let docHtml = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>培训资料</title>" +
    "<style>body{font-family:Microsoft YaHei,SimHei,sans-serif;padding:40px;max-width:900px;margin:0 auto;color:#333;}" +
    "h1{color:#1f3a6b;border-bottom:3px solid #2a5298;padding-bottom:12px;}" +
    ".case-card{border:1px solid #eef2f6;border-radius:16px;padding:20px;margin:20px 0;background:#fafcfd;}" +
    ".qc-code{font-size:1.1rem;font-weight:700;color:#1f3a6b;margin-bottom:8px;}" +
    ".label{font-weight:600;color:#5e6f8d;font-size:0.85rem;margin-top:14px;margin-bottom:6px;}" +
    ".desc{line-height:1.7;color:#4a5568;}img{max-width:100%;border-radius:10px;margin:6px;border:1px solid #e2e8f0;cursor:pointer;}" +
    ".correct{background:#eef2ff;padding:12px 16px;border-radius:12px;color:#2a5298;line-height:1.7;}" +
    ".footer{color:#94a3b8;text-align:center;margin-top:40px;font-size:0.85rem;}" +
    "</style></head><body><h1>" + (opts.docTitle || "📄 精准培训资料") + "</h1>" +
    "<p style=\"color:#94a3b8;\">培训范围：" + escapeHtml(opts.scopeText || "") + " | 涉及人员：" + reviewerNames.join("、") + " | 生成日期：" + new Date().toLocaleDateString("zh-CN") + " | 共 " + matched.length + " 个案例</p>" +
    "<p style=\"color:#5e6f8d;font-size:0.85rem;\">品类+失误类别：" + comboText + "</p>";

    matched.forEach(function(c) {
        docHtml += "<div class=\"case-card\"><div class=\"qc-code\">🔖 质检码：" + escapeHtml(c.qcCode) + " | 🏷️ " + escapeHtml(c.errorCategory || "") + "</div>" +
        "<div class=\"label\">📝 问题描述</div><div class=\"desc\">" + escapeHtml(c.issueDesc || "") + "</div>";
        if (c.issuePhotos && c.issuePhotos.length > 0) {
            docHtml += "<div class=\"label\">📷 问题照片</div>" + c.issuePhotos.map(function(p) { return trainPhotoTag(p, 400, 400, resolved, placeholderOnly); }).join("");
        }
        docHtml += "<div class=\"label\">✅ 应操作方向</div><div class=\"correct\">" + escapeHtml(c.correctDir || "") + "</div>";
        if (c.dirPhotos && c.dirPhotos.length > 0) {
            docHtml += "<div class=\"label\">📷 方向示例照片</div>" + c.dirPhotos.map(function(p) { return trainPhotoTag(p, 400, 400, resolved, placeholderOnly); }).join("");
        }
        // 2026-09-22 修复：原先少一个「}」，把「方向示例补充照片」的判断嵌进了「方向示例照片」的 if 里，
        //   「有补充照片、没有方向示例照片」的案例那几张根本不渲染（实测每份报告丢约 7 张照片）。
        //   页面 buildTrainingDoc + renderGenerateMaterials + 本文件，三处同一份代码，一起改。
        if (c.dirExamplePhotos && c.dirExamplePhotos.length > 0) {
            docHtml += "<div class=\"label\">📸 方向示例补充照片</div>" + c.dirExamplePhotos.map(function(p) { return trainPhotoTag(p, 400, 400, resolved, placeholderOnly); }).join("");
        }
        docHtml += "</div>";
    });
    docHtml += "<div class=\"footer\">" + escapeHtml(opts.footerText || "优学堂 · 精准培训资料") + "</div></body></html>";
    return { ok: true, docHtml: docHtml, matched: matched, comboText: comboText };
}

// 报告存档：**KV 优先**（键 report_<utf8hex>），KV 写失败才退回 Supabase generatedReports。
//
// 为什么不再无条件写 Supabase（2026-09-21 实测后改）：
//   generatedReports 是**一整条记录**，每次写都要「读全量 + 写全量」。个人报告实测 0.78MB/份，
//   30 个人就是往这条记录里塞 ~23MB、来回搬 ~360MB —— 正是把 Supabase 出站流量打爆的那类写法
//   （402 那次）。而且收件人打开链接时，页面 openSharedReport 会先把**整条**记录拉下来
//   （index.html 17627 行），为看一份 0.78MB 的报告要下 23MB，手机很痛。
//   KV 是一人一键、按 key 单取，写多少读多少，没有放大（实测 2.2MB 单键写得进读得回）。
//   站点案例链不受影响：它每周只有 1 份报告，且由页面的同步通道去推，不经过这里。
// 所以：正常只写 KV；KV 万一失败才用 Supabase 那条当保命绳 —— 报告打得开比省流量重要。
async function saveReportAsync(reportName, html) {
    const bytes = Buffer.byteLength(String(html), 'utf8');

    // ① KV（主通道）：键 = report_ + utf8 十六进制（与页面 _kvReportKey 同算法）
    const key = 'report_' + Buffer.from(String(reportName), 'utf8').toString('hex');
    if (bytes > KV_REPORT_HARD_BYTES) {
        console.log('  ⚠️ KV 跳过：' + (bytes/1048576).toFixed(2) + ' MB 超过单键上限');
    } else {
        try {
            const r = await fetch(KV_PAGES + '/data', {
                method: 'POST',
                headers: { 'x-yxt-secret': KV_SECRET, 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: [{ key: key, v: html, t: new Date().toISOString() }] })
            });
            const j = await r.json().catch(function(){ return null; });
            if (j && j.ok && !j.failed) { console.log('  💾 KV 已缓存：' + Math.round(bytes/1024) + ' KB → ' + key.slice(0, 20) + '…'); return { ok: true, via: 'kv' }; }
            console.log('  ⚠️ KV 缓存失败：' + JSON.stringify(j).slice(0, 200));
        } catch (e) { console.log('  ⚠️ KV 缓存异常：' + e.message); }
    }

    // ② Supabase 兜底（只在上面没成功时走；会撑大那条共享记录，所以不作默认）
    try {
        const reports = (await supabaseGet('generatedReports')) || {};
        reports[reportName] = html;
        const wr = await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: 'generatedReports', value: JSON.stringify(reports), updated_at: new Date().toISOString() }])
        });
        if (!wr.ok) console.log('  ⚠️ Supabase 兜底也失败 HTTP ' + wr.status);
        else console.log('  💾 Supabase 兜底已存档：' + reportName + '（共 ' + Object.keys(reports).length + ' 份）');
        return { ok: wr.ok, via: 'supabase' };
    } catch (e) { console.log('  ⚠️ Supabase 兜底异常：' + e.message); return { ok: false, reason: '网络错误', error: e.message }; }
}

// ===== KV 兜底暂存（2026-09-04）=====
// Supabase 挂断（402/网络错）期间：写 app_data 转存 CF KV /data，读失败从 KV 读回
// feishu_token 走 /token 路由（与页面双写共用一份，不进中转、不回灌）
// KV 只做 Supabase 错误后的最后屏障：Supabase 恢复后由页面自动回灌并清空 KV
async function kvUpsert(key, value, t) {
    try {
        const r = await fetch(KV_PAGES + '/data', {
            method: 'POST',
            headers: { 'x-yxt-secret': KV_SECRET, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ key: key, v: value, t: t || new Date().toISOString() }] })
        });
        return r.ok;
    } catch(e) { console.log('  ⚠️ KV 写入失败: ' + e.message); return false; }
}
async function kvGetRaw(key) {
    // KV /data 中转读：返回原 value 字符串（无记录/墓碑返回 null）
    try {
        const r = await fetch(KV_PAGES + '/data?key=' + encodeURIComponent(key), { headers: { 'x-yxt-secret': KV_SECRET } });
        if (!r.ok) return null;
        const d = await r.json();
        if (!d || typeof d.value !== 'string') return null;
        const o = JSON.parse(d.value); // {"v":<原value>, "t":<时间>}
        return (o && typeof o.v === 'string') ? o.v : null;
    } catch(e) { return null; }
}
async function kvMirrorFromBody(body) {
    try {
        const items = JSON.parse(body);
        const arr = Array.isArray(items) ? items : [items];
        for (const it of arr) {
            if (!it || !it.key || typeof it.value === 'undefined') continue;
            if (it.key === 'feishu_token') {
                await fetch(KV_PAGES + '/token', { method: 'POST', headers: { 'x-yxt-secret': KV_SECRET, 'Content-Type': 'application/json' }, body: it.value }).catch(function(){});
            } else {
                await kvUpsert(it.key, String(it.value), it.updated_at);
            }
        }
    } catch(e) {}
}
// 写 app_data 的 fetch 统一包装：Supabase 失败/异常时把 body 转存 KV 兜底（读请求不包装）
const _origFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf(SUPABASE_URL + '/rest/v1/app_data') >= 0 && init && init.method === 'POST') {
        return _origFetch(input, init).then(function(res) {
            if (!res.ok) {
                console.log('  ⚠️ Supabase ' + res.status + '，写入转存 KV 兜底');
                return kvMirrorFromBody(init.body).then(function() { return res; });
            }
            return res;
        }).catch(function(e) {
            console.log('  ⚠️ Supabase 网络错误（' + e.message + '），写入转存 KV 兜底');
            return kvMirrorFromBody(init.body).then(function() { return null; });
        });
    }
    return _origFetch(input, init);
};

// ===== API =====
// 飞书 POST 统一入口（2026-09-20 加）。
// 为什么需要它：本脚本是**唯一不经过代理**的（网页走 feishuApiFetch、其他脚本走 viaProxy），
//   所以密钥一旦取不到，直连必然被飞书拒（HTTP 200 + code 10003）——而周一推送就整个不发。
//   这里补一条退路：有本地密钥就直连；没有就走 Pages 代理，
//   由代理用 Cloudflare 环境变量里的真值把 app_secret 补上（跟网页、其他脚本同一套机制）。
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
            // 直连被拒（最典型：密钥末尾多粘了个换行/空格，飞书回 10003）→ 不能就这么认了，
            // 下面还有代理那条路。2026-09-20 补：原来这里是「直连失败直接用失败结果」，
            // 等于把「密钥配错了」变成一个周一早上才发现的哑炮。
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
    if (!d.tenant_access_token) throw new Error('AppToken: ' + JSON.stringify(d));
    return d.tenant_access_token;
}

async function supabaseGet(key) {
    try {
        const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value&limit=1', {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length > 0) { try { return JSON.parse(arr[0].value); } catch(e) {} }
        return null;
    } catch(e) {
        // Supabase 挂断 → KV 兜底读（feishu_token 走 /token 路由，其余走 /data 中转）
        if (key === 'feishu_token') {
            try {
                const r2 = await fetch(KV_PAGES + '/token', { headers: { 'x-yxt-secret': KV_SECRET } });
                const d2 = await r2.json();
                if (d2 && d2.value) { try { return JSON.parse(d2.value); } catch(e2) {} }
            } catch(e2) {}
            return null;
        }
        const v = await kvGetRaw(key);
        if (v === null) { console.log('  ⚠️ Supabase 读 ' + key + ' 失败（' + e.message + '），KV 无兜底数据'); return null; }
        try { return JSON.parse(v); } catch(e2) { return null; }
    }
}

// 写推送记录。语义（2026-09-14 定，用户规则：「生成不是推送，发飞书卡片到对应才算推送记录」）：
//   ① 三个 pushRecords.push 都发生在 await sendCard() 之后、同一个 try 块里 → 只有真发成功才走到这里
//   ② 考试不进 trainingPushRecords ——「培训推送记录」tab 只放培训资料；考试的去处是 feishuPushRecords（下面的「已推送」标记）
//   ③ 学习进 learnPlanPushRecords（有专门的「学习地图推送记录」tab），培训进 trainingPushRecords
//   ④ 三类都写一份「已推送」标记到 feishuPushRecords —— 这是页面 ✅ 标签读的表，不写的话周一脚本推完页面还显示未推，管理员会重复推
// 每张表各自独立守卫：读不到自己的底表就一个字都不写（避免把历史整表覆盖）
async function writePushRecords(pushRecords) {
    if (!pushRecords || pushRecords.length === 0) { console.log('  📋 无推送记录需写入'); return; }
    var examRecords = pushRecords.filter(function(r){ return r.type === 'exam'; });
    var learnRecords = pushRecords.filter(function(r){ return r.type === 'learn'; });
    var trainRecords = pushRecords.filter(function(r){ return r.type === 'train'; });
    var existingTraining = await supabaseGet('trainingPushRecords');
    var existingLearn = await supabaseGet('learnPlanPushRecords');
    var existingPush = await supabaseGet('feishuPushRecords');
    var base = Date.now();
    var rows = [];
    var summary = [];

    // ① 培训 → trainingPushRecords（只有培训，不含考试）
    if (trainRecords.length > 0) {
        if (existingTraining === null) {
            console.log('  ⚠️ 读不到 trainingPushRecords，本次培训记录不写，避免覆盖历史');
        } else {
            // 2026-09-21：原来这里只搬了 reviewerName/email/pushedAt，把 scope / caseCount / reportName **丢了** ——
            //   而页面「培训推送记录」正是靠这三个字段显示「XXX 的培训资料」「N案例」「👁️查看/📥下载」。
            //   丢了之后页面读不到就当 0 和空渲染 → 显示成「培训资料（1人） | 0案例 | 📌 无报告」，
            //   报告明明在云端躺着却点不开。现在原样带过去（各自兜底，老记录里没这几个字段也不会报错）。
            var newTraining = existingTraining.concat(trainRecords.map(function(r, i){ return { key: 'train_'+r.reviewerName+'_'+(base+i), type: 'train', title: r.reviewerName+' 精准培训', reviewerName: r.reviewerName, users: [{name: r.email}], site: r.site || '', time: r.pushedAt, scope: r.scope || '个人培训资料', caseCount: (typeof r.caseCount === 'number' ? r.caseCount : 0), reportName: r.reportName || '' }; }));
            rows.push({ key: 'trainingPushRecords', value: JSON.stringify(newTraining), updated_at: new Date().toISOString() });
            summary.push('培训 ' + newTraining.length + ' 条(+' + trainRecords.length + ')');
        }
    }

    // ② 学习 → learnPlanPushRecords
    if (learnRecords.length > 0) {
        if (existingLearn === null) {
            console.log('  ⚠️ 读不到 learnPlanPushRecords，本次学习记录不写，避免覆盖历史');
        } else {
            var newLearn = existingLearn.concat(learnRecords.map(function(r, i){ return { key: 'learn_'+r.reviewerName+'_'+(base+i), type: 'learn', title: r.reviewerName+' 学习地图', reviewerName: r.reviewerName, users: [{name: r.email}], site: '', time: r.pushedAt }; }));
            rows.push({ key: 'learnPlanPushRecords', value: JSON.stringify(newLearn), updated_at: new Date().toISOString() });
            summary.push('学习 ' + newLearn.length + ' 条(+' + learnRecords.length + ')');
        }
    }

    // ③ 三类都写「已推送」标记 → feishuPushRecords（key 与页面 markFeishuPushed 完全一致；同一个 pushKey 覆盖旧条目）
    if (existingPush === null) {
        console.log('  ⚠️ 读不到 feishuPushRecords，本次「已推送」标记不写，避免覆盖历史');
    } else {
        var pushList = existingPush.slice();
        var marks = [];
        examRecords.forEach(function(r){ if (r.examCode) marks.push({ pushKey: 'exam_' + r.examCode, meta: { type: 'exam', title: r.reviewerName + ' 精准考试', reviewerName: r.reviewerName, users: [r.reviewerName], site: '' } }); });
        learnRecords.forEach(function(r){ if (r.planCode) marks.push({ pushKey: 'learning_' + r.planCode, meta: { type: 'learning', title: r.reviewerName + ' 学习地图', reviewerName: r.reviewerName, users: [r.reviewerName], site: '' } }); });
        trainRecords.forEach(function(r){ if (r.reportName) marks.push({ pushKey: 'train_' + r.reportName, meta: { type: 'train', title: r.reviewerName + ' 精准培训', reviewerName: r.reviewerName, users: [r.reviewerName], site: '' } }); });
        marks.forEach(function(mk){
            var hit = pushList.filter(function(x){ return x && x.pushKey === mk.pushKey; })[0];
            if (hit) { hit.time = new Date().toISOString(); hit.meta = mk.meta; }      // 同 key 覆盖 —— 与页面 markFeishuPushed 一致
            else pushList.push({ pushKey: mk.pushKey, time: new Date().toISOString(), meta: mk.meta });
        });
        rows.push({ key: 'feishuPushRecords', value: JSON.stringify(pushList), updated_at: new Date().toISOString() });
        summary.push('已推送标记 ' + pushList.length + ' 条(+' + marks.length + ')');
    }

    if (rows.length === 0) { console.log('  📋 无推送记录需写入'); return; }
    await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(rows)
    }).catch(function(){});
    console.log('  📋 推送记录已写：' + summary.join('，'));
}

async function sendCard(email, card, token) {
    const body = JSON.stringify({ receive_id: email, msg_type: 'interactive', content: JSON.stringify(card) });
    const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=email', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(d.msg || 'send fail');
    return d;
}

function examCard(name, count) {
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + name + ' 精准考试' }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达出卷阈值（≥' + TH.examMin + '次）\n点击下方按钮自动出卷并开始考试' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: SITE_URL + '?autoExam=' + encodeURIComponent(name) }] }] };
}
function learnCard(name, count) {
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + name + ' 学习地图' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达学习阈值（≥' + TH.learnMin + '次）\n点击下方按钮查看学习地图' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: SITE_URL + '?autoLearn=' + encodeURIComponent(name) }] }] };
}
function trainCard(name, count) {
    return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + name + ' 精准培训' }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达培训阈值（≥' + TH.trainMin + '次）\n点击下方按钮查看培训资料' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: SITE_URL + '?autoTrain=' + encodeURIComponent(name) }] }] };
}

// ===== 主流程 =====
async function main() {
    console.log('=== 飞书周一自动推送 ' + new Date().toISOString() + ' [阶段:' + PHASE + '] ===');
    const wk = lastWeek();
    console.log('上周: ' + wk.key + ' ~ ' + fmt(wk.end));

    const doneKey = 'auto_push_done_' + fmt(new Date());
    const queueKey = 'auto_push_queue_' + wk.key;

    // send 阶段：无视已推送标记，直接读队列发
    if (PHASE === 'send') {
        console.log('📤 发送模式（无视已推送标记，以本次为准）');
        const queue = await supabaseGet(queueKey);
        if (!queue || !queue.entries || queue.entries.length === 0) { console.log('队列为空，无待推送人员'); return; }
        const appToken = await getAppToken();
        let sent = 0, fail = 0;
        let pushRecords = []; // 推送记录，写回 Supabase 供网页查看
        for (const entry of queue.entries) {
            if (entry.type === 'exam') {
                var card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + entry.name + ' 精准考试' }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + entry.name + '** 上周失误 **' + entry.count + ' 次**，已达出卷阈值\n考试码：**' + entry.code + '**' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: SITE_URL + '?exam=' + entry.code }] }] };
                try { await sendCard(entry.email, card, appToken); console.log('  📝 考试 → ' + entry.name + '(' + entry.count + ') [' + entry.code + ']'); sent++; pushRecords.push({ type: 'exam', reviewerName: entry.name, examCode: entry.code, email: entry.email, pushedAt: new Date().toISOString() }); }
                catch(e) { console.log('  ❌ ' + entry.name + ': ' + e.message); fail++; }
            } else if (entry.type === 'learn') {
                var lcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '🗺️ ' + entry.name + ' 学习地图' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + entry.name + '** 上周失误 **' + entry.count + ' 次**，已达学习阈值\n课程：' + entry.courseCount + ' 节' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🗺️ 学习地图' }, type: 'primary', url: SITE_URL + '?learnPlan=' + entry.code }] }] };
                try { await sendCard(entry.email, lcard, appToken); console.log('  🗺️ 学习 → ' + entry.name + ' [' + entry.code + '] ' + entry.courseCount + '课'); sent++; pushRecords.push({ type: 'learn', reviewerName: entry.name, planCode: entry.code, email: entry.email, pushedAt: new Date().toISOString() }); }
                catch(e) { console.log('  ❌ ' + entry.name + ': ' + e.message); fail++; }
            } else if (entry.type === 'train') {
                var tcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + entry.name + ' 精准培训' }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + entry.name + '** 上周失误 **' + entry.count + ' 次**，已达培训阈值\n匹配案例：' + entry.caseCount + ' 条' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: SITE_URL + '?report=' + encodeURIComponent(entry.reportName) }] }] };
                // 2026-09-21：caseCount / scope 必须带上 —— 页面「培训推送记录」靠它们显示「N案例」和
                //   「XXX 的培训资料」。之前没带 → 自动推的记录在页面上显示成「0案例 | 培训资料 | 📌 无报告」，
                //   连「查看/下载」按钮都不出来（报告明明生成了却点不开）。scope 由推的人决定：本脚本按人匹配
                //   案例，故为「个人培训资料」；以后若加站点级推送，在那边写 scope 即可，这里会原样带过去。
                try { await sendCard(entry.email, tcard, appToken); console.log('  📖 培训 → ' + entry.name + ' (' + entry.caseCount + '条)'); sent++; pushRecords.push({ type: 'train', reviewerName: entry.name, reportName: entry.reportName, email: entry.email, pushedAt: new Date().toISOString(), caseCount: entry.caseCount || 0, scope: entry.scope || '个人培训资料' }); }
                catch(e) { console.log('  ❌ ' + entry.name + ': ' + e.message); fail++; }
            }
        }
        // 写入推送记录到 Supabase
        await writePushRecords(pushRecords);
        // 标记已推送（以此为准）
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: doneKey, value: JSON.stringify({ date: new Date().toISOString(), week: wk.key, sent, fail, phase: 'send' }), updated_at: new Date().toISOString() }])
        });
        console.log('=== 发送完成: ' + sent + '成功 ' + fail + '失败 ===');
        return;
    }

    // analyze/full 阶段：检查推送标记（仅认脚本写的JSON对象，忽略浏览器端的"1"）
    var doneVal = await supabaseGet(doneKey);
    if (PHASE !== 'analyze' && doneVal && typeof doneVal === 'object' && doneVal.phase) { console.log('已推送（' + doneVal.phase + '），跳过'); return; }
    if (PHASE === 'analyze') console.log('🔍 分析模式（不发送、不标记）');
    if (PHASE === 'full') console.log('📤 完整模式（分析+发送+标记）');

    const appToken = await getAppToken();
    const emails = (await supabaseGet('personnelEmails')) || {};
    console.log('Token OK, 邮箱: ' + Object.keys(emails).length + '人');

    let sent = 0, fail = 0;
    let pushQueue = []; // 推送队列
    let pushRecords = []; // 推送记录（full 阶段写回：培训→trainingPushRecords / 学习→learnPlanPushRecords / 三类都→feishuPushRecords 已推送标记）
    let generatedExamCodes = {}; // 记录本次生成的考试码，供发送时直接使用

    // 从飞书获取用户的 token 读表格（优先 refresh，失败才降级 appToken）
    const stored = await supabaseGet('feishu_token');
    var userToken = null;
    if (stored && stored.access_token) {
        if (stored.expiresAt > Date.now()) {
            userToken = stored.access_token;
        } else if (stored.refresh_token) {
            // token 过期，尝试 refresh
            try {
                // 2026-09-20：改走 feishuPost —— 没配密钥时由代理补（原来直连，空密钥必被拒）
                var refData = await feishuPost('/authen/v1/refresh_access_token', { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET, grant_type: 'refresh_token', refresh_token: stored.refresh_token });
                if (refData.code === 0 && refData.data && refData.data.access_token) {
                    userToken = refData.data.access_token;
                    // 保存新 token 回 Supabase
                    var newToken = { access_token: refData.data.access_token, refresh_token: refData.data.refresh_token || stored.refresh_token, expiresAt: Date.now() + (refData.data.expires_in || 7200) * 1000 };
                    await fetch(SUPABASE_URL + '/rest/v1/app_data', {
                        method: 'POST',
                        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
                        body: JSON.stringify([{ key: 'feishu_token', value: JSON.stringify(newToken), updated_at: new Date().toISOString() }])
                    }).catch(function(){});
                    console.log('🔄 Token 已刷新');
                }
            } catch(e) { console.warn('⚠️ Token 刷新失败: ' + e.message); }
        }
    }
    if (!userToken) {
        console.warn('⚠️ 无有效用户 token，降级使用租户 token（可能无读表格权限）');
        userToken = appToken;
    }

    // 拉取上周数据，分析按人统计
    let rows = [];
    const FEISHU_SHEETS = [
        { id: '4054dd', colDate: 0, colReviewer: 8, colCategory: 6, colNote: 9, colProduct: 5 },
        { id: 'mEiT35', colDate: 0, colReviewer: 6, colCategory: 10, colNote: 11, colProduct: 5 },
        { id: 'LIfICo', colDate: 0, colReviewer: 5, colCategory: 4, colNote: 6, colProduct: 3 }
    ];
    for (const sh of FEISHU_SHEETS) {
        try {
            const r2 = await fetch('https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/EdI0sn3qkh7H6wtkhcpcxrTnnDf/values/' + sh.id + '?majorDimension=ROWS', { headers: { 'Authorization': 'Bearer ' + userToken } });
            const d2 = await r2.json();
            if (d2.code && d2.code !== 0) { console.warn('  ⚠️ Sheet ' + sh.id + ' 返回错误: ' + (d2.msg||d2.code)); continue; }
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
        } catch(e) { console.warn('  ⚠️ Sheet ' + sh.id + ' 读取异常: ' + e.message); }
    }

    // 再读一遍全部数据（不限周），用于学习地图关键词提取
    var allRows = [];
    for (const sh of FEISHU_SHEETS) {
        try {
            var r3 = await fetch('https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/EdI0sn3qkh7H6wtkhcpcxrTnnDf/values/'+sh.id+'?majorDimension=ROWS', {
                headers:{'Authorization':'Bearer '+userToken}
            });
            var d3 = await r3.json();
            if (d3.code && d3.code !== 0) { console.warn('  ⚠️ 全量Sheet ' + sh.id + ' 返回错误: ' + (d3.msg||d3.code)); continue; }
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
        } catch(e) { console.warn('  ⚠️ 全量Sheet ' + sh.id + ' 读取异常: ' + e.message); }
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
    const reportedQuestions = (await supabaseGet('reportedQuestions')) || {};
    // 过滤被反馈且未解决的试题
    const allQuestions = (qbData.questions || []).filter(function(q) {
        var r = reportedQuestions[q.id];
        return !(r && !r.resolved);
    });
    console.log('题库: ' + (qbData.questions||[]).length + '题 → 排除反馈后: ' + allQuestions.length + '题');
    // 旧题库数据题型纠正：choice 但答案为多字母（多选）→ multi（与网页端 inferQuestionType 同规则）
    allQuestions.forEach(function(q) {
        if (q.type === 'choice' && q.answer) {
            var cleanAns = String(q.answer).replace(/[\s√✓.,、;；]/g, '');
            if (/^[A-Fa-f]{2,}$/.test(cleanAns)) q.type = 'multi';
        }
    });

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

    // 阈值 examMin/learnMin/trainMin 见文件顶部 TH（2026-09-21 提到模块级，卡片文案也读它）
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
                generatedAt: new Date().toISOString(),
                source: '周一自动推送',
                status: 'pending', attempts: 0, records: [],
                timeLimit: 40, maxAttempts: 2, wrongAnswers: []
            };
            examHistory[examRecord.id] = examRecord;
            generatedExamCodes[name] = examCode;
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
            var examCode = generatedExamCodes[name] || null;
            // fallback: 从 examHistory 查找（analyze 阶段预先出卷的场景）
            if (!examCode) {
                var exams = Object.values(examHistory).filter(function(e) {
                    if (e.reviewerName !== name) return false;
                    var t = new Date(e.generatedAt || e.time || 0);
                    return t >= wk.start && t <= wk.end;
                });
                if (exams.length > 0) examCode = exams[exams.length - 1].examCode;
            }

            if (!examCode) { console.log('  ⏭ ' + name + ' 无考试码，跳过'); continue; }
            if (PHASE === 'analyze') {
                pushQueue.push({ type: 'exam', name: name, email: email, count: count, code: examCode });
                console.log('  📝 加入队列 → ' + name + '(' + count + ') [' + examCode + ']');
            } else {
                var card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📝 ' + name + ' 精准考试' }, template: 'orange' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达出卷阈值\n考试码：**' + examCode + '**' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 开始考试' }, type: 'primary', url: SITE_URL + '?exam=' + examCode }] }] };
                try { await sendCard(email, card, appToken); console.log('  📝 考试 → ' + name+'('+count+') [' + examCode + ']'); sent++; pushRecords.push({ type: 'exam', reviewerName: name, examCode: examCode, email: email, pushedAt: new Date().toISOString() }); }
                catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
            }
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
                if (PHASE === 'analyze') {
                    pushQueue.push({ type: 'learn', name: name, email: email, count: count, code: planCode, courseCount: allItems.length });
                    console.log('  🗺️ 加入队列 → ' + name + ' [' + planCode + '] ' + allItems.length + '课');
                } else {
                    var lcard = {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'🗺️ '+name+' 学习地图'},template:'blue'},elements:[{tag:'div',text:{tag:'lark_md',content:'**'+name+'** 上周失误 **'+count+' 次**，已达学习阈值\n课程：'+allItems.length+' 节\n涉及：'+areaNames}},{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'🗺️ 学习地图'},type:'primary',url:SITE_URL+'?learnPlan='+planCode}]}]};
                    try { await sendCard(email, lcard, appToken); console.log('  🗺️ 学习 → '+name+' ['+planCode+'] '+allItems.length+'课'); sent++; pushRecords.push({ type: 'learn', reviewerName: name, planCode: planCode, email: email, pushedAt: new Date().toISOString() }); }
                    catch(e) { console.log('  ❌ '+name+': '+e.message); fail++; }
                }
            } else { console.log('  ⏭ '+name+' 未匹配到课程'); }
        }
        if (count >= TH.trainMin) {
            // ── 照片：目标是「收件人打开就有图、零点击」，所以**每张都要嵌进报告** ──────────
            // 两条来源，先便宜的：
            //   ① Pages KV 里现成的压缩图（键 qbimg_<飞书token>，主电脑压好的 900px JPEG 80%）
            //      —— 直接嵌，不下载，免费。实测命中率约 6 成。
            //   ② KV 里没有 → 下飞书原图（实测平均 2.08MB/张）→ sharp 压到 900px 再嵌，
            //      顺手写回 KV，下周同一张就直接命中 ①（一次写入换长期免费）。
            // 为什么不再「全有或全无」，也不再「装不下就留占位」：收件人点一下才能看图 = 没达到目的。
            // 取图路径与页面 _qbImgGetFromKV（index.html 约 9798 行）逐字对应：
            // 页面传的 key 不带前缀，worker 内部自己补 sync_。
            async function getKvImage(token) {
                if (!token) return null;
                try {
                    const r = await fetch(KV_PAGES + '/data?key=' + encodeURIComponent('qbimg_' + token), { headers: { 'x-yxt-secret': KV_SECRET } });
                    if (!r.ok) return null;
                    const j = await r.json();
                    if (!j || !j.value) return null;
                    let o = null;
                    try { o = JSON.parse(j.value); } catch(e) { return null; }
                    if (o && typeof o.v === 'string' && o.v.indexOf('data:image') === 0) return o.v;
                    return null;
                } catch(e) { return null; }
            }

            // 下飞书原图：走 Pages 代理的 x-target-url 通道，与页面 fetchFeishuImage（index.html 9648 行）
            // 同一条路、同一个接口。代理对 image/* 是**原样透传字节**的（cf-pages-proxy/_worker.js 787 行），
            // 所以这里直接拿 arrayBuffer，千万别 text()（UTF-8 解码会把二进制搞坏）。
            async function downloadFeishuImage(fileToken, authToken) {
                if (!fileToken) return null;
                try {
                    const headers = {
                        'x-target-url': 'https://open.feishu.cn/open-apis/drive/v1/medias/' + fileToken + '/download',
                        'x-target-method': 'GET'
                    };
                    if (authToken) headers['x-target-auth'] = 'Bearer ' + authToken;
                    const r = await fetch(KV_PAGES, { headers: headers });
                    if (!r.ok) return null;
                    const ct = String(r.headers.get('content-type') || '').toLowerCase();
                    const buf = Buffer.from(await r.arrayBuffer());
                    if (!buf || buf.length < 100) return null;
                    if (buf[0] === 0x7b) return null;   // 首字节 0x7b = 飞书返回的 JSON 错误体（多半是 token 过期）
                    if (ct.indexOf('image/') !== 0 && ct.indexOf('octet-stream') < 0) return null;
                    return buf;
                } catch (e) { return null; }
            }

            // 压到这张照片的预算以内。阶梯：先按最高画质试，超了就往下退一档。
            // 为什么退分辨率而不是退张数：900px 已经远超 400px 的显示框，退到 640px 在手机上也看不出
            // 差别 —— 宁可每张都稍微降一点，也要保证**一张不落**（少一张就得让收件人点一下）。
            const PHOTO_LADDER = [
                { px: 900, q: 78 }, { px: 820, q: 70 }, { px: 720, q: 62 }, { px: 640, q: 54 }
            ];
            async function shrinkToDataUri(buf, capBytes) {
                if (!sharp) return null;
                let last = null;
                for (let li = 0; li < PHOTO_LADDER.length; li++) {
                    const rung = PHOTO_LADDER[li];
                    try {
                        const out = await sharp(buf)
                            .rotate()   // 按 EXIF 摆正：手机竖拍的照片不转这一下会躺着
                            .resize({ width: rung.px, height: rung.px, fit: 'inside', withoutEnlargement: true })
                            .jpeg({ quality: rung.q, mozjpeg: true })
                            .toBuffer();
                        last = 'data:image/jpeg;base64,' + out.toString('base64');
                        if (last.length <= capBytes) return last;
                    } catch (e) {
                        return null;    // sharp 不认的格式（如 iPhone 的 HEIC）→ 放弃这张，外层会留占位图
                    }
                }
                return last;            // 退到最低档还是超预算：照样返回，让总预算去定夺
            }

            // 把新压好的图写回 KV（键与页面 _qbImgKey 同款、值格式 {"v":dataURI,"t":iso}）。
            // 只写 KV 里本来没有的 —— 绝不覆盖主电脑压好的那份。失败无所谓（下次再下原图就是）。
            async function kvBackfillImages(items) {
                if (!items.length) return 0;
                try {
                    const r = await fetch(KV_PAGES + '/data', {
                        method: 'POST',
                        headers: { 'x-yxt-secret': KV_SECRET, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items: items })
                    });
                    const j = await r.json().catch(function () { return null; });
                    return (j && j.written) || 0;
                } catch (e) { return 0; }
            }

            // 个人培训资料：与页面「失误分析看板 → 个人培训资料」手动生成的那份完全一致。
            // 算法与排版见文件顶部 buildTrainingDocLocal（照抄页面 buildTrainingDoc）。
            const trainBase = {
                errors: rows,
                reviewerNames: [name],
                scopeText: wk.key + '（' + fmt(wk.start) + ' ~ ' + fmt(wk.end) + '）',
                docTitle: '📄 精准培训资料',
                footerText: '优学堂 · 精准培训资料',
                cases: allCasesData,
                maxCases: 30
            };

            // 第一遍：占位图模式 —— 一张照片都不取，先把「选中哪 30 个案例」定下来
            const pre = buildTrainingDocLocal(Object.assign({}, trainBase, { placeholderOnly: true }));
            if (!pre.ok) {
                console.log('  ⏭ ' + name + ' ' + pre.reason + '，跳过');
            } else {
                // 只取「选中案例」的照片（没选上的一张都不取）；KV 里没有的留空，生成时自动变占位图
                const resolved = {};
                const photoTokens = [];
                pre.matched.forEach(function(c) {
                    ['issuePhotos', 'dirPhotos', 'dirExamplePhotos'].forEach(function(k) {
                        (c[k] || []).forEach(function(p) {
                            if (p && typeof p === 'object' && p.t && photoTokens.indexOf(p.t) < 0) photoTokens.push(p.t);
                        });
                    });
                });
                // 每张照片的预算 = 总预算平均分给所有照片，夹在 50KB~250KB。
                //   · 张数多（比如 45 张）→ 每张 50KB 下限，宁可降画质也要一张不落；
                //   · 张数少 → 上限 250KB，不必浪费预算。
                // 按 24 张算：2.2MB/24 ≈ 94KB/张 —— 实测压完平均约 65KB，都装得下。
                const perPhotoCap = Math.max(50 * 1024, Math.min(250 * 1024,
                    Math.floor(KV_PHOTO_BUDGET_BYTES / Math.max(1, photoTokens.length))));

                let photoBytes = 0, fromKv = 0, fromFeishu = 0;
                const backfill = [];
                for (let ti = 0; ti < photoTokens.length; ti++) {
                    const tk = photoTokens[ti];
                    if (photoBytes >= KV_PHOTO_BUDGET_BYTES) continue;      // 总预算用光 → 剩下的留占位图（兜底，正常到不了）

                    let b64 = await getKvImage(tk);                          // ① KV 现成的
                    if (b64) {
                        // 个别 KV 图偏大（实测最大 263KB，超过 94KB 的均摊预算）→ 重压一遍，别挤占别人的份额
                        if (b64.length > perPhotoCap && sharp) {
                            const raw = Buffer.from(String(b64).split(',')[1] || '', 'base64');
                            if (raw.length) b64 = (await shrinkToDataUri(raw, perPhotoCap)) || b64;
                        }
                        if (b64) fromKv++;
                    } else {
                        // ② KV 里没有 → 下飞书原图 → 压到预算以内
                        const raw = await downloadFeishuImage(tk, appToken);
                        if (raw) {
                            b64 = await shrinkToDataUri(raw, perPhotoCap);
                            if (b64) {
                                fromFeishu++;
                                backfill.push({ key: 'qbimg_' + tk, v: b64, t: new Date().toISOString() });
                            }
                        }
                        // 错开一点：飞书对短时间大量下载会限流，压着 150ms 一张稳一点
                        await new Promise(function (res) { setTimeout(res, 150); });
                    }
                    if (!b64) continue;                                     // 两条路都没拿到 → 留占位图（点一下能看）
                    if (photoBytes + b64.length > KV_PHOTO_BUDGET_BYTES) continue;
                    resolved[tk] = b64;
                    photoBytes += b64.length;
                }
                // 写回 KV：一次批量写完，别一张一个请求（KV 免费写额度 1000/天，也要省着用）
                const backfilled = await kvBackfillImages(backfill);
                if (backfilled) console.log('     ↑ 已写回 KV ' + backfilled + ' 张压缩图（下周不用再下原图）');

                // 第二遍：内嵌 base64 生成
                let rpt = buildTrainingDocLocal(Object.assign({}, trainBase, { resolvedPhotos: resolved }));
                let rptBytes = Buffer.byteLength(rpt.docHtml, 'utf8');
                // 超过 KV 单键上限 → 退回占位图版（与页面 runSiteCaseTrainingPush 的两遍生成同款）
                if (rptBytes > KV_REPORT_HARD_BYTES) {
                    const phBytes = Buffer.byteLength(pre.docHtml, 'utf8');
                    console.log('  ⚠️ ' + name + ' 内嵌照片版 ' + (rptBytes / 1048576).toFixed(2) + ' MB 超过 KV 上限，改用占位图版（' + Math.round(phBytes / 1024) + ' KB）');
                    rpt = pre; rptBytes = phBytes;
                }
                console.log('  📖 ' + name + '：案例 ' + rpt.matched.length + ' 条 · 照片内嵌 ' + Object.keys(resolved).length + ' 张（KV 现成 ' + fromKv + ' + 新压 ' + fromFeishu + '）/ 占位 ' + (photoTokens.length - Object.keys(resolved).length) + ' 张 · ' + (rptBytes / 1048576).toFixed(2) + ' MB');

                // 报告名 = 姓名 + 生成日期（北京时间的今天）。
                // 原来用 wk.key（上周一），报告名会随「哪天生成」漂 7 天，跟页面手动生成的那份对不上。
                const reportName = name + ' 培训资料(' + beijingDateStr() + ')';
                const shareUrl = SITE_URL + '?report=' + encodeURIComponent(reportName);
                await saveReportAsync(reportName, rpt.docHtml);

                if (PHASE === 'analyze') {
                    pushQueue.push({ type: 'train', name: name, email: email, count: count, code: planCode, caseCount: rpt.matched.length, reportName: reportName });
                    console.log('  📖 加入队列 → ' + name + ' (' + rpt.matched.length + '条)');
                } else {
                    const tcard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '📖 ' + name + ' 精准培训' }, template: 'purple' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**' + name + '** 上周失误 **' + count + ' 次**，已达培训阈值\n匹配案例：' + rpt.matched.length + ' 条' } }, { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📖 查看培训' }, type: 'primary', url: shareUrl }] }] };
                    try { await sendCard(email, tcard, appToken); console.log('  📖 培训 → ' + name + ' (' + rpt.matched.length + '条)'); sent++; pushRecords.push({ type: 'train', reviewerName: name, reportName: reportName, email: email, pushedAt: new Date().toISOString(), caseCount: rpt.matched.length, scope: '个人培训资料' }); }
                    catch(e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
                }
            }
        }
    }

    if (PHASE === 'analyze') {
        // 分析模式：保存队列到 Supabase，不发、不标记
        if (pushQueue.length > 0) {
            await fetch(SUPABASE_URL + '/rest/v1/app_data', {
                method: 'POST',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify([{ key: queueKey, value: JSON.stringify({ entries: pushQueue, week: wk.key, time: new Date().toISOString() }), updated_at: new Date().toISOString() }])
            });
            console.log('=== 分析完成: ' + pushQueue.length + ' 人已加入推送队列 ===');
        } else {
            console.log('=== 分析完成: 无人达到推送阈值 ===');
        }
    } else if (PHASE === 'full') {
        // 写推送记录（供网页「培训推送记录」「学习地图推送记录」查看）
        await writePushRecords(pushRecords);
        // 标记已推送（防止下周重复发送）
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([{ key: doneKey, value: JSON.stringify({ date: new Date().toISOString(), week: wk.key, sent, fail, phase: 'full' }), updated_at: new Date().toISOString() }])
        });
        console.log('=== 完成: ' + sent + '成功 ' + fail + '失败 ===');
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
