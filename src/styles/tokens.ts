/**
 * EviDex Design System — Shared Tokens
 *
 * All style constants live here. Import and use these instead of
 * hard-coding colours, sizes, or spacings in components.
 */

// ─── Brand ────────────────────────────────────────────────────────────────────
export const color = {
  /** Primary brand green */
  brand: "#99cc00",
  /** Text on brand-green surfaces */
  brandText: "#111827",
  /** Subtle brand tint used for active/hover backgrounds */
  brandTint: "rgba(153, 204, 0, 0.14)",
  /** Slightly stronger tint for selected items */
  brandTintStrong: "rgba(153, 204, 0, 0.2)",

  // ─── Semantic status ────────────────────────────────────────────────────────
  success: "#22c55e",
  successBg: "#d1fae5",
  successBorder: "#6ee7b7",
  successText: "#065f46",

  warning: "#f59e0b",
  warningBg: "#fef3c7",
  warningBorder: "#fcd34d",
  warningText: "#92400e",

  danger: "#ef4444",
  dangerBg: "#fee2e2",
  dangerBorder: "#fca5a5",
  dangerText: "#991b1b",

  info: "#3b82f6",
  infoBg: "#dbeafe",
  infoBorder: "#93c5fd",
  infoText: "#1e3a8a",

  // ─── Workflow stage colours (fixed — not theme-sensitive) ───────────────────
  stage: {
    initialization: "#3b82f6",
    interpretation: "#8b5cf6",
    retrieval: "#06b6d4",
    validation: "#f59e0b",
    conclusion: "#10b981",
    approval: "#ec4899",
    exported: "#6b7280",
  },
} as const;

// ─── Typography ───────────────────────────────────────────────────────────────
export const font = {
  family: '"Aptos", "Segoe UI", system-ui, sans-serif',
  size: {
    xs: "11px",
    sm: "12px",
    base: "14px",
    md: "15px",
    lg: "16px",
    xl: "18px",
    "2xl": "20px",
    "3xl": "24px",
    "4xl": "28px",
  },
  weight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: 1.3,
    normal: 1.5,
    relaxed: 1.6,
  },
} as const;

// ─── Spacing ──────────────────────────────────────────────────────────────────
export const space = {
  "0": "0",
  "1": "4px",
  "2": "8px",
  "3": "12px",
  "4": "16px",
  "5": "20px",
  "6": "24px",
  "7": "28px",
  "8": "32px",
  "10": "40px",
  "12": "48px",
} as const;

// ─── Border radius ────────────────────────────────────────────────────────────
export const radius = {
  /** Badges, tags, small chips */
  sm: "4px",
  /** Inputs, small buttons, inline elements */
  base: "6px",
  /** Buttons, nav items, list items */
  md: "8px",
  /** Cards, panels, modals */
  lg: "12px",
  /** Pills / fully rounded */
  full: "9999px",
} as const;

// ─── Shadows ──────────────────────────────────────────────────────────────────
export const shadow = {
  none: "none",
  sm: "0 1px 2px rgba(0, 0, 0, 0.06)",
  base: "0 2px 6px rgba(0, 0, 0, 0.08)",
  md: "0 4px 12px rgba(0, 0, 0, 0.10)",
  lg: "0 8px 24px rgba(0, 0, 0, 0.12)",
} as const;

// ─── Icon ─────────────────────────────────────────────────────────────────────
/** Standard FontAwesome icon size tokens */
export const iconSize = {
  /** Inline / compact contexts (12 px) */
  sm: "sm" as const,
  /** Default body-text icon (16 px) */
  base: "1x" as const,
  /** Heading / feature icon (20 px) */
  lg: "lg" as const,
  /** Hero / metric icon (24 px) */
  xl: "xl" as const,
} as const;

// ─── Transitions ──────────────────────────────────────────────────────────────
export const transition = {
  fast: "0.15s ease",
  base: "0.2s ease",
  slow: "0.3s ease",
} as const;

// ─── Shared style objects ─────────────────────────────────────────────────────
// These are ready-to-spread React CSSProperties objects.

/** Standard card — two-px brand border, lg radius */
export const cardStyle: React.CSSProperties = {
  padding: space["4"],
  border: `2px solid ${color.brand}`,
  borderRadius: radius.lg,
  background: "var(--card-bg)",
};

/** Subtle secondary card — thin theme border */
export const cardSubtleStyle: React.CSSProperties = {
  padding: space["4"],
  border: "1px solid var(--border-color)",
  borderRadius: radius.lg,
  background: "var(--card-bg)",
};

/** Primary action button */
export const primaryButtonStyle: React.CSSProperties = {
  padding: `${space["3"]} ${space["4"]}`,
  background: color.brand,
  border: "none",
  borderRadius: radius.base,
  color: color.brandText,
  fontFamily: font.family,
  fontSize: font.size.base,
  fontWeight: font.weight.semibold,
  cursor: "pointer",
  transition: `opacity ${transition.base}`,
};

/** Secondary / outline button */
export const secondaryButtonStyle: React.CSSProperties = {
  padding: `${space["2"]} ${space["3"]}`,
  background: "transparent",
  border: "1px solid var(--border-color)",
  borderRadius: radius.md,
  color: "inherit",
  fontFamily: font.family,
  fontSize: font.size.base,
  fontWeight: font.weight.semibold,
  cursor: "pointer",
  transition: `opacity ${transition.base}`,
};

/** Danger / destructive button */
export const dangerButtonStyle: React.CSSProperties = {
  padding: `${space["3"]} ${space["4"]}`,
  background: color.danger,
  border: "none",
  borderRadius: radius.base,
  color: "#ffffff",
  fontFamily: font.family,
  fontSize: font.size.base,
  fontWeight: font.weight.semibold,
  cursor: "pointer",
  transition: `opacity ${transition.base}`,
};

/** Success / approve button */
export const successButtonStyle: React.CSSProperties = {
  padding: `${space["3"]} ${space["4"]}`,
  background: color.success,
  border: "none",
  borderRadius: radius.base,
  color: "#ffffff",
  fontFamily: font.family,
  fontSize: font.size.base,
  fontWeight: font.weight.semibold,
  cursor: "pointer",
  transition: `opacity ${transition.base}`,
};

/** Warning / revision button */
export const warningButtonStyle: React.CSSProperties = {
  padding: `${space["3"]} ${space["4"]}`,
  background: color.warning,
  border: "none",
  borderRadius: radius.base,
  color: "#ffffff",
  fontFamily: font.family,
  fontSize: font.size.base,
  fontWeight: font.weight.semibold,
  cursor: "pointer",
  transition: `opacity ${transition.base}`,
};

/** Text / form input field */
export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: `${space["2"]} ${space["3"]}`,
  marginTop: space["2"],
  background: "transparent",
  border: `1px solid ${color.brand}`,
  borderRadius: radius.base,
  color: "inherit",
  fontFamily: font.family,
  fontSize: font.size.base,
  boxSizing: "border-box",
};

/** Error / danger alert block */
export const errorAlertStyle: React.CSSProperties = {
  padding: space["3"],
  background: color.dangerBg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.base,
  color: color.dangerText,
  fontSize: font.size.base,
  marginBottom: space["4"],
};

/** Table header cell */
export const thStyle: React.CSSProperties = {
  padding: space["3"],
  textAlign: "left",
  fontSize: font.size.sm,
  fontWeight: font.weight.semibold,
  borderBottom: "1px solid var(--border-color)",
  color: "inherit",
};

/** Table data cell */
export const tdStyle: React.CSSProperties = {
  padding: space["3"],
  fontSize: font.size.base,
  borderBottom: "1px solid var(--border-color)",
  verticalAlign: "top",
};
