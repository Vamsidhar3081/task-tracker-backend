import { db } from "../config/db.js";
import { cosine } from "./embeddings.js";

export const upsertTaskEmbedding = async ({ taskId, assignedTo, content, embedding }) => {
  await db.query(
    `INSERT INTO task_embeddings (task_id, assigned_to, content, embedding) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE assigned_to = VALUES(assigned_to), content = VALUES(content), embedding = VALUES(embedding)`,
    [taskId, assignedTo, content, JSON.stringify(embedding)]
  );
};

export const deleteTaskEmbedding = async (taskId) => {
  await db.query("DELETE FROM task_embeddings WHERE task_id = ?", [taskId]);
};

export const searchSimilar = async (queryEmbedding, { ownerId = null, count = 8 } = {}) => {
  const values = [];
  let where = "";
  if (ownerId) {
    where = "WHERE assigned_to = ?";
    values.push(ownerId);
  }
  const [rows] = await db.query(`SELECT task_id, content, embedding FROM task_embeddings ${where}`, values);

  return rows
    .map((r) => ({
      task_id: r.task_id,
      content: r.content,
      similarity: cosine(queryEmbedding, typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, count);
};