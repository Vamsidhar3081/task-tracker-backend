import express from "express";
import {
  authMiddleware,
  requireAdmin,
} from "../middlewares/middleware.js";
import {
  completeTask,
  createTask,
  createUser,
  deleteTask,
  deleteUser,
  delayTask,
  getTaskById,
  getTasks,
  getUsers,
  loginUser,
  registerUser,
  updateTask,
} from "../controllers/controller.js";
import {
  createTasksSchema,
  createUserSchema,
  delayTaskSchema,
  loginSchema,
  registerSchema,
  updateTasksSchema,
} from "../validators.js";
import { validateRequest } from "../middlewares/validateRequest.js";

const router = express.Router();

router.get("/me", authMiddleware, (req, res) => {
  res.json(req.user);
});

router.post("/register", validateRequest(registerSchema), registerUser);
router.post("/login", validateRequest(loginSchema), loginUser);

router.get("/users", authMiddleware, requireAdmin, getUsers);
router.post("/users", authMiddleware, requireAdmin, validateRequest(createUserSchema), createUser);
router.delete("/users/:userId", authMiddleware, requireAdmin, deleteUser);

router.post("/createtask", authMiddleware, validateRequest(createTasksSchema), createTask);
router.get("/gettasks", authMiddleware, getTasks);
router.put("/updateticket/:taskId", authMiddleware, validateRequest(updateTasksSchema), updateTask);
router.post("/tasks/:taskId/delay", authMiddleware, validateRequest(delayTaskSchema), delayTask);
router.patch("/tasks/:taskId/complete", authMiddleware, completeTask);
router.get("/tasks/:taskId", authMiddleware, getTaskById);
router.delete("/tasks/:taskId", authMiddleware, deleteTask);

export default router;
