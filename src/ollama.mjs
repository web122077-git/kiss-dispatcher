// Ollama /api/chat with tool-call loop. Iterates until model emits no tool_calls
// or MAX_ITERATIONS hits. Per T2a of dispatcher-build-chosen-pattern-zdev-2026-05.

import { executeTool } from "./tools.mjs";

// Per-role max iterations — planners stop fast, coders may need more context-gathering.
// Smoke 2026-05-11 found qwen3-coder:30b chains 45 tool calls when cap is 8; cap of 4
// forces planner roles to commit. Coder roles still get 6 to read multiple files.
const MAX_ITERATIONS_BY_ROLE = { cpm: 4, pm: 4, tl: 6, be: 6, fe: 6, do: 6, qa: 4, doc: 4, closer: 5, openclaw: 4 };
const MAX_ITERATIONS_DEFAULT = 4;

// API shape: kiss-dispatcher speaks Ollama-native /api/chat by default. When
// the persona's ollamaUrl is the openclaw gateway (or any OpenAI-compatible
// endpoint), the dispatcher must POST to /v1/chat/completions and unwrap the
// OpenAI response shape (choices[0].message instead of message). The persona's
// api_shape field or ollamaUrl bearer token are passed through opts.

const PER_CALL_TIMEOUT_MS = 180_000; // 3 min per /api/chat round-trip

/**
 * Multi-turn chat with optional tool loop.
 *
 * @param {object} args
 * @param {string} args.ollamaUrl       Base URL (no trailing slash), e.g. http://10.50.50.11:11434
 * @param {string} args.model           Ollama model tag
 * @param {Array}  args.messages        Initial messages array (system + user)
 * @param {Array}  [args.tools]         OpenAI-format function schemas; omit for tool-free roles
 * @param {object} [args.options]       Ollama options (temperature, top_p, num_predict, ...)
 * @param {(level,msg,extra)=>void} [args.log]
 * @returns {Promise<{messages, finalText, iterations, toolCallsMade}>}
 */
export async function chatWithTools({ ollamaUrl, model, messages, tools, options = {}, log, apiShape, authBearer }) {
  const conv = messages.slice();
  const toolCallsMade = [];
  let iteration = 0;
  // Default to Ollama-native unless persona/env says otherwise.
  const shape = (apiShape || process.env.API_SHAPE || "ollama").toLowerCase();
  const useOpenAI = shape === "openai" || shape === "openai_compat";
  const chatPath = useOpenAI ? "/v1/chat/completions" : "/api/chat";

  const MAX_ITERATIONS = MAX_ITERATIONS_BY_ROLE[process.env.ROLE_HINT] ?? MAX_ITERATIONS_DEFAULT;
  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    // Build the per-shape body. OpenAI variant: max_tokens instead of options.num_predict;
    // top-level temperature/top_p instead of options.{...}.
    let body;
    if (useOpenAI) {
      body = { model, messages: conv, stream: false };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.top_p !== undefined) body.top_p = options.top_p;
      if (options.num_predict !== undefined) body.max_tokens = options.num_predict;
      if (tools && tools.length) body.tools = tools;
    } else {
      body = { model, messages: conv, stream: false, options };
      if (tools && tools.length) body.tools = tools;
    }

    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort("ollama timeout"), PER_CALL_TIMEOUT_MS);
    let resp;
    try {
      const headers = { "Content-Type": "application/json" };
      if (useOpenAI && authBearer) headers["Authorization"] = `Bearer ${authBearer}`;
      const r = await fetch(`${ollamaUrl}${chatPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`chat HTTP ${r.status} via ${chatPath}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      // Normalize: lift OpenAI choices[0].message into Ollama-shape resp.message.
      resp = useOpenAI ? { message: j?.choices?.[0]?.message ?? {} } : j;
    } finally {
      clearTimeout(tm);
    }

    const msg = resp.message || {};
    conv.push(msg);

    const tcs = msg.tool_calls || [];
    if (!tcs.length) {
      // Model is done.
      log?.("info", "chat_done", { iterations: iteration, content_len: (msg.content || "").length });
      return { messages: conv, finalText: msg.content || "", iterations: iteration, toolCallsMade };
    }

    // Execute each tool call sequentially; append a tool message per result.
    for (const tc of tcs) {
      const name = tc.function?.name || tc.name;
      let args = tc.function?.arguments ?? tc.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      args = args || {};
      log?.("info", "tool_call", { iteration, name, args });
      const result = await executeTool(name, args, process.env.ROLE_HINT);
      toolCallsMade.push({ iteration, name, args, result_len: typeof result === "string" ? result.length : 0 });
      conv.push({
        role: "tool",
        content: typeof result === "string" ? result : JSON.stringify(result),
        // tool_call_id / name vary per backend; Ollama accepts a plain tool message
        name,
      });
    }
  }

  // Iteration cap reached without the model emitting a tool-free response.
  log?.("warn", "tool_loop_cap_hit", { iterations: iteration, toolCallsMade: toolCallsMade.length });
  return {
    messages: conv,
    finalText: "",
    iterations: iteration,
    toolCallsMade,
    cap_hit: true,
  };
}
