import Anthropic from "@anthropic-ai/sdk";
import PQueue from "p-queue";

const MAX_CHARS = 5000;

// Global queue
const globalQueue = new PQueue({interval: 1000, intervalCap: 1});

// Per-client quota (in-memory)
const clientUsage = new Map();

function checkAndIncrement(clientId) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour
    let record = clientUsage.get(clientId);

    if (!record || now > record.resetAt) {
        record = {count: 0, resetAt: now + windowMs};
    }

    // Different quota for anonymous vs identified
    const limit = clientId === "anonymous" ? 200 : 10;

    if (record.count >= limit) return false;

    record.count++;
    clientUsage.set(clientId, record);
    return true;
}

// Anthropic client
const anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

export default async function (context, req) {
    try {
        const body = req.body || {};
        const entries = Array.isArray(body.entries) ? body.entries : [];
        const texts = entries
            .map(e => (e && typeof e.text === "string" ? e.text : null))
            .filter(Boolean);

        // Identity
        const clientPrincipalHeader = req.headers["x-ms-client-principal"];
        let email = "anonymous";
        if (clientPrincipalHeader) {
            try {
                const decoded = Buffer.from(clientPrincipalHeader, "base64").toString("ascii");
                const clientPrincipal = JSON.parse(decoded);
                email = clientPrincipal.userDetails || "anonymous";
            } catch (err) {
                console.error("Failed to parse client principal:", err);
            }
        }

        // Per-client quota
        let clientId = "anonymous";
        if (clientPrincipalHeader) {
            try {
                const decoded = Buffer.from(clientPrincipalHeader, "base64").toString("ascii");
                const clientPrincipal = JSON.parse(decoded);
                clientId =
                    clientPrincipal.userId ||
                    clientPrincipal.claims?.find(c => c.typ.includes("nameidentifier"))?.val ||
                    "anonymous";
            } catch (err) {
                console.error("Failed to parse client principal:", err);
            }
        }

        if (!checkAndIncrement(clientId)) {
            context.res = {status: 429, body: {error: "Hourly limit exceeded"}};
            return;
        }

        // batching
        const batches = [];
        let currentBatch = [], currentLength = 0;
        for (const text of texts) {
            if (currentLength + text.length > MAX_CHARS) {
                batches.push(currentBatch);
                currentBatch = [];
                currentLength = 0;
            }
            currentBatch.push(text);
            currentLength += text.length;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);

        const debugMode = (process.env.DEBUG_MODE || "").toLowerCase() === "true";
        const debugApiMode = (process.env.DEBUG_API || "").toLowerCase() === "true";

        // Run all batches concurrently
        const batchPromises = batches.map(batch => globalQueue.add(async () => {
            const prompt = buildPrompt(batch);

            // If debugMode only (no API calls)
            if (debugMode && !debugApiMode) {
                // Return empty category instead of "DEBUG"
                return batch.map(text => ({text, category: ""}));
            }

            // Otherwise call Anthropic
            const response = await anthropic.messages.create({
                model: "claude-3-haiku-20240307",
                max_tokens: 3000, // reduced for speed/cost
                system: `You are a JSON-only classifier.
Always respond with a valid JSON array, no extra text or commentary.
Each element must be an object with keys "text" and "category".
Allowed categories: "PROB", "SOLN", or "" (empty string).`,
                messages: [{role: "user", content: prompt}],
            });

            const textBlock = response.content.find(c => c.type === "text");
            const content = textBlock?.text;
            if (!content) throw new Error("Unexpected Anthropic response");

            const parsed = safeParse(content, batch);

            // Attach debug info separately if requested
            if (debugApiMode) {
                return [
                    ...parsed,
                    {__debugPrompt: prompt, __debugApiResponse: content}
                ];
            }

            return parsed;
        }));

        const resultsNested = await Promise.all(batchPromises);
        const results = resultsNested.flat();

        context.res = {
            headers: {"Content-Type": "application/json"},
            body: {success: true, results}
        };
    } catch (err) {
        console.error("Function error:", err);
        context.res = {status: 500, body: {success: false, error: err.message}};
    }
};

function buildPrompt(batch) {
    return `Definitions:
- Problem (PROB): Activities that enable designers to understand the problem, analyze requirements, constraints, gather information.
- Solution (SOLN): Activities that contribute to creating solutions: generating ideas, detailing, building, comparing, selecting.

Example input:
[
  {"text": "We need to gather more requirements from the client."},
  {"text": "Let's brainstorm possible design alternatives."},
  {"text": "The weather is nice today."}
]

Example output:
[
  {"text": "We need to gather more requirements from the client.", "category": "PROB"},
  {"text": "Let's brainstorm possible design alternatives.", "category": "SOLN"},
  {"text": "The weather is nice today.", "category": ""}
]

Now categorize the following snippets:
${JSON.stringify(batch.map(text => ({text})), null, 2)}`;
}

function safeParse(content, batch) {
    try {
        return JSON.parse(content);
    } catch {
        // Try to extract JSON substring
        const match = content.match(/(\[.*\]|\{.*\})/s);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (err) {
                console.error("Failed to parse extracted JSON:", err);
            }
        }
        console.error("Failed to parse:", content);
        // Fallback: return original texts with empty category
        return batch.map(text => ({text, category: ""}));
    }
}