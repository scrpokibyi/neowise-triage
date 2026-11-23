import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { toView, render, MESSAGES } from "../ui.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function startServer(options = {}) {
  const server = createApp({ log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return { base, close };
}

function postRaw(base, rawBody) {
  return fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

const post = (base, body) => postRaw(base, JSON.stringify(body));

describe("POST /api/triage", () => {
  let app;
  before(async () => {
    app = await startServer();
  });
  after(() => app.close());

  describe("некорректный ввод → 400 invalid_input", () => {
    const cases = [
      ["битый JSON", "{not json"],
      ["пустое тело", ""],
      ["нет поля text", JSON.stringify({})],
      ["пустая строка", JSON.stringify({ text: "" })],
      ["только пробелы", JSON.stringify({ text: "   \n " })],
      ["text — число", JSON.stringify({ text: 42 })],
      ["text — null", JSON.stringify({ text: null })],
      ["тело — null", "null"],
      ["тело — массив", JSON.stringify([{ text: "доставка" }])],
      ["тело — строка", JSON.stringify("доставка")],
    ];

    for (const [name, rawBody] of cases) {
      test(name, async () => {
        const response = await postRaw(app.base, rawBody);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { status: "invalid_input" });
      });
    }
  });

  describe("корректный ответ модели → 200 ready", () => {
    const cases = [
      ["Когда будет доставка заказа?", "delivery"],
      ["Какая стоимость подписки?", "pricing"],
      ["Здравствуйте, вопрос по договору", "other"],
    ];

    for (const [text, topic] of cases) {
      test(`${topic}: «${text}»`, async () => {
        const response = await post(app.base, { text });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, "ready");
        assert.equal(body.topic, topic);
        assert.equal(typeof body.draft, "string");
        assert.notEqual(body.draft.trim(), "");
      });
    }
  });

  describe("сбой модели → 200 manual_review", () => {
    for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
      test(tag, async () => {
        const response = await post(app.base, { text: `Где моя доставка? ${tag}` });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), MANUAL_REVIEW);
      });
    }

    test("[timeout]: отвечаем за ~300 мс, а не ждём модель 1200 мс", async () => {
      const started = performance.now();
      const response = await post(app.base, { text: "Где моя доставка? [timeout]" });
      const elapsed = performance.now() - started;

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), MANUAL_REVIEW);
      assert.ok(elapsed >= 250, `ответ пришёл слишком рано: ${elapsed.toFixed(0)} мс`);
      assert.ok(elapsed < 1000, `ответ пришёл слишком поздно: ${elapsed.toFixed(0)} мс`);
    });
  });
});

test("таймаут срабатывает, даже если модель игнорирует сигнал отмены", async () => {
  const hangingModel = () => new Promise(() => {});
  const app = await startServer({ model: hangingModel, timeoutMs: 50 });
  try {
    const response = await post(app.base, { text: "Где моя доставка?" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), MANUAL_REVIEW);
  } finally {
    await app.close();
  }
});

test("причина ручного разбора попадает в лог", async () => {
  const events = [];
  const app = await startServer({ log: (event) => events.push(event) });
  try {
    await post(app.base, { text: "Вопрос [bad-topic]" });
    assert.deepEqual(events, [{ event: "triage_manual_review", reason: "unknown_topic" }]);
  } finally {
    await app.close();
  }
});

describe("страница: при сбое показываем ручной разбор и стираем черновик", () => {
  const makeElements = () => ({
    status: { textContent: "", dataset: {} },
    topic: { textContent: "" },
    draft: { value: "" },
    output: { hidden: true },
  });

  test("после успешного ответа сбой очищает предыдущий черновик", () => {
    const els = makeElements();

    render(toView(200, { status: "ready", topic: "delivery", draft: "Спасибо за обращение." }), els);
    assert.equal(els.draft.value, "Спасибо за обращение.");
    assert.equal(els.topic.textContent, "Доставка");
    assert.equal(els.output.hidden, false);

    render(toView(200, MANUAL_REVIEW), els);
    assert.equal(els.draft.value, "");
    assert.equal(els.topic.textContent, "");
    assert.equal(els.output.hidden, true);
    assert.equal(els.status.textContent, MESSAGES.manualReview);
  });

  test("ответ сервера 500 или сетевая ошибка — тоже ручной разбор без черновика", () => {
    for (const [status, body] of [[500, { status: "server_error" }], [0, null]]) {
      const view = toView(status, body);
      assert.equal(view.kind, "manual_review");
      assert.equal(view.draft, "");
      assert.equal(view.message, MESSAGES.unavailable);
    }
  });

  test("«ready» с пустым черновиком страница тоже не показывает", () => {
    const view = toView(200, { status: "ready", topic: "delivery", draft: "   " });
    assert.equal(view.kind, "manual_review");
    assert.equal(view.draft, "");
  });
});
