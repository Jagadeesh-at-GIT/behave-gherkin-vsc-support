# behave-gherkin-vsc-support

VS Code hybrid extension (Python CLI + TS) for Behave/Gherkin:

- Highlight undefined Gherkin steps
- Go to step definition (F12 / right-click)
- Quick-fix to create step definition into a selected `.py` file (skeleton)
- Semantic coloring for Feature/Scenario/Given/When/Then/And/But and quoted parameters

## Dev quickstart

1. Ensure `python3` (or `python`) is on PATH.
2. Open this folder in VS Code.
3. Run:
   ```bash
   npm install
   npm run compile
