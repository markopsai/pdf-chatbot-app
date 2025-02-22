import { useState, useRef, useEffect } from 'react';

export default function Home() {
  // Chat logic states
  const [messages, setMessages] = useState([]);
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [question, setQuestion] = useState("");
  const currentAnswerRef = useRef("");

  // File upload states
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLogs, setUploadLogs] = useState([]);
  const [isUploading, setIsUploading] = useState(false);

  // Handle PDF file upload via XHR for progress
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadProgress(0);
    setUploadLogs([]);
    setIsUploading(true);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const percent = (ev.loaded / ev.total) * 100;
        setUploadProgress(percent);
      }
    };

    xhr.onload = () => {
      setIsUploading(false);
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        alert(`PDF processed successfully with ${response.chunks} chunks.`);
        if (response.logs) {
          setUploadLogs(response.logs);
        }
      } else {
        alert(`Upload failed with status ${xhr.status}`);
      }
    };

    xhr.onerror = () => {
      setIsUploading(false);
      alert('Network or server error during upload.');
    };

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  };

  // Handle question + streaming chat response
  const handleAskQuestion = async () => {
    if (!question.trim()) return;
    setMessages((msgs) => [...msgs, { role: 'user', text: question }]);
    setCurrentAnswer("");
    currentAnswerRef.current = "";
    setQuestion("");

    try {
      const response = await fetch(`/api/chat?question=${encodeURIComponent(question)}`, {
        method: 'GET'
      });
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunk = decoder.decode(value);
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
      setMessages((msgs) => [...msgs, { role: 'assistant', text: currentAnswerRef.current }]);
      setCurrentAnswer("");
    } catch (err) {
      console.error("Error during streaming response:", err);
    }
  };

  // Auto-scroll to bottom of chat
  const chatEndRef = useRef(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentAnswer]);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-100">
      {/* Top Nav Bar */}
      <div className="w-full bg-white border-b px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="text-lg font-bold text-gray-800">
          My PDF Chatbot
        </div>
        <div className="text-sm text-gray-500">
          Ask questions about your uploaded PDF
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="hidden md:flex flex-col w-64 bg-gray-200 p-4 border-r">
          <h2 className="font-semibold text-gray-700 mb-2">PDF Upload</h2>
          <p className="text-xs text-gray-600 mb-3">
            Upload a PDF to process it for Q&A.
          </p>
          <label className="block mb-2 text-sm font-medium text-gray-700">
            Choose PDF
          </label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handleFileUpload}
            className="mb-4 text-sm file:mr-3 file:py-1 file:px-2 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700"
          />

          {/* Upload progress bar */}
          {isUploading && (
            <div className="w-full bg-gray-300 rounded h-4 mb-3">
              <div
                className="bg-blue-600 h-4 rounded"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}

          {uploadLogs.length > 0 && (
            <div className="mt-2 bg-white p-2 rounded shadow text-xs overflow-y-auto max-h-64">
              <h3 className="font-semibold mb-1">Logs:</h3>
              <ul className="list-disc ml-4">
                {uploadLogs.map((log, idx) => (
                  <li key={idx}>{log}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col">
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.map((msg, idx) => (
              <ChatBubble key={idx} role={msg.role} text={msg.text} />
            ))}

            {/* Streaming partial answer */}
            {currentAnswer && (
              <ChatBubble role="assistant" text={currentAnswer} streaming />
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input bar */}
          <div className="border-t p-3 bg-white">
            <div className="flex items-center">
              <textarea
                className="flex-grow border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                rows={1}
                placeholder="Ask a question about the PDF..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAskQuestion();
                  }
                }}
              />
              <button
                onClick={handleAskQuestion}
                className="ml-2 px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 
 * A reusable chat bubble component 
 * role: "user" or "assistant"
 * text: message text
 * streaming: optional boolean (if the assistant is currently streaming text)
 */
function ChatBubble({ role, text, streaming }) {
  const isUser = role === 'user';
  return (
    <div className={`mb-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] px-4 py-2 rounded-lg text-sm whitespace-pre-wrap
          ${isUser ? 'bg-blue-600 text-white' : 'bg-white text-gray-800 border'}
        `}
      >
        <span className="font-semibold block mb-1">
          {isUser ? 'You' : 'Assistant'}
        </span>
        {text}
        {streaming && (
          <span className="animate-pulse ml-1">▌</span>
        )}
      </div>
    </div>
  );
}
