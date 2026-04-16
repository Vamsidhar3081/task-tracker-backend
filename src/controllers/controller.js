import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../config/db.js";

const mapTask = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  feedback_date: row.feedback_date,
  completed_at: row.completed_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
  created_by: row.created_by,
  assigned_to: row.assigned_to,
  creator_name: row.creator_name,
  assignee_name: row.assignee_name,
  is_overdue: row.is_overdue,
});

const ensureAssignableUser = async (assignedTo) => {
  const [users] = await db.query(
    "SELECT id, role FROM users WHERE id = ?",
    [assignedTo]
  );

  if (users.length === 0) {
    throw new Error("Assigned user not found");
  }

  if (users[0].role !== "USER") {
    throw new Error("Tasks can only be assigned to USER accounts");
  }
};

const buildTaskScope = (req, values) => {
  if (req.user.role === "ADMIN") {
    return "WHERE t.is_deleted = 0";
  }

  values.push(req.user.id);
  return "WHERE t.assigned_to = ? AND t.is_deleted = 0";
};

const setCompletedColumns = (status) => {
  if (status === "COMPLETED") {
    return "completed_at = NOW()";
  }

  return "completed_at = NULL";
};

export const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const [existing] = await db.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, 'USER')",
      [name, email, hashed]
    );

    return res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const createUser = async (req, res) => {
  try {
    const { name, email, password, role = "USER" } = req.body;

    const [existing] = await db.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [name, email, hashed, role]
    );

    return res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const getUsers = async (_req, res) => {
  try {
    const [users] = await db.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.role,
         u.created_at,
         COUNT(CASE WHEN t.is_deleted = 0 THEN 1 END) AS total_tasks,
         COUNT(CASE WHEN t.is_deleted = 0 AND t.status = 'ONGOING' THEN 1 END) AS ongoing_tasks
       FROM users u
       LEFT JOIN tasks t ON t.assigned_to = u.id
       WHERE u.role = 'USER'
       GROUP BY u.id, u.name, u.email, u.role, u.created_at
       ORDER BY u.created_at DESC`
    );

    return res.json({ users });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const deleteUser = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.params.userId);

    if (Number.isNaN(userId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    const [users] = await connection.query(
      "SELECT id, role FROM users WHERE id = ?",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (users[0].role === "ADMIN") {
      return res.status(400).json({ message: "Admin accounts cannot be deleted" });
    }

    await connection.beginTransaction();

    const [tasks] = await connection.query(
      "SELECT id FROM tasks WHERE created_by = ? OR assigned_to = ?",
      [userId, userId]
    );

    const taskIds = tasks.map((task) => task.id);

    if (taskIds.length > 0) {
      await connection.query(
        `DELETE FROM task_delays WHERE task_id IN (${taskIds.map(() => "?").join(",")})`,
        taskIds
      );

      await connection.query(
        "DELETE FROM tasks WHERE created_by = ? OR assigned_to = ?",
        [userId, userId]
      );
    }

    await connection.query("DELETE FROM users WHERE id = ?", [userId]);
    await connection.commit();

    return res.json({ message: "User deleted successfully" });
  } catch (err) {
    await connection.rollback();
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  } finally {
    connection.release();
  }
};

export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.query(
      "SELECT id, name, email, role, password_hash FROM users WHERE email = ?",
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = users[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    return res.json({
      token,
      role: user.role,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const createTask = async (req, res) => {
  try {
    const { title, description, feedback_date, status = "ONGOING", assignedTo } = req.body;
    const creatorId = req.user.id;

    let assigneeId = creatorId;

    if (req.user.role === "ADMIN" && assignedTo) {
      await ensureAssignableUser(assignedTo);
      assigneeId = assignedTo;
    }

    const [result] = await db.query(
      `INSERT INTO tasks
         (title, description, feedback_date, status, completed_at, created_by, assigned_to)
       VALUES (?, ?, ?, ?, ${status === "COMPLETED" ? "NOW()" : "NULL"}, ?, ?)`,
      [title, description, feedback_date, status, creatorId, assigneeId]
    );

    return res.status(201).json({
      message: "Task created successfully",
      taskId: result.insertId,
    });
  } catch (err) {
    const statusCode =
      err.message === "Assigned user not found" ||
      err.message === "Tasks can only be assigned to USER accounts"
        ? 400
        : 500;

    return res.status(statusCode).json({
      message: err.message || "Something went wrong",
    });
  }
};

export const getTasks = async (req, res) => {
  try {
    const { date, status, search, filter, assignedTo, page = 1, limit = 10 } = req.query;

    const pageNum = Math.max(parseInt(page, 10), 1);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    const offset = (pageNum - 1) * limitNum;

    const values = [];
    let baseSql = `
      FROM tasks t
      INNER JOIN users creator ON creator.id = t.created_by
      INNER JOIN users assignee ON assignee.id = t.assigned_to
    `;

    baseSql += ` ${buildTaskScope(req, values)}`;

    if (req.user.role === "ADMIN" && assignedTo) {
      baseSql += " AND t.assigned_to = ?";
      values.push(assignedTo);
    }

    if (status) {
      baseSql += " AND t.status = ?";
      values.push(status);
    }

    if (date) {
      baseSql += " AND t.created_at >= ? AND t.created_at < DATE_ADD(?, INTERVAL 1 DAY)";
      values.push(date, date);
    }

    if (search) {
      baseSql += " AND (t.title LIKE ? OR t.description LIKE ? OR assignee.name LIKE ?)";
      const keyword = `%${search}%`;
      values.push(keyword, keyword, keyword);
    }

    if (filter === "overdue") {
      baseSql += " AND t.status != 'COMPLETED' AND t.feedback_date < CURDATE()";
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total ${baseSql}`,
      values
    );

    const [task] = await db.query(
      `SELECT
         t.id,
         t.title,
         t.description,
         t.status,
         t.feedback_date,
         t.created_at,
         t.updated_at,
         t.created_by,
         t.assigned_to,
         creator.name AS creator_name,
         assignee.name AS assignee_name,
         CASE
           WHEN t.status != 'COMPLETED' AND t.feedback_date < CURDATE() THEN 1
           ELSE 0
         END AS is_overdue
       ${baseSql}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limitNum, offset]
    );

    return res.json({
      meta: {
        total: countRows[0].total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(countRows[0].total / limitNum) || 1,
      },
      task: task.map(mapTask),
    });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const updateTask = async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const { title, description, feedback_date, status, assignedTo } = req.body;

    if (Number.isNaN(taskId)) {
      return res.status(400).json({ message: "Invalid task id" });
    }

    const [tasks] = await db.query(
      `SELECT id, assigned_to
       FROM tasks
       WHERE id = ? AND is_deleted = 0`,
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (req.user.role !== "ADMIN" && tasks[0].assigned_to !== req.user.id) {
      return res.status(403).json({ message: "You cannot edit this task" });
    }

    const fields = [];
    const values = [];

    if (title !== undefined) {
      fields.push("title = ?");
      values.push(title);
    }

    if (description !== undefined) {
      fields.push("description = ?");
      values.push(description);
    }

    if (feedback_date !== undefined) {
      fields.push("feedback_date = ?");
      values.push(feedback_date);
    }

    if (status !== undefined) {
      fields.push("status = ?");
      values.push(status);
      fields.push(setCompletedColumns(status));
    }

    if (req.user.role === "ADMIN" && assignedTo !== undefined) {
      await ensureAssignableUser(assignedTo);
      fields.push("assigned_to = ?");
      values.push(assignedTo);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(taskId);
    await db.query(
      `UPDATE tasks
       SET ${fields.join(", ")}, updated_at = NOW()
       WHERE id = ? AND is_deleted = 0`,
      values
    );

    return res.json({ message: "Task updated successfully" });
  } catch (err) {
    const statusCode =
      err.message === "Assigned user not found" ||
      err.message === "Tasks can only be assigned to USER accounts"
        ? 400
        : 500;

    return res.status(statusCode).json({
      message: err.message || "Something went wrong",
    });
  }
};

export const delayTask = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const taskId = Number(req.params.taskId);
    const { reason, newDate } = req.body;

    const [tasks] = await connection.query(
      "SELECT id, feedback_date, status, assigned_to FROM tasks WHERE id = ? AND is_deleted = 0",
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    const task = tasks[0];

    if (req.user.role !== "ADMIN" && task.assigned_to !== req.user.id) {
      return res.status(403).json({ message: "You cannot delay this task" });
    }

    if (task.status === "COMPLETED") {
      return res.status(400).json({ message: "Cannot delay a completed task" });
    }

    if (!task.feedback_date) {
      return res.status(400).json({ message: "Cannot delay a task without a feedback date" });
    }

    if (new Date(newDate) <= new Date(task.feedback_date)) {
      return res.status(400).json({ message: "New date must be greater than current feedback date" });
    }

    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO task_delays (task_id, old_date, new_date, reason)
       VALUES (?, ?, ?, ?)`,
      [taskId, task.feedback_date, newDate, reason]
    );

    await connection.query(
      `UPDATE tasks
       SET status = 'DELAYED', feedback_date = ?, completed_at = NULL, updated_at = NOW()
       WHERE id = ? AND is_deleted = 0`,
      [newDate, taskId]
    );

    await connection.commit();
    return res.json({ message: "Task delayed successfully" });
  } catch (err) {
    await connection.rollback();
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  } finally {
    connection.release();
  }
};

export const completeTask = async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const [tasks] = await db.query(
      "SELECT id, status, assigned_to FROM tasks WHERE id = ? AND is_deleted = 0",
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    const task = tasks[0];

    if (req.user.role !== "ADMIN" && task.assigned_to !== req.user.id) {
      return res.status(403).json({ message: "You cannot complete this task" });
    }

    if (task.status === "COMPLETED") {
      return res.status(400).json({ message: "Task is already completed" });
    }

    await db.query(
      `UPDATE tasks
       SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
       WHERE id = ? AND is_deleted = 0`,
      [taskId]
    );

    return res.json({ message: "Task completed successfully" });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const deleteTask = async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);

    if (Number.isNaN(taskId)) {
      return res.status(400).json({ message: "Invalid task id" });
    }

    const [tasks] = await db.query(
      "SELECT id, assigned_to FROM tasks WHERE id = ? AND is_deleted = 0",
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (req.user.role !== "ADMIN" && tasks[0].assigned_to !== req.user.id) {
      return res.status(403).json({ message: "You cannot delete this task" });
    }

    await db.query(
      `UPDATE tasks
       SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [taskId]
    );

    return res.json({ message: "Task deleted successfully" });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};

export const getTaskById = async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);

    if (Number.isNaN(taskId)) {
      return res.status(400).json({ message: "Invalid task id" });
    }

    const [tasks] = await db.query(
      `SELECT
         t.id,
         t.title,
         t.description,
         t.feedback_date,
         t.status,
         t.completed_at,
         t.created_at,
         t.updated_at,
         t.created_by,
         t.assigned_to,
         creator.name AS creator_name,
         assignee.name AS assignee_name,
         CASE
           WHEN t.status != 'COMPLETED' AND t.feedback_date < CURDATE() THEN 1
           ELSE 0
         END AS is_overdue
       FROM tasks t
       INNER JOIN users creator ON creator.id = t.created_by
       INNER JOIN users assignee ON assignee.id = t.assigned_to
       WHERE t.id = ? AND t.is_deleted = 0`,
      [taskId]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    const task = tasks[0];

    if (req.user.role !== "ADMIN" && task.assigned_to !== req.user.id) {
      return res.status(403).json({ message: "You cannot view this task" });
    }

    const [delays] = await db.query(
      `SELECT id, old_date, new_date, reason, created_at
       FROM task_delays
       WHERE task_id = ?
       ORDER BY created_at DESC`,
      [taskId]
    );

    return res.json({
      ...mapTask(task),
      delay_count: delays.length,
      delays,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Something went wrong",
      error: err.message,
    });
  }
};
