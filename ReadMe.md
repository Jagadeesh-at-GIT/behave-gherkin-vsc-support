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

# Behave Gherkin VSC Support 🥒🐍

VS Code extension that adds **first-class support for Behave (Python) + Gherkin** feature files.

This extension helps you **navigate, validate, and author Gherkin steps faster** by intelligently linking `.feature` files with Behave step definitions.

---

## ✨ Features

### 🔗 Step Definition Navigation
- **Go to Step Definition** from any Gherkin step (`F12` or right-click)
- Works with:
  - Parameters (`"{param}"`, numbers, snake_case values)
  - Quoted and unquoted arguments
  - Dynamic values

---

### ⚠️ Undefined Step Detection
- Automatically **underlines Gherkin steps** that have no matching step definition
- Diagnostics update:
  - On file change
  - On step file updates
  - Without reloading VS Code

---

### 🛠 Create Step Definition (Quick Fix)
- Hover or place cursor on an undefined step
- Click **“Create step definition…”**
- Choose:
  - Existing step file
  - Or create a new one
- Generates a **ready-to-use Behave step skeleton**:
  ```python
  @then('the response status code should be {status_code}')
  def step_impl(context, status_code):
      raise NotImplementedError("Step not implemented")
