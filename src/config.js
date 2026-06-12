import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export async function loadLocalEnv({ filePath = path.join(rootDir, ".env"), env = process.env } = {}) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { loaded: false, values: {} };
    throw error;
  }

  const values = parseEnv(content);
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  return { loaded: true, values };
}

export function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const value = stripQuotes(line.slice(separator + 1).trim());
    if (isPlaceholderValue(value)) continue;
    values[key] = value;
  }
  return values;
}

function stripQuotes(value) {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\\"", "\"");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isPlaceholderValue(value) {
  return /^your[_-]/i.test(value) || /^你的/.test(value);
}
