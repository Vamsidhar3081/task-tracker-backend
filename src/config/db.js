import dotenv from "dotenv";
dotenv.config();

import mysql from "mysql2/promise";

export const db = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: process.env.MYSQLPORT,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,

  ssl: {
    rejectUnauthorized: false,
  },

  waitForConnections: true,
  connectionLimit: 10,
});

export default db;