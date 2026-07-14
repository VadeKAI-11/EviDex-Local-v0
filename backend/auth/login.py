import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["Auth"])

EMAIL_REGEX = re.compile(
    r"^(?=.{1,254}$)(?=.{1,64}@)"
    r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$"
)

SUPPORTED_GENERIC_TLDS = {
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
}

SUPPORTED_COUNTRY_TLDS = {
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
}


def is_supported_top_level_domain(value: str) -> bool:
    candidate = (value or "").strip().lower()
    if "@" not in candidate:
        return False

    domain = candidate.split("@", 1)[1]
    labels = domain.split(".")
    if not labels:
        return False

    tld = labels[-1]
    if not tld:
        return False

    if re.fullmatch(r"[a-z]{2}", tld):
        return tld in SUPPORTED_COUNTRY_TLDS

    return tld in SUPPORTED_GENERIC_TLDS


def is_valid_global_email(value: str) -> bool:
    candidate = (value or "").strip()
    return bool(EMAIL_REGEX.fullmatch(candidate)) and is_supported_top_level_domain(candidate)

class LoginRequest(BaseModel):
    email: str
    password: str

@router.post("/login")
def login(req: LoginRequest):
    email = (req.email or "").strip()
    password = (req.password or "").strip()

    if not email or not password:
        raise HTTPException(status_code=400, detail="Invalid credentials")

    if not is_valid_global_email(email):
        raise HTTPException(
            status_code=400,
            detail="Invalid email format. Use a valid email address, for example auditor@company.com.",
        )

    return {
        "authenticated": True,
        "user": {
            "email": email,
            "role": "Auditor"
        }
    }