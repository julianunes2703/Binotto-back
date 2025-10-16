import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { z } from "zod";

dotenv.config();

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(helmet());
app.use(morgan("tiny"));

/* ========================= CORS ========================= */
const allowlist = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/postman/etc
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    if (url.hostname.endsWith(".vercel.app")) return true;
  } catch {
    /* noop */
  }
  return allowlist.includes(origin);
}

app.use(
  cors({
    origin: (origin, cb) =>
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("CORS: origem bloqueada")),
    credentials: true,
  })
);

/* ===================== RATE LIMIT ======================= */
app.set("trust proxy", 1);
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

/* ====================== OPENAI ========================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ==================== UTIL / CONSTS ===================== */
const MONTHS_ORDER = [
  "JAN",
  "FEV",
  "MAR",
  "ABR",
  "MAI",
  "JUN",
  "JUL",
  "AGO",
  "SET",
  "OUT",
  "NOV",
  "DEZ",
];
const money = (v) => Number(v) || 0;
const normalizeMes = (m) => String(m || "").trim().slice(0, 3).toUpperCase();

function summarizeBlock(rows, metaKey, realKey, isPercent = false) {
  let meta = 0;
  let real = 0;
  let n = 0;

  rows.forEach((r) => {
    const m = Number(r[metaKey] ?? 0);
    const v = Number(r[realKey] ?? 0);
    if (isPercent) {
      if (!Number.isNaN(m)) meta += m;
      if (!Number.isNaN(v)) real += v;
      n += 1;
    } else {
      meta += money(m);
      real += money(v);
    }
  });

  if (isPercent) {
    meta = n ? meta / n : 0;
    real = n ? real / n : 0;
  }
  const perc = meta ? (real / meta) * 100 : 0;
  return { meta, real, perc };
}

function monthDelta(curr, prev) {
  if (!curr || !prev) return {};
  const out = {};
  for (const k of Object.keys(curr)) {
    if (typeof curr[k] === "number" && typeof prev[k] === "number") {
      out[k] = curr[k] - prev[k];
    }
  }
  return out;
}

/* =============== SCHEMAS (Zod) ========================== */
const RowSchema = z.object({
  obra: z.string().min(1),
  ano: z.number().int().optional(),
  mes: z.string().min(1),
  prazo_pedido_meta: z.number().optional(),
  prazo_pedido_real: z.number().optional(),
  prazo_entrega_meta: z.number().optional(),
  prazo_entrega_real: z.number().optional(),
  pontualidade_meta: z.number().optional(),
  pontualidade_real: z.number().optional(),
  negociacao_meta: z.number().optional(),
  negociacao_real: z.number().optional(),
  prazo_pedido_perc: z.number().optional(),
  prazo_entrega_perc: z.number().optional(),
  pontualidade_perc: z.number().optional(),
  negociacao_perc: z.number().optional(),
});

const AnalyzeObrasSchema = z.object({
  ano: z.number().int().optional(),
  obra: z.string().optional(),
  alvoPct: z.number().min(0.1).max(1).default(0.75),
  rows: z.array(RowSchema),
});

/* ================== HEALTH / ROOT ======================= */
app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.get("/", (_, res) => res.status(200).send("OK"));

/* ===================== ROTA: /analyze =================== */
app.post("/analyze", async (req, res) => {
  try {
    const { ano, mes, metric, resumo } = req.body;
    if (!ano || !resumo) {
      return res.status(400).json({ ok: false, error: "Parâmetros faltando" });
    }

    const isTodos = String(mes || "").toUpperCase() === "TODOS";

    const system = `Você é um analista sênior de planejamento e controle de obras (PCO) e suprimentos.
Responda APENAS em JSON válido UTF-8, sem markdown.
Seja claro, objetivo e priorize o que mais impacta o resultado.`;

    const user = isTodos
      ? `
Analise o desempenho GERAL do ano ${ano} (${metric || "geral"}), usando todos os meses fornecidos.
Identifique tendências do ano, meses atípicos, principais desvios, riscos e oportunidades.
Traga 5–8 ações recomendadas e 3–5 riscos/oportunidades.

DADOS:
${JSON.stringify(resumo, null, 2)}

Responda EXCLUSIVAMENTE neste JSON:
{
  "resumo": "string",
  "destaques": ["string"],
  "riscos": ["string"],
  "oportunidades": ["string"],
  "acoesRecomendadas": ["string"],
  "tarefas": [
    { "titulo": "string", "descricao": "string", "responsavel": "string",
      "prioridade": "alta|media|baixa", "impacto": "operacao|receita|prazo|margem", "prazoDias": 7 }
  ]
}
- Nunca omita campos.`
      : `
Analise o mês ${mes}/${ano} considerando a métrica "${metric || "geral"}".
Compare com o mês anterior (se existir) e destaque variações, causas prováveis e ações corretivas.
Traga 5–8 ações recomendadas e 3–5 riscos/oportunidades.

DADOS:
${JSON.stringify(resumo, null, 2)}

Responda EXCLUSIVAMENTE neste JSON:
{
  "resumo": "string",
  "destaques": ["string"],
  "riscos": ["string"],
  "oportunidades": ["string"],
  "acoesRecomendadas": ["string"],
  "tarefas": [
    { "titulo": "string", "descricao": "string", "responsavel": "string",
      "prioridade": "alta|media|baixa", "impacto": "operacao|receita|prazo|margem", "prazoDias": 7 }
  ]
}
- Nunca omita campos.`;

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.25,
    });

    let raw = String(resp.output_text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const fix = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: "Conserte o texto abaixo para JSON válido. Responda apenas o JSON." },
          { role: "user", content: raw },
        ],
        temperature: 0,
      });
      const fixed = (fix.output_text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
      data = JSON.parse(fixed);
    }

    return res.json({ ok: true, data });
  } catch (err) {
    console.error("Erro /analyze", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/* ================== ROTA: /analyze-obras ================== */
app.post("/analyze-obras", async (req, res) => {
  try {
    const parsed = AnalyzeObrasSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    const { ano, obra, alvoPct, rows } = parsed.data;
    const norm = rows.map((r) => ({
      ...r,
      mes: normalizeMes(r.mes),
      ano: r.ano ?? ano ?? new Date().getFullYear(),
    }));

    const obraSel = obra && obra !== "Todas" ? obra : null;
    const filtered = norm.filter((r) => (obraSel ? r.obra === obraSel : true));

    const isPercentBlock = {
      pontualidade: true,
      negociacao: true,
      prazo_pedido: false,
      prazo_entrega: false,
    };

    const months = MONTHS_ORDER.map((m) => {
      const rs = filtered.filter((r) => r.mes === m && (!ano || r.ano === ano));

      const prazoPedido = summarizeBlock(rs, "prazo_pedido_meta", "prazo_pedido_real", false);
      const prazoEntrega = summarizeBlock(rs, "prazo_entrega_meta", "prazo_entrega_real", false);
      const pontualidade = summarizeBlock(rs, "pontualidade_meta", "pontualidade_real", true);
      const negociacao = summarizeBlock(rs, "negociacao_meta", "negociacao_real", true);

      return { mes: m, prazo_pedido: prazoPedido, prazo_entrega: prazoEntrega, pontualidade, negociacao };
    });

    const monthsWithDelta = months.map((row, idx) => {
      const prev = idx > 0 ? months[idx - 1] : null;
      return {
        ...row,
        delta: {
          prazo_pedido: prev ? monthDelta(row.prazo_pedido, prev.prazo_pedido) : {},
          prazo_entrega: prev ? monthDelta(row.prazo_entrega, prev.prazo_entrega) : {},
          pontualidade: prev ? monthDelta(row.pontualidade, prev.pontualidade) : {},
          negociacao: prev ? monthDelta(row.negociacao, prev.negociacao) : {},
        },
      };
    });

    const ytd = {
      prazo_pedido: summarizeBlock(filtered, "prazo_pedido_meta", "prazo_pedido_real", false),
      prazo_entrega: summarizeBlock(filtered, "prazo_entrega_meta", "prazo_entrega_real", false),
      pontualidade: summarizeBlock(filtered, "pontualidade_meta", "pontualidade_real", true),
      negociacao: summarizeBlock(filtered, "negociacao_meta", "negociacao_real", true),
    };

    const resumoIA = { obra: obraSel || "Todas", ano, alvoPct, ytd, meses: monthsWithDelta };

    const system = `Você é um analista sênior de planejamento e suprimentos.
Responda APENAS em JSON válido UTF-8, sem markdown.
Seja claro, objetivo e priorize o que mais impacta o resultado.`;

    const user = `
Analise o desempenho de compras/suprimentos da obra "${resumoIA.obra}" no ano ${resumoIA.ano}.
Considere prazos (sol×pedido e sol×entrega), pontualidade e % de negociação.
Use YTD, % do planejado e comprometimento ao alvo de ${(alvoPct * 100).toFixed(0)}%.
Traga 5–8 ações priorizadas e 3–5 riscos/oportunidades.

DADOS:
${JSON.stringify(resumoIA, null, 2)}

Responda EXCLUSIVAMENTE neste JSON:
{
  "resumo": "string",
  "destaques": ["string"],
  "riscos": ["string"],
  "oportunidades": ["string"],
  "acoesRecomendadas": ["string"],
  "tarefas": [
    { "titulo": "string", "descricao": "string", "responsavel": "string",
      "prioridade": "alta|media|baixa", "impacto": "prazo|negociacao|pontualidade|operacao", "prazoDias": 7 }
  ]
}
- Nunca omita campos.`;

    let analise = {};

    try {
      const resp = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.25,
      });

      let raw = String(resp.output_text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
      analise = JSON.parse(raw);
    } catch (e) {
      console.warn("Falha IA /analyze-obras:", e.message);
    }

    return res.json({ ok: true, obra: resumoIA.obra, ano: resumoIA.ano, ytd, meses: monthsWithDelta, analise });
  } catch (err) {
    console.error("Erro /analyze-obras", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/* ====================== START =========================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`IA Analyzer rodando em http://localhost:${PORT}`);
});
