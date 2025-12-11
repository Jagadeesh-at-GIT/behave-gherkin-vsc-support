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

STEPS_DIR = "features/steps"
FEATURES_DIR = "features"

def normalize_gherkin(s: str) -> str:
    s = s.strip()
    s = re.sub(r'^(Feature|Scenario|Given|When|Then|And|But)\s+', '', s, flags=re.I)
    s = re.sub(r'"[^"]*"', '"{}"', s)
    return s.strip()

def normalize_pattern(pat: str) -> str:
    pat = pat.strip()
    pat = re.sub(r'^[ruRU]\s*', '', pat)  # remove r' or u' prefix
    if (pat.startswith('"') and pat.endswith('"')) or (pat.startswith("'") and pat.endswith("'")):
        pat = pat[1:-1]
    pat = re.sub(r'\{[^}]+\}', '{}', pat)
    pat = re.sub(r'"[^"]*"', '"{}"', pat)
    return pat.strip()

def build_index():
    root = Path.cwd()
    step_root = root / STEPS_DIR
    res = []
    if not step_root.exists():
        return res
    for py in step_root.rglob("*.py"):
        try:
            text = py.read_text(encoding="utf-8")
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), start=1):
            m = re.match(r'^\s*@(?P<kw>given|when|then|step)\((?P<pat>.+)\)', line, flags=re.I)
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
    idx = build_index()
    for e in idx:
        if e["normalized"] == targ:
            return e
    return None

def list_undefined():
    root = Path.cwd()
    feat_root = root / FEATURES_DIR
    if not feat_root.exists():
        return []
    idx = build_index()
    normalized_set = {e["normalized"] for e in idx}
    missing = []
    for f in feat_root.rglob("*.feature"):
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
