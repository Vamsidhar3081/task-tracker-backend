import "dotenv/config";
import { db } from "../config/db.js";

const [cols] = await db.query("SHOW COLUMNS FROM tasks");
const typeOf = (name) => cols.find((c) => c.Field === name)?.Type;

const idType = typeOf("id");
const assignedType = typeOf("assigned_to");
console.log({ idType, assignedType });

if (!idType || !assignedType) {
  console.error("Could not find the id or assigned_to column in the tasks table.");
  process.exit(1);
}

await db.query(`
  CREATE TABLE IF NOT EXISTS task_embeddings (
    task_id ${idType} PRIMARY KEY,
    assigned_to ${assignedType} NOT NULL,
    content TEXT NOT NULL,
    embedding JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
`);

console.log("task_embeddings table is ready");
process.exit(0);