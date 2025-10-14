// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * CORS: libera localhost (dev), *.vercel.app (deploy do front)
 * e quaisquer domínios que você adicionar em CORS_ORIGIN (separados por vírgula).
 * Se preferir abrir para todos, troque por app.use(cors()).
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
    if (url.hostname.endsWith(".vercel.app")) return true;
  } catch {
    // se não for URL válida, cai para allowlist explícito
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

// --- Health & raiz (úteis para Render) ---
app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.get("/", (_, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3001;

app.post("/analyze", async (req, res) => {
  try {
    const { ano, mes, metric, resumo } = req.body;
    if (!ano || !mes || !metric || !resumo) {
      return res.status(400).json({ ok: false, error: "Parâmetros faltando" });
    }

    const system = `Você é um analista de operações e vendas. 
Responda SEMPRE em JSON válido (UTF-8), sem markdown e sem comentários. Seja objetivo e acionável.`;

    const user = `
Analise o mês ${mes}/${ano} considerando a métrica "${metric}".
Use o comparativo com o mês anterior para identificar variações.

DADOS (JSON):
${JSON.stringify(resumo, null, 2)}

Responda EXCLUSIVAMENTE em JSON com este formato exato:
{
  "resumo": "string obrigatória, objetiva",
  "destaques": ["bullet 1", "bullet 2"],
  "riscos": ["bullet 1", "bullet 2"],
  "oportunidades": ["bullet 1", "bullet 2"],
  "tops": {
    "cidades": ["Cidade A (motivo opcional)", "Cidade B ..."],
    "produtos": ["Produto X (motivo opcional)", "Produto Y ..."]
  },
  "acoesRecomendadas": ["ação 1", "ação 2", "ação 3"],
  "tarefas": [
    {
      "titulo": "string curta e clara",
      "descricao": "o que exatamente fazer",
      "responsavel": "equipe ou papel (ex.: Comercial/ROTA 3)",
      "prioridade": "alta|media|baixa",
      "impacto": "receita|margem|cobertura|mix|operacao",
      "prazoDias": 7
    }
  ]
}
Regras:
- Se algum campo não se aplicar, devolva-o como lista vazia [] (NUNCA omita campos).
- Nada fora do JSON.
`;

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2
    });

    // extrai texto e tenta parsear
    let raw =
      resp.output_text ??
      resp.output?.[0]?.content?.[0]?.text ??
      "";

    raw = String(raw).trim().replace(/^```json\s*/i, "").replace(/```$/i, "");

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // reparo mínimo para JSON válido
      const fix = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: "Conserte para JSON válido. Responda apenas o JSON." },
          { role: "user", content: raw }
        ],
        temperature: 0
      });
      const fixed = (fix.output_text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
      data = JSON.parse(fixed);
    }

    return res.json({ ok: true, data });
  } catch (err) {
    console.error("Erro /analyze", {
      message: err?.message,
      name: err?.name,
      code: err?.code,
      status: err?.status,
      requestId: err?._request_id,
      responseStatus: err?.response?.status,
      responseData: err?.response?.data
    });
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`IA analyzer rodando em http://localhost:${PORT}`);
});
