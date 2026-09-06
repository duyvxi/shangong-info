import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { normalizeText, rankDocuments } from "../_shared/retrieval.js";

type KnowledgeDocument = {
  id?: string;
  slug: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  source_url: string | null;
  source_type: "curated" | "official_notice" | "manual";
  source_date: string | null;
  verified_at: string | null;
  effective_from: string | null;
  effective_until: string | null;
  metadata: Record<string, unknown> | null;
};

type RetrievalMatch = KnowledgeDocument & {
  retrieval_score: number;
  retrieval_method: "keyword" | "semantic" | "hybrid";
  semantic_score?: number;
  chunk_id?: string;
};

type SemanticMatch = {
  chunk_id: string;
  document_id: string;
  slug: string;
  title: string;
  category: string;
  content: string;
  source_url: string | null;
  source_date: string | null;
  verified_at: string | null;
  semantic_score: number;
  source_type?: KnowledgeDocument["source_type"];
  effective_from?: string | null;
  effective_until?: string | null;
  metadata?: Record<string, unknown> | null;
};

class CampusAIError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CampusAIError";
    this.code = code;
  }
}

const DEFAULT_ORIGINS = [
  "https://duyvxi.github.io",
  "https://dgtzddf-2lxcnmk2.edgeone.cool",
  "https://tgfhjvhcvasgdiusfgfsh-4egfid21.edgeone.cool",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function env(name: string, fallback = "") {
  return (Deno.env.get(name) || fallback).trim();
}

function jsonResponse(body: unknown, status: number, origin: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function configuredOrigins() {
  const configured = env("AI_ALLOWED_ORIGINS");
  return configured
    ? configured.split(",").map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
}

function isLoopbackOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return isHttp && isLoopback;
  } catch {
    return false;
  }
}

function allowedOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  // 本机预览工具经常随机分配端口（如 5500、8080）。Origin 仍由浏览器
  // 强制生成，网页无法伪造为 loopback，因此可以安全兼容这些开发端口。
  return configuredOrigins().includes(origin) || isLoopbackOrigin(origin) ? origin : "";
}

function collectStringValues(value: unknown, target: string[]) {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectStringValues(entry, target));
  }
}

function getPublicKeys() {
  const keys: string[] = [];
  const legacyKey = env("SUPABASE_ANON_KEY");
  if (legacyKey) keys.push(legacyKey);

  const publishableKeys = env("SUPABASE_PUBLISHABLE_KEYS");
  if (publishableKeys) {
    try {
      collectStringValues(JSON.parse(publishableKeys), keys);
    } catch {
      // 环境变量格式异常时仍可兼容旧 anon key。
    }
  }
  return [...new Set(keys.filter(Boolean))];
}

async function hasValidPublicKey(providedKey: string) {
  if (!providedKey || providedKey.length > 2048) return false;
  if (getPublicKeys().includes(providedKey)) return true;

  // 兼容旧项目：部分部署环境不会继续注入 legacy anon key。
  // 使用该 key 对本项目公开只读配置执行一次最小查询，由 Supabase Gateway 验证。
  const supabaseUrl = env("SUPABASE_URL").replace(/\/$/, "");
  if (!supabaseUrl) return false;
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/site_settings?select=key&limit=1`, {
      headers: { apikey: providedKey },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function getSecretKey() {
  const explicit = env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
  if (explicit) return explicit;

  const secretKeys = env("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const values: string[] = [];
      collectStringValues(JSON.parse(secretKeys), values);
      return values.find((value) => value.startsWith("sb_secret_")) || values[0] || "";
    } catch {
      return "";
    }
  }
  return "";
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function restRequest(path: string, init: RequestInit = {}) {
  const supabaseUrl = env("SUPABASE_URL").replace(/\/$/, "");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) throw new Error("Supabase 服务端密钥未配置");

  const headers = new Headers(init.headers);
  headers.set("apikey", secretKey);
  // 新 sb_secret_ key 只能放 apikey；旧 service_role JWT 才能作为 Bearer。
  if (!secretKey.startsWith("sb_secret_")) {
    headers.set("Authorization", `Bearer ${secretKey}`);
  }
  if (init.body) headers.set("Content-Type", "application/json");

  return fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers });
}

async function consumeQuota(clientHash: string) {
  const limit = Math.max(1, Math.min(Number(env("AI_REQUEST_LIMIT", "12")) || 12, 100));
  const response = await restRequest("rpc/consume_ai_quota", {
    method: "POST",
    body: JSON.stringify({ p_client_hash: clientHash, p_limit: limit, p_window_minutes: 60 }),
  });
  if (!response.ok) throw new Error(`额度检查失败：${await response.text()}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function fetchKnowledge(): Promise<KnowledgeDocument[]> {
  const fields = "id,slug,title,category,summary,content,source_url,source_type,source_date,verified_at,effective_from,effective_until,metadata";
  const response = await restRequest(
    `knowledge_documents?select=${fields}&status=eq.published&order=updated_at.desc&limit=500`,
  );
  if (!response.ok) throw new Error(`知识库读取失败：${await response.text()}`);
  const rows = await response.json() as KnowledgeDocument[];
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter((document) =>
    (!document.effective_from || document.effective_from <= today)
    && (!document.effective_until || document.effective_until >= today)
  );
}

function sourceKind(document: KnowledgeDocument | RetrievalMatch) {
  if (document.source_type === "official_notice") return "官方通知";
  const sourceClass = String(document.metadata?.source_class || "");
  if (sourceClass === "student_curated" || sourceClass === "student_submission") return "学生整理资料";
  return "本站整理资料";
}

function buildContext(documents: RetrievalMatch[]) {
  return documents.map((document, index) => {
    const sourceMeta = [
      document.source_date && `发布日期 ${document.source_date}`,
      document.verified_at && `核实时间 ${document.verified_at.slice(0, 10)}`,
    ].filter(Boolean).join("；");
    return [
      `[资料 ${index + 1}] ${document.title}`,
      `分类：${document.category}${sourceMeta ? `；${sourceMeta}` : ""}`,
      `资料性质：${sourceKind(document)}`,
      document.content.slice(0, 3200),
      document.source_url
        ? `${document.source_type === "official_notice" ? "官方来源" : "参考链接"}：${document.source_url}`
        : "参考链接：未记录",
    ].join("\n");
  }).join("\n\n---\n\n");
}

function embeddingConfig() {
  const dimensions = Number(env("AI_EMBEDDING_DIMENSIONS", "1024"));
  return {
    enabled: env("AI_EMBEDDING_ENABLED", "true").toLowerCase() !== "false",
    apiKey: env("AI_EMBEDDING_API_KEY") || env("AI_API_KEY"),
    baseUrl: (env("AI_EMBEDDING_API_BASE_URL") || env("AI_API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")).replace(/\/$/, ""),
    model: env("AI_EMBEDDING_MODEL", "text-embedding-v4"),
    dimensions,
  };
}

async function createQuestionEmbedding(question: string) {
  const config = embeddingConfig();
  if (!config.enabled || !config.apiKey) return null;
  if (config.dimensions !== 1024) {
    console.warn("Semantic search disabled: AI_EMBEDDING_DIMENSIONS must be 1024");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: question,
        dimensions: config.dimensions,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      console.warn("Embedding request failed", response.status, payload);
      return null;
    }
    const data = Array.isArray(payload.data) ? payload.data : [];
    const embedding = (data[0] as Record<string, unknown> | undefined)?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== config.dimensions) {
      console.warn("Embedding response has unexpected dimensions");
      return null;
    }
    return embedding as number[];
  } catch (error) {
    console.warn("Semantic search unavailable; falling back to keywords", error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function semanticSearch(question: string): Promise<SemanticMatch[]> {
  const embedding = await createQuestionEmbedding(question);
  if (!embedding) return [];
  const threshold = Math.max(0, Math.min(Number(env("AI_SEMANTIC_THRESHOLD", "0.55")) || 0.55, 1));
  const response = await restRequest("rpc/match_knowledge_chunks", {
    method: "POST",
    body: JSON.stringify({
      p_query_embedding: embedding,
      p_match_threshold: threshold,
      p_match_count: 12,
    }),
  });
  if (!response.ok) {
    console.warn("Semantic RPC unavailable; falling back to keywords", await response.text());
    return [];
  }
  return response.json();
}

function fuseMatches(
  keywordMatches: Array<KnowledgeDocument & { retrieval_score: number }>,
  semanticMatches: SemanticMatch[],
  limit = 5,
): RetrievalMatch[] {
  const combined = new Map<string, RetrievalMatch & { keyword_rank?: number; semantic_rank?: number }>();

  keywordMatches.forEach((document, rank) => {
    const keywordStrength = Math.min(document.retrieval_score / 20, 1);
    combined.set(document.slug, {
      ...document,
      retrieval_score: keywordStrength * 0.35 + 0.35 / (rank + 1),
      retrieval_method: "keyword",
      keyword_rank: rank,
    });
  });

  const seenSemanticDocuments = new Set<string>();
  semanticMatches.forEach((row, rank) => {
    if (seenSemanticDocuments.has(row.slug)) return;
    seenSemanticDocuments.add(row.slug);
    const existing = combined.get(row.slug);
    const semanticStrength = Math.max(0, Math.min(Number(row.semantic_score) || 0, 1));
    const semanticContribution = semanticStrength * 0.65 + 0.35 / (rank + 1);
    if (existing) {
      combined.set(row.slug, {
        ...existing,
        id: row.document_id,
        content: row.content,
        source_url: row.source_url,
        source_date: row.source_date,
        verified_at: row.verified_at,
        source_type: row.source_type || "curated",
        effective_from: row.effective_from || null,
        effective_until: row.effective_until || null,
        metadata: row.metadata || null,
        chunk_id: row.chunk_id,
        semantic_score: semanticStrength,
        semantic_rank: rank,
        retrieval_score: existing.retrieval_score + semanticContribution,
        retrieval_method: "hybrid",
      });
    } else {
      combined.set(row.slug, {
        id: row.document_id,
        slug: row.slug,
        title: row.title,
        category: row.category,
        summary: "",
        content: row.content,
        source_url: row.source_url,
        source_date: row.source_date,
        verified_at: row.verified_at,
        source_type: row.source_type || "curated",
        effective_from: row.effective_from || null,
        effective_until: row.effective_until || null,
        metadata: row.metadata || null,
        chunk_id: row.chunk_id,
        semantic_score: semanticStrength,
        semantic_rank: rank,
        retrieval_score: semanticContribution,
        retrieval_method: "semantic",
      });
    }
  });

  return [...combined.values()]
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, limit)
    .map(({ keyword_rank: _keywordRank, semantic_rank: _semanticRank, ...match }) => match);
}

async function retrieveKnowledge(question: string, documents: KnowledgeDocument[]) {
  const keywordMatches = rankDocuments(question, documents, 8) as Array<KnowledgeDocument & { retrieval_score: number }>;
  let semanticMatches: SemanticMatch[] = [];
  try {
    semanticMatches = await semanticSearch(question);
  } catch (error) {
    console.warn("Semantic search failed; continuing with keyword results", error);
  }
  const documentsBySlug = new Map(documents.map((document) => [document.slug, document]));
  // RPC 只返回切片字段。这里用经过有效期过滤的文章补回来源性质，
  // 同时丢弃已过期或尚未生效文章的语义结果。
  semanticMatches = semanticMatches.flatMap((row) => {
    const document = documentsBySlug.get(row.slug);
    return document ? [{ ...document, ...row, content: row.content }] : [];
  });
  return {
    matches: fuseMatches(keywordMatches, semanticMatches, 5),
    mode: semanticMatches.length > 0 ? "hybrid" : "keyword",
  };
}

function redactQuestion(question: string) {
  return question
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[手机号]")
    .replace(/(^|\D)\d{8,20}(?!\d)/g, "$1[编号]")
    .slice(0, 500);
}

function classifyTopic(question: string) {
  const groups: Array<[string, RegExp]> = [
    ["学生组织", /学生会|研究生会|社团|团委|志愿者|学生组织/],
    ["教学与考试", /选课|课程|考试|补考|重修|成绩|学分|教务/],
    ["宿舍生活", /宿舍|公寓|门禁|水电|报修|调宿/],
    ["奖助与就业", /奖学金|助学金|贷款|勤工|就业|招聘|实习/],
    ["入学与学籍", /报到|新生|学籍|转专业|休学|复学|毕业|档案/],
    ["校园服务", /食堂|图书馆|校医院|一卡通|校园网|快递|地图/],
  ];
  return groups.find(([, pattern]) => pattern.test(question))?.[0] || "其他";
}

async function recordUnansweredQuestion(question: string) {
  try {
    const sample = redactQuestion(question);
    const normalized = normalizeText(sample).slice(0, 500) || "未分类问题";
    const questionHash = await sha256(`${env("AI_RATE_LIMIT_SALT")}:unanswered:${normalized}`);
    const response = await restRequest("rpc/record_unanswered_question", {
      method: "POST",
      body: JSON.stringify({
        p_question_hash: questionHash,
        p_sample_question: sample,
        p_normalized_question: normalized,
        p_topic: classifyTopic(sample),
        p_metadata: { source: "campus-ai" },
      }),
    });
    if (!response.ok) console.warn("Unanswered question log failed", await response.text());
  } catch (error) {
    console.warn("Unanswered question log failed", error);
  }
}

function systemInstructions() {
  return [
    "你是‘山商信息通’内置的校园信息助手，服务山东工商学院学生。",
    "你只能依据本次提供的校园资料作答，不得使用记忆补充学校政策、时间、地点、电话或办理规则。",
    "回答应直接、简洁、适合学生阅读。涉及流程时使用短列表。",
    "每个事实结论后用 [1]、[2] 这样的编号标注对应资料；编号必须来自提供的资料。",
    "资料不足、相互冲突或已经可能过期时，明确说‘现有知识库无法确认’，并建议查看列出的官方来源。",
    "资料性质标为‘学生整理资料’时，要用‘学生整理资料显示’或‘可作为参考’来表述，不得说成学校官方规定或固定承诺。",
    "公交线路、食堂档口、营业时间和价格属于动态信息，应提醒用户出发或到店前核对实时信息。不要把学生评论当成官方政策。",
    "不要索取或复述学号、身份证号、手机号等个人信息。",
    "结尾固定补充：‘本站为学生自发整理，具体办理以学校官方最新通知为准。’",
  ].join("\n");
}

function extractResponseText(payload: Record<string, unknown>, style: string) {
  if (style === "responses") {
    if (typeof payload.output_text === "string") return payload.output_text.trim();
    const output = Array.isArray(payload.output) ? payload.output : [];
    const parts: string[] = [];
    for (const item of output as Array<Record<string, unknown>>) {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "output_text" && typeof block.text === "string") parts.push(block.text);
      }
    }
    return parts.join("\n").trim();
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content.trim() : "";
}

async function callModel(question: string, context: string, clientHash: string) {
  const apiKey = env("AI_API_KEY");
  const model = env("AI_MODEL");
  const baseUrl = env("AI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const style = env("AI_API_STYLE", "responses").toLowerCase();
  if (!apiKey || !model) throw new Error("AI_API_KEY 或 AI_MODEL 尚未配置");
  if (!["responses", "chat_completions"].includes(style)) throw new Error("AI_API_STYLE 配置无效");

  const userInput = `学生问题：\n${question}\n\n可用校园资料：\n${context}`;
  const body = style === "responses"
    ? {
        model,
        instructions: systemInstructions(),
        input: userInput,
        max_output_tokens: 900,
        store: false,
        safety_identifier: clientHash.slice(0, 64),
      }
    : {
        model,
        messages: [
          { role: "system", content: systemInstructions() },
          { role: "user", content: userInput },
        ],
        max_tokens: 900,
        temperature: 0.2,
      };

  const configuredTimeout = Number(env("AI_MODEL_TIMEOUT_MS", "55000"));
  const modelTimeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(Math.max(configuredTimeout, 10000), 90000)
    : 55000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), modelTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/${style === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CampusAIError("MODEL_TIMEOUT", `模型服务在 ${modelTimeoutMs}ms 内未响应`);
      }
      throw new CampusAIError("MODEL_NETWORK", error instanceof Error ? error.message : "模型网络请求失败");
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload.error as Record<string, unknown> | undefined;
      const detail = typeof error?.message === "string" ? error.message : `模型服务返回 ${response.status}`;
      if (response.status === 429) throw new CampusAIError("MODEL_BUSY", detail);
      if (response.status >= 500) throw new CampusAIError("MODEL_UPSTREAM", detail);
      throw new CampusAIError("MODEL_REJECTED", detail);
    }
    const answer = extractResponseText(payload, style);
    if (!answer) throw new Error("模型没有返回可显示的文字");
    return { answer, model, provider: env("AI_PROVIDER", new URL(baseUrl).hostname), style };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function logUsage(entry: Record<string, unknown>) {
  try {
    await restRequest("ai_usage", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(entry),
    });
  } catch (error) {
    console.warn("AI usage log failed", error);
  }
}

Deno.serve(async (request: Request) => {
  const origin = allowedOrigin(request);
  if (origin === "") return jsonResponse({ error: "该来源不允许调用校园助手" }, 403, null);
  if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 200, origin);
  if (request.method !== "POST") return jsonResponse({ error: "只支持 POST 请求" }, 405, origin);

  const providedKey = request.headers.get("apikey") || "";
  if (!await hasValidPublicKey(providedKey)) {
    return jsonResponse({ error: "无效的站点访问凭据" }, 401, origin);
  }

  const startedAt = Date.now();
  let clientHash = "unknown";
  try {
    const payload = await request.json();
    const question = String(payload?.question || "").trim();
    const clientId = String(payload?.clientId || "").trim();
    if (question.length < 2 || question.length > 500) {
      return jsonResponse({ error: "问题长度需要在 2～500 个字符之间" }, 400, origin);
    }
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(clientId)) {
      return jsonResponse({ error: "匿名设备标识无效" }, 400, origin);
    }

    const salt = env("AI_RATE_LIMIT_SALT");
    if (!salt) throw new Error("AI_RATE_LIMIT_SALT 尚未配置");
    clientHash = await sha256(`${salt}:${clientId}`);

    const quota = await consumeQuota(clientHash);
    if (!quota?.allowed) {
      await logUsage({
        client_hash: clientHash,
        provider: "none",
        model: "none",
        status: "rate_limited",
        latency_ms: Date.now() - startedAt,
      });
      return jsonResponse({
        error: "本小时提问次数已用完，请稍后再试",
        remaining: 0,
        resetAt: quota?.reset_at || null,
      }, 429, origin);
    }

    const documents = await fetchKnowledge();
    const retrieval = await retrieveKnowledge(question, documents);
    const matches = retrieval.matches;
    if (matches.length === 0) {
      await recordUnansweredQuestion(question);
      await logUsage({
        client_hash: clientHash,
        provider: "none",
        model: "none",
        retrieval_count: 0,
        input_chars: question.length,
        output_chars: 0,
        latency_ms: Date.now() - startedAt,
        status: "no_match",
      });
      return jsonResponse({
        answer: "现有知识库暂未收录这个问题的可靠资料。这个问题已进入待补充清单；你也可以补充具体学院、部门或事项名称后重新提问。",
        sources: [],
        remaining: quota.remaining,
        noMatch: true,
        answerMode: "no_match",
      }, 200, origin);
    }

    const result = await callModel(question, buildContext(matches), clientHash);
    const sources = matches.map((document, index) => ({
      index: index + 1,
      slug: document.slug,
      title: document.title,
      category: document.category,
      url: document.source_url,
      sourceDate: document.source_date,
      verifiedAt: document.verified_at,
      sourceType: document.source_type,
      sourceLabel: typeof document.metadata?.source_name === "string" ? document.metadata.source_name : sourceKind(document),
      retrievalMethod: document.retrieval_method,
    }));

    await logUsage({
      client_hash: clientHash,
      provider: result.provider,
      model: result.model,
      retrieval_count: matches.length,
      input_chars: question.length,
      output_chars: result.answer.length,
      latency_ms: Date.now() - startedAt,
      status: "ok",
    });

    return jsonResponse({
      answer: result.answer,
      sources,
      remaining: quota.remaining,
      answerMode: "knowledge",
      retrievalMode: retrieval.mode,
    }, 200, origin);
  } catch (error) {
    console.error("campus-ai failed", error);
    await logUsage({
      client_hash: clientHash,
      provider: env("AI_PROVIDER", "unknown"),
      model: env("AI_MODEL", "unknown"),
      latency_ms: Date.now() - startedAt,
      status: "error",
    });
    const message = error instanceof Error ? error.message : "校园助手暂时不可用";
    const code = error instanceof CampusAIError ? error.code : "UNKNOWN";
    const publicMessage = message.includes("尚未配置")
      ? "校园助手尚未完成模型配置，请联系站点维护者"
      : code === "MODEL_TIMEOUT"
      ? "模型本次响应超时，请点击“再次提问”重试"
      : ["MODEL_BUSY", "MODEL_UPSTREAM", "MODEL_NETWORK"].includes(code)
      ? "模型服务当前繁忙，请稍后点击“再次提问”重试"
      : "校园助手暂时不可用，请稍后再试";
    return jsonResponse({ error: publicMessage }, 500, origin);
  }
});
