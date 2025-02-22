// pages/api/upload.js
import nextConnect from 'next-connect';
import multer from 'multer';
import fs from 'fs';
import pdfParse from 'pdf-parse';
import { PineconeClient } from '@pinecone-database/pinecone';
import { Configuration, OpenAIApi } from 'openai';

// Ephemeral storage on Vercel
const upload = multer({
  dest: '/tmp',
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// next-connect handler
const apiRoute = nextConnect({
  onError(error, req, res) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  },
  onNoMatch(req, res) {
    res.status(405).json({ error: `Method '${req.method}' Not Allowed` });
  },
});

// Attach multer middleware
apiRoute.use(upload.single('file'));

// The main POST route
apiRoute.post(async (req, res) => {
  const logs = [];
  try {
    if (!req.file) {
      logs.push('No file uploaded.');
      return res.status(400).json({ error: 'No file uploaded', logs });
    }
    logs.push(`File uploaded: ${req.file.originalname}`);

    // Read PDF file
    const fileBuffer = fs.readFileSync(req.file.path);
    logs.push('Extracting text with pdf-parse...');
    const pdfData = await pdfParse(fileBuffer);
    const extractedText = pdfData.text;
    logs.push('Text extraction complete.');

    // Split into chunks
    logs.push('Splitting text into chunks...');
    const textChunks = splitTextIntoChunks(extractedText);
    logs.push(`Document split into ${textChunks.length} chunks.`);

    // Initialize Pinecone
    logs.push('Initializing Pinecone...');
    const pinecone = new PineconeClient();
    await pinecone.init({
      apiKey: process.env.PINECONE_API_KEY,
      environment: process.env.PINECONE_ENV
    });
    const index = pinecone.Index(process.env.PINECONE_INDEX);

    // Initialize OpenAI
    logs.push('Initializing OpenAI...');
    const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
    const openai = new OpenAIApi(configuration);

    // Generate embeddings + upsert
    logs.push('Generating embeddings and upserting to Pinecone...');
    const vectors = [];
    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      if (!chunk.trim()) continue;

      const embResponse = await openai.createEmbedding({
        model: 'text-embedding-ada-002',
        input: chunk
      });
      const embedding = embResponse.data.data[0].embedding;

      vectors.push({
        id: `chunk-${i}`,
        values: embedding,
        metadata: { text: chunk }
      });
    }

    if (vectors.length > 0) {
      await index.upsert({ vectors, namespace: 'pdf-chatbot' });
      logs.push(`Upserted ${vectors.length} vectors.`);
    } else {
      logs.push('No vectors to upsert (possibly empty PDF).');
    }

    logs.push('PDF processed successfully.');
    res.status(200).json({
      message: 'PDF processed successfully',
      chunks: textChunks.length,
      logs
    });
  } catch (err) {
    logs.push(`Error: ${err.message}`);
    console.error('Upload route error:', err);
    res.status(500).json({ error: err.message, logs });
  }
});

// Helper function to chunk text
function splitTextIntoChunks(text, maxLength = 1000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end > text.length) end = text.length;
    let segment = text.slice(start, end);
    const lastNewline = segment.lastIndexOf('\n');
    const lastSpace = segment.lastIndexOf(' ');
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

// Disable Next.js default body parsing for file uploads
export const config = {
  api: {
    bodyParser: false,
  },
};

export default apiRoute;
