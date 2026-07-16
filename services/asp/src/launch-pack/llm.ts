/**
 * OpenAI-compatible chat client for consumer Launch Pack tools only.
 * Never used on the money path (policy/preflight stay LLM-free / I1).
 *
 * Providers (first match wins):
 *   1. XAI_API_KEY  → api.x.ai
 *   2. GROQ_API_KEY → api.groq.com/openai/v1
 *   3. OPENAI_API_KEY + optional OPENAI_BASE_URL (OpenAI or any compatible host)
 */

export type LlmConfig = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly provider: "xai" | "groq" | "openai";
};

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const xai = env.XAI_API_KEY?.trim();
  const groq = env.GROQ_API_KEY?.trim();
  const openai = env.OPENAI_API_KEY?.trim();

  if (xai) {
    return {
      apiKey: xai,
      baseUrl: (env.OPENAI_BASE_URL?.trim() || "https://api.x.ai/v1").replace(/\/$/, ""),
      model: env.OPENAI_MODEL?.trim() || env.XAI_MODEL?.trim() || "grok-3-mini",
      provider: "xai",
    };
  }
  if (groq) {
    return {
      apiKey: groq,
      baseUrl: (env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
      model: env.OPENAI_MODEL?.trim() || env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile",
      provider: "groq",
    };
  }
  if (openai) {
    const base = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
    const isGroq = /groq\.com/i.test(base);
    return {
      apiKey: openai,
      baseUrl: base,
      model: env.OPENAI_MODEL?.trim() || (isGroq ? "llama-3.3-70b-versatile" : "gpt-4o-mini"),
      provider: isGroq ? "groq" : "openai",
    };
  }
  return null;
}

export async function chatJson(args: {
  readonly config: LlmConfig;
  readonly system: string;
  readonly user: string;
  readonly timeoutMs?: number;
}): Promise<unknown> {
  const { config, system, user, timeoutMs = 25_000 } = args;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      temperature: 0.65,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    // response_format json_object is widely supported; Groq and OpenAI honor it.
    body.response_format = { type: "json_object" };

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("LLM returned empty content");
    // Some models wrap JSON in fences
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    return JSON.parse(cleaned) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
