import dotenv from 'dotenv';
dotenv.config();

import mysql from "mysql2/promise";

export const db = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE
});
export default db;