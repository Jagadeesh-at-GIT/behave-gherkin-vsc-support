#!/usr/bin/env python3
# tools/find_step.py
"""
Usage:
  python tools/find_step.py --index
  python tools/find_step.py --line 'When the user sends a "GET" request'
  python tools/find_step.py --undefined

Outputs JSON to stdout.

Assumes workspace root = current working directory with:
  features/**/*.feature
  features/steps/**/*.py
"""

import sys, json, argparse, re
from pathlib import Path

def find_feature_files(root: Path):
    return list(root.rglob("*.feature"))

STEP_DECORATOR_RE = re.compile(
    r'^\s*@(?P<kw>given|when|then|step|and)\s*\(',
    re.I | re.M
)

def is_step_file(py_file: Path) -> bool:
    try:
        text = py_file.read_text(encoding="utf-8")
    except Exception:
        return False
    return bool(STEP_DECORATOR_RE.search(text))

def find_step_files(root: Path):
    step_files = []
    for py in root.rglob("*.py"):
        if is_step_file(py):
            step_files.append(py)
    return step_files



def normalize_gherkin(s: str) -> str:
    """
    Normalize a Gherkin line from a .feature file by:
      - removing leading keyword (Feature/Scenario/Given/When/Then/And/But)
      - replacing quoted strings with "{}"
      - replacing numeric tokens (integers/floats) with "{}"
      - collapsing extra whitespace
    This makes it comparable to normalized patterns extracted from step defs.
    """
    s = s.strip()
    s = re.sub(r'^(Feature|Scenario|Given|When|Then|And)\s+', '', s, flags=re.I)
    # replace quoted strings with placeholder
    s = re.sub(r'"[^"]*"', '"{}"', s)
    s = re.sub(r"'[^']*'", "'{}'", s)
    # replace numbers (integers and floats) with placeholder
    s = re.sub(r'\b\d+(\.\d+)?\b', '{}', s)
    # def repl_token(m):
    #     token = m.group(0)
    #     if token == "{}":
    #         return token
    #     if "_" in token or re.search(r'\d', token):
    #         return "{}"
    #     return token

    # s = re.sub(r'\b[A-Za-z_][A-Za-z0-9_]*\b', repl_token, s)
    # collapse whitespace
    s = re.sub(r'\s+', ' ', s)
    return s.strip()

def normalize_pattern(pat: str) -> str:
    """
    Normalize a pattern from step decorator:
      - remove r/R/u prefixes and surrounding quotes
      - replace {param} placeholders with {}
      - replace any quoted string inside pattern with {}
      - replace numeric regex groups with {}
    """
    pat = pat.strip()
    # strip leading r' or u' etc.
    pat = re.sub(r'^[ruRU]\s*', '', pat)
    # remove surrounding quotes if present
    if (pat.startswith('"') and pat.endswith('"')) or (pat.startswith("'") and pat.endswith("'")):
        pat = pat[1:-1]
    # replace {param} with {}
    pat = re.sub(r'\{[^}]+\}', '{}', pat)
    # replace explicit regex numeric groups like (\d+), (\d+\.\d+), etc. with {}
    pat = re.sub(r'\(\\?d\+\)', '{}', pat)           # (\d+)
    pat = re.sub(r'\(\\?d\+\.\d\+\)', '{}', pat)     # (\d+\.\d+)
    # replace quoted pieces with {}
    pat = re.sub(r'"[^"]*"', '"{}"', pat)
    pat = re.sub(r"\'[^\']*\'", "'{}'", pat)
    # collapse whitespace
    pat = re.sub(r'\s+', ' ', pat)
    return pat.strip()

def build_index():
    root = Path.cwd()
    res = []

    for py in find_step_files(root):
        try:
            text = py.read_text(encoding="utf-8")
        except Exception:
            continue

        for i, line in enumerate(text.splitlines(), start=1):
            m = re.match(
                r'^\s*@(?P<kw>given|when|then|step|and)\((?P<pat>.+)\)',
                line,
                flags=re.I
            )
            if m:
                raw = m.group("pat").strip()
                norm = normalize_pattern(raw)
                res.append({
                    "file": str(py),
                    "line": i,
                    "raw": raw,
                    "normalized": norm,
                    "keyword": m.group("kw").lower()
                })

    return res


def find_match(gherkin_line: str):
    targ = normalize_gherkin(gherkin_line)
    print("Searching for normalized line:", targ)
    idx = build_index()
    for e in idx:
        if e["normalized"] == targ:
            return e
    return None

def list_undefined():
    root = Path.cwd()
    idx = build_index()
    normalized_set = {e["normalized"] for e in idx}
    missing = []

    for f in find_feature_files(root):
        try:
            txt = f.read_text(encoding="utf-8")
        except Exception:
            continue

        for i, line in enumerate(txt.splitlines(), start=1):
            if re.search(r'\b(Given|When|Then|And|But)\b', line):
                norm = normalize_gherkin(line)
                if norm and norm not in normalized_set:
                    missing.append({
                        "feature_file": str(f),
                        "line": i,
                        "text": line.strip(),
                        "normalized": norm
                    })

    return missing

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", action="store_true")
    parser.add_argument("--line", type=str)
    parser.add_argument("--undefined", action="store_true")
    args = parser.parse_args()
    if args.index:
        print(json.dumps(build_index(), ensure_ascii=False))
        return
    if args.line:
        print(json.dumps(find_match(args.line), ensure_ascii=False))
        return
    if args.undefined:
        print(json.dumps(list_undefined(), ensure_ascii=False))
        return
    parser.print_help()

if __name__ == "__main__":
    main()