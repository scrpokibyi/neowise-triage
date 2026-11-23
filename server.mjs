import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });
const INVALID_INPUT = Object.freeze({ status: "invalid_input" });

const html = await readFile(new URL("./index.html", import.meta.url));
const uiScript = await readFile(new URL("./ui.mjs", import.meta.url));

class InvalidInputError extends Error {}

class ModelTimeoutError extends Error {
  name = "ModelTimeoutError";
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/** Читает тело запроса и возвращает непустой текст заявки или бросает InvalidInputError. */
async function readTicketText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInputError("body_too_large");
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInputError("bad_json");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidInputError("not_an_object");
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    throw new InvalidInputError("empty_or_not_string");
  }
  return body.text;
}

/**
 * Вызывает модель и ждёт не дольше timeoutMs.
 * Сигнал отменяет запрос к модели, а Promise.race гарантирует лимит,
 * даже если модель сигнал игнорирует.
 */
async function callModel(model, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ModelTimeoutError(`Model did not respond in ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });

  const call = Promise.resolve().then(() => model(text, { signal: controller.signal }));
  call.catch(() => {}); // ответ, пришедший после таймаута, нам уже не нужен

  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Проверяет сырой ответ модели. HTTP 200 от модели ещё не значит, что результат годный. */
export function validateModelOutput(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_json" };
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "not_an_object" };
  }
  if (!TOPICS.has(data.topic)) return { ok: false, reason: "unknown_topic" };
  if (typeof data.draft !== "string" || data.draft.trim() === "") {
    return { ok: false, reason: "empty_draft" };
  }
  return { ok: true, topic: data.topic, draft: data.draft.trim() };
}

/** Разбор заявки: либо готовый результат, либо ручной разбор с причиной для логов. */
export async function triage(text, { model = classify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  let raw;
  try {
    raw = await callModel(model, text, timeoutMs);
  } catch (error) {
    const reason = error instanceof ModelTimeoutError ? "timeout" : "model_error";
    return { body: MANUAL_REVIEW, reason };
  }

  const checked = validateModelOutput(raw);
  if (!checked.ok) return { body: MANUAL_REVIEW, reason: checked.reason };
  return { body: { status: "ready", topic: checked.topic, draft: checked.draft } };
}

export function createApp({
  model = classify,
  timeoutMs = MODEL_TIMEOUT_MS,
  log = (event) => console.warn(JSON.stringify(event)),
} = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/ui.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(uiScript);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }

    try {
      const text = await readTicketText(request);
      const { body, reason } = await triage(text, { model, timeoutMs });
      if (reason) log({ event: "triage_manual_review", reason });
      return json(response, 200, body);
    } catch (error) {
      if (error instanceof InvalidInputError) return json(response, 400, INVALID_INPUT);
      log({ event: "triage_server_error", message: error.message });
      return json(response, 500, { status: "server_error" });
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Сервер запущен: http://127.0.0.1:${port}`);
  });
}
