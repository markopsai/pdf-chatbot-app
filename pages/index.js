import { useState, useRef } from 'react';

export default function Home() {
  // --- Chat States ---
  const [messages, setMessages] = useState([]);       // chat history
  const [currentAnswer, setCurrentAnswer] = useState(""); // partial streaming answer
  const [question, setQuestion] = useState("");       // current question input
  const currentAnswerRef = useRef("");               // for accumulating streaming text

  // --- Upload States ---
  const [uploadProgress, setUploadProgress] = useState(0);  // percentage of file upload
  const [uploadLogs, setUploadLogs] = useState([]);         // logs returned by the server

  // ---------------------------------------------------
  // 1. Handle PDF Upload with XHR for Progress
  // ---------------------------------------------------
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Reset states
    setUploadProgress(0);
    setUploadLogs([]);

    // Create an XHR request to track progress
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload'); // Our Next.js API route

    // Track upload progress
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const percent = (ev.loaded / ev.total) * 100;
        setUploadProgress(percent);
      }
    };

    // On successful response from the server
    xhr.onload = () => {
      if (xhr.status === 200) {
        // Parse the JSON returned by the server
        const response = JSON.parse(xhr.responseText);
        alert(`PDF processed successfully with ${response.chunks} chunks.`);
        // If the server included logs, show them
        if (response.logs) {
          setUploadLogs(response.logs);
        }
      } else {
        // e.g. 404, 500, etc.
        alert(`Upload failed with status ${xhr.status}`);
      }
    };

    // On error (network issues, etc.)
    xhr.onerror = () => {
      alert('Network or server error during upload.');
    };

    // Send the file
    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  };

  // ---------------------------------------------------
  // 2. Handle Asking a Question (Streaming Response)
  // ---------------------------------------------------
  const handleAskQuestion = async () => {
    if (!question.trim()) return;
    
    // Add user's question to chat
    setMessages((msgs) => [...msgs, { role: 'user', text: question }]);
    setCurrentAnswer("");
    currentAnswerRef.current = "";
    setQuestion("");

    try {
      // Stream from /api/chat?question=...
      const response = await fetch(`/api/chat?question=${encodeURIComponent(question)}`, {
        method: 'GET'
      });
      if (!response.body) throw new Error("No response body from /api/chat");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunk = decoder.decode(value);
          // Each SSE line starts with "data: "
          const lines = chunk.split('\n');
          for (let line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.replace(/^data: /, '');
              if (data === "[DONE]") {
                done = true;
                break;
              }
              currentAnswerRef.current += data;
              setCurrentAnswer((prev) => prev + data);
            }
          }
        }
      }

      // Add the completed assistant answer to the chat
      setMessages((msgs) => [...msgs, { role: 'assistant', text: currentAnswerRef.current }]);
      setCurrentAnswer("");
    } catch (err) {
      console.error("Error during streaming chat response:", err);
      alert(`Error: ${err.message}`);
    }
  };

  // ---------------------------------------------------
  // Render
  // ---------------------------------------------------
  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">PDF Chatbot (Next.js API Routes)</h1>

      {/* PDF Upload Section */}
      <div className="mb-4">
        <input
          type="file"
          accept="application/pdf"
          onChange={handleFileUpload}
          className="file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:bg-blue-50 file:text-blue-700"
        />
      </div>

      {/* Upload Progress Bar */}
      {uploadProgress > 0 && uploadProgress < 100 && (
        <div className="w-full bg-gray-200 rounded h-4 mb-4">
          <div
            className="bg-blue-600 h-4 rounded"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}
      {uploadProgress === 100 && (
        <p className="mb-4">Upload complete. Processing on server...</p>
      )}

      {/* Server Logs After Upload */}
      {uploadLogs.length > 0 && (
        <div className="mb-4 bg-gray-100 p-2 rounded">
          <h2 className="font-semibold">Upload Logs:</h2>
          <ul className="list-disc list-inside">
            {uploadLogs.map((log, idx) => (
              <li key={idx}>{log}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Chat History */}
      <div className="mb-4 max-h-80 overflow-y-auto border p-3 rounded bg-gray-50">
        {messages.map((msg, idx) => (
          <div key={idx} className={`my-1 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`px-3 py-2 rounded-lg ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-300 text-black'}`}>
              <span className="font-semibold">{msg.role === 'user' ? 'You: ' : 'Assistant: '}</span>
              {msg.text}
            </div>
          </div>
        ))}
        {/* Streaming response in progress */}
        {currentAnswer && (
          <div className="my-1 flex justify-start">
            <div className="px-3 py-2 rounded-lg bg-gray-300 text-black">
              <span className="font-semibold">Assistant: </span>{currentAnswer}
              <span className="animate-pulse">▌</span>
            </div>
          </div>
        )}
      </div>

      {/* Question Input */}
      <div className="flex">
        <input
          type="text"
          className="flex-grow border rounded px-3 py-2"
          placeholder="Ask a question about the PDF..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if(e.key === 'Enter') handleAskQuestion(); }}
        />
        <button
          onClick={handleAskQuestion}
          className="ml-2 px-4 py-2 bg-blue-600 text-white rounded"
        >
          Send
        </button>
      </div>
    </div>
  );
}
