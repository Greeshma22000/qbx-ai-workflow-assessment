const { isValidToolCall, isValidFinal } = require("./llm/schema");

const INJECTION_PATTERNS = [
  /ignore previous instructions/i,
  /reveal secrets/i,
  /override policy/i,
  /send confidential/i
];

/**
 * detectPromptInjection(text)
 *
 * Return array of detected issue codes (empty array if safe).
 */
function detectPromptInjection(text) {
  const matched = INJECTION_PATTERNS.some((pattern) => pattern.test(text));
  return matched ? ["PROMPT_INJECTION"] : [];
}

/**
 * enforceToolAllowlist(toolName, allowedTools)
 *
 * Return true if allowed, false otherwise.
 */
function enforceToolAllowlist(toolName, allowedTools) {
  return Array.isArray(allowedTools) && allowedTools.includes(toolName);
}

/**
 * validateLlmResponse(obj)
 *
 * Must return:
 * - { ok: true, type: "tool_call" } when obj is a valid tool call
 * - { ok: true, type: "final" } when obj is a valid final response
 * - { ok: false, reason: string } otherwise
 */
function validateLlmResponse(obj) {
  if (isValidToolCall(obj)) return { ok: true, type: "tool_call" };
  if (isValidFinal(obj)) return { ok: true, type: "final" };
  return { ok: false, reason: "Invalid LLM response schema" };
}

module.exports = {
  detectPromptInjection,
  enforceToolAllowlist,
  validateLlmResponse
};