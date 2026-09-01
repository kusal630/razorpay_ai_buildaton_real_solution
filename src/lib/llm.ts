import { getConfig } from "../config.js";
import { z } from "zod";

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMResponse {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function isCircuitOpen(): boolean {
  if (consecutiveFailures >= 3 && Date.now() < circuitOpenUntil) return true;
  if (consecutiveFailures >= 3 && Date.now() >= circuitOpenUntil) {
    consecutiveFailures = 0;
    return false;
  }
  return false;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= 3) {
    circuitOpenUntil = Date.now() + 60 * 1000;
  }
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

export async function callLLM(messages: LLMMessage[]): Promise<LLMResponse> {
  const config = getConfig();

  if (isCircuitOpen()) {
    throw new Error("LLM circuit breaker open, using fallback");
  }

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json() as any;
      recordSuccess();
      return {
        content: data.choices[0].message.content,
        usage: data.usage,
      };
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  recordFailure();
  throw lastError || new Error("LLM call failed");
}

export function parseLLMJson<T>(text: string, schema: z.ZodSchema<T>): T {
  // Extract JSON from markdown code blocks or raw text
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error("No JSON found in LLM output");
  const parsed = JSON.parse(jsonMatch[1].trim());
  return schema.parse(parsed);
}

export function isCircuitBreakerOpen(): boolean {
  return isCircuitOpen();
}
