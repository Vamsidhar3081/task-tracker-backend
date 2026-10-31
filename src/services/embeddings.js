import { pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";

let extractor;

export const embed = async (text) => {
  extractor ??= await pipeline("feature-extraction", MODEL);
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
};

// vectors are normalized, so the dot product equals cosine similarity
export const cosine = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
};