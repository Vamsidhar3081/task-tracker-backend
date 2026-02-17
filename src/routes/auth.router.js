import { authMiddleware } from "../middlewares/middleware.js";
import { registerUser, loginUser,createTask,getTasks,updateTask,delayTask,completeTask,deleteTask,getTaskById} from "../controllers/controller.js";
import express from "express";
import {registerSchema,loginSchema,createTasksSchema,updateTasksSchema,delayTaskSchema} from "../validators.js";
import { validateRequest } from "../middlewares/validateRequest.js";

const app = express();

const router = express.Router();
app.get("/me",authMiddleware,(req,res)=>{
    res.json({userId:req.user.id});
});

router.post("/register",validateRequest(registerSchema), registerUser);
router.post("/login",validateRequest(loginSchema), loginUser);
router.post("/createtask",authMiddleware,validateRequest(createTasksSchema), createTask);
router.get("/gettasks",authMiddleware, getTasks);
router.put("/updateticket/:taskId",authMiddleware,validateRequest(updateTasksSchema), updateTask);
router.post("/tasks/:taskId/delay",authMiddleware,validateRequest(delayTaskSchema),delayTask);
router.patch("/tasks/:taskId/complete",authMiddleware,completeTask);
router.get("/tasks/:taskId", authMiddleware, getTaskById);
router.delete("/tasks/:taskId",authMiddleware, deleteTask);

export default router;