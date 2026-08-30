import express from "express";
import { queryTasksWithAI } from "../controllers/ai.controller.js";
import { authMiddleware } from "../middlewares/middleware.js";
import { validateRequest } from "../middlewares/validateRequest.js";
import { aiTaskQuerySchema } from "../validators.js";

const router = express.Router();

router.post("/query", authMiddleware, validateRequest(aiTaskQuerySchema), queryTasksWithAI);

export default router;
