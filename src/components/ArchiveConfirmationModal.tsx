import { useEffect } from "react";

type Props = {
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ArchiveConfirmationModal({
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const bodyStyle = document.body.style;
    const previousOverflow = bodyStyle.overflow;
    const previousPaddingRight = bodyStyle.paddingRight;
    const scrollbarCompensation =
      window.innerWidth - document.documentElement.clientWidth;

    bodyStyle.overflow = "hidden";
    if (scrollbarCompensation > 0) {
      bodyStyle.paddingRight = `${scrollbarCompensation}px`;
    }

    return () => {
      bodyStyle.overflow = previousOverflow;
      bodyStyle.paddingRight = previousPaddingRight;
    };
  }, []);

  return (
    <div className="evidex-modal-overlay">
      <div
        className="evidex-modal-panel"
        style={{
          width: "360px",
        }}
      >
        <h3>Confirm Archive</h3>
        <p style={{ marginTop: "8px", opacity: 0.8 }}>
          This request will move to the Archive section and remain read-only for
          retention and audit review.
        </p>

        <div className="evidex-modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="evidex-modal-primary"
            onClick={onConfirm}
            style={{
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}