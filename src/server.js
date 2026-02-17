import dotenv from "dotenv";
dotenv.config();

import app from "./app.js";
import { db } from "./config/db.js";

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

(async () => {
  try {
    const [rows] = await db.query("SELECT 1");
    console.log("✅ Database connected:", rows);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
})();