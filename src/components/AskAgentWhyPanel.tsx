import { useState } from "react";

export default function AskAgentWhyPanel({ requestId }: { requestId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<any>(null);

  async function submit() {
    const res = await fetch(
      `http://localhost:8000/api/requests/${requestId}/reasoning/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      }
    );

    const data = await res.json();
    setAnswer(data);
  }

  return (
    <div style={{ marginTop: 32 }}>
      <h3>Ask the Agent Why</h3>

      <input
        placeholder="Why was this evidence sufficient?"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        style={{ width: "100%", padding: 8 }}
      />

      <button onClick={submit} style={{ marginTop: 8 }}>
        Ask
      </button>

      {answer && (
        <div style={{ marginTop: 16 }}>
          <p>{answer.answer}</p>
          {answer.evidence?.map((log: any, i: number) => (
            <div key={i}>
              <strong>{log.agent}</strong>: {log.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}