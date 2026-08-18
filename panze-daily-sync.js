/**
 * 每日判责量自动同步（覆盖式，配合Windows计划任务使用）
 * 只同步最近3天的文件，每次都直接覆盖上传，不检查是否已存在
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://zfxwnixlvdxawoylhgxj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHduaXhsdmR4YXdveWxoZ3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDEyNzIsImV4cCI6MjA5Nzc3NzI3Mn0.aPfO4Ry_LzoOColCVx64JQPF-BWga-_J2fX9hg-E4G8';
const LOCAL_DIR = path.join(require('os').homedir(), 'Desktop', '借出', '判责完成导出', '每日判责完成导出', '每日判责完成导出数据表');

function supabaseUpsert(key, value) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]);
        const url = new URL(SUPABASE_URL + '/rest/v1/app_data');
        const opts = {
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
            }
        };
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error('Supabase err ' + res.statusCode));
                else resolve();
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function parsePanZeExcel(filePath) {
    let XLSX;
    try { XLSX = require('xlsx'); } catch (e) {
        require('child_process').execSync('npm install xlsx', { stdio: 'inherit' });
        XLSX = require('xlsx');
    }
    const buf = fs.readFileSync(filePath);
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!data || data.length < 2) return null;
    const header = data[0];
    let colName = -1;
    for (let i = 0; i < header.length; i++) {
        const h = String(header[i]).trim();
        if (h === '初审人员' || h === '初审' || h.includes('初审') || h === '姓名' || h === '名字') {
            colName = i; break;
        }
    }
    if (colName < 0) return null;
    const panZeMap = {};
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row) continue;
        const name = String(row[colName] || '').trim();
        if (name) panZeMap[name] = (panZeMap[name] || 0) + 1;
    }
    return panZeMap;
}

async function main() {
    console.log('判责量同步任务开始...');
    if (!fs.existsSync(LOCAL_DIR)) {
        console.log('❌ 目录不存在: ' + LOCAL_DIR);
        process.exit(1);
    }
    const files = fs.readdirSync(LOCAL_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}判责完成数据\.xlsx$/.test(f))
        .sort();
    if (files.length === 0) {
        console.log('❌ 未找到判责Excel文件');
        process.exit(1);
    }
    console.log('  共 ' + files.length + ' 个文件（' + files[0].slice(0,10) + ' ~ ' + files[files.length-1].slice(0,10) + '）');

    // 只覆盖最近3天的文件（每次都直接上传，不检查是否已存在）
    const recentDates = [];
    for (let d = 0; d < 3; d++) {
        recentDates.push(new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
    }
    console.log('  覆盖范围: ' + recentDates.join(', '));

    let synced = 0, skipped = 0, failed = 0;
    for (const f of files) {
        const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : '';
        if (!dateStr) { skipped++; continue; }

        // 只处理最近3天的文件（覆盖式），其余跳过
        if (!recentDates.includes(dateStr)) { skipped++; continue; }

        const panZeMap = parsePanZeExcel(path.join(LOCAL_DIR, f));
        if (!panZeMap || Object.keys(panZeMap).length === 0) {
            console.log('  ⚠️ ' + dateStr + ' 解析无数据，跳过');
            skipped++;
            continue;
        }

        const names = Object.keys(panZeMap);
        const total = Object.values(panZeMap).reduce((a, b) => a + b, 0);
        await supabaseUpsert('feishu_panze_' + dateStr, JSON.stringify({
            date: dateStr, map: panZeMap, updatedAt: new Date().toISOString()
        }));
        console.log('  ✅ ' + dateStr + ' (' + names.length + '人, ' + total + '次)');
        synced++;
    }

    // 更新最新记录
    if (synced > 0 || skipped > 0) {
        const last = files[files.length - 1];
        const dm = last.match(/^(\d{4}-\d{2}-\d{2})/);
        const lastDate = dm ? dm[1] : '';
        if (lastDate) {
            const lastMap = parsePanZeExcel(path.join(LOCAL_DIR, last));
            if (lastMap) {
                const names = Object.keys(lastMap);
                const total = Object.values(lastMap).reduce((a, b) => a + b, 0);
                await supabaseUpsert('feishu_panze_latest', JSON.stringify({
                    date: lastDate, total, count: names.length
                }));
            }
        }
    }

    console.log('📊 完成: ' + synced + ' 个覆盖, ' + skipped + ' 个跳过, ' + failed + ' 个失败');
    process.exit(0);
}

main().catch(e => {
    console.log('❌ 同步失败: ' + e.message);
    process.exit(1);
});
