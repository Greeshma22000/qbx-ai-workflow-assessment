const { mockLlm } = require("./llm/mockLlm");
const { safeParse } = require("./llm/schema");
const { TOOL_REGISTRY } = require("./tools/tools");
const {
  detectPromptInjection,
  enforceToolAllowlist,
  validateLlmResponse
} = require("./guardrails");

/**
 * runAgentForItem(ticket, config)
 *
 * config:
 *  - maxToolCalls
 *  - maxLlmAttempts
 */
async function runAgentForItem(ticket, config) {
  const maxToolCalls = config?.maxToolCalls ?? 3;
  const maxLlmAttempts = config?.maxLlmAttempts ?? 3;

  const plan = [];
  const tool_calls = [];
  const safety = { blocked: false, reasons: [] };

  // Step 1: prompt injection detection — reject before touching LLM or tools
  const injectionIssues = detectPromptInjection(ticket.user_request);
  if (injectionIssues.length > 0) {
    safety.blocked = true;
    safety.reasons = injectionIssues;
    plan.push("Rejected: prompt injection detected in user request");
    return {
      id: ticket.id,
      status: "REJECTED",
      plan,
      tool_calls: [],
      final: { action: "REFUSE", payload: { reason: "Prompt injection detected." } },
      safety
    };
  }

  // Step 2: build initial messages
  const allowedTools = ticket.context?.allowed_tools ?? [];
  const policy = ticket.context?.policy ?? "";

  const messages = [
    {
      role: "system",
      content: `You are an automation agent. Policy: ${policy}. Available tools: ${allowedTools.join(", ")}. Respond with valid JSON only.`
    },
    {
      role: "user",
      content: ticket.user_request
    }
  ];

  plan.push(`Processing request: ${ticket.user_request}`);

  // Step 3: bounded agent loop
  let attempts = 0;
  let toolCallCount = 0;

  while (attempts < maxLlmAttempts) {
    attempts++;

    const raw = await mockLlm(messages);
    const parsed = safeParse(raw);

    if (!parsed.ok) {
      plan.push(`Attempt ${attempts}: malformed LLM response`);
      if (attempts >= maxLlmAttempts) {
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: { action: "REFUSE", payload: { reason: "LLM returned malformed response after max attempts." } },
          safety
        };
      }
      messages.push({
        role: "system",
        content: "Your previous response was not valid JSON. You MUST respond with a valid JSON object only."
      });
      continue;
    }

    const validation = validateLlmResponse(parsed.value);

    if (!validation.ok) {
      plan.push(`Attempt ${attempts}: invalid LLM response schema — ${validation.reason}`);
      if (attempts >= maxLlmAttempts) {
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: { action: "REFUSE", payload: { reason: "LLM returned invalid schema after max attempts." } },
          safety
        };
      }
      messages.push({
        role: "system",
        content: `Your previous response did not match the required schema: ${validation.reason}. Respond with a valid tool_call or final JSON object.`
      });
      continue;
    }

    if (validation.type === "tool_call") {
      const { tool, args } = parsed.value;

      if (!enforceToolAllowlist(tool, allowedTools)) {
        plan.push(`Rejected: tool "${tool}" is not in the allowlist`);
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: { action: "REFUSE", payload: { reason: `Tool "${tool}" is not allowed for this ticket.` } },
          safety
        };
      }

      if (toolCallCount >= maxToolCalls) {
        plan.push("Rejected: maximum tool calls exceeded");
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: { action: "REFUSE", payload: { reason: "Maximum tool calls exceeded." } },
          safety
        };
      }

      plan.push(`Calling tool: ${tool}`);
      const toolResult = await TOOL_REGISTRY[tool](args);
      toolCallCount++;
      tool_calls.push({ tool, args });

      // Feed the tool call and result back into the conversation.
      // Replace the user message so keyword-based checks (e.g. "latest report")
      // don't re-fire on subsequent LLM calls, allowing the TOOL_RESULT branch
      // of the mock LLM to take effect.
      messages.push({ role: "assistant", content: JSON.stringify(parsed.value) });
      messages.push({ role: "assistant", content: "TOOL_RESULT: " + JSON.stringify(toolResult) });
      const userMsgIdx = messages.findIndex((m) => m.role === "user");
      if (userMsgIdx !== -1) {
        messages[userMsgIdx] = {
          role: "user",
          content: "Based on the retrieved context above, determine and return the final action."
        };
      }
      continue;
    }

    if (validation.type === "final") {
      const { action, payload } = parsed.value.final;
      plan.push(`Final action: ${action}`);
      return {
        id: ticket.id,
        status: "DONE",
        plan,
        tool_calls,
        final: { action, payload },
        safety
      };
    }
  }

  // Exhausted all attempts without a final answer
  return {
    id: ticket.id,
    status: "REJECTED",
    plan,
    tool_calls,
    final: { action: "REFUSE", payload: { reason: "Max LLM attempts reached without a valid response." } },
    safety
  };
}

module.exports = {
  runAgentForItem
};