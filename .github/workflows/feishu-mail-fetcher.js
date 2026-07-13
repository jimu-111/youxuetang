/**
 * 判责量本地文件 → Supabase 云端同步
 * 用法：node feishu-mail-fetcher.js [文件路径]
 * 默认路径：C:\Users\xuhan\Desktop\判责数据.xlsx
 * Windows 定时任务每天跑一次
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const CONFIG = {
    localFile: process.env.PANZE_FILE || '',
    localDir: path.join(require('os').homedir(), 'Desktop', '借出', '判责完成导出', '每日判责完成导出', '每日判责完成导出数据表'),
    supabase: {
        url: process.env.SUPABASE_URL || 'https://zfxwnixlvdxawoylhgxj.supabase.co',
        key: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8',
    },
};

// ========== 工具函数 ==========
function supabaseUpsert(key, value) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]);
        const url = new URL(CONFIG.supabase.url + '/rest/v1/app_data');
        const opts = {
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: {
                'apikey': CONFIG.supabase.key,
                'Authorization': 'Bearer ' + CONFIG.supabase.key,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates',
            }
        };
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error('Supabase err ' + res.statusCode + ': ' + d));
                else resolve();
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ========== Excel 解析 ==========
function parsePanZeExcel(filePath) {
    console.log('[Excel] 读取: ' + filePath);

    let XLSX;
    try { XLSX = require('xlsx'); } catch (e) {
        require('child_process').execSync('npm install xlsx', { stdio: 'inherit' });
        XLSX = require('xlsx');
    }

    const buf = fs.readFileSync(filePath);
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    console.log('[Excel] Sheet: ' + sheetName);

    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!data || data.length < 2) { console.log('[Excel] 无数据'); return null; }

    // 找"初审人员"列
    const header = data[0];
    let colName = -1;
    for (let i = 0; i < header.length; i++) {
        const h = String(header[i]).trim();
        if (h === '初审人员' || h === '初审' || h.includes('初审') || h === '姓名' || h === '名字') {
            colName = i; break;
        }
    }
    if (colName < 0) { console.log('[Excel] 未找到名字列，表头: ' + JSON.stringify(header)); return null; }
    console.log('[Excel] 名字列: 索引' + colName + ' (' + header[colName] + ')');

    // 按名字出现次数计数（判责数据名字即标准，不做任何修正）
    const panZeMap = {};
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row) continue;
        const name = String(row[colName] || '').trim();
        if (name) {
            panZeMap[name] = (panZeMap[name] || 0) + 1;
        }
    }

    console.log('[Excel] 解析结果: ' + Object.keys(panZeMap).length + ' 人');
    for (const [name, count] of Object.entries(panZeMap)) {
        console.log('  ' + name + ': ' + count);
    }
    return panZeMap;
}

// ========== 主流程 ==========
async function main() {
    // 计算前一天的日期，匹配文件名：YYYY-MM-DD判责完成数据.xlsx
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');

    // 优先使用命令行参数指定的文件，否则自动匹配前一天的文件
    let filePath = process.argv[2];
    if (!filePath) {
        filePath = path.join(CONFIG.localDir, yStr + '判责完成数据.xlsx');
    }

    console.log('========================================');
    console.log('  判责量本地 → Supabase 同步');
    console.log('  文件: ' + filePath);
    console.log('  ' + new Date().toISOString());
    console.log('========================================');

    if (!fs.existsSync(filePath)) {
        console.log('[Main] ❌ 文件不存在: ' + filePath);
        console.log('[Main] 请将判责邮件附件保存为: ' + filePath);
        process.exit(1);
    }

    try {
        // 解析 Excel
        const panZeMap = parsePanZeExcel(filePath);
        if (!panZeMap || Object.keys(panZeMap).length === 0) {
            console.log('[Main] 未解析到数据，任务结束');
            return;
        }

        // 写入 Supabase：优先从文件名提取日期，否则用今天
        const fileDateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})判责完成数据/);
        const targetDate = fileDateMatch ? fileDateMatch[1] : new Date().toISOString().slice(0, 10);
        const panZeData = JSON.stringify({
            date: targetDate,
            map: panZeMap,
            updatedAt: new Date().toISOString(),
        });

        await supabaseUpsert('feishu_panze_' + targetDate, panZeData);
        console.log('[Supabase] 已写入: feishu_panze_' + targetDate + ' (' + Object.keys(panZeMap).length + '人)');

        // 维护 latest 标记
        await supabaseUpsert('feishu_panze_latest', JSON.stringify({
            date: targetDate,
            total: Object.values(panZeMap).reduce((a, b) => a + b, 0),
            count: Object.keys(panZeMap).length,
        }));
        console.log('[Supabase] latest 标记已更新');

        // 每周一清理上上周的数据源
        const today2 = new Date();
        if (today2.getDay() === 1) {
            console.log('[清理] 今天是周一，清理上上周之前的文件...');
            const cutoff = new Date(today2);
            cutoff.setDate(today2.getDate() - 7); // 7天前
            const cutoffStr = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0') + '-' + String(cutoff.getDate()).padStart(2, '0');
            try {
                const files = fs.readdirSync(CONFIG.localDir);
                let deleted = 0;
                for (const f of files) {
                    const m = f.match(/^(\d{4}-\d{2}-\d{2})判责完成数据\.xlsx$/);
                    if (m && m[1] < cutoffStr) {
                        fs.unlinkSync(path.join(CONFIG.localDir, f));
                        console.log('[清理] 已删除: ' + f);
                        deleted++;
                    }
                }
                console.log('[清理] 完成，删除 ' + deleted + ' 个文件（' + cutoffStr + ' 以前）');
            } catch(e) { console.log('[清理] 失败:', e.message); }
        }

        console.log('[Main] ✅ 全部完成！');
    } catch (err) {
        console.error('[Main] ❌ 失败:', err.message);
        process.exit(1);
    }
}

main();
