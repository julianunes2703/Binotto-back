// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * CORS — permite localhost no dev, *.vercel.app (previews) e qualquer origem listada em CORS_ORIGIN (separadas por vírgula)
 * Ex.: CORS_ORIGIN=https://seu-site.vercel.app,https://outro-dominio.com
 */
const allowlist = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/postman/etc
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    if (url.hostname.endsWith(".vercel.app")) return true; // previews + prod da Vercel
  } catch {
    // se não for URL válida, cai pro allowlist explícito
  }
  return allowlist.includes(origin);
}

app.use(
  cors({
    origin: (origin, cb) => (isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("CORS: origem bloqueada"))),
    credentials: true,
  })
);

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Health & raiz ---
app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.get("/", (_, res) => res.status(200).send("OK"));

// --- Schema de saída (Structured Outputs) ---
const schema = {
  type: "object",
  properties: {
    resumo: { type: "string" },
    destaques: { type: "array", items: { type: "string" } },
    riscos: { type: "array", items: { type: "string" } },
    oportunidades: { type: "array", items: { type: "string" } },
    tops: {
      type: "object",
      properties: {
        cidades: { type: "array", items: { type: "string" } },
        produtos: { type: "array", items: { type: "string" } },
      },
      required: ["cidades", "produtos"],
      additionalProperties: false,
    },
    acoesRecomendadas: { type: "array", items: { type: "string" } },
    tarefas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          titulo: { type: "string" },
          descricao: { type: "string" },
          responsavel: { type: "string" },
          prioridade: { enum: ["alta", "media", "baixa"] },
          impacto: { enum: ["receita", "margem", "cobertura", "mix", "operacao"] },
          prazoDias: { type: "number" },
        },
        required: ["titulo", "descricao", "responsavel", "prioridade", "impacto", "prazoDias"],
        additionalProperties: false,
      },
    },
  },
  required: ["resumo", "destaques", "riscos", "oportunidades", "tops", "acoesRecomendadas", "tarefas"],
  additionalProperties: false,
};

// util: tenta extrair JSON estruturado de diferentes formatos do SDK
function extractStructured(resp) {
  // Responses API costuma ter: resp.output[0].content = [{type: 'output_json', parsed: {...}} | {type:'output_text', text:'...'} ...]
  const first = resp?.output?.[0];
  const content = Array.isArray(first?.content) ? first.content : [];

  // 1) preferimos output_json
  const jsonPart = content.find((c) => c?.type === "output_json" && c?.parsed);
  if (jsonPart?.parsed) return jsonPart.parsed;

  // 2) fallback: se vier texto, tentar parsear
  const textPart = content.find((c) => c?.type === "output_text" && typeof c?.text === "string");
  if (textPart?.text) {
    const raw = String(textPart.text).trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    try {
      return JSON.parse(raw);
    } catch {
      // se falhar, cai pro throw abaixo
    }
  }

  // 3) último fallback: resp.output_text agregado (algumas versões expõem)
  if (resp?.output_text) {
    const raw = String(resp.output_text).trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    try {
      return JSON.parse(raw);
    } catch {
      // ignore
    }
  }

  throw new Error("Resposta sem JSON estruturado");
}

// --- Rota principal ---
app.post("/analyze", async (req, res) => {
  try {
    const { ano, mes, metric, resumo } = req.body;
    if (!ano || !mes || !metric || !resumo) {
      return res.status(400).json({ ok: false, error: "Parâmetros faltando" });
    }

    const system = `Você é um analista de operações e vendas.
Responda SEMPRE usando o schema JSON fornecido, sem markdown e sem comentários. Seja objetivo e acionável.`;

    const user = `
Analise o mês ${mes}/${ano} considerando a métrica "${metric}".
Use o comparativo com o mês anterior para identificar variações.

DADOS (JSON):
${JSON.stringify(resumo, null, 2)}

Regras:
- Se algum campo não se aplicar, devolva-o como lista vazia [] (NUNCA omita campos).
`.trim();

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "AnaliseMensal",
          schema,
          strict: true,
        },
      },
      temperature: 0.2,
    });

    const data = extractStructured(resp);
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("Erro /analyze", {
      message: err?.message,
      requestId: err?._request_id,
      stack: err?.stack,
    });
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`IA analyzer rodando em http://localhost:${PORT}`);
});
