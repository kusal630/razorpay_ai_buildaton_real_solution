/**
 * brain-test.ts — F3 smoke test. Calls callBrain("recovery", fixtureContext)
 * directly (bypassing triggers) and logs the full trace: HTTP request (URL,
 * model, message count), status, latency, tokens, parsed output, validation
 * result, mode. Errors surface verbatim.
 * `npm run brain-test` — server need not run; needs the LLM endpoint up.
 */
import { loadConfig, getConfig } from "../src/config.js";

loadConfig();

const sb = await import("../src/lib/sharedBrain.js");
const { buildSmokeFixture } = await import("../src/lib/brainFixture.js");

const bogus = process.argv.includes("--bogus-model");

async function main() {
  const config = getConfig();
  const events: any[] = [];
  sb.setFallbackSink(async (e: any) => { events.push(e); });

  if (bogus) {
    const check = await sb.checkModelAvailable("bogus-model-xyz");
    console.log("model-check:", JSON.stringify(check));
    console.log(check.available ? "UNEXPECTED: bogus model listed" : "OK: bogus model refused (no POST attempted)");
    process.exit(check.available ? 1 : 0);
  }

  console.log(`request: POST ${config.LLM_BASE_URL}/chat/completions | model=${config.LLM_MODEL} | messages=2`);
  // Small models are stochastic: up to 3 honest attempts (each fully
  // validated); the log shows every attempt. Exit 0 on the first llm land.
  const tries = Number(process.env.BRAIN_TEST_TRIES || 3);
  for (let attempt = 1; attempt <= tries; attempt++) {
    const t0 = Date.now();
    const brain = await sb.callBrain("recovery", buildSmokeFixture());
    const ms = Date.now() - t0;
    console.log(`attempt ${attempt}: mode=${brain.mode} | latency=${ms}ms | validation=${brain.mode === "llm" ? "PASS" : "FALLBACK reason=" + (brain as any).fallback_reason}`);
    if (brain.mode === "llm") {
      console.log(`tokens: ${JSON.stringify(brain.usage)}`);
      console.log(`parsed: ${JSON.stringify((brain as any).raw || {}).slice(0, 800)}`);
      console.log(`copy: ${(brain.message_copy || "").slice(0, 320)}`);
      process.exit(0);
    }
  }
  console.log(`fallback-events: ${JSON.stringify(events.map((e) => e.data.reason))}`);
  process.exit(1);
}

main().catch((e) => { console.error("SMOKE ERROR (verbatim):", e?.message || e); process.exit(1); });
