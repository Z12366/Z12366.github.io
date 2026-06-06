const express = require('express');
const path = require('path');
const { pool, initDB } = require('./db');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname)));

// ===== 车辆入场 =====
app.post('/api/enter', async (req, res) => {
  try {
    const { plate, type, nev } = req.body;
    if (!plate || !/^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼宁][A-Z][A-Z0-9]{5,6}$/.test(plate)) {
      return res.json({ ok: false, msg: '车牌格式不正确' });
    }
    const [rows] = await pool.query(
      'SELECT id FROM parking_records WHERE plate = ? AND status = 1', [plate]
    );
    if (rows.length > 0) return res.json({ ok: false, msg: '该车辆已在场内' });

    await pool.query(
      'INSERT INTO parking_records (plate, type, entry_time, nev, status) VALUES (?, ?, NOW(), ?, 1)',
      [plate, type || 'car', nev ? 1 : 0]
    );
    res.json({ ok: true, msg: plate + ' 入场成功' });
  } catch (e) {
    res.json({ ok: false, msg: '服务器错误: ' + e.message });
  }
});

// ===== 查询在场车辆 =====
app.get('/api/active', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, plate, type, entry_time, nev FROM parking_records WHERE status = 1 ORDER BY entry_time DESC'
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.json({ ok: false, data: [] });
  }
});

// ===== 车辆离场（计算费用） =====
app.post('/api/checkout', async (req, res) => {
  try {
    const { plate } = req.body;
    const [rows] = await pool.query(
      'SELECT id, plate, type, entry_time, nev FROM parking_records WHERE plate = ? AND status = 1', [plate]
    );
    if (rows.length === 0) return res.json({ ok: false, msg: '未找到该在场车辆' });

    const rec = rows[0];
    const [sRows] = await pool.query('SELECT * FROM parking_settings WHERE id = 1');
    const s = sRows[0] || {};
    const rateMap = {
      car: { rate: Number(s.car_rate) || 5, add: Number(s.car_add) || 3, cap: Number(s.car_cap) || 30 },
      suv: { rate: Number(s.suv_rate) || 6, add: Number(s.suv_add) || 4, cap: Number(s.suv_cap) || 35 },
      truck: { rate: Number(s.truck_rate) || 10, add: Number(s.truck_add) || 6, cap: Number(s.truck_cap) || 50 },
      motor: { rate: Number(s.motor_rate) || 2, add: Number(s.motor_add) || 1, cap: Number(s.motor_cap) || 10 }
    };
    const dayMul = Number(s.day_rate) || 1;
    const nightMul = Number(s.night_rate) || 0.5;
    const dayStart = s.day_start != null ? Number(s.day_start) : 8;
    const dayEnd = s.day_end != null ? Number(s.day_end) : 20;
    const freeMin = s.free_min != null ? Number(s.free_min) : 30;

    const now = new Date();
    const entry = new Date(rec.entry_time);
    const totalMin = Math.max(0, (now - entry) / 60000);

    if (totalMin <= freeMin) {
      return res.json({ ok: true, data: { ...rec, fee: 0, hours: totalMin / 60, exitTime: now.toISOString() } });
    }

    // count hours in day vs night periods
    let dayHrs = 0, nightHrs = 0;
    let cur = new Date(entry);
    while (cur < now) {
      const hr = cur.getHours();
      const isNight = (hr >= dayEnd || hr < dayStart);
      // find end of current period
      let periodEnd = new Date(cur);
      if (isNight) {
        periodEnd.setHours(dayStart, 0, 0, 0);
        if (periodEnd <= cur) periodEnd.setDate(periodEnd.getDate() + 1);
      } else {
        periodEnd.setHours(dayEnd, 0, 0, 0);
      }
      const segEnd = periodEnd < now ? periodEnd : now;
      const segHrs = (segEnd - cur) / 3600000;
      if (isNight) nightHrs += segHrs; else dayHrs += segHrs;
      cur = segEnd;
    }

    const vt = rateMap[rec.type] || rateMap.car;
    // first hour at full blended rate
    const blendedRate = (dayHrs * dayMul + nightHrs * nightMul) / Math.max(dayHrs + nightHrs, 0.01);
    const totalHrs = dayHrs + nightHrs;
    const effectiveFirstRate = vt.rate * blendedRate;
    const effectiveAddRate = vt.add * blendedRate;

    let fee = 0;
    if (totalHrs <= 1) fee = effectiveFirstRate;
    else fee = Math.min(effectiveFirstRate + Math.ceil(totalHrs - 1) * effectiveAddRate, vt.cap);

    res.json({ ok: true, data: { ...rec, fee, hours: totalHrs, exitTime: now.toISOString(), dayHrs, nightHrs } });
  } catch (e) {
    res.json({ ok: false, msg: '服务器错误: ' + e.message });
  }
});

// ===== 确认付款离场 =====
function toMySQLTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

app.post('/api/confirm', async (req, res) => {
  try {
    const { plate, fee, exitTime } = req.body;
    const [rows] = await pool.query(
      'SELECT * FROM parking_records WHERE plate = ? AND status = 1', [plate]
    );
    if (rows.length === 0) return res.json({ ok: false, msg: '记录不存在' });

    const rec = rows[0];
    const et = toMySQLTime(exitTime || new Date().toISOString());
    await pool.query('UPDATE parking_records SET status = 0, exit_time = ?, fee = ? WHERE id = ?',
      [et, fee, rec.id]);

    await pool.query(
      'INSERT INTO parking_history (plate, type, entry_time, exit_time, fee, nev) VALUES (?, ?, ?, ?, ?, ?)',
      [rec.plate, rec.type, rec.entry_time, et, fee, rec.nev]
    );
    res.json({ ok: true, msg: rec.plate + ' 已收款 ¥' + Number(fee).toFixed(2) + '，放行！' });
  } catch (e) {
    res.json({ ok: false, msg: '服务器错误: ' + e.message });
  }
});

// ===== 统计接口 =====
app.get('/api/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [[{ todayIn }]] = await pool.query(
      `SELECT COUNT(*) AS todayIn FROM (
        SELECT id FROM parking_records WHERE DATE(entry_time)=? UNION ALL
        SELECT id FROM parking_history WHERE DATE(entry_time)=?
      ) t`, [today, today]
    );
    const [[{ todayOut }]] = await pool.query(
      'SELECT COUNT(*) AS todayOut FROM parking_history WHERE DATE(exit_time)=?', [today]
    );
    const [active] = await pool.query('SELECT COUNT(*) AS cnt FROM parking_records WHERE status=1');
    const [[{ todayFee }]] = await pool.query(
      'SELECT COALESCE(SUM(fee),0) AS todayFee FROM parking_history WHERE DATE(exit_time)=?', [today]
    );
    const [[{ yesterdayFee }]] = await pool.query(
      'SELECT COALESCE(SUM(fee),0) AS yesterdayFee FROM parking_history WHERE DATE(exit_time)=?', [yesterday]
    );
    const [[{ totalCars }]] = await pool.query(
      'SELECT COUNT(*) AS totalCars FROM parking_history'
    );
    const [[{ totalFee }]] = await pool.query(
      'SELECT COALESCE(SUM(fee),0) AS totalFee FROM parking_history'
    );
    const [[{ avgDur }]] = await pool.query(
      'SELECT COALESCE(ROUND(AVG(TIMESTAMPDIFF(MINUTE, entry_time, exit_time))),0) AS avgDur FROM parking_history'
    );

    res.json({
      ok: true,
      data: {
        todayIn, todayOut, parkingNow: active[0].cnt, todayFee, yesterdayFee,
        totalCars, totalFee, avgDur
      }
    });
  } catch (e) {
    res.json({ ok: false, data: {} });
  }
});

// ===== 费率设置 =====
app.get('/api/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM parking_settings WHERE id = 1');
    res.json({ ok: true, data: rows[0] || {} });
  } catch (e) {
    res.json({ ok: false, data: {} });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { car_rate, car_add, car_cap, suv_rate, suv_add, suv_cap, truck_rate, truck_add, truck_cap, motor_rate, motor_add, motor_cap, free_min, day_rate, night_rate, day_start, day_end } = req.body;
    await pool.query(
      `UPDATE parking_settings SET car_rate=?, car_add=?, car_cap=?, suv_rate=?, suv_add=?, suv_cap=?,
       truck_rate=?, truck_add=?, truck_cap=?, motor_rate=?, motor_add=?, motor_cap=?, free_min=?,
       day_rate=?, night_rate=?, day_start=?, day_end=? WHERE id=1`,
      [car_rate, car_add, car_cap, suv_rate, suv_add, suv_cap, truck_rate, truck_add, truck_cap, motor_rate, motor_add, motor_cap, free_min, day_rate, night_rate, day_start, day_end]
    );
    res.json({ ok: true, msg: '费率已更新' });
  } catch (e) {
    res.json({ ok: false, msg: '保存失败: ' + e.message });
  }
});

// ===== 历史记录 =====
app.get('/api/history', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT plate, type, entry_time, exit_time, fee, nev FROM parking_history ORDER BY exit_time DESC LIMIT 200'
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.json({ ok: true, data: [] });
  }
});

// ===== 收费趋势 =====
app.get('/api/chart', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const ds = d.toISOString().slice(0, 10);
      const [[row]] = await pool.query(
        'SELECT COALESCE(SUM(fee),0) AS fee, COUNT(*) AS cnt FROM parking_history WHERE DATE(exit_time)=?', [ds]
      );
      data.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), fee: row.fee, count: row.cnt });
    }
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: true, data: [] });
  }
});

// ===== 车型分布 =====
app.get('/api/type-dist', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT type, COUNT(*) AS cnt, COALESCE(SUM(fee),0) AS total_fee FROM parking_history GROUP BY type'
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.json({ ok: true, data: [] });
  }
});

// ===== 繁忙时段 =====
app.get('/api/peak-hours', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT HOUR(entry_time) AS hr, COUNT(*) AS cnt FROM parking_history GROUP BY HOUR(entry_time) ORDER BY hr'
    );
    const hours = new Array(24).fill(0);
    rows.forEach(r => { hours[r.hr] = r.cnt; });
    res.json({ ok: true, data: hours });
  } catch (e) {
    res.json({ ok: true, data: new Array(24).fill(0) });
  }
});

const PORT = 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`服务已启动: http://localhost:${PORT}`));
}).catch(err => {
  console.error('数据库连接失败:', err.message);
  process.exit(1);
});
