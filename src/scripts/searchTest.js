import "dotenv/config";
import { embed } from "../services/embeddings.js";
import { searchSimilar } from "../services/vectorStore.js";

const question = process.argv.slice(2).join(" ");
const results = await searchSimilar(await embed(question), { count: 5 });
console.table(results.map((r) => ({ id: r.task_id, score: r.similarity.toFixed(3), content: r.content.slice(0, 80) })));
process.exit(0);