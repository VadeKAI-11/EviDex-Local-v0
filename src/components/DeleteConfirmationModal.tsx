import { useEffect } from "react";

type Props = {
  onConfirm: () => void;
  onCancel: () => void;
};

export default function DeleteConfirmationModal({
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const bodyStyle = document.body.style;
    const previousOverflow = bodyStyle.overflow;
    const previousPaddingRight = bodyStyle.paddingRight;
    const scrollbarCompensation = window.innerWidth - document.documentElement.clientWidth;

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
        <h3>Confirm Delete</h3>
        <p style={{ marginTop: "8px", opacity: 0.8 }}>
          This request will move to the recycle bin. You can restore it
          within 90 days before it is automatically purged.
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
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}