import "dotenv/config";
import { db } from "../config/db.js";
import { embed } from "../services/embeddings.js";
import { upsertTaskEmbedding } from "../services/vectorStore.js";

const [tasks] = await db.query(
  `SELECT t.id, t.assigned_to, t.title, t.description
   FROM tasks t
   WHERE t.is_deleted = 0`
);
console.log("tasks found:", tasks.length);

for (const t of tasks) {
  const content = [t.title, t.description].filter(Boolean).join(". ");
  await upsertTaskEmbedding({
    taskId: t.id,
    assignedTo: t.assigned_to,
    content,
    embedding: await embed(content),
  });
  console.log("embedded:", t.id, t.title);
}
process.exit(0);