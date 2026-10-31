import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.router.js';
import aiRoutes from './routes/ai.router.js';

const app = express();


app.use(
  cors({
    origin:  [
    "http://localhost:5173",
    "https://task-tracker-9b99.vercel.app"
  ],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  })
);
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/ai", aiRoutes);


export default app;