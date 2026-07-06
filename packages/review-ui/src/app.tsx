import { readFile } from "node:fs/promises";
import {
  defaultDatabasePath,
  getPreferenceQueueItem,
  getReviewQueueItem,
  initializeDatabase,
  insertHumanReview,
  listPreferenceQueue,
  listReviewQueue,
  markPreferenceQueueAnswered,
  type PreferenceQueueRow,
  type ReviewQueueItem,
} from "@model-routing/datastore";
import { uuidv7 } from "@model-routing/shared";
import { Hono } from "hono";

export type ReviewUiOptions = {
  dbPath?: string;
};

type FormVerdict = "A" | "B" | "tie" | "skip";

const styles = `
:root {
  color-scheme: light dark;
  --paper: light-dark(#f6f7f4, #151816);
  --surface: light-dark(#ffffff, #20241f);
  --surface-2: light-dark(#edf0eb, #262b25);
  --ink: light-dark(#161915, #eff4ed);
  --muted: light-dark(#5d685b, #a8b3a4);
  --line: light-dark(#c9d0c4, #3e473c);
  --accent: light-dark(#b23a2f, #ff8b73);
  --accent-2: light-dark(#286b55, #72d2b0);
  --focus: light-dark(#1d5fd1, #8bb7ff);
  --mono: ui-monospace, "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  accent-color: var(--accent);
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  line-height: 1.5;
}

a {
  color: inherit;
}

button,
.button {
  min-block-size: 2.5rem;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-weight: 650;
  padding: 0.55rem 0.85rem;
  text-decoration: none;
}

button:hover:not(:disabled),
.button:hover {
  border-color: var(--accent);
}

:focus-visible {
  outline: 0.18rem solid var(--focus);
  outline-offset: 0.16rem;
}

.shell {
  min-block-size: 100dvh;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-block-end: 1px solid var(--line);
  background: var(--surface);
  padding: 0.85rem clamp(1rem, 3vw, 2rem);
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  min-inline-size: 0;
}

.brand strong {
  font-size: 1rem;
}

.brand span,
.meta {
  color: var(--muted);
  font-size: 0.875rem;
}

.content {
  padding: clamp(1rem, 3vw, 2rem);
}

.queue {
  display: grid;
  gap: 0.75rem;
  margin-block-start: 1rem;
}

.queue-item {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  padding: 0.9rem;
}

.queue-title {
  margin: 0;
  overflow-wrap: anywhere;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-block-start: 0.45rem;
}

.chip {
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.78rem;
  padding: 0.12rem 0.5rem;
}

.chip.urgent {
  border-color: var(--accent);
  color: var(--accent);
}

.task {
  border-block-end: 1px solid var(--line);
  margin-block-end: 1rem;
  padding-block-end: 1rem;
}

.task h1 {
  font-size: 1.15rem;
  margin: 0 0 0.5rem;
}

.task pre,
.pane pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.compare-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
}

.pane {
  container-type: inline-size;
  content-visibility: auto;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  overflow: hidden;
}

.pane h2 {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin: 0;
  border-block-end: 1px solid var(--line);
  background: var(--surface-2);
  padding: 0.65rem 0.8rem;
  font-size: 0.95rem;
}

.pane-section {
  padding: 0.8rem;
}

.pane-section + .pane-section {
  border-block-start: 1px solid var(--line);
}

.pane-section h3 {
  color: var(--muted);
  font-size: 0.8rem;
  margin: 0 0 0.45rem;
}

.pane pre {
  max-block-size: 44rem;
  margin: 0;
  overflow: auto;
  font-family: var(--mono);
  font-size: 0.82rem;
  line-height: 1.45;
  scrollbar-color: var(--muted) transparent;
}

.actions {
  position: sticky;
  inset-block-end: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  border-block-start: 1px solid var(--line);
  background: color-mix(in oklab, var(--paper), transparent 8%);
  padding: 0.85rem clamp(1rem, 3vw, 2rem);
}

.actions button:first-of-type,
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.reveal {
  display: grid;
  gap: 1rem;
  max-inline-size: 58rem;
}

.identity {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.identity div,
.empty {
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  padding: 1rem;
}

@media (max-width: 820px) {
  .compare-grid,
  .identity,
  .queue-item {
    grid-template-columns: 1fr;
  }
}
`;

const keysScript = `
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const button = document.querySelector("[data-review-key='" + event.key.toLowerCase() + "']");
  if (button instanceof HTMLButtonElement) {
    event.preventDefault();
    button.click();
  }
});
`;

function Layout(props: { title: string; children: unknown }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div class="shell">
          <header class="topbar">
            <div class="brand">
              <strong>Model Routing Review</strong>
              <span>blind pairwise queue</span>
            </div>
            <nav>
              <a href="/queue">Queue</a>
              {" · "}
              <a href="/push">Push</a>
            </nav>
          </header>
          <main class="content">{props.children}</main>
        </div>
      </body>
    </html>
  );
}

function compareHref(item: ReviewQueueItem): string {
  return `/compare/${encodeURIComponent(item.evalTaskId)}/${encodeURIComponent(item.candidateRunId)}/${encodeURIComponent(item.baselineRunId)}`;
}

function pushHref(item: PreferenceQueueRow): string {
  return `/push/${encodeURIComponent(item.id)}`;
}

function verifyLabel(value: boolean | null): string {
  if (value == null) {
    return "not run";
  }

  return value ? "passed" : "failed";
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

async function readArtifact(path: string | null, fallback: string): Promise<string> {
  if (!path) {
    return fallback;
  }

  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

function formVerdictToStored(value: FormVerdict): string {
  switch (value) {
    case "A":
      return "candidate_win";
    case "B":
      return "baseline_win";
    case "tie":
      return "tie";
    case "skip":
      return "skip";
  }
}

function verdictFromForm(value: FormDataEntryValue | undefined): FormVerdict {
  if (value === "A" || value === "B" || value === "tie" || value === "skip") {
    return value;
  }

  throw new Error("invalid verdict");
}

function startedAtFromForm(value: FormDataEntryValue | undefined): number {
  if (typeof value !== "string") {
    return Date.now();
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function QueuePage(props: { items: ReviewQueueItem[] }) {
  const byCategory = new Map<string, number>();
  for (const item of props.items) {
    byCategory.set(item.taskCategory, (byCategory.get(item.taskCategory) ?? 0) + 1);
  }

  return (
    <Layout title="Review queue">
      <section>
        <h1>Review queue</h1>
        <p class="meta">
          {props.items.length} pending
          {[...byCategory.entries()].map(([category, count]) => ` · ${category}: ${count}`).join("")}
        </p>
      </section>
      {props.items.length === 0 ? (
        <div class="empty">未レビューの比較はありません。</div>
      ) : (
        <section class="queue" aria-label="Pending comparisons">
          {props.items.map((item) => (
            <article class="queue-item">
              <div>
                <p class="queue-title">{truncate(item.promptText, 180)}</p>
                <div class="chips">
                  <span class="chip">{item.taskCategory}</span>
                  <span class="chip">{item.repoPath}</span>
                  {item.hasJudgeConflict ? <span class="chip urgent">position conflict</span> : null}
                </div>
              </div>
              <a class="button primary" href={compareHref(item)}>
                Open
              </a>
            </article>
          ))}
        </section>
      )}
    </Layout>
  );
}

function PushQueuePage(props: { items: PreferenceQueueRow[] }) {
  return (
    <Layout title="Push queue">
      <section>
        <h1>Push queue</h1>
        <p class="meta">{props.items.length} pending preference prompts</p>
      </section>
      {props.items.length === 0 ? (
        <div class="empty">通知対象の比較はありません。</div>
      ) : (
        <section class="queue" aria-label="Pending preference prompts">
          {props.items.map((item) => (
            <article class="queue-item">
              <div>
                <p class="queue-title">{item.reason}</p>
                <div class="chips">
                  <span class="chip">{item.batchId}</span>
                  <span class="chip">priority {item.priority}</span>
                  <span class="chip">{item.evalTaskId}</span>
                </div>
              </div>
              <a class="button primary" href={pushHref(item)}>
                Open
              </a>
            </article>
          ))}
        </section>
      )}
    </Layout>
  );
}

function Pane(props: { label: string; diff: string; finalMessage: string; verify: string }) {
  return (
    <section class="pane" aria-label={`Artifact ${props.label}`}>
      <h2>
        <span>Artifact {props.label}</span>
        <span class="meta">{props.verify}</span>
      </h2>
      <div class="pane-section">
        <h3>Diff</h3>
        <pre>{props.diff}</pre>
      </div>
      <div class="pane-section">
        <h3>Final report</h3>
        <pre>{props.finalMessage}</pre>
      </div>
    </section>
  );
}

function ComparePage(props: {
  item: ReviewQueueItem;
  preferenceQueueId?: string;
  candidateDiff: string;
  candidateFinal: string;
  baselineDiff: string;
  baselineFinal: string;
}) {
  return (
    <Layout title="Compare artifacts">
      <section class="task">
        <h1>Task</h1>
        <pre>{props.item.promptText}</pre>
      </section>
      <form method="post" action="/reviews">
        <input type="hidden" name="eval_task_id" value={props.item.evalTaskId} />
        <input type="hidden" name="candidate_run_id" value={props.item.candidateRunId} />
        <input type="hidden" name="baseline_run_id" value={props.item.baselineRunId} />
        {props.preferenceQueueId ? (
          <input type="hidden" name="preference_queue_id" value={props.preferenceQueueId} />
        ) : null}
        <input type="hidden" name="started_at" value={Date.now().toString()} />
        <div class="compare-grid">
          <Pane
            label="A"
            diff={props.candidateDiff}
            finalMessage={props.candidateFinal}
            verify={verifyLabel(props.item.candidateVerifyPassed)}
          />
          <Pane
            label="B"
            diff={props.baselineDiff}
            finalMessage={props.baselineFinal}
            verify={verifyLabel(props.item.baselineVerifyPassed)}
          />
        </div>
        <div class="actions">
          <button type="submit" name="verdict" value="A" data-review-key="a">
            A
          </button>
          <button type="submit" name="verdict" value="B" data-review-key="b">
            B
          </button>
          <button type="submit" name="verdict" value="tie" data-review-key="t">
            同等
          </button>
          <button type="submit" name="verdict" value="skip" data-review-key="s">
            スキップ
          </button>
        </div>
      </form>
      <script src="/keys.js" />
    </Layout>
  );
}

function RevealPage(props: { item: ReviewQueueItem; next: ReviewQueueItem | null }) {
  return (
    <Layout title="Review saved">
      <section class="reveal">
        <h1>Saved</h1>
        <div class="identity">
          <div>
            <p class="meta">Artifact A</p>
            <strong>{props.item.candidateVariant}</strong>
            <p>{props.item.candidateRunId}</p>
          </div>
          <div>
            <p class="meta">Artifact B</p>
            <strong>{props.item.baselineVariant}</strong>
            <p>{props.item.baselineRunId}</p>
          </div>
        </div>
        <div class="empty">
          <strong>Judge</strong>
          <p>{props.item.judgmentSummary || "no judge summary"}</p>
        </div>
        <p>
          {props.next ? (
            <a class="button primary" href={compareHref(props.next)}>
              Next
            </a>
          ) : (
            <a class="button primary" href="/queue">
              Queue
            </a>
          )}
        </p>
      </section>
    </Layout>
  );
}

export function createReviewUiApp(options: ReviewUiOptions = {}): Hono {
  const dbPath = options.dbPath ?? defaultDatabasePath();
  initializeDatabase(dbPath);

  const app = new Hono();

  app.get("/styles.css", (c) => c.text(styles, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/keys.js", (c) => c.text(keysScript, 200, { "content-type": "application/javascript; charset=utf-8" }));
  app.get("/", (c) => c.redirect("/queue"));
  app.get("/queue", (c) => c.html(<QueuePage items={listReviewQueue(dbPath, 100)} />));
  app.get("/push", (c) =>
    c.html(<PushQueuePage items={listPreferenceQueue(dbPath, { status: "pending", limit: 100 })} />),
  );
  app.get("/compare/:evalTaskId/:candidateRunId/:baselineRunId", async (c) => {
    const item = getReviewQueueItem(dbPath, {
      evalTaskId: c.req.param("evalTaskId"),
      candidateRunId: c.req.param("candidateRunId"),
      baselineRunId: c.req.param("baselineRunId"),
    });
    if (!item) {
      return c.notFound();
    }

    return c.html(
      <ComparePage
        item={item}
        candidateDiff={truncate(await readArtifact(item.candidateDiffPath, "[no diff artifact]"), 80_000)}
        candidateFinal={truncate(await readArtifact(item.candidateFinalMessagePath, "[no final report]"), 16_000)}
        baselineDiff={truncate(await readArtifact(item.baselineDiffPath, "[no diff artifact]"), 80_000)}
        baselineFinal={truncate(await readArtifact(item.baselineFinalMessagePath, "[no final report]"), 16_000)}
      />,
    );
  });
  app.get("/push/:preferenceQueueId", async (c) => {
    const preference = getPreferenceQueueItem(dbPath, c.req.param("preferenceQueueId"));
    if (preference?.status !== "pending") {
      return c.notFound();
    }

    const item = getReviewQueueItem(dbPath, {
      evalTaskId: preference.evalTaskId,
      candidateRunId: preference.candidateRunId,
      baselineRunId: preference.baselineRunId,
    });
    if (!item) {
      return c.notFound();
    }

    return c.html(
      <ComparePage
        item={item}
        preferenceQueueId={preference.id}
        candidateDiff={truncate(await readArtifact(item.candidateDiffPath, "[no diff artifact]"), 80_000)}
        candidateFinal={truncate(await readArtifact(item.candidateFinalMessagePath, "[no final report]"), 16_000)}
        baselineDiff={truncate(await readArtifact(item.baselineDiffPath, "[no diff artifact]"), 80_000)}
        baselineFinal={truncate(await readArtifact(item.baselineFinalMessagePath, "[no final report]"), 16_000)}
      />,
    );
  });
  app.post("/reviews", async (c) => {
    const body = await c.req.parseBody();
    const item = getReviewQueueItem(dbPath, {
      evalTaskId: String(body.eval_task_id ?? ""),
      candidateRunId: String(body.candidate_run_id ?? ""),
      baselineRunId: String(body.baseline_run_id ?? ""),
    });
    if (!item) {
      return c.notFound();
    }

    const formVerdict = verdictFromForm(body.verdict);
    const startedAt = startedAtFromForm(body.started_at);
    const preferenceQueueId = typeof body.preference_queue_id === "string" ? body.preference_queue_id : "";
    const preference = preferenceQueueId ? getPreferenceQueueItem(dbPath, preferenceQueueId) : null;
    if (
      preferenceQueueId &&
      (preference?.evalTaskId !== item.evalTaskId ||
        preference.candidateRunId !== item.candidateRunId ||
        preference.baselineRunId !== item.baselineRunId)
    ) {
      return c.notFound();
    }

    const reviewId = uuidv7();
    const createdAt = Date.now();
    insertHumanReview(dbPath, {
      id: reviewId,
      evalTaskId: item.evalTaskId,
      candidateRunId: item.candidateRunId,
      baselineRunId: item.baselineRunId,
      createdAt,
      source: preference ? "push" : "review_session",
      verdict: formVerdictToStored(formVerdict),
      note: null,
      reviewSeconds: Math.max(0, Math.round((createdAt - startedAt) / 1000)),
    });
    if (preference) {
      markPreferenceQueueAnswered(dbPath, { id: preferenceQueueId, humanReviewId: reviewId, answeredAt: createdAt });
    }

    return c.redirect(
      `/reveal/${encodeURIComponent(item.evalTaskId)}/${encodeURIComponent(item.candidateRunId)}/${encodeURIComponent(item.baselineRunId)}`,
      303,
    );
  });
  app.get("/reveal/:evalTaskId/:candidateRunId/:baselineRunId", (c) => {
    const item = getReviewQueueItem(dbPath, {
      evalTaskId: c.req.param("evalTaskId"),
      candidateRunId: c.req.param("candidateRunId"),
      baselineRunId: c.req.param("baselineRunId"),
    });
    const next = listReviewQueue(dbPath, 1)[0] ?? null;
    if (!item) {
      return c.notFound();
    }

    return c.html(<RevealPage item={item} next={next} />);
  });

  return app;
}
