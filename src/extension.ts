//---This is new code---
// src/extension.ts
import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { promisify } from "util";

const execFile = promisify(cp.execFile);

const DEFAULT_PY_CLI_REL = path.posix.join("tools", "find_step.py");
const KEYWORDS = ["Feature", "Scenario", "Given", "When", "Then", "And","Scenario Outline"];
const GHERKIN_IDS = ["feature", "gherkin"];

type StepDef = {
  file: string;
  line: number;
  raw: string;
  normalized: string;
  keyword?: string;
};

// ---------- Output channel helper (minimal typing)
function getOutputChannel(): vscode.OutputChannel {
  const g: any = globalThis as any;
  if (g.__behaveGherkinOutputChannel && g.__behaveGherkinOutputChannel.append) {
    return g.__behaveGherkinOutputChannel;
  }
  const ch = vscode.window.createOutputChannel("Behave Gherkin");
  (globalThis as any).__behaveGherkinOutputChannel = ch;
  return ch;
}

// ---------- Local TS normalizer (mirror Python normalize_gherkin)
function normalizeGherkinTS(line: string): string {
  let s = line.trim();
  // remove leading Gherkin keyword
  s = s.replace(/^(Feature|Scenario|Given|When|Then|And|But)\s+/i, "");
  // replace quoted strings with "{}"
  s = s.replace(/"[^"]*"/g, '"{}"');
  s = s.replace(/'[^']*'/g, "'{}'");
  // replace numbers (int/float)
  s = s.replace(/\b\d+(\.\d+)?\b/g, "{}");
  // static words set (lowercase) - words we shouldn't treat as variable placeholders
  // const STATIC_WORDS = new Set([
  //   "response", "should", "have", "an", "event", "triggered",
  //   "the", "when", "given", "then", "and", "but", "feature", "scenario",
  //   "user", "response_json", "time", "is", "to", "in", "on", "a", "of", "for"
  // ]);
  // replace variable-like unquoted tokens with {} if they look like variable and not static
  s = s.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, (m) => {
    if (m === "{}") return m;
    // if token contains underscore or digit, treat as param placeholder
    // if (/[0-9]/.test(m) || m.includes("_")) return "{}";
    // otherwise keep the token (likely normal English / keyword)
    return m;
  });
  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ---------- Python CLI helpers (unchanged logic) ----------
async function findPython(configuredPath?: string): Promise<string | null> {
  if (configuredPath && configuredPath.trim().length > 0) {
    try {
      await execFile(configuredPath, ["--version"], { timeout: 2000 });
      return configuredPath;
    } catch {}
  }
  for (const c of ["python3", "python"]) {
    try {
      await execFile(c, ["--version"], { timeout: 2000 });
      return c;
    } catch {}
  }
  return null;
}

async function runPythonCli(args: string[], cwd: string, context: vscode.ExtensionContext): Promise<any> {
  const output = getOutputChannel();
  output.appendLine(`runPythonCli: args=${JSON.stringify(args)}, cwd=${cwd}`);

  const cfg = vscode.workspace.getConfiguration("behaveGherkin");
  const configuredFindPath = cfg.get<string>("findStepPath") ?? DEFAULT_PY_CLI_REL;
  const configuredPython = cfg.get<string>("pythonPath") ?? "";

  output.appendLine(`Configured findStepPath: ${configuredFindPath}`);
  output.appendLine(`Configured pythonPath: ${configuredPython}`);

  const py = await findPython(configuredPython);
  if (!py) {
    const msg = "Python not found (python3 or python required on PATH) and behaveGherkin.pythonPath not configured correctly.";
    output.appendLine(msg);
    throw new Error(msg);
  }
  output.appendLine(`Using python executable: ${py}`);

  const candidates: string[] = [];
  const wsfolders = vscode.workspace.workspaceFolders || [];
  for (const ws of wsfolders) {
    const candidate = path.join(ws.uri.fsPath, configuredFindPath);
    candidates.push(candidate);
  }
  if (path.isAbsolute(configuredFindPath)) {
    candidates.unshift(configuredFindPath);
  }
  const bundled = context.asAbsolutePath(path.posix.join("tools", "find_step.py"));
  candidates.push(bundled);

  output.appendLine("CLI candidate paths (in order):");
  for (const c of candidates) output.appendLine(`  - ${c}`);

  let lastErr: any = null;
  for (const cliPath of candidates) {
    try {
      if (!fs.existsSync(cliPath)) {
        output.appendLine(`CLI not found at: ${cliPath}`);
        continue;
      }
      output.appendLine(`Attempting to run CLI at: ${cliPath}`);
      const { stdout } = await execFile(py, [cliPath, ...args], { cwd, timeout: 20000 });
      output.appendLine(`CLI stdout (first 400 chars): ${String(stdout).slice(0, 400)}`);
      try {
        const parsed = JSON.parse(stdout || "null");
        output.appendLine(`CLI parsed JSON successfully from: ${cliPath}`);
        return parsed;
      } catch (jerr) {
        output.appendLine(`Failed to parse JSON from CLI at ${cliPath}: ${jerr}`);
        lastErr = jerr;
        continue;
      }
    } catch (err: any) {
      output.appendLine(`Error running CLI at ${cliPath}: ${err && err.message ? err.message : String(err)}`);
      lastErr = err;
      continue;
    }
  }

  const tried = candidates.join("\n");
  const help = `Index failed: CLI not found or failed to run. Tried:\n${tried}\nSet 'behaveGherkin.findStepPath' to the relative path of find_step.py in your workspace or ensure the CLI exists in your workspace.`;
  output.appendLine(help);
  if (lastErr) output.appendLine(`Last error: ${String(lastErr)}`);
  throw new Error(help + (lastErr ? `\nLast error: ${String(lastErr)}` : ""));
}

// ---------- Debounce helper ----------
function debounce<T extends (...args: any[]) => void>(fn: T, delay = 300) {
  let timer: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ---------- activate / main logic ----------
export async function activate(context: vscode.ExtensionContext) {
  const output = getOutputChannel();
  context.subscriptions.push(output);

  const diagCollection = vscode.languages.createDiagnosticCollection("behave-gherkin");
  context.subscriptions.push(diagCollection);

  let stepIndex: StepDef[] = [];

  // reindex function debounced to avoid spamming
  const doReindex = async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      output.appendLine("reindex: no workspace open, skipping.");
      return;
    }
    try {
      output.appendLine("Starting workspace index...");
      const res = await runPythonCli(["--index"], ws.uri.fsPath, context);
      stepIndex = Array.isArray(res) ? res : [];
      output.appendLine(`Index built: ${stepIndex.length} step definitions found.`);
    } catch (e: any) {
      output.appendLine("Index failed: " + (e.message || e));
      vscode.window.showErrorMessage("Index failed: " + (e.message || e));
      stepIndex = [];
    }
    await updateWorkspaceDiagnostics(); // refresh diagnostics after reindex
  };
  const reindex = debounce(doReindex, 400);

  // quick local match using stepIndex and TS normalizer
  async function findStepForLine(line: string): Promise<StepDef | null> {
    // first try CLI (more authoritative) — but we can also try local stepIndex equality match
    const normalized = normalizeGherkinTS(line);
    // exact match against existing index
    const found = stepIndex.find(s => s.normalized === normalized);
    if (found) return found;
    // fallback: try CLI (some users might have custom param types)
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return null;
    try {
      const res = await runPythonCli(["--line", line], ws.uri.fsPath, context);
      return res || null;
    } catch (e) {
      output.appendLine("findStepForLine fallback CLI errored: " + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }

  // Update diagnostics for whole workspace (used after reindex)
  async function updateWorkspaceDiagnostics() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    try {
      const missing = await runPythonCli(["--undefined"], ws.uri.fsPath, context);
      diagCollection.clear();
      if (Array.isArray(missing)) {
        const map = new Map<string, vscode.Diagnostic[]>();
        for (const m of missing) {
          const uri = vscode.Uri.file(m.feature_file);
          const range = new vscode.Range(m.line - 1, 0, m.line - 1, Math.min(m.text.length, 300));
          const diag = new vscode.Diagnostic(range, "Step definition not found", vscode.DiagnosticSeverity.Warning);
          diag.source = "behave-gherkin";
          const arr = map.get(uri.toString()) || [];
          arr.push(diag);
          map.set(uri.toString(), arr);
        }
        for (const [k, arr] of map.entries()) {
          diagCollection.set(vscode.Uri.parse(k), arr);
        }
      }
    } catch (e:any) {
      output.appendLine("Diagnostics update failed: " + (e && (e.message || e)));
    }
  }

  // quick per-document diagnostics using TS normalizer + current stepIndex (less flicker)
  function updateDocDiagnostics(doc: vscode.TextDocument) {
    if (!doc) return;
    const diagnostics: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(text)) continue;
      const normalized = normalizeGherkinTS(text);
      // if found in index, skip
      const matched = stepIndex.find(s => s.normalized === normalized);
      if (!matched) {
        const range = new vscode.Range(i, 0, i, Math.min(text.length, 300));
        diagnostics.push(new vscode.Diagnostic(range, "Step definition not found", vscode.DiagnosticSeverity.Warning));
      }
    }
    diagCollection.set(doc.uri, diagnostics);
  }

  // initial index
  await doReindex();

  // watchers for step files / feature files
  const stepsGlob = "features/steps/**/*.py";
  const featuresGlob = "features/**/*.feature";
  const w1 = vscode.workspace.createFileSystemWatcher(stepsGlob);
  const w2 = vscode.workspace.createFileSystemWatcher(featuresGlob);
  [w1, w2].forEach(w => {
    context.subscriptions.push(w);
    w.onDidCreate(reindex);
    w.onDidChange(reindex);
    w.onDidDelete(reindex);
  });

  // also reindex on workspace folder changes
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => reindex()));

  // Definition provider (F12)
  const defProvider: vscode.DefinitionProvider = {
    provideDefinition: async (doc, pos) => {
      const lineText = doc.lineAt(pos.line).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(lineText)) return null;
      const found = await findStepForLine(lineText);
      if (!found) return null;
      const uri = vscode.Uri.file(found.file);
      return new vscode.Location(uri, new vscode.Position(found.line - 1, 0));
    }
  };
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: "feature" }, defProvider));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: "gherkin" }, defProvider));

  // CodeAction provider (quick fix) - unchanged
  class CreateStepCodeActionProvider implements vscode.CodeActionProvider {
    public async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[] | undefined> {
      const line = document.lineAt(range.start.line).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(line)) return;
      const norm = normalizeGherkinTS(line);
      if (stepIndex.some(s => s.normalized === norm)) return;
      const action = new vscode.CodeAction("Create step definition...", vscode.CodeActionKind.QuickFix);
      action.command = { command: "behaveGherkin.createStepDefinition", title: "Create step", arguments: [document.uri, range.start.line] };
      return [action];
    }
  }
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: "feature" }, new CreateStepCodeActionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

  // Command: Go to step definition (unchanged)
  context.subscriptions.push(vscode.commands.registerCommand("behaveGherkin.goToStepDefinition", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("No active editor"); return; }
    const lineText = editor.document.lineAt(editor.selection.active.line).text;
    const found = await findStepForLine(lineText);
    if (!found) { vscode.window.showInformationMessage("No matching step definition found"); return; }
    const uri = vscode.Uri.file(found.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(found.line - 1, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }));

  // Command: Create step definition (unchanged) - uses existing implementation
  context.subscriptions.push(vscode.commands.registerCommand("behaveGherkin.createStepDefinition", async (featureUri?: vscode.Uri, lineNum?: number) => {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("Open a workspace folder first"); return; }

      let featureLine = "";
      if (featureUri && typeof lineNum === "number") {
        const doc = await vscode.workspace.openTextDocument(featureUri);
        featureLine = doc.lineAt(lineNum).text.trim();
      } else if (vscode.window.activeTextEditor) {
        featureLine = vscode.window.activeTextEditor.document.lineAt(vscode.window.activeTextEditor.selection.active.line).text.trim();
      } else {
        vscode.window.showErrorMessage("No feature line selected");
        return;
      }

      const files = await vscode.workspace.findFiles("**/features/steps/**/*.py", "**/node_modules/**", 100);
      const quickItems: vscode.QuickPickItem[] = [
        ...files.map(f => ({ label: path.relative(ws.uri.fsPath, f.fsPath), description: f.fsPath })),
        { label: "<Create new file>", description: "Create a new steps file (e.g. features/steps/new_steps.py)" }
      ];
      const pick = await vscode.window.showQuickPick(quickItems, { placeHolder: "Select steps file to add the generated step" });
      if (!pick) return;

      let targetUri: vscode.Uri;
      if (pick.label === "<Create new file>") {
        const input = await vscode.window.showInputBox({ prompt: "Enter relative path for new steps file", value: "features/steps/steps_generated.py" });
        if (!input) return;
        targetUri = ws.uri.with({ path: path.posix.join(ws.uri.path, input) });
      } else {
        targetUri = vscode.Uri.file((pick as any).description);
      }

      const paramMatches = Array.from(featureLine.matchAll(/"([^"]*)"/g));
      const params = paramMatches.map((_, i) => `param${i+1}`);
      let template = featureLine;
      let idx = 0;
      template = template.replace(/"([^"]*)"/g, () => {
        idx++; return `"{${params[idx-1]}}"`;
      });
      const kwMatch = /^\s*(Given|When|Then|And|But)\b/i.exec(featureLine);
      const kw = (kwMatch ? kwMatch[1] : "when").toLowerCase();

      const snippet = `@${kw}('${template}')
def step_impl(context${params.length ? ", " + params.join(", ") : ""}):
    \"\"\"Auto-generated step for: ${featureLine}\"\"\"
    # TODO: implement step
    raise NotImplementedError("Step not implemented")
\n`;

      try {
        await vscode.workspace.fs.stat(targetUri);
        const doc2 = await vscode.workspace.openTextDocument(targetUri);
        const edit = new vscode.WorkspaceEdit();
        const end = new vscode.Position(doc2.lineCount, 0);
        edit.insert(targetUri, end, "\n" + snippet);
        await vscode.workspace.applyEdit(edit);
        await doc2.save();
      } catch {
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from("# Generated behave steps\n\n" + snippet, "utf8"));
      }

      vscode.window.showInformationMessage(`Step created/updated in ${path.relative(ws.uri.fsPath, targetUri.fsPath)}`);
      reindex(); // async reindex
    } catch (e:any) {
      vscode.window.showErrorMessage("Create step failed: " + (e.message || e));
    }
  }));

  // Hover provider: if a step is undefined, show a hover with command link to create step
  const hoverProvider: vscode.HoverProvider = {
    provideHover: async (doc, pos) => {
      const lineText = doc.lineAt(pos.line).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(lineText)) return null;
      const found = await findStepForLine(lineText);
      if (found) return null; // defined step - no hover suggestion
      // show markdown with command link: command accepts args, we pass document uri and line number
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      // command link triggers createStepDefinition with args array
      md.appendMarkdown(`**Step definition not found.**  \n[Create step definition](command:behaveGherkin.createStepDefinition?${encodeURIComponent(JSON.stringify([doc.uri, pos.line]))})`);
      return new vscode.Hover(md);
    }
  };
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: "feature" }, hoverProvider));

  // Listen to doc open / change and update diagnostics quickly (and trigger reindex on fs changes)
  vscode.workspace.onDidOpenTextDocument(doc => {
    if (GHERKIN_IDS.includes(doc.languageId)) updateDocDiagnostics(doc);
  });
  // debounced per-document change to avoid heavy operations while typing
  const debouncedDocChange = debounce((doc: vscode.TextDocument) => {
    if (GHERKIN_IDS.includes(doc.languageId)) updateDocDiagnostics(doc);
  }, 200);
  vscode.workspace.onDidChangeTextDocument(ev => debouncedDocChange(ev.document));
  vscode.workspace.onDidSaveTextDocument(doc => {
    if (GHERKIN_IDS.includes(doc.languageId)) updateDocDiagnostics(doc);
    // also reindex when steps file saved
    if (doc.fileName.endsWith(".py") && doc.fileName.includes("features/steps")) {
      reindex();
    }
  });

  // Semantic tokens: keywords, strings (params), comments, variables (parameters)
  const tokenTypes = ["tag", "featureKeyword", "scenarioKeyword", "stepKeyword", "string", "variable", "comment"];
  const legend = new vscode.SemanticTokensLegend(tokenTypes, []);
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      [{ language: "feature" }, { language: "gherkin" }],
      new (class implements vscode.DocumentSemanticTokensProvider {
        async provideDocumentSemanticTokens(
          document: vscode.TextDocument
        ): Promise<vscode.SemanticTokens> {
          const builder = new vscode.SemanticTokensBuilder(legend);
  
          const tagToken       = tokenTypes.indexOf("tag");
          const featureToken   = tokenTypes.indexOf("featureKeyword");
          const scenarioToken  = tokenTypes.indexOf("scenarioKeyword");
          const stepToken      = tokenTypes.indexOf("stepKeyword");
          const stringToken    = tokenTypes.indexOf("string");
          const variableToken  = tokenTypes.indexOf("variable");
          const commentToken   = tokenTypes.indexOf("comment");
  
          for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
  
            // -------- TAGS (e.g. @Smoke @API-TC-100)
            for (const m of line.matchAll(/@[A-Za-z0-9_\-]+/g)) {
              if (m.index !== undefined) {
                builder.push(i, m.index, m[0].length, tagToken, 0);
              }
            }
  
            // -------- COMMENTS (# something)
            const commentMatch = /^\s*#/.exec(line);
            if (commentMatch) {
              builder.push(i, 0, line.length, commentToken, 0);
              continue;
            }
  
            // -------- FEATURE
            const featureMatch = /^\s*(Feature)\b/i.exec(line);
            if (featureMatch) {
              const s = line.indexOf(featureMatch[1]);
              builder.push(i, s, featureMatch[1].length, featureToken, 0);
              continue;
            }
  
            // -------- SCENARIO / SCENARIO OUTLINE
            const scenarioMatch = /^\s*(Scenario Outline|Scenario)\b/i.exec(line);
            if (scenarioMatch) {
              const s = line.indexOf(scenarioMatch[1]);
              builder.push(i, s, scenarioMatch[1].length, scenarioToken, 0);
              continue;
            }
  
            // -------- STEP KEYWORDS
            const stepMatch = /^\s*(Given|When|Then|And|But)\b/i.exec(line);
            if (stepMatch) {
              const s = line.indexOf(stepMatch[1]);
              builder.push(i, s, stepMatch[1].length, stepToken, 0);
            }
  
            // -------- QUOTED STRINGS ("value")
            for (const m of line.matchAll(/"[^"]*"/g)) {
              if (m.index !== undefined) {
                builder.push(i, m.index, m[0].length, stringToken, 0);
              }
            }
  
            // -------- NUMBERS
            for (const m of line.matchAll(/(?<![A-Za-z0-9_-])\d+(\.\d+)?(?![A-Za-z0-9_-])/g)) {
              if (m.index !== undefined) {
                builder.push(i, m.index, m[0].length, variableToken, 0);
              }
            }
  
            // -------- VARIABLE-LIKE TOKENS (snake_case or contains digits)
            // for (const m of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
            //   const word = m[0];
            //   const idx = m.index ?? -1;
            //   if (idx < 0) continue;
  
            //   const skip = [
            //     "feature",
            //     "scenario",
            //     "scenario outline",
            //     "given",
            //     "when",
            //     "then",
            //     "and",
            //     "but",
            //   ];
  
            //   if (skip.includes(word.toLowerCase())) continue;
  
            //   if (word.includes("_") || /\d/.test(word)) {
            //     builder.push(i, idx, word.length, variableToken, 0);
            //   }
            // }
          }
  
          return builder.build();
        }
      })(),
      legend
    )
  );
  
  // initial doc diagnostics for currently open docs
  for (const doc of vscode.workspace.textDocuments) {
    if (GHERKIN_IDS.includes(doc.languageId)) updateDocDiagnostics(doc);
  }
}

// deactivate
export function deactivate() {}
