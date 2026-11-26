import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AppError } from "../http/errors.ts";
import { NarrativeOutputSchema } from "./prompt.ts";
import type { LlmResult, NarrativeLlm } from "./types.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Models that accept the server-side `fallbacks` parameter; others would reject the request. */
const SUPPORTS_SERVER_FALLBACK = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;

/**
 * Claude-backed analyst. One structured-output call per narrative:
 *  - adaptive thinking lets the model reason over the facts before committing to hypotheses;
 *  - structured outputs guarantee the JSON shape (the narrator still re-validates);
 *  - server-side fallback keeps the endpoint answering if the primary model declines.
 */
export function createAnthropicLlm(apiKey: string, model: string, effort: Effort): NarrativeLlm {
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  const fallback = SUPPORTS_SERVER_FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};

  return {
    provider: "anthropic",
    model,
    effort,
    async complete({ system, user }): Promise<LlmResult> {
      let response;
      try {
        response = await client.beta.messages.parse({
          model,
          max_tokens: 16_000,
          ...fallback,
          thinking: { type: "adaptive" },
          output_config: { effort, format: betaZodOutputFormat(NarrativeOutputSchema) },
          system,
          messages: [{ role: "user", content: user }],
        });
      } catch (error) {
        throw mapError(error);
      }

      if (response.stop_reason === "refusal") {
        throw new AppError("LLM_REFUSED", "The model declined to analyze this data.");
      }
      if (response.stop_reason === "max_tokens" || response.parsed_output === null) {
        throw new AppError("LLM_UNAVAILABLE", "The model returned an incomplete analysis. Try again.");
      }
      return {
        output: response.parsed_output,
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

function mapError(error: unknown): AppError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AppError("LLM_UNAVAILABLE", "The LLM provider rejected the configured API key.", { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AppError("LLM_UNAVAILABLE", "The LLM provider is rate limiting requests. Try again shortly.", { retryAfterSeconds: 30, cause: error });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.APIConnectionError) {
    return new AppError("LLM_UNAVAILABLE", "Could not reach the LLM provider.", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new AppError("LLM_UNAVAILABLE", `The LLM provider returned an error (HTTP ${error.status ?? "unknown"}).`, { cause: error });
  }
  if (error instanceof AppError) return error;
  return new AppError("LLM_UNAVAILABLE", "The analysis could not be generated.", { cause: error });
}
