// Per-role user-prompt builders + output-shape parsers (T2b).
//
// Each builder takes (task, persona, contextHints) and returns the user message.
// Each parser takes the model's finalText and returns a structured object
// describing what the dispatcher should do (board writes, follow-ups, etc.).

const COMMON_STOP_GUIDANCE = `
[TOOL USE — read carefully]
- Use tools to ground your answer in real graph/source state, not to enumerate the catalog.
- After 1-3 successful tool calls, COMMIT to an answer. Do not keep gathering.
- If a tool returns 'Nothing found' or 404, the entity does not exist — DO NOT retry with variations of the name; treat the absence as fact and proceed.
- You may ONLY reference ids that came from a prior tool result. Do NOT invent ids (no epic-42, no node-foo).
- When you have what you need, emit your final response per your role's output shape and STOP calling tools.`.trim();

// ── CPM ───────────────────────────────────────────────────────────────────
// 4 output shapes: new_epic | new_story | new_task | closer_response

export function buildCpmPrompt(task, persona /*, hints*/) {
  return `[ASK FROM CHET]
${task.title}

[INTENT]
${task.description || "(none)"}

[YOUR JOB]
Decide which of FOUR output shapes fits this Ask. Use your tools (agile_epic_list, agile_story_list_by_epic, decision_recent) to browse existing work BEFORE deciding so you don't duplicate.

  A) new_epic + first Story         — brand-new intent, no existing Epic fits
  B) new_story under existing Epic  — intent fits an active Epic's scope
  C) new_task under existing Story  — intent is a small addition to in-flight work
  D) closer_response                — this Task carries a CLOSER verdict (see slot below)

If unsure between A and B, prefer B (attaching is cheaper to revert than a duplicate Epic).

[CLOSER VERDICT, if any]
${task._closer_decision_body || "(none — this is intake mode)"}

${COMMON_STOP_GUIDANCE}

[OUTPUT — emit ONE fenced JSON block, nothing else]
\`\`\`json
For A: {"shape":"new_epic","epic":{"id":"<slug>","title":"...","description":"...","goal":"..."},
        "first_story":{"id":"<slug>","title":"...","description":"...","acceptance_criteria":"...",
                       "role_hint":"pm","assignee_id":"<env>-pm"}}
For B: {"shape":"new_story","parent_epic_id":"<existing-id-from-tools>",
        "story":{"id":"<slug>","title":"...","description":"...","acceptance_criteria":"...",
                 "role_hint":"...","assignee_id":"<env>-<role>"}}
For C: {"shape":"new_task","parent_story_id":"<existing-id-from-tools>",
        "task":{"id":"<slug>","title":"...","description":"...","acceptance_criteria":"...",
                "role_hint":"..."}}
For D: {"shape":"closer_response","verdict":"accept|redirect|escalate",
        "decision_id":"<the closer decision id>","detail":"..."}
\`\`\``;
}

// ── PM ────────────────────────────────────────────────────────────────────
// Output: epic_decomposition with skip-already-covered

export function buildPmPrompt(task, persona, hints) {
  const existingStories = hints?.existing_stories_under_epic || "(call agile_story_list_by_epic with this Epic's id)";
  return `[EPIC]
${hints?.epic?.title || "(call agile_epic_get with the Task's parent_epic_id from CPM)"}

[EXISTING STORIES UNDER THIS EPIC]
${existingStories}

[CPM's FRAMING]
${task.description || "(none)"}

${COMMON_STOP_GUIDANCE}

[YOUR JOB]
First line: "Story acceptance criteria as I read them: <bulleted list of the Task's AC>"
Second line: "What I am building in this turn: <one sentence>"

Decompose what's MISSING from the existing Story set. If the Epic is already well-decomposed and the only ask is "add Stories for X", scope your work to that gap. Apply scope guard + restate AC.

[PUSHBACK — when you cannot decompose as briefed]
If the Epic framing has a load-bearing flaw you cannot work around, do NOT emit a low-quality decomposition. Emit shape:"pm_pushback" instead. Pushback MUST name a CONCRETE change CPM should make (not just "this is wrong"). The dispatcher will route your pushback back to CPM and increment a per-Epic counter. Three pushbacks on the same Epic escalate to CLOSER for a Decision — so use pushback only when the framing is genuinely unworkable, not when you would prefer a different phrasing.

[OUTPUT — emit ONE fenced JSON block]
For a normal decomposition:
\`\`\`json
{
  "shape":"epic_decomposition",
  "skipped_already_covered":["<existing-story-id>", ...],
  "new_stories":[
    {
      "story":{"id":"<slug>","title":"...","description":"...","goal":"...","size":"S|M|L",
               "acceptance_criteria":"...","role_hint":"tl|be|fe|do|qa|doc",
               "assignee_id":"<env>-<role>"},
      "tasks":[
        {"id":"<slug>","title":"...","description":"...","acceptance_criteria":"...","role_hint":"..."}
      ]
    }
  ],
  "rationale":"<one short paragraph>"
}
\`\`\`

For a pushback to CPM (use sparingly):
\`\`\`json
{
  "shape":"pm_pushback",
  "epic_id":"<the Epic id you were asked to decompose>",
  "concrete_change":"<one sentence: what specifically about CPM's framing needs to change>",
  "reason":"<one paragraph: why you cannot proceed as briefed>"
}
\`\`\``;
}

// ── TL ────────────────────────────────────────────────────────────────────
// Two modes: plan (Story -> brief) or review (BE/FE/DO submission -> verdict)

export function buildTlPrompt(task, persona, hints) {
  const submission = hints?.submission_to_review;
  if (submission) {
    return `[STORY]
${hints?.story?.title || task.title}
acceptance_criteria: ${hints?.story?.acceptance_criteria || task.acceptance_criteria || "(none)"}

[SUBMISSION FOR REVIEW]
${submission}

[TEST OUTPUT, if any]
${hints?.test_output || "(no test_output attached)"}

${COMMON_STOP_GUIDANCE}

[YOUR JOB]
First line: "Story acceptance criteria as I read them: <bulleted list>"
Second line: "What I am reviewing in this turn: <one sentence>"

Emit ONE fenced JSON block:
\`\`\`json
{"shape":"tl_review","verdict":"APPROVE|REQUEST_CHANGES|REJECT",
 "red_flag":"<name or null>","defects":["..."],"notes":"..."}
\`\`\``;
  }
  // Plan mode
  return `[STORY]
${hints?.story?.title || task.title}
${hints?.story?.description || task.description || ""}
goal: ${hints?.story?.goal || "(none)"}
acceptance_criteria: ${hints?.story?.acceptance_criteria || task.acceptance_criteria || "(none)"}

[HOMELAB CONTEXT]
${hints?.homelab_context || "(none injected; use xray/host/service as needed)"}

${COMMON_STOP_GUIDANCE}

[YOUR JOB — plan mode]
First line: "Story acceptance criteria as I read them: <bulleted list>"
Second line: "What I am building in this turn: <one sentence>"

Emit ONE fenced JSON block:
\`\`\`json
{"shape":"tl_brief",
 "steps":[{"what":"...","how":"...","verify":"...","rollback":"..."}],
 "contract":{...},"affected_components":[...],"risks":[...],
 "target_repo":"<absolute path under /10310L/repos>","target_doc":"none|skill:<name>|readme:<repo>|adr:<id>"}
\`\`\``;
}

// ── BE / FE / DO — implementer ────────────────────────────────────────────

function buildImplementerPrompt(task, persona, hints, roleLabel) {
  return `[STORY]
${hints?.story?.title || task.title}
acceptance_criteria: ${hints?.story?.acceptance_criteria || task.acceptance_criteria || "(none)"}

[TL BRIEF — the contract you are implementing]
${hints?.tl_brief || task.description || "(missing — file a clarification request)"}

[REPO CONTEXT]
${hints?.repo_context || "(use file_tree + file_read against the target_repo from the brief)"}

${COMMON_STOP_GUIDANCE}

[YOUR JOB — ${roleLabel} implementer]
First line: "Story acceptance criteria as I read them: <bulleted list>"
Second line: "What I am building in this turn: <one sentence>"

Emit a unified diff against the target repo, then a JSON block:
\`\`\`diff
--- a/path/to/file
+++ b/path/to/file
@@ ... @@
-old
+new
\`\`\`
\`\`\`json
{"shape":"${roleLabel}_implementation","target_repo":"...",
 "test_command":"<how to run the tests; or null>",
 "ac_coverage":[{"ac":"<bullet>","covered":true|false,"note":"..."}],
 "red_flag_retreat": null }
\`\`\`
If you decide your draft trips a red_flag (per your system_prompt), DO NOT submit code. Set red_flag_retreat to the name and omit the diff.`;
}

export const buildBePrompt = (t, p, h) => buildImplementerPrompt(t, p, h, "be");
export const buildFePrompt = (t, p, h) => buildImplementerPrompt(t, p, h, "fe");
export const buildDoPrompt = (t, p, h) => buildImplementerPrompt(t, p, h, "do");

// ── QA — reviewer ────────────────────────────────────────────────────────

export function buildQaPrompt(task, persona, hints) {
  return `[STORY]
${hints?.story?.title || task.title}
acceptance_criteria: ${hints?.story?.acceptance_criteria || task.acceptance_criteria || "(none)"}

[IMPLEMENTATION TO REVIEW]
${hints?.implementation_body || "(missing — return needs_evidence)"}

[TEST OUTPUT]
${hints?.test_output || "(none — return needs_evidence if the verdict depends on it)"}

[RED-FLAG HISTORY ON THIS STORY]
${hints?.red_flag_history || "(none)"}

[RELEVANT LESSONS]
${hints?.relevant_lessons || "(qdrant retrieval pending — none for this turn)"}

${COMMON_STOP_GUIDANCE}

[YOUR JOB — strict reviewer]
Per your system_prompt: approval bar is 'this implementation achieves the Story's underlying goal without introducing a risk the team did not notice.' Verdict lexicon: approve | revise | reject | needs_evidence. Max 2 blocking defects on revise. Apply the reviewer-no-fabrication rule strictly.

[OUTPUT — ONE fenced JSON block, no prose outside]
\`\`\`json
{"shape":"qa_verdict","verdict":"approve|revise|reject|needs_evidence",
 "defects":["..."], "red_flag":"<name or null>", "notes":"..."}
\`\`\``;
}

// ── DOC — writer with two verdicts ────────────────────────────────────────

export function buildDocPrompt(task, persona, hints) {
  return `[STORY signed off]
${hints?.story?.title || task.title}
goal: ${hints?.story?.goal || "(none)"}
acceptance_criteria: ${hints?.story?.acceptance_criteria || task.acceptance_criteria || "(none)"}

[WHAT SHIPPED]
${hints?.shipped_summary || "(use file_read on the diffed paths in this Story's Tasks)"}

[CANDIDATE DOCS TO TOUCH]
${hints?.candidate_docs || "(target_doc from TL brief; or scan likely paths)"}

${COMMON_STOP_GUIDANCE}

[YOUR JOB]
Per your system_prompt: match voice + structure, keep YAML frontmatter intact, prefer adding callout over creating new skill.

[OUTPUT — ONE fenced JSON block, plus the diff if shape is doc_diff]
\`\`\`diff
--- a/<doc-path>
+++ b/<doc-path>
@@ ... @@
... your doc changes ...
\`\`\`
\`\`\`json
{"shape":"doc_diff",
 "verdict":"docs-ready|docs-ready-needs-review|needs-source-clarification",
 "target_doc":"<chosen target>","rationale":"<one paragraph>",
 "missing":"<for needs-source-clarification: what you need from the implementer>"}
\`\`\``;
}

// ── CLOSER — alignment ────────────────────────────────────────────────────

export function buildCloserPrompt(task, persona, hints) {
  // The CLOSER v7 system_prompt is already very explicit about envelope shapes.
  // Dispatcher injects the envelope structure (sprint_close vs blocker_file).
  const env = hints?.envelope || { mode: "(missing — dispatcher should inject)" };
  return `[ENVELOPE — ${env.mode || "sprint_close"} mode]
${JSON.stringify(env, null, 2)}

${COMMON_STOP_GUIDANCE}

Per your system_prompt: emit ONE JSON object with the strict verdict lexicon. No prose outside.`;
}

// ── Dispatch table ────────────────────────────────────────────────────────

export const PROMPT_BUILDERS = {
  cpm: buildCpmPrompt,
  pm:  buildPmPrompt,
  tl:  buildTlPrompt,
  be:  buildBePrompt,
  fe:  buildFePrompt,
  do:  buildDoPrompt,
  qa:  buildQaPrompt,
  doc: buildDocPrompt,
  closer: buildCloserPrompt,
};

// ── Output parser ─────────────────────────────────────────────────────────

const FENCED_JSON_RE = /```json\s*\n([\s\S]+?)\n```/;
const FENCED_DIFF_RE = /```diff\s*\n([\s\S]+?)\n```/;

export function parseOutput(roleHint, finalText) {
  if (!finalText || finalText.length < 10) {
    return { ok: false, error: "empty_or_short_response" };
  }
  const jsonMatch = finalText.match(FENCED_JSON_RE);
  if (!jsonMatch) {
    return { ok: false, error: "no_fenced_json_block", preview: finalText.slice(0, 300) };
  }
  let parsed;
  try { parsed = JSON.parse(jsonMatch[1]); }
  catch (e) {
    return { ok: false, error: `json_parse_failed: ${e.message}`, raw: jsonMatch[1].slice(0, 400) };
  }
  const diffMatch = finalText.match(FENCED_DIFF_RE);
  const diff = diffMatch ? diffMatch[1] : null;
  return { ok: true, shape: parsed.shape, parsed, diff };
}
