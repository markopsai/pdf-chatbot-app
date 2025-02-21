// server.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { PineconeClient } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();

// Use a single multer declaration with file size limits
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
});

// Enable CORS (in case we're not using Next.js proxy)
app.use(cors());
app.use(express.json());

// Initialize Pinecone client
const pinecone = new PineconeClient();
(async () => {
  await pinecone.init({
    apiKey: process.env.PINECONE_API_KEY,
    environment: process.env.PINECONE_ENV        // e.g. "us-east1-gcp"
  });
})().catch(err => {
  console.error("Pinecone initialization error:", err);
});

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Utility: split text into smaller chunks for embedding (to fit token limits or logical splits)
function splitTextIntoChunks(text, maxLength = 1000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end > text.length) end = text.length;
    // Ensure we don't cut in the middle of a sentence (optional improvement)
    let segment = text.slice(start, end);
    // Try to cut at a newline or space if possible
    const lastNewline = segment.lastIndexOf("\n");
    const lastSpace = segment.lastIndexOf(" ");
    if (end < text.length && (lastNewline > 200 || lastSpace > 200)) {
      // if there is a newline or space towards the end of segment, cut there
      const cutIndex = lastNewline > 200 ? lastNewline : lastSpace;
      segment = text.slice(start, start + cutIndex);
      end = start + cutIndex;
    }
    chunks.push(segment.trim());
    start = end;
  }
  return chunks;
}

// PDF Upload and Processing route
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    // 1. Perform OCR on the uploaded PDF to extract text
    let extractedText = "";
    console.log(`Starting OCR for file: ${file.path}`);
    // Tesseract can extract text from images; for PDFs, ensure the PDF is scanned or convert to image per page.
    // Here we assume the PDF is a scanned image or has images; Tesseract will handle it.
    const result = await Tesseract.recognize(file.path, 'eng');
    extractedText = result.data.text;
    console.log("OCR extraction complete.");

    // 2. Split the extracted text into chunks for embeddings
    const textChunks = splitTextIntoChunks(extractedText);
    console.log(`Document split into ${textChunks.length} chunks for embedding.`);

    // 3. Generate embeddings for each chunk and upsert into Pinecone
    // Connect to Pinecone index (ensure the index is already created via Pinecone dashboard)
    const index = pinecone.Index(process.env.PINECONE_INDEX);
    const vectors = [];
    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      if (!chunk.trim()) continue;
      // Get embedding from OpenAI
      const embResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: chunk
      });
      const [embeddingData] = embResponse.data;  // OpenAI returns an array of embeddings
      const embedding = embeddingData.embedding;
      // Prepare Pinecone vector
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

  // Set headers for Server-Sent Events (SSE) streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Allow flush of headers (if using compression or proxies)
  res.flushHeaders();

  try {
    // 1. Embed the user's question
    const qEmbResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: question
    });
    const [qEmbData] = qEmbResponse.data;
    const questionEmbedding = qEmbData.embedding;

    // 2. Query Pinecone for relevant chunks
    const index = pinecone.Index(process.env.PINECONE_INDEX);
    const queryResponse = await index.query({
      topK: 5,
      includeMetadata: true,
      vector: questionEmbedding,
      namespace: "pdf-chatbot"
    });
    const matches = queryResponse.matches || [];
    // Construct a prompt or context from top matches
    let contextText = "";
    for (let match of matches) {
      if (match.metadata?.text) {
        contextText += match.metadata.text + "\n";
      }
    }
    if (contextText.trim() === "") {
      contextText = "The document is empty or not relevant.";
    }

    // 3. Call OpenAI Chat Completion API with streaming
    const messages = [
      { role: "system", content: "You are a helpful assistant. Use the provided document text to answer the question." },
      { role: "user", content: `${contextText}\nQuestion: ${question}\nAnswer:` }
    ];
    const chatStream = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      stream: true
    });

    // Stream the response back to client
    for await (const part of chatStream) {
      const content = part.choices[0].delta?.content || "";
      if (content) {
        // Send each chunk with SSE format
        res.write(`data: ${content}\n\n`);
      }
      // If the response is done (stop reason), break the loop
      if (part.choices[0].finish_reason) {
        break;
      }
    }
    // Signal completion
    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (err) {
    console.error("Error during chat completion:", err);
    res.write(`data: [DONE]\n\n`);  // End the SSE on error as well
    res.end();
  }
});

// A simple GET route to confirm the server is running
app.get('/', (req, res) => {
  res.send("Express server is running. Use /upload or /chat endpoints.");
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🤖 Server is running on http://localhost:${PORT}`);
});
