// pages/api/chat.js
import { PineconeClient } from '@pinecone-database/pinecone';
import { Configuration, OpenAIApi } from 'openai';
import { NextApiRequest, NextApiResponse } from 'next';

// We'll do a standard Next.js API route for SSE
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: `Method '${req.method}' Not Allowed` });
  }

  const { question } = req.query;
  if (!question) {
    return res.status(400).send('Missing question param.');
  }

  // Attempt to set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Some environments need flushHeaders
  if (res.flushHeaders) res.flushHeaders();

  try {
    // Init Pinecone
    const pinecone = new PineconeClient();
    await pinecone.init({
      apiKey: process.env.PINECONE_API_KEY,
      environment: process.env.PINECONE_ENV,
    });
    const index = pinecone.Index(process.env.PINECONE_INDEX);

    // Init OpenAI
    const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
    const openai = new OpenAIApi(configuration);

    // 1) Embed the question
    const embResponse = await openai.createEmbedding({
      model: 'text-embedding-ada-002',
      input: question,
    });
    const questionEmbedding = embResponse.data.data[0].embedding;

    // 2) Query Pinecone
    const queryResponse = await index.query({
      vector: questionEmbedding,
      topK: 5,
      includeMetadata: true,
      namespace: 'pdf-chatbot',
    });
    const matches = queryResponse.matches || [];
    let contextText = '';
    for (const match of matches) {
      if (match.metadata?.text) {
        contextText += match.metadata.text + '\n';
      }
    }
    if (contextText.trim() === '') {
      contextText = 'The document is empty or not relevant.';
    }

    // 3) Build ChatGPT prompt
    const messages = [
      { role: 'system', content: 'You are a helpful assistant. Use the provided document text to answer the question.' },
      { role: 'user', content: `${contextText}\nQuestion: ${question}\nAnswer:` },
    ];

    // 4) Call ChatGPT with streaming
    const chatCompletion = await openai.createChatCompletion(
      {
        model: 'gpt-3.5-turbo',
        messages,
        stream: true,
      },
      { responseType: 'stream' }
    );

    // 5) Pipe streaming data back to the client
    chatCompletion.data.on('data', (chunk) => {
      const payload = chunk.toString();
      const lines = payload.split('\n');
      for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        if (line.startsWith('data: [DONE]')) {
          // Signal the end
          res.write(`data: [DONE]\n\n`);
          return;
        }
        if (line.startsWith('data: ')) {
          const jsonStr = line.replace(/^data: /, '');
          try {
            const parsed = JSON.parse(jsonStr);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              res.write(`data: ${token}\n\n`);
            }
          } catch (err) {
            console.error('JSON parse error in SSE chunk', err);
          }
        }
      }
    });

    chatCompletion.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    chatCompletion.data.on('error', (err) => {
      console.error('Chat SSE error:', err);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
