import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const defaultEnvPath = path.join(rootDir, ".env");
const managedSettingKeys = new Set([
  "DASHSCOPE_API_KEY",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
  "ALIYUN_TTS_MODEL",
]);

export async function loadLocalEnv({ filePath = defaultEnvPath, env = process.env } = {}) {
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

export async function readPublicSettings({ filePath = defaultEnvPath, env = process.env } = {}) {
  const fileValues = await readEnvFileValues(filePath);
  const values = { ...fileValues };
  for (const key of managedSettingKeys) {
    if (env[key] !== undefined) values[key] = env[key];
  }

  return {
    providers: {
      dashscope: providerStatus("阿里 DashScope", values.DASHSCOPE_API_KEY),
      pexels: providerStatus("Pexels 素材库", values.PEXELS_API_KEY),
      pixabay: providerStatus("Pixabay 素材库", values.PIXABAY_API_KEY),
    },
    ttsModel: values.ALIYUN_TTS_MODEL || "",
    envPath: ".env",
    writable: true,
  };
}

export async function saveLocalSettings({ filePath = defaultEnvPath, env = process.env, updates = {}, clear = [] } = {}) {
  const existing = await readRawEnv(filePath);
  const lines = existing ? existing.split(/\r?\n/) : [];
  const values = parseEnv(existing);
  const clearSet = new Set(clear);

  for (const key of managedSettingKeys) {
    if (clearSet.has(key)) {
      delete values[key];
      delete env[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    const value = String(updates[key] || "").trim();
    if (!value) continue;
    values[key] = value;
    env[key] = value;
  }

  const next = serializeEnv(lines, values);
  await writeFile(filePath, next, "utf8");
  return readPublicSettings({ filePath, env });
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

async function readEnvFileValues(filePath) {
  const content = await readRawEnv(filePath);
  return parseEnv(content);
}

async function readRawEnv(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function serializeEnv(lines, values) {
  const seen = new Set();
  const output = [];
  for (const rawLine of lines) {
    const separator = rawLine.indexOf("=");
    const key = separator > 0 ? rawLine.slice(0, separator).trim() : "";
    if (!managedSettingKeys.has(key)) {
      output.push(rawLine);
      continue;
    }
    seen.add(key);
    if (values[key]) output.push(`${key}=${values[key]}`);
  }

  for (const key of managedSettingKeys) {
    if (!seen.has(key) && values[key]) output.push(`${key}=${values[key]}`);
  }

  return `${output.filter((line, index, array) => line || index < array.length - 1).join("\n")}\n`;
}

function providerStatus(label, value) {
  const text = String(value || "");
  return {
    configured: Boolean(text),
    masked: text ? `****${text.slice(-4)}` : "",
    label,
  };
}
