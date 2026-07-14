/**
 * Workflow Interface Component - "Ask Agent Why" Chat Interface
 * 
 * Provides an interactive chat interface for auditors to ask questions about
 * the workflow execution, evidence assessment, and AI agent decisions. Uses
 * AWS Bedrock to generate contextual responses based on the request state.
 * 
 * Key Features:
 * - Real-time conversational interface with AI agent
 * - Context-aware responses based on workflow state and evidence
 * - Quick suggestion buttons for common questions
 * - Health check for backend connectivity
 * - Message history persistence
 * - Automatic scrolling to latest messages
 * 
 * Props:
 * - requestId: The audit request being discussed
 * - auditorEmail: Email of the auditor asking questions
 * - requestText: Original audit request text for context
 * - preferredInteractionId: Resume existing conversation
 * - defaultTopic: Topic category (clarification, evidence, standards)
 * - onInteractionReady: Callback when chat session is established
 * 
 * Backend Integration:
 * - POST /api/chat/workflow/interactions - Create new conversation
 * - POST /api/chat/workflow/interactions/:id/messages - Send message
 * - GET /api/chat/workflow/interactions/:id - Get conversation history
 * - GET /api/chat/workflow/interactions/:id/health - Check backend status
 */

// ============================================================================
// IMPORTS
// ============================================================================

import { useEffect, useState, useRef, useMemo } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import {
  createWorkflowInteraction,
  sendWorkflowInteractionMessage,
  getWorkflowInteraction,
  getWorkflowInteractionHealth,
} from "../api/backend-api";
import type { WorkflowInteractionHealthResponse, WorkflowMessage } from "../api/types";
import RichTextBlock from "./RichTextBlock";
import { formatTimeHM, getDisplayTimeZoneLabel, getDisplayTimeZoneName } from "../utils/dateTime";

interface WorkflowInterfaceProps {
  requestId: string;
  auditorEmail: string;
  requestText?: string;
  preferredInteractionId?: string | null;
  defaultTopic?: string;
  onInteractionReady?: (interactionId: string) => void;
}

export default function WorkflowInterface({
  requestId,
  auditorEmail,
  requestText,
  preferredInteractionId,
  defaultTopic = "clarification",
  onInteractionReady,
}: WorkflowInterfaceProps) {
  const timeZoneLabel = getDisplayTimeZoneLabel();
  const timeZoneName = getDisplayTimeZoneName();
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WorkflowMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [healthStatus, setHealthStatus] = useState<WorkflowInteractionHealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const interactionStorageKey = `evidex-interaction-${requestId}`;

  const quickSuggestions = useMemo(() => {
    const normalized = (requestText || "").replace(/\s+/g, " ").trim();
    const requestPreview = normalized
      ? (normalized.length > 72 ? `${normalized.slice(0, 72)}...` : normalized)
      : "this request";

    const latestAssistant = [...messages]
      .reverse()
      .find((msg) => msg.sender_type === "ai_agent");
    const latestAuditor = [...messages]
      .reverse()
      .find((msg) => msg.sender_type === "auditor");

    const assistantText = (latestAssistant?.message_text || "").replace(/\s+/g, " ").trim();
    const auditorText = (latestAuditor?.message_text || "").replace(/\s+/g, " ").trim();

    if (!assistantText) {
      return [
        `Summarize current evidence for ${requestPreview}`,
        "What are the top evidence gaps to close next?",
        "Which uploaded files are most relevant and why?",
        "What follow-up evidence should I request from the client?",
      ];
    }

    const sentenceMatch = assistantText.match(/[^.!?]+[.!?]/g);
    const firstSentence = sentenceMatch?.[0]?.trim() || assistantText.slice(0, 120);
    const sentencePreview =
      firstSentence.length > 88 ? `${firstSentence.slice(0, 88)}...` : firstSentence;

    const confidenceMention = assistantText.match(/\b\d{1,3}%\b/);
    const confidenceHint = confidenceMention ? confidenceMention[0] : null;

    const suggestions = [
      `Can you explain this further: "${sentencePreview}"?`,
      "What is the single highest-priority next action?",
      "Which evidence should I request next to close remaining gaps?",
      auditorText
        ? `Refine your answer based on my question: "${auditorText.slice(0, 72)}${auditorText.length > 72 ? "..." : ""}"`
        : "Draft a concise update I can share with my audit manager.",
    ];

    if (confidenceHint) {
      suggestions[1] = `How should I interpret the ${confidenceHint} confidence level?`;
    }

    return suggestions;
  }, [requestText, messages]);

  // Initialize interaction on mount
  useEffect(() => {
    let disposed = false;

    async function createAndStoreInteraction(topic: string) {
      const conv = await createWorkflowInteraction(requestId, topic);
      if (disposed) return;
      setInteractionId(conv.conversation_id);
      localStorage.setItem(interactionStorageKey, conv.conversation_id);
      onInteractionReady?.(conv.conversation_id);

      const loaded = await getWorkflowInteraction(conv.conversation_id);
      if (disposed) return;
      setMessages(loaded.messages);
    }

    async function initializeInteraction() {
      try {
        setIsLoading(true);

        if (preferredInteractionId) {
          try {
            const preferred = await getWorkflowInteraction(preferredInteractionId);
            if (disposed) return;
            setInteractionId(preferredInteractionId);
            setMessages(preferred.messages);
            localStorage.setItem(
              interactionStorageKey,
              preferredInteractionId
            );
            onInteractionReady?.(preferredInteractionId);
            setError(null);
            return;
          } catch {
            // Fall through to stored/default creation logic.
          }
        }

        const storedInteractionId = localStorage.getItem(
          interactionStorageKey
        );

        if (storedInteractionId) {
          try {
            const existing = await getWorkflowInteraction(storedInteractionId);
            if (disposed) return;
            setInteractionId(storedInteractionId);
            setMessages(existing.messages);
            onInteractionReady?.(storedInteractionId);
            setError(null);
            return;
          } catch {
            localStorage.removeItem(interactionStorageKey);
          }
        }

        await createAndStoreInteraction(defaultTopic);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create Interact session");
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }
    }

    initializeInteraction();

    return () => {
      disposed = true;
    };
  }, [
    requestId,
    interactionStorageKey,
    preferredInteractionId,
    defaultTopic,
    onInteractionReady,
  ]);

  // Fetch interaction when it changes
  useEffect(() => {
    if (!interactionId) return;
    const currentInteractionId: string = interactionId;

    async function fetchInteraction() {
      try {
        const conv = await getWorkflowInteraction(currentInteractionId);
        setMessages(conv.messages);
      } catch (err) {
        console.error("Failed to fetch workflow interaction:", err);
      }
    }

    // Initial fetch
    fetchInteraction();

    // Poll for updates
    const interval = setInterval(fetchInteraction, 3000);
    return () => clearInterval(interval);
  }, [interactionId]);

  async function sendCurrentMessage(text: string) {
    if (!text.trim() || !interactionId) return;

    try {
      setIsSending(true);
      setError(null);

      await sendWorkflowInteractionMessage(
        interactionId,
        requestId,
        text,
        "question"
      );

      setInputText("");

      // Fetch updated interaction
      const updatedConv = await getWorkflowInteraction(interactionId);
      setMessages(updatedConv.messages);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send message";

      const isInteractionNotFound =
        message.toLowerCase().includes("workflow interaction") &&
        message.toLowerCase().includes("not found");

      if (isInteractionNotFound) {
        try {
          localStorage.removeItem(interactionStorageKey);

          const replacement = await createWorkflowInteraction(requestId, defaultTopic);
          const newInteractionId = replacement.conversation_id;

          setInteractionId(newInteractionId);
          localStorage.setItem(interactionStorageKey, newInteractionId);
          onInteractionReady?.(newInteractionId);

          await sendWorkflowInteractionMessage(
            newInteractionId,
            requestId,
            text,
            "question"
          );

          setInputText("");
          const refreshed = await getWorkflowInteraction(newInteractionId);
          setMessages(refreshed.messages);
          setError(null);
          return;
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : "Failed to recover Interact session";
          setError(retryMessage);
          return;
        }
      }

      setError(message);
    } finally {
      setIsSending(false);
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = inputText.trim();
    if (!text) return;
    await sendCurrentMessage(text);
  }

  function handleQuickSuggestionClick(suggestion: string) {
    if (isSending) return;
    setInputText(suggestion);
    setError(null);
  }

  async function handleCheckBedrockStatus() {
    try {
      setIsCheckingHealth(true);
      setHealthError(null);
      const status = await getWorkflowInteractionHealth(true);
      setHealthStatus(status);
    } catch (err) {
      setHealthStatus(null);
      setHealthError(err instanceof Error ? err.message : "Interact health check failed");
    } finally {
      setIsCheckingHealth(false);
    }
  }

  if (isLoading) {
    return (
      <div
        style={{
          border: "2px solid #99cc00",
          borderRadius: "12px",
          padding: "24px",
          background: "var(--card-bg)",
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: "16px" }}>
          Interact
        </h3>
        <p>Initializing Interact...</p>
      </div>
    );
  }

  if (error && !interactionId) {
    return (
      <div
        style={{
          border: "2px solid #ef4444",
          borderRadius: "12px",
          padding: "24px",
          background: "#fee2e2",
          color: "#991b1b",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Interact</h3>
        <p>
          <FontAwesomeIcon icon={faTriangleExclamation} style={{ marginRight: "8px" }} />
          {error}
        </p>
        <div style={{ fontSize: "13px", opacity: 0.85, lineHeight: 1.5 }}>
          <p style={{ margin: "8px 0" }}>
            Configure AWS Bedrock access and model permissions to enable Interact.
          </p>
          <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
            <li>Start the backend and confirm it is reachable at http://localhost:8000.</li>
            <li>Set AWS credentials and AWS_REGION in the backend environment.</li>
            <li>Grant IAM permission bedrock:InvokeModel for the configured chat model.</li>
            <li>Enable model access in Bedrock for the configured model ID in your AWS account.</li>
          </ul>
          <button
            type="button"
            onClick={() => void handleCheckBedrockStatus()}
            disabled={isCheckingHealth}
            style={{
              marginTop: "12px",
              border: "1px solid #991b1b",
              background: "transparent",
              color: "#991b1b",
              borderRadius: "6px",
              padding: "6px 10px",
              cursor: isCheckingHealth ? "not-allowed" : "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            {isCheckingHealth ? "Checking Bedrock status..." : "Check Bedrock status"}
          </button>
          {(healthStatus || healthError) && (
            <div
              style={{
                marginTop: "10px",
                padding: "8px 10px",
                borderRadius: "6px",
                border: "1px solid rgba(153, 27, 27, 0.25)",
                background: "rgba(255, 255, 255, 0.65)",
                color: "#7f1d1d",
              }}
            >
              {healthError || healthStatus?.diagnostic_message || "No diagnostics available."}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        border: "2px solid #99cc00",
        borderRadius: "12px",
        background: "var(--card-bg)",
        display: "flex",
        flexDirection: "column",
        height: "680px",
        overflow: "hidden",
      }}
    >
      {/* Chat Header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexShrink: 0,
        }}
      >
        {/* AI Avatar */}
        <div
          style={{
            width: "38px",
            height: "38px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #99cc00, #6ea800)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            flexShrink: 0,
          }}
        >
          🤖
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: "15px" }}>EviDex AI Agent</div>
          <div style={{ fontSize: "11px", opacity: 0.55 }}>
            Powered by NVIDIA Nemotron · {auditorEmail}
          </div>
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              border: "1px solid var(--border-color)",
              borderRadius: "999px",
              padding: "3px 8px",
              lineHeight: 1,
            }}
            title={`Times shown in ${timeZoneName}`}
          >
            {timeZoneLabel}
          </span>
          <button
            type="button"
            onClick={() => void handleCheckBedrockStatus()}
            disabled={isCheckingHealth}
            style={{
              border: "1px solid var(--border-color)",
              background: "transparent",
              color: "inherit",
              borderRadius: "6px",
              padding: "5px 8px",
              cursor: isCheckingHealth ? "not-allowed" : "pointer",
              fontSize: "11px",
              fontWeight: 600,
              opacity: isCheckingHealth ? 0.7 : 1,
            }}
          >
            {isCheckingHealth ? "Checking..." : "Check Bedrock status"}
          </button>
          <div
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: healthError
                ? "#ef4444"
                : healthStatus?.bedrock_access_ok === false
                  ? "#f59e0b"
                  : "#22c55e",
              boxShadow: healthError
                ? "0 0 0 2px #fecaca"
                : healthStatus?.bedrock_access_ok === false
                  ? "0 0 0 2px #fde68a"
                  : "0 0 0 2px #bbf7d0",
            }}
          />
        </div>
      </div>

      {(healthStatus || healthError) && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid var(--border-color)",
            fontSize: "12px",
            background: healthError
              ? "var(--color-danger-bg)"
              : healthStatus?.bedrock_access_ok
                ? "var(--color-success-bg)"
                : "var(--color-warning-bg)",
            color: healthError
              ? "var(--color-danger-text)"
              : healthStatus?.bedrock_access_ok
                ? "var(--color-success-text)"
                : "var(--color-warning-text)",
          }}
        >
          {healthError || healthStatus?.diagnostic_message || "No diagnostics available."}
        </div>
      )}

      {/* Messages Area */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0.45,
              textAlign: "center",
              gap: "8px",
              padding: "40px 0",
            }}
          >
            <div style={{ fontSize: "36px" }}>💬</div>
            <p style={{ margin: 0, fontWeight: 600 }}>No messages yet</p>
            <p style={{ margin: 0, fontSize: "13px" }}>
              Ask a question about the audit evidence or process below.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isAuditor = msg.sender_type === "auditor";
            return (
              <div
                key={msg.message_id}
                style={{
                  display: "flex",
                  flexDirection: isAuditor ? "row-reverse" : "row",
                  alignItems: "flex-end",
                  gap: "10px",
                }}
              >
                {/* Avatar */}
                <div
                  style={{
                    width: "32px",
                    height: "32px",
                    borderRadius: "50%",
                    background: isAuditor
                      ? "linear-gradient(135deg, #3b82f6, #1d4ed8)"
                      : "linear-gradient(135deg, #99cc00, #6ea800)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "14px",
                    flexShrink: 0,
                  }}
                >
                  {isAuditor ? "👤" : "🤖"}
                </div>

                {/* Bubble */}
                <div
                  style={{
                    maxWidth: "72%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isAuditor ? "flex-end" : "flex-start",
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      opacity: 0.55,
                      fontWeight: 600,
                      paddingLeft: isAuditor ? 0 : "4px",
                      paddingRight: isAuditor ? "4px" : 0,
                    }}
                  >
                    {isAuditor ? "You" : "AI Agent"}
                    {msg.ai_confidence ? ` · ${(msg.ai_confidence * 100).toFixed(0)}% confidence` : ""}
                  </div>

                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: isAuditor
                        ? "18px 4px 18px 18px"
                        : "4px 18px 18px 18px",
                      background: "var(--card-bg)",
                      color: "inherit",
                      border: "1px solid var(--border-color)",
                      fontSize: "14px",
                      lineHeight: 1.55,
                      boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                    }}
                  >
                    <RichTextBlock text={msg.message_text} />
                  </div>

                  <div
                    style={{
                      fontSize: "10px",
                      opacity: 0.4,
                      paddingLeft: isAuditor ? 0 : "4px",
                      paddingRight: isAuditor ? "4px" : 0,
                    }}
                  >
                    {formatTimeHM(msg.timestamp)}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Typing indicator */}
        {isSending && (
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "flex-end",
              gap: "10px",
            }}
          >
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                background: "linear-gradient(135deg, #99cc00, #6ea800)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "14px",
                flexShrink: 0,
              }}
            >
              🤖
            </div>
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "4px 18px 18px 18px",
                background: "var(--card-bg)",
                border: "1px solid var(--border-color)",
                display: "flex",
                gap: "5px",
                alignItems: "center",
              }}
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    width: "7px",
                    height: "7px",
                    borderRadius: "50%",
                    background: "#99cc00",
                    animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Suggestions */}
      {quickSuggestions.length > 0 && (
        <div
          style={{
            padding: "8px 16px",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            flexShrink: 0,
          }}
        >
          {quickSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => handleQuickSuggestionClick(suggestion)}
              disabled={isSending}
              style={{
                border: "1px solid #99cc00",
                background: "transparent",
                color: "#99cc00",
                borderRadius: "999px",
                padding: "4px 10px",
                fontSize: "11px",
                cursor: isSending ? "not-allowed" : "pointer",
                opacity: isSending ? 0.5 : 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "220px",
              }}
              title={suggestion}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "#fee2e2",
            border: "none",
            borderTop: "1px solid #fca5a5",
            color: "#991b1b",
            fontSize: "13px",
            flexShrink: 0,
          }}
        >
          <FontAwesomeIcon icon={faTriangleExclamation} style={{ marginRight: "8px" }} />
          {error}
        </div>
      )}

      {/* Input Bar */}
      <form
        onSubmit={handleSendMessage}
        style={{
          padding: "12px 16px",
          borderTop: "1px solid var(--border-color)",
          display: "flex",
          gap: "10px",
          alignItems: "center",
          flexShrink: 0,
          background: "var(--card-bg)",
        }}
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Ask a question about the audit..."
          disabled={isSending}
          style={{
            flex: 1,
            padding: "10px 16px",
            border: "1px solid var(--border-color)",
            background: "var(--input-bg, var(--card-bg))",
            color: "inherit",
            borderRadius: "999px",
            fontSize: "14px",
            fontFamily: "inherit",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!inputText.trim() || isSending}
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: !inputText.trim() || isSending ? "#ccc" : "#99cc00",
            color: "white",
            border: "none",
            cursor: !inputText.trim() || isSending ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            flexShrink: 0,
            transition: "background 0.2s",
          }}
          title="Send"
        >
          ➤
        </button>
      </form>

      {/* Bounce keyframe injected inline */}
      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
