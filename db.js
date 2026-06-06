const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  port: 3307,
  user: 'root',
  password: '147258',
  database: 'tcsf_parking',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

async function initDB() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: '147258'
  });
  await conn.query('CREATE DATABASE IF NOT EXISTS tcsf_parking CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await conn.end();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS parking_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plate VARCHAR(10) NOT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'car',
      entry_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      exit_time DATETIME NULL,
      fee DECIMAL(10,2) NOT NULL DEFAULT 0,
      nev TINYINT(1) NOT NULL DEFAULT 0,
      status TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=在场 0=已离场',
      INDEX idx_plate (plate),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS parking_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plate VARCHAR(10) NOT NULL,
      type VARCHAR(20) NOT NULL,
      entry_time DATETIME NOT NULL,
      exit_time DATETIME NOT NULL,
      fee DECIMAL(10,2) NOT NULL DEFAULT 0,
      nev TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_exit_time (exit_time),
      INDEX idx_plate (plate)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS parking_settings (
      id INT PRIMARY KEY DEFAULT 1,
      car_rate DECIMAL(10,2) NOT NULL DEFAULT 5,
      car_add DECIMAL(10,2) NOT NULL DEFAULT 3,
      car_cap DECIMAL(10,2) NOT NULL DEFAULT 30,
      suv_rate DECIMAL(10,2) NOT NULL DEFAULT 6,
      suv_add DECIMAL(10,2) NOT NULL DEFAULT 4,
      suv_cap DECIMAL(10,2) NOT NULL DEFAULT 35,
      truck_rate DECIMAL(10,2) NOT NULL DEFAULT 10,
      truck_add DECIMAL(10,2) NOT NULL DEFAULT 6,
      truck_cap DECIMAL(10,2) NOT NULL DEFAULT 50,
      motor_rate DECIMAL(10,2) NOT NULL DEFAULT 2,
      motor_add DECIMAL(10,2) NOT NULL DEFAULT 1,
      motor_cap DECIMAL(10,2) NOT NULL DEFAULT 10,
      free_min INT NOT NULL DEFAULT 30,
      day_rate DECIMAL(3,2) NOT NULL DEFAULT 1.0 COMMENT '白天费率倍率',
      night_rate DECIMAL(3,2) NOT NULL DEFAULT 0.5 COMMENT '夜间费率倍率',
      day_start INT NOT NULL DEFAULT 8 COMMENT '白天开始小时',
      day_end INT NOT NULL DEFAULT 20 COMMENT '白天结束小时',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`INSERT IGNORE INTO parking_settings (id) VALUES (1)`);
  // add new columns if upgrading from old schema
  try { await pool.query('ALTER TABLE parking_settings ADD COLUMN day_rate DECIMAL(3,2) NOT NULL DEFAULT 1.0'); } catch (e) {}
  try { await pool.query('ALTER TABLE parking_settings ADD COLUMN night_rate DECIMAL(3,2) NOT NULL DEFAULT 0.5'); } catch (e) {}
  try { await pool.query('ALTER TABLE parking_settings ADD COLUMN day_start INT NOT NULL DEFAULT 8'); } catch (e) {}
  try { await pool.query('ALTER TABLE parking_settings ADD COLUMN day_end INT NOT NULL DEFAULT 20'); } catch (e) {}

  console.log('数据库初始化完成');
}

module.exports = { pool, initDB };
