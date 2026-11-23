// Логика отображения без привязки к DOM: её можно проверить тестом в Node.

export const TOPIC_LABELS = {
  delivery: "Доставка",
  pricing: "Цена и стоимость",
  other: "Другое",
};

export const MESSAGES = {
  loading: "Разбираю заявку…",
  invalid: "Введите текст заявки.",
  manualReview: "AI не смог разобрать заявку. Определите тему и подготовьте ответ вручную.",
  unavailable: "Сервис разбора недоступен. Разберите заявку вручную.",
};

/** Превращает ответ API в то, что видит менеджер. Всё, что не «ready», — без черновика. */
export function toView(httpStatus, body) {
  const isReady =
    body?.status === "ready" &&
    typeof body.topic === "string" &&
    typeof body.draft === "string" &&
    body.draft.trim() !== "";

  if (isReady) {
    return {
      kind: "ready",
      message: "",
      topic: TOPIC_LABELS[body.topic] ?? body.topic,
      draft: body.draft,
    };
  }
  if (httpStatus === 400 || body?.status === "invalid_input") {
    return { kind: "invalid", message: MESSAGES.invalid, topic: "", draft: "" };
  }
  if (body?.status === "manual_review") {
    return { kind: "manual_review", message: MESSAGES.manualReview, topic: "", draft: "" };
  }
  // 5xx, сетевая ошибка или неожиданный ответ — тоже ручной разбор.
  return { kind: "manual_review", message: MESSAGES.unavailable, topic: "", draft: "" };
}

export const LOADING_VIEW = Object.freeze({ kind: "loading", message: MESSAGES.loading, topic: "", draft: "" });

/** Применяет view к элементам страницы. Предыдущий черновик всегда перезаписывается. */
export function render(view, els) {
  els.status.textContent = view.message;
  els.status.dataset.kind = view.kind;
  els.topic.textContent = view.topic;
  els.draft.value = view.draft;
  els.output.hidden = view.kind !== "ready";
}
