// pages/index.js
import { useState, useRef } from 'react';

export default function Home() {
  const [messages, setMessages] = useState([]);       // chat history (array of {role, text})
  const [currentAnswer, setCurrentAnswer] = useState(""); // partial streaming answer
  const [question, setQuestion] = useState("");       // current question input
  const currentAnswerRef = useRef("");               // useRef to accumulate streaming text

  // Handle PDF file selection and upload
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Send the file to the backend via an API call
    const formData = new FormData();
    formData.append('file', file);
    try {
      // Using Next.js rewrite: the URL '/api/upload' is proxied to the Express server
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) throw new Error("Upload failed");
      alert("PDF uploaded and processed successfully!");
    } catch (err) {
      console.error(err);
      alert("Error uploading file: " + err.message);
    }
  };

  // Handle sending a question to the chatbot
  const handleAskQuestion = async () => {
    if (!question) return;
    // Append user's question to chat history
    setMessages((msgs) => [...msgs, { role: 'user', text: question }]);
    setCurrentAnswer(""); 
    currentAnswerRef.current = "";
    setQuestion("");  // clear input field

    try {
      // Open a connection to the streaming endpoint
      const response = await fetch(`/api/chat?question=${encodeURIComponent(question)}`, {
        method: 'GET'
      });
      if (!response.body) throw new Error("No response body");

      // Use the ReadableStream to read chunks from the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          // Decode and accumulate the chunk
          const chunk = decoder.decode(value);
          // The server sends SSE formatted chunks "data: <text>\n\n"
          // We split by SSE delimiter to get the actual text
          const lines = chunk.split('\n');
          for (let line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.replace(/^data: /, '');
              if (data === "[DONE]") {
                // Stream end signal
                done = true;
                break;
              }
              // Update the streaming answer state
              currentAnswerRef.current += data;
              setCurrentAnswer((prev) => prev + data);
            }
          }
        }
      }
      // After done, save the full assistant answer to chat history
      setMessages((msgs) => [...msgs, { role: 'assistant', text: currentAnswerRef.current }]);
      setCurrentAnswer("");
    } catch (err) {
      console.error("Error during streaming response:", err);
    }
  };

  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">PDF Chatbot</h1>

      {/* PDF Upload */}
      <div className="mb-4">
        <input 
          type="file" 
          accept="application/pdf" 
          onChange={handleFileUpload}
          className="file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:bg-blue-50 file:text-blue-700"
        />
      </div>

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
