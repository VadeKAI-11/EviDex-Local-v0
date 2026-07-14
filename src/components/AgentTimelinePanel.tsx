import { useEffect, useState } from "react";
import { formatDateTimeDMY } from "../utils/dateTime";

type Log = {
  timestamp: string;
  agent: string;
  message: string;
};

export default function AgentTimelinePanel({ requestId }: { requestId: string }) {
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    const source = new EventSource(
      `http://localhost:8000/api/requests/${requestId}/reasoning/stream`
    );

    source.onmessage = (event) => {
      const log = JSON.parse(event.data);
      setLogs((prev) => [...prev, log]);
    };

    return () => source.close();
  }, [requestId]);

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Live Agent Timeline</h3>
      <ul>
        {logs.map((log, i) => (
          <li key={i}>
            <strong>{log.agent}</strong>{" "}
            ({formatDateTimeDMY(log.timestamp)}):
            <div>{log.message}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}