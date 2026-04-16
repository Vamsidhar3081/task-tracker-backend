import dotenv from "dotenv";
dotenv.config();

import app from "./app.js";
import { db } from "./config/db.js";

const PORT = process.env.PORT || 5000;

// ✅ Start server ONLY after DB is verified
const startServer = async () => {
  try {
    const [rows] = await db.query("SELECT 1");
    console.log("✅ Database connected");

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1); // 🔥 stop app if DB fails
  }
};

startServer();