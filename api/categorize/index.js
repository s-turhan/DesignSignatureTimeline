import Anthropic from "@anthropic-ai/sdk";
import PQueue from "p-queue";

const MAX_CHARS = 4000;

// Global queue
const globalQueue = new PQueue({interval: 1000, intervalCap: 1});

// Per-client quota (in-memory)
const clientUsage = new Map();

function checkAndIncrement(clientId) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    let record = clientUsage.get(clientId);
    if (!record || now > record.resetAt) {
        record = {count: 0, resetAt: now + windowMs};
    }
    if (record.count >= 10) return false;
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
        const texts = entries.map(e => e.text);

        // Identity
        const clientPrincipalHeader = req.headers["x-ms-client-principal"];
        let email = "anonymous";
        if (clientPrincipalHeader) {
            const decoded = Buffer.from(clientPrincipalHeader, "base64").toString("ascii");
            const clientPrincipal = JSON.parse(decoded);
            email = clientPrincipal.userDetails || "anonymous";
        }

        // Per-client quota
        if (!checkAndIncrement(email)) {
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

        const results = [];
        const debugMode = (process.env.DEBUG_MODE || "").toLowerCase() === "true";
        const debugApiMode = (process.env.DEBUG_API || "").toLowerCase() === "true";

        for (const batch of batches) {
            const prompt = buildPrompt(batch);

            if (debugMode) {
                console.log("DEBUG: Would send prompt to Anthropic:\n", prompt);
                results.push(...batch.map(text => ({text, category: "DEBUG"})));

                if (debugApiMode) {
                    // include prompt in response
                    results.push({__debugPrompt: prompt});
                }
            } else {
                const response = await globalQueue.add(() =>
                    anthropic.messages.create({
                        model: "claude-3-5-sonnet-20240620",
                        max_tokens: 500,
                        messages: [{role: "user", content: prompt}],
                    })
                );

                const content = response.content?.[0]?.text;
                if (!content) throw new Error("Unexpected Anthropic response");

                const parsed = safeParse(content);
                results.push(...parsed);

                if (debugApiMode) {
                    // include both prompt and raw API response
                    results.push({
                        __debugPrompt: prompt,
                        __debugApiResponse: content,
                    });
                }
            }
        }

        context.res = {headers: {"Content-Type": "application/json"}, body: {success: true, results}};
    } catch (err) {
        console.error("Function error:", err);
        context.res = {status: 500, body: {success: false, error: err.message}};
    }
};

function buildPrompt(batch) {
    return `Considering the two design process definitions given below:
- Problem (PROB): Any activities that enable designers to understand both the broad and specific attributes of the problem they are solving: Problem analysis, identifying requirements and constraints, search for and collect information
- Solution (SOLN): Any activities that designers engage in that contribute to creating solutions for the problem: thinking up potential solutions, detail how to build solutions(s), build solutions, compare and contrast solutions, select final solution

Please categorize the following transcription snippets. Do not mark anything if it doesn't fit. Format as JSON array:
${JSON.stringify(batch.map(text => ({text})), null, 2)}`;
}

function safeParse(content) {
    try {
        return JSON.parse(content);
    } catch {
        console.error("Failed to parse:", content);
        return [];
    }
}