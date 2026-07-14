import { useNavigate, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import { login } from "../api/backend-api";
import { cardStyle, primaryButtonStyle, iconSize } from "../styles/tokens";
import { useToast } from "../context/ToastContext";
import { recordAuditEvent } from "../utils/auditLog";

const THEME_KEY = "evidex-theme";
const EMAIL_REGEX = /^(?=.{1,254}$)(?=.{1,64}@)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

const SUPPORTED_GENERIC_TLDS = new Set([
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "mil",
  "int",
  "biz",
  "info",
  "name",
  "pro",
  "io",
  "ai",
  "app",
  "dev",
  "tech",
  "cloud",
  "online",
  "site",
]);

const SUPPORTED_COUNTRY_TLDS = new Set([
  "ac", "ad", "ae", "af", "ag", "ai", "al", "am", "ao", "aq", "ar", "as", "at", "au", "aw", "ax", "az",
  "ba", "bb", "bd", "be", "bf", "bg", "bh", "bi", "bj", "bm", "bn", "bo", "bq", "br", "bs", "bt", "bv", "bw", "by", "bz",
  "ca", "cc", "cd", "cf", "cg", "ch", "ci", "ck", "cl", "cm", "cn", "co", "cr", "cu", "cv", "cw", "cx", "cy", "cz",
  "de", "dj", "dk", "dm", "do", "dz",
  "ec", "ee", "eg", "eh", "er", "es", "et", "eu",
  "fi", "fj", "fk", "fm", "fo", "fr",
  "ga", "gb", "gd", "ge", "gf", "gg", "gh", "gi", "gl", "gm", "gn", "gp", "gq", "gr", "gs", "gt", "gu", "gw", "gy",
  "hk", "hm", "hn", "hr", "ht", "hu",
  "id", "ie", "il", "im", "in", "iq", "ir", "is", "it",
  "je", "jm", "jo", "jp",
  "ke", "kg", "kh", "ki", "km", "kn", "kp", "kr", "kw", "ky", "kz",
  "la", "lb", "lc", "li", "lk", "lr", "ls", "lt", "lu", "lv", "ly",
  "ma", "mc", "md", "me", "mf", "mg", "mh", "mk", "ml", "mm", "mn", "mo", "mp", "mq", "mr", "ms", "mt", "mu", "mv", "mw", "mx", "my", "mz",
  "na", "nc", "ne", "nf", "ng", "ni", "nl", "no", "np", "nr", "nu", "nz",
  "om",
  "pa", "pe", "pf", "pg", "ph", "pk", "pl", "pm", "pn", "pr", "ps", "pt", "pw", "py",
  "qa",
  "re", "ro", "rs", "ru", "rw",
  "sa", "sb", "sc", "sd", "se", "sg", "sh", "si", "sj", "sk", "sl", "sm", "sn", "so", "sr", "ss", "st", "sv", "sx", "sy", "sz",
  "tc", "td", "tf", "tg", "th", "tj", "tk", "tl", "tm", "tn", "to", "tr", "tt", "tv", "tw", "tz",
  "ua", "ug", "uk", "um", "us", "uy", "uz",
  "va", "vc", "ve", "vg", "vi", "vn", "vu",
  "wf", "ws",
  "ye", "yt",
  "za", "zm", "zw",
]);

function isSupportedTopLevelDomain(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  if (!domain) return false;

  const labels = domain.split(".");
  const tld = labels[labels.length - 1];
  if (!tld) return false;

  if (/^[a-z]{2}$/.test(tld)) {
    return SUPPORTED_COUNTRY_TLDS.has(tld);
  }

  return SUPPORTED_GENERIC_TLDS.has(tld);
}

function isValidGlobalEmail(value: string): boolean {
  const candidate = value.trim();
  return EMAIL_REGEX.test(candidate) && isSupportedTopLevelDomain(candidate);
}

export default function LoginPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    const storedTheme = localStorage.getItem(THEME_KEY);
    const theme = storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const normalizedEmail = email.trim();

    if (!normalizedEmail || !password) return;

    if (!isValidGlobalEmail(normalizedEmail)) {
      setEmailError("Enter a valid email address");
      return;
    }

    setEmailError(null);

    setIsLoading(true);
    try {
      const result = await login(normalizedEmail, password);

      sessionStorage.setItem("isAuthenticated", "true");
      sessionStorage.setItem("userEmail", result.user.email);
      sessionStorage.setItem("userRole", result.user.role);

      recordAuditEvent({
        eventName: "auth.login.success",
        action: "User logged in",
        category: "authentication",
        module: "auth",
        feature: "login",
        source: "ui",
        actor: {
          email: result.user.email,
          role: String(result.user.role || "auditor"),
          userId: result.user.email.split("@")[0] || result.user.email,
        },
        metadata: {
          loginMethod: "password",
        },
      });

      navigate("/dashboard");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Invalid login credentials";

      recordAuditEvent({
        eventName: "auth.login.failed",
        action: "Failed login attempt",
        category: "authentication",
        module: "auth",
        feature: "login",
        severity: "warning",
        source: "ui",
        actor: {
          email: normalizedEmail || "unknown@unknown",
          role: "unknown",
          userId: normalizedEmail.split("@")[0] || "unknown",
        },
        metadata: {
          reason: message,
        },
      });

      showToast(message, "error");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "var(--bg-color)",
      }}
    >
      <form
        onSubmit={handleLogin}
        style={{
          ...cardStyle,
          width: "380px",
          padding: "36px",
          color: "var(--text-color)",
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ textAlign: "center", marginTop: 0, marginBottom: "28px" }}>EviDex</h1>

        <label style={{ display: "block" }}>
          <span style={{ fontSize: "14px", fontWeight: 600 }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => {
              const nextValue = e.target.value;
              setEmail(nextValue);
              if (!nextValue.trim()) {
                setEmailError(null);
                return;
              }
              setEmailError(
                isValidGlobalEmail(nextValue)
                  ? null
                  : "Enter a valid email address"
              );
            }}
            required
            autoComplete="email"
            aria-invalid={Boolean(emailError)}
            style={inputStyle}
          />
          {emailError && (
            <p
              style={{
                margin: "8px 0 0 0",
                fontSize: "12px",
                color: "#ef4444",
              }}
            >
              {emailError}
            </p>
          )}
        </label>

        <label style={{ display: "block", marginTop: "18px" }}>
          <span style={{ fontSize: "14px", fontWeight: 600 }}>Password</span>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ ...inputStyle, flex: 1, marginTop: 0 }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{
                border: "1px solid var(--border-color)",
                background: "var(--card-bg)",
                color: "var(--text-color)",
                borderRadius: "6px",
                minWidth: "42px",
                cursor: "pointer",
              }}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} size={iconSize.base} />
            </button>
          </div>
        </label>

        <div style={{ marginTop: "14px", textAlign: "right" }}>
          <Link to="/forgot-password" style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            Forgot password?
          </Link>
        </div>

        <button type="submit" disabled={isLoading || Boolean(emailError)} style={{ ...primaryButtonStyle, width: "100%", marginTop: "28px", padding: "14px" }}>
          {isLoading ? "Logging in…" : "Login"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  marginTop: "8px",
  background: "transparent",
  border: "1px solid var(--evidex-green)",
  borderRadius: "6px",
  color: "inherit",
  fontSize: "14px",
  boxSizing: "border-box",
};
