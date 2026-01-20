import crypto from "crypto";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";

function verifySlack(rawBody: string, timestamp: string, signature: string, signingSecret: string) {
  const now = Math.floor(Date.now() / 1000);
  if (!timestamp || Math.abs(now - Number(timestamp)) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${hash}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature || "", "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseExpense(text: string) {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (!t) return { type: "help" as const };
  if (["help", "hjelp", "?"].includes(lower)) return { type: "help" as const };
  if (["month", "måned", "maned"].includes(lower)) return { type: "month" as const };
  if (["today", "i dag", "idag", "dag"].includes(lower)) return { type: "today" as const };
  if (["list", "liste", "siste"].includes(lower)) return { type: "list" as const };

  const m = t.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (!m) return { type: "invalid" as const };

  const amount = Number(m[1].replace(",", "."));
  let rest = m[2].trim();

  let category: string | null = null;
  const cat = rest.match(/(?:^|\s)#(\S+)/);
  if (cat) {
    category = cat[1];
    rest = rest.replace(cat[0], "").trim();
  }

  const note = rest || "";
  if (!Number.isFinite(amount) || amount <= 0 || !note) return { type: "invalid" as const };

  return { type: "add" as const, amount, note, category };
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS expenses (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      note TEXT NOT NULL,
      category TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

function formatNok(n: number) {
  return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK" }).format(n);
}

export async function POST(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
  const rawBody = await req.text();

  const ts = req.headers.get("x-slack-request-timestamp") || "";
  const sig = req.headers.get("x-slack-signature") || "";

  if (!verifySlack(rawBody, ts, sig, signingSecret)) {
    return new Response("Ugyldig signatur", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const params = new URLSearchParams(rawBody);
  const text = (params.get("text") || "").trim();
  const userId = params.get("user_id") || "unknown";

  const parsed = parseExpense(text);

  if (parsed.type === "help") {
    return new Response(
      "Bruk:\n/expense 120 kaffe #mat\n/expense måned\n/expense idag\n/expense liste",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    return new Response(
      "DB mangler. Koble til Vercel Postgres og redeploy, så kan jeg lagre utgifter.",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  await ensureSchema();

  if (parsed.type === "invalid") {
    return new Response(
      "Ugyldig format. Prøv: /expense 120 kaffe #mat",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (parsed.type === "add") {
    await sql`
      INSERT INTO expenses (user_id, amount, note, category)
      VALUES (${userId}, ${parsed.amount}, ${parsed.note}, ${parsed.category})
    `;
    const cat = parsed.category ? ` (#${parsed.category})` : "";
    return new Response(
      `✅ Registrert: ${formatNok(parsed.amount)} – ${parsed.note}${cat}`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (parsed.type === "month") {
    const r = await sql<{ sum: string | null }>`
      SELECT COALESCE(SUM(amount), 0) as sum
      FROM expenses
      WHERE user_id = ${userId}
        AND date_trunc('month', created_at) = date_trunc('month', now())
    `;
    const total = Number(r.rows[0]?.sum || 0);
    return new Response(
      `📅 Denne måneden: ${formatNok(total)}`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (parsed.type === "today") {
    const r = await sql<{ sum: string | null }>`
      SELECT COALESCE(SUM(amount), 0) as sum
      FROM expenses
      WHERE user_id = ${userId}
        AND created_at >= date_trunc('day', now())
        AND created_at < date_trunc('day', now()) + interval '1 day'
    `;
    const total = Number(r.rows[0]?.sum || 0);
    return new Response(
      `📌 I dag: ${formatNok(total)}`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const rows = await sql<{ amount: string; note: string; category: string | null; created_at: string }>`
    SELECT amount::text as amount, note, category, created_at::text as created_at
    FROM expenses
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 10
  `;

  if (rows.rows.length === 0) {
    return new Response(
      "Ingen registrerte utgifter ennå.",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const lines = rows.rows.map((x) => {
    const a = formatNok(Number(x.amount));
    const c = x.category ? ` #${x.category}` : "";
    const d = new Intl.DateTimeFormat("nb-NO", { dateStyle: "short", timeStyle: "short" }).format(new Date(x.created_at));
    return `• ${a} – ${x.note}${c} (${d})`;
  });

  return new Response(
    `Siste 10:\n${lines.join("\n")}`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}
