// server.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const pdf = require('pdf-parse');
const { PineconeClient } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();

// For Vercel: Use /tmp/uploads/ as the upload directory
const uploadDir = '/tmp/uploads/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
});

app.use(cors());
app.use(express.json());

// Initialize Pinecone client
const pinecone = new PineconeClient();
(async () => {
  await pinecone.init({
    apiKey: process.env.PINECONE_API_KEY,
    environment: process.env.PINECONE_ENV
  });
})().catch(err => {
  console.error("Pinecone initialization error:", err);
});

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Utility: Split text into smaller chunks for embeddings
function splitTextIntoChunks(text, maxLength = 1000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end > text.length) end = text.length;
    let segment = text.slice(start, end);
    const lastNewline = segment.lastIndexOf("\n");
    const lastSpace = segment.lastIndexOf(" ");
    if (end < text.length && (lastNewline > 200 || lastSpace > 200)) {
      const cutIndex = lastNewline > 200 ? lastNewline : lastSpace;
      segment = text.slice(start, start + cutIndex);
      end = start + cutIndex;
    }
    chunks.push(segment.trim());
    start = end;
  }
  return chunks;
}

// PDF Upload and Processing route using pdf-parse
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    console.log(`Starting text extraction for file: ${file.path}`);
    const dataBuffer = fs.readFileSync(file.path);
    const data = await pdf(dataBuffer);
    const extractedText = data.text;
    console.log("Text extraction complete using pdf-parse.");

    const textChunks = splitTextIntoChunks(extractedText);
    console.log(`Document split into ${textChunks.length} chunks for embedding.`);

    const index = pinecone.Index(process.env.PINECONE_INDEX);
    const vectors = [];
    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      if (!chunk.trim()) continue;
      const embResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: chunk
      });
      const [embeddingData] = embResponse.data;
      const embedding = embeddingData.embedding;
      vectors.push({
        id: `chunk-${i}`,
        values: embedding,
        metadata: { text: chunk }
      });
    }
    if (vectors.length > 0) {
      await index.upsert({ vectors: vectors, namespace: "pdf-chatbot" });
    }
    console.log("Stored embeddings in Pinecone for the uploaded PDF.");
    res.status(200).json({ message: "PDF processed successfully", chunks: textChunks.length });
  } catch (err) {
    console.error("Error processing PDF:", err);
    res.status(500).json({ error: err.message });
  }
});

// Chat query route with streaming response
app.get('/chat', async (req, res) => {
  const question = req.query.question;
  if (!question) {
    return res.status(400).send("Question query parameter is required.");
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const qEmbResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: question
    });
    const [qEmbData] = qEmbResponse.data;
    const questionEmbedding = qEmbData.embedding;

    const index = pinecone.Index(process.env.PINECONE_INDEX);
    const queryResponse = await index.query({
      topK: 5,
      includeMetadata: true,
      vector: questionEmbedding,
      namespace: "pdf-chatbot"
    });
    const matches = queryResponse.matches || [];
    let contextText = "";
    for (let match of matches) {
      if (match.metadata?.text) {
        contextText += match.metadata.text + "\n";
      }
    }
    if (contextText.trim() === "") {
      contextText = "The document is empty or not relevant.";
    }

    const messages = [
      { role: "system", content: "You are a helpful assistant. Use the provided document text to answer the question." },
      { role: "user", content: `${contextText}\nQuestion: ${question}\nAnswer:` }
    ];
    const chatStream = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      stream: true
    });

    for await (const part of chatStream) {
      const content = part.choices[0].delta?.content || "";
      if (content) {
        res.write(`data: ${content}\n\n`);
      }
      if (part.choices[0].finish_reason) {
        break;
      }
    }
    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (err) {
    console.error("Error during chat completion:", err);
    res.write(`data: [DONE]\n\n`);
    res.end();
  }
});

// Simple GET route for backend check
app.get('/', (req, res) => {
  res.send("Express server is running. Use /upload or /chat endpoints.");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🤖 Server is running on http://localhost:${PORT}`);
});
