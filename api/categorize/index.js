// Restrict if you want
  // if (!email.endsWith('@uwaterloo.ca')) {
  //   context.res = { status: 403, body: { error: 'Access restricted' } };
  //   return;
  // }
const fetch = require('node-fetch');

const MAX_CHARS = 4000;

module.exports = async function (context, req) {
  try {
    // 🔑 Identity (optional)
    const clientPrincipalHeader = req.headers['x-ms-client-principal'];
    let email = '';
    if (clientPrincipalHeader) {
      const decoded = Buffer.from(clientPrincipalHeader, 'base64').toString('ascii');
      const clientPrincipal = JSON.parse(decoded);
      email = clientPrincipal.userDetails || '';
    }

    const entries = req.body.entries || [];
    const texts = entries.map(e => e.text);

    // batching
    const batches = [];
    let currentBatch = [];
    let currentLength = 0;
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
    const debugMode = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';

    for (const batch of batches) {
      const prompt = buildPrompt(batch);

      if (debugMode) {
        console.log('DEBUG: Would send prompt to OpenAI:\n', prompt);
        results.push(...batch.map(text => ({ text, category: 'DEBUG' })));
      } else {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2
          })
        });

        const data = await response.json();

        if (!response.ok) {
          // Bubble up OpenAI error
          throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
        }

        if (!data.choices || !data.choices[0]?.message?.content) {
          throw new Error(`Unexpected OpenAI response: ${JSON.stringify(data)}`);
        }

        const parsed = safeParse(data.choices[0].message.content);
        results.push(...parsed);
      }
    }

    context.res = {
      headers: { 'Content-Type': 'application/json' },
      body: { success: true, results }
    };
  } catch (err) {
    console.error('Function error:', err);
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, error: err.message }
    };
  }
};

function buildPrompt(batch) {
  return `Considering the two design process definitions given below:
- Problem (PROB): Any activities that enable designers to understand both the broad and specific attributes of the problem they are solving: Problem analysis, identifying requirements and constraints, search for and collect information
- Solution (SOLN): Any activities that designers engage in that contribute to creating solutions for the problem: thinking up potential solutions, detail how to build solutions(s), build solutions, compare and contrast solutions, select final solution

Please categorize the following transcription snippets. Do not mark anything if it doesn't fit. Format as JSON array:
${JSON.stringify(batch.map(text => ({ text })), null, 2)}`;
}

function safeParse(content) {
  try {
    return JSON.parse(content);
  } catch {
    console.error('Failed to parse model output:', content);
    return [];
  }
}