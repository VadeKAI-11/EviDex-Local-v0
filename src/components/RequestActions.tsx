import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBoxArchive, faTrash } from "@fortawesome/free-solid-svg-icons";
import type { CSSProperties, MouseEvent } from "react";

type RequestActionsProps = {
  onArchive?: () => void;
  onDelete?: () => void;
  archiveTitle?: string;
  deleteTitle?: string;
  compact?: boolean;
};

function stopAndRun(event: MouseEvent<HTMLButtonElement>, action: () => void) {
  event.stopPropagation();
  action();
}

export default function RequestActions({
  onArchive,
  onDelete,
  archiveTitle = "Archive request",
  deleteTitle = "Delete request",
  compact = false,
}: RequestActionsProps) {
  if (!onArchive && !onDelete) {
    return null;
  }

  const buttonSize = compact ? "24px" : "28px";
  const iconSize = compact ? "11px" : "12px";

  return (
    <div style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
      {onArchive && (
        <button
          type="button"
          onClick={(event) => stopAndRun(event, onArchive)}
          style={{
            ...actionButton,
            width: buttonSize,
            height: buttonSize,
          }}
          title={archiveTitle}
          aria-label={archiveTitle}
        >
          <FontAwesomeIcon icon={faBoxArchive} style={{ fontSize: iconSize }} />
        </button>
      )}

      {onDelete && (
        <button
          type="button"
          onClick={(event) => stopAndRun(event, onDelete)}
          style={{
            ...actionButton,
            width: buttonSize,
            height: buttonSize,
            color: "var(--color-danger)",
          }}
          title={deleteTitle}
          aria-label={deleteTitle}
        >
          <FontAwesomeIcon icon={faTrash} style={{ fontSize: iconSize }} />
        </button>
      )}
    </div>
  );
}

const actionButton: CSSProperties = {
  border: "1px solid var(--border-color)",
  background: "var(--card-bg)",
  color: "inherit",
  borderRadius: "6px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};
