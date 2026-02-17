import bcrypt from "bcrypt";
import { db } from "../config/db.js";
import jwt from "jsonwebtoken";

export const registerUser = async (req, res) => {
    console.log("register api hitted");
    console.log("req.body", req.body);
    try {
        const { name, email, password } = req.body;

        const [existing] = await db.query("select id from users where email =?", [email]);

        console.log("existing", existing);
        if (existing.length > 0) {
            return res.status(400).json({ message: "User already exists" });
        }

        const hashed = await bcrypt.hash(password, 10);

        await db.query("insert into users(name,email,password_hash) values(?,?,?)", [name, email, hashed]);

        res.status(201).json({ message: "User registered successfully" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
}

export const loginUser = async (req, res) => {
    console.log("login hitted");
    try {
        const { email, password } = req.body;
        console.log("req.body", req.body);
        const [users] = await db.query("select id,password_hash from users where email = ?", [email]);
        console.log("users", users);
        if (users.length === 0) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        const user = users[0];
        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
            return res.status(401).json({ message: "Invalid credentials" });
        }
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
        res.json({ token });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
}

// export const createTask = async (req, res) => {
//     try {
//         const { title, description } = req.body;
//         const userId = req.user.id;
//         await db.query("insert into tasks(title,description,user_id) values(?,?,?)", [title, description, userId]);
//         res.status(201).json({ message: "Ticket created successfully" });
//     } catch (err) {
//         res.status(500).json({ message: "Something went wrong" });
//     }
// }

export const createTask = async (req, res) => {
    try {
        const { title, description, feedback_date, status } = req.body;
        const userId = req.user.id;

        let taskStatus = "ONGOING";
        let completedAt = null;

        if (status === "COMPLETED") {
            taskStatus = "COMPLETED";
            completedAt = new Date();
        }

        const [result] = await db.query(
            `INSERT INTO tasks 
       (title, description, user_id, feedback_date, status, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [title, description, userId, feedback_date, taskStatus, completedAt]
        );

        res.status(201).json({
            message: "Task created successfully",
            taskId: result.insertId
        });

    } catch (err) {
        res.status(500).json({
            message: "Something went wrong",
            error: err.message
        });
    }
};

export const getTasks = async (req, res) => {
    try {
        const userId = req.user.id;
        const { date, status, search, filter, page = 1, limit = 10 } = req.query;

        const pageNum = Math.max(parseInt(page, 10), 1);
        const limitNum = Math.min(parseInt(limit, 10), 100);
        const offset = (pageNum - 1) * limitNum;

        let baseSql = `from tasks where user_id=? and is_deleted=0`;
        const values = [userId];

        if (status) {
            baseSql += " and status=?";
            values.push(status);
        }

        if (date) {
            baseSql += " AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)";
            values.push(date, date);
        }

        if (search) {
            baseSql += " AND (title LIKE ? OR description LIKE ?)";
            const keyword = `%${search}%`;
            values.push(keyword, keyword);
        }

        if (filter === "overdue") {
            baseSql += " AND status != 'COMPLETED' AND feedback_date < CURDATE()";
        }

        const [countRows] = await db.query(`select count(*) as total ${baseSql}`, values);

        const total = countRows[0].total;

        const [task] = await db.query(`select id,title,description,status,created_at ,CASE WHEN status != 'COMPLETED' AND feedback_date < CURDATE() then 1 else 0 end as is_overdue ${baseSql} order by created_at desc limit ? offset ?`,
            [...values, limitNum, offset]);
        res.json({
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            },
            task
        });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
}

//update task
export const updateTask = async (req, res) => {
    try {
        const { taskId } = req.params;
        const userId = req.user.id;
        const { title, description } = req.body;

        const fields = [];
        const values = [];

        if (title != undefined) {
            fields.push("title=?");
            values.push(title)
        }
        if (description != undefined) {
            fields.push("description=?");
            values.push(description)
        }
        // if (status) {
        //     fields.push("status=?");
        //     values.push(status)
        // }
        if (fields.length === 0) {
            return res.status(400).json({ message: "No fields to update" });
        }
        values.push(taskId, userId);

        const [result] = await db.query(`update tasks set ${fields.join(",")} where id=? and user_id=? and is_deleted=0`, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Task not found" });
        }
        res.json({ message: "Task updated successfully" });
    }
    catch (err) {
        res.status(500).json({
            message: "Something went wrong",
            error: err.message
        });
    }
}

export const delayTask = async (req, res) => {
    const connection = await db.getConnection();

    try {
        const { taskId } = req.params;
        const userId = req.user.id;
        const { reason, newDate } = req.body;

        await connection.beginTransaction();

        // Check task belongs to user
        const [tasks] = await connection.query(
            "SELECT id, feedback_date , status FROM tasks WHERE id=? AND user_id=? and is_deleted=0",
            [taskId, userId]
        );

        if (tasks.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: "Task not found" });
        }

        if (tasks[0].status === "COMPLETED") {
            await connection.rollback();
            return res.status(400).json({
                message: "Cannot delay a completed task"
            });
        }

        if (!tasks[0].feedback_date) {
            await connection.rollback();
            return res.status(400).json({
                message: "Cannot delay a task without a feedback date"
            });
        }

        const oldDate = tasks[0].feedback_date;

        if (new Date(newDate) <= new Date(oldDate)) {
            await connection.rollback();
            return res.status(400).json({
                message: "New date must be greater than current feedback date"
            });
        }

        // Insert delay history
        await connection.query(
            `INSERT INTO task_delays 
       (task_id, old_date, new_date, reason) 
       VALUES (?, ?, ?, ?)`,
            [taskId, oldDate, newDate, reason]
        );

        // Update task
        await connection.query(
            `UPDATE tasks 
       SET status='DELAYED',
           feedback_date=?,
           updated_at=NOW()
       WHERE id=? AND user_id=? AND is_deleted=0`,
            [newDate, taskId, userId]
        );

        await connection.commit();

        res.json({ message: "Task delayed successfully" });

    } catch (err) {
        await connection.rollback();
        res.status(500).json({
            message: "Something went wrong",
            error: err.message
        });
    } finally {
        connection.release();
    }
};

export const completeTask = async (req, res) => {
    console.log("1st log",req.body);
    try {
        const { taskId } = req.params;
        const userId = req.user.id;

        // Check task exists & belongs to user
        const [tasks] = await db.query(
            "SELECT id, status FROM tasks WHERE id=? AND user_id=? and is_deleted=0",
            [taskId, userId]
        );

        if (tasks.length === 0) {
            return res.status(404).json({ message: "Task not found" });
        }

        if (tasks[0].status === "COMPLETED") {
            return res.status(400).json({
                message: "Task is already completed"
            });
        }

        await db.query(
            `UPDATE tasks 
       SET status='COMPLETED', 
           completed_at=NOW(), 
           updated_at=NOW()
       WHERE id=? AND user_id=? AND is_deleted=0`,
            [taskId, userId]
        );

        res.json({ message: "Task completed successfully" });

    } catch (err) {
        res.status(500).json({
            message: "Something went wrong",
            error: err.message
        });
    }
};

export const deleteTask = async (req, res) => {
    try {
        const { taskId } = req.params;
        const userId = req.user.id;

        if (isNaN(taskId)) {
            return res.status(400).json({ message: "Invalid taskId" });
        }

        const [result] = await db.query(
            `UPDATE tasks 
       SET is_deleted = TRUE ,
           updated_at = NOW(),
           deleted_at = NOW()
       WHERE id = ? AND user_id = ? AND is_deleted = 0`,
            [taskId, userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Task not found" });
        }

        return res.status(200).json({
            message: "Task deleted successfully"
        });

    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getTaskById = async (req, res) => {
    try {
        const { taskId } = req.params;
        const userId = req.user.id;

        if (isNaN(taskId)) {
            return res.status(400).json({ message: "Invalid taskId" });
        }

        const [tasks] = await db.query(
            `select id,title,description,feedback_date,status,created_at,updated_at ,CASE when status != 'COMPLETED' and feedback_date < CURDATE() then 1 else 0 end as is_overdue from tasks where id=? and user_id=? and is_deleted=0`,
            [taskId, userId]);

        if (tasks.length === 0) {
            return res.status(404).json({ message: "Task not found" });
        }

        const task = tasks[0];

        const [delays] = await db.query(
            `select id,old_date,new_date,reason,created_at from task_delays where task_id=? order by created_at desc`,
            [taskId]);

        res.json({
            ...task,
            delay_count: delays.length,
            delays
        });

    } catch (err) {
        res.status(500).json({
            message: "Something went wrong",
            error: err.message
        });
    }
}