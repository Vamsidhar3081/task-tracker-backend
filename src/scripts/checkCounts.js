import { db } from "../config/db.js";

const [[row]] = await db.query(`
  SELECT
    COUNT(*) AS total_tasks,
    COALESCE(SUM(status = 'COMPLETED'), 0) AS completed_tasks,
    COALESCE(SUM(status = 'DELAYED'), 0) AS delayed_tasks,
    COALESCE(SUM(status = 'ONGOING'), 0) AS ongoing_tasks,
    COALESCE(SUM(status != 'COMPLETED' AND feedback_date < CURDATE()), 0) AS overdue_tasks
  FROM tasks
  WHERE is_deleted = 0
`);

console.table([row]);
process.exit(0);