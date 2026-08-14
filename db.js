// MySQL connection (Hostinger's database) + the single table this app needs.
// Uses mysql2 with `dateStrings` so datetimes come back as plain
// 'YYYY-MM-DD HH:MM:SS' strings — we treat all times as Irish local time and
// never do timezone conversion, which keeps everything simple.

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      service_id  INT NOT NULL,
      format      VARCHAR(20) NOT NULL,
      starts_at   DATETIME NOT NULL,
      ends_at     DATETIME NOT NULL,
      status      VARCHAR(20) NOT NULL DEFAULT 'pending',
      name        VARCHAR(160) NOT NULL,
      email       VARCHAR(200) NOT NULL,
      phone       VARCHAR(40) NULL,
      referrer    VARCHAR(200) NULL,
      notes       TEXT NULL,
      token       VARCHAR(64) NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_starts (starts_at),
      INDEX idx_status (status),
      INDEX idx_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

module.exports = { pool, init };
