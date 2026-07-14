import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

const DURATION_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = "info") => {
      const id = ++nextId.current;
      setToasts((prev) => [...prev, { id, message, type }]);
      window.setTimeout(() => dismiss(id), DURATION_MS);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ─── internal container ────────────────────────────────────────────────────

function toastBg(type: ToastType): string {
  switch (type) {
    case "success":
      return "var(--color-success-bg, #dcfce7)";
    case "error":
      return "var(--color-danger-bg, #fee2e2)";
    case "warning":
      return "var(--color-warning-bg, #fef9c3)";
    default:
      return "var(--color-info-bg, #dbeafe)";
  }
}

function toastBorder(type: ToastType): string {
  switch (type) {
    case "success":
      return "var(--color-success-border, #86efac)";
    case "error":
      return "var(--color-danger-border, #fca5a5)";
    case "warning":
      return "var(--color-warning-border, #fde047)";
    default:
      return "var(--color-info-border, #93c5fd)";
  }
}

function toastTextColor(type: ToastType): string {
  switch (type) {
    case "success":
      return "var(--color-success-text, #166534)";
    case "error":
      return "var(--color-danger-text, #991b1b)";
    case "warning":
      return "var(--color-warning-text, #854d0e)";
    default:
      return "var(--color-info-text, #1e40af)";
  }
}

function toastIcon(type: ToastType): string {
  switch (type) {
    case "success":
      return "✓";
    case "error":
      return "✕";
    case "warning":
      return "⚠";
    default:
      return "ℹ";
  }
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        zIndex: 9999,
        maxWidth: "360px",
        width: "100%",
      }}
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "8px",
            border: `1px solid ${toastBorder(toast.type)}`,
            background: toastBg(toast.type),
            color: toastTextColor(toast.type),
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            fontSize: "14px",
            lineHeight: 1.4,
            animation: "evidex-toast-in 0.2s ease",
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontSize: "15px",
              flexShrink: 0,
              marginTop: "1px",
            }}
          >
            {toastIcon(toast.type)}
          </span>
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              fontSize: "16px",
              lineHeight: 1,
              padding: "0",
              flexShrink: 0,
              opacity: 0.6,
            }}
          >
            ×
          </button>
        </div>
      ))}

      <style>{`
        @keyframes evidex-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
